import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { catalogSkillService } from '../services/catalogSkillService'
import type { CatalogSkillEnsureResult, CatalogSkillOutcome } from '../../shared/catalogSkills'
import { ipcHandle } from './_wrap'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Catalog skills in folder agents: add, update, remove, and fetch what an
 * agent pins. Thin: activation gate, scope, delegate. Folder agents live in
 * the settings scope like every `local-agent:*` channel; the service reads
 * the active Cinna profile itself. Only ids and names cross, and every answer
 * — refusals included — is data (`src/shared/catalogSkills.ts`).
 */
export function registerCatalogSkillHandlers(): void {
  ipcHandle('catalog-skills:add', (_event, input?: { agentId?: unknown; packageUuid?: unknown }): Promise<CatalogSkillOutcome> => {
    userActivation.requireActivated()
    return catalogSkillService.addToAgent(getSettingsScopeUserId(), str(input?.agentId), str(input?.packageUuid))
  })

  ipcHandle('catalog-skills:update', (_event, input?: { agentId?: unknown; name?: unknown }): Promise<CatalogSkillOutcome> => {
    userActivation.requireActivated()
    return catalogSkillService.update(getSettingsScopeUserId(), str(input?.agentId), str(input?.name))
  })

  ipcHandle('catalog-skills:remove', (_event, input?: { agentId?: unknown; name?: unknown }): Promise<CatalogSkillOutcome> => {
    userActivation.requireActivated()
    return catalogSkillService.remove(getSettingsScopeUserId(), str(input?.agentId), str(input?.name))
  })

  ipcHandle('catalog-skills:ensure', (_event, input?: { agentId?: unknown }): Promise<CatalogSkillEnsureResult> => {
    userActivation.requireActivated()
    return catalogSkillService.ensurePinned(getSettingsScopeUserId(), str(input?.agentId))
  })
}
