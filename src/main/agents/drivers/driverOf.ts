/**
 * Which driver a row or a folder's runtime names — pure, no imports beyond
 * shared types, so the scanner and the DTO mapper can use it without pulling
 * the drivers' production wiring in.
 */
import type { AgentRow } from '../../db/agents'
import {
  isAgentDriverId,
  launcherOfConfig,
  type AcpLauncherId,
  type AgentDriverId
} from '../../../shared/agentDrivers'
import { DEFAULT_AGENT_ENGINE, effectiveEngine, type AgentEngine } from '../../../shared/engine'

/** Known driver identity only. Migration owns legacy backfill; reads never guess. */
export function driverOfRow(agent: Pick<AgentRow, 'driver'>): AgentDriverId | null {
  return isAgentDriverId(agent.driver) ? agent.driver : null
}

/**
 * Which engine an ACP agent runs — `driver_config.launcher`.
 *
 * The default rather than a refusal for a row whose config is missing or names
 * an engine this build has not heard of, because the value is a *cache* of what
 * the folder said: the turn re-reads the folder and reconciles anyway, so the
 * only thing a stricter read would buy is a broken agent list while a rescan
 * catches up.
 */
export function launcherOfRow(agent: Pick<AgentRow, 'driverConfig'>): AcpLauncherId {
  return launcherOfConfig(agent.driverConfig ?? null) ?? DEFAULT_AGENT_ENGINE
}

/**
 * The launcher a folder's runtime block names.
 *
 * The same tolerant read `runtimeService` makes (`effectiveEngine`): a runtime
 * that names no engine is the machine default, and one naming an engine this
 * build cannot run on a folder is OpenCode, so a folder written by a newer tool
 * keeps running rather than disappearing from the list.
 *
 * **Never null, and that is the distinction that matters.** "The runtime was
 * read and names nothing" is an answer: the default. "The manifest could not be
 * read at all" is *not* an answer, and only `folderIndexLauncher` can tell —
 * it checks the folder's identity first and returns null there, which is what
 * keeps the row's value. Collapsing the two left a user who cleared the engine
 * in the Runtime card on the engine they had cleared.
 */
export function launcherOfFolder(
  runtime: { engine?: unknown; credential?: unknown; model?: unknown } | null | undefined,
  /**
   * This machine's Default Runtime, for a folder that names no engine.
   *
   * Defaulted rather than required, and the default is the historical one, so
   * the pure callers that have no business reading a setting — tests, and the
   * scanner's row cache before the setting is known — behave exactly as they
   * did. The turn's own dispatch passes the real value.
   */
  defaultEngine: AgentEngine = DEFAULT_AGENT_ENGINE
): AcpLauncherId {
  // Only an engine a folder can actually run on is honoured as named — the
  // three `AgentEngine`s, which `effectiveEngine` returns as declared.
  // `runtime.engine` is a preference, never refused: any other name, including
  // the launcher ids no folder can use (`gemini` has no launcher; `custom` needs
  // a command or endpoint only an external agent's row carries), runs on
  // OpenCode, and only a runtime naming *nothing* reaches the machine default.
  return effectiveEngine(runtime, defaultEngine)
}
