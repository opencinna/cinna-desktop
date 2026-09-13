/**
 * The wire contract for the **local engine** — the `opencode` binary folder
 * agents run on, and which engine each agent runs.
 *
 * Shared between main and renderer, so everything here is type-only or a plain
 * constant. The rule that shapes it is Invariant 4: **nothing key-shaped may be
 * in any of these types.** An engine is handed its credentials as environment
 * variables in the main process; what crosses to the renderer is which
 * credential a runtime *refers to*.
 *
 * Phase 3 of the agent runtime plan took the shared `opencode serve` away: an
 * agent's turn spawns its own child and speaks the Agent Client Protocol to it
 * over stdio. So there is no base URL, no loopback password and no server
 * state here any more — only {@link EngineBinaryState}, which is about a file on
 * disk rather than a process.
 */

import type { ModelOrigin } from './runtimeDefaults'
import type { WorkComplexity } from './modelFamilies'

/**
 * Where the running `opencode` binary came from.
 *
 * - `configured` — an explicit path in Settings. Whatever the user points at is
 *   what runs; no version pin applies.
 * - `path` — a user-installed `opencode` found on the login-shell PATH. The
 *   preferred source: a developer who already has one keeps their own install,
 *   their own auth and their own updates.
 * - `managed` — the pinned version this app downloaded into its data directory,
 *   verified against a recorded SHA-256.
 */
export type EngineBinarySource = 'configured' | 'path' | 'managed'

/** What the engine is doing right now. */
/**
 * Whether this machine has a usable `opencode`, and where it came from.
 *
 * All that is left of "the engine" as state the UI shows. Before phase 3 of the
 * agent runtime plan this was an `EngineState` about a **server** — stopped,
 * installing, starting, running, failed, with a pid — because one
 * `opencode serve` sat behind every folder agent. The ACP driver starts a child
 * per agent and reaps it when it goes idle, so there is nothing for a user to
 * start and nothing whose being up or down they can act on.
 *
 * What survives is the question that outlives every turn: is there a binary,
 * where is it from, and if there is not, why. `resolving` is worth a state of
 * its own because the answer can involve downloading and verifying 46 MB, and
 * `failed` because a path the user typed in Settings is a thing only they can
 * fix.
 *
 * No `baseUrl`, no password, no pid — deliberately, as before: nothing here is
 * a handle a renderer could act on.
 */
export type EngineBinaryState =
  /** Nobody has looked yet. The first turn, or Settings' *Check again*, looks. */
  | { state: 'unresolved' }
  /** Looking now — which may be a download, once, of about a minute. */
  | { state: 'resolving' }
  | {
      state: 'ready'
      /** Absolute path — shown in Settings, never fetched. */
      path: string
      source: EngineBinarySource
      /** `opencode --version`, or null when the probe failed but the file runs. */
      version: string | null
    }
  /** One sentence explaining it. Never carries a secret. */
  | { state: 'failed'; error: string }

/** Main → renderer push whenever {@link EngineBinaryState} changes. */
export const ENGINE_BINARY_CHANNEL = 'engine:binary-state'

/** The pinned engine version this build downloads when it must manage one. */
export const PINNED_ENGINE_VERSION = '1.18.27'

/**
 * What actually runs an agent's turn.
 *
 * - `opencode` — the desktop-managed `opencode serve` process. The default, and
 *   the only engine that existed before this axis; every agent that names no
 *   engine is one.
 * - `claude` and `codex` — ACP adapters driving the user's installed CLI and
 *   its own login. Neither uses a credential configured in this desktop.
 */
export type AgentEngine = 'opencode' | 'claude' | 'codex'

/** The engine an agent that names none runs on. */
export const DEFAULT_AGENT_ENGINE: AgentEngine = 'opencode'

/** Whether a value off a manifest is an engine this build knows. */
export function isAgentEngine(value: unknown): value is AgentEngine {
  return value === 'opencode' || value === 'claude' || value === 'codex'
}

/**
 * **This machine's Default runtime**, out of the setting and what is installed.
 *
 * The setting is written **once**, on the first launch that can answer it
 * (`defaultEngineService.lockIfUnset`), and the empty value means only "not
 * decided yet". So this function has two callers with two different jobs: the
 * lock, which passes `''` to ask *what should this machine get*, and every
 * ordinary read, which passes the stored value and gets it back.
 *
 * `claudeAvailable` is passed in rather than looked up, because the two sides
 * learn it differently — the main process from `toolDetectionService`, the
 * renderer from the main process — and this function must give the same answer
 * on both. It is the same rule every other resolution in this area follows: one
 * function, called twice, so a panel cannot predict a runtime the engine will
 * not build.
 *
 * **The fallback is the OpenCode runner**, never "nothing": that runner is the
 * one this app installs for itself, so it is the only choice that is true on a
 * machine with no developer tooling at all. What it spends is the credential
 * named beside the picker.
 */
export function resolveDefaultEngine(setting: string, claudeAvailable: boolean, codexAvailable = false): AgentEngine {
  const pinned = setting.trim()
  if (isAgentEngine(pinned)) return pinned
  return claudeAvailable ? 'claude' : codexAvailable ? 'codex' : DEFAULT_AGENT_ENGINE
}

export function effectiveEngine(
  runtime: { engine?: unknown; credential?: unknown; model?: unknown } | null | undefined,
  defaultEngine: AgentEngine
): AgentEngine {
  const declared = typeof runtime?.engine === 'string' ? runtime.engine.trim() : ''
  if (isAgentEngine(declared)) return declared
  const credential = typeof runtime?.credential === 'string' ? runtime.credential.trim() : ''
  const model = typeof runtime?.model === 'string' ? runtime.model.trim() : ''
  if (credential !== '' || model !== '') return DEFAULT_AGENT_ENGINE
  return defaultEngine
}

/**
 * What the renderer is told about the Default Runtime.
 *
 * Resolved in the **main process** and sent whole, rather than derived on each
 * side from the setting plus the detected tools. The renderer has both of those
 * facts and could do the sum — and that is exactly the arrangement that put a
 * label and an engine out of step in this area twice before. It also lands as
 * one value: a panel that derived it would render `AI credentials` for the
 * fraction of a second detection is in flight and then swap the picker under
 * the pointer (ux_rules rule 1), where one `undefined` is simply *not known
 * yet*.
 */
export interface DefaultEngineDto {
  /**
   * What an agent that names no engine of its own runs on.
   *
   * One field, deliberately. The picker in Settings needs a second fact —
   * whether each runtime is *installed* — and reads it from the detected-tools
   * list it already has, which is the same list this was derived from. A second
   * copy here would be one more thing for the two to disagree about, and this
   * type exists precisely so that "which engine" has exactly one answer.
   */
  engine: AgentEngine
}

/**
 * Who answers a Claude agent's permission asks before the desktop does.
 *
 * - `auto` — the CLI's own classifier, the same one a terminal `claude` runs
 *   in auto mode. It approves what it judges routine for what the user asked
 *   and the desktop is consulted only for what it will not approve. Watched
 *   against the binary (`claude_contract.md` §10): over seven probes, including
 *   a force push and a global git config rewrite, it approved everything and
 *   the desktop's callback never fired — so on this setting the permission
 *   block is a backstop, not a gate.
 * - `ask` — the SDK's `default` mode: every command, edit, write and fetch
 *   reaches the desktop, and a standing grant or the permission block answers
 *   it. Read-only tools never ask on either setting.
 *
 * Not the SDK's `PermissionMode`, on purpose. That type has six members and
 * two of them — `bypassPermissions` and `dontAsk` — would remove the desktop
 * from the decision entirely; this pair is the whole choice the desktop
 * offers, and the runner maps it onto the SDK's vocabulary in one place.
 */
export type ClaudeApproval = 'auto' | 'ask'

/**
 * What a Claude agent that has not been told otherwise runs on.
 *
 * `auto`, because the alternative asked for every command the agent ran —
 * including the `ls` and `git status` a terminal `claude` runs without a
 * word — and a user who had never seen those prompts in the terminal read
 * the desktop as broken.
 */
export const DEFAULT_CLAUDE_APPROVAL: ClaudeApproval = 'auto'

/** Whether a value off disk or the wire is an approval setting this build knows. */
export function isClaudeApproval(value: unknown): value is ClaudeApproval {
  return value === 'auto' || value === 'ask'
}

/**
 * Work Complexity → the model alias the Claude engine asks for.
 *
 * A small table, deliberately **not** `modelFamilies.ts`. That module classifies
 * a live catalogue against a credential's `listModels()`, and on this path there
 * is no credential and no catalogue: a plan serves what the plan serves,
 * addressed by alias. Resolving a tier through a classifier with nothing to
 * classify would produce `null` for every agent.
 *
 * The Medium floor still applies in spirit — an agent that names no tier runs on
 * `sonnet`.
 */
const CLAUDE_TIER_ALIAS: Record<WorkComplexity, string> = {
  simple: 'haiku',
  medium: 'sonnet',
  complex: 'opus'
}

/** The alias the Claude engine runs a tier on; `sonnet` when none is named. */
export function claudeModelForComplexity(complexity: WorkComplexity | null): string {
  return complexity ? CLAUDE_TIER_ALIAS[complexity] : CLAUDE_TIER_ALIAS.medium
}

/** Login readiness from the user's Codex CLI; no credentials cross IPC. */
export interface CodexAuthStatus {
  state: 'logged_in' | 'logged_out' | 'unknown'
}

/** Codex keeps its configured model; complexity controls reasoning effort. */
export function codexEffortForComplexity(complexity: WorkComplexity | null): string {
  return complexity === 'simple' ? 'low' : complexity === 'complex' ? 'high' : 'medium'
}

/**
 * Whether the user's own `claude` install is logged in.
 *
 * `unknown` is a first-class answer, not a synonym for "no". The panel already
 * makes the same distinction for detection — "we have not asked yet" and "the
 * answer is no" are different states, and collapsing them is what put a red
 * alarm on every healthy first visit.
 */
export type ClaudeAuthState = 'logged_in' | 'logged_out' | 'unknown'

/**
 * What `claude auth status` says, reduced to what a caller may see.
 *
 * **The account's organisation id and organisation name are in that response and
 * are not in this type.** They are never lifted out of the CLI's JSON at all, so
 * they cannot reach a log line, this process boundary, or a screenshot — a field
 * that is never read cannot leak from a debug line somebody adds later, which is
 * a stronger defence than a rule about logging.
 *
 * The **email** and the plan do cross, because they are the answer to the
 * question the "Runs with" panel exists to ask: *which account pays for this?*
 * A tier alone says a subscription is paying and not which one, and a machine
 * with more than one Claude login is exactly where that matters. It is the
 * user's own account shown to the user on their own machine — no credential
 * crosses, and Invariant 4 is about keys.
 *
 * It stays out of the logs regardless. `claudeAuth.ts` logs states, methods and
 * durations, never the account.
 */
export interface ClaudeAuthStatus {
  state: ClaudeAuthState
  /**
   * How that install authenticates, as the CLI words it — `claude.ai` for a
   * subscription login, `none` when logged out. Passed through, never mapped:
   * this app does not own the value set.
   */
  authMethod: string | null
  /**
   * The plan, when the CLI reports one (`max`, `pro`, …). Null otherwise, and
   * **never inferred** — a subscription this app asserts because it stripped an
   * environment variable is a claim about an environment it does not fully
   * control.
   */
  subscriptionType: string | null
  /**
   * The account that will pay, as the CLI reports it. Null when it names none —
   * a logged-out install has no `email` field at all, and one authenticated some
   * other way may not either.
   */
  email: string | null
}

/** Which of the two resolution steps produced a runtime. */
export type RuntimeSource =
  /** The manifest's own `runtime` block. */
  | 'manifest'
  /** The Default runtime, derived from the user's default chat mode. */
  | 'default'
  /** Neither — there is nothing to run on. {@link ResolvedRuntime.reason} says so. */
  | 'none'

/**
 * A resolved runtime: which engine, which credential, which model.
 *
 * The manifest stores a credential **reference** (`credentialRef`) and a model
 * id; `credentialId` is that reference resolved against the credentials this
 * machine actually has, and is null when it resolves to nothing.
 *
 * `engine` is a field here and **not** a synthetic credential row, which is the
 * tempting alternative — one list, one uniform consumer. It is rejected because
 * `isCredentialUsable`, `findCredentialByReference`, `collectEngineProviders`
 * and every skip reason are written about a row with a key, an `enabled` flag
 * and a catalogue behind it. A synthetic row satisfies none of those and would
 * lie to each differently — worst at "the user switched this credential off",
 * which has no meaning for an engine that bills nobody's key.
 *
 * `engine` and {@link RuntimeSource} answer different questions: *which* engine,
 * and *where the choice came from*.
 */
export interface ResolvedRuntime {
  source: RuntimeSource
  /**
   * The launcher resolved from this folder's authoring configuration. Always `opencode` unless the manifest
   * says otherwise, so an agent written before the axis existed is unchanged.
   */
  launcher: AgentEngine
  /** Verbatim from the manifest, when it declares one. Never a key. */
  credentialRef: string | null
  /** The provider row the reference resolved to. */
  credentialId: string | null
  credentialName: string | null
  credentialType: string | null
  modelId: string | null
  /**
   * How {@link modelId} was arrived at — a manifest model, a Work Complexity
   * tier resolved against the credential's catalogue, the Default runtime, or the
   * Medium floor. Separate from {@link reason} on purpose: a substitution is not
   * a failure, and folding it into the failure sentence would make every caller
   * that tests `reason !== null` treat a working agent as a broken one.
   */
  modelSource: ModelOrigin
  /**
   * For `modelSource === 'substituted'`: the model the manifest still names,
   * which the credential no longer lists. The manifest is never rewritten from
   * this — the substitution is reported, so the file keeps saying what the user
   * wrote.
   */
  replacedModelId: string | null
  /** One sentence when this runtime cannot run. Null when it can. */
  reason: string | null
}

/**
 * What the user picked in the Runtime card, on its way to the manifest.
 *
 * Both nullable: clearing them removes the `runtime` block and the agent falls
 * back to the Default runtime. Neither may ever hold a key — `runtimeService`
 * rejects a value that looks like one rather than trusting the caller, because
 * this is a renderer-supplied string that lands in a file the user may commit.
 */
export interface LocalAgentRuntimeInput {
  /**
   * Which engine to run on. `null` clears it, exactly as the other three fields
   * behave — clearing every field removes the `runtime` block.
   *
   * **Required, not optional, and that is the whole point.** `applyToManifest`
   * deletes this key before rewriting it, so a caller that simply omits it
   * *erases the user's engine choice* from a file they commit. While `engine`
   * was merely an unknown key the manifest layer preserved it verbatim; making
   * it known removed that protection for exactly the field being added. An
   * optional field here is both silent and destructive when absent, so the
   * compiler is made to ask every caller instead.
   *
   * `claude` and {@link credential} are refused together — see
   * `runtimeService.validate`. They are not mutually meaningful: there is no
   * credential on the Claude path, and a manifest carrying one would make the
   * Runs-with panel name a key that pays for nothing.
   */
  engine: AgentEngine | null
  /** A credential **name** — what the manifest carries, so it travels. */
  credential: string | null
  /** A concrete model id — the Advanced picker's answer. */
  modelId: string | null
  /**
   * A Work Complexity tier — the plain picker's answer, and the portable one.
   * Mutually exclusive with {@link modelId}: `runtimeService` refuses both at
   * once rather than inventing a precedence nobody would remember.
   */
  complexity: WorkComplexity | null
}
