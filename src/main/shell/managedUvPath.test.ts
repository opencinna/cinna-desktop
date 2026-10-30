import { describe, it, expect, vi } from 'vitest'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))

const { createManagedUvPath, uvCouldNotStart, uvUnavailableMessage } = await import('./managedUvPath')

const MANAGED = '/data/localdev/uv-0.12.10'
const UV_DIR_VARS = ['UV_CACHE_DIR', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'UV_PYTHON_INSTALL_DIR']

type Env = Record<string, string | undefined>

/** `executables` are the absolute paths that exist and run. */
function fallback(options: { platform?: NodeJS.Platform; executables?: string[]; uvDir?: string } = {}): { apply(env: Env): Promise<Env> } {
  const executables = new Set(options.executables ?? [])
  return createManagedUvPath({
    platform: options.platform ?? 'darwin',
    uvDir: () => options.uvDir ?? MANAGED,
    isExecutable: async (candidate) => executables.has(candidate)
  })
}

describe('withManagedUvFallback', () => {
  it('appends the managed uv directory after the user\'s PATH, never before it', async () => {
    const env = await fallback().apply({ PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/home/u' })
    expect(env.PATH).toBe(`/opt/homebrew/bin:/usr/bin:/bin:${MANAGED}`)
    expect(env.HOME).toBe('/home/u')
  })

  it('appends even to an empty or missing PATH', async () => {
    expect((await fallback().apply({})).PATH).toBe(MANAGED)
    expect((await fallback().apply({ PATH: '' })).PATH).toBe(MANAGED)
  })

  it('is idempotent: a second pass adds nothing and returns the same env', async () => {
    const shaper = fallback()
    const once = await shaper.apply({ PATH: '/usr/bin:/bin' })
    const twice = await shaper.apply(once)
    expect(twice).toBe(once)
    expect(twice.PATH!.split(':').filter((entry) => entry === MANAGED)).toHaveLength(1)
  })

  it('moves an earlier copy of the directory to the end rather than duplicating it', async () => {
    const env = await fallback().apply({ PATH: `${MANAGED}:/usr/bin:/bin` })
    expect(env.PATH).toBe(`/usr/bin:/bin:${MANAGED}`)
  })

  it('never sets any of uv\'s directory variables, with or without a uv of the user\'s', async () => {
    for (const executables of [[], ['/opt/homebrew/bin/uv']]) {
      const env = await fallback({ executables }).apply({ PATH: '/opt/homebrew/bin:/usr/bin' })
      for (const name of UV_DIR_VARS) expect(env).not.toHaveProperty(name)
    }
  })

  it('sets UV_PYTHON_PREFERENCE=only-managed when no uv resolves before the managed one', async () => {
    const env = await fallback().apply({ PATH: '/usr/bin:/bin' })
    expect(env.UV_PYTHON_PREFERENCE).toBe('only-managed')
  })

  it('leaves the preference alone when the user has their own uv on PATH', async () => {
    const env = await fallback({ executables: ['/opt/homebrew/bin/uv'] }).apply({ PATH: '/opt/homebrew/bin:/usr/bin' })
    expect(env).not.toHaveProperty('UV_PYTHON_PREFERENCE')
  })

  it('does not count the managed uv itself as the user\'s uv', async () => {
    const env = await fallback({ executables: [`${MANAGED}/uv`] }).apply({ PATH: `/usr/bin:${MANAGED}:/bin` })
    expect(env.UV_PYTHON_PREFERENCE).toBe('only-managed')
  })

  it('keeps a preference the env already sets', async () => {
    const env = await fallback().apply({ PATH: '/usr/bin', UV_PYTHON_PREFERENCE: 'system' })
    expect(env.UV_PYTHON_PREFERENCE).toBe('system')
  })

  it('on Windows, appends to the env\'s own `Path` key with `;`, and adds no second PATH', async () => {
    const dir = 'C:\\Users\\u\\AppData\\Roaming\\Cinna\\localdev\\uv-0.12.10'
    const env = await fallback({ platform: 'win32', uvDir: dir }).apply({ Path: 'C:\\Windows;C:\\Windows\\System32' })
    expect(env.Path).toBe(`C:\\Windows;C:\\Windows\\System32;${dir}`)
    expect(env).not.toHaveProperty('PATH')
  })

  it('on Windows, finds the user\'s uv.exe through PATHEXT', async () => {
    const env = await fallback({ platform: 'win32', uvDir: 'C:\\cinna\\uv', executables: ['C:\\tools\\uv.EXE'] })
      .apply({ Path: 'C:\\tools', PATHEXT: '.COM;.EXE' })
    expect(env).not.toHaveProperty('UV_PYTHON_PREFERENCE')
  })

  it('returns the env unchanged when the managed directory cannot be named', async () => {
    const shaper = createManagedUvPath({
      platform: 'darwin',
      uvDir: () => { throw new Error('Runtime host is not installed.') },
      isExecutable: async () => false
    })
    const env = { PATH: '/usr/bin' }
    expect(await shaper.apply(env)).toBe(env)
  })
})

describe('uvCouldNotStart', () => {
  const absent = async (): Promise<boolean> => false
  const present = async (): Promise<boolean> => true

  it('is a `uv …` command that exited 127 with no uv on the child\'s PATH', async () => {
    expect(await uvCouldNotStart('uv run scripts/status.py', { exitCode: 127, stderr: '' }, absent, 'darwin')).toBe(true)
  })

  it('is not a 127 that uv passed through from its own child, when uv resolves', async () => {
    const stderr = 'scripts/status.sh: line 2: jq: command not found\n'
    expect(await uvCouldNotStart('uv run scripts/status.py', { exitCode: 127, stderr }, present, 'darwin')).toBe(false)
  })

  it('only looks the uv up for a 127 without a uv-specific line', async () => {
    const resolves = vi.fn(present)
    await uvCouldNotStart('uv run x.py', { exitCode: 1, stderr: '' }, resolves, 'darwin')
    await uvCouldNotStart('uv run x.py', { exitCode: 127, stderr: 'sh: uv: command not found' }, resolves, 'darwin')
    expect(resolves).not.toHaveBeenCalled()
  })

  it('is a `uv …` command whose shell said uv was not found, in sh, dash, bash or zsh words', async () => {
    for (const stderr of ['sh: uv: command not found\n', 'sh: 1: uv: not found\n', 'bash: uv: command not found\n', 'zsh: command not found: uv\n']) {
      expect(await uvCouldNotStart('uv run x.py', { exitCode: 127, stderr }, present, 'linux')).toBe(true)
    }
  })

  it('on Windows, is "is not recognized"', async () => {
    const stderr = "'uv' is not recognized as an internal or external command"
    expect(await uvCouldNotStart('uv run x.py', { exitCode: 1, stderr }, present, 'win32')).toBe(true)
    expect(await uvCouldNotStart('uv run x.py', { exitCode: 1, stderr }, present, 'darwin')).toBe(false)
  })

  it('is not any other command, nor an ordinary failure of uv', async () => {
    expect(await uvCouldNotStart('python3 x.py', { exitCode: 127, stderr: 'sh: python3: command not found' }, absent, 'darwin')).toBe(false)
    expect(await uvCouldNotStart('uvx thing', { exitCode: 127, stderr: '' }, absent, 'darwin')).toBe(false)
    expect(await uvCouldNotStart('uv run x.py', { exitCode: 1, stderr: 'Traceback …\nValueError' }, absent, 'darwin')).toBe(false)
  })
})

describe('uvUnavailableMessage', () => {
  it('says Cinna is still installing when nothing failed', () => {
    expect(uvUnavailableMessage()).toBe('uv is not available, so this command could not start. Cinna is still installing its copy; try again in a moment.')
  })

  it('says to install uv on a platform Cinna has no build for', () => {
    expect(uvUnavailableMessage({ code: 'unsupported_platform', message: 'no build' })).toBe(
      'uv is not available, so this command could not start. Cinna has no uv build for this platform; install uv (https://docs.astral.sh/uv/) and run it again.')
  })

  it('names the download failure and says to check the network', () => {
    expect(uvUnavailableMessage({ code: 'download_failed', message: 'HTTP 503' })).toBe(
      'uv is not available, so this command could not start. Cinna could not download its copy of uv (HTTP 503). Check the network connection and run it again.')
  })
})
