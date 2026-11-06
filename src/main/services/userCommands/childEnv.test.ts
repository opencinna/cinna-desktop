import { describe, it, expect, vi } from 'vitest'

// The login shell and the shim helper, as a Mac without the developer tools
// sees them: the helper's own tests cover when it shims; this file only proves
// a user command's env goes through it.
vi.mock('../../shell/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shell/env')>()),
  getShellEnv: async () => ({ PATH: '/usr/bin:/bin', HOME: '/home/test', ANTHROPIC_API_KEY: 'must-not-inherit' })
}))
vi.mock('../../shell/developerToolShims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/developerToolShims')>()
  return {
    ...actual,
    withDeveloperToolShims: async (env: Record<string, string | undefined>) =>
      ({ ...env, PATH: `/data/${actual.SHIM_DIR_NAME}:${env.PATH ?? ''}` })
  }
})

const { userCommandShellEnv } = await import('./childEnv')
const { SHIM_DIR_NAME } = await import('../../shell/developerToolShims')

describe('a user command\'s env', () => {
  // A first `uv run` downloads a Python and patches it with `install_name_tool`,
  // found by PATH lookup: the /usr/bin stub raises Apple's install dialog.
  it('puts the developer-tool shims first on PATH, ahead of the /usr/bin stubs', async () => {
    const env = await userCommandShellEnv()
    expect(env.PATH?.split(':')[0]).toBe(`/data/${SHIM_DIR_NAME}`)
    expect(env.PATH?.split(':')).toContain('/usr/bin')
  })

  it('is narrowed to the child env, without the shell\'s secrets', async () => {
    expect((await userCommandShellEnv()).ANTHROPIC_API_KEY).toBeUndefined()
  })
})
