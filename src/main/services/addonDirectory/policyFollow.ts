/**
 * The admin's addon policy changed for the active account: stop what it now
 * gates, without deleting anything (it runs again once the policy allows).
 *
 * * `stdioMcp` turned off — a local server from a directory entry
 *   (`registry_ref`) and a plugin's local server (`managed_by`) are
 *   disconnected; their next connect is refused at launch
 *   (`mcp/managed.ts`). A **hand-made** local connector keeps running: the
 *   policy forbids *adding* local servers (`mcpService.upsert`), not the
 *   ones the user already made by hand.
 * * `pluginHooks` — read when a session starts: the next session goes
 *   without them, and nothing runs here to stop.
 * * `externalDirectories`, `customMcp` — what may be added; connectors
 *   already made keep running.
 *
 * Core: no Electron.
 */

import type { AddonPolicy } from '../../../shared/addons/directory'
import { mcpProviderRepo, type McpProviderRow } from '../../db/mcpProviders'
import { mcpManager } from '../../mcp/manager'
import { createLogger } from '../../logger/logger'
import { addonPolicies } from './policy'

const logger = createLogger('AddonPolicy')

export interface PolicyFollowDeps {
  rows(settingsUserId: string): Pick<McpProviderRow, 'id' | 'transportType' | 'managedBy' | 'registryRef'>[]
  running(id: string): boolean
  disconnect(id: string): Promise<void>
}

const defaultDeps: PolicyFollowDeps = {
  rows: (settingsUserId) => mcpProviderRepo.list(settingsUserId),
  running: (id) => mcpManager.getConnection(id) !== undefined,
  disconnect: (id) => mcpManager.disconnect(id)
}

/** The connectors `after` gates that `before` did not: a directory's or a plugin's local servers once `stdioMcp` is off. */
export function gatedBy(rows: ReturnType<PolicyFollowDeps['rows']>, before: AddonPolicy, after: AddonPolicy): string[] {
  if (!before.stdioMcp || after.stdioMcp) return []
  // A hand-made local connector (no plugin, no directory entry) is not gated: only adding one is.
  return rows.filter((row) => row.transportType === 'stdio' && (!!row.managedBy || !!row.registryRef)).map((row) => row.id)
}

/** Disconnect what the change gates; never throws. */
export async function stopGated(settingsUserId: string, before: AddonPolicy, after: AddonPolicy, deps: PolicyFollowDeps = defaultDeps): Promise<string[]> {
  const ids = gatedBy(deps.rows(settingsUserId), before, after).filter((id) => deps.running(id))
  await Promise.all(
    ids.map((id) =>
      deps.disconnect(id).catch((err) => logger.warn('could not stop a server the policy now forbids', { providerId: id, error: err instanceof Error ? err.message : String(err) }))
    )
  )
  if (ids.length > 0) logger.info('stopped servers the admin policy now forbids', { count: ids.length })
  return ids
}

let installed: (() => void) | null = null

/** Follow the active account's policy from now on (once). */
export function installAddonPolicyFollow(deps: PolicyFollowDeps = defaultDeps): () => void {
  installed?.()
  const off = addonPolicies.onChange((settingsUserId, before, after) => {
    void stopGated(settingsUserId, before, after, deps)
  })
  installed = off
  return off
}
