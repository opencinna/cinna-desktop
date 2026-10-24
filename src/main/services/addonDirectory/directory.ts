/**
 * The addon directory for one agent: merges every directory provider's
 * entries, folds a local MCP provider made from a directory entry into that
 * entry (shown once, as "On this computer"), and marks each entry with where
 * it stands for the agent. Add and Remove dispatch to the paths each kind
 * already has (catalog / marketplace skill pins, MCP attach).
 *
 * Pure over its {@link AddonDirectoryDeps}, so the merge, the states and the
 * dispatch are tested with fakes; `index.ts` wires the real services.
 * Every answer is data; nothing a caller can cause is thrown.
 */

import {
  DEFAULT_ADDON_POLICY,
  addonRefKey,
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
import type { DirectoryContext, DirectoryProvider, ProviderEntry, ProviderListing } from './types'

export const LOCAL_SOURCE = 'this-computer'
export const CATALOG_SOURCE = 'core-catalog'
export const MARKETPLACE_SOURCE = 'core-marketplace'

export const ADDON_STATE_TEXT = {
  added: 'Added to this agent',
  addedNeeds: (need: string) => `Added — ${need.charAt(0).toLowerCase()}${need.slice(1)}`,
  preparing: 'Being prepared on the server',
  unsupported: 'The server could not prepare it for adding',
  plugin: 'Plugins arrive in a later update',
  needsKit: 'Needs a cinna-agent.json',
  gated: 'Turned off for your account by your admin',
  notFound: 'This addon is no longer listed',
  agentNotFound: 'This agent is not on this computer any more'
} as const

/** What the directory needs to know about the agent. Null: not a folder agent in this scope. */
export interface AgentFacts {
  /** A kit agent (has a `cinna-agent.json`): it can pin skills. */
  kit: boolean
  skills: Pick<LocalAgentSkill, 'source' | 'name' | 'packageUuid' | 'entryUuid'>[]
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
  /** Throws a `DomainError` (`not_found`) for an agent or provider outside the scope. */
  attachMcp(userId: string, agentId: string, mcpProviderId: string): void
  detachMcp(userId: string, agentId: string, mcpProviderId: string): void
  /** The step a local provider still needs before it connects unattended, or null. */
  mcpSetup(userId: string, mcpProviderId: string): McpSetup | null
  /** The local provider created from this directory entry, if any. */
  findMcpByRef(userId: string, ref: AddonRef): string | null
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
 * The only de-duplication: a local provider whose `registry_ref` names an
 * entry another source lists takes that entry's place. Everything else shows
 * once per source, even when two sources hold the same name.
 */
export function mergeLocalProviders(entries: ProviderEntry[]): ProviderEntry[] {
  const directory = new Map<string, ProviderEntry>()
  for (const entry of entries) if (entry.ref.source !== LOCAL_SOURCE) directory.set(addonRefKey(entry.ref), entry)
  const consumed = new Set<string>()
  const merged = entries.map((entry) => {
    if (entry.ref.source !== LOCAL_SOURCE || !entry.registryRef) return entry
    const key = addonRefKey(entry.registryRef)
    const from = directory.get(key)
    if (!from) return entry
    consumed.add(key)
    return mergedLocal(entry, from)
  })
  return merged.filter((entry) => entry.ref.source === LOCAL_SOURCE || !consumed.has(addonRefKey(entry.ref)))
}

function isAdded(entry: ProviderEntry, agent: AgentFacts, attached: ReadonlySet<string>): boolean {
  if (entry.mcpProviderId) return attached.has(entry.mcpProviderId)
  const id = entry.ref.id.toLowerCase()
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
  if (entry.kind === 'plugin') return { state: 'blocked', stateReason: ADDON_STATE_TEXT.plugin }
  if (entry.kind === 'skill' && !agent.kit) return { state: 'blocked', stateReason: ADDON_STATE_TEXT.needsKit }
  if (entry.kind === 'skill' && skillAccess) return { state: 'blocked', stateReason: skillAccess }
  if (entry.setupReason) return { state: 'addable_with_setup', stateReason: entry.setupReason }
  return { state: 'addable', stateReason: null }
}

function toAgentEntry(entry: ProviderEntry, agent: AgentFacts, attached: ReadonlySet<string>, skillAccess: SkillAccess): AgentDirectoryEntry {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { registryRef, setupReason, setupStep, mcpProviderId, provider, ...shared } = entry
  return {
    ...shared,
    provider: provider ?? '',
    ...stateOf(entry, agent, attached, skillAccess),
    ...(mcpProviderId ? { mcpProviderId } : {}),
    ...(mcpProviderId && setupStep ? { setupStep } : {})
  }
}

export function createAddonDirectory(deps: AddonDirectoryDeps) {
  /** Core's last policy per settings scope; the default until core sends one. */
  const policies = new Map<string, AddonPolicy>()
  /** Entries only a search found (the official registry), so a detail read or an add can name them. */
  const searched = new Map<string, ProviderEntry>()

  const policyOf = (userId: string): AddonPolicy => policies.get(userId) ?? DEFAULT_ADDON_POLICY
  const allowed = (provider: DirectoryProvider, policy: AddonPolicy): boolean => !provider.gate || policy[provider.gate]
  const ownerOf = (ref: AddonRef): DirectoryProvider | undefined => deps.providers.find((provider) => provider.owns(ref))

  async function read(
    provider: DirectoryProvider,
    run: () => Promise<ProviderListing>
  ): Promise<{ entries: ProviderEntry[]; source: AddonSourceStatus; policy?: AddonPolicy }> {
    try {
      const listing = await run()
      return {
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
    const ungated = deps.providers.filter((provider) => !provider.gate)
    const first = await Promise.all(ungated.map((provider) => read(provider, () => provider.list(ctx))))
    const sent = first.find((answer) => answer.policy)?.policy
    if (sent) policies.set(ctx.settingsUserId, sent)
    const policy = policyOf(ctx.settingsUserId)
    const gated = deps.providers.filter((provider) => provider.gate && allowed(provider, policy))
    const second = await Promise.all(gated.map((provider) => read(provider, () => provider.list(ctx))))
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
        return { ok: true, entries: entries.map((entry) => toAgentEntry(entry, agent, attached, access)), sources, policy }
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
        if (ref.source === LOCAL_SOURCE) return await attachLocal(userId, agentId, ref.id)

        const provider = ownerOf(ref)
        if (!provider) return refused('not_found', ADDON_STATE_TEXT.notFound)
        if (!allowed(provider, policyOf(userId))) return refused('blocked', ADDON_STATE_TEXT.gated)
        const existing = deps.findMcpByRef(userId, ref)
        if (existing) return await attachLocal(userId, agentId, existing)
        const entry = await directoryEntry({ settingsUserId: userId }, ref)
        if (!entry) return refused('not_found', ADDON_STATE_TEXT.notFound)
        if (entry.kind === 'plugin') return refused('blocked', ADDON_STATE_TEXT.plugin)
        if (entry.status === 'pending') return refused('preparing', ADDON_STATE_TEXT.preparing)
        if (entry.kind !== 'mcp' || entry.status === 'unsupported' || !entry.install || !('mcp' in entry.install)) {
          return refused('unsupported', ADDON_STATE_TEXT.unsupported)
        }
        const created = await deps.createMcpFromDirectory(userId, entry)
        try {
          deps.attachMcp(userId, agentId, created.id)
        } catch (err) {
          // Nothing the user asked for is left behind: the connector made for this add goes with it.
          await deps.deleteMcp(userId, created.id).catch(() => undefined)
          throw err
        }
        return setupResult(created.id, created.setup)
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
        const mcpProviderId = ref.source === LOCAL_SOURCE ? ref.id : deps.findMcpByRef(userId, ref)
        if (!mcpProviderId) return { ok: true, next: null }
        deps.detachMcp(userId, agentId, mcpProviderId)
        return { ok: true, next: null, mcpProviderId }
      } catch (err) {
        return refusalOf(err)
      }
    }
  }
}

export type AddonDirectory = ReturnType<typeof createAddonDirectory>
