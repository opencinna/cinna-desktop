/**
 * The production wiring of {@link createAgentAccounts}: the services it reads, in process. Kept apart
 * from `agentAccounts.ts` so that module's rules are tested without a database.
 */
import { createAgentAccounts } from './agentAccounts'
import { serviceCredentialService } from './service'
import { localAgentService } from '../localAgents/localAgentService'
import { defaultEngineService } from '../localAgents/defaultEngineService'
import { runtimeService } from '../localAgents/runtimeService'
import { providerService } from '../providerService'
import { appSettingsService } from '../appSettingsService'
import { llmProviderRepo } from '../../db/llmProviders'
import { userRepo } from '../../db/users'
import { getManagedResourceScopes } from '../../auth/scope'
import { isVaultAgent } from '../../vault/isVaultAgent'

export const agentAccountsService = createAgentAccounts({
  isVault: isVaultAgent,
  agent: (id) => localAgentService.get('__default__', id),
  credentialAccounts: (id) => serviceCredentialService.unavailableAccounts(id),
  profileAccount: (userId) => serviceCredentialService.profileAccount(userId),
  defaultEngine: () => defaultEngineService.current(),
  providers: () => providerService.listMerged(),
  fallbackCredentialId: (providers) => {
    try { return runtimeService.resolveDefault(providers).credentialId } catch { return null }
  },
  settings: () => {
    const all = appSettingsService.getAll()
    return { localAgentsDefaultCredentialId: all.localAgentsDefaultCredentialId, claudeAuthMode: all.claudeAuthMode, claudeApiCredentialId: all.claudeApiCredentialId }
  },
  otherManagedRows: () => {
    const scopes = new Set(getManagedResourceScopes())
    const others = userRepo.list().map((u) => u.id).filter((id) => !scopes.has(id))
    return llmProviderRepo.listByUserIds(others).filter((row) => row.managed)
      .map((row) => ({ userId: row.userId, id: row.id, name: row.name, managed: row.managed }))
  }
})
