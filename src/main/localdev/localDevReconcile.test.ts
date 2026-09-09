import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalDevState } from '../../shared/localDevState'
import type { ToolchainProgress, ToolchainResult, ToolchainPins } from './toolchain'

/**
 * The reconcile as the renderer sees it: what is actually pushed down the
 * broadcast channel, run by run.
 *
 * The other file here tests the pure mappings; this one exists because the
 * failures that survive those are all of one kind — the reconciler knows
 * perfectly well what is happening and the window never hears it. That is not
 * hypothetical. The per-component checklist shipped attached to `state` while
 * the broadcast sent the pre-checklist object, so every push arrived with no
 * tasks and the UI fell back to a single "Installing…" line for a five-part
 * install. Nothing caught it, because nothing here looked at a payload.
 *
 * Everything below the service is faked, including the toolchain — the point is
 * the state machine and its broadcasts, not uv.
 */

const sent: LocalDevState[] = []
const consentStore = new Map<string, string>()

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (_channel: string, state: LocalDevState) => {
            // Structured-cloned in the real thing, so a test that kept the
            // reference would not notice the reconciler mutating it afterwards.
            sent.push(JSON.parse(JSON.stringify(state)) as LocalDevState)
          }
        }
      }
    ]
  },
  shell: { openPath: async () => '' },
  app: { getPath: () => '/nonexistent' }
}))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

vi.mock('../db/users', () => ({
  userRepo: {
    get: () => ({
      id: 'u1',
      type: 'cinna_user',
      username: 'someone@example.com',
      cinnaServerUrl: 'https://cinna.example.com'
    })
  }
}))

vi.mock('../db/appSettings', () => ({
  appSettingsRepo: {
    get: (key: string) => consentStore.get(key),
    set: (key: string, value: string) => void consentStore.set(key, value)
  }
}))

vi.mock('../services/cinna-http', () => ({
  cinnaFetch: async () => ({ setup_command: 'cinna account setup <token>' })
}))

vi.mock('../auth/cinna-oauth', () => ({
  clearEndpointCache: () => {},
  discoverCinnaEndpoints: async () => ({
    local_dev: {
      setup_token_endpoint: '/api/v1/cli/account/setup-tokens',
      cinna_cli_version: '0.4.0',
      mutagen_version: '9.9.9'
    }
  })
}))

const agentsHome = mkdtempSync(join(tmpdir(), 'cinna-localdev-'))
vi.mock('../services/localAgents/agentsHomeService', () => ({
  agentsHomeService: {
    ensureHome: () => ({ path: agentsHome }),
    // The reconcile calls this before it can name the workspace: on macOS it is
    // what takes the Documents-folder prompt, off it a plain `mkdir`.
    prepare: async () => ({ path: agentsHome, guarded: false, access: 'ready' })
  }
}))
vi.mock('../kit/contractStore', () => ({
  getLayout: () => ({ workshop: { cloud_dir: 'Cloud' } })
}))

/**
 * What the *next* `cinna account status` reports. Only the first one is honoured
 * — an expired token is refreshed and re-read, and a fake that kept saying
 * expired would loop.
 */
let nextStatusToken: 'valid' | 'expired' = 'valid'

vi.mock('./cliRunner', () => ({
  runCinnaCli: async ({ args }: { args: readonly string[] }) => {
    const isStatus = args.includes('status')
    const token = isStatus ? nextStatusToken : 'valid'
    if (isStatus) nextStatusToken = 'valid'
    return {
      exitCode: 0,
      result: { result: 'ok', token, workspace: agentsHome },
      stderr: '',
      stdout: '',
      timedOut: false
    }
  }
}))

/**
 * The engine pre-fetch, faked. Unmocked it would resolve — and on a machine
 * without one, download — a real 46 MB binary from the network, which is not
 * something a unit test may do.
 */
type PrefetchResult = { ok: true; source: 'managed' | 'path' } | { ok: false; error: string }
const prefetchEngineBinary = vi.fn(
  async (_onProgress?: (received: number, total: number | null) => void): Promise<PrefetchResult> =>
    ({ ok: true, source: 'managed' })
)
vi.mock('../engine/binaryResolver', () => ({
  prefetchEngineBinary: (onProgress?: (received: number, total: number | null) => void) =>
    prefetchEngineBinary(onProgress)
}))

vi.mock('./cliCapabilities', () => ({
  clearCliCapabilityCache: () => {},
  probeCliCapabilities: async () => ({ version: '0.4.0', json: true, accountSetToken: true })
}))

/**
 * The toolchain, under the test's control: `ensure` hands its progress callback
 * back and waits until the test says the install is over, which is what makes a
 * concurrent install — and a report arriving after a failure — reproducible.
 */
let install: {
  report: ToolchainProgress
  finish: (result: ToolchainResult) => void
  fail: (err: unknown) => void
}
const ensure = vi.fn(
  (_pins: ToolchainPins, onProgress?: ToolchainProgress) =>
    new Promise<ToolchainResult>((resolve, reject) => {
      install = {
        report: onProgress ?? ((): void => {}),
        finish: resolve,
        fail: reject
      }
    })
)

vi.mock('./toolchain', () => ({
  toolchain: {
    ensure: (pins: ToolchainPins, onProgress?: ToolchainProgress) => ensure(pins, onProgress),
    repair: (pins: ToolchainPins, onProgress?: ToolchainProgress) => ensure(pins, onProgress),
    toolchainEnv: async () => ({}),
    paths: () => ({ cinnaBin: '/managed/bin/cinna' }),
    root: () => '/managed'
  }
}))

const { localDevService } = await import('./localDevService')
const { ToolchainError } = await import('../errors')

/** Wait for the reconcile to reach the point where it is asking the toolchain. */
async function untilInstalling(): Promise<void> {
  for (let i = 0; i < 200 && install === undefined; i += 1) await Promise.resolve()
}

beforeEach(() => {
  sent.length = 0
  consentStore.clear()
  // Consent already given: this file is about what happens after it.
  consentStore.set('localDevConsent', JSON.stringify({ 'cinna.example.com': true }))
  install = undefined as never
  nextStatusToken = 'valid'
  ensure.mockClear()
  prefetchEngineBinary.mockClear()
})

describe('what the renderer is told', () => {
  it('puts the checklist in every push, not only in getState', async () => {
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.report({ step: 'Downloading Mutagen — 1.0 of 47.1 MB', tool: 'mutagen', toolPercent: 4 })
    install.finish({ cliVersion: '0.4.0', paths: {} as never })
    await run

    expect(sent.length).toBeGreaterThan(1)
    // Every push, including the first — a renderer that replaces its whole copy
    // on each one (which is what the store does) must never be handed a state
    // that has forgotten the five components it was told about a moment ago.
    for (const state of sent) {
      expect(state.tasks?.map((t) => t.id)).toEqual([
        'uv',
        'mutagen',
        'cinna-cli',
        'engine',
        'workspace',
        'token'
      ])
    }
    expect(sent.at(-1)?.tasks?.every((t) => t.status === 'done')).toBe(true)
  })

  it('shows the components that are genuinely in flight together, at once', async () => {
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    // uv finished; Mutagen and cinna-cli are installing concurrently, which is
    // what the toolchain now does and what the checklist has to be able to say.
    install.report({ step: 'uv installed', tool: 'uv', toolPercent: 100, toolStatus: 'done' })
    install.report({ step: 'Downloading Mutagen', tool: 'mutagen', toolPercent: 40 })
    install.report({ step: 'Resolved 42 packages', tool: 'cinna-cli', toolPercent: 25 })

    const tasks = sent.at(-1)?.tasks ?? []
    expect(tasks.find((t) => t.id === 'uv')?.status).toBe('done')
    expect(tasks.find((t) => t.id === 'mutagen')).toMatchObject({ status: 'active', percent: 40 })
    expect(tasks.find((t) => t.id === 'cinna-cli')).toMatchObject({ status: 'active', percent: 25 })
    // Nothing later has been ticked off by the mere fact that cinna-cli started.
    expect(tasks.find((t) => t.id === 'workspace')?.status).toBe('pending')

    install.finish({ cliVersion: '0.4.0', paths: {} as never })
    await run
  })

  it('does not let a survivor of a failed run narrate over the failure', async () => {
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    const { report } = install
    report({ step: 'Downloading Mutagen', tool: 'mutagen', toolPercent: 40 })
    install.fail(new ToolchainError('checksum_mismatch', 'Mutagen did not verify.', 'Mutagen', 'mutagen'))
    const failed = await run
    expect(failed).toMatchObject({ phase: 'attention', reason: 'toolchain' })

    // The cinna-cli install was still running when Mutagen failed, and it keeps
    // going: `Promise.all` rejects, it does not cancel. Its next line must not
    // replace the error the user is looking at with a progress bar that nothing
    // will ever complete.
    const after = sent.length
    report({ step: 'Installed 60 packages', tool: 'cinna-cli', toolPercent: 80 })
    expect(sent.length).toBe(after)
    expect(localDevService.getState().phase).toBe('attention')
  })

  it('names the component that failed, and stops the others pretending to spin', async () => {
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.report({ step: 'Downloading Mutagen', tool: 'mutagen', toolPercent: 40 })
    install.report({ step: 'Resolved 42 packages', tool: 'cinna-cli', toolPercent: 25 })
    install.fail(new ToolchainError('checksum_mismatch', 'Mutagen did not verify.', 'Mutagen', 'mutagen'))
    await run

    const tasks = sent.at(-1)?.tasks ?? []
    expect(tasks.find((t) => t.id === 'mutagen')).toMatchObject({
      status: 'failed',
      detail: 'Mutagen did not verify.'
    })
    expect(tasks.find((t) => t.id === 'cinna-cli')?.status).not.toBe('active')
  })

  it('ticks the engine row off without downloading when the user has their own', async () => {
    // The good outcome nobody sees: a developer with `opencode` on their PATH
    // gets the row answered in milliseconds, and the row has to say *why* it
    // was instant rather than looking like a download that flashed past.
    prefetchEngineBinary.mockResolvedValueOnce({ ok: true, source: 'path' })
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.finish({ cliVersion: '0.4.0', paths: {} as never })
    await run

    const engine = (sent.at(-1)?.tasks ?? []).find((t) => t.id === 'engine')
    expect(engine).toMatchObject({ status: 'done', detail: 'Already on this machine' })
  })

  it('is still ready when the engine could not be fetched, and does not tick that row', async () => {
    // The pre-fetch is an optimisation. Local development is genuinely set up
    // without it, and the engine is fetched at first use exactly as it was
    // before — so the run reports the row and carries on, rather than turning a
    // working install into `attention`.
    prefetchEngineBinary.mockResolvedValueOnce({
      ok: false,
      error: 'Could not reach the release host.'
    })
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.finish({ cliVersion: '0.4.0', paths: {} as never })
    const final = await run

    expect(final.phase).toBe('ready')
    const engine = (sent.at(-1)?.tasks ?? []).find((t) => t.id === 'engine')
    // Not `failed`: nothing is broken, and a red row under a green "ready"
    // would be contradicted by an app that works. Not `done` either — the
    // closing tick must not claim a download that did not happen.
    expect(engine?.status).toBe('pending')
    expect(engine?.detail).toContain('first time you run an agent')
    // And the components that did finish are not dragged down with it.
    expect((sent.at(-1)?.tasks ?? []).find((t) => t.id === 'token')?.status).toBe('done')
  })

  it('keeps the bar moving while the engine is the only thing left', async () => {
    // A warm toolchain and a warm workspace reach the token check in seconds
    // and then wait on a cold 46 MB download. If the blended percentage only
    // recomputed when something *sequential* reported, the bar would freeze
    // there for the whole download — the exact shape the engine's share of it
    // exists to prevent.
    let report: (received: number, total: number | null) => void = () => {}
    let release = (): void => {}
    prefetchEngineBinary.mockImplementationOnce(async (onProgress) => {
      report = onProgress ?? (() => {})
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { ok: true, source: 'managed' }
    })

    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.finish({ cliVersion: '0.4.0', paths: {} as never })
    // The reconcile is now parked on the engine; nothing sequential will report
    // again.
    for (let i = 0; i < 200; i += 1) await Promise.resolve()
    const installing = (): { step: string; percent?: number } => {
      const last = sent.at(-1)
      if (last?.phase !== 'installing') throw new Error(`expected installing, got ${last?.phase}`)
      return last
    }
    const parked = installing().percent
    report(10_000_000, 46_000_000)
    report(30_000_000, 46_000_000)

    expect(parked).toBeTypeOf('number')
    expect(installing().percent!).toBeGreaterThan(parked!)
    expect(installing().step).toContain('Downloading opencode')

    release()
    await run
  })

  it('never publishes a percentage below the last one the user saw', async () => {
    // The token check publishes 97; a token that turns out to be expired sends
    // the refresh back to 70. A bar that jumps back reads as a restart, which
    // is worse than no bar at all.
    nextStatusToken = 'expired'
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.report({ step: 'uv', tool: 'uv', toolPercent: 100, toolStatus: 'done' })
    install.report({ step: 'Downloading Mutagen', tool: 'mutagen', toolPercent: 50 })
    install.finish({ cliVersion: '0.4.0', paths: {} as never })
    await run

    const percents = sent
      .map((s) => (s.phase === 'installing' ? s.percent : undefined))
      .filter((p): p is number => p !== undefined)
    expect(percents.length).toBeGreaterThan(1)
    expect([...percents].sort((a, b) => a - b)).toEqual(percents)
  })

  it('blames the component the error names, not whichever row happens to be active', async () => {
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    // Mutagen is downloading — healthily — when the cinna-cli install fails.
    // Its `detail` is a stderr tail, so the row can only be identified by the
    // component the error carries; the old "first active row" reading would
    // put a uv resolver error on Mutagen's line.
    install.report({ step: 'Downloading Mutagen', tool: 'mutagen', toolPercent: 40 })
    install.fail(
      new ToolchainError(
        'install_failed',
        'Installing cinna-cli 0.4.0 failed.',
        'error: no solution found',
        'cinna-cli'
      )
    )
    await run

    const tasks = sent.at(-1)?.tasks ?? []
    expect(tasks.find((t) => t.id === 'cinna-cli')?.status).toBe('failed')
    expect(tasks.find((t) => t.id === 'mutagen')?.status).not.toBe('failed')
  })
})
