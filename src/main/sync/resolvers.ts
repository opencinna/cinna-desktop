import { chatModeRepo } from '../db/chatModes'
import { agentRepo, type AgentRow } from '../db/agents'
import { mcpProviderRepo, type McpProviderRow } from '../db/mcpProviders'
import { getSettingsScopeUserId } from '../auth/scope'
import { getCinnaServerUrl } from '../services/cinnaApiService'
import {
  agentIdentityKey,
  mcpIdentityKey,
  mcpRowToDescriptor,
  modeKey,
  normalizeUrl
} from './identity'
import { createLogger } from '../logger/logger'
import type { JobDepDescriptor, JobSyncManifest } from '../../shared/sync'

const logger = createLogger('sync-resolvers')

/**
 * Descriptor → local-id resolution for the sync apply path (plan:
 * data-sync-portable-deps §4). For server-backed dependencies (remote/cinna
 * agents) the identity is the backend UUID — the same on every device on that
 * account, so the happy path is zero-prompt. For local-power-user deps (local
 * A2A agents, MCP providers) we match by connection identity and, on a miss,
 * auto-create a **disabled** setup shell in Default Scope so the dependency
 * isn't silently lost and the user can finish setup.
 *
 * Safety: auto-created rows are NEVER enabled/connected (defense-in-depth
 * against an attacker-shaped stdio `command`), and secrets never sync — only
 * connection coords + display name + env *key names*.
 */

export interface ResolveCache {
  /** mcpIdentityKey → providerId, so N jobs needing the same MCP create it once. */
  createdMcp: Map<string, string>
  /** agentIdentityKey → agentId, same dedupe for local agent shells. */
  createdAgent: Map<string, string>
}

export function newResolveCache(): ResolveCache {
  return { createdMcp: new Map(), createdAgent: new Map() }
}

/** Best-effort Cinna server URL for a profile; null when not a Cinna profile. */
export function profileServerUrl(userId: string): string | null {
  try {
    return getCinnaServerUrl(userId)
  } catch {
    return null
  }
}

/**
 * Resolve a chat mode by portable name (case-insensitive). Falls back to the
 * profile's default mode, then null. Modes live in Default Scope.
 */
export function resolveMode(name: string | null): string | null {
  if (!name) return null
  const scope = getSettingsScopeUserId()
  const modes = chatModeRepo.list(scope)
  const want = modeKey(name)
  const exact = modes.find((m) => modeKey(m.name) === want)
  if (exact) return exact.id
  return modes.find((m) => m.isDefault)?.id ?? null
}

/**
 * Resolve a remote agent by its server-stable backend UUID among the profile's
 * synced remote agents. Guards on the recorded server URL so an agent from a
 * server this profile isn't on stays unresolved (never mis-binds). No
 * auto-create — remote agents come from the backend listing, not the client.
 */
export function resolveRemoteAgent(
  profileUserId: string,
  desc: Extract<JobDepDescriptor, { kind: 'agent'; source: 'remote' }>,
  serverUrl: string | null
): string | null {
  if (desc.serverUrl && serverUrl && normalizeUrl(desc.serverUrl) !== normalizeUrl(serverUrl)) {
    return null // foreign-server agent — leave unresolved (grey in the UI).
  }
  const want = agentIdentityKey(desc)
  const match = agentRepo.listRemote(profileUserId).find((a) => {
    if (!a.remoteTargetType || !a.remoteTargetId) return false
    return (
      agentIdentityKey({
        kind: 'agent',
        source: 'remote',
        remoteTargetType: a.remoteTargetType,
        remoteTargetId: a.remoteTargetId
      }) === want
    )
  })
  return match?.id ?? null
}

/**
 * Resolve a local A2A agent by card URL in Default Scope; on a miss auto-create
 * a disabled shell carrying just the card URL (card fetch/token happen when the
 * user enables it).
 */
export function resolveLocalAgent(
  desc: Extract<JobDepDescriptor, { kind: 'agent'; source: 'local' }>,
  cache: ResolveCache
): string {
  const want = agentIdentityKey(desc)
  const cached = cache.createdAgent.get(want)
  if (cached) return cached
  const scope = getSettingsScopeUserId()
  const match = agentRepo.list(scope).find((a) => {
    if (a.source !== 'local') return false
    const cardUrl = a.cardUrl ?? a.endpointUrl
    return !!cardUrl && agentIdentityKey({ kind: 'agent', source: 'local', cardUrl }) === want
  })
  if (match) return match.id
  const created = agentRepo.create(scope, {
    name: desc.name?.trim() || 'Synced agent',
    protocol: 'a2a',
    cardUrl: desc.cardUrl,
    enabled: false,
    createdBySync: true
  })
  logger.info('auto-created disabled local agent from sync', { agentId: created.id })
  cache.createdAgent.set(want, created.id)
  return created.id
}

/**
 * Resolve an MCP provider by connection identity in Default Scope; on a miss
 * auto-create a disabled, not-connected provider from the coords. Env values /
 * auth tokens never sync, so the shell starts credential-less.
 */
export function resolveMcp(
  desc: Extract<JobDepDescriptor, { kind: 'mcp' }>,
  cache: ResolveCache
): string {
  const want = mcpIdentityKey(desc)
  const cached = cache.createdMcp.get(want)
  if (cached) return cached
  const scope = getSettingsScopeUserId()
  const match = mcpProviderRepo
    .list(scope)
    .find((p) => mcpIdentityKey(mcpRowToDescriptor(p)) === want)
  if (match) return match.id
  const res = mcpProviderRepo.upsert(scope, {
    name: desc.name?.trim() || 'Synced MCP',
    transportType: desc.transport,
    command: desc.command ?? null,
    args: desc.args ?? null,
    url: desc.url ?? null,
    env: null,
    enabled: false,
    createdBySync: true
  })
  logger.info('auto-created disabled MCP provider from sync', { providerId: res.id })
  cache.createdMcp.set(want, res.id)
  return res.id
}

/**
 * Pre-built in-memory resolution index for a profile — lets the job *list*
 * compute a "needs setup" badge per job without an O(jobs × deps) storm of
 * per-dependency table scans. Build it ONCE, then test each manifest against it.
 */
export interface ResolveIndex {
  /** mcpIdentityKey → enabled. */
  mcp: Map<string, boolean>
  /** local agentIdentityKey → enabled. */
  localAgent: Map<string, boolean>
  /** remote agentIdentityKeys present for the profile. */
  remoteAgent: Set<string>
  /** normalized chat-mode names available in Default Scope. */
  modeNames: Set<string>
  hasDefaultMode: boolean
}

export function buildResolveIndex(profileUserId: string): ResolveIndex {
  const settingsScope = getSettingsScopeUserId()
  const mcp = new Map<string, boolean>()
  for (const p of mcpProviderRepo.list(settingsScope)) {
    mcp.set(mcpIdentityKey(mcpRowToDescriptor(p)), p.enabled)
  }
  const localAgent = new Map<string, boolean>()
  for (const a of agentRepo.list(settingsScope)) {
    if (a.source !== 'local') continue
    const cardUrl = a.cardUrl ?? a.endpointUrl
    if (!cardUrl) continue
    localAgent.set(agentIdentityKey({ kind: 'agent', source: 'local', cardUrl }), a.enabled)
  }
  const remoteAgent = new Set<string>()
  for (const a of agentRepo.listRemote(profileUserId)) {
    if (!a.remoteTargetType || !a.remoteTargetId) continue
    remoteAgent.add(
      agentIdentityKey({
        kind: 'agent',
        source: 'remote',
        remoteTargetType: a.remoteTargetType,
        remoteTargetId: a.remoteTargetId
      })
    )
  }
  const modes = chatModeRepo.list(settingsScope)
  const modeNames = new Set(modes.map((m) => modeKey(m.name)))
  const hasDefaultMode = modes.some((m) => m.isDefault)
  return { mcp, localAgent, remoteAgent, modeNames, hasDefaultMode }
}

/**
 * Does a job's manifest have any dependency that isn't fully resolved on this
 * device (missing/disabled MCP or local agent, foreign remote agent, or an
 * absent mode with no default to substitute)? Cheap — pure map lookups.
 */
export function manifestNeedsSetup(
  manifest: JobSyncManifest | null,
  idx: ResolveIndex
): boolean {
  if (!manifest) return false
  if (manifest.modeName) {
    const ok = idx.modeNames.has(modeKey(manifest.modeName)) || idx.hasDefaultMode
    if (!ok) return true
  }
  for (const desc of manifest.deps) {
    if (desc.kind === 'mcp') {
      if (idx.mcp.get(mcpIdentityKey(desc)) !== true) return true
    } else if (desc.source === 'remote') {
      if (!idx.remoteAgent.has(agentIdentityKey(desc))) return true
    } else {
      if (idx.localAgent.get(agentIdentityKey(desc)) !== true) return true
    }
  }
  return false
}

/** Find an existing MCP provider matching a descriptor (no auto-create). */
export function findMcp(
  desc: Extract<JobDepDescriptor, { kind: 'mcp' }>
): McpProviderRow | null {
  const want = mcpIdentityKey(desc)
  return (
    mcpProviderRepo
      .list(getSettingsScopeUserId())
      .find((p) => mcpIdentityKey(mcpRowToDescriptor(p)) === want) ?? null
  )
}

/** Find an existing local A2A agent matching a descriptor (no auto-create). */
export function findLocalAgent(
  desc: Extract<JobDepDescriptor, { kind: 'agent'; source: 'local' }>
): AgentRow | null {
  const want = agentIdentityKey(desc)
  return (
    agentRepo.list(getSettingsScopeUserId()).find((a) => {
      if (a.source !== 'local') return false
      const cardUrl = a.cardUrl ?? a.endpointUrl
      return !!cardUrl && agentIdentityKey({ kind: 'agent', source: 'local', cardUrl }) === want
    }) ?? null
  )
}
