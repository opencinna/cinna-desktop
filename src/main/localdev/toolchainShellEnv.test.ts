import { describe, it, expect, vi } from 'vitest'

// The login shell and the shim helper, as a Mac without the developer tools
// sees them: the helper's own tests cover when it shims; this file only proves
// the toolchain's base env goes through it.
vi.mock('../shell/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shell/env')>()),
  getShellEnv: async () => ({ PATH: '/usr/bin:/bin', HOME: '/home/test' })
}))
vi.mock('../shell/developerToolShims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shell/developerToolShims')>()
  return {
    ...actual,
    withDeveloperToolShims: async (env: Record<string, string | undefined>) =>
      ({ ...env, PATH: `/data/${actual.SHIM_DIR_NAME}:${env.PATH ?? ''}` })
  }
})

const { toolchainShellEnv, realToolchainDeps } = await import('./toolchain')
const { SHIM_DIR_NAME } = await import('../shell/developerToolShims')

describe('the local-dev toolchain\'s base env', () => {
  // `uv tool install cinna-cli` downloads a Python and patches it with
  // `install_name_tool`, found by PATH lookup: the /usr/bin stub raises Apple's
  // install dialog on a Mac without the command line tools.
  it('puts the developer-tool shims ahead of the /usr/bin stubs', async () => {
    const path = (await toolchainShellEnv()).PATH?.split(':') ?? []
    expect(path[0]).toBe(`/data/${SHIM_DIR_NAME}`)
    expect(path.indexOf(`/data/${SHIM_DIR_NAME}`)).toBeLessThan(path.indexOf('/usr/bin'))
  })

  it('is the env every toolchain spawn is built from', () => {
    expect(realToolchainDeps().shellEnv).toBe(toolchainShellEnv)
  })
})
