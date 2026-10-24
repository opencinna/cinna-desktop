/**
 * The addon directory as the app runs it: the three U0 providers in display
 * order (Cinna, this computer, the MCP registries) over the services that
 * already pin skills and attach connectors. Core service — no Electron.
 */

import { LocalAgentError } from '../../errors'
import { mcpProviderRepo } from '../../db/mcpProviders'
import { localAgentService } from '../localAgents/localAgentService'
import { agentMcpService } from '../agentMcpService'
import { catalogSkillService, changeability, changeabilitySentence } from '../catalogSkillService'
import { activeListing } from '../catalogSkillUpdates'
import { marketplaceSkillService } from '../marketplaceSkillService'
import { marketplacePluginService } from '../marketplacePluginService'
import { pluginPinsOf } from '../pluginSkills'
import { stdioRuntimes } from '../stdioRuntimes'
import { defaultEngineService } from '../localAgents/defaultEngineService'
import { effectiveEngine } from '../../../shared/engine'
import { addonPolicies } from './policy'
import { mcpService } from '../mcpService'
import { createAddonDirectory, type AgentFacts, type McpSetup } from './directory'
import { createCinnaCoreProvider } from './cinnaCore'
import { createThisComputerProvider } from './thisComputer'
import { createMcpRegistriesProvider } from './mcpRegistries'

const cinnaCore = createCinnaCoreProvider()
const thisComputer = createThisComputerProvider()
const mcpRegistries = createMcpRegistriesProvider()

const pinOutcome = <T extends { ok: boolean }>(outcome: T): { ok: true } | { ok: false; code: string; message: string } =>
  outcome.ok ? { ok: true } : (outcome as unknown as { ok: false; code: string; message: string })

function agentFacts(userId: string, agentId: string): AgentFacts | null {
  try {
    const agent = localAgentService.get(userId, agentId)
    const kit = agent.skills !== undefined
    return {
      kit,
      skills: agent.skills ?? [],
      plugins: kit ? pluginPinsOf(agent.manifest).map((pin) => ({ entryUuid: pin.entry_uuid, name: pin.name })) : [],
      engine: effectiveEngine(agent.runtime, defaultEngineService.current())
    }
  } catch (err) {
    if (err instanceof LocalAgentError) return null
    throw err
  }
}

/** Whether the agent's pins are the user's to change, as Add would decide it (`changeability`, one git read); null when that cannot be read. */
async function skillAccess(userId: string, agentId: string): Promise<string | null> {
  try {
    const agent = localAgentService.get(userId, agentId)
    const access = await changeability(agent.path, activeListing())
    return access === 'ok' ? null : changeabilitySentence(access)
  } catch {
    // Fail open: a failed check never fails the whole directory read, and Add checks changeability again.
    return null
  }
}

export const addonDirectory = createAddonDirectory({
  providers: [cinnaCore, thisComputer, mcpRegistries],
  agent: agentFacts,
  skillAccess,
  attachedMcp: (userId, agentId) => agentMcpService.list(userId, agentId),
  addCatalogSkill: async (userId, agentId, id) => pinOutcome(await catalogSkillService.addToAgent(userId, agentId, id)),
  removeCatalogSkill: async (userId, agentId, name) => pinOutcome(await catalogSkillService.remove(userId, agentId, name)),
  addMarketplaceSkill: async (userId, agentId, id) => pinOutcome(await marketplaceSkillService.addToAgent(userId, agentId, id)),
  removeMarketplaceSkill: async (userId, agentId, name) => pinOutcome(await marketplaceSkillService.remove(userId, agentId, name)),
  addPlugin: async (userId, agentId, id) => {
    const outcome = await marketplacePluginService.addToAgent(userId, agentId, id)
    return outcome.ok ? { ok: true, next: outcome.next } : outcome
  },
  removePlugin: async (userId, agentId, name) => pinOutcome(await marketplacePluginService.remove(userId, agentId, name)),
  pluginBlock: (userId, entry) => stdioRuntimes.blockOf(entry.components?.mcpServers ?? [], addonPolicies.get(userId)),
  policies: addonPolicies.store(),
  attachMcp: (userId, agentId, id) => agentMcpService.attach(userId, agentId, id),
  detachMcp: (userId, agentId, id) => agentMcpService.detach(userId, agentId, id),
  mcpSetup: (userId, id) => thisComputer.setup(userId, id),
  findMcpByRef: (userId, ref) => mcpProviderRepo.findByRegistryRef(userId, ref)?.id ?? null,
  createMcpFromDirectory: async (userId, entry) => {
    const connect = entry.install && 'mcp' in entry.install ? entry.install.mcp : null
    if (!connect) throw new Error('This entry has nothing to connect to.')
    const created = await mcpService.createFromDirectory(userId, {
      name: entry.title || entry.name,
      transportType: connect.transport,
      url: connect.url,
      authType: connect.auth,
      registryRef: entry.ref,
      connect: connect.auth !== 'bearer'
    })
    // A token only for a server that says it takes one; any other failed connect offers Connect again,
    // so a server that is merely down is never turned into a bearer server by a pasted token.
    let setup: McpSetup | null = null
    if (connect.auth === 'bearer') setup = { next: 'bearer' }
    else if (created.status !== 'connected') {
      setup = created.needsUser ? { next: 'oauth' } : { next: 'connect', ...(created.error ? { message: created.error } : {}) }
    }
    return { id: created.id, setup }
  },
  deleteMcp: async (userId, id) => {
    await mcpService.delete(userId, id)
  }
})

