/**
 * Where an agent's machine-local state lives, and why there are two answers.
 *
 * The split is the load-bearing rule of bare agents: a kit folder's state is
 * inside it (the contract says that file is the desktop's), and a bare folder's
 * is not, because a bare folder is somebody's repository and the desktop writes
 * nothing into it. Everything that reads or writes an agent's state — the
 * scanner, the runner, the permission store — calls one function with one
 * argument, so this decision is made in exactly one place and cannot be made
 * differently by two callers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { desktopStateService, desktopStatePath } = await import('./desktopStateService')

let dir: string
/** Captured while the folder is still bare — a test may give it a manifest. */
let barePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-state-'))
  barePath = desktopStatePath(dir, 'bare')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  // The bare branch writes outside `dir`; clean up what this file created.
  rmSync(barePath, { force: true })
})

describe('desktopStatePath', () => {
  it('keeps a kit folder’s state inside the folder', () => {
    expect(desktopStatePath(dir, 'kit')).toBe(join(dir, 'app-data', 'desktop.json'))
  })

  it('is decided by the caller, never by what is lying in the folder', () => {
    // The bug this parameter replaced a probe for. `discoverBareAgents` tests
    // for `AGENT.md` and nothing else, so a folder carrying **both** files is
    // adopted as a bare agent — and a probe for `cinna-agent.json` would then
    // send its very first write into that folder, creating the untracked
    // `app-data/` this location exists to avoid.
    writeFileSync(join(dir, 'cinna-agent.json'), '{}')
    writeFileSync(join(dir, 'AGENT.md'), '# Both\n')
    expect(desktopStatePath(dir, 'bare').startsWith(dir)).toBe(false)

    desktopStateService.patch(dir, 'bare', { hidden: true })
    expect(existsSync(join(dir, 'app-data'))).toBe(false)
  })

  it('keeps a bare folder’s state out of the folder entirely', () => {
    // The rule this whole shape exists for. Mutation: always join the agent
    // dir, and adopting a repository of fifteen agents drops fifteen untracked
    // `app-data/` directories into somebody's working tree.
    const path = desktopStatePath(dir, 'bare')
    expect(path.startsWith(dir)).toBe(false)
    expect(path.endsWith('.json')).toBe(true)
  })

  it('gives two different bare folders two different files', () => {
    const other = mkdtempSync(join(tmpdir(), 'cinna-state-b-'))
    try {
      expect(desktopStatePath(dir, 'bare')).not.toBe(desktopStatePath(other, 'bare'))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('is stable for the same folder across calls', () => {
    // The key *is* the identity of a bare agent's state. Mutation: key it on
    // anything time- or process-dependent and every restart loses the agent's
    // sessions, its token and its permission grants.
    expect(desktopStatePath(dir, 'bare')).toBe(desktopStatePath(dir, 'bare'))
  })
})

describe('bare agent state', () => {
  it('round-trips a name and a hidden flag without touching the folder', () => {
    desktopStateService.patch(dir, 'bare', { displayName: 'Invoice watcher', hidden: true })

    expect(existsSync(join(dir, 'app-data'))).toBe(false)
    const state = desktopStateService.read(dir, 'bare')
    expect(state.displayName).toBe('Invoice watcher')
    expect(state.hidden).toBe(true)
  })

  it('reads defaults for a folder that has never run', () => {
    const state = desktopStateService.read(dir, 'bare')
    expect(state.displayName).toBeNull()
    expect(state.hidden).toBe(false)
  })

  it('forgetAt removes the state of an agent whose folder is already gone', () => {
    // Without this, a deleted bare agent's sessions, token and grants sit under
    // `userData` forever — and are inherited by whatever is next created at the
    // same path, because the path is the key.
    //
    // The folder is removed **before** the call, which is the order the real
    // caller works in and the reason this takes a path rather than a directory:
    // `desktopStatePath` keys on `realpathSync`, so once the folder is gone the
    // key it derives is a different one wherever any component was a symlink —
    // and on macOS `tmpdir()` is exactly that (`/var` → `/private/var`). A
    // version that resolved the path here unlinked a file that never existed
    // and left the real one behind, on every machine this test runs on.
    desktopStateService.patch(dir, 'bare', { displayName: 'Gone soon' })
    const path = desktopStatePath(dir, 'bare')
    expect(existsSync(path)).toBe(true)

    rmSync(dir, { recursive: true, force: true })
    desktopStateService.forgetAt(path)
    expect(existsSync(path)).toBe(false)
  })

  it('forgetAt is silent about a file that is not there', () => {
    // The folder is already in the Trash by the time this runs; a missing state
    // file is not worth failing a delete over.
    expect(() => desktopStateService.forgetAt(join(dir, 'nowhere.json'))).not.toThrow()
  })

  it('keeps a bare agent’s engine, which is a key a picker can set', () => {
    // **The hole the engine axis opened here.** `toRuntimeRef` produces
    // `{ engine: 'claude' }` for an agent that chose only an engine, and this
    // store is where a bare agent's choice lands — so a narrowing that did not
    // know the key wrote it, forgot it on the next read, and the picker snapped
    // back to Default in front of the user with nothing reporting a failure.
    desktopStateService.write(dir, 'bare', {
      ...desktopStateService.read(dir, 'bare'),
      runtime: { engine: 'claude' }
    })
    expect(desktopStateService.read(dir, 'bare').runtime).toEqual({ engine: 'claude' })

    desktopStateService.write(dir, 'bare', {
      ...desktopStateService.read(dir, 'bare'),
      runtime: { engine: 'claude', complexity: 'complex' }
    })
    expect(desktopStateService.read(dir, 'bare').runtime).toEqual({
      engine: 'claude',
      complexity: 'complex'
    })
  })

  it('keeps only the runtime keys a picker can set', () => {
    // This file has one writer, so unlike a manifest there is nothing to
    // round-trip: anything else in the block is a leftover from a build whose
    // surface is gone, and handing it to the engine long afterwards is how a
    // stale permission map outlives the code that wrote it.
    desktopStateService.write(dir, 'bare', {
      ...desktopStateService.read(dir, 'bare'),
      runtime: {
        credential: 'Anthropic',
        complexity: 'medium',
        permissions: { bash: 'allow' }
      }
    })

    expect(desktopStateService.read(dir, 'bare').runtime).toEqual({
      credential: 'Anthropic',
      complexity: 'medium'
    })
  })

  it('reads a runtime that names nothing as no choice at all', () => {
    // `{}` and a missing key have to mean the same thing, or an agent whose
    // choice was cleared would take the manifest branch of `resolve` over a
    // block that says nothing.
    desktopStateService.write(dir, 'bare', {
      ...desktopStateService.read(dir, 'bare'),
      runtime: {}
    })
    expect(desktopStateService.read(dir, 'bare').runtime).toBeNull()
  })

  it('a folder that gains a manifest keeps the state it had', () => {
    // The second half of the same bug. A bare folder is one `git pull` from
    // gaining a `cinna-agent.json` — the update check ships beside this — and a
    // probe would have moved its state on that pull: `hidden` reverting (an
    // agent the user removed reappears), the rename lost, and its sessions,
    // token and standing permission grants orphaned. The kind comes from the
    // root row, so the file appearing changes nothing.
    desktopStateService.patch(dir, 'bare', { displayName: 'Bare', hidden: true })
    writeFileSync(join(dir, 'cinna-agent.json'), '{}')

    const state = desktopStateService.read(dir, 'bare')
    expect(state.displayName).toBe('Bare')
    expect(state.hidden).toBe(true)
    expect(existsSync(join(dir, 'app-data'))).toBe(false)
  })
})
