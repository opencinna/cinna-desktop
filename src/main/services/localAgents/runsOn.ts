/**
 * **What a folder agent runs on — the one resolver.**
 *
 * Two sources can say which engine and credential a kit agent starts on: the
 * manifest's `runtime` block (a file that travels, and that an assistant
 * edits) and the Runs-on choice the user made in this app, stored in the
 * agent's desktop state (`runsOn`, see `RunsOnChoice` in `shared/engine.ts`).
 * The app wins: precedence is **stored choice → file → machine default**.
 *
 * Pure on purpose. Everything that reads the world — this machine's Default
 * runtime, the credential list behind `runtimeService.resolve` — arrives as
 * {@link RunsOnDeps}, so the precedence and the conflict rule are tested here
 * without a database, and `runtimeService.resolveRunsOn` is the one place that
 * supplies the real inputs. The renderer never re-derives any of it: it reads
 * `LocalAgentDto.resolvedRuntime`.
 *
 * ### Outcomes, not keys
 *
 * Two runtimes are the same when they start the same engine and, on OpenCode,
 * spend the same credential. A stored "Claude Agent" over a file that names no
 * engine on a Claude-default machine is no conflict at all; a stored
 * "Default runtime" over `engine: "opencode"` on that machine is one.
 */

import type { AgentRuntimeRef } from '../../../shared/kit/manifest'
import { effectiveEngine, isEngineLoginId, type AgentEngine, type RunsOnChoice } from '../../../shared/engine'
import type {
  LocalAgentResolvedRuntime,
  LocalAgentRuntimeConflict,
  LocalAgentRuntimeSide
} from '../../../shared/localAgents'

/** What `runtimeService.resolve` answers about one block — the three facts this module needs. */
export interface RunsOnResolution {
  credentialId: string | null
  credentialName: string | null
  modelId: string | null
}

export interface RunsOnDeps {
  /** This machine's Default runtime, the same value `runtimeService.resolve` reads. */
  defaultEngine: AgentEngine
  /**
   * `runtimeService.resolve` for one block. Called only where a credential or
   * a model is needed (an OpenCode outcome, a conflict), so an agent on a
   * CLI engine with nothing to compare costs no credential lookup.
   */
  resolve: (runtime: AgentRuntimeRef | null) => RunsOnResolution
}

export interface RunsOnResult {
  /** The runtime block a turn launches with (`LocalAgentDto.runtime`). */
  effective: AgentRuntimeRef | null
  resolved: LocalAgentResolvedRuntime
}

/** The Runs-on axis of a runtime block: the keys a choice replaces. */
const RUNS_ON_KEYS = ['engine', 'credential', 'model'] as const

function named(runtime: AgentRuntimeRef | null | undefined, key: (typeof RUNS_ON_KEYS)[number]): boolean {
  const value = runtime?.[key]
  return typeof value === 'string' && value.trim() !== ''
}

/** Whether a block settles the engine itself (any engine string, a credential or a model). */
function namesRunsOn(runtime: AgentRuntimeRef | null | undefined): boolean {
  return RUNS_ON_KEYS.some((key) => named(runtime, key))
}

/** OpenCode is the one engine that spends a credential of this app's. */
function spendsCredential(engine: AgentEngine): boolean {
  return !isEngineLoginId(engine)
}

/**
 * A stored choice in the file's form: the block a turn runs with when the
 * choice and the file disagree, and **exactly what "Update file" writes**.
 *
 * The file's `complexity`, `effort` and every key this build does not know
 * (`permissions`, a newer contract's) survive; its `engine`, `credential` and
 * `model` go — the model belonged to the engine or credential being replaced,
 * and a bare model would itself pull the agent onto OpenCode. Null when
 * nothing is left, so "no runtime" reads the same as an absent block.
 */
export function runtimeForChoice(file: AgentRuntimeRef | null | undefined, choice: RunsOnChoice): AgentRuntimeRef | null {
  const base: AgentRuntimeRef = file && typeof file === 'object' ? { ...file } : {}
  for (const key of RUNS_ON_KEYS) delete base[key]
  const next: AgentRuntimeRef =
    choice.kind === 'engine' ? { ...base, engine: choice.engine }
      : choice.kind === 'credential' ? { ...base, credential: choice.name }
        : base
  return Object.keys(next).length === 0 ? null : next
}

/** Lazily-resolved facts about one block, so each block is resolved at most once. */
function memoized(deps: RunsOnDeps): (runtime: AgentRuntimeRef | null) => RunsOnResolution {
  const cache = new Map<AgentRuntimeRef | null, RunsOnResolution>()
  return (runtime) => {
    let hit = cache.get(runtime)
    if (!hit) {
      hit = deps.resolve(runtime)
      cache.set(runtime, hit)
    }
    return hit
  }
}

interface Outcome {
  engine: AgentEngine
  credentialId: string | null
}

/**
 * Resolve a **kit** agent: its file's `runtime` block and the stored choice.
 *
 * - No choice: the file verbatim, as before. `unrecorded` conflict when the
 *   file resolves to an engine other than the machine default (any shape:
 *   an engine pin, a bare credential or model, an engine this build cannot run).
 * - A choice whose outcome equals the file's: the file verbatim, no conflict.
 * - Otherwise: {@link runtimeForChoice}, and a `choice` conflict.
 */
export function resolveRunsOn(
  file: AgentRuntimeRef | null | undefined,
  choice: RunsOnChoice | null,
  deps: RunsOnDeps
): RunsOnResult {
  const fileBlock = file && typeof file === 'object' ? file : null
  const resolve = memoized(deps)
  const outcomeOf = (runtime: AgentRuntimeRef | null): Outcome => {
    const engine = effectiveEngine(runtime, deps.defaultEngine)
    return { engine, credentialId: spendsCredential(engine) ? resolve(runtime).credentialId : null }
  }
  const sideOf = (runtime: AgentRuntimeRef | null, engine: AgentEngine): LocalAgentRuntimeSide => {
    const facts = resolve(runtime)
    return { engine, credentialName: spendsCredential(engine) ? facts.credentialName : null, modelId: facts.modelId }
  }

  if (choice === null) {
    const outcome = outcomeOf(fileBlock)
    const conflict: LocalAgentRuntimeConflict | null =
      outcome.engine === deps.defaultEngine
        ? null
        : (() => {
            const app = runtimeForChoice(fileBlock, { kind: 'default' })
            return { kind: 'unrecorded', file: sideOf(fileBlock, outcome.engine), app: sideOf(app, effectiveEngine(app, deps.defaultEngine)) }
          })()
    return {
      effective: fileBlock,
      resolved: {
        engine: outcome.engine,
        credentialId: outcome.credentialId,
        source: namesRunsOn(fileBlock) ? 'file' : 'default',
        choice: null,
        conflict
      }
    }
  }

  const fileOutcome = outcomeOf(fileBlock)
  const chosen = runtimeForChoice(fileBlock, choice)
  const chosenOutcome = outcomeOf(chosen)
  const same = fileOutcome.engine === chosenOutcome.engine && fileOutcome.credentialId === chosenOutcome.credentialId
  if (same) {
    return {
      effective: fileBlock,
      resolved: { engine: fileOutcome.engine, credentialId: fileOutcome.credentialId, source: 'choice', choice, conflict: null }
    }
  }
  return {
    effective: chosen,
    resolved: {
      engine: chosenOutcome.engine,
      credentialId: chosenOutcome.credentialId,
      source: 'choice',
      choice,
      conflict: { kind: 'choice', file: sideOf(fileBlock, fileOutcome.engine), app: sideOf(chosen, chosenOutcome.engine) }
    }
  }
}

/**
 * A **bare** agent: no manifest, so no conflict — its runtime already is the
 * app's own, from its desktop state. `choice` if that runtime names an engine,
 * a credential or a model, else `default`.
 */
export function resolveBareRunsOn(runtime: AgentRuntimeRef | null | undefined, deps: RunsOnDeps): RunsOnResult {
  const block = runtime && typeof runtime === 'object' ? runtime : null
  const engine = effectiveEngine(block, deps.defaultEngine)
  return {
    effective: block,
    resolved: {
      engine,
      credentialId: spendsCredential(engine) ? deps.resolve(block).credentialId : null,
      source: namesRunsOn(block) ? 'choice' : 'default',
      choice: null,
      conflict: null
    }
  }
}

/** A vault agent runs on its vault engine; nothing on this computer decides it. */
export function resolveVaultRunsOn(engine: AgentEngine): LocalAgentResolvedRuntime {
  return { engine, credentialId: null, source: 'choice', choice: null, conflict: null }
}

/**
 * A short label for the per-turn log line: `choice(default)`,
 * `choice(engine:codex)`, `choice(credential:<name>)`, `file`, `default` —
 * with `,conflict` / `,unrecorded` when the file disagrees.
 */
export function runsOnSourceLabel(resolved: LocalAgentResolvedRuntime): string {
  if (resolved.source !== 'choice' || resolved.choice === null) {
    return `${resolved.source}${resolved.conflict ? ',unrecorded' : ''}`
  }
  const choice = resolved.choice
  const detail = choice.kind === 'engine' ? `engine:${choice.engine}` : choice.kind === 'credential' ? `credential:${choice.name}` : 'default'
  return `choice(${detail})${resolved.conflict ? ',conflict' : ''}`
}
