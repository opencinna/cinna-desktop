import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { agentRepo, type AgentRow } from '../db/agents'
import { chatRepo } from '../db/chats'
import { llmProviderRepo } from '../db/llmProviders'
import { managedAgentSessionRepo } from '../db/managedAgentSessions'
import { getManagedResourceScopes, getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { decryptApiKey } from '../security/keystore'
import { parseManagedAgentConfig, type ManagedAgentConfig } from '../../shared/managedAgents'
import type { ManagedRunBinding } from '../agents/drivers/managed/managedRun'

/** One captured account capability. No renderer-supplied URL or key enters it. */
function credential(credentialId: string): { client: Anthropic; fingerprint: string; validate(): void } {
  const profileId = getProfileScopeUserId()
  const read = () => llmProviderRepo.listByUserIds(getManagedResourceScopes()).find((row) => row.id === credentialId)
  const row = read()
  if (!row || row.type !== 'anthropic' || !row.enabled || row.unsupported || !row.apiKeyEncrypted) {
    throw new Error('Choose an enabled Anthropic API credential in Settings → AI Credentials.')
  }
  const signature = (value: typeof row): string => createHash('sha256').update(JSON.stringify([
    profileId, value.userId, value.id, value.type, value.enabled, value.unsupported,
    value.configRevision ?? 0, value.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    value.apiKeyEncrypted?.toString('base64')
  ])).digest('hex')
  const fingerprint = signature(row)
  const apiKey = decryptApiKey(row.apiKeyEncrypted)
  if (apiKey.startsWith('sk-ant-oat')) throw new Error('Managed agents require an Anthropic API key, not a Claude CLI login.')
  return {
    client: new Anthropic({ apiKey, authToken: null, ...(row.baseUrl ? { baseURL: row.baseUrl } : {}), maxRetries: 0, timeout: 30_000 }),
    fingerprint,
    validate() {
      const current = read()
      if (getProfileScopeUserId() !== profileId || !current || signature(current) !== fingerprint) {
        throw new Error('The Managed agent credential or active profile changed. Start again with the current configuration.')
      }
    }
  }
}

export const managedAgentService = {
  configuration(id: string): { name: string; config: ManagedAgentConfig } {
    const row = agentRepo.getOwned(getSettingsScopeUserId(), id)
    if (!row || row.driver !== 'managed') throw new Error('Managed agent not found.')
    return { name: row.name, config: parseManagedAgentConfig(row.driverConfig) }
  },
  readiness(agent: AgentRow): void {
    const config = parseManagedAgentConfig(agent.driverConfig)
    credential(config.credentialId).validate()
  },

  prepare(ownerId: string, agent: AgentRow, chatId: string): ManagedRunBinding {
    const profileId = getProfileScopeUserId()
    const config = parseManagedAgentConfig(agent.driverConfig)
    const account = credential(config.credentialId)
    const configIdentity = JSON.stringify(agent.driverConfig)
    const fingerprint = createHash('sha256').update(JSON.stringify([profileId, ownerId, agent.id, configIdentity, account.fingerprint])).digest('hex')
    const validate = (): void => {
      account.validate()
      if (!chatRepo.getOwned(profileId, chatId)) throw new Error('This Managed conversation is no longer available.')
      const current = agentRepo.getOwned(ownerId, agent.id)
      if (!current || !current.enabled || current.driver !== 'managed' || JSON.stringify(current.driverConfig) !== configIdentity) {
        throw new Error('This Managed agent configuration changed. Start a new chat with its current configuration.')
      }
    }
    validate()
    return {
      client: account.client, config, validate,
      checkpoint: managedAgentSessionRepo.get(profileId, chatId, agent.id, fingerprint),
      save(checkpoint) {
        validate()
        managedAgentSessionRepo.save(profileId, ownerId, chatId, agent.id, fingerprint, checkpoint)
      }
    }
  },

  async choices(credentialId: string, workspaceId?: string): Promise<{
    agents: { id: string; name: string; description: string | null; version: number }[]
    environments: { id: string; name: string }[]
  }> {
    const account = credential(credentialId)
    const params = workspaceId ? { workspace_id: workspaceId } : {}
    const signal = AbortSignal.timeout(30_000)
    const agents: { id: string; name: string; description: string | null; version: number }[] = []
    const environments: { id: string; name: string }[] = []
    for await (const row of account.client.beta.agents.list(params, { signal, maxRetries: 0 })) {
      account.validate()
      if (agents.length >= 1000) throw new Error('This account has too many Managed agents to list. Choose a narrower workspace.')
      agents.push({ id: row.id, name: row.name ?? row.id, description: row.description ?? null, version: row.version })
    }
    for await (const row of account.client.beta.environments.list(params, { signal, maxRetries: 0 })) {
      account.validate()
      if (environments.length >= 1000) throw new Error('This account has too many environments to list. Choose a narrower workspace.')
      environments.push({ id: row.id, name: row.name ?? row.id })
    }
    account.validate()
    return { agents, environments }
  },

  async save(input: { id?: string; name?: string; config: ManagedAgentConfig }): Promise<{ id: string }> {
    const config = parseManagedAgentConfig(input.config)
    const ownerId = getSettingsScopeUserId()
    const profileId = getProfileScopeUserId()
    const original = input.id ? agentRepo.getOwned(ownerId, input.id) : null
    if (input.id && (!original || original.driver !== 'managed')) throw new Error('Managed agent not found.')
    const originalIdentity = original ? JSON.stringify([original.driverConfig, original.enabled]) : null
    const account = credential(config.credentialId)
    const params = config.workspaceId ? { workspace_id: config.workspaceId } : {}
    const options = { signal: AbortSignal.timeout(30_000), maxRetries: 0 }
    const remote = await account.client.beta.agents.retrieve(config.agentId, { ...params, ...(config.version ? { version: config.version } : {}) }, options)
    account.validate()
    await account.client.beta.environments.retrieve(config.environmentId, params, options)
    account.validate()
    if (getProfileScopeUserId() !== profileId || getSettingsScopeUserId() !== ownerId) throw new Error('The active profile changed.')
    if (input.id) {
      const current = agentRepo.getOwned(ownerId, input.id)
      if (!current || JSON.stringify([current.driverConfig, current.enabled]) !== originalIdentity) throw new Error('This agent changed while its configuration was being checked. Reopen it and try again.')
    }
    const name = (input.name ?? remote.name ?? config.agentId).trim()
    if (!name || name.length > 200) throw new Error('Give this agent a name of up to 200 characters.')
    const storedConfig = { ...config }
    const row = input.id
      ? agentRepo.updateRuntime(ownerId, input.id, 'managed', { name, config: storedConfig })
      : agentRepo.createRuntime(ownerId, { name, description: remote.description, driver: 'managed', config: storedConfig })
    return { id: row.id }
  }
}
