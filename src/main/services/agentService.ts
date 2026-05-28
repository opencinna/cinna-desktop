import { net } from 'electron'
import { agentRepo, agentOverrideRepo, AgentRow, RemoteTarget } from '../db/agents'
import { userRepo } from '../db/users'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import {
  fetchAgentCard,
  resolveProtocol,
  AgentCardFetchError,
  A2aHttpError,
  type ProtocolResolution
} from '../agents/a2a-client'
import { AgentError } from '../errors'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { createLogger } from '../logger/logger'
import type { AgentCard } from '../agents/a2a-client'
import type { RemoteAgentMetadata, CinnaMcpDescriptor } from '../../shared/agentMetadata'
import { extractCliCommands, type CliCommand } from '../../shared/cliCommands'

const logger = createLogger('agents')

/** UUID v1–v5 form. Bounds remote target_id so we don't accept arbitrary strings. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const REMOTE_ID_PREFIX = 'remote:'

export interface AgentDto {
  id: string
  name: string
  description: string | null
  protocol: string
  cardUrl: string | null
  endpointUrl: string | null
  protocolInterfaceUrl: string | null
  protocolInterfaceVersion: string | null
  hasAccessToken: boolean
  cardData: Record<string, unknown> | null
  skills: Array<{ id: string; name: string; description?: string }> | null
  enabled: boolean
  source: string
  remoteTargetType: string | null
  remoteTargetId: string | null
  remoteMetadata: RemoteAgentMetadata | null
  createdAt: Date
}

export interface UpsertAgentInput {
  id?: string
  name: string
  description?: string
  protocol: string
  cardUrl?: string
  endpointUrl?: string
  protocolInterfaceUrl?: string
  protocolInterfaceVersion?: string
  accessToken?: string
  cardData?: Record<string, unknown>
  skills?: Array<{ id: string; name: string; description?: string }>
  enabled?: boolean
}

export interface FetchCardInput {
  cardUrl: string
  accessToken?: string
}

export interface SyncRemoteResult {
  synced: number
  removed: number
}

function toDto(row: AgentRow): AgentDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    protocol: row.protocol,
    cardUrl: row.cardUrl,
    endpointUrl: row.endpointUrl,
    protocolInterfaceUrl: row.protocolInterfaceUrl,
    protocolInterfaceVersion: row.protocolInterfaceVersion,
    hasAccessToken: !!row.accessTokenEncrypted,
    cardData: row.cardData,
    skills: row.skills,
    enabled: row.enabled,
    source: row.source,
    remoteTargetType: row.remoteTargetType,
    remoteTargetId: row.remoteTargetId,
    remoteMetadata: row.remoteMetadata,
    createdAt: row.createdAt
  }
}

function skillsFromCard(
  card: AgentCard
): Array<{ id: string; name: string; description?: string }> | null {
  if (!card.skills) return null
  return card.skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description
  }))
}

/**
 * Remote (Cinna-backed) agents authenticate against the agent card endpoint
 * with a Cinna-issued JWT. A 401/403 means the server has invalidated that
 * JWT (token revoked, replay detected, account suspended) even though the
 * desktop's local copy may still appear valid — surface this as a
 * `CinnaReauthRequired` so the renderer's reauth chip kicks in.
 *
 * Two paths can produce the typed status:
 *  - `A2aHttpError` from `buildLoggingFetch` (intercepts 401/403 before
 *    the SDK / `fetchRawCard` wraps the response)
 *  - `AgentCardFetchError` from `fetchRawCard` (other non-OK statuses on
 *    the card endpoint — kept for symmetry; 401/403 won't reach it because
 *    the fetch layer throws `A2aHttpError` first)
 *
 * Local (manually-added) A2A agents use a user-supplied static token; a
 * 401/403 from them just means the configured token is wrong, with no
 * in-app reauth flow — propagate the original error unchanged.
 */
function rethrowAsReauthIfCinna401(err: unknown, agent: AgentRow): never {
  if (agent.source === 'remote') {
    const status =
      err instanceof A2aHttpError
        ? err.status
        : err instanceof AgentCardFetchError
          ? err.status
          : undefined
    if (status === 401 || status === 403) {
      throw new CinnaReauthRequired(
        `Cinna server rejected the agent card request (${status}). Re-authentication required.`,
        { cause: err as Error }
      )
    }
  }
  throw err
}

function synthesizeRemoteSkills(
  examplePrompts: string[]
): Array<{ id: string; name: string; description?: string }> | null {
  if (examplePrompts.length === 0) return null
  return examplePrompts.slice(0, 5).map((prompt, i) => ({
    id: `example-${i}`,
    name: prompt.length > 50 ? prompt.slice(0, 47) + '...' : prompt,
    description: prompt
  }))
}

/** Shape of a target returned by GET /api/v1/external/agents */
interface ExternalTarget {
  target_type: string
  target_id: string
  name: string
  description: string | null
  entrypoint_prompt: string | null
  example_prompts: string[]
  session_mode: string | null
  ui_color_preset: string | null
  agent_card_url: string
  protocol_versions: string[]
  metadata: Record<string, unknown>
  /** The agent's `cinna.mcp` descriptor (agents-as-MCP wrapper). */
  mcp?: CinnaMcpDescriptor
}

export const agentService = {
  /**
   * Local agents (shared, default scope) + the active profile's remote agents.
   * When the active profile is the default user, the merge collapses to a
   * single `list(defaultUserId)` call. Remote agents have their `enabled` flag
   * overlaid from {@link agentOverrideRepo} so the user's manual toggle wins.
   */
  listMerged(defaultUserId: string, profileUserId: string): AgentDto[] {
    const local = agentRepo.list(defaultUserId).filter((a) => a.source === 'local')
    const remoteRows =
      profileUserId === defaultUserId
        ? agentRepo.list(defaultUserId).filter((a) => a.source === 'remote')
        : agentRepo.list(profileUserId).filter((a) => a.source === 'remote')

    const overrides = new Map(
      agentOverrideRepo.listForUser(profileUserId).map((o) => [o.agentId, o.enabled])
    )
    const remote = remoteRows.map((row) => {
      const override = overrides.get(row.id)
      return override === undefined ? row : { ...row, enabled: override }
    })

    return [...local, ...remote].map(toDto)
  },

  /**
   * Resolve an agent across the dual scopes used by the new chat surface:
   * remote agents live in the active profile, everything else in the default
   * (shared) scope. Returns the row plus the userId that owns it so callers
   * can pass it into the user-scoped service methods.
   */
  findAgent(
    defaultUserId: string,
    profileUserId: string,
    agentId: string
  ): { row: AgentRow; userId: string } | null {
    if (agentId.startsWith(REMOTE_ID_PREFIX)) {
      const row = agentRepo.getOwned(profileUserId, agentId)
      return row ? { row, userId: profileUserId } : null
    }
    const row = agentRepo.getOwned(defaultUserId, agentId)
    return row ? { row, userId: defaultUserId } : null
  },

  /**
   * Toggle the enabled flag for an agent. Local (default-scope) agents update
   * the row directly; remote (sync-managed) agents write to the per-profile
   * {@link agentOverrideRepo} so the manual choice survives subsequent syncs.
   */
  setEnabled(
    defaultUserId: string,
    profileUserId: string,
    agentId: string,
    enabled: boolean
  ): void {
    if (agentId.startsWith(REMOTE_ID_PREFIX)) {
      const row = agentRepo.getOwned(profileUserId, agentId)
      if (!row) throw new AgentError('not_found', 'Agent not found')
      agentOverrideRepo.set(profileUserId, agentId, enabled)
      logger.info('agent enabled flag set', { agentId, enabled, scope: 'override' })
      return
    }
    const existing = agentRepo.getOwned(defaultUserId, agentId)
    if (!existing) throw new AgentError('not_found', 'Agent not found')
    agentRepo.update(defaultUserId, agentId, { enabled })
    logger.info('agent enabled flag set', { agentId, enabled, scope: 'local' })
  },

  /**
   * Create or update an agent. Renderer-supplied ids starting with `remote:`
   * are rejected — sync owns those. A provided id that doesn't match a row for
   * this user returns `not_found` without leaking whether it exists elsewhere.
   */
  upsert(userId: string, input: UpsertAgentInput): { id: string; dto: AgentDto } {
    if (input.id?.startsWith(REMOTE_ID_PREFIX)) {
      throw new AgentError('invalid_id', 'Remote agents cannot be modified manually')
    }

    if (input.id) {
      const existing = agentRepo.getOwned(userId, input.id)
      if (!existing) {
        throw new AgentError('not_found', 'Agent not found')
      }
      const accessTokenEncrypted = input.accessToken
        ? encryptApiKey(input.accessToken)
        : existing.accessTokenEncrypted
      const updated = agentRepo.update(userId, input.id, {
        name: input.name,
        description: input.description ?? existing.description,
        protocol: input.protocol,
        cardUrl: input.cardUrl ?? existing.cardUrl,
        endpointUrl: input.endpointUrl ?? existing.endpointUrl,
        protocolInterfaceUrl: input.protocolInterfaceUrl ?? existing.protocolInterfaceUrl,
        protocolInterfaceVersion:
          input.protocolInterfaceVersion ?? existing.protocolInterfaceVersion,
        accessTokenEncrypted,
        cardData: input.cardData ?? existing.cardData,
        skills: input.skills ?? existing.skills,
        enabled: input.enabled ?? existing.enabled
      })
      if (!updated) throw new AgentError('not_found', 'Agent not found')
      return { id: updated.id, dto: toDto(updated) }
    }

    const row = agentRepo.create(userId, {
      name: input.name,
      description: input.description ?? null,
      protocol: input.protocol,
      cardUrl: input.cardUrl ?? null,
      endpointUrl: input.endpointUrl ?? null,
      protocolInterfaceUrl: input.protocolInterfaceUrl ?? null,
      protocolInterfaceVersion: input.protocolInterfaceVersion ?? null,
      accessTokenEncrypted: input.accessToken ? encryptApiKey(input.accessToken) : null,
      cardData: input.cardData ?? null,
      skills: input.skills ?? null,
      enabled: input.enabled ?? true
    })
    logger.info('agent created', { agentId: row.id, protocol: row.protocol })
    return { id: row.id, dto: toDto(row) }
  },

  delete(userId: string, agentId: string): void {
    const existing = agentRepo.getOwned(userId, agentId)
    if (!existing) {
      throw new AgentError('not_found', 'Agent not found')
    }
    if (existing.source === 'remote') {
      throw new AgentError(
        'remote_immutable',
        'Remote agents cannot be deleted — they are managed by Cinna sync'
      )
    }
    agentRepo.delete(userId, agentId)
    logger.info('agent deleted', { agentId })
  },

  /** Fetch an agent card from a URL — used by the "add agent" form, no userId needed. */
  async fetchCardPreview(
    input: FetchCardInput
  ): Promise<{ card: AgentCard; protocol: ProtocolResolution }> {
    return fetchAgentCard(input.cardUrl, input.accessToken)
  },

  /**
   * Test a saved agent: fetches its card, updates cached card data + resolved
   * protocol, and returns the card.
   */
  async testAgent(
    userId: string,
    agentId: string
  ): Promise<{ card: AgentCard; protocol: ProtocolResolution }> {
    const agent = agentRepo.getOwned(userId, agentId)
    if (!agent) throw new AgentError('not_found', 'Agent not found')
    if (agent.protocol !== 'a2a') {
      throw new AgentError('unsupported_protocol', `Unsupported protocol: ${agent.protocol}`)
    }
    if (!agent.cardUrl) {
      throw new AgentError('no_card_url', 'No card URL configured')
    }

    const accessToken = await this.resolveAccessToken(userId, agent)
    let card: AgentCard
    let protocol: ProtocolResolution
    try {
      ;({ card, protocol } = await fetchAgentCard(agent.cardUrl, accessToken))
    } catch (err) {
      rethrowAsReauthIfCinna401(err, agent)
    }

    agentRepo.updateCardCache(userId, agentId, {
      cardData: card as unknown as Record<string, unknown>,
      skills: skillsFromCard(card),
      endpointUrl: protocol.url,
      protocolInterfaceUrl: protocol.url,
      protocolInterfaceVersion: protocol.version
    })

    logger.info('agent test ok', { agentId, protocolVersion: protocol.version })
    return { card, protocol }
  },

  /**
   * If the agent has no resolved endpoint, auto-resolve one for remote agents
   * by fetching the card. Local agents must be tested first — their card URL
   * may require a user-supplied access token we haven't been given yet.
   * Caches the resolution so subsequent messages skip this step.
   */
  async resolveEndpointIfNeeded(userId: string, agent: AgentRow): Promise<string> {
    const existing = agent.protocolInterfaceUrl ?? agent.endpointUrl
    if (existing) return existing

    if (agent.source !== 'remote' || !agent.cardUrl) {
      throw new AgentError(
        'no_endpoint',
        'No compatible protocol endpoint resolved. Test the agent connection first.'
      )
    }

    const accessToken = await this.resolveAccessToken(userId, agent)
    let protocol: ProtocolResolution
    try {
      ;({ protocol } = await fetchAgentCard(agent.cardUrl, accessToken))
    } catch (err) {
      rethrowAsReauthIfCinna401(err, agent)
    }
    agentRepo.updateResolvedEndpoint(userId, agent.id, {
      endpointUrl: protocol.url,
      protocolInterfaceUrl: protocol.url,
      protocolInterfaceVersion: protocol.version
    })
    logger.info('agent endpoint auto-resolved', {
      agentId: agent.id,
      endpointUrl: protocol.url
    })
    return protocol.url
  },

  /**
   * Resolve the access token for an agent.
   * Remote agents use the user's Cinna JWT; local agents use the decrypted stored token.
   *
   * Lets `CinnaReauthRequired` bubble so callers can render an actionable
   * "Re-authenticate" affordance instead of a generic error string.
   */
  async resolveAccessToken(userId: string, agent: AgentRow): Promise<string | undefined> {
    if (agent.source === 'remote') {
      return getCinnaAccessToken(userId)
    }
    return agent.accessTokenEncrypted ? decryptApiKey(agent.accessTokenEncrypted) : undefined
  },

  /**
   * Fetch the agent card fresh and extract CLI command skills
   * (`cinna.run.*` / `tags: ["cinna-run"]`). Returns [] for non-A2A agents or
   * agents without a card URL. Does not persist — the card cache is driven by
   * `testAgent`.
   */
  async listCliCommands(userId: string, agentId: string): Promise<CliCommand[]> {
    const agent = agentRepo.getOwned(userId, agentId)
    if (!agent) throw new AgentError('not_found', 'Agent not found')
    if (agent.protocol !== 'a2a' || !agent.cardUrl) return []
    const accessToken = await this.resolveAccessToken(userId, agent)
    const started = Date.now()
    let card: AgentCard
    try {
      ;({ card } = await fetchAgentCard(agent.cardUrl, accessToken))
    } catch (err) {
      rethrowAsReauthIfCinna401(err, agent)
    }
    const commands = extractCliCommands((card as unknown as { skills?: unknown }).skills)
    logger.info('CLI commands fetched', {
      agentId,
      count: commands.length,
      durationMs: Date.now() - started
    })
    return commands
  },

  /**
   * Sync remote agents from the Cinna backend for a user.
   * Filters out unknown target types and invalid target ids before delegating
   * the transactional upsert/prune to `agentRepo.syncRemote`.
   *
   * Re-throws {@link CinnaReauthRequired} so callers (periodic loop) can stop.
   */
  async syncRemoteAgents(userId: string): Promise<SyncRemoteResult> {
    const user = userRepo.get(userId)
    if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) {
      return { synced: 0, removed: 0 }
    }

    const accessToken = await getCinnaAccessToken(userId)

    const baseUrl = user.cinnaServerUrl.replace(/\/$/, '')
    const response = await net.fetch(`${baseUrl}/api/v1/external/agents`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    })
    if (!response.ok) {
      throw new AgentError(
        'sync_failed',
        `Backend returned ${response.status} ${response.statusText}`
      )
    }
    const data = (await response.json()) as { targets?: ExternalTarget[] }
    const rawTargets = data.targets ?? []

    const validTypes = new Set(['agent', 'app_mcp_route', 'identity'])
    const targets: RemoteTarget[] = []
    for (const t of rawTargets) {
      if (!validTypes.has(t.target_type)) {
        logger.warn('skipping target with unknown type', {
          targetType: t.target_type,
          targetId: t.target_id
        })
        continue
      }
      if (!UUID_RE.test(t.target_id)) {
        logger.warn('skipping target with invalid target_id', {
          targetType: t.target_type,
          targetId: t.target_id
        })
        continue
      }
      targets.push({
        targetType: t.target_type as RemoteTarget['targetType'],
        targetId: t.target_id,
        name: t.name,
        description: t.description,
        cardUrl: t.agent_card_url,
        skills: synthesizeRemoteSkills(t.example_prompts ?? []),
        metadata: {
          entrypoint_prompt: t.entrypoint_prompt,
          example_prompts: t.example_prompts,
          session_mode: t.session_mode,
          ui_color_preset: t.ui_color_preset,
          protocol_versions: t.protocol_versions,
          ...t.metadata,
          // Carry the agents-as-MCP descriptor when the backend supplied one.
          // Spread `t.metadata` first so an explicit top-level `mcp` wins over
          // any stray `cinna_mcp` already nested in metadata.
          ...(t.mcp ? { cinna_mcp: t.mcp } : {})
        }
      })
    }

    logger.info(`fetched ${targets.length} remote agents from ${baseUrl}`)
    const result = agentRepo.syncRemote(userId, targets)
    if (result.removed > 0) {
      logger.info(`removed ${result.removed} stale remote agents`)
    }
    return result
  }
}

export { CinnaReauthRequired, resolveProtocol }
