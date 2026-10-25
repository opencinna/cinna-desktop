/**
 * The addon directory for one agent: merges every directory provider's
 * entries, folds a local MCP provider made from a directory entry into that
 * entry (shown once, as "On this computer"), and marks each entry with where
 * it stands for the agent. Add and Remove dispatch to the paths each kind
 * already has (catalog / marketplace skill pins, MCP attach).
 *
 * A kit agent's MCP connectors from a directory are also written into its
 * `cinna-agent.json` as `mcp_servers[]` requirements (D6, no secrets), so a
 * shared copy arrives with them listed; {@link mcpRequirements} says where
 * each requirement stands on this computer.
 *
 * Pure over its {@link AddonDirectoryDeps}, so the merge, the states and the
 * dispatch are tested with fakes; `index.ts` wires the real services.
 * Every answer is data; nothing a caller can cause is thrown.
 */

import {
  DEFAULT_ADDON_POLICY,
  addonRefKey,
  isAddonRef,
  type AddonMcpConnect,
  type AddonMcpRequirement,
  type AddonMcpRequirementsResult,
  type AddonActionResult,
  type AddonDirectoryResult,
  type AddonNextStep,
  type AddonPolicy,
  type AddonRef,
  type AddonRefused,
  type AddonSearchResult,
  type AddonSourceStatus,
  type AgentAddonState,
  type AgentDirectoryEntry
} from '../../../shared/addons/directory'
import type { LocalAgentSkill } from '../../../shared/localAgents'
import type { McpServerAuth, McpServerRequirement } from '../../../shared/kit/manifest'
import type { AgentEngine } from '../../../shared/engine'
import { compatibilityOf } from '../../../shared/addons/engineSupport'
import type { DirectoryContext, DirectoryProvider, ProviderEntry, ProviderListing } from './types'
import { serverKeyOfInstall } from './serverIdentity'

export const LOCAL_SOURCE = 'this-computer'
export const CATALOG_SOURCE = 'core-catalog'
export const MARKETPLACE_SOURCE = 'core-marketplace'
/** A claude- or codex-format marketplace plugin (the entry uuid); pinned by `marketplacePluginService`. */
export const PLUGIN_SOURCE = 'core-marketplace-plugin'
/** A server of core's MCP directory (U4). */
export const CORE_MCP_SOURCE = 'core-mcp-directory'

export const ADDON_STATE_TEXT = {
  added: 'Added to this agent',
  addedNeeds: (need: string) => `Added — ${need.charAt(0).toLowerCase()}${need.slice(1)}`,
  preparing: 'Being prepared on the server',
  unsupported: 'The server could not prepare it for adding',
  needsKit: 'Needs a cinna-agent.json',
  gated: 'Turned off for your account by your admin',
  notFound: 'This addon is no longer listed',
  agentNotFound: 'This agent is not on this computer any more'
} as const

/** Where an `mcp_servers[]` requirement stands, in words. */
export const MCP_REQUIREMENT_TEXT = {
  custom: 'Set it up as a custom connector',
  unavailable: 'No longer available to you',
  needsSetup: 'Needs setup on this computer',
  notAttached: 'On this computer, not added to this agent yet',
  unchecked: 'Could not check where it comes from right now',
  step: {
    oauth: 'Needs you to sign in',
    bearer: 'Needs an access token',
    env: 'Needs settings filled in',
    connect: 'Could not connect',
    enable: 'Turned off'
  } satisfies Record<AddonNextStep, string>
} as const

/** What the directory needs to know about the agent. Null: not a folder agent in this scope. */
export interface AgentFacts {
  /** A kit agent (has a `cinna-agent.json`): it can pin skills and plugins. */
  kit: boolean
  skills: Pick<LocalAgentSkill, 'source' | 'name' | 'packageUuid' | 'entryUuid'>[]
  /** The plugins it pins (`marketplace_plugins[]`); absent reads as none. */
  plugins?: { entryUuid: string; name: string }[]
  /** The engine it runs on (manifest `runtime.engine`, else this machine's default): what compatibility is judged against. */
  engine?: AgentEngine
  /** Its manifest's `mcp_servers[]` requirements (kit agents); absent reads as none. */
  mcpServers?: McpServerRequirement[]
}

/** Core's policy per settings scope: what the directory reads and writes back (`addonPolicies.store()`, or a plain map). */
export interface AddonPolicyStore {
  get(settingsUserId: string): AddonPolicy | undefined
  /** `account`: the account the read was started for ({@link account}); the active one when absent. */
  set(settingsUserId: string, policy: AddonPolicy, account?: string | null): void
  /** The active account's key at the start of a read, carried to {@link set}; absent for a plain map. */
  account?(): string | null
}

/** Why the agent's skill pins are not the user's to change (a team agent shared to use only), or null. */
export type SkillAccess = string | null

/** Where a local connector stands after an add: the step it still needs, and why when it did not connect. */
export interface McpSetup {
  next: AddonNextStep
  message?: string
}

type PinOutcome = { ok: true } | AddonRefused

export interface AddonDirectoryDeps {
  /** In display order. */
  providers: DirectoryProvider[]
  agent(userId: string, agentId: string): AgentFacts | null
  /**
   * Whether this kit agent's skill pins may be changed here: null when they
   * may, else the sentence why not. Asked once per directory read (it may
   * read the folder's git remote), never per entry.
   */
  skillAccess(userId: string, agentId: string): Promise<SkillAccess>
  attachedMcp(userId: string, agentId: string): string[]
  addCatalogSkill(userId: string, agentId: string, packageUuid: string): Promise<PinOutcome>
  removeCatalogSkill(userId: string, agentId: string, name: string): Promise<PinOutcome>
  addMarketplaceSkill(userId: string, agentId: string, entryUuid: string): Promise<PinOutcome>
  removeMarketplaceSkill(userId: string, agentId: string, name: string): Promise<PinOutcome>
  /** Pin a marketplace plugin; `next` is the step a managed connector of it still needs. */
  addPlugin?(userId: string, agentId: string, entryUuid: string): Promise<{ ok: true; next: AddonNextStep | null; starting?: string[] } | AddonRefused>
  removePlugin?(userId: string, agentId: string, name: string): Promise<PinOutcome>
  /**
   * Why a plugin cannot be added on this computer — a local server needs a
   * runtime it lacks, or the admin's policy forbids local servers — or null.
   * Asked once per plugin entry per directory read.
   */
  pluginBlock?(userId: string, entry: ProviderEntry): Promise<string | null>
  /**
   * Why a local (stdio) directory MCP server cannot be added here — the
   * admin forbids local servers, or its package needs Node or Docker — or null.
   */
  mcpBlock?(userId: string, entry: ProviderEntry): Promise<string | null>
  /** Core's policy per settings scope, shared with the services that honour it; a private map when absent. */
  policies?: AddonPolicyStore
  /**
   * Record in a kit agent's manifest that it uses the local provider
   * `mcpProviderId` (an `mcp_servers[]` requirement under the provider's
   * directory ref, else `ref`). Nothing for a custom or a plugin's connector,
   * or an agent whose manifest is not the user's to change. `auth` is the
   * entry's own auth when the add read the entry (a remote server that needs
   * none is `none`, though its connector is OAuth-capable). Never throws.
   */
  noteMcpRequirement?(userId: string, agentId: string, mcpProviderId: string, ref: AddonRef | null, auth?: McpServerAuth): Promise<void>
  /** Drop the requirement for `ref` (a local provider's ref names its directory ref) from the manifest. Never throws. */
  dropMcpRequirement?(userId: string, agentId: string, ref: AddonRef): Promise<void>
  /** Throws a `DomainError` (`not_found`) for an agent or provider outside the scope. */
  attachMcp(userId: string, agentId: string, mcpProviderId: string): void
  detachMcp(userId: string, agentId: string, mcpProviderId: string): void | Promise<void>
  /** The step a local provider still needs before it connects unattended, or null. */
  mcpSetup(userId: string, mcpProviderId: string): McpSetup | null
  /** The local provider created from this directory entry, if any. */
  findMcpByRef(userId: string, ref: AddonRef): string | null
  /** A local provider (not a plugin's) that is the same server as this entry of core's MCP directory (`serverIdentity.ts`), if any. */
  findMcpByServer?(userId: string, entry: ProviderEntry): string | null
  /** Create a local provider from a directory MCP entry (with its `registry_ref`); the step it needs next. */
  createMcpFromDirectory(userId: string, entry: ProviderEntry): Promise<{ id: string; setup: McpSetup | null }>
  /** Delete a local provider this directory just created (its attach failed). */
  deleteMcp(userId: string, mcpProviderId: string): Promise<void>
}

const SEARCH_MEMORY_MAX = 500

function refused(code: string, message: string): AddonRefused {
  return { ok: false, code, message }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function refusalOf(err: unknown): AddonRefused {
  const code = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'failed'
  return refused(code, errorText(err).slice(0, 300) || 'Something went wrong.')
}

/** A local provider made from a directory entry, shown as that entry's metadata on this computer. */
function mergedLocal(local: ProviderEntry, from: ProviderEntry): ProviderEntry {
  return {
    ...from,
    ref: local.ref,
    origin: { ...local.origin, repositoryUrl: from.origin.repositoryUrl, homepage: from.origin.homepage },
    runsCode: local.runsCode,
    status: 'ready',
    unsupportedReason: null,
    install: null,
    mcpProviderId: local.mcpProviderId,
    registryRef: local.registryRef,
    setupReason: local.setupReason,
    setupStep: local.setupStep,
    provider: local.provider
  }
}

/**
 * The de-duplication: a local provider whose `registry_ref` names an entry
 * another source lists takes that entry's place; else, one that is the same
 * server as an entry of core's MCP directory — its URL, or the package it
 * runs ({@link ProviderEntry.serverKey}) — takes that entry's place (a
 * connector typed in by hand, or made from the opencinna list core's
 * directory is seeded from). Everything else shows once per source, even
 * when two sources hold the same name.
 */
export function mergeLocalProviders(entries: ProviderEntry[]): ProviderEntry[] {
  const directory = new Map<string, ProviderEntry>()
  const coreByServer = new Map<string, ProviderEntry>()
  for (const entry of entries) {
    if (entry.ref.source === LOCAL_SOURCE) continue
    directory.set(addonRefKey(entry.ref), entry)
    const server = entry.ref.source === CORE_MCP_SOURCE ? serverKeyOfInstall(entry.install) : null
    if (server && !coreByServer.has(server)) coreByServer.set(server, entry)
  }
  // What a local provider's own ref takes first, so a match by server never doubles it.
  const consumed = new Set<string>()
  for (const entry of entries) {
    if (entry.ref.source === LOCAL_SOURCE && entry.registryRef && directory.has(addonRefKey(entry.registryRef))) consumed.add(addonRefKey(entry.registryRef))
  }
  const merged = entries.map((entry) => {
    if (entry.ref.source !== LOCAL_SOURCE) return entry
    const byRef = entry.registryRef ? directory.get(addonRefKey(entry.registryRef)) : undefined
    // By server only into an entry no other local provider has taken: one connector stands for it.
    const byServer = !byRef && entry.serverKey ? coreByServer.get(entry.serverKey) : undefined
    const from = byRef ?? (byServer && !consumed.has(addonRefKey(byServer.ref)) ? byServer : undefined)
    if (!from) return entry
    consumed.add(addonRefKey(from.ref))
    return mergedLocal(entry, from)
  })
  return merged.filter((entry) => entry.ref.source === LOCAL_SOURCE || !consumed.has(addonRefKey(entry.ref)))
}

function isAdded(entry: ProviderEntry, agent: AgentFacts, attached: ReadonlySet<string>): boolean {
  if (entry.mcpProviderId) return attached.has(entry.mcpProviderId)
  const id = entry.ref.id.toLowerCase()
  if (entry.ref.source === PLUGIN_SOURCE) return (agent.plugins ?? []).some((plugin) => plugin.entryUuid.toLowerCase() === id)
  if (entry.ref.source === CATALOG_SOURCE) {
    return agent.skills.some((skill) => skill.source === 'catalog' && skill.packageUuid?.toLowerCase() === id)
  }
  if (entry.ref.source === MARKETPLACE_SOURCE) {
    return agent.skills.some((skill) => skill.source === 'marketplace' && skill.entryUuid?.toLowerCase() === id)
  }
  return false
}

/**
 * Where one entry stands for one agent, and the sentence why. An added
 * connector that still needs a sign-in, a key or a connect says so:
 * "Added — <what it needs>".
 */
export function stateOf(
  entry: ProviderEntry,
  agent: AgentFacts,
  attached: ReadonlySet<string>,
  skillAccess: SkillAccess = null
): { state: AgentAddonState; stateReason: string | null } {
  if (isAdded(entry, agent, attached)) {
    return { state: 'added', stateReason: entry.setupReason ? ADDON_STATE_TEXT.addedNeeds(entry.setupReason) : ADDON_STATE_TEXT.added }
  }
  if (entry.status === 'pending') return { state: 'preparing', stateReason: ADDON_STATE_TEXT.preparing }
  if (entry.status === 'unsupported') return { state: 'blocked', stateReason: ADDON_STATE_TEXT.unsupported }
  const pinned = entry.kind === 'skill' || entry.kind === 'plugin'
  if (pinned && !agent.kit) return { state: 'blocked', stateReason: ADDON_STATE_TEXT.needsKit }
  if (pinned && skillAccess) return { state: 'blocked', stateReason: skillAccess }
  if (entry.blockReason) return { state: 'blocked', stateReason: entry.blockReason }
  if (entry.kind === 'plugin' && entry.components && agent.engine) {
    const fit = compatibilityOf(entry.components, null, agent.engine)
    if (fit.level !== 'compatible') return { state: fit.level, stateReason: fit.reason }
  }
  if (entry.setupReason) return { state: 'addable_with_setup', stateReason: entry.setupReason }
  return { state: 'addable', stateReason: null }
}

function toAgentEntry(entry: ProviderEntry, agent: AgentFacts, attached: ReadonlySet<string>, skillAccess: SkillAccess): AgentDirectoryEntry {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { registryRef, serverKey, setupReason, setupStep, mcpProviderId, provider, blockReason, ...shared } = entry
  return {
    ...shared,
    provider: provider ?? '',
    ...stateOf(entry, agent, attached, skillAccess),
    ...(mcpProviderId ? { mcpProviderId } : {}),
    ...(mcpProviderId && setupStep ? { setupStep } : {})
  }
}

/**
 * The `mcp_servers[]` auth of a core MCP directory entry's connect: a remote
 * server with no auth is `none`, though the desktop connects it OAuth-capable.
 */
function requirementAuth(connect: AddonMcpConnect): McpServerAuth {
  if (connect.transport === 'stdio') return connect.auth
  return connect.requiresAuth ? connect.auth : 'none'
}

export function createAddonDirectory(deps: AddonDirectoryDeps) {
  /** Core's last policy per settings scope; the default until core sends one. */
  const policies: AddonPolicyStore = deps.policies ?? new Map<string, AddonPolicy>()
  /** Entries only a search found (the official registry), so a detail read or an add can name them. */
  const searched = new Map<string, ProviderEntry>()

  const policyOf = (userId: string): AddonPolicy => policies.get(userId) ?? DEFAULT_ADDON_POLICY
  const allowed = (provider: DirectoryProvider, policy: AddonPolicy): boolean => !provider.gate || policy[provider.gate]
  const ownerOf = (ref: AddonRef): DirectoryProvider | undefined => deps.providers.find((provider) => provider.owns(ref))

  async function read(
    provider: DirectoryProvider,
    run: () => Promise<ProviderListing>
  ): Promise<{ entries: ProviderEntry[]; source: AddonSourceStatus; policy?: AddonPolicy; mcpDirectory?: boolean }> {
    try {
      const listing = await run()
      return {
        ...(listing.mcpDirectory ? { mcpDirectory: true } : {}),
        entries: listing.entries.map((entry) => ({ ...entry, provider: provider.id })),
        source: {
          id: provider.id,
          label: provider.label,
          ...(listing.error ? { error: listing.error } : {}),
          ...(listing.error && listing.errorCode ? { errorCode: listing.errorCode } : {})
        },
        policy: listing.policy
      }
    } catch (err) {
      return { entries: [], source: { id: provider.id, label: provider.label, error: errorText(err) } }
    }
  }

  /** Every provider's list: the ungated ones first (core's policy among them), then those the policy allows. */
  async function listAll(ctx: DirectoryContext): Promise<{ entries: ProviderEntry[]; sources: AddonSourceStatus[]; policy: AddonPolicy }> {
    // The account the read is for, fixed now: a profile switch while core answers never files A's policy as B's.
    const account = policies.account?.()
    const ungated = deps.providers.filter((provider) => !provider.gate)
    const first = await Promise.all(ungated.map((provider) => read(provider, () => provider.list(ctx))))
    const sent = first.find((answer) => answer.policy)?.policy
    if (sent) policies.set(ctx.settingsUserId, sent, account)
    const policy = policyOf(ctx.settingsUserId)
    const gated = deps.providers.filter((provider) => provider.gate && allowed(provider, policy))
    const gatedCtx: DirectoryContext = first.some((answer) => answer.mcpDirectory) ? { ...ctx, coreMcpDirectory: true } : ctx
    const second = await Promise.all(gated.map((provider) => read(provider, () => provider.list(gatedCtx))))
    const answers = new Map([...first, ...second].map((answer) => [answer.source.id, answer]))
    const ordered = deps.providers.flatMap((provider) => {
      const answer = answers.get(provider.id)
      return answer ? [answer] : []
    })
    return {
      entries: mergeLocalProviders(ordered.flatMap((answer) => answer.entries)),
      sources: ordered.map((answer) => answer.source),
      policy
    }
  }

  function remember(entries: ProviderEntry[]): void {
    for (const entry of entries) {
      const key = addonRefKey(entry.ref)
      searched.delete(key)
      searched.set(key, entry)
    }
    while (searched.size > SEARCH_MEMORY_MAX) searched.delete(searched.keys().next().value as string)
  }

  /** The directory entry behind a ref that is not a local provider, from memory, the provider, or its list. */
  async function directoryEntry(ctx: DirectoryContext, ref: AddonRef): Promise<ProviderEntry | null> {
    const key = addonRefKey(ref)
    const known = searched.get(key)
    if (known) return known
    const provider = ownerOf(ref)
    if (!provider) return null
    if (provider.find) return provider.find(ctx, ref)
    const listing = await provider.list(ctx)
    return listing.entries.find((entry) => addonRefKey(entry.ref) === key) ?? null
  }

  function agentOf(userId: string, agentId: string): AgentFacts | AddonRefused {
    const agent = deps.agent(userId, agentId)
    return agent ?? refused('not_found', ADDON_STATE_TEXT.agentNotFound)
  }

  function setupResult(mcpProviderId: string, setup: McpSetup | null): AddonActionResult {
    return { ok: true, next: setup?.next ?? null, mcpProviderId, ...(setup?.message ? { message: setup.message } : {}) }
  }

  async function attachLocal(userId: string, agentId: string, mcpProviderId: string): Promise<AddonActionResult> {
    deps.attachMcp(userId, agentId, mcpProviderId)
    return setupResult(mcpProviderId, deps.mcpSetup(userId, mcpProviderId))
  }

  /** The agent's skill access, read only for a kit agent (the others cannot pin at all). */
  async function skillAccessOf(userId: string, agentId: string, agent: AgentFacts): Promise<SkillAccess> {
    return agent.kit ? deps.skillAccess(userId, agentId) : null
  }

  /** Why this entry cannot be added here (a plugin's runtimes or the policy, a local MCP server's), or null. */
  async function blockOf(userId: string, entry: ProviderEntry): Promise<string | null> {
    if (entry.status !== 'ready') return null
    if (entry.kind === 'plugin' && deps.pluginBlock) return deps.pluginBlock(userId, entry).catch(() => null)
    if (isLocalMcpEntry(entry) && deps.mcpBlock) return deps.mcpBlock(userId, entry).catch(() => null)
    return null
  }

  /** Each plugin and local MCP entry with why it cannot be added here, asked once per read. */
  async function withPluginBlocks(userId: string, entries: ProviderEntry[]): Promise<ProviderEntry[]> {
    if (!deps.pluginBlock && !deps.mcpBlock) return entries
    return Promise.all(
      entries.map(async (entry) => {
        const reason = await blockOf(userId, entry)
        return reason ? { ...entry, blockReason: reason } : entry
      })
    )
  }

  /** Write the requirement after an MCP add; a failure never fails the add. */
  async function noted(userId: string, agentId: string, agent: AgentFacts, result: AddonActionResult, ref: AddonRef | null, auth?: McpServerAuth): Promise<AddonActionResult> {
    if (result.ok && result.mcpProviderId && agent.kit && deps.noteMcpRequirement) {
      await deps.noteMcpRequirement(userId, agentId, result.mcpProviderId, ref, ...(auth ? [auth] : [])).catch(() => undefined)
    }
    return result
  }

  function pinned(outcome: PinOutcome): AddonActionResult {
    return outcome.ok ? { ok: true, next: null } : refused(outcome.code, outcome.message)
  }

  return {
    /** `refresh`: the sources re-read what they cache (the picker's once-per-opening read). */
    async list(userId: string, agentId: string, options: { refresh?: boolean } = {}): Promise<AddonDirectoryResult> {
      try {
        const agent = agentOf(userId, agentId)
        if ('ok' in agent) return agent
        // In turn, not together: the access check reads the listing a refreshing read has just replaced.
        const { entries, sources, policy } = await listAll({ settingsUserId: userId, ...(options.refresh ? { refresh: true } : {}) })
        const access = await skillAccessOf(userId, agentId, agent)
        const attached = new Set(deps.attachedMcp(userId, agentId))
        const checked = await withPluginBlocks(userId, entries)
        return { ok: true, entries: checked.map((entry) => toAgentEntry(entry, agent, attached, access)), sources, policy }
      } catch (err) {
        return refusalOf(err)
      }
    },

    /** The search-only sources (the official MCP registry); a result that is a local provider shows as that provider. */
    async search(userId: string, agentId: string, query: string): Promise<AddonSearchResult> {
      try {
        const agent = agentOf(userId, agentId)
        if ('ok' in agent) return agent
        const ctx = { settingsUserId: userId }
        const policy = policyOf(userId)
        const searchers = deps.providers.filter((provider) => provider.search && allowed(provider, policy))
        const answers = await Promise.all(searchers.map((provider) => read(provider, () => provider.search!(ctx, query))))
        const found = answers.flatMap((answer) => answer.entries)
        remember(found)
        const localProvider = ownerOf({ source: LOCAL_SOURCE, id: '' })
        const locals = localProvider ? (await read(localProvider, () => localProvider.list(ctx))).entries : []
        const localByRef = new Map<string, ProviderEntry>()
        for (const local of locals) if (local.registryRef) localByRef.set(addonRefKey(local.registryRef), local)
        const attached = new Set(deps.attachedMcp(userId, agentId))
        const entries = found.map((entry) => {
          const local = localByRef.get(addonRefKey(entry.ref))
          return toAgentEntry(local ? mergedLocal({ ...local, provider: localProvider?.id }, entry) : entry, agent, attached, null)
        })
        return { ok: true, entries, sources: answers.map((answer) => answer.source) }
      } catch (err) {
        return refusalOf(err)
      }
    },

    async add(userId: string, agentId: string, ref: AddonRef): Promise<AddonActionResult> {
      try {
        const agent = agentOf(userId, agentId)
        if ('ok' in agent) return agent
        if (ref.source === CATALOG_SOURCE) return pinned(await deps.addCatalogSkill(userId, agentId, ref.id))
        if (ref.source === MARKETPLACE_SOURCE) return pinned(await deps.addMarketplaceSkill(userId, agentId, ref.id))
        if (ref.source === PLUGIN_SOURCE) {
          if (!deps.addPlugin) return refused('unsupported', ADDON_STATE_TEXT.unsupported)
          const outcome = await deps.addPlugin(userId, agentId, ref.id)
          if (!outcome.ok) return refused(outcome.code, outcome.message)
          return { ok: true, next: outcome.next, ...(outcome.starting?.length ? { starting: outcome.starting } : {}) }
        }
        if (ref.source === LOCAL_SOURCE) return await noted(userId, agentId, agent, await attachLocal(userId, agentId, ref.id), null)

        const provider = ownerOf(ref)
        if (!provider) return refused('not_found', ADDON_STATE_TEXT.notFound)
        if (!allowed(provider, policyOf(userId))) return refused('blocked', ADDON_STATE_TEXT.gated)
        const existing = deps.findMcpByRef(userId, ref)
        if (existing) return await noted(userId, agentId, agent, await attachLocal(userId, agentId, existing), ref)
        const entry = await directoryEntry({ settingsUserId: userId }, ref)
        if (!entry) return refused('not_found', ADDON_STATE_TEXT.notFound)
        if (entry.kind === 'plugin') return refused('unsupported', ADDON_STATE_TEXT.unsupported)
        if (entry.status === 'pending') return refused('preparing', ADDON_STATE_TEXT.preparing)
        if (entry.kind !== 'mcp' || entry.status === 'unsupported' || !entry.install || !('mcp' in entry.install)) {
          return refused('unsupported', ADDON_STATE_TEXT.unsupported)
        }
        // The same server is already on this computer (typed in, or from the opencinna list): attach it, never a second one.
        const same = ref.source === CORE_MCP_SOURCE && deps.findMcpByServer ? deps.findMcpByServer(userId, entry) : null
        // Core's MCP directory states its auth; a public registry may not declare a sign-in it needs.
        const auth = ref.source === CORE_MCP_SOURCE ? requirementAuth(entry.install.mcp) : undefined
        if (same) return await noted(userId, agentId, agent, await attachLocal(userId, agentId, same), ref, auth)
        const block = await blockOf(userId, entry)
        if (block) return refused('blocked', block)
        const created = await deps.createMcpFromDirectory(userId, entry)
        try {
          deps.attachMcp(userId, agentId, created.id)
        } catch (err) {
          // Nothing the user asked for is left behind: the connector made for this add goes with it.
          await deps.deleteMcp(userId, created.id).catch(() => undefined)
          throw err
        }
        return await noted(userId, agentId, agent, setupResult(created.id, created.setup), ref, auth)
      } catch (err) {
        return refusalOf(err)
      }
    },

    /** Unpin or detach. What this agent does not have is a no-op; a local provider is detached, never deleted. */
    async remove(userId: string, agentId: string, ref: AddonRef): Promise<AddonActionResult> {
      try {
        const agent = agentOf(userId, agentId)
        if ('ok' in agent) return agent
        const id = ref.id.toLowerCase()
        if (ref.source === CATALOG_SOURCE) {
          const pin = agent.skills.find((skill) => skill.source === 'catalog' && skill.packageUuid?.toLowerCase() === id)
          return pin ? pinned(await deps.removeCatalogSkill(userId, agentId, pin.name)) : { ok: true, next: null }
        }
        if (ref.source === MARKETPLACE_SOURCE) {
          const pin = agent.skills.find((skill) => skill.source === 'marketplace' && skill.entryUuid?.toLowerCase() === id)
          return pin ? pinned(await deps.removeMarketplaceSkill(userId, agentId, pin.name)) : { ok: true, next: null }
        }
        if (ref.source === PLUGIN_SOURCE) {
          const pin = (agent.plugins ?? []).find((plugin) => plugin.entryUuid.toLowerCase() === id)
          return pin && deps.removePlugin ? pinned(await deps.removePlugin(userId, agentId, pin.name)) : { ok: true, next: null }
        }
        const mcpProviderId = ref.source === LOCAL_SOURCE ? ref.id : deps.findMcpByRef(userId, ref)
        // The manifest's requirement goes first (it names the directory ref, which a local ref is resolved to).
        if (agent.kit && deps.dropMcpRequirement) await deps.dropMcpRequirement(userId, agentId, ref).catch(() => undefined)
        if (!mcpProviderId) return { ok: true, next: null }
        await deps.detachMcp(userId, agentId, mcpProviderId)
        return { ok: true, next: null, mcpProviderId }
      } catch (err) {
        return refusalOf(err)
      }
    },

    /**
     * Where each of a kit agent's `mcp_servers[]` requirements stands on this
     * computer: `ready` — a local provider made from its directory entry is
     * attached and needs nothing; `needs_setup` — that provider still needs
     * a step, is not attached, or does not exist yet (then `entryRef` is the
     * directory entry to set it up from); `unavailable` — no source the
     * account may use lists it any more. A requirement with no ref is a
     * custom connector: set up by hand.
     */
    async mcpRequirements(userId: string, agentId: string): Promise<AddonMcpRequirementsResult> {
      try {
        const agent = agentOf(userId, agentId)
        if ('ok' in agent) return agent
        const requirements = agent.kit ? (agent.mcpServers ?? []) : []
        if (requirements.length === 0) return { ok: true, items: [] }
        const attached = new Set(deps.attachedMcp(userId, agentId))
        let listed: Promise<{ entries: ProviderEntry[]; sources: AddonSourceStatus[]; policy: AddonPolicy }> | null = null
        const listing = () => (listed ??= listAll({ settingsUserId: userId }))
        const items: AddonMcpRequirement[] = []
        for (const requirement of requirements) {
          const base = {
            name: typeof requirement?.name === 'string' ? requirement.name : '',
            transport: requirement?.transport === 'http' || requirement?.transport === 'sse' ? requirement.transport : ('stdio' as const)
          }
          const ref = isAddonRef(requirement?.ref) ? { source: requirement.ref.source, id: requirement.ref.id } : null
          if (!ref) {
            items.push({ ...base, ref: null, state: 'needs_setup', reason: MCP_REQUIREMENT_TEXT.custom, mcpProviderId: null, entryRef: null })
            continue
          }
          const local = deps.findMcpByRef(userId, ref)
          if (local) {
            const entryRef = { source: LOCAL_SOURCE, id: local }
            if (!attached.has(local)) {
              items.push({ ...base, ref, state: 'needs_setup', reason: MCP_REQUIREMENT_TEXT.notAttached, mcpProviderId: local, entryRef })
              continue
            }
            const setup = deps.mcpSetup(userId, local)
            items.push({
              ...base,
              ref,
              state: setup ? 'needs_setup' : 'ready',
              reason: setup ? MCP_REQUIREMENT_TEXT.step[setup.next] : null,
              mcpProviderId: local,
              entryRef
            })
            continue
          }
          const owner = ownerOf(ref)
          const { entries, sources, policy } = await listing()
          const key = addonRefKey(ref)
          if (!owner || !allowed(owner, policy)) {
            items.push({ ...base, ref, state: 'unavailable', reason: owner ? ADDON_STATE_TEXT.gated : MCP_REQUIREMENT_TEXT.unavailable, mcpProviderId: null, entryRef: null })
            continue
          }
          let entry = entries.find((candidate) => addonRefKey(candidate.ref) === key) ?? null
          if (!entry && owner.find) entry = await owner.find({ settingsUserId: userId }, ref).catch(() => null)
          if (entry) {
            remember([{ ...entry, provider: owner.id }])
            items.push({ ...base, ref, state: 'needs_setup', reason: MCP_REQUIREMENT_TEXT.needsSetup, mcpProviderId: null, entryRef: ref })
            continue
          }
          // Its source did not answer: nothing says it is gone, so it is offered as it was.
          const failed = sources.some((source) => source.id === owner.id && source.error)
          items.push(
            failed
              ? { ...base, ref, state: 'needs_setup', reason: MCP_REQUIREMENT_TEXT.unchecked, mcpProviderId: null, entryRef: ref }
              : { ...base, ref, state: 'unavailable', reason: MCP_REQUIREMENT_TEXT.unavailable, mcpProviderId: null, entryRef: null }
          )
        }
        return { ok: true, items }
      } catch (err) {
        return refusalOf(err)
      }
    }
  }
}

/** A directory MCP entry that runs a local process. */
export function isLocalMcpEntry(entry: Pick<ProviderEntry, 'kind' | 'install'>): boolean {
  return entry.kind === 'mcp' && !!entry.install && 'mcp' in entry.install && entry.install.mcp.transport === 'stdio'
}

export type AddonDirectory = ReturnType<typeof createAddonDirectory>
