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
 * * `stdioMcp` turned back on — a connection left in error with the policy's
 *   sentence (app start refused it, `auth/reload.ts`) is cleared, so no card
 *   keeps saying "Blocked by your admin"; each is then started as app start
 *   would: a plugin's when it `startsUnattended`, a directory's once
 *   its settings are filled in.
 * * `pluginHooks` — read when a session starts: the next session goes
 *   without them, and nothing runs here to stop.
 * * `externalDirectories`, `customMcp` — what may be added; connectors
 *   already made keep running.
 *
 * Core: no Electron.
 */

import type { AddonPolicy } from '../../../shared/addons/directory'
import { STDIO_RUNTIME_TEXT } from '../../../shared/stdioRuntimeText'
import { mcpProviderRepo, type McpProviderRow } from '../../db/mcpProviders'
import { mcpManager } from '../../mcp/manager'
import { mcpRowToConfig } from '../../mcp/config'
import { missingEnvOf } from '../../mcp/managed'
import { createLogger } from '../../logger/logger'
import { addonPolicies } from './policy'

const logger = createLogger('AddonPolicy')

export interface PolicyFollowDeps {
  rows(settingsUserId: string): McpProviderRow[]
  running(id: string): boolean
  /** The connection's error, when its last connect failed. */
  error(id: string): string | undefined
  disconnect(id: string): Promise<void>
  /** `marketplacePluginService.startsUnattended`: whether app start would start this plugin's connector. */
  startsUnattended(row: McpProviderRow): Promise<boolean>
  connect(row: McpProviderRow): Promise<unknown>
}

const defaultDeps: PolicyFollowDeps = {
  rows: (settingsUserId) => mcpProviderRepo.list(settingsUserId),
  running: (id) => mcpManager.getConnection(id) !== undefined,
  error: (id) => {
    const connection = mcpManager.getConnection(id)
    return connection?.status === 'error' ? connection.error : undefined
  },
  disconnect: (id) => mcpManager.disconnect(id),
  // Loaded on use, as `auth/reload.ts` does: the plugin service is not this module's to pull in at import.
  startsUnattended: async (row) => (await import('../marketplacePluginService')).marketplacePluginService.startsUnattended(row),
  connect: (row) => mcpManager.connect(mcpRowToConfig(row))
}

/** The connectors `after` gates that `before` did not: a directory's or a plugin's local servers once `stdioMcp` is off. */
export function gatedBy(rows: readonly Pick<McpProviderRow, 'id' | 'transportType' | 'managedBy' | 'registryRef'>[], before: AddonPolicy, after: AddonPolicy): string[] {
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

/**
 * Local servers allowed again: clear every connection the policy refused, then start each as app start would.
 * Never throws.
 */
export async function resumeAllowed(settingsUserId: string, before: AddonPolicy, after: AddonPolicy, deps: PolicyFollowDeps = defaultDeps): Promise<string[]> {
  if (before.stdioMcp || !after.stdioMcp) return []
  const refused = deps.rows(settingsUserId).filter((row) => deps.error(row.id) === STDIO_RUNTIME_TEXT.policy)
  const started: string[] = []
  await Promise.all(
    refused.map(async (row) => {
      try {
        await deps.disconnect(row.id)
        if (!row.enabled) return
        // The rule `auth/reload.ts` starts rows by: a plugin's when it may run unattended, a directory's once filled in.
        const starts = row.managedBy ? await deps.startsUnattended(row) : missingEnvOf(row).length === 0
        if (!starts) return
        await deps.connect(row)
        started.push(row.id)
      } catch (err) {
        logger.warn('could not start a server the policy allows again', { providerId: row.id, error: err instanceof Error ? err.message : String(err) })
      }
    })
  )
  if (refused.length > 0) logger.info('cleared servers the admin policy allows again', { count: refused.length, started: started.length })
  return started
}

let installed: (() => void) | null = null

/** Follow the active account's policy from now on (once). */
export function installAddonPolicyFollow(deps: PolicyFollowDeps = defaultDeps): () => void {
  installed?.()
  const off = addonPolicies.onChange((settingsUserId, before, after) => {
    void stopGated(settingsUserId, before, after, deps)
    void resumeAllowed(settingsUserId, before, after, deps)
  })
  installed = off
  return off
}
