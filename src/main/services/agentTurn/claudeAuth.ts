/**
 * Whether the user's own `claude` install is logged in — asked **before** a
 * turn, for free.
 *
 * ## Why this exists
 *
 * Readiness on this engine had two answerable states and one that was not.
 * "There is no `claude` on this machine" comes from `toolDetectionService`
 * without spawning anything. "That install is not logged in" did not: the
 * runner learned it from a **thrown turn error** and told the two apart by
 * matching the CLI's own words (`claudeAgentTurnRunner.isNotLoggedIn`). That
 * works, but it is the wrong shape — the user asks a question, the app spends a
 * turn's worth of latency, and the answer is an error about authentication.
 *
 * `claude auth status` closes it. It logs nothing in or out, runs no turn, and
 * bills nothing. See `docs/agents/local_agents/claude_contract.md` §5.
 *
 * ## Three things learned from the binary, two of which are traps
 *
 * 1. **A logged-out install exits 1, and its answer is still on stdout.**
 *    Measured against `claude` 2.1.266, three runs per state, two independent
 *    ways of being logged out (`USER` withheld, and an empty `HOME` with `USER`
 *    present): exit **0** logged in, exit **1** logged out, valid JSON and an
 *    empty stderr in both. So the exit code must not gate the parse — treating
 *    non-zero as "the probe failed" turns the one state this module exists to
 *    detect into `unknown`, and readiness silently goes back to being answered
 *    by a billed turn. *(The contract's §5 recorded exit 0 in every state; that
 *    row was wrong, and is corrected there.)*
 * 2. **The JSON field is the signal.** `loggedIn` is a boolean and is the only
 *    thing consulted. Absent or non-boolean is `unknown`, never `logged_out`:
 *    a CLI whose output shape moved must not lock every user out of an engine
 *    that works.
 * 3. **The probe must run in the same environment the turn will.** The whole
 *    `USER` finding is that this binary answers differently depending on the
 *    child environment — the very first bisect was run *with this command*. A
 *    probe under the full shell environment would cheerfully report a login for
 *    a child that then cannot authenticate, which is worse than not probing.
 *    Hence {@link ClaudeAuthProbe} takes {@link buildClaudeEnv}'s output, not
 *    `process.env`.
 *
 * ## What is deliberately not read
 *
 * The response also carries the account's **email**, **organisation id** and
 * organisation name. None of the three is lifted out of the JSON — not into the
 * returned shape, not into a log line, not across IPC. That is stronger than a
 * rule about logging: a field that is never read cannot leak from a debug line
 * somebody adds later. What is kept is the plan type, which says who pays
 * without saying who they are.
 */

import { execFile } from 'node:child_process'
import { createLogger } from '../../logger/logger'
import type { ClaudeAuthStatus } from '../../../shared/engine'

export type { ClaudeAuthState, ClaudeAuthStatus } from '../../../shared/engine'

/**
 * **States and durations only — never `stdout`.** The CLI's answer carries the
 * account's email, `orgId` and `orgName`, and the reason
 * {@link parseClaudeAuthStatus} never reads them is so that no line here can
 * print one. A log of the raw output would undo that in one edit.
 */
const logger = createLogger('claude-auth')

const UNKNOWN: ClaudeAuthStatus = { state: 'unknown', authMethod: null, subscriptionType: null }

/** How long the probe may take. Observed at ~0.27s; this is a hang guard. */
export const CLAUDE_AUTH_TIMEOUT_MS = 5000

/** How long an answer is reused before the binary is asked again. */
export const CLAUDE_AUTH_TTL_MS = 30_000

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Read `claude auth status`'s stdout.
 *
 * Pure, so the one rule that matters — a boolean field decides, and nothing
 * else does — is asserted without a binary.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return UNKNOWN
  }
  if (typeof parsed !== 'object' || parsed === null) return UNKNOWN
  const record = parsed as Record<string, unknown>
  // Not `!!record.loggedIn`: a missing field would then read as a definite
  // "logged out" and lock the user out of a working engine.
  if (typeof record.loggedIn !== 'boolean') return UNKNOWN
  return {
    state: record.loggedIn ? 'logged_in' : 'logged_out',
    authMethod: str(record.authMethod),
    subscriptionType: str(record.subscriptionType)
  }
}

export interface ClaudeAuthProbeInput {
  /** Absolute path of the `claude` to ask. Never a bare name. */
  claudePath: string
  /** The child environment, from `buildClaudeEnv` — see the header. */
  env: Record<string, string>
  timeoutMs?: number
  /** Injected for tests; production uses `node:child_process`. */
  exec?: typeof execFile
}

/**
 * Ask one `claude` whether it is logged in.
 *
 * Never rejects. Every failure is `unknown`, because the only thing a failed
 * probe justifies is *not blocking the turn*: the runner's error-text fallback
 * is still there, and a readiness check that can refuse a working engine is
 * worse than no readiness check.
 */
export async function probeClaudeAuth(input: ClaudeAuthProbeInput): Promise<ClaudeAuthStatus> {
  const timeoutMs = input.timeoutMs ?? CLAUDE_AUTH_TIMEOUT_MS
  const run = input.exec ?? execFile
  const startedAt = Date.now()
  const probe = new Promise<ClaudeAuthStatus>((resolve) => {
    run(
      input.claudePath,
      ['auth', 'status'],
      { timeout: timeoutMs, env: input.env, windowsHide: true, killSignal: 'SIGKILL' },
      // **`err` is not consulted.** A logged-out install exits 1 with its
      // answer on stdout; branching on the error here is the defect this
      // module was written to avoid.
      (_err, stdout) => {
        const status = parseClaudeAuthStatus(`${stdout}`)
        if (status.state === 'unknown') {
          // Four different causes land here — an unspawnable binary, non-JSON
          // output, a `loggedIn` that is not a boolean, a timeout — and every
          // one of them silently degrades the panel to its weaker sentence.
          // Without a line here, "it never says I am logged in" leaves no trace
          // anywhere. The byte count stands in for the output itself.
          logger.warn('claude auth status gave no usable verdict', {
            durationMs: Date.now() - startedAt,
            stdoutBytes: `${stdout}`.length
          })
        } else {
          logger.debug('claude auth status', {
            state: status.state,
            authMethod: status.authMethod,
            durationMs: Date.now() - startedAt
          })
        }
        resolve(status)
      }
    )
  })
  // Raced against our own timer for the reason `toolDetectionService.probeVersion`
  // documents: `execFile`'s `timeout` fires on **close**, which waits for the
  // stdio pipes to reach EOF, so a shim whose grandchild inherits stdout keeps
  // the callback pending after the direct child is dead.
  return Promise.race([
    probe,
    new Promise<ClaudeAuthStatus>((resolve) =>
      setTimeout(() => {
        logger.warn('claude auth status did not answer in time', { timeoutMs })
        resolve(UNKNOWN)
      }, timeoutMs + 500).unref?.()
    )
  ])
}

export interface ClaudeAuthProbeDeps {
  /** The `claude` this machine has, or null. `toolDetectionService`'s answer. */
  claudePath(): Promise<string | null>
  /** The child environment the turn would use. */
  env(): Promise<Record<string, string>>
  ttlMs?: number
  now?: () => number
  probe?: typeof probeClaudeAuth
}

/**
 * The cached answer.
 *
 * **Time-boxed rather than cached for the app's lifetime**, which is where
 * detection sits. Whether a binary exists barely changes while the app is open;
 * whether it is logged in changes precisely because the app just told the user
 * to go and log in, and a permanently cached "no" would leave them staring at
 * the alarm they had already fixed.
 *
 * The in-flight promise is shared, so a panel render and a turn starting
 * together spawn one child rather than two.
 */
export class ClaudeAuthProbe {
  private cached: { at: number; value: ClaudeAuthStatus } | null = null
  private inFlight: Promise<ClaudeAuthStatus> | null = null

  constructor(private readonly deps: ClaudeAuthProbeDeps) {}

  private get ttl(): number {
    return this.deps.ttlMs ?? CLAUDE_AUTH_TTL_MS
  }

  private get clock(): number {
    return (this.deps.now ?? Date.now)()
  }

  async status(): Promise<ClaudeAuthStatus> {
    if (this.cached && this.clock - this.cached.at < this.ttl) return this.cached.value
    if (this.inFlight) return this.inFlight
    this.inFlight = this.run().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * Drop the cached answer and ask again — for a user who has just logged in.
   *
   * A refresh landing while a probe is already in flight **joins that one**
   * rather than starting a second. That is deliberate and not a staleness bug:
   * the in-flight probe is a `claude` spawned moments ago and bounded at five
   * seconds, so its answer is as current as a new one would be, and two
   * children for one question is the thing worth avoiding.
   */
  refresh(): Promise<ClaudeAuthStatus> {
    this.cached = null
    return this.status()
  }

  private async run(): Promise<ClaudeAuthStatus> {
    try {
      return await this.ask()
    } catch {
      // **Never rejects.** `probeClaudeAuth` already cannot, but `claudePath()`
      // and `env()` are injected and both do real work — detection walks the
      // login-shell PATH, `getShellEnv` sources a profile. A rejection here
      // would surface at `runTurn`'s `await this.deps.claudeAuth()`, which sits
      // outside its `try`, and break the never-throws contract on the one path
      // that exists to make a turn *less* likely to fail.
      return this.remember(UNKNOWN)
    }
  }

  private async ask(): Promise<ClaudeAuthStatus> {
    const claudePath = await this.deps.claudePath()
    // No install is not "unknown login", but it is not this module's sentence
    // either: `claude_not_installed` outranks it everywhere it is read, and
    // caching an `unknown` here keeps that ordering the caller's decision.
    if (!claudePath) return this.remember(UNKNOWN)
    const probe = this.deps.probe ?? probeClaudeAuth
    return this.remember(await probe({ claudePath, env: await this.deps.env() }))
  }

  private remember(value: ClaudeAuthStatus): ClaudeAuthStatus {
    this.cached = { at: this.clock, value }
    return value
  }
}
