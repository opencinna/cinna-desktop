/**
 * The addon directory as the app runs it: the three providers in display
 * order (Cinna, this computer, the MCP registries) over the services that
 * already pin skills and attach connectors, and the kit manifest's
 * `mcp_servers[]` requirements (`directoryMcp.ts`). Core service — no Electron.
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
import { stdioRuntimes, STDIO_RUNTIME_TEXT } from '../stdioRuntimes'
import { managedUvLayout } from '../../localdev/toolchain'
import { createLogger } from '../../logger/logger'
import { DIRECTORY_PACKAGE_REFUSED, directoryStdioLaunch, requirementOf, runtimeOfPackage, withoutRequirement, withRequirement, type UvBins } from './directoryMcp'
import { changeRequirements, registryRefOfRow } from './requirements'
import { defaultEngineService } from '../localAgents/defaultEngineService'
import { effectiveEngine } from '../../../shared/engine'
import { addonPolicies } from './policy'
import { mcpService } from '../mcpService'
import { CATALOG_SOURCE, createAddonDirectory, LOCAL_SOURCE, MARKETPLACE_SOURCE, type AgentFacts, type McpSetup } from './directory'
import { catalogSkillCache } from '../catalogSkillCache'
import { marketplaceSkillCache } from '../marketplaceSkillCache'
import { skillDashboardComponentCount } from '../dashboards/dashboardsSkill'
import type { CatalogSkillCacheState } from '../../kit/skills'
import type { DirectoryEntry } from '../../../shared/addons/directory'
import { createCinnaCoreProvider } from './cinnaCore'
import { createThisComputerProvider } from './thisComputer'
import { createMcpRegistriesProvider } from './mcpRegistries'
import { serverKeyOfConnector, serverKeyOfInstall } from './serverIdentity'

const logger = createLogger('AddonDirectory')

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
      engine: effectiveEngine(agent.runtime, defaultEngineService.current()),
      mcpServers: kit && Array.isArray(agent.manifest?.mcp_servers) ? agent.manifest.mcp_servers : []
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

/** The managed uv's binaries, or null on a host with no userData (they are then no stored command either). */
function uvBins(): UvBins | null {
  try {
    return managedUvLayout()
  } catch {
    return null
  }
}

/** A catalog entry's revision, from its download path (`…/revisions/<n>/download`); null when it names none. */
const CATALOG_REVISION_RE = /\/revisions\/(\d+)\/download$/

/**
 * How many dashboard components a skill entry ships, counted in the copy
 * cached on this computer (any agent's pin of the same digest). A skill never
 * downloaded here has no folder to count, so the picker says nothing.
 */
export function skillDashboardComponents(entry: DirectoryEntry): number {
  const sha = entry.digest?.startsWith('sha256:') ? entry.digest.slice('sha256:'.length) : null
  if (!sha) return 0
  let state: CatalogSkillCacheState = { state: 'missing' }
  if (entry.ref.source === MARKETPLACE_SOURCE) {
    state = marketplaceSkillCache.resolve({ entryUuid: entry.ref.id, name: entry.name, archiveSha256: sha })
  } else if (entry.ref.source === CATALOG_SOURCE) {
    const path = entry.install && 'archivePath' in entry.install ? entry.install.archivePath : ''
    const revision = CATALOG_REVISION_RE.exec(path)?.[1]
    if (!revision) return 0
    state = catalogSkillCache.resolve({ packageUuid: entry.ref.id, revisionNumber: Number(revision), name: entry.name, archiveSha256: sha })
  }
  return state.state === 'ready' ? skillDashboardComponentCount(state.dir) : 0
}

/** A refusal `refusalOf` reads as data: the code and the sentence. */
const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code })

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
    return outcome.ok ? { ok: true, next: outcome.next, ...(outcome.starting ? { starting: outcome.starting } : {}) } : outcome
  },
  removePlugin: async (userId, agentId, name) => pinOutcome(await marketplacePluginService.remove(userId, agentId, name)),
  pluginBlock: (userId, entry) => stdioRuntimes.blockOf(entry.components?.mcpServers ?? [], addonPolicies.get(userId)),
  mcpBlock: async (userId, entry) => {
    const connect = entry.install && 'mcp' in entry.install ? entry.install.mcp : null
    if (!connect || connect.transport !== 'stdio') return null
    return stdioRuntimes.blockOf([{ transport: 'stdio', runtime: runtimeOfPackage(connect.package.registry) }], addonPolicies.get(userId))
  },
  policies: addonPolicies.store(),
  noteMcpRequirement: async (userId, agentId, mcpProviderId, ref, auth) => {
    const row = mcpProviderRepo.getOwned(userId, mcpProviderId)
    // A plugin's own server is carried by its pin; a custom connector stays on this computer.
    if (!row || row.managedBy) return
    const from = registryRefOfRow(row) ?? (ref && ref.source !== LOCAL_SOURCE ? ref : null)
    if (!from) return
    const requirement = requirementOf(row, from, uvBins(), auth)
    await changeRequirements(userId, agentId, (list) => withRequirement(list, requirement))
  },
  dropMcpRequirement: async (userId, agentId, ref) => {
    const target = ref.source === LOCAL_SOURCE ? registryRefOfRow(mcpProviderRepo.getOwned(userId, ref.id)) : ref
    if (!target) return
    await changeRequirements(userId, agentId, (list) => withoutRequirement(list, target))
  },
  attachMcp: (userId, agentId, id) => agentMcpService.attach(userId, agentId, id),
  detachMcp: (userId, agentId, id) => agentMcpService.detach(userId, agentId, id),
  mcpSetup: (userId, id) => thisComputer.setup(userId, id),
  findMcpByRef: (userId, ref) => mcpProviderRepo.findByRegistryRef(userId, ref)?.id ?? null,
  findMcpByServer: (userId, entry) => {
    const server = serverKeyOfInstall(entry.install)
    if (!server) return null
    return mcpProviderRepo.list(userId).find((row) => !row.managedBy && serverKeyOfConnector(row) === server)?.id ?? null
  },
  createMcpFromDirectory: async (userId, entry) => {
    const connect = entry.install && 'mcp' in entry.install ? entry.install.mcp : null
    if (!connect) throw new Error('This entry has nothing to connect to.')
    if (connect.transport === 'stdio') {
      if (connect.package.registry === 'pypi') {
        try {
          await stdioRuntimes.ensureUv()
        } catch (err) {
          logger.warn('the managed uv could not be installed for a directory server', { error: err instanceof Error ? err.message : String(err) })
          throw coded('runtime_failed', STDIO_RUNTIME_TEXT.uvFailed)
        }
      }
      const launch = directoryStdioLaunch(connect, managedUvLayout())
      if (!launch) throw coded('unsupported', DIRECTORY_PACKAGE_REFUSED)
      const env = Object.fromEntries(connect.env.map((item) => [item.name, '']))
      const local = await mcpService.createFromDirectory(userId, {
        name: entry.title || entry.name,
        transportType: 'stdio',
        command: launch.command,
        args: launch.args,
        env,
        registryRef: entry.ref,
        connect: connect.env.length === 0
      })
      const setup: McpSetup | null =
        connect.env.length > 0 ? { next: 'env' } : local.status === 'connected' ? null : { next: 'connect', ...(local.error ? { message: local.error } : {}) }
      return { id: local.id, setup }
    }
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
  },
  skillDashboardComponents
})

