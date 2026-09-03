import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { on: () => undefined } }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../index', () => ({ getMainWindow: () => null }))

const { classifyEvent, watcherService } = await import('./watcherService')
const { turnLock } = await import('./turnLock')

const ROOT = '/w'

afterEach(() => {
  watcherService.stopAll()
  turnLock.releaseAll()
})

/**
 * These assert *which* answer, not merely "not an agent". The three outcomes are
 * three different instructions — do nothing, rescan one agent, rescan the root —
 * and an assertion that cannot tell `ignore` from `root` would pass while every
 * `app-data/` write triggered a full re-index of the root.
 */
describe('classifyEvent — what a watch event means', () => {
  it('attributes a file inside an agent folder to that agent', () => {
    expect(classifyEvent(ROOT, 'alpha/docs/WORKFLOW_PROMPT.md')).toEqual({
      kind: 'agent',
      dir: join(ROOT, 'Local', 'alpha')
    })
    expect(classifyEvent(ROOT, 'alpha/cinna-agent.json')).toEqual({
      kind: 'agent',
      dir: join(ROOT, 'Local', 'alpha')
    })
  })

  it('treats a bare agent folder as a root-level change', () => {
    // The agent set changed — a scaffold, a delete, a rename. Only a whole-root
    // scan can insert or prune, so this must not be attributed to one agent.
    expect(classifyEvent(ROOT, 'alpha')).toEqual({ kind: 'root' })
  })

  it('ignores the agent’s own runtime directory — ignore, not rescan', () => {
    // `app-data/` churns constantly while a turn runs. Downgrading this to a
    // root rescan is the bug: it is the most expensive response there is, on
    // the one directory this service says it does not watch.
    expect(classifyEvent(ROOT, 'alpha/app-data/storage/STATUS.md')).toEqual({ kind: 'ignore' })
    expect(classifyEvent(ROOT, 'alpha/app-data/desktop.json')).toEqual({ kind: 'ignore' })
    expect(classifyEvent(ROOT, 'alpha/app-data')).toEqual({ kind: 'ignore' })
    expect(classifyEvent(ROOT, 'alpha/app-data/cache/anything.json')).toEqual({ kind: 'ignore' })
  })

  it('ignores dot-entries, including the scaffolder’s staging folder', () => {
    expect(classifyEvent(ROOT, '.alpha.scaffold-1-2/cinna-agent.json')).toEqual({
      kind: 'ignore'
    })
    expect(classifyEvent(ROOT, '.DS_Store')).toEqual({ kind: 'ignore' })
  })

  it('falls back to the root when the platform gives no filename', () => {
    // Costly, but the alternative is missing a change entirely.
    expect(classifyEvent(ROOT, null)).toEqual({ kind: 'root' })
    expect(classifyEvent(ROOT, '')).toEqual({ kind: 'root' })
  })
})

describe('watching a real directory', () => {
  function workshopWithAgent(): { workshop: string; agentDir: string } {
    const workshop = mkdtempSync(join(tmpdir(), 'cinna-watch-'))
    const agentDir = join(workshop, 'Local', 'alpha')
    mkdirSync(join(agentDir, 'docs'), { recursive: true })
    writeFileSync(join(agentDir, 'cinna-agent.json'), '{}\n')
    return { workshop, agentDir }
  }

  function root(workshop: string) {
    return {
      id: 'r1',
      userId: '__default__',
      path: workshop,
      label: 'Agents',
      isDefault: true,
      createdAt: new Date()
    }
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return predicate()
  }

  it('rescans after a file inside an agent changes', async () => {
    const { workshop, agentDir } = workshopWithAgent()
    const rescanAgent = vi.fn()
    const rescanRoot = vi.fn()
    watcherService.configure({
      rescanAgent,
      rescanRoot,
      agentIdForPath: () => 'folder:alpha',
      agentIdsForRoot: () => ['folder:alpha']
    })
    try {
      watcherService.watchRoot(root(workshop))
      expect(watcherService.watchedRootIds()).toEqual(['r1'])

      // The write is repeated rather than made once: a platform watcher takes a
      // moment to arm (macOS goes through FSEvents), and a write that lands in
      // that window is simply not reported. Re-writing until the callback
      // arrives tests that changes *do* reach the scanner, without asserting a
      // timing guarantee `fs.watch` never made.
      let lastWrite = 0
      const fired = await waitFor(() => {
        // Spaced well beyond the debounce window: writing on every poll would
        // reset the timer forever and the flush would never run.
        if (Date.now() - lastWrite > 1_500) {
          writeFileSync(join(agentDir, 'docs', 'WORKFLOW_PROMPT.md'), `changed ${Date.now()}\n`)
          lastWrite = Date.now()
        }
        return rescanAgent.mock.calls.length + rescanRoot.mock.calls.length > 0
      }, 12_000)

      // Either attribution is correct behaviour: a precise per-agent rescan, or
      // the whole-root fallback when the platform gave an unattributable event.
      expect(fired).toBe(true)
    } finally {
      watcherService.stopAll()
      rmSync(workshop, { recursive: true, force: true })
    }
  })

  /**
   * The guarantee: **nothing** rescans while a turn is streaming — not the
   * per-agent branch, and not the whole-root one.
   *
   * Asserting only `rescanAgent` was the hole: the root branch is where an
   * unattributable event lands, and a mid-turn root scan walks and re-indexes
   * every agent in the root, so it is the same hazard at a larger scale. The
   * burst below deliberately produces both kinds of event — files inside the
   * agent, and a new folder appearing in `Local/` — so both branches are live.
   *
   * The other half — that the deferred rescan runs once the lock releases — is
   * `turnLock.whenFree`, unit-tested in `turnLock.test.ts`; asserting it here
   * would depend on how the platform attributes a particular write, which is
   * exactly what `fs.watch` does not promise.
   */
  it('never rescans, by either route, while a turn holds an agent', async () => {
    const { workshop, agentDir } = workshopWithAgent()
    const rescanAgent = vi.fn()
    const rescanRoot = vi.fn()
    watcherService.configure({
      rescanAgent,
      rescanRoot,
      agentIdForPath: () => 'folder:alpha',
      agentIdsForRoot: () => ['folder:alpha']
    })
    const handle = turnLock.acquire('folder:alpha', 'turn')
    try {
      watcherService.watchRoot(root(workshop))

      // A turn writing its own files: several changes, in a burst…
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(agentDir, 'docs', `note-${i}.md`), `pass ${i}\n`)
        writeFileSync(join(agentDir, 'cinna-agent.json'), `{"pass":${i}}\n`)
      }
      // …and a root-level change, which routes down the other branch.
      mkdirSync(join(workshop, 'Local', 'beta'), { recursive: true })

      // Well past the debounce, so any flush that was going to happen has.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(rescanAgent).not.toHaveBeenCalled()
      expect(rescanRoot).not.toHaveBeenCalled()
    } finally {
      handle.release()
      watcherService.stopAll()
      rmSync(workshop, { recursive: true, force: true })
    }
  })

  it('runs the deferred root rescan once the last turn releases', async () => {
    const { workshop } = workshopWithAgent()
    const rescanRoot = vi.fn()
    watcherService.configure({
      rescanAgent: vi.fn(),
      rescanRoot,
      agentIdForPath: () => 'folder:alpha',
      agentIdsForRoot: () => ['folder:alpha']
    })
    const handle = turnLock.acquire('folder:alpha', 'turn')
    try {
      watcherService.watchRoot(root(workshop))
      let lastWrite = 0
      // Drive root-level events until one is delivered and deferred.
      await waitFor(() => {
        if (Date.now() - lastWrite > 1_500) {
          const marker = join(workshop, 'Local', `beta-${Date.now()}`)
          mkdirSync(marker, { recursive: true })
          lastWrite = Date.now()
        }
        return false
      }, 3_000)
      expect(rescanRoot).not.toHaveBeenCalled()

      handle.release()
      expect(await waitFor(() => rescanRoot.mock.calls.length > 0, 5_000)).toBe(true)
    } finally {
      watcherService.stopAll()
      rmSync(workshop, { recursive: true, force: true })
    }
  })

  /**
   * The end-to-end half of C2. `update_status.py` and `desktop.json` are written
   * repeatedly while an agent runs; each one used to schedule a full walk, parse
   * and re-index of every agent in the root.
   *
   * A negative assertion, so a missed platform event cannot make it flake — it
   * can only fail when an event *is* delivered and acted on, which is the bug.
   */
  it('does not rescan anything when only app-data/ changes', async () => {
    const { workshop, agentDir } = workshopWithAgent()
    const rescanAgent = vi.fn()
    const rescanRoot = vi.fn()
    watcherService.configure({
      rescanAgent,
      rescanRoot,
      agentIdForPath: () => 'folder:alpha',
      agentIdsForRoot: () => ['folder:alpha']
    })
    try {
      mkdirSync(join(agentDir, 'app-data', 'storage'), { recursive: true })
      watcherService.watchRoot(root(workshop))

      // macOS FSEvents replays a backlog of changes made just before the watch
      // was armed — the files this test's own setup wrote. Let it drain and
      // reset, so what follows is only about `app-data/`.
      await new Promise((resolve) => setTimeout(resolve, 900))
      rescanAgent.mockClear()
      rescanRoot.mockClear()

      for (let i = 0; i < 5; i++) {
        writeFileSync(join(agentDir, 'app-data', 'storage', 'STATUS.md'), `pass ${i}\n`)
        writeFileSync(join(agentDir, 'app-data', 'desktop.json'), `{"pass":${i}}\n`)
      }

      // Well past the debounce window.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(rescanAgent).not.toHaveBeenCalled()
      expect(rescanRoot).not.toHaveBeenCalled()
    } finally {
      watcherService.stopAll()
      rmSync(workshop, { recursive: true, force: true })
    }
  })

  it('stops watching on unwatch, and survives a root that does not exist', () => {
    watcherService.configure({
      rescanAgent: vi.fn(),
      rescanRoot: vi.fn(),
      agentIdForPath: () => null,
      agentIdsForRoot: () => []
    })
    watcherService.watchRoot(root('/nowhere/at/all'))
    expect(watcherService.watchedRootIds()).toEqual(['r1'])
    watcherService.unwatchRoot('r1')
    expect(watcherService.watchedRootIds()).toEqual([])
  })
})
