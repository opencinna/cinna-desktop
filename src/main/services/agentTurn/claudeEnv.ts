/**
 * The environment a spawned `claude` runs in, and the one rule this whole
 * feature rests on.
 *
 * ## Why this is its own module
 *
 * **The desktop is an orchestrator. It never becomes an authentication
 * provider.** Cinna spawns the `claude` the user installed, unmodified, in an
 * environment where that binary resolves the credentials it already has — no
 * login, no stored token, no brokered session. That is the whole basis on which
 * the feature is permitted, and it is one variable away from being false in
 * either direction:
 *
 * - put an auth variable in, and the turn silently bills the user's **API
 *   account** while the panel says it ran on their Claude plan; or
 * - leave the wrong variable out, and the CLI reports *"Not logged in"* on a
 *   machine that is perfectly logged in.
 *
 * Both were live hazards. The second is the one that actually bit, and it is
 * the reason this is a tested module rather than an object literal inside the
 * runner.
 *
 * ## `Options.env` replaces; it never merges
 *
 * Verbatim from `sdk.d.ts` at 0.3.266: *"When set, this value REPLACES the
 * subprocess environment entirely — it is not merged with `process.env`."* So
 * every variable reaching the child is one this app chose to put there, and
 * "we did not interfere with the CLI's own auth" is a property that has to be
 * actively maintained rather than one that holds by default.
 *
 * Neither SDK default is correct for us. Inheriting `process.env` is the
 * dangerous one, and it is dangerous in a way that reports success: `ANTHROPIC_API_KEY`
 * lives in exactly the `.zshrc` this app deliberately sources (see
 * `shell_environment.md`), so the obvious implementation authenticates against
 * the wrong account with no error and no failed turn — just a bill at the end
 * of the month.
 *
 * ## The construction rule
 *
 * **Narrow with the helper the app already has, then strip, then add one.**
 *
 * Starting from {@link shellEnvForChild} is not a convenience — it is what
 * makes the `USER` requirement below hold automatically instead of depending on
 * somebody remembering it. `CHILD_ENV_ALLOWLIST` begins with the MCP SDK's
 * `DEFAULT_INHERITED_ENV_VARS`, which is `HOME`, `LOGNAME`, `PATH`, `SHELL`,
 * `TERM`, `USER`. A hand-assembled dictionary is what the plan specified, and
 * a hand-assembled dictionary is what left `USER` out.
 *
 * `HOME` is the one deliberate widening of the narrowing rule, and it is safe
 * for a reason worth stating plainly: the alternative is not "narrower", it is
 * "authenticates as nobody".
 */

import { shellEnvForChild } from '../../shell/env'

/**
 * Variables stripped from the child no matter where they came from.
 *
 * Every one of these either **re-authenticates** the turn against an account
 * the user did not pick in the Runs-with panel, or **redirects** it at a
 * third-party provider. None of them can be justified by "the agent's own tools
 * might need it", which is the argument that gets everything else in.
 *
 * Most are not in `CHILD_ENV_ALLOWLIST` and so never survive the narrowing
 * anyway. They are named here regardless, because this list is the *statement
 * of intent* — a future widening of the allowlist must not quietly grant one of
 * these — and because a test asserting their absence is only meaningful against
 * an explicit list.
 */
export const CLAUDE_STRIPPED_ENV: readonly string[] = [
  // The trap. Distinct from an OAuth login in the CLI's own `ApiKeySource`, and
  // present in the shell profile of exactly the users most likely to try this.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // Each routes the turn to a provider the user did not choose here.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS'
]

/**
 * Prefix of the local engine's per-credential key variables.
 *
 * `configGenerator` hands OpenCode its credentials as `CINNA_ENGINE_KEY_*`.
 * They have no business on this path — there is no credential here — and their
 * presence would be a second way to pay for a turn the user was told is on
 * their subscription.
 */
export const ENGINE_KEY_PREFIX = 'CINNA_ENGINE_KEY_'

/**
 * Identifies this app in the CLI's User-Agent. An orchestrator should say who
 * it is; the CLI reads this and nothing else from us about our identity.
 */
export const CLIENT_APP_ENV = 'CLAUDE_AGENT_SDK_CLIENT_APP'

export interface ClaudeEnvInput {
  /** The login-shell environment, as `resolveShellEnv` produced it. */
  shellEnv: NodeJS.ProcessEnv
  /** This app's version, for the client-app string. */
  appVersion: string
  /** Injected for testability; the second source inside `shellEnvForChild`. */
  processEnv?: NodeJS.ProcessEnv
  /**
   * The narrowing allowlist. Production always takes `CHILD_ENV_ALLOWLIST`.
   *
   * Injectable for one specific reason, and it is not general testability.
   * Today `CHILD_ENV_ALLOWLIST` happens not to contain `ANTHROPIC_API_KEY` or
   * any `CINNA_ENGINE_KEY_*`, so the narrowing alone removes them and the
   * explicit strip below is **untestable through the front door** — a mutation
   * deleting the strip passes every test written against the real allowlist.
   *
   * That is exactly the state in which a later widening of the allowlist
   * silently restores the billing trap with no test failing. Injecting a
   * deliberately over-wide allowlist is what makes the strip's own behaviour
   * assertable, independently of a list this module does not own.
   */
  allowlist?: readonly string[]
}

/**
 * Build the environment a `claude` child runs in.
 *
 * Deliberately pure and Electron-free, so the one property that matters —
 * *nothing key-shaped reaches the child* — is asserted by a unit test rather
 * than by reading the runner.
 */
export function buildClaudeEnv(input: ClaudeEnvInput): Record<string, string> {
  const narrowed = shellEnvForChild(input.shellEnv, input.allowlist, input.processEnv)

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(narrowed)) {
    if (CLAUDE_STRIPPED_ENV.includes(key)) continue
    if (key.startsWith(ENGINE_KEY_PREFIX)) continue
    out[key] = value
  }

  // Not `CLAUDE_CODE_ENTRYPOINT`: the SDK sets that itself (`sdk-ts`) and
  // overwriting it would misreport how the CLI was invoked.
  out[CLIENT_APP_ENV] = `cinna-desktop/${input.appVersion}`
  return out
}

/**
 * Whether a built environment still carries anything that could pay for, or
 * redirect, a turn.
 *
 * Exported so the runner can log a loud warning rather than merely trusting
 * that {@link buildClaudeEnv} was the thing that ran. The environment is the
 * one input here whose corruption is invisible in the result — a turn on the
 * wrong account looks exactly like a turn on the right one — so it is worth
 * checking the value actually being handed over, not the function that
 * produced it.
 *
 * **Names only, never values.** The whole diagnostic value is in the name, and
 * logging the value of `ANTHROPIC_API_KEY` to explain that it leaked would
 * recreate the leak in the log buffer.
 */
export function auditClaudeEnv(env: Record<string, string>): string[] {
  return Object.keys(env)
    .filter((key) => CLAUDE_STRIPPED_ENV.includes(key) || key.startsWith(ENGINE_KEY_PREFIX))
    .sort()
}
