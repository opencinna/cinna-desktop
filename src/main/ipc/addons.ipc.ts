import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { addonDirectory } from '../services/addonDirectory'
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
}
