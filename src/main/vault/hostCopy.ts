/**
 * The host folder a vault agent left behind (Move to vault… copies, it does
 * not delete), as its row remembers it in `driverConfig.vault.hostCopyPath`.
 * A module of its own so the agent list can ask without importing the move
 * service.
 */
import { existsSync } from 'node:fs'
import type { AgentRow } from '../db/agents'

export function hostCopyPathOf(row: Pick<AgentRow, 'driverConfig'>): string | null {
  const raw = (row.driverConfig?.['vault'] ?? {}) as Record<string, unknown>
  return typeof raw['hostCopyPath'] === 'string' && raw['hostCopyPath'] ? raw['hostCopyPath'] : null
}

/** True while a vault agent's host folder is still there (the list's `vault.hostCopy`). */
export function hasHostCopy(row: Pick<AgentRow, 'driverConfig'>): boolean {
  const path = hostCopyPathOf(row)
  return !!path && existsSync(path)
}
