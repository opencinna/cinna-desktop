import { net } from 'electron'
import { agentRepo, agentOverrideRepo, AgentRow, RemoteTarget } from '../db/agents'
import { userRepo } from '../db/users'
import { encryptApiKey } from '../security/keystore'
import { fetchAgentCard, resolveProtocol, type ProtocolResolution } from '../agents/a2a-client'
import { resolveAccessToken, rethrowAsReauthIfCinna401 } from '../agents/drivers/a2aConnection'
import { capabilitiesFor } from '../agents/drivers/capabilities'
import { driverOfRow } from '../agents/drivers/driverOf'
import type { AgentCapabilities, AgentDriverId, AgentReadiness } from '../../shared/agentDrivers'
import { agentReadinessService } from './agentReadinessService'
import { AgentError, CinnaApiError } from '../errors'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { cinnaFetch } from './cinna-http'
import { createLogger } from '../logger/logger'
import type { AgentCard } from '../agents/a2a-client'
import type {
  RemoteAgentMetadata,
  CinnaMcpDescriptor,
  BundleVersionInfo
} from '../../shared/agentMetadata'
import { extractCliCommands, type CliCommand } from '../../shared/cliCommands'
import { FOLDER_AGENT_ID_PREFIX } from '../../shared/localAgents'
import { getLayoutView } from '../kit/contractStore'
import { readCommandCatalog } from '../kit/validator'
import { localAgentService } from './localAgents/localAgentService'

const logger = createLogger('agents')

/** UUID v1–v5 form. Bounds remote target_id so we don't accept arbitrary strings. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const REMOTE_ID_PREFIX = 'remote:'

/**
 * Folder agents. Machine-local like a hand-added A2A agent, so they live in the
 * **default / settings scope** and follow every profile — the prefix exists to
 * say "sync does not own this, and neither does a card URL", not to pick a
 * different scope. There is no `scope` column; scope is derived from
 * `userId` + `source`.
 */
const FOLDER_ID_PREFIX = FOLDER_AGENT_ID_PREFIX

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
  /**
   * Folder agents only: the absolute path of the agent folder on this machine.
   * Not a secret — the user chose the folder and the agent page shows it — but
   * it is the only filesystem path in this DTO, so nothing else may be added
   * here without the same reasoning.
   */
  localPath: string | null
  /** Folder agents only: the `agent_roots` row the folder was scanned from. */
  localRootId: string | null
  /**
   * Which driver runs this agent. `source` above says who owns the row; this
   * says how it runs.
   */
  driver: AgentDriverId
  /**
   * What the agent can do, from its driver. A surface that needs to decide
   * behaviour — whether to offer an attach, where `/` commands come from —
   * asks this rather than comparing `source`.
   */
  capabilities: AgentCapabilities
  /**
   * Whether the agent can take a turn right now — its driver's last answer, or
   * null when it has not been checked yet (which never blocks a send). Merged
   * at mapping time from `agentReadinessService`; a list never waits on a probe.
   */
  readiness: AgentReadiness | null
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
    localPath: row.localPath,
    localRootId: row.localRootId,
    driver: driverOfRow(row),
    capabilities: capabilitiesFor(row),
    readiness: agentReadinessService.peek(row.id),
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
  /** The agent's `cinna.mcp` descriptor (agents-as-MCP wrapper). */
  mcp?: CinnaMcpDescriptor
  /** Installed-vs-latest bundle version state (consumer installs only). */
  bundle_version?: BundleVersionInfo | null
}

export const agentService = {
  /**
   * Local agents — hand-added A2A (`source: 'local'`) and folder agents
   * (`source: 'folder'`), both in the shared default scope — plus the active
   * profile's remote agents. When the active profile is the default user, the
   * merge collapses to a single `list(defaultUserId)` call. Remote agents have
   * their `enabled` flag overlaid from {@link agentOverrideRepo} so the user's
   * manual toggle wins.
   */
  listMerged(defaultUserId: string, profileUserId: string): AgentDto[] {
    // Folder agents share the default scope with hand-added A2A agents; both
    // are properties of this machine, not of the signed-in account.
    const local = agentRepo
      .list(defaultUserId)
      .filter((a) => a.source === 'local' || a.source === 'folder')
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

    // The list answers with what readiness already knows and asks for the rest
    // in the background: an A2A agent's answer is a card fetch, and a list must
    // never wait on one. Each row is checked in the scope it was listed from.
    agentReadinessService.kick([
      ...local.map((row) => ({ userId: defaultUserId, row })),
      ...remote.map((row) => ({ userId: profileUserId, row }))
    ])

    return [...local, ...remote].map(toDto)
  },

  /**
   * Resolve an agent across the dual scopes used by the new chat surface:
   * remote agents live in the active profile, everything else — hand-added A2A
   * agents and folder agents alike — in the default (shared) scope. Returns the
   * row plus the userId that owns it so callers can pass it into the
   * user-scoped service methods.
   */
  findAgent(
    defaultUserId: string,
    profileUserId: string,
    agentId: string
  ): { row: AgentRow; userId: string } | null {
    // Three id shapes, two scopes. `remote:` is sync-owned and profile-bound;
    // `folder:` (a folder agent) and a bare nanoid (a hand-added A2A agent) are
    // both properties of this machine and resolve in the default scope.
    const userId = agentId.startsWith(REMOTE_ID_PREFIX) ? profileUserId : defaultUserId
    const row = agentRepo.getOwned(userId, agentId)
    return row ? { row, userId } : null
  },

  /**
   * Toggle the enabled flag for an agent. Default-scope agents — hand-added A2A
   * and folder agents — update the row directly; remote (sync-managed) agents
   * write to the per-profile {@link agentOverrideRepo} so the manual choice
   * survives subsequent syncs.
   *
   * A folder agent's row is otherwise a derived index that a rescan rebuilds,
   * so this flag is the one column the scanner must never overwrite — see
   * `agentRepo.replaceFolderIndex`.
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
      // A switched-off agent is not probed; its last answer would only go stale.
      if (!enabled) agentReadinessService.forget(agentId)
      logger.info('agent enabled flag set', { agentId, enabled, scope: 'override' })
      return
    }
    const existing = agentRepo.getOwned(defaultUserId, agentId)
    if (!existing) throw new AgentError('not_found', 'Agent not found')
    agentRepo.update(defaultUserId, agentId, { enabled })
    if (!enabled) agentReadinessService.forget(agentId)
    logger.info('agent enabled flag set', {
      agentId,
      enabled,
      scope: existing.source === 'folder' ? 'folder' : 'local'
    })
  },

  /**
   * Create or update an agent. Renderer-supplied ids starting with `remote:` or
   * `folder:` are rejected — sync owns the first, and the folder on disk owns
   * the second (a folder agent is edited through `local-agent:update-field`,
   * which writes the files the row is derived from). A provided id that doesn't
   * match a row for this user returns `not_found` without leaking whether it
   * exists elsewhere.
   */
  upsert(userId: string, input: UpsertAgentInput): { id: string; dto: AgentDto } {
    if (input.id?.startsWith(REMOTE_ID_PREFIX)) {
      throw new AgentError('invalid_id', 'Remote agents cannot be modified manually')
    }
    if (input.id?.startsWith(FOLDER_ID_PREFIX)) {
      throw new AgentError(
        'invalid_id',
        'Local agents are edited through their folder, not this form'
      )
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
    if (existing.source === 'folder') {
      // Deleting the row would only make the next scan re-create it: the folder
      // is the agent. Removing one means removing (or unregistering) the folder.
      throw new AgentError(
        'folder_immutable',
        'Local agents are their folder on disk — delete the folder, or remove its agents folder'
      )
    }
    agentRepo.delete(userId, agentId)
    agentReadinessService.forget(agentId)
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

    const accessToken = await resolveAccessToken(userId, agent)
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
   * The composer's `/` popup and the agent page's Commands card, for a folder
   * agent: `docs/CLI_COMMANDS.yaml`, read fresh (no cache — the file is on
   * disk and can change under an open chat the same way any other kit file
   * can) and mapped into the same {@link CliCommand} shape the remote-agent
   * branch below returns, so neither `useCliCommands` nor `CliCommandPopup`
   * needs to know which kind of agent it is looking at. `command` is always
   * `/run:<name>` — the exact reference grammar `commandService.matchRunCommand`
   * (main-side) and `validateAgentFolder` (`status_refresh_command`) both
   * check against, so an entry this returns is always runnable.
   *
   * Never throws: a locate failure (folder moved, root gone) or an unreadable
   * catalog is exactly the state `readCommandCatalog` itself already treats
   * as "nothing to show" rather than an error — this is a low-stakes fetch
   * backing a popup, not a page that should show a fault for it.
   */
  listFolderCliCommands(userId: string, agentId: string): CliCommand[] {
    try {
      const { root, agentDir } = localAgentService.locate(userId, agentId)
      const layout = getLayoutView(root.path)
      const catalog = readCommandCatalog(agentDir, layout.layout.agent.command_catalog)
      return catalog.commands.map((command) => ({
        slug: command.name,
        name: command.name,
        description: command.description,
        command: `/run:${command.name}`
      }))
    } catch (err) {
      logger.warn('folder agent CLI commands could not be read', { agentId, error: String(err) })
      return []
    }
  },

  /**
   * Fetch the agent card fresh and extract CLI command skills
   * (`cinna.run.*` / `tags: ["cinna-run"]`). Returns [] for non-A2A agents or
   * agents without a card URL. Does not persist — the card cache is driven by
   * `testAgent`.
   *
   * A folder agent is dispatched to {@link listFolderCliCommands} — its own
   * branch, not folded in here, because it reads a file rather than making a
   * network call and has nothing in common with the reauth/fetch machinery
   * below.
   */
  async listCliCommands(userId: string, agentId: string): Promise<CliCommand[]> {
    const agent = agentRepo.getOwned(userId, agentId)
    if (!agent) throw new AgentError('not_found', 'Agent not found')
    const { commands: source } = capabilitiesFor(agent)
    if (source === 'catalog') return this.listFolderCliCommands(userId, agentId)
    if (source !== 'card' || agent.protocol !== 'a2a' || !agent.cardUrl) return []
    const accessToken = await resolveAccessToken(userId, agent)
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
          ...(t.mcp ? { cinna_mcp: t.mcp } : {}),
          // Installed-vs-latest version state — drives the in-app Update
          // affordance on the Catalog card and Agents list. Omit the key
          // entirely when absent so older servers don't write a null over a
          // previously-synced value mid-rollout.
          ...(t.bundle_version ? { bundle_version: t.bundle_version } : {})
        }
      })
    }

    logger.info(`fetched ${targets.length} remote agents from ${baseUrl}`)
    const result = agentRepo.syncRemote(userId, targets)
    if (result.removed > 0) {
      logger.info(`removed ${result.removed} stale remote agents`)
    }
    return result
  },

  /**
   * Apply the latest bundle revision to an installed agent via the native
   * client surface — `POST /api/v1/external/agents/{installId}/apply-update`.
   * cinna-server stops the environment, swaps in the new revision's bundle
   * folders, restarts, and refreshes prompts; per-bundle App Data and
   * credentials are preserved. Returns the post-update `BundleVersionInfo`
   * snapshot so the caller can refresh its UI without a second round-trip.
   *
   * `installId` is the cinna-server Agent UUID — i.e. the catalog entry's
   * `userInstallId` or a synced agent's `remoteTargetId`. Routes through the
   * shared {@link cinnaFetch} so auth, error mapping (401/403 →
   * `CinnaApiError('reauth_required')`, surfaced to the IPC layer as a re-auth
   * chip), and latency logging match every other Cinna call.
   */
  async applyBundleUpdate(userId: string, installId: string): Promise<BundleVersionInfo> {
    // Fail fast on a malformed id before it reaches the request URL — the
    // server owner-gates and validates too, but this keeps the boundary tight.
    if (!UUID_RE.test(installId)) {
      throw new AgentError('invalid_id', `Invalid install id: ${installId}`)
    }
    logger.info('apply bundle update start', { installId })
    const started = Date.now()
    try {
      const bundleVersion = await cinnaFetch<BundleVersionInfo>(
        userId,
        `/api/v1/external/agents/${encodeURIComponent(installId)}/apply-update`,
        { method: 'POST', body: {} }
      )
      logger.info('apply bundle update done', {
        installId,
        installedRevision: bundleVersion.installed_revision_number,
        latestRevision: bundleVersion.latest_revision_number,
        durationMs: Date.now() - started
      })
      return bundleVersion
    } catch (err) {
      const code = err instanceof CinnaApiError ? err.code : undefined
      logger.warn('apply bundle update failed', {
        installId,
        code,
        durationMs: Date.now() - started
      })
      throw err
    }
  }
}

export { CinnaReauthRequired, resolveProtocol }
