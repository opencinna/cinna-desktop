import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { addonDirectory } from '../services/addonDirectory'
import { marketplacePluginService } from '../services/marketplacePluginService'
import { stdioRuntimes } from '../services/stdioRuntimes'
import type { PluginActionResult, PluginDisabledInput, PluginStatusResult, RecheckRuntimesResult } from '../../shared/addons/plugins'
import {
  isAddonRef,
  type AddonActionResult,
  type AddonDirectoryResult,
  type AddonRef,
  type AddonSearchResult
} from '../../shared/addons/directory'
import { ipcHandle } from './_wrap'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const refOf = (value: unknown): AddonRef | null => (isAddonRef(value) ? { source: value.source, id: value.id } : null)
const NO_REF = { ok: false as const, code: 'invalid_ref', message: 'No addon was named.' }
const names = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, 200)).slice(0, 200) : undefined

/** Only the keys a pin's `disabled` has, with their own types. */
function disabledOf(value: unknown): PluginDisabledInput {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const out: PluginDisabledInput = {}
  if (typeof raw.hooks === 'boolean') out.hooks = raw.hooks
  const servers = names(raw.mcpServers)
  if (servers) out.mcpServers = servers
  const skills = names(raw.skills)
  if (skills) out.skills = skills
  return out
}

/**
 * The addon directory of one folder agent: every skill and MCP connector it
 * could add from every source, each with its state for the agent, and the
 * one Add / Remove over them. `refresh` on a directory read re-reads the
 * sources' caches (the picker asks it once per opening). Thin: activation gate, settings scope (folder
 * agents and the MCP list live there; the core source reads the active Cinna
 * profile itself), delegate. Only ids, refs and the query cross; every answer
 * — refusals included — is data (`src/shared/addons/directory.ts`).
 */
export function registerAddonHandlers(): void {
  ipcHandle('addons:directory', (_event, input?: { agentId?: unknown; refresh?: unknown }): Promise<AddonDirectoryResult> => {
    userActivation.requireActivated()
    return addonDirectory.list(getSettingsScopeUserId(), str(input?.agentId), { refresh: input?.refresh === true })
  })

  ipcHandle('addons:search', (_event, input?: { agentId?: unknown; query?: unknown }): Promise<AddonSearchResult> => {
    userActivation.requireActivated()
    return addonDirectory.search(getSettingsScopeUserId(), str(input?.agentId), str(input?.query).slice(0, 200))
  })

  ipcHandle('addons:add', async (_event, input?: { agentId?: unknown; ref?: unknown }): Promise<AddonActionResult> => {
    userActivation.requireActivated()
    const ref = refOf(input?.ref)
    if (!ref) return NO_REF
    return addonDirectory.add(getSettingsScopeUserId(), str(input?.agentId), ref)
  })

  ipcHandle('addons:remove', async (_event, input?: { agentId?: unknown; ref?: unknown }): Promise<AddonActionResult> => {
    userActivation.requireActivated()
    const ref = refOf(input?.ref)
    if (!ref) return NO_REF
    return addonDirectory.remove(getSettingsScopeUserId(), str(input?.agentId), ref)
  })

  /** A kit agent's pinned plugins, part by part (`src/shared/addons/plugins.ts`). */
  ipcHandle('addons:plugin-status', (_event, input?: { agentId?: unknown }): Promise<PluginStatusResult> => {
    userActivation.requireActivated()
    return marketplacePluginService.status(getSettingsScopeUserId(), str(input?.agentId))
  })

  /** Turn a pinned plugin's skills, connectors or hooks off or on. */
  ipcHandle(
    'addons:set-plugin-disabled',
    (_event, input?: { agentId?: unknown; name?: unknown; disabled?: unknown }): Promise<PluginActionResult> => {
      userActivation.requireActivated()
      return marketplacePluginService.setDisabled(getSettingsScopeUserId(), str(input?.agentId), str(input?.name), disabledOf(input?.disabled))
    }
  )

  /** Move a pinned plugin to its entry's current snapshot. */
  ipcHandle('addons:update-plugin', (_event, input?: { agentId?: unknown; name?: unknown }): Promise<PluginActionResult> => {
    userActivation.requireActivated()
    return marketplacePluginService.update(getSettingsScopeUserId(), str(input?.agentId), str(input?.name))
  })

  /** Look for Node.js and Docker again (a plugin's Check again), without a restart. */
  ipcHandle('addons:recheck-runtimes', async (): Promise<RecheckRuntimesResult> => {
    userActivation.requireActivated()
    return { ok: true, ...(await stdioRuntimes.recheck()) }
  })
}
