/**
 * The wire contract for the **local engine** — the desktop-managed
 * `opencode serve` process that runs folder agents.
 *
 * Shared between main and renderer, so everything here is type-only or a plain
 * constant. The rule that shapes it is Invariant 4: **nothing key-shaped may be
 * in any of these types.** The engine is handed its credentials as environment
 * variables in the main process; what crosses to the renderer is which
 * credential a runtime *refers to* and whether the engine is up.
 *
 * The engine's own base URL and the per-run Basic-auth password stay in main
 * too. They are not secrets in the same sense — the port is loopback and the
 * password is regenerated on every start — but the renderer has no use for
 * either, and a base URL on the wire is an invitation for a component to fetch
 * the engine directly and route around the runner.
 */

import type { ModelOrigin } from './runtimeDefaults'
import type { EngineSkipCode } from './runtimeMessages'
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
export type EngineStatus =
  /** Never started, or stopped cleanly. */
  | 'stopped'
  /** Resolving or downloading the binary. Can take a minute on first use. */
  | 'installing'
  /** Process spawned, health check not yet green. */
  | 'starting'
  /** Health check green. Turns can run. */
  | 'running'
  /** The last start failed, or the process died. {@link EngineState.error} says how. */
  | 'failed'

/**
 * The engine as the readiness strip and the Runtime card see it.
 *
 * No `baseUrl`, no password, no `pid`-adjacent handle a renderer could act on
 * — deliberately. `pid` itself is here because "the engine is running as
 * process 4711" is a diagnosis a user can act on and a number that grants
 * nothing.
 */
export interface EngineState {
  status: EngineStatus
  /** `opencode --version`, once a binary has been resolved. */
  version: string | null
  binarySource: EngineBinarySource | null
  /** Absolute path of the resolved binary — shown in Settings, never fetched. */
  binaryPath: string | null
  pid: number | null
  /** One sentence explaining a `failed` status. Never carries a secret. */
  error: string | null
  /** When the state last changed (epoch ms). */
  changedAt: number
}

/**
 * What the last config generation refused to include, and why.
 *
 * A folder agent can be perfectly valid on disk and still be absent from the
 * engine — its credential is one the engine cannot use, or its runtime names no
 * model. Without this the only symptom is an agent that does nothing when
 * chatted with, which is indistinguishable from a bug in this app.
 *
 * Empty until a config has been generated, which is to say until the engine has
 * been started at least once.
 *
 * A **code**, not a phrase. It used to travel as the second half of a sentence
 * the agent page completed, which meant `configGenerator` — a module about
 * OpenCode's config shape — silently owned a line of user-facing copy on a
 * screen at its narrowest supported width, with no test asserting the result.
 * `describeEngineSkip` in `shared/runtimeMessages` now owns the words.
 */
export interface EngineSkips {
  agents: { agentId: string; code: EngineSkipCode }[]
}

/** Main → renderer push whenever {@link EngineState} changes. */
export const ENGINE_STATE_CHANNEL = 'engine:state'

/** The pinned engine version this build downloads when it must manage one. */
export const PINNED_ENGINE_VERSION = '1.18.27'

/**
 * What actually runs an agent's turn.
 *
 * - `opencode` — the desktop-managed `opencode serve` process. The default, and
 *   the only engine that existed before this axis; every agent that names no
 *   engine is one.
 * - `claude` — the Claude Agent SDK, in-process, spawning the `claude` binary
 *   the user installed under that install's own login. The desktop holds no
 *   credential on this path and no API key is involved.
 *
 * Deliberately two-valued. Nothing here is built to accommodate a third engine
 * and it should not be until there is one — the abstraction that fits two is
 * not reliably the one that fits three.
 */
export type AgentEngine = 'opencode' | 'claude'

/** The engine an agent that names none runs on. */
export const DEFAULT_AGENT_ENGINE: AgentEngine = 'opencode'

/** Whether a value off a manifest is an engine this build knows. */
export function isAgentEngine(value: unknown): value is AgentEngine {
  return value === 'opencode' || value === 'claude'
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
   * The engine this agent's turns run on. Always `opencode` unless the manifest
   * says otherwise, so an agent written before the axis existed is unchanged.
   */
  engine: AgentEngine
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
