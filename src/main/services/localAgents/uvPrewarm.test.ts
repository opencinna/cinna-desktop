vi.mock('../../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

// The bundled contract under `resources/`, as the scaffold test reads it.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => repoRoot, getVersion: () => '0.0.0-test', on: () => undefined }
}))

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))

// The login shell and the shim helper, as a Mac without the developer tools
// sees them: the helper's own tests cover when it shims; this file only proves
// the pre-warm's child goes through it.
vi.mock('../../shell/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shell/env')>()),
  getShellEnv: async () => ({ PATH: '/usr/bin:/bin', HOME: '/home/test' })
}))
vi.mock('../../shell/developerToolShims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/developerToolShims')>()
  return {
    ...actual,
    withDeveloperToolShims: async (env: Record<string, string | undefined>) =>
      ({ ...env, PATH: `/data/${actual.SHIM_DIR_NAME}:${env.PATH ?? ''}` })
  }
})

const { createUvPrewarm, prewarmRunEnv, realUvPrewarmDeps, TEMPLATE_PYTHON_VERSION_FILE, RETRY_BACKOFF_MS } = await import('./uvPrewarm')
const { SHIM_DIR_NAME } = await import('../../shell/developerToolShims')
const { ToolchainError } = await import('../../errors')
const { readContractFile } = await import('../../kit/contractStore')

const RUN_ENV = { PATH: '/usr/bin:/bin:/data/localdev/uv-0.12.10', UV_PYTHON_PREFERENCE: 'only-managed' }
const MANAGED_UV = '/data/localdev/uv-0.12.10/uv'

/** A fake toolchain and runner: nothing is downloaded and nothing runs. */
function world(options: { ensureUv?: () => Promise<unknown>; versionFile?: boolean; contractVersion?: string | null; uv?: string | null; code?: number; enabled?: boolean } = {}) {
  const ensureUv = vi.fn(options.ensureUv ?? (async () => ({})))
  const run = vi.fn(async (_bin: string, _args: readonly string[], _options: { env: NodeJS.ProcessEnv; cwd?: string }) =>
    ({ code: options.code ?? 0, stderr: '' }))
  const resolveUv = vi.fn(async (_env: NodeJS.ProcessEnv) => (options.uv === undefined ? MANAGED_UV : options.uv))
  const killRuns = vi.fn()
  const clock = { now: 1_000_000 }
  const prewarmer = createUvPrewarm({
    now: () => clock.now,
    enabled: () => options.enabled ?? true,
    killRuns,
    ensureUv,
    runEnv: async () => ({ ...RUN_ENV }),
    resolveUv,
    contractPythonVersion: () => (options.contractVersion === undefined ? '3.12' : options.contractVersion),
    hasPythonVersionFile: () => options.versionFile ?? true,
    run
  })
  return { prewarmer, ensureUv, run, resolveUv, killRuns, clock }
}

describe('uv pre-warm', () => {
  it('starts unknown, then installs uv and the agent\'s Python with the run env, in the agent folder', async () => {
    const { prewarmer, ensureUv, run, resolveUv } = world()
    expect(prewarmer.state()).toEqual({ uv: 'unknown', python: 'unknown' })
    await prewarmer.prewarm('/agents/Local/alpha')
    expect(ensureUv).toHaveBeenCalledTimes(1)
    expect(resolveUv).toHaveBeenCalledWith(RUN_ENV)
    expect(run).toHaveBeenCalledExactlyOnceWith(MANAGED_UV, ['python', 'install'], { env: RUN_ENV, cwd: '/agents/Local/alpha' })
    expect(prewarmer.state()).toEqual({ uv: 'ready', python: 'ready' })
  })

  it('names the contract\'s Python version when there is no agent folder', async () => {
    const { prewarmer, run } = world()
    await prewarmer.prewarm()
    expect(run).toHaveBeenCalledExactlyOnceWith(MANAGED_UV, ['python', 'install', '3.12'], { env: RUN_ENV })
  })

  it('names the contract\'s version for a folder with no .python-version', async () => {
    const { prewarmer, run } = world({ versionFile: false })
    await prewarmer.prewarm('/agents/Local/bare')
    expect(run).toHaveBeenCalledExactlyOnceWith(MANAGED_UV, ['python', 'install', '3.12'], { env: RUN_ENV, cwd: '/agents/Local/bare' })
  })

  it('reads the version the bundled contract\'s template pins', () => {
    expect(readContractFile(TEMPLATE_PYTHON_VERSION_FILE).trim()).toMatch(/^3\.\d+$/)
  })

  it('is single-flight: calls while one runs share it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { prewarmer, ensureUv, run } = world({ ensureUv: () => gate })
    const first = prewarmer.prewarm('/a')
    const second = prewarmer.prewarm('/b')
    expect(second).toBe(first)
    await vi.waitFor(() => expect(prewarmer.state().uv).toBe('installing'))
    release()
    await Promise.all([first, second])
    expect(ensureUv).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    // Done: a later call runs again (uv's install is cached by the toolchain).
    await prewarmer.prewarm('/c')
    expect(ensureUv).toHaveBeenCalledTimes(2)
  })

  it('stores a download failure rather than throwing, and still installs Python with a uv of the user\'s', async () => {
    const { prewarmer, run } = world({
      ensureUv: async () => { throw new ToolchainError('download_failed', 'Could not download uv: HTTP 503.') },
      uv: '/opt/homebrew/bin/uv'
    })
    await expect(prewarmer.prewarm()).resolves.toBeUndefined()
    expect(prewarmer.state()).toEqual({ uv: 'failed', python: 'ready', failure: { code: 'download_failed', message: 'Could not download uv: HTTP 503.' } })
    expect(run.mock.calls[0][0]).toBe('/opt/homebrew/bin/uv')
  })

  it('stores unsupported_platform, and fails Python when no uv resolves at all', async () => {
    const { prewarmer, run } = world({
      ensureUv: async () => { throw new ToolchainError('unsupported_platform', 'Cinna has no verified uv build for win32-x64.') },
      uv: null
    })
    await prewarmer.prewarm()
    expect(prewarmer.state()).toMatchObject({ uv: 'failed', python: 'failed', failure: { code: 'unsupported_platform' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('clears a stored failure once uv installs', async () => {
    let fail = true
    const { prewarmer } = world({ ensureUv: async () => { if (fail) throw new ToolchainError('download_failed', 'offline') } })
    await prewarmer.prewarm()
    expect(prewarmer.state().failure).toBeDefined()
    fail = false
    await prewarmer.prewarm()
    expect(prewarmer.state()).toEqual({ uv: 'ready', python: 'ready' })
  })

  it('marks Python failed on a non-zero install, and never throws', async () => {
    const { prewarmer } = world({ code: 2 })
    await expect(prewarmer.prewarm('/a')).resolves.toBeUndefined()
    expect(prewarmer.state()).toEqual({ uv: 'ready', python: 'failed' })
  })

  it('does nothing under CINNA_UV_PREWARM=off', async () => {
    const { prewarmer, ensureUv, run } = world({ enabled: false })
    await prewarmer.prewarm('/a')
    expect(ensureUv).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(prewarmer.state()).toEqual({ uv: 'unknown', python: 'unknown' })
  })

  it('on shutdown kills the install children and starts no more', async () => {
    const { prewarmer, ensureUv, killRuns } = world()
    prewarmer.shutdown()
    expect(killRuns).toHaveBeenCalledTimes(1)
    await prewarmer.prewarm()
    expect(ensureUv).not.toHaveBeenCalled()
  })

  it('spawns no Python install when the app started quitting during the uv download', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { prewarmer, run } = world({ ensureUv: () => gate })
    const running = prewarmer.prewarm()
    await vi.waitFor(() => expect(prewarmer.state().uv).toBe('installing'))
    prewarmer.shutdown()
    release()
    await running
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the reason a `uv …` command could not start', () => {
  const NOT_FOUND = { exitCode: 127, stderr: 'sh: uv: command not found\n' }

  it('starts a new pre-warm after a recorded failure, and says what failed', async () => {
    let fail = true
    const { prewarmer, ensureUv, clock } = world({ ensureUv: async () => { if (fail) throw new ToolchainError('download_failed', 'offline') }, uv: null })
    await prewarmer.prewarm()
    expect(ensureUv).toHaveBeenCalledTimes(1)
    fail = false
    clock.now += RETRY_BACKOFF_MS
    const reason = await prewarmer.unavailableReason('uv run scripts/status.py', NOT_FOUND)
    expect(reason).toContain('Cinna could not download its copy of uv (offline).')
    await vi.waitFor(() => expect(prewarmer.state().uv).toBe('ready'))
    expect(ensureUv).toHaveBeenCalledTimes(2)
  })

  it('starts none within the back-off after a failed install', async () => {
    const { prewarmer, ensureUv, clock } = world({ ensureUv: async () => { throw new ToolchainError('download_failed', 'offline') }, uv: null })
    await prewarmer.prewarm()
    clock.now += RETRY_BACKOFF_MS - 1
    expect(await prewarmer.unavailableReason('uv run x.py', NOT_FOUND)).toContain('(offline)')
    expect(ensureUv).toHaveBeenCalledTimes(1)
  })

  it('never starts one when the platform has no uv build', async () => {
    const { prewarmer, ensureUv, clock } = world({
      ensureUv: async () => { throw new ToolchainError('unsupported_platform', 'Cinna has no verified uv build for win32-x64.') },
      uv: null
    })
    await prewarmer.prewarm()
    clock.now += RETRY_BACKOFF_MS * 10
    expect(await prewarmer.unavailableReason('uv run x.py', NOT_FOUND)).toContain('no uv build for this platform')
    expect(ensureUv).toHaveBeenCalledTimes(1)
  })

  it('starts one when none ever ran (an agent that was not scaffolded here)', async () => {
    const { prewarmer, ensureUv } = world({ uv: null })
    expect(await prewarmer.unavailableReason('uv run x.py', NOT_FOUND)).toContain('still installing')
    expect(ensureUv).toHaveBeenCalledTimes(1)
  })

  it('starts none while one is installing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { prewarmer, ensureUv } = world({ ensureUv: () => gate })
    const running = prewarmer.prewarm()
    expect(prewarmer.state().uv).toBe('installing')
    const spy = vi.spyOn(prewarmer, 'prewarm')
    expect(await prewarmer.unavailableReason('uv run x.py', NOT_FOUND)).toContain('still installing')
    expect(spy).not.toHaveBeenCalled()
    expect(ensureUv).toHaveBeenCalledTimes(1)
    release()
    await running
  })

  it('is null, and starts nothing, for a 127 passed through by a uv that resolves', async () => {
    const { prewarmer, ensureUv, resolveUv } = world({ uv: '/opt/homebrew/bin/uv' })
    expect(await prewarmer.unavailableReason('uv run x.py', { exitCode: 127, stderr: 'jq: command not found' })).toBeNull()
    expect(resolveUv).toHaveBeenCalledWith(RUN_ENV)
    expect(ensureUv).not.toHaveBeenCalled()
  })
})

describe('the pre-warm\'s child env', () => {
  // `uv python install` patches the Python it downloads with `install_name_tool`,
  // found by PATH lookup: the /usr/bin stub raises Apple's install dialog.
  it('puts the developer-tool shims first on PATH, ahead of the /usr/bin stubs', async () => {
    const env = await prewarmRunEnv()
    expect(env.PATH?.split(':')[0]).toBe(`/data/${SHIM_DIR_NAME}`)
    expect(env.PATH?.split(':')).toContain('/usr/bin')
  })

  it('is the env the real pre-warm runs uv in', () => {
    expect(realUvPrewarmDeps.runEnv).toBe(prewarmRunEnv)
  })
})
