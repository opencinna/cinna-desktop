/**
 * A kit agent's `mcp_servers[]` requirements as the app changes them (D6):
 * through the manifest's modified-underneath guard (`directoryMcp.ts`
 * `writeMcpRequirements`), and only where the user may change the agent
 * (`changeability`) — a team agent shared to use is left as the team shared
 * it. Shared by the addon directory (Add / Remove), every detach of a
 * connector from an agent (`agentMcpService.detach`), and the Addons tab's
 * Remove of a requirement no source lists any more.
 *
 * Core: no Electron.
 */

import { mcpProviderRepo } from '../../db/mcpProviders'
import { changeability, changeabilitySentence, locateKit, settle } from '../catalogSkillService'
import { activeListing } from '../catalogSkillUpdates'
import { createLogger } from '../../logger/logger'
import type { McpServerRequirement } from '../../../shared/kit/manifest'
import type { AddonActionResult, AddonRef } from '../../../shared/addons/directory'
import { withoutRequirement, writeMcpRequirements } from './directoryMcp'

const logger = createLogger('AddonDirectory')

/** The directory entry a local provider was made from (`registry_ref`), or null. */
export const registryRefOfRow = (row: { registryRef?: { source?: unknown; id?: unknown } | null } | undefined): AddonRef | null =>
  row?.registryRef && typeof row.registryRef.source === 'string' && typeof row.registryRef.id === 'string'
    ? { source: row.registryRef.source, id: row.registryRef.id }
    : null

/**
 * Change a kit agent's `mcp_servers[]` through the manifest guard, where the
 * user may change the agent. Never throws: the connector itself is already
 * attached or detached, and the requirement is its note for other
 * computers. Answers whether it wrote.
 */
export async function changeRequirements(
  userId: string,
  agentId: string,
  change: (list: readonly McpServerRequirement[]) => McpServerRequirement[] | null
): Promise<boolean> {
  try {
    const kit = locateKit(userId, agentId)
    if ('ok' in kit) return false
    if ((await changeability(kit.dir, activeListing())) !== 'ok') return false
    if (!writeMcpRequirements(kit.dir, change)) return false
    settle(kit.rootId, agentId)
    return true
  } catch (err) {
    logger.warn('the agent’s MCP requirements could not be written', { agentId, error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * The provider `mcpProviderId` was detached from the agent: drop the
 * requirement it was written as (by its `registry_ref`). A plugin's own
 * connector and a custom one were never written, so nothing changes.
 */
export async function dropRequirementOfProvider(userId: string, agentId: string, mcpProviderId: string): Promise<void> {
  const row = mcpProviderRepo.getOwned(userId, mcpProviderId)
  if (!row || row.managedBy) return
  const ref = registryRefOfRow(row)
  if (!ref) return
  await changeRequirements(userId, agentId, (list) => withoutRequirement(list, ref))
}

/** The sentence a Remove of a requirement is refused with on an agent that has no manifest to change. */
export const REQUIREMENT_NOT_KIT = 'This agent has no connector list to change.'

/**
 * Remove the requirement `name` from the kit agent's `mcp_servers[]` (the
 * Addons tab's Remove of a connector no source lists any more, or a custom
 * one). Refusals are data; a name the list does not hold is a no-op.
 */
export async function removeRequirementByName(userId: string, agentId: string, name: string): Promise<AddonActionResult> {
  const kit = locateKit(userId, agentId)
  if ('ok' in kit) return kit.code === 'not_found' ? kit : { ok: false, code: kit.code, message: REQUIREMENT_NOT_KIT }
  const access = await changeability(kit.dir, activeListing())
  if (access !== 'ok') return { ok: false, code: access, message: changeabilitySentence(access) }
  try {
    const wrote = writeMcpRequirements(kit.dir, (list) => {
      const next = list.filter((item) => item?.name !== name)
      return next.length === list.length ? null : next
    })
    if (wrote) {
      settle(kit.rootId, agentId)
      logger.info('MCP requirement removed', { agentId, name })
    }
    return { ok: true, next: null }
  } catch (err) {
    logger.warn('an MCP requirement could not be removed', { agentId, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, code: 'write_failed', message: 'cinna-agent.json could not be changed. Try again.' }
  }
}
