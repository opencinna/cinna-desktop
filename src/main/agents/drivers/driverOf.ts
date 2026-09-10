/**
 * Which driver a row or a folder's runtime names — pure, no imports beyond
 * shared types, so the scanner and the DTO mapper can use it without pulling
 * the drivers' production wiring in.
 */
import type { AgentRow } from '../../db/agents'
import { isAgentDriverId, type AgentDriverId } from '../../../shared/agentDrivers'
import { DEFAULT_AGENT_ENGINE, isAgentEngine } from '../../../shared/engine'

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
