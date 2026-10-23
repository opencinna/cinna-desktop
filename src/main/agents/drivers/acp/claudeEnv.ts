/**
 * The environment a spawned `claude` runs in, and the one rule this whole
 * feature rests on.
 *
 * ## Why this is its own module
 *
 * **The desktop is an orchestrator. A turn is paid for by exactly the account
 * the user picked for Claude Agent in Settings → Local Agents — and nothing
 * else.** Two picks exist (`shared/claudeAuthMode.ts`):
 *
 * - **Subscription** (the default): Cinna spawns the `claude` the user
 *   installed, unmodified, in an environment where that binary resolves the
 *   credentials it already has — no login, no stored token, no brokered
 *   session. No key reaches the child.
 * - **API Token**: the one Anthropic AI credential chosen there, decrypted in
 *   main, is added as `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL` when the
 *   credential names one) **after** the strip. Only that credential: whatever
 *   the shell profile exported is still removed first. The CLI is also told to
 *   scrub it from every subprocess it starts, so the agent's own Bash and MCP
 *   servers never see it.
 *
 * Either way the property is one variable away from being false:
 *
 * - let an inherited auth variable in, and the turn silently bills an account
 *   the user did not pick while the panel names another; or
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
 * **Narrow with the helper the app already has, then strip, then add only what
 * this app chose** — the client-app string, the updater switch and, in API
 * mode, the picked credential and the subprocess scrub that keeps it out of
 * the agent's own tools ({@link SUBPROCESS_SCRUB_ENV}).
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

import { shellEnvForChild } from '../../../shell/env'

/**
 * Variables stripped from the child no matter where they came from.
 *
 * Every one of these either **re-authenticates** the turn against an account
 * the user did not pick, or **redirects** it at a third-party provider — when
 * it arrives from the environment. In API mode two of them are put back
 * afterwards, from the credential picked in Settings ({@link ClaudeApiKeyEnv}). None of them can be justified by "the agent's own tools
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
 * They have no business on this path — API mode names its one key as
 * `ANTHROPIC_API_KEY` — and their presence would be a second way to pay for a
 * turn with a credential nobody picked for Claude Agent.
 */
export const ENGINE_KEY_PREFIX = 'CINNA_ENGINE_KEY_'

/**
 * Identifies this app in the CLI's User-Agent. An orchestrator should say who
 * it is; the CLI reads this and nothing else from us about our identity.
 */
export const CLIENT_APP_ENV = 'CLAUDE_AGENT_SDK_CLIENT_APP'

/**
 * Switches off Claude Code's own background updater for the processes Cinna
 * spawns.
 *
 * A session can run on **the user's own install** (an exact-version PATH copy,
 * or a Claude Path from Settings), and that install's updater replaces the
 * binary and retargets `~/.local/bin/claude` from inside whichever process
 * happens to be running. A desktop session must never be the thing that moves
 * the user's `claude` to another version — nor move the version under a pooled
 * adapter to one that never passed the gate. The user's own terminal sessions
 * are untouched and update as they always did.
 */
export const AUTOUPDATER_ENV = 'DISABLE_AUTOUPDATER'

/**
 * Makes the CLI strip its own credentials from every subprocess it starts —
 * API mode only.
 *
 * In API mode the picked key is `ANTHROPIC_API_KEY` in the `claude` process,
 * and a Bash tool call or a stdio MCP server inherits that process's
 * environment: one `env` in a turn prints the key into the transcript, which
 * a shared agent syncs. With this set the CLI removes `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS` and its OAuth tokens from
 * the environment of what it spawns; the CLI itself still authenticates.
 *
 * Side effect, read from the 2.1.296 binary: the CLI forces its *startup*
 * permission mode to `default` while this is set. Cinna sets the mode with
 * `session/set_mode` after every new/load anyway, and the contract
 * (`claude.launch.subprocess-env-scrub*`) checks that `auto` and `default`
 * are still accepted, that `default` still asks over ACP, and that Bash and
 * file writes in the agent's folder still work.
 *
 * Subscription mode leaves it unset: no key is in the child's environment to
 * leak, and the user's own `claude` runs as they installed it.
 */
export const SUBPROCESS_SCRUB_ENV = 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'

/**
 * The credential API mode adds to the child, already decrypted in main. Never
 * logged, never in a spec key (the pool digests the environment), never sent
 * to the renderer.
 */
export interface ClaudeApiKeyEnv {
  apiKey: string
  /** The credential's own endpoint, when it names one; null for Anthropic's. */
  baseUrl: string | null
}

/** The variables API mode puts back after the strip. */
export const CLAUDE_API_KEY_ENV: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']

/**
 * How one Claude launch authenticates, as main resolved it from the setting
 * (`claudeAuthService.resolve`). `fingerprint` is a non-secret digest of mode,
 * credential id and key: the pool retires idle processes started under another
 * one. An `error` refuses the launch — API mode never falls back to the
 * subscription.
 */
export type ClaudeLaunchAuth =
  | { mode: 'subscription'; fingerprint: string }
  | { mode: 'api_key'; fingerprint: string; credential: ClaudeApiKeyEnv }
  | { mode: 'api_key'; fingerprint: string; error: string }

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
  /**
   * API mode's credential, added **after** the strip so it is the only key the
   * child sees. Absent: subscription — no key at all.
   */
  apiKey?: ClaudeApiKeyEnv | null
}

/**
 * Build the environment a `claude` child runs in.
 *
 * Deliberately pure and Electron-free, so the one property that matters —
 * *no key reaches the child but the one picked in Settings* — is asserted by a
 * unit test rather than by reading the runner.
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
  // API mode: the picked credential, after the strip, so nothing inherited
  // survives beside it. An empty key would read as "no key" to the CLI and
  // fall through to the login — refused upstream, never built here.
  if (input.apiKey?.apiKey) {
    out.ANTHROPIC_API_KEY = input.apiKey.apiKey
    if (input.apiKey.baseUrl) out.ANTHROPIC_BASE_URL = input.apiKey.baseUrl
  }
  // Set last, so nothing inherited can switch it back on. Every Cinna-spawned
  // `claude` gets this environment — sessions and the login probe alike.
  out[AUTOUPDATER_ENV] = '1'
  // API mode only, and after everything else for the same reason: the key is
  // in this process's environment, and without the scrub every Bash command
  // and MCP server the agent starts inherits it.
  if (input.apiKey?.apiKey) out[SUBPROCESS_SCRUB_ENV] = '1'
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
 *
 * `expected.apiKey` is API mode: the picked credential's `ANTHROPIC_API_KEY`
 * and `ANTHROPIC_BASE_URL` are then the intended ones and not reported.
 * Everything else on the list still is.
 */
export function auditClaudeEnv(env: Record<string, string>, expected: { apiKey?: boolean } = {}): string[] {
  return Object.keys(env)
    .filter((key) => CLAUDE_STRIPPED_ENV.includes(key) || key.startsWith(ENGINE_KEY_PREFIX))
    .filter((key) => !(expected.apiKey && CLAUDE_API_KEY_ENV.includes(key)))
    .sort()
}
