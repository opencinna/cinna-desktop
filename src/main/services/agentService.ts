import { net } from 'electron'
import { agentRepo, AgentRow, RemoteTarget } from '../db/agents'
import { userRepo } from '../db/users'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import {
  fetchAgentCard,
  resolveProtocol,
  type ProtocolResolution
} from '../agents/a2a-client'
import { AgentError } from '../errors'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { createLogger } from '../logger/logger'
import type { AgentCard } from '../agents/a2a-client'

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
  remoteMetadata: Record<string, unknown> | null
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
}

export const agentService = {
  list(userId: string): AgentDto[] {
    return agentRepo.list(userId).map(toDto)
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
    const { card, protocol } = await fetchAgentCard(agent.cardUrl, accessToken)

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
    const { protocol } = await fetchAgentCard(agent.cardUrl, accessToken)
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
   */
  async resolveAccessToken(userId: string, agent: AgentRow): Promise<string | undefined> {
    if (agent.source === 'remote') {
      try {
        return await getCinnaAccessToken(userId)
      } catch {
        throw new Error('Cinna session expired — please re-authenticate')
      }
    }
    return agent.accessTokenEncrypted ? decryptApiKey(agent.accessTokenEncrypted) : undefined
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
          ...t.metadata
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
