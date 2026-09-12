import { describe, it, expect } from 'vitest'
import { auditClaudeEnv, buildClaudeEnv, CLAUDE_STRIPPED_ENV } from './claudeEnv'

/**
 * The environment a spawned `claude` runs in.
 *
 * Two properties are load-bearing and they pull in opposite directions, which
 * is why both are asserted here rather than left to a reading of the runner:
 *
 * 1. **Nothing that can pay for a turn reaches the child.** `Options.env`
 *    replaces the subprocess environment entirely, so an `ANTHROPIC_API_KEY`
 *    that gets through does not fail — it silently bills the user's API account
 *    while the panel says the agent ran on their Claude plan.
 * 2. **`USER` and `HOME` *do* reach the child.** Without them the CLI reports
 *    "Not logged in" on a machine that is logged in, and the readiness ladder
 *    then tells the user to log in a CLI that was already fine. This is the
 *    defect the contract was written to record
 *    (`docs/agents/local_agents/claude_contract.md` §2), and it is the reason
 *    the second half of this file exists at all.
 */

const SHELL_ENV: NodeJS.ProcessEnv = {
  PATH: '/opt/homebrew/bin:/usr/bin',
  HOME: '/Users/someone',
  USER: 'someone',
  LOGNAME: 'someone',
  SHELL: '/bin/zsh',
  TERM: 'xterm-256color'
}

const build = (extra: NodeJS.ProcessEnv = {}): Record<string, string> =>
  buildClaudeEnv({ shellEnv: { ...SHELL_ENV, ...extra }, appVersion: '9.9.9', processEnv: {} })

/**
 * The same build, but through an allowlist wide enough to let the dangerous
 * names through the narrowing.
 *
 * Without this the strip is untestable: `CHILD_ENV_ALLOWLIST` does not contain
 * `ANTHROPIC_API_KEY` today, so the narrowing removes it and a mutation
 * deleting the strip entirely passes every test — which is precisely the state
 * where a future widening of that list quietly restores the billing trap. This
 * asserts the strip on its own terms, so it stays load-bearing whatever the
 * allowlist becomes.
 */
const buildWideOpen = (extra: NodeJS.ProcessEnv = {}): Record<string, string> => {
  const shellEnv = { ...SHELL_ENV, ...extra }
  return buildClaudeEnv({
    shellEnv,
    appVersion: '9.9.9',
    processEnv: {},
    allowlist: Object.keys(shellEnv)
  })
}

describe('buildClaudeEnv — what must reach the child', () => {
  it('passes USER and HOME, which the CLI cannot authenticate without', () => {
    const env = build()
    expect(env.USER).toBe('someone')
    expect(env.HOME).toBe('/Users/someone')
  })

  it('passes the login-shell PATH, so the agent’s own tools resolve', () => {
    expect(build().PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('identifies this app to the CLI', () => {
    expect(build().CLAUDE_AGENT_SDK_CLIENT_APP).toBe('cinna-desktop/9.9.9')
  })

  it('does not set CLAUDE_CODE_ENTRYPOINT, which the SDK owns', () => {
    // The SDK writes `sdk-ts` itself. Setting it here would misreport how the
    // CLI was invoked, to no benefit.
    expect(Object.hasOwn(build(), 'CLAUDE_CODE_ENTRYPOINT')).toBe(false)
  })
})

describe('buildClaudeEnv — what must never reach the child', () => {
  it.each(CLAUDE_STRIPPED_ENV)('strips %s even if the allowlist would pass it', (name) => {
    expect(Object.hasOwn(buildWideOpen({ [name]: 'something' }), name)).toBe(false)
  })

  it.each(CLAUDE_STRIPPED_ENV)('strips %s under the real allowlist too', (name) => {
    // Belt and braces: today the narrowing alone would do it, and this asserts
    // the end state a caller actually gets.
    expect(Object.hasOwn(build({ [name]: 'something' }), name)).toBe(false)
  })

  it('strips the local engine’s credential variables', () => {
    // These are how `configGenerator` pays OpenCode. On this path there is no
    // credential at all, and their presence would be a second way to pay for a
    // turn the user was told runs on their subscription.
    const env = buildWideOpen({
      CINNA_ENGINE_KEY_ANTHROPIC_AB12: 'sk-ant-real',
      CINNA_ENGINE_KEY_OPENAI_CD34: 'sk-real'
    })
    expect(Object.keys(env).filter((k) => k.startsWith('CINNA_ENGINE_KEY_'))).toEqual([])
  })

  it('strips an API key even when it arrives beside a valid login', () => {
    // The exact shape of the trap: the user has a working claude.ai login AND
    // an ANTHROPIC_API_KEY exported in their shell profile — which is the
    // normal state for the developers most likely to use this feature.
    const env = buildWideOpen({ ANTHROPIC_API_KEY: 'sk-ant-real-key' })
    expect(Object.hasOwn(env, 'ANTHROPIC_API_KEY')).toBe(false)
    // …and the login still works, which is the half that makes it a fix rather
    // than a blanket narrowing.
    expect(env.USER).toBe('someone')
    expect(env.HOME).toBe('/Users/someone')
    expect(Object.values(env)).not.toContain('sk-ant-real-key')
  })

  it('leaves nothing for the audit to find', () => {
    expect(
      auditClaudeEnv(
        buildWideOpen({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'y', CINNA_ENGINE_KEY_Z_1: 'z' })
      )
    ).toEqual([])
  })
})

describe('auditClaudeEnv', () => {
  it('names what leaked, so a regression is loud rather than silent', () => {
    // The audit exists because the environment is the one input whose
    // corruption is invisible in the result: a turn billed to the wrong account
    // looks exactly like a turn billed to the right one.
    expect(
      auditClaudeEnv({
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-leaked',
        CINNA_ENGINE_KEY_ANTHROPIC_AB12: 'sk-leaked'
      })
    ).toEqual(['ANTHROPIC_API_KEY', 'CINNA_ENGINE_KEY_ANTHROPIC_AB12'])
  })

  it('reports names, never values', () => {
    const found = auditClaudeEnv({ ANTHROPIC_API_KEY: 'sk-ant-secret-value' })
    expect(found).toEqual(['ANTHROPIC_API_KEY'])
    expect(found.join(' ')).not.toContain('sk-ant-secret-value')
  })
})
