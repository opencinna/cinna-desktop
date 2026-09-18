import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  ClaudeAuthProbe,
  parseClaudeAuthStatus,
  probeClaudeAuth,
  type ClaudeAuthStatus
} from './claudeAuth'

const log = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn() }))
vi.mock('../../../logger/logger', () => ({ createLogger: () => log }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/**
 * The readiness probe, driven with no binary.
 *
 * What is asserted here is the pair of rules that came out of watching the real
 * `claude` 2.1.266 and that nothing in a type or a man page would have given
 * us: **a logged-out install exits non-zero and still answers on stdout**, so
 * the exit code must not gate the parse; and **an unreadable answer is
 * `unknown`, never `logged_out`**, so a CLI whose output shape moves cannot
 * lock every user out of an engine that still works.
 *
 * The second half of the verification is not here and cannot be: whether the
 * command behaves this way is a fact about the binary, recorded in
 * `docs/agents/local_agents/claude_contract.md` §5 and re-checked by hand.
 *
 * The third rule is about what leaves this module: the account's email is read,
 * because the panel's whole question is which login pays; the organisation id
 * and name are not, because nothing asked. The test below pins both halves, so
 * a later "while we are here" widening has to argue with a named assertion.
 */

const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
  analyticsDisabled: false,
  projectsDirectory: '/Users/x/.claude/projects',
  // The three fields this module must never surface. Present here precisely so
  // a test can assert they do not come back out.
  email: 'someone@example.com',
  orgId: 'org_abc123',
  orgName: 'Example Org'
})

/** What the CLI prints when it is logged out: fewer keys, and no account at all. */
const LOGGED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: 'none',
  apiProvider: 'firstParty',
  analyticsDisabled: false,
  projectsDirectory: '/Users/x/.claude/projects'
})

describe('parseClaudeAuthStatus', () => {
  it('reads a logged-in install as logged in, with its plan', () => {
    expect(parseClaudeAuthStatus(LOGGED_IN)).toEqual({
      state: 'logged_in',
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      email: 'someone@example.com'
    })
  })

  it('carries the account, and never the organisation', () => {
    // Not a formality, and the asymmetry is the point. The email answers the
    // question the panel exists to ask — which login pays for this turn — and a
    // tier alone cannot, on a machine holding more than one Claude login. The
    // organisation fields answer nothing anybody asked, so nothing reads them,
    // and a field nothing reads cannot leak from a debug line added later.
    const status = parseClaudeAuthStatus(LOGGED_IN) as unknown as Record<string, unknown>
    expect(Object.keys(status).sort()).toEqual(['authMethod', 'email', 'state', 'subscriptionType'])
    expect(status.email).toBe('someone@example.com')
    expect(JSON.stringify(status)).not.toMatch(/org_abc123|Example Org/)
  })

  it('reads a logged-out install as logged out, and asserts no plan for it', () => {
    expect(parseClaudeAuthStatus(LOGGED_OUT)).toEqual({
      state: 'logged_out',
      authMethod: 'none',
      subscriptionType: null,
      // A logged-out install has no `email` field at all — there is no account.
      email: null
    })
  })

  it.each([
    ['nothing at all', ''],
    ['a sentence rather than JSON', 'Usage: claude auth status'],
    ['valid JSON that is not an object', '"logged in"'],
    ['null', 'null'],
    ['an object with no verdict in it', '{"authMethod":"claude.ai"}'],
    // The dangerous one: a CLI that starts reporting a string would otherwise
    // be read as a definite "no" by any truthiness test.
    ['a verdict that is not a boolean', '{"loggedIn":"true"}']
  ])('%s is unknown, not logged out', (_label, stdout) => {
    expect(parseClaudeAuthStatus(stdout)).toEqual({
      state: 'unknown',
      authMethod: null,
      subscriptionType: null,
      email: null
    })
  })
})

describe('probeClaudeAuth', () => {
  /** `execFile`'s shape, with the arguments captured. */
  function stubExec(
    answer: { code: number | null; stdout: string; stderr?: string },
    seen?: { path?: string; args?: readonly string[]; env?: Record<string, string> }
  ): Parameters<typeof probeClaudeAuth>[0]['exec'] {
    return ((
      path: string,
      args: readonly string[],
      options: { env?: Record<string, string> },
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      if (seen) {
        seen.path = path
        seen.args = args
        seen.env = options.env
      }
      const err = answer.code === 0 ? null : Object.assign(new Error('Command failed'), { code: answer.code })
      setTimeout(() => cb(err, answer.stdout, answer.stderr ?? ''), 0)
      return undefined as never
    }) as unknown as Parameters<typeof probeClaudeAuth>[0]['exec']
  }

  it.each([true, false])('cancels the fallback timeout after a valid loggedIn=%s answer', async (loggedIn) => {
    vi.useFakeTimers()
    const pending = probeClaudeAuth({ claudePath: '/opt/claude', env: {},
      exec: stubExec({ code: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn }) }) })
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).state).toBe(loggedIn ? 'logged_in' : 'logged_out')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(6000)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('still reports a genuine timeout when the process never completes its callback', async () => {
    vi.useFakeTimers()
    const pending = probeClaudeAuth({ claudePath: '/opt/claude', env: {}, timeoutMs: 5,
      exec: (() => undefined) as unknown as Parameters<typeof probeClaudeAuth>[0]['exec'] })
    await vi.advanceTimersByTimeAsync(505)
    expect((await pending).state).toBe('unknown')
    expect(log.warn).toHaveBeenCalledWith('claude auth status did not answer in time', { timeoutMs: 5 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads a logged-out answer that exited 1 — the exit code is not the signal', async () => {
    // Measured against claude 2.1.266: exit 0 logged in, exit **1** logged out,
    // valid JSON and an empty stderr in both. Branching on the error here is
    // the whole defect this module exists to avoid — it would turn the one
    // state worth detecting back into "we could not tell".
    const status = await probeClaudeAuth({
      claudePath: '/usr/local/bin/claude',
      env: { PATH: '/usr/bin', HOME: '/Users/x', USER: 'x' },
      exec: stubExec({ code: 1, stdout: LOGGED_OUT })
    })
    expect(status.state).toBe('logged_out')
  })

  it('asks the resolved path, with `auth status`, in the environment it was given', async () => {
    const seen: { path?: string; args?: readonly string[]; env?: Record<string, string> } = {}
    // The environment matters more than it looks: withholding `USER` makes a
    // logged-in install report itself logged out, so a probe run under a
    // different environment than the turn answers about a different process.
    const env = { PATH: '/usr/bin', HOME: '/Users/x', USER: 'x' }
    await probeClaudeAuth({ claudePath: '/opt/claude', env, exec: stubExec({ code: 0, stdout: LOGGED_IN }, seen) })

    expect(seen.path).toBe('/opt/claude')
    expect(seen.args).toEqual(['auth', 'status'])
    expect(seen.env).toEqual(env)
  })

  it('a probe that never calls back is unknown rather than a hang', async () => {
    vi.useFakeTimers()
    try {
      const pending = probeClaudeAuth({
        claudePath: '/usr/local/bin/claude',
        env: {},
        timeoutMs: 50,
        // A shim whose grandchild holds stdout open: `execFile`'s own timeout
        // fires on close, so the callback never comes.
        exec: (() => undefined as never) as unknown as Parameters<typeof probeClaudeAuth>[0]['exec']
      })
      await vi.advanceTimersByTimeAsync(600)
      expect((await pending).state).toBe('unknown')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a binary that cannot be spawned at all is unknown, not logged out', async () => {
    const status = await probeClaudeAuth({
      claudePath: '/nope/claude',
      env: {},
      exec: stubExec({ code: 127, stdout: '' })
    })
    expect(status.state).toBe('unknown')
  })
})

describe('ClaudeAuthProbe', () => {
  function harness(
    over: Partial<{ answers: ClaudeAuthStatus[]; claudePath: string | null; ttlMs: number }> = {}
  ): { probe: ClaudeAuthProbe; calls: () => number; tick: (ms: number) => void } {
    const answers = over.answers ?? [{ state: 'logged_in', authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com' }]
    let n = 0
    let now = 1_000_000
    const probe = new ClaudeAuthProbe({
      claudePath: async () => (over.claudePath === undefined ? '/usr/local/bin/claude' : over.claudePath),
      env: async () => ({ PATH: '/usr/bin', HOME: '/Users/x', USER: 'x' }),
      ttlMs: over.ttlMs,
      now: () => now,
      probe: async () => answers[Math.min(n++, answers.length - 1)]
    })
    return { probe, calls: () => n, tick: (ms) => void (now += ms) }
  }

  it('asks once and reuses the answer inside its window', async () => {
    const { probe, calls } = harness({ ttlMs: 30_000 })
    expect((await probe.status()).state).toBe('logged_in')
    await probe.status()
    await probe.status()
    expect(calls()).toBe(1)
  })

  it('asks again once the window has passed — a user who has just logged in must not stay locked out', async () => {
    const { probe, calls, tick } = harness({
      ttlMs: 30_000,
      answers: [
        { state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null },
        { state: 'logged_in', authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com' }
      ]
    })
    expect((await probe.status()).state).toBe('logged_out')
    tick(30_001)
    expect((await probe.status()).state).toBe('logged_in')
    expect(calls()).toBe(2)
  })

  it('`refresh` drops the answer immediately, for the user who acted on the remedy', async () => {
    const { probe, tick } = harness({
      ttlMs: 30_000,
      answers: [
        { state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null },
        { state: 'logged_in', authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com' }
      ]
    })
    await probe.status()
    tick(10)
    expect((await probe.refresh()).state).toBe('logged_in')
  })

  it('a panel render and a turn starting together spawn one child, not two', async () => {
    const { probe, calls } = harness()
    const [a, b] = await Promise.all([probe.status(), probe.status()])
    expect(calls()).toBe(1)
    expect(a).toEqual(b)
  })

  it('never rejects, whichever of its dependencies throws', async () => {
    // Both do real work — detection walks the login-shell PATH, `getShellEnv`
    // sources a profile — and `runTurn` awaits this *outside* its own `try`, so
    // a rejection would escape as a thrown turn: the never-throws contract
    // broken by the check that exists to make turns fail less.
    for (const deps of [
      { claudePath: async () => { throw new Error('PATH walk failed') }, env: async () => ({}) },
      { claudePath: async () => '/usr/local/bin/claude', env: async () => { throw new Error('no shell env') } }
    ]) {
      const probe = new ClaudeAuthProbe({ ...deps, probe: async () => ({ state: 'logged_in', authMethod: null, subscriptionType: null, email: 'someone@example.com' }) })
      await expect(probe.status()).resolves.toMatchObject({ state: 'unknown', email: null })
    }
  })

  it('no install on this machine is unknown, and nothing is spawned to find out', async () => {
    const { probe, calls } = harness({ claudePath: null })
    // "There is no Claude Code here" is a different sentence, and it outranks
    // this one everywhere it is read — so it stays the caller's to say.
    expect((await probe.status()).state).toBe('unknown')
    expect(calls()).toBe(0)
  })

  it('does not keep "nothing to ask": the turn that installs the CLI is asked about its login', async () => {
    let path: string | null = null
    let asked = 0
    const probe = new ClaudeAuthProbe({
      claudePath: async () => path, env: async () => ({}), ttlMs: 30_000, now: () => 1,
      probe: async () => { asked++; return { state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null } }
    })
    expect((await probe.status()).state).toBe('unknown')
    path = '/runtimes/claude-2.1.276/claude' // the first turn's install landed
    expect((await probe.status()).state).toBe('logged_out')
    expect(asked).toBe(1)
  })

  it('`invalidate` forgets an answer asked of another binary, and drops one still in flight', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const answers: ClaudeAuthStatus[] = [
      { state: 'logged_in', authMethod: 'claude.ai', subscriptionType: 'max', email: 'old@example.com' },
      { state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null }
    ]
    let n = 0
    const probe = new ClaudeAuthProbe({
      claudePath: async () => '/a/claude', env: async () => ({}), ttlMs: 30_000, now: () => 1,
      probe: async () => { const answer = answers[n++]; if (n === 1) await held; return answer }
    })
    const stale = probe.status()
    probe.invalidate() // the Claude Path changed while the old binary was being asked
    const current = probe.status()
    release()
    expect((await stale).state).toBe('logged_in') // its own caller still hears it
    expect((await current).state).toBe('logged_out')
    // …and the late, stale answer was not written over the current one.
    expect((await probe.status()).state).toBe('logged_out')
    expect(n).toBe(2)
  })
})
