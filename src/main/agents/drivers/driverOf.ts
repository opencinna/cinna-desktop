/**
 * Which driver a row or a folder's runtime names — pure, no imports beyond
 * shared types, so the scanner and the DTO mapper can use it without pulling
 * the drivers' production wiring in.
 */
import type { AgentRow } from '../../db/agents'
import {
  FOLDER_AGENT_DRIVER,
  isAcpLauncherId,
  isAgentDriverId,
  launcherOfConfig,
  type AcpLauncherId,
  type AgentDriverId
} from '../../../shared/agentDrivers'
import { DEFAULT_AGENT_ENGINE } from '../../../shared/engine'

/**
 * The driver a row names, falling back by ownership for a row whose `driver`
 * is not set or not one this build has.
 *
 * The migration backfills every row and every insert writes one, so the
 * fallback is for a database touched by a newer build (an unknown id) — never
 * a reason to leave the column empty.
 */
export function driverOfRow(agent: Pick<AgentRow, 'driver' | 'source'>): AgentDriverId {
  if (isAgentDriverId(agent.driver)) return agent.driver
  return agent.source === 'folder' ? FOLDER_AGENT_DRIVER : 'a2a'
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
 * The same tolerant read `runtimeService` makes: a runtime that names no engine
 * — or one this build has no name for — is the default engine, so a folder
 * written by a newer tool keeps running rather than disappearing from the list.
 *
 * **Never null, and that is the distinction that matters.** "The runtime was
 * read and names nothing" is an answer: the default. "The manifest could not be
 * read at all" is *not* an answer, and only `folderIndexLauncher` can tell —
 * it checks the folder's identity first and returns null there, which is what
 * keeps the row's value. Collapsing the two left a user who cleared the engine
 * in the Runtime card on the engine they had cleared.
 */
export function launcherOfFolder(
  runtime: { engine?: unknown } | null | undefined
): AcpLauncherId {
  const raw = typeof runtime?.engine === 'string' ? runtime.engine.trim() : ''
  return isAcpLauncherId(raw) ? raw : DEFAULT_AGENT_ENGINE
}
