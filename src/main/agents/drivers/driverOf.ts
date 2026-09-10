/**
 * Which driver a row or a folder's runtime names — pure, no imports beyond
 * shared types, so the scanner and the DTO mapper can use it without pulling
 * the drivers' production wiring in.
 */
import type { AgentRow } from '../../db/agents'
import { isAgentDriverId, type AgentDriverId } from '../../../shared/agentDrivers'
import { DEFAULT_AGENT_ENGINE, isAgentEngine } from '../../../shared/engine'
import { ACP_LAUNCHER_IDS, type AcpLauncherId } from './acp/types'

/**
 * The driver a folder agent runs on, from its runtime block (the manifest's,
 * or a bare folder's desktop state).
 *
 * The same tolerant read `runtimeService` makes: a missing or unrecognised
 * engine is the default engine, so a folder written by a newer tool keeps
 * running. The two folder drivers' ids are the engine names until phase 3
 * collapses them into `acp`.
 */
export function driverOfFolder(runtime: { engine?: unknown } | null | undefined): AgentDriverId {
  const raw = typeof runtime?.engine === 'string' ? runtime.engine.trim() : ''
  return isAgentEngine(raw) ? raw : DEFAULT_AGENT_ENGINE
}

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
  return agent.source === 'folder' ? DEFAULT_AGENT_ENGINE : 'a2a'
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
  const raw = agent.driverConfig?.launcher
  return isAcpLauncherId(raw) ? raw : DEFAULT_AGENT_ENGINE
}

/**
 * The launcher a folder's runtime block names, or **null when it could not be
 * read**.
 *
 * Null is the same "keep what the row says" signal `folderIndexDriver` has
 * always carried: a scan changes readiness, never identity, and a manifest is
 * unparseable for a moment every time an assistant saves it. An insert with
 * null takes the default engine; there is no earlier value to keep.
 */
export function launcherOfFolder(
  runtime: { engine?: unknown } | null | undefined
): AcpLauncherId | null {
  const raw = typeof runtime?.engine === 'string' ? runtime.engine.trim() : ''
  if (raw === '') return null
  return isAcpLauncherId(raw) ? raw : null
}

/** Whether a stored value names a launcher this build has. */
export function isAcpLauncherId(value: unknown): value is AcpLauncherId {
  return typeof value === 'string' && (ACP_LAUNCHER_IDS as readonly string[]).includes(value)
}
