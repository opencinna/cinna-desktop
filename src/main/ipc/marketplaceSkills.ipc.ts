import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { marketplaceSkillService } from '../services/marketplaceSkillService'
import type {
  MarketplaceSkillDiscoverResult,
  MarketplaceSkillEnsureResult,
  MarketplaceSkillOutcome,
  MarketplaceSkillStatusResult
} from '../../shared/marketplaceSkills'
import { ipcHandle } from './_wrap'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Marketplace skills in folder agents: list what the marketplaces offer, add,
 * update, remove, fetch what an agent pins, and where each pin stands. Thin:
 * activation gate, scope, delegate. Folder agents live in the settings scope
 * like every `local-agent:*` channel; the service reads the active Cinna
 * profile itself. Only ids and names cross, and every answer — refusals
 * included — is data (`src/shared/marketplaceSkills.ts`).
 */
export function registerMarketplaceSkillHandlers(): void {
  ipcHandle('marketplace-skills:discover', (): Promise<MarketplaceSkillDiscoverResult> => {
    userActivation.requireActivated()
    return marketplaceSkillService.discover()
  })

  ipcHandle('marketplace-skills:add', (_event, input?: { agentId?: unknown; entryUuid?: unknown }): Promise<MarketplaceSkillOutcome> => {
    userActivation.requireActivated()
    return marketplaceSkillService.addToAgent(getSettingsScopeUserId(), str(input?.agentId), str(input?.entryUuid))
  })

  ipcHandle('marketplace-skills:update', (_event, input?: { agentId?: unknown; name?: unknown }): Promise<MarketplaceSkillOutcome> => {
    userActivation.requireActivated()
    return marketplaceSkillService.update(getSettingsScopeUserId(), str(input?.agentId), str(input?.name))
  })

  ipcHandle('marketplace-skills:remove', (_event, input?: { agentId?: unknown; name?: unknown }): Promise<MarketplaceSkillOutcome> => {
    userActivation.requireActivated()
    return marketplaceSkillService.remove(getSettingsScopeUserId(), str(input?.agentId), str(input?.name))
  })

  ipcHandle('marketplace-skills:ensure', (_event, input?: { agentId?: unknown }): Promise<MarketplaceSkillEnsureResult> => {
    userActivation.requireActivated()
    return marketplaceSkillService.ensurePinned(getSettingsScopeUserId(), str(input?.agentId))
  })

  ipcHandle('marketplace-skills:status', (_event, input?: { agentId?: unknown }): Promise<MarketplaceSkillStatusResult> => {
    userActivation.requireActivated()
    return marketplaceSkillService.status(getSettingsScopeUserId(), str(input?.agentId))
  })
}
