import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readlink, symlink, unlink } from 'node:fs/promises'
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
  shell: { openPath: vi.fn(async () => '') },
  app: { getPath: () => '/nonexistent' }
}))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

vi.mock('../db/users', () => ({
  userRepo: {
    get: (id: string) => ({
      id,
      type: 'cinna_user',
      username: 'someone@example.com',
      cinnaServerUrl: id === 'u1' ? 'https://cinna.example.com' : `https://${id}.example.com`
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
  cinnaFetch: vi.fn(async () => ({ setup_command: 'cinna account setup <token>' }))
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
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => agentsHome
}))
vi.mock('../services/localAgents/agentsHomeService', () => ({
  agentsHomeService: {
    ensureHome: () => ({ path: agentsHome }),
    // The reconcile calls this before it can name the workspace: on macOS it is
    // what takes the Documents-folder prompt, off it a plain `mkdir`.
    prepare: vi.fn(async () => ({ path: agentsHome, guarded: false, access: 'ready' }))
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
  runCinnaCli: vi.fn(async ({ args }: { args: readonly string[] }) => {
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
  })
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
const engineEnsure = vi.hoisted(() => vi.fn(async () => ({ ok: true, source: 'path' })))
vi.mock('../engine/engineBinaryService', () => ({
  engineBinaryService: { ensure: engineEnsure }
}))
vi.mock('../engine/binaryResolver', () => ({
  prefetchEngineBinary: (onProgress?: (received: number, total: number | null) => void) =>
    prefetchEngineBinary(onProgress)
}))

const capabilityProbe = vi.hoisted(() => vi.fn())
vi.mock('./cliCapabilities', () => ({
  clearCliCapabilityCache: () => {},
  probeCliCapabilities: capabilityProbe
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
const repair = vi.fn((pins: ToolchainPins, onProgress?: ToolchainProgress) => ensure(pins, onProgress))

vi.mock('./toolchain', () => ({
  toolchain: {
    ensure: (pins: ToolchainPins, onProgress?: ToolchainProgress) => ensure(pins, onProgress),
    repair: (pins: ToolchainPins, onProgress?: ToolchainProgress) => repair(pins, onProgress),
    toolchainEnv: async () => ({}),
    paths: () => ({ cinnaBin: '/managed/bin/cinna' }),
    root: () => '/managed',
    installedCli: async () => ({ path: '/managed/bin/cinna', version: '0.4.0' })
  }
}))

const { localDevService } = await import('./localDevService')
const { ToolchainError } = await import('../errors')
const { cinnaFetch } = await import('../services/cinna-http')
const { runCinnaCli } = await import('./cliRunner')
const { agentsHomeService } = await import('../services/localAgents/agentsHomeService')
const { shell } = await import('electron')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const installed = { cliVersion: '0.4.0', paths: {} as never }


/** Wait for the reconcile to reach the point where it is asking the toolchain. */
async function untilInstalling(): Promise<void> {
  for (let i = 0; i < 200 && install === undefined; i += 1) await Promise.resolve()
}

beforeEach(() => {
  localDevService.clear()
  capabilityProbe.mockReset().mockResolvedValue({ json: true, accountSetToken: true })
  vi.mocked(cinnaFetch).mockClear()
  vi.mocked(runCinnaCli).mockClear()
  vi.mocked(agentsHomeService.prepare).mockClear()
  vi.mocked(shell.openPath).mockClear()
  sent.length = 0
  consentStore.clear()
  // Consent already given: this file is about what happens after it.
  consentStore.set('localDevConsent', JSON.stringify({ 'cinna.example.com': true }))
  install = undefined as never
  nextStatusToken = 'valid'
  ensure.mockClear()
  repair.mockClear()
  prefetchEngineBinary.mockClear()
  engineEnsure.mockClear()
})

describe('what the renderer is told', () => {
  it('rechecks a legacy result using the installed CLI without reinstalling the workspace', async () => {
    capabilityProbe.mockResolvedValueOnce({ json: false, accountSetToken: false })
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.finish(installed)
    expect(await run).toMatchObject({ phase: 'ready', protocol: 'legacy' })
    const installs = ensure.mock.calls.length
    await localDevService.recheckCapabilities('u1')
    expect(capabilityProbe).toHaveBeenLastCalledWith('/managed/bin/cinna', '0.4.0', {}, { fresh: true })
    expect(localDevService.getState()).toMatchObject({ phase: 'ready', protocol: 'json' })
    expect(ensure).toHaveBeenCalledTimes(installs)
  })

  it('marks a failed CLI probe as a toolchain failure so Repair reinstalls it', async () => {
    capabilityProbe.mockRejectedValueOnce(new Error('Could not check Cinna CLI support (exit code 1).'))
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.finish(installed)
    expect(await run).toMatchObject({
      phase: 'attention', reason: 'toolchain', detail: 'Could not check Cinna CLI support (exit code 1).',
      tasks: expect.arrayContaining([expect.objectContaining({ id: 'cinna-cli', status: 'failed' })])
    })
    expect(agentsHomeService.prepare).not.toHaveBeenCalled()
    install = undefined as never
    const fixed = localDevService.reconcile('u1', true)
    await untilInstalling()
    expect(repair).toHaveBeenCalledOnce()
    install.finish(installed)
    expect(await fixed).toMatchObject({ phase: 'ready', protocol: 'json' })
  })

  it('does not publish a recheck after the active profile has been cleared', async () => {
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.finish(installed)
    await run
    capabilityProbe.mockImplementationOnce(async () => {
      localDevService.clear()
      return { json: true, accountSetToken: true }
    })
    await expect(localDevService.recheckCapabilities('u1')).rejects.toThrow('changed during the check')
    expect(localDevService.getState().phase).toBe('idle')
  })

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
    // And the binary service is told. `prefetchEngineBinary` goes through the
    // resolver directly, which the service does not observe — so without this
    // Settings went on saying "Not resolved yet" after a setup that had a
    // binary in hand: true of the service, not of the machine.
    expect(engineEnsure).toHaveBeenCalled()
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
    // And nothing is claimed to the binary service either: there is no binary
    // to tell it about, and a refresh here would only replace one honest
    // "not resolved" with another.
    expect(engineEnsure).not.toHaveBeenCalled()
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


describe('managed CLI updates without workspace setup', () => {
  it.each([false, undefined])('preserves saved consent %s and never prepares a workspace', async (consent) => {
    consentStore.set('localDevConsent', JSON.stringify({ 'cinna.example.com': consent }))
    await localDevService.reconcile('u1')
    const before = localDevService.getState()
    const savedConsent = consentStore.get('localDevConsent')
    const update = localDevService.updateCli('u1', '0.4.0')
    await untilInstalling()
    install.finish(installed)
    await update
    expect(consentStore.get('localDevConsent')).toBe(savedConsent)
    expect(localDevService.getState()).toEqual(before)
    expect(agentsHomeService.prepare).not.toHaveBeenCalled()
    expect(cinnaFetch).not.toHaveBeenCalled()
    expect(runCinnaCli).not.toHaveBeenCalled()
    expect(prefetchEngineBinary).not.toHaveBeenCalled()
    expect(ensure).toHaveBeenCalledExactlyOnceWith({ cinnaCliVersion: '0.4.0', mutagenVersion: '9.9.9' }, undefined)
  })

  it('refreshes an already-ready context after draining reconciliation without repeating account work', async () => {
    capabilityProbe.mockResolvedValueOnce({ json: false, accountSetToken: false })
    const reconcile = localDevService.reconcile('u1')
    await untilInstalling()
    const firstInstall = install
    const update = localDevService.updateCli('u1', '0.4.0')
    expect(ensure).toHaveBeenCalledOnce()
    firstInstall.finish({ ...installed, cliVersion: '0.3.0' })
    await reconcile
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2))
    const accountCalls = vi.mocked(runCinnaCli).mock.calls.length
    expect(localDevService.getState().phase).toBe('installing')
    install.finish(installed)
    await update
    expect(localDevService.getState()).toMatchObject({ phase: 'ready', cliVersion: '0.4.0', protocol: 'json', workspacePath: join(agentsHome, 'Cloud', 'cinna.example.com') })
    expect(capabilityProbe).toHaveBeenLastCalledWith('/managed/bin/cinna', '0.4.0', {}, { fresh: true })
    expect(runCinnaCli).toHaveBeenCalledTimes(accountCalls)
    expect(agentsHomeService.prepare).toHaveBeenCalledOnce()
  })

  it('drains an update before another profile installs and never publishes the old context', async () => {
    consentStore.set('localDevConsent', JSON.stringify({ 'cinna.example.com': false, 'u2.example.com': true }))
    await localDevService.reconcile('u1')
    const update = localDevService.updateCli('u1', '0.4.0')
    const rejected = expect(update).rejects.toThrow('active profile changed')
    await untilInstalling()
    const firstInstall = install
    const next = localDevService.reconcile('u2')
    expect(ensure).toHaveBeenCalledOnce()
    firstInstall.finish(installed)
    await rejected
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2))
    expect(capabilityProbe).not.toHaveBeenCalled()
    install.finish(installed)
    expect(await next).toMatchObject({ phase: 'ready', workspacePath: join(agentsHome, 'Cloud', 'u2.example.com') })
  })

  it('skips an update queued for a profile that has been cleared', async () => {
    const reconcile = localDevService.reconcile('u1')
    await untilInstalling()
    const update = localDevService.updateCli('u1', '0.4.0')
    const rejected = expect(update).rejects.toThrow('active profile changed')
    localDevService.clear()
    install.finish(installed)
    await Promise.all([reconcile, rejected])
    expect(ensure).toHaveBeenCalledOnce()
    expect(localDevService.getState().phase).toBe('idle')
  })

  it('rejects a changed server target before touching shared tools', async () => {
    await expect(localDevService.updateCli('u1', '0.5.0')).rejects.toThrow('required CLI version changed')
    expect(ensure).not.toHaveBeenCalled()
  })

  it('retires readiness on an update probe failure and allows Repair to reinstall', async () => {
    const reconcile = localDevService.reconcile('u1')
    await untilInstalling()
    install.finish(installed)
    await reconcile
    install = undefined as never
    capabilityProbe.mockRejectedValueOnce(new Error('The updated CLI could not start.'))
    const update = localDevService.updateCli('u1', '0.4.0')
    const rejected = expect(update).rejects.toThrow('could not start')
    await untilInstalling()
    install.finish(installed)
    await rejected
    expect(localDevService.getState()).toMatchObject({ phase: 'attention', reason: 'toolchain' })
    install = undefined as never
    const fixed = localDevService.reconcile('u1', true)
    await untilInstalling()
    expect(repair).toHaveBeenCalledOnce()
    install.finish(installed)
    expect(await fixed).toMatchObject({ phase: 'ready' })
  })
})

describe('profile ownership of reconciliation', () => {
  it('drains A installation before starting B and never prepares A after the switch', async () => {
    consentStore.set('localDevConsent', JSON.stringify({ 'cinna.example.com': true, 'u2.example.com': true }))
    const a = localDevService.reconcile('u1')
    await untilInstalling()
    const oldInstall = install
    const b = localDevService.reconcile('u2')
    const stateAtSwitch = localDevService.getState()
    const openedAtSwitch = await localDevService.openWorkspace()
    const installsAtSwitch = ensure.mock.calls.length
    oldInstall.finish(installed)
    await a
    expect(stateAtSwitch.phase).toBe('idle')
    expect(openedAtSwitch).toEqual({ ok: false })
    expect(installsAtSwitch).toBe(1)
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2))
    const after = sent.length
    oldInstall.report({ step: 'A finished late', tool: 'cinna-cli', toolPercent: 100 })
    expect(sent).toHaveLength(after)
    expect(agentsHomeService.prepare).not.toHaveBeenCalled()
    install.finish(installed)
    expect(await b).toMatchObject({ phase: 'ready', workspacePath: join(agentsHome, 'Cloud', 'u2.example.com') })
    expect(agentsHomeService.prepare).toHaveBeenCalledExactlyOnceWith('u2')
    expect(cinnaFetch).toHaveBeenCalledExactlyOnceWith('u2', expect.any(String), expect.any(Object))
    await localDevService.openWorkspace()
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(join(agentsHome, 'Cloud', 'u2.example.com'))
  })

  it.each(['signout', 'switch'] as const)('does not revive a queued B after %s', async (next) => {
    const a = localDevService.reconcile('u1')
    await untilInstalling()
    const b = localDevService.reconcile('u2')
    localDevService.clear()
    const c = next === 'switch' ? localDevService.reconcile('u3') : undefined
    install.finish(installed)
    await Promise.all([a, b, c])
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(agentsHomeService.prepare).not.toHaveBeenCalled()
    expect(cinnaFetch).not.toHaveBeenCalled()
    expect(localDevService.getState()).toMatchObject(next === 'switch'
      ? { phase: 'consent', host: 'u3.example.com' }
      : { phase: 'idle', tasks: undefined })
  })

  it('ignores progress and failure after clear, including the parallel engine', async () => {
    const engine = deferred<PrefetchResult>()
    let engineProgress: ((received: number, total: number | null) => void) | undefined
    prefetchEngineBinary.mockImplementationOnce((report) => { engineProgress = report; return engine.promise })
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    localDevService.clear()
    const after = sent.length
    install.report({ step: 'Old progress', tool: 'uv', toolPercent: 90 })
    engineProgress?.(30, 100)
    engine.resolve({ ok: true, source: 'managed' })
    install.fail(new Error('Old failure'))
    await run
    expect(sent).toHaveLength(after)
    expect(localDevService.getState()).toEqual({ phase: 'idle', tasks: undefined })
    expect(engineEnsure).not.toHaveBeenCalled()
  })

  it('does not start account setup when a mint completes after clear', async () => {
    const mint = deferred<{ setup_command: string }>()
    vi.mocked(cinnaFetch).mockImplementationOnce(() => mint.promise)
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.finish(installed)
    await vi.waitFor(() => expect(cinnaFetch).toHaveBeenCalled())
    localDevService.clear()
    const after = sent.length
    mint.resolve({ setup_command: 'old-profile-token' })
    await run
    expect(runCinnaCli).not.toHaveBeenCalled()
    expect(sent).toHaveLength(after)
  })

  it('ignores workspace progress and skips token checks when setup finishes after clear', async () => {
    const setup = deferred<Awaited<ReturnType<typeof runCinnaCli>>>()
    vi.mocked(runCinnaCli).mockImplementationOnce(() => setup.promise)
    const run = localDevService.reconcile('u1')
    await untilInstalling()
    install.finish(installed)
    await vi.waitFor(() => expect(runCinnaCli).toHaveBeenCalled())
    const report = vi.mocked(runCinnaCli).mock.calls[0][0].onProgress
    localDevService.clear()
    const after = sent.length
    report?.({ status: 'start', message: 'Old workspace', step: 2, total: 3 })
    setup.resolve({ exitCode: 0, result: { result: 'ok' }, stderr: '', stdout: '', timedOut: false })
    await run
    expect(runCinnaCli).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(after)
  })

  it('does not revive a consent request waiting on a former profile', async () => {
    const a = localDevService.reconcile('u1')
    await untilInstalling()
    const consent = localDevService.setConsent('u1', 'cinna.example.com', true)
    localDevService.clear()
    install.finish(installed)
    await a
    // Drain a wrongly revived run too, so the regression fails on its extra
    // install rather than leaving a pending promise behind for the next test.
    for (let i = 0; i < 200; i += 1) await Promise.resolve()
    if (ensure.mock.calls.length > 1) install.finish(installed)
    await consent
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(localDevService.getState().phase).toBe('idle')
  })

  it('deduplicates same-profile calls during an install', async () => {
    const first = localDevService.reconcile('u1')
    await untilInstalling()
    const repair = localDevService.reconcile('u1', true)
    install.finish(installed)
    const results = await Promise.all([first, repair])
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(results[0]).toBe(results[1])
  })
})

describe('managed PATH link ownership', () => {
  it.each(['/managed-backup/bin/cinna', '/managed/../other/cinna'])(
    'preserves the unrelated symlink to %s', async (destination) => {
      const target = join(agentsHome, '.local', 'bin', 'cinna')
      await mkdir(join(agentsHome, '.local', 'bin'), { recursive: true })
      await unlink(target).catch(() => {})
      await symlink(destination, target)
      expect(await localDevService.addToPath()).toMatchObject({ ok: false })
      expect(await readlink(target)).toBe(destination)
    }
  )

  it('refreshes the link pointing exactly to the managed launcher', async () => {
    const target = join(agentsHome, '.local', 'bin', 'cinna')
    await mkdir(join(agentsHome, '.local', 'bin'), { recursive: true })
    await unlink(target).catch(() => {})
    await symlink('/managed/bin/../bin/cinna', target)
    expect(await localDevService.addToPath()).toMatchObject({ ok: true, path: target })
    expect(await readlink(target)).toBe('/managed/bin/cinna')
  })
})
