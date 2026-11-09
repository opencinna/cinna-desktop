/**
 * Dashboards and tiles: CRUD, ordering, limits, and resolving a tile to the
 * component it shows. Dashboards are per profile; the agents whose components
 * they show are folder agents, which live in the default scope.
 *
 * Every outcome is data ({@link DashboardsOutcome}); nothing here throws to a
 * caller for a refusal. The renderer names tiles and components, never paths:
 * a tile references its agent by manifest id and its component by folder
 * name, and both are found again on every read.
 *
 * Core module: no Electron.
 */

import { dirname, isAbsolute, join } from 'node:path'
import { dashboardRepo, type DashboardRow, type DashboardTileRow, isCloudTileRow } from '../../db/dashboards'
import { getSettingsScopeUserId } from '../../auth/scope'
import { createLogger } from '../../logger/logger'
import { localAgentService } from '../localAgents/localAgentService'
import { desktopStateService } from '../localAgents/desktopStateService'
import { kitAgentDeliverableSkills } from '../agentSkillsPlugin'
import { isPinnedSkill, SKILLS_DIR } from '../../kit/skills'
import { COMPONENT_NAME_PATTERN, MIN_WHILE_OPEN_EVERY_MS } from '../../kit/dashboardsProtocol'
import { localScheduleRepo } from '../../db/localSchedules'
import { readAgentManifest, readComponent, scanComponents, type ComponentAgent, type ComponentSkillFolder, type ScannedComponent } from './componentScanner'
import { normalizeTileParams } from './tileParams'
import { MAX_PROMPTS, MAX_PROMPT_LABEL, MAX_PROMPT_TEXT } from '../../kit/dashboardsProtocol'
import { formatComponentReference, parseComponentReference } from '../../../shared/componentReference'
import { coreDashboardsClient } from './remote/coreDashboardsClient'
import { backingDashboards as defaultBacking, transportMessage, refreshToCore, type BackingDashboards } from './remote/backingDashboards'
import { cloudComponentFrom, listCloudAgents, onOtherCoreServer, parseCoreComponent, profileServerUrl, serverHost, type CloudAgent, type CloudComponent } from './remote/cloudComponent'
import type { CloudTileRef } from './remote/remoteTileSource'
import type { CoreComponent, CoreOutcome } from './remote/coreDashboardsClient'
import {
  DASHBOARDS_TILE_CHANGED_CHANNEL,
  MAX_CLOUD_TILES_PER_DASHBOARD,
  MAX_DASHBOARDS_PER_PROFILE,
  TILE_SIZE_SPANS,
  MAX_DASHBOARD_NAME_LENGTH,
  MAX_TILES_PER_DASHBOARD,
  MAX_TILE_OWN_PROMPTS,
  MAX_TILE_TITLE_LENGTH,
  isTileSize,
  isTileSpan,
  parseDuration,
  type AddTileInput,
  type ComponentInfo,
  type ComponentPrompt,
  type ComponentPlacement,
  type ComponentReferenceAgent,
  type ComponentReferenceMiss,
  type ComponentReferenceResolution,
  type DashboardDto,
  type DashboardsErrorCode,
  type DashboardsOutcome,
  type TileDto,
  type TilePlacementSize,
  type TilePromptOverride,
  type TileRefreshOverride,
  type TileScheduleState,
  type TileView,
  type ResolveReferenceOutcome,
  type CloudComponentsOutcome,
  type CloudOrigin,
  type UpdateTileInput,
  CLOUD_CATALOGUE_TTL_MS
} from '../../../shared/dashboards'
import { publishEvent } from '../../host/events'
import type { LocalAgentCredentialState, LocalAgentDto } from '../../../shared/localAgents'

const logger = createLogger('dashboards')

type Refusal = { ok: false; code: DashboardsErrorCode; message: string }
const refuse = (code: DashboardsErrorCode, message: string): Refusal => ({ ok: false, code, message })

/** A local agent that is not a kit agent (a bare folder): a reference to it is `not_kit_agent`. */
export interface OtherAgent {
  id: string
  manifestId: string
  name: string
  slug: string
}

export interface DashboardServiceDeps {
  /** The kit agents on this machine, as the scanner needs them. */
  agents: () => ComponentAgent[]
  /** The other local agents (bare folders), for references only. */
  otherAgents?: () => OtherAgent[]
  /** Whether a manifest schedule runs on this device for the profile, and when next: the local scheduler's opt-in. */
  scheduleOnDevice?: (userId: string, manifestId: string, name: string) => { onThisDevice: boolean; nextRunAt: number | null }
  /** Cloud agents and their server (D6); the real ones when absent. */
  cloud?: CloudDeps
}

/** What the cloud branch (D6) reads and calls. */
export interface CloudDeps {
  /** The profile's synced remote agents that are core agents. */
  agents: (userId: string) => CloudAgent[]
  serverUrl: (userId: string) => string | null
  client: Pick<typeof coreDashboardsClient, 'getComponent' | 'listComponents' | 'addBlock' | 'deleteBlock'> &
    Partial<Pick<typeof coreDashboardsClient, 'resolveRefs'>>
  backing: BackingDashboards
  /**
   * A core session of a chat with this remote agent row (its A2A task id), or
   * null: core matches an `id:`/slug reference against the chat agent's own
   * workspace manifest, which only it can read (D6.8).
   */
  chatCoreSession?: (userId: string, agentRowId: string) => string | null
  /** `DASHBOARDS_TILE_CHANGED_CHANNEL` for a tile whose cached component changed. */
  publish: (tileId: string) => void
  now?: () => number
}

export { CLOUD_CATALOGUE_TTL_MS }

function defaultCloud(): CloudDeps {
  return {
    agents: listCloudAgents,
    serverUrl: profileServerUrl,
    client: coreDashboardsClient,
    backing: defaultBacking,
    chatCoreSession: (userId, agentRowId) => dashboardRepo.latestCoreSessionForAgent(userId, agentRowId),
    publish: (tileId) => publishEvent(DASHBOARDS_TILE_CHANGED_CHANNEL, { tileId })
  }
}

/**
 * The local scheduler's per-device opt-in for an agent's manifest schedule:
 * a binding that is on, and its next due time. Read from the binding only;
 * a definition that changed since it was turned on is turned off by the
 * scheduler's own next pass.
 */
export function scheduleOnDevice(userId: string, manifestId: string, name: string): { onThisDevice: boolean; nextRunAt: number | null } {
  try {
    const binding = localScheduleRepo.list(userId).find((row) => row.manifestId === manifestId && row.name === name && row.definition.executionType !== 'job')
    if (!binding?.enabled || binding.reason) return { onThisDevice: false, nextRunAt: null }
    return { onThisDevice: true, nextRunAt: binding.nextDueAt ?? null }
  } catch (err) {
    logger.debug('could not read a schedule binding', { error: err instanceof Error ? err.message : String(err) })
    return { onThisDevice: false, nextRunAt: null }
  }
}

/** The names of the agent manifest's `schedules[]`, or null when it has no readable manifest. */
function manifestScheduleNames(agent: ComponentAgent): Set<string> | null {
  const manifest = agent.manifest === undefined ? readAgentManifest(agent.path) : agent.manifest
  if (!isRecord(manifest)) return null
  const schedules = Array.isArray(manifest.schedules) ? manifest.schedules : []
  return new Set(schedules.filter(isRecord).map((entry) => entry.name).filter((name): name is string => typeof name === 'string'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether a credential slot is ready for the agent, as the scan judged it
 * (`satisfied`). `satisfied` reads an optional slot as filled whatever it
 * holds; a component that names it in `requires_credentials` needs it filled,
 * so an optional slot is judged by the same rule the scan applies to a
 * required one: its matching attachment's state, else its `.env` names.
 */
export function credentialSlotReady(slot: LocalAgentCredentialState): boolean {
  if (!slot.optional) return slot.satisfied
  if (slot.attachment) return slot.attachment.state === 'ready'
  return slot.expectedKeys.length === 0 ? slot.presentKeys.length > 0 : slot.presentKeys.length === slot.expectedKeys.length
}

/**
 * The agent's bundle id (README §5.5): the manifest's `bundle.bundle_id`
 * (contract 1.19.0 lets a host read it), else `app-data/desktop.json`
 * `shared_remote.bundle_id`. The manifest wins when both exist.
 */
export function agentBundleId(agentDir: string, manifest: unknown): string | null {
  const fromManifest = isRecord(manifest) && isRecord(manifest.bundle) ? manifest.bundle.bundle_id : null
  if (typeof fromManifest === 'string' && fromManifest.trim()) return fromManifest.trim()
  try {
    const shared = desktopStateService.read(agentDir, 'kit').shared_remote?.bundle_id
    return typeof shared === 'string' && shared.trim() ? shared.trim() : null
  } catch {
    return null
  }
}

/**
 * The skills a kit agent resolves and where each folder is: the agent's own
 * `skills/<name>/`, or the read-only catalog, marketplace or plugin cache copy
 * — the set and the folders `agentSkillsPlugin.ts` delivers to every engine.
 */
export function agentSkillFolders(agentDir: string, manifest: unknown): ComponentSkillFolder[] {
  return kitAgentDeliverableSkills(agentDir, manifest).map((skill) => ({
    name: skill.name,
    dir: isPinnedSkill(skill) && isAbsolute(skill.path) ? dirname(skill.path) : join(agentDir, SKILLS_DIR, skill.name)
  }))
}

/** A kit agent of the local agent list as the scanner needs it. */
export function componentAgentFrom(agent: LocalAgentDto): ComponentAgent {
  return {
    id: agent.id,
    manifestId: agent.manifestId,
    name: agent.name,
    path: agent.path,
    rootPath: agent.rootPath,
    slug: agent.slug,
    manifest: agent.manifest,
    credentialSlots: agent.credentials.map((slot) => ({ name: slot.name, ready: credentialSlotReady(slot) })),
    skills: () => agentSkillFolders(agent.path, agent.manifest),
    bundleId: () => agentBundleId(agent.path, agent.manifest)
  }
}

function listAgents(): LocalAgentDto[] {
  try {
    return localAgentService.list(getSettingsScopeUserId()).agents
  } catch (err) {
    logger.warn('could not list the local agents', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

function defaultAgents(): ComponentAgent[] {
  return listAgents()
    .filter((agent) => agent.kind === 'kit')
    .map(componentAgentFrom)
}

function defaultOtherAgents(): OtherAgent[] {
  return listAgents()
    .filter((agent) => agent.kind !== 'kit')
    .map((agent) => ({ id: agent.id, manifestId: agent.manifestId, name: agent.name, slug: agent.slug }))
}

/** A skill as a caller names it: null for the agent's own, a name, or invalid. */
function normalizeSkill(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  return typeof value === 'string' && value.length <= 128 && !/[/\\\0]/.test(value) ? value : 'invalid'
}

function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/\s+/g, ' ').trim()
  if (!name || name.length > max) return null
  return name
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * A refresh override as the user may set it in Edit tile: a max age, Manual,
 * the interval (null turns the component's off; at least 1m), after-turn and
 * on-app-start. Absent fields keep the component's; `false` on a flag is kept,
 * since it overrides a component that says true.
 */
export function normalizeRefreshOverride(value: unknown): TileRefreshOverride | null | 'invalid' {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const input = value as Record<string, unknown>
  const out: TileRefreshOverride = {}
  if (input.maxAge !== undefined && input.maxAge !== null) {
    if (parseDuration(input.maxAge) === null) return 'invalid'
    out.maxAge = String(input.maxAge).trim()
  }
  if (input.manual !== undefined) {
    if (typeof input.manual !== 'boolean') return 'invalid'
    if (input.manual) out.manual = true
  }
  if (input.whileOpenEvery !== undefined) {
    if (input.whileOpenEvery === null) out.whileOpenEvery = null
    else {
      const ms = parseDuration(input.whileOpenEvery)
      if (ms === null || ms < MIN_WHILE_OPEN_EVERY_MS) return 'invalid'
      out.whileOpenEvery = String(input.whileOpenEvery)
    }
  }
  for (const flag of ['afterTurn', 'onAppStart'] as const) {
    if (input[flag] === undefined) continue
    if (typeof input[flag] !== 'boolean') return 'invalid'
    out[flag] = input[flag] as boolean
  }
  return Object.keys(out).length > 0 ? out : null
}

export function toDashboardDto(row: DashboardRow & { tileCount?: number }): DashboardDto {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    tileCount: row.tileCount ?? 0,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime()
  }
}

/**
 * A tile's change to its component's suggested questions, as Edit tile sends
 * it: text trimmed and within the component's own caps, an empty change null.
 */
export function normalizePromptOverride(value: unknown): TilePromptOverride | null | 'invalid' {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const raw = value as Record<string, unknown>
  const question = (entry: unknown): ComponentPrompt | null => {
    if (!entry || typeof entry !== 'object') return null
    const { label, prompt } = entry as Record<string, unknown>
    if (typeof label !== 'string' || typeof prompt !== 'string') return null
    const [cleanLabel, cleanPrompt] = [label.trim(), prompt.trim()]
    if (!cleanLabel || !cleanPrompt || cleanLabel.length > MAX_PROMPT_LABEL || cleanPrompt.length > MAX_PROMPT_TEXT) return null
    return { label: cleanLabel, prompt: cleanPrompt }
  }
  const out: TilePromptOverride = {}
  if (raw.hidden !== undefined) {
    if (!Array.isArray(raw.hidden) || raw.hidden.length > MAX_PROMPTS || raw.hidden.some((label) => typeof label !== 'string')) return 'invalid'
    if (raw.hidden.length > 0) out.hidden = raw.hidden as string[]
  }
  if (raw.edited !== undefined) {
    if (!raw.edited || typeof raw.edited !== 'object' || Array.isArray(raw.edited)) return 'invalid'
    const entries = Object.entries(raw.edited)
    if (entries.length > MAX_PROMPTS) return 'invalid'
    const edited: Record<string, ComponentPrompt> = {}
    for (const [label, entry] of entries) {
      const clean = question(entry)
      if (!clean) return 'invalid'
      edited[label] = clean
    }
    if (entries.length > 0) out.edited = edited
  }
  if (raw.added !== undefined) {
    if (!Array.isArray(raw.added) || raw.added.length > MAX_TILE_OWN_PROMPTS) return 'invalid'
    const added: NonNullable<TilePromptOverride['added']> = []
    for (const entry of raw.added) {
      const clean = question(entry)
      if (!clean) return 'invalid'
      added.push((entry as { hidden?: unknown }).hidden === true ? { ...clean, hidden: true } : clean)
    }
    if (added.length > 0) out.added = added
  }
  return Object.keys(out).length > 0 ? out : null
}

export function toTileDto(row: DashboardTileRow, cloud?: CloudOrigin): TileDto {
  const override = normalizeRefreshOverride(parseJsonObject(row.refreshOverrideJson))
  const prompts = normalizePromptOverride(parseJsonObject(row.promptOverrideJson))
  const customSpan = { cols: row.customCols, rows: row.customRows }
  return {
    id: row.id,
    dashboardId: row.dashboardId,
    agentManifestId: row.agentManifestId,
    ...(cloud ? { cloud } : {}),
    component: row.component,
    skill: row.skill ?? null,
    title: row.title,
    // `custom` only with its cells; a row without them reads as Medium, like any unknown size.
    size: isTileSize(row.size) || (row.size === 'custom' && isTileSpan(customSpan)) ? (row.size as TilePlacementSize) : 'm',
    customSpan: isTileSpan(customSpan) ? customSpan : null,
    position: row.position,
    params: parseJsonObject(row.paramsJson) ?? {},
    refreshOverride: override === 'invalid' ? null : override,
    promptOverride: prompts === 'invalid' ? null : prompts
  }
}

/** A tile with the agent and component behind it, found again now. */
export interface ResolvedTile {
  tile: TileDto
  view: TileView
  agent: ComponentAgent | null
  scanned: ScannedComponent | null
  /**
   * Set for a cloud tile (D6), with what main needs to reach its block; null
   * when it cannot run now (another server, the agent gone, no backing
   * dashboard). Never sent to the renderer.
   */
  cloud?: CloudTileRef | null
}

export function createDashboardService(deps: DashboardServiceDeps = { agents: defaultAgents, otherAgents: defaultOtherAgents }) {
  let cloudDeps: CloudDeps | null = deps.cloud ?? null
  const cloud = (): CloudDeps => (cloudDeps ??= defaultCloud())
  const cloudNow = (): number => (cloud().now ?? Date.now)()
  /** Core agents core said are gone (`not_found`), until a list of theirs works again. */
  const goneCloudAgents = new Set<string>()
  /** Cloud tiles whose component the agent's last list did not have. */
  const missingCloudComponents = new Set<string>()
  /** When each core agent's components were last asked for. */
  const catalogueAskedAt = new Map<string, number>()

  function cloudAgents(userId: string): CloudAgent[] {
    try {
      return cloud().agents(userId)
    } catch (err) {
      logger.warn('could not list the cloud agents', { error: err instanceof Error ? err.message : String(err) })
      return []
    }
  }

  function cloudAgentById(userId: string, agentId: unknown): CloudAgent | null {
    if (typeof agentId !== 'string' || !agentId) return null
    return cloudAgents(userId).find((agent) => agent.id === agentId) ?? null
  }

  /**
   * The component as stored without its placements (they change with every
   * add and say nothing about the component), with the agent's name beside it
   * (`agent_name`, ours, not core's), so a tile still names its agent after the
   * sync removed a deleted agent's row.
   */
  function storedComponent(component: CoreComponent, agentName: string | null): string {
    return JSON.stringify({ ...component, placements: [], ...(agentName ? { agent_name: agentName } : {}) })
  }

  function storedAgentName(core: CoreComponent | null): string | null {
    const name = (core as (CoreComponent & { agent_name?: unknown }) | null)?.agent_name
    return typeof name === 'string' && name ? name : null
  }

  /**
   * An agent's list from core, applied to this profile's cloud tiles of it:
   * a changed component is stored again, a missing one marked, and each
   * changed tile is published. `not_found` marks the agent gone.
   */
  function applyCatalogue(userId: string, remoteAgentId: string, outcome: CoreOutcome<{ components: CoreComponent[] }>): void {
    const rows = dashboardRepo.tilesForRemoteAgent(userId, remoteAgentId).map((entry) => entry.tile)
    const agentName = cloudAgents(userId).find((entry) => entry.remoteTargetId === remoteAgentId)?.name ?? null
    const changed: string[] = []
    if (!outcome.ok) {
      if (outcome.code === 'not_found' && !goneCloudAgents.has(remoteAgentId)) {
        goneCloudAgents.add(remoteAgentId)
        changed.push(...rows.map((row) => row.id))
      }
    } else {
      if (goneCloudAgents.delete(remoteAgentId)) changed.push(...rows.map((row) => row.id))
      const listed = Array.isArray(outcome.value?.components) ? outcome.value.components : []
      for (const row of rows) {
        const found = listed.find((entry) => entry.name === row.component && (entry.skill ?? null) === (row.skill ?? null))
        if (!found) {
          if (!missingCloudComponents.has(row.id)) {
            missingCloudComponents.add(row.id)
            changed.push(row.id)
          }
          continue
        }
        if (missingCloudComponents.delete(row.id)) changed.push(row.id)
        const json = storedComponent(found, agentName ?? storedAgentName(parseCoreComponent(row.cloudComponentJson)))
        if (json !== row.cloudComponentJson) {
          dashboardRepo.updateTile(userId, row.id, { cloudComponentJson: json })
          changed.push(row.id)
        }
      }
    }
    for (const tileId of new Set(changed)) cloud().publish(tileId)
  }

  /** Ask core for an agent's components in the background, at most once per {@link CLOUD_CATALOGUE_TTL_MS}. */
  function refreshCatalogue(userId: string, remoteAgentId: string): void {
    const at = cloudNow()
    const last = catalogueAskedAt.get(remoteAgentId)
    if (last !== undefined && at - last < CLOUD_CATALOGUE_TTL_MS) return
    catalogueAskedAt.set(remoteAgentId, at)
    void cloud()
      .client.listComponents(userId, remoteAgentId)
      .then((outcome) => applyCatalogue(userId, remoteAgentId, outcome))
      .catch((err) => logger.debug('a cloud agent’s components could not be read', { error: err instanceof Error ? err.name : 'error' }))
  }

  /** A cloud tile row with what it shows now, from what main last read; runs and fetches nothing. */
  function resolveCloudRow(userId: string, row: DashboardTileRow, dashboard: DashboardRow | null): ResolvedTile {
    const server = cloud().serverUrl(userId)
    const remoteAgentId = row.remoteAgentId ?? ''
    const origin: CloudOrigin = { remoteAgentId, server: serverHost(dashboard?.coreServer ?? server) }
    const tile = toTileDto(row, origin)
    const agent = cloudAgents(userId).find((entry) => entry.remoteTargetId === remoteAgentId) ?? null
    const core = parseCoreComponent(row.cloudComponentJson)
    const read: CloudComponent | null = core && agent ? cloudComponentFrom(core, agent, origin) : null
    const state: TileView['state'] =
      onOtherCoreServer(dashboard?.coreServer, server)
        ? 'wrong_server'
        : !agent || !agent.owned || goneCloudAgents.has(remoteAgentId)
          ? 'agent_missing'
          : !read || missingCloudComponents.has(row.id)
            ? 'component_missing'
            : read.info.valid
              ? 'ok'
              : 'invalid'
    const displayTitle = tile.title ?? read?.info.title ?? (core?.title || null) ?? tile.component
    const ref: CloudTileRef | null =
      state === 'ok' && dashboard?.coreDashboardId && row.coreBlockId
        ? { tile, coreDashboardId: dashboard.coreDashboardId, coreBlockId: row.coreBlockId, remoteAgentId, agentName: agent!.name, serverUrl: server, spec: read!.spec }
        : null
    return {
      tile,
      agent: null,
      scanned: null,
      cloud: ref,
      view: { tile, displayTitle, state, component: read?.info ?? null, agentName: agent?.name ?? storedAgentName(core), schedule: null }
    }
  }

  function agentById(agentId: unknown): ComponentAgent | null {
    if (typeof agentId !== 'string') return null
    return deps.agents().find((agent) => agent.id === agentId) ?? null
  }

  function agentByManifestId(manifestId: string): ComponentAgent | null {
    if (!manifestId) return null
    const matches = deps.agents().filter((agent) => agent.manifestId === manifestId)
    return matches.length === 1 ? matches[0] : null
  }

  const onDevice = deps.scheduleOnDevice ?? scheduleOnDevice

  /** The schedule that feeds a tile (`refresh.schedule`), as it stands on this device. */
  function scheduleState(userId: string, agent: ComponentAgent | null, scanned: ScannedComponent | null): TileScheduleState | null {
    const name = scanned?.spec?.schedule
    if (!agent || !name) return null
    const exists = manifestScheduleNames(agent)?.has(name) ?? false
    const device = exists && agent.manifestId ? onDevice(userId, agent.manifestId, name) : { onThisDevice: false, nextRunAt: null }
    return { name, exists, onThisDevice: device.onThisDevice, nextRunAt: device.onThisDevice ? device.nextRunAt : null }
  }

  function resolveRow(userId: string, row: DashboardTileRow, dashboard?: DashboardRow | null): ResolvedTile {
    if (isCloudTileRow(row)) return resolveCloudRow(userId, row, dashboard === undefined ? dashboardRepo.get(userId, row.dashboardId) : dashboard)
    const tile = toTileDto(row)
    const agent = agentByManifestId(tile.agentManifestId)
    // A skill that is gone reads as a component that is gone.
    const scanned = agent ? readComponent(agent, tile.component, tile.skill) : null
    const state = !agent ? 'agent_missing' : !scanned ? 'component_missing' : scanned.spec ? 'ok' : 'invalid'
    const displayTitle = tile.title ?? scanned?.info.title ?? tile.component
    return { tile, agent, scanned, view: { tile, displayTitle, state, component: scanned?.info ?? null, schedule: scheduleState(userId, agent, scanned) } }
  }

  return {
    list(userId: string): DashboardDto[] {
      return dashboardRepo.list(userId).map(toDashboardDto)
    },

    create(userId: string, name: unknown): DashboardsOutcome<{ dashboard: DashboardDto }> {
      const clean = cleanName(name, MAX_DASHBOARD_NAME_LENGTH)
      if (!clean) return refuse('invalid_input', `A dashboard needs a name of up to ${MAX_DASHBOARD_NAME_LENGTH} characters.`)
      if (dashboardRepo.count(userId) >= MAX_DASHBOARDS_PER_PROFILE) {
        return refuse('limit_reached', `You have ${MAX_DASHBOARDS_PER_PROFILE} dashboards, the most a profile can have. Delete one to make another.`)
      }
      return { ok: true, dashboard: toDashboardDto(dashboardRepo.create(userId, clean)) }
    },

    rename(userId: string, dashboardId: unknown, name: unknown): DashboardsOutcome<{ dashboard: DashboardDto }> {
      const clean = cleanName(name, MAX_DASHBOARD_NAME_LENGTH)
      if (!clean) return refuse('invalid_input', `A dashboard needs a name of up to ${MAX_DASHBOARD_NAME_LENGTH} characters.`)
      if (typeof dashboardId !== 'string' || !dashboardRepo.rename(userId, dashboardId, clean)) return refuse('not_found', 'That dashboard is gone.')
      const row = dashboardRepo.list(userId).find((entry) => entry.id === dashboardId)
      // The backing core dashboard's name follows, without waiting (D6.1).
      if (row?.coreDashboardId) void cloud().backing.renamed(userId, row, clean)
      return row ? { ok: true, dashboard: toDashboardDto(row) } : refuse('not_found', 'That dashboard is gone.')
    },

    delete(userId: string, dashboardId: unknown): DashboardsOutcome<object> {
      const row = typeof dashboardId === 'string' ? dashboardRepo.get(userId, dashboardId) : null
      if (typeof dashboardId !== 'string' || !dashboardRepo.delete(userId, dashboardId)) return refuse('not_found', 'That dashboard is gone.')
      // Its backing core dashboard goes too, without waiting (D6.1).
      if (row?.coreDashboardId) void cloud().backing.deleted(userId, row)
      return { ok: true }
    },

    reorder(userId: string, orderedIds: unknown): DashboardsOutcome<{ dashboards: DashboardDto[] }> {
      if (!Array.isArray(orderedIds) || !orderedIds.every((id) => typeof id === 'string')) return refuse('invalid_input', 'Nothing to reorder.')
      dashboardRepo.reorder(userId, orderedIds as string[])
      return { ok: true, dashboards: this.list(userId) }
    },

    tiles(userId: string, dashboardId: unknown): DashboardsOutcome<{ dashboard: DashboardDto; tiles: TileView[] }> {
      if (typeof dashboardId !== 'string') return refuse('not_found', 'That dashboard is gone.')
      const row = dashboardRepo.list(userId).find((entry) => entry.id === dashboardId)
      if (!row) return refuse('not_found', 'That dashboard is gone.')
      const resolved = dashboardRepo.tiles(userId, dashboardId).map((tile) => resolveRow(userId, tile, row))
      // Cloud tiles draw from what main last read; their agents' lists are read again behind it.
      const askAbout = new Set(
        resolved
          .filter((entry) => entry.tile.cloud && entry.view.state !== 'wrong_server' && entry.view.agentName !== null)
          .map((entry) => entry.tile.cloud!.remoteAgentId)
      )
      for (const remoteAgentId of askAbout) refreshCatalogue(userId, remoteAgentId)
      return { ok: true, dashboard: toDashboardDto(row), tiles: resolved.map((entry) => entry.view) }
    },

    /** A dashboard's tiles, in its order, each with what it shows; [] when the dashboard is not this profile's. */
    resolvedTiles(userId: string, dashboardId: string): ResolvedTile[] {
      const dashboard = dashboardRepo.get(userId, dashboardId)
      return dashboardRepo.tiles(userId, dashboardId).map((row) => resolveRow(userId, row, dashboard))
    },

    /** This profile's cloud tile backed by core block `coreBlockId`, resolved; null when there is none or it cannot run now. */
    resolveCloudBlock(userId: string, coreBlockId: string): CloudTileRef | null {
      const found = dashboardRepo.tileByCoreBlock(userId, coreBlockId)
      return found ? (resolveCloudRow(userId, found.tile, found.dashboard).cloud ?? null) : null
    },

    /** Core's stored params for a cloud tile, kept on its row (a mirror; never sent from here). */
    mirrorCloudParams(userId: string, tileId: string, params: Record<string, unknown>): TileDto | null {
      const existing = dashboardRepo.tile(userId, tileId)
      if (!existing || !isCloudTileRow(existing)) return null
      const json = JSON.stringify(params)
      const row = json === existing.paramsJson ? existing : dashboardRepo.updateTile(userId, tileId, { paramsJson: json })
      return row ? this.resolveTile(userId, tileId)?.tile ?? null : null
    },

    /** One tile and what it shows, or null when the tile is not this profile's. */
    resolveTile(userId: string, tileId: unknown): ResolvedTile | null {
      if (typeof tileId !== 'string') return null
      const row = dashboardRepo.tile(userId, tileId)
      return row ? resolveRow(userId, row) : null
    },

    /**
     * A tile's params from a native filter or `cinna.setParams`: the whole
     * set, each value checked against the component's `params` (a bad one
     * refuses the change, a name it does not declare is dropped, a key left
     * out or null falls back to its default), then kept on the tile in place
     * of the old set. Recomputing is the caller's (the refresh service).
     */
    setParams(userId: string, input: unknown): DashboardsOutcome<{ tile: TileDto }> {
      const value = isRecord(input) ? input : {}
      const resolved = this.resolveTile(userId, value.tileId)
      if (!resolved) return refuse('not_found', 'That tile is gone.')
      // A cloud tile's params are core's: the refresh service sends them (D6.5).
      if (resolved.tile.cloud) return refuse('invalid_input', 'A cloud tile’s params are set on its Cinna server.')
      if (!resolved.scanned?.spec) return refuse('component_invalid', 'This component has problems to fix before its params can change.')
      const merged = normalizeTileParams(value.params, resolved.scanned.spec.params)
      if (!merged.ok) return refuse('invalid_input', merged.message)
      const row = dashboardRepo.updateTile(userId, resolved.tile.id, { paramsJson: JSON.stringify(merged.params) })
      return row ? { ok: true, tile: toTileDto(row) } : refuse('not_found', 'That tile is gone.')
    },

    /** A component of a kit agent, by agent row id, skill (null for its own) and name; null when there is none. */
    resolveComponent(agentId: unknown, component: unknown, skill?: unknown): { agent: ComponentAgent; scanned: ScannedComponent } | null {
      const agent = agentById(agentId)
      const skillName = normalizeSkill(skill)
      if (!agent || skillName === 'invalid' || typeof component !== 'string' || !COMPONENT_NAME_PATTERN.test(component)) return null
      const scanned = readComponent(agent, component, skillName)
      return scanned ? { agent, scanned } : null
    },

    addTile(userId: string, input: unknown): DashboardsOutcome<{ tile: TileDto; dashboard: DashboardDto }> {
      if (!input || typeof input !== 'object') return refuse('invalid_input', 'Nothing to add.')
      const value = input as Partial<AddTileInput>
      const found = this.resolveComponent(value.agentId, value.component, value.skill)
      if (!found) return refuse('not_found', 'That component is no longer in the agent’s folder.')
      if (!found.agent.manifestId) return refuse('needs_identity', 'This agent needs an id first.')
      if (!found.scanned.spec) return refuse('component_invalid', 'This component has problems to fix before it can be added.')
      const title = value.title === undefined || value.title === null ? null : cleanName(value.title, MAX_TILE_TITLE_LENGTH)
      if (value.title && !title) return refuse('invalid_input', `A title has up to ${MAX_TILE_TITLE_LENGTH} characters.`)
      if (value.size !== undefined && !isTileSize(value.size)) return refuse('invalid_input', 'That is not a tile size.')
      const override = normalizeRefreshOverride(value.refreshOverride)
      if (override === 'invalid') return refuse('invalid_input', 'That refresh rule is not valid.')

      let dashboardId = typeof value.dashboardId === 'string' ? value.dashboardId : null
      if (!dashboardId) {
        const created = this.create(userId, value.newDashboardName)
        if (!created.ok) return created
        dashboardId = created.dashboard.id
      } else if (!dashboardRepo.get(userId, dashboardId)) {
        return refuse('not_found', 'That dashboard is gone.')
      }
      if (dashboardRepo.tileCount(dashboardId) >= MAX_TILES_PER_DASHBOARD) {
        return refuse('limit_reached', `This dashboard has ${MAX_TILES_PER_DASHBOARD} tiles, the most it can hold. Remove one, or add this to another dashboard.`)
      }
      const params: Record<string, unknown> = {}
      for (const [name, param] of Object.entries(found.scanned.spec.params)) if (param.default !== undefined) params[name] = param.default
      const row = dashboardRepo.addTile(userId, dashboardId, {
        agentManifestId: found.agent.manifestId,
        component: found.scanned.info.name,
        skill: found.scanned.info.skill,
        // The component's own title is not copied: it follows the component.
        title: title && title !== found.scanned.spec.title ? title : null,
        size: value.size ?? found.scanned.spec.size,
        paramsJson: JSON.stringify(params),
        refreshOverrideJson: override ? JSON.stringify(override) : null
      })
      const dashboard = dashboardRepo.list(userId).find((entry) => entry.id === dashboardId)
      if (!row || !dashboard) return refuse('not_found', 'That dashboard is gone.')
      return { ok: true, tile: toTileDto(row), dashboard: toDashboardDto(dashboard) }
    },

    updateTile(userId: string, input: unknown): DashboardsOutcome<{ tile: TileDto }> {
      if (!input || typeof input !== 'object') return refuse('invalid_input', 'Nothing to change.')
      const value = input as Partial<UpdateTileInput>
      if (typeof value.tileId !== 'string') return refuse('not_found', 'That tile is gone.')
      const patch: Parameters<typeof dashboardRepo.updateTile>[2] = {}
      if (value.title !== undefined) {
        if (value.title === null || value.title === '') patch.title = null
        else {
          const title = cleanName(value.title, MAX_TILE_TITLE_LENGTH)
          if (!title) return refuse('invalid_input', `A title has up to ${MAX_TILE_TITLE_LENGTH} characters.`)
          patch.title = title
        }
      }
      if (value.customSpan !== undefined) {
        if (!isTileSpan(value.customSpan)) return refuse('invalid_input', 'That is not a tile size.')
        patch.customCols = value.customSpan.cols
        patch.customRows = value.customSpan.rows
      }
      if (value.size !== undefined) {
        if (value.size === 'custom') {
          // Custom needs cells: these, or the ones the tile last had.
          if (value.customSpan === undefined) {
            const current = dashboardRepo.tile(userId, value.tileId)
            if (current && !isTileSpan({ cols: current.customCols, rows: current.customRows })) return refuse('invalid_input', 'That is not a tile size.')
          }
        } else if (!isTileSize(value.size)) return refuse('invalid_input', 'That is not a tile size.')
        patch.size = value.size
      }
      if (value.promptOverride !== undefined) {
        const prompts = normalizePromptOverride(value.promptOverride)
        if (prompts === 'invalid') return refuse('invalid_input', `A suggested question needs a label of up to ${MAX_PROMPT_LABEL} characters and text of up to ${MAX_PROMPT_TEXT}.`)
        patch.promptOverrideJson = prompts ? JSON.stringify(prompts) : null
      }
      if (value.refreshOverride !== undefined) {
        const override = normalizeRefreshOverride(value.refreshOverride)
        if (override === 'invalid') return refuse('invalid_input', 'That refresh rule is not valid.')
        patch.refreshOverrideJson = override ? JSON.stringify(override) : null
      }
      const before = dashboardRepo.tile(userId, value.tileId)
      const row = dashboardRepo.updateTile(userId, value.tileId, patch)
      if (!row) return refuse('not_found', 'That tile is gone.')
      if (isCloudTileRow(row)) {
        // The block's title and refresh follow, without waiting (D6.1).
        const dashboard = dashboardRepo.get(userId, row.dashboardId)
        if (dashboard?.coreDashboardId) {
          if (patch.title !== undefined && patch.title !== before?.title) void cloud().backing.titleChanged(userId, dashboard, row)
          if (patch.refreshOverrideJson !== undefined && patch.refreshOverrideJson !== before?.refreshOverrideJson) {
            void cloud().backing.refreshChanged(userId, dashboard, row, toTileDto(row).refreshOverride)
          }
        }
        return { ok: true, tile: resolveRow(userId, row, dashboard).tile }
      }
      return { ok: true, tile: toTileDto(row) }
    },

    moveTile(userId: string, tileId: unknown, toIndex: unknown): DashboardsOutcome<object> {
      if (typeof tileId !== 'string' || typeof toIndex !== 'number' || !Number.isFinite(toIndex)) return refuse('invalid_input', 'Nothing to move.')
      return dashboardRepo.moveTile(userId, tileId, toIndex) ? { ok: true } : refuse('not_found', 'That tile is gone.')
    },

    removeTile(userId: string, tileId: unknown): DashboardsOutcome<object> {
      const row = typeof tileId === 'string' ? dashboardRepo.tile(userId, tileId) : null
      if (typeof tileId !== 'string' || !dashboardRepo.removeTile(userId, tileId)) return refuse('not_found', 'That tile is gone.')
      if ((!!row && isCloudTileRow(row))) {
        missingCloudComponents.delete(row.id)
        // Its block goes too, without waiting (D6.1); the backing dashboard stays.
        const dashboard = dashboardRepo.get(userId, row.dashboardId)
        if (dashboard?.coreDashboardId) void cloud().backing.tileRemoved(userId, dashboard, row)
      }
      return { ok: true }
    },

    /** Core ran a refresh of this cloud tile (its environment is up): an Edit tile change core refused before is sent again. */
    cloudRefreshed(userId: string, tileId: string): void {
      if (!cloud().backing.hasPendingRefresh(tileId)) return
      const row = dashboardRepo.tile(userId, tileId)
      if (!row || !isCloudTileRow(row)) return
      const dashboard = dashboardRepo.get(userId, row.dashboardId)
      if (dashboard) void cloud().backing.resendRefresh(userId, dashboard, row, toTileDto(row).refreshOverride)
    },

    /** The profile's synced cloud agent with this row id, or null. */
    cloudAgent(userId: string, agentId: unknown): CloudAgent | null {
      return cloudAgentById(userId, agentId)
    },

    /** The profile's Cinna server URL now, or null. Main only. */
    serverUrl(userId: string): string | null {
      return cloud().serverUrl(userId)
    },

    /**
     * A cloud agent's component on a dashboard (D6.1): the profile's own agent
     * only (D6.9); read from core; the backing core dashboard made or checked;
     * a block added, then the tile row. A block whose row cannot be written is
     * deleted again. Refusals are data.
     */
    async addCloudTile(userId: string, input: unknown): Promise<DashboardsOutcome<{ tile: TileDto; dashboard: DashboardDto }>> {
      if (!input || typeof input !== 'object') return refuse('invalid_input', 'Nothing to add.')
      const value = input as Partial<AddTileInput>
      const agent = cloudAgentById(userId, value.agentId)
      if (!agent) return refuse('not_found', 'That agent is no longer available.')
      if (!agent.owned) return refuse('not_owner', `Only ${agent.name}’s owner can add its components to a dashboard.`)
      const skill = normalizeSkill(value.skill)
      if (skill === 'invalid' || typeof value.component !== 'string' || !COMPONENT_NAME_PATTERN.test(value.component)) {
        return refuse('not_found', `That component is no longer in ${agent.name}.`)
      }
      const title = value.title === undefined || value.title === null ? null : cleanName(value.title, MAX_TILE_TITLE_LENGTH)
      if (value.title && !title) return refuse('invalid_input', `A title has up to ${MAX_TILE_TITLE_LENGTH} characters.`)
      if (value.size !== undefined && !isTileSize(value.size)) return refuse('invalid_input', 'That is not a tile size.')
      const override = normalizeRefreshOverride(value.refreshOverride)
      if (override === 'invalid') return refuse('invalid_input', 'That refresh rule is not valid.')
      const server = cloud().serverUrl(userId)
      if (!server) return refuse('reauth_required', `Sign in to ${serverHost(null)} again.`)

      // Limits before any call to core.
      const existingId = typeof value.dashboardId === 'string' ? value.dashboardId : null
      if (existingId) {
        const existing = dashboardRepo.get(userId, existingId)
        if (!existing) return refuse('not_found', 'That dashboard is gone.')
        if (existing.coreDashboardId && onOtherCoreServer(existing.coreServer, server)) {
          return refuse('wrong_server', 'This dashboard’s cloud tiles are on another Cinna server. Add this to another dashboard.')
        }
        if (dashboardRepo.tileCount(existingId) >= MAX_TILES_PER_DASHBOARD) {
          return refuse('limit_reached', `This dashboard has ${MAX_TILES_PER_DASHBOARD} tiles, the most it can hold. Remove one, or add this to another dashboard.`)
        }
        if (dashboardRepo.cloudTileCount(existingId) >= MAX_CLOUD_TILES_PER_DASHBOARD) {
          return refuse('limit_reached', `A dashboard holds at most ${MAX_CLOUD_TILES_PER_DASHBOARD} cloud tiles.`)
        }
      } else {
        const clean = cleanName(value.newDashboardName, MAX_DASHBOARD_NAME_LENGTH)
        if (!clean) return refuse('invalid_input', `A dashboard needs a name of up to ${MAX_DASHBOARD_NAME_LENGTH} characters.`)
        if (dashboardRepo.count(userId) >= MAX_DASHBOARDS_PER_PROFILE) {
          return refuse('limit_reached', `You have ${MAX_DASHBOARDS_PER_PROFILE} dashboards, the most a profile can have. Delete one to make another.`)
        }
      }

      const read = await cloud().client.getComponent(userId, agent.remoteTargetId, value.component, skill)
      if (!read.ok) {
        if (read.code === 'not_found') return refuse('not_found', `That component is no longer in ${agent.name}.`)
        if (read.code === 'env_unavailable') return refuse('env_unavailable', `${agent.name}’s environment isn’t running.`)
        if (read.code === 'not_owner') return refuse('not_owner', `Only ${agent.name}’s owner can add its components to a dashboard.`)
        return refuse(read.code, transportMessage(read, server))
      }
      if (read.value.has_errors) return refuse('component_invalid', 'This component has problems to fix before it can be added.')
      const origin: CloudOrigin = { remoteAgentId: agent.remoteTargetId, server: serverHost(server) }
      const component = cloudComponentFrom(read.value, agent, origin)

      // A new dashboard is made only now, and goes again if the add fails.
      let dashboardId = existingId
      let madeHere = false
      if (!dashboardId) {
        const created = this.create(userId, value.newDashboardName)
        if (!created.ok) return created
        dashboardId = created.dashboard.id
        madeHere = true
      }
      // The dashboard made for this add goes again, with the backing core dashboard made for it.
      const undo = (): void => {
        if (!madeHere) return
        const made = dashboardRepo.get(userId, dashboardId!)
        if (made?.coreDashboardId) void cloud().backing.deleted(userId, made)
        dashboardRepo.delete(userId, dashboardId!)
      }
      const backing = await cloud().backing.ensure(userId, dashboardId)
      if (!backing.ok) {
        undo()
        return backing
      }
      const size = value.size ?? component.info.size
      const spans = TILE_SIZE_SPANS[size]
      const keptTitle = title && title !== component.info.title ? title : null
      const addBlock = () =>
        cloud().client.addBlock(userId, backing.coreDashboardId, {
          agentId: agent.remoteTargetId,
          title: keptTitle,
          gridW: spans.cols,
          gridH: spans.rows,
          config: { component: component.info.name, skill: component.info.skill, params: {}, refresh: refreshToCore(override) }
        })
      let block = await addBlock()
      // Core's 20-block cap with fewer tiles here: blocks whose delete never reached core. Clear them and try once more.
      if (!block.ok && block.code === 'limit_reached') {
        const freed = await cloud().backing.deleteOrphanBlocks(userId, dashboardId, backing.coreDashboardId)
        if (freed > 0) block = await addBlock()
      }
      if (!block.ok) {
        undo()
        if (block.code === 'limit_reached') return refuse('limit_reached', `A dashboard holds at most ${MAX_CLOUD_TILES_PER_DASHBOARD} cloud tiles.`)
        return refuse(block.code, transportMessage(block, server))
      }
      let row: DashboardTileRow | null = null
      try {
        row = dashboardRepo.addTile(userId, dashboardId, {
          agentManifestId: '',
          component: component.info.name,
          skill: component.info.skill,
          title: keptTitle,
          size,
          // The owner's values, as core holds them: none yet (core resolves the defaults).
          paramsJson: '{}',
          refreshOverrideJson: override ? JSON.stringify(override) : null,
          source: 'remote',
          remoteAgentId: agent.remoteTargetId,
          coreBlockId: block.value.id,
          cloudComponentJson: storedComponent(read.value, agent.name)
        })
      } catch (err) {
        logger.warn('a cloud tile could not be written', { error: err instanceof Error ? err.message : String(err) })
        row = null
      }
      const dashboard = dashboardRepo.list(userId).find((entry) => entry.id === dashboardId)
      if (!row || !dashboard) {
        void cloud().client.deleteBlock(userId, backing.coreDashboardId, block.value.id).catch(() => {})
        undo()
        return refuse('not_found', 'That dashboard is gone.')
      }
      goneCloudAgents.delete(agent.remoteTargetId)
      return { ok: true, tile: toTileDto(row, origin), dashboard: toDashboardDto(dashboard) }
    },

    /**
     * A cloud agent's components (its Dashboards tab, the Add dialog), from
     * core's list (never wakes anything), with this profile's tiles of them.
     * The tiles' cached components are brought up to date on the way.
     */
    async cloudComponents(userId: string, agentId: unknown): Promise<CloudComponentsOutcome> {
      const agent = cloudAgentById(userId, agentId)
      if (!agent) return refuse('not_found', 'That agent is no longer available.')
      if (!agent.owned) return refuse('not_owner', `Only ${agent.name}’s owner can add its components to a dashboard.`)
      const server = cloud().serverUrl(userId)
      const listed = await cloud().client.listComponents(userId, agent.remoteTargetId)
      catalogueAskedAt.set(agent.remoteTargetId, cloudNow())
      applyCatalogue(userId, agent.remoteTargetId, listed)
      if (!listed.ok) {
        const code = listed.code === 'not_owner' || listed.code === 'unreachable' || listed.code === 'reauth_required' || listed.code === 'not_found' ? listed.code : 'unreachable'
        if (code === 'not_found') return refuse('not_found', `${agent.name} is no longer available.`)
        if (code === 'not_owner') return refuse('not_owner', `Only ${agent.name}’s owner can add its components to a dashboard.`)
        return refuse(code, transportMessage({ ...listed, code }, server))
      }
      const origin: CloudOrigin = { remoteAgentId: agent.remoteTargetId, server: serverHost(server) }
      const components = (Array.isArray(listed.value?.components) ? listed.value.components : []).map((entry) => cloudComponentFrom(entry, agent, origin).info)
      return { ok: true, components, placements: this.placements(userId, agent.id) }
    },

    /** A kit agent's display name, or null when it is not one on this machine. */
    agentName(agentId: unknown): string | null {
      return agentById(agentId)?.name ?? null
    },

    /** Whether `agentId` (a row id) is an agent whose components dashboards show: a kit agent on this machine. */
    isComponentAgent(agentId: unknown): boolean {
      return agentById(agentId) !== null
    },

    /** Whether `agentId` is another local agent (a bare folder), which has no components. */
    isOtherLocalAgent(agentId: unknown): boolean {
      return typeof agentId === 'string' && (deps.otherAgents?.() ?? []).some((agent) => agent.id === agentId)
    },

    /** One agent's components, or every kit agent's. Reading runs nothing. */
    components(agentId?: unknown): ComponentInfo[] {
      if (agentId === undefined || agentId === null) return deps.agents().flatMap((agent) => scanComponents(agent))
      const agent = agentById(agentId)
      return agent ? scanComponents(agent) : []
    },

    /** Where this agent's components (its own and its skills') sit on this profile's dashboards. */
    placements(userId: string, agentId: unknown): ComponentPlacement[] {
      const agent = agentById(agentId)
      const cloudAgent = agent ? null : cloudAgentById(userId, agentId)
      const rows = agent?.manifestId
        ? dashboardRepo.tilesForAgent(userId, agent.manifestId)
        : cloudAgent
          ? dashboardRepo.tilesForRemoteAgent(userId, cloudAgent.remoteTargetId)
          : []
      return rows.map(({ tile, dashboardName }) => ({
        component: tile.component,
        skill: tile.skill ?? null,
        tileId: tile.id,
        dashboardId: tile.dashboardId,
        dashboardName
      }))
    },

    /**
     * A component reference (README §5.5) resolved to a component on this
     * machine or in one of the profile's own cloud agents, or the reason there
     * is none, as data. Main parses the reference again; the chat's own agent
     * (`chatAgentId`, a row id) wins a clash. `bundle:` (D6.8): the chat's own
     * agent, then a local agent, then the profile's own cloud agent with that
     * bundle id; `id:` and slug reach a cloud agent only when it is the chat's
     * own. Reading runs nothing (README D8): a cloud one is core's GET only.
     */
    async resolveReference(userId: string, input: unknown): Promise<ResolveReferenceOutcome> {
      const value = isRecord(input) ? input : {}
      const ref = typeof value.reference === 'string' ? parseComponentReference(value.reference) : null
      if (!ref) return refuse('invalid_input', 'That is not a component reference.')
      const chatAgentId = typeof value.chatAgentId === 'string' ? value.chatAgentId : null
      const miss = (reason: ComponentReferenceMiss, extra: Partial<Extract<ComponentReferenceResolution, { found: false }>> = {}): ResolveReferenceOutcome => ({
        ok: true,
        resolution: { found: false, reason, agentName: null, agentId: null, bundleId: null, ...extra }
      })

      const { kind, value: wanted } = ref.agent
      const clouds = cloudAgents(userId)
      const chatCloud = chatAgentId ? (clouds.find((agent) => agent.id === chatAgentId) ?? null) : null

      const resolveCloud = async (agent: CloudAgent): Promise<ResolveReferenceOutcome> => {
        const named = { agentName: agent.name, agentId: agent.id }
        if (!agent.owned) return miss('not_owner', named)
        const read = await cloud().client.getComponent(userId, agent.remoteTargetId, ref.name, ref.skill)
        if (!read.ok) {
          if (read.code === 'not_found') return miss(kind === 'bundle' ? 'not_in_this_copy' : 'gone', named)
          if (read.code === 'not_owner') return miss('not_owner', named)
          return miss('unreachable', named)
        }
        const server = cloud().serverUrl(userId)
        const found = cloudComponentFrom(read.value, agent, { remoteAgentId: agent.remoteTargetId, server: serverHost(server) })
        const bundleId = kind === 'bundle' ? wanted : agent.bundleId
        return {
          ok: true,
          resolution: {
            found: true,
            component: found.info,
            placements: this.placements(userId, agent.id).filter((p) => p.component === found.info.name && p.skill === found.info.skill),
            canonicalReference: bundleId ? formatComponentReference({ kind: 'bundle', value: bundleId }, found.info.skill, found.info.name) : ref.raw
          }
        }
      }

      // The chat's own cloud agent wins a bundle reference it matches.
      if (kind === 'bundle' && chatCloud && chatCloud.bundleId === wanted) return resolveCloud(chatCloud)
      // An `id:` or slug in a cloud agent's own chat names that agent only when its workspace manifest says
      // so, which core alone can read: asked first, so the chat's own agent wins over a local namesake (D6.8).
      let chatCloudUnreachable = false
      if (kind !== 'bundle' && chatCloud && chatCloud.owned) {
        const session = cloud().chatCoreSession?.(userId, chatCloud.id) ?? null
        const resolveRefs = cloud().client.resolveRefs
        if (session && resolveRefs) {
          const asked = await resolveRefs(userId, [ref.raw], session)
          const answer = asked.ok ? asked.value?.results?.[0] : undefined
          if (!asked.ok) chatCloudUnreachable = asked.code === 'unreachable' || asked.code === 'reauth_required'
          else if (answer && answer.agent?.id === chatCloud.remoteTargetId) {
            if (answer.status === 'ok') return resolveCloud(chatCloud)
            const named = { agentName: chatCloud.name, agentId: chatCloud.id }
            if (answer.status === 'env_asleep' || answer.status === 'adapter_unsupported') return miss('unreachable', named)
            return miss('gone', named)
          }
        }
      }
      const kits = deps.agents()
      const others = kind === 'bundle' ? [] : (deps.otherAgents?.() ?? [])
      const matchesKit = (agent: ComponentAgent): boolean =>
        kind === 'id' ? agent.manifestId.toLowerCase() === wanted : kind === 'slug' ? agent.slug === wanted : bundleIdOf(agent) === wanted
      const matchesOther = (agent: OtherAgent): boolean => (kind === 'id' ? agent.manifestId.toLowerCase() === wanted : agent.slug === wanted)
      const candidates: Array<{ id: string; kit: ComponentAgent | null; other: OtherAgent | null }> = [
        ...kits.filter(matchesKit).map((agent) => ({ id: agent.id, kit: agent, other: null })),
        ...others.filter(matchesOther).map((agent) => ({ id: agent.id, kit: null, other: agent }))
      ]
      if (candidates.length === 0) {
        if (kind === 'bundle') {
          // No local agent has it: the profile's own cloud agent with that bundle id.
          const matching = clouds.filter((agent) => agent.bundleId === wanted)
          const owned = matching.filter((agent) => agent.owned)
          if (owned.length === 1) return resolveCloud(owned[0])
          if (owned.length > 1) return miss('ambiguous')
          if (matching.length > 0) return miss('not_owner', { agentName: matching[0].name, agentId: matching[0].id })
          return miss('bundle_not_installed', { bundleId: wanted })
        }
        // Core did not match it to the chat's cloud agent (asked above), and no local agent has it.
        if (chatCloud && !chatCloud.owned) return miss('not_owner', { agentName: chatCloud.name, agentId: chatCloud.id })
        return chatCloudUnreachable && chatCloud ? miss('unreachable', { agentName: chatCloud.name, agentId: chatCloud.id }) : miss('agent_not_here')
      }
      // Two installs of one bundle, or two agents with one slug, are a clash the chat's own agent settles.
      const chosen = candidates.length === 1 ? candidates[0] : candidates.find((candidate) => candidate.id === chatAgentId)
      if (!chosen) return miss('ambiguous')
      if (!chosen.kit) return miss('not_kit_agent', { agentName: chosen.other!.name, agentId: chosen.other!.id })

      const agent = chosen.kit
      const scanned = readComponent(agent, ref.name, ref.skill)
      if (!scanned) return miss(kind === 'bundle' ? 'not_in_this_copy' : 'gone', { agentName: agent.name, agentId: agent.id })
      const bundleId = kind === 'bundle' ? wanted : bundleIdOf(agent)
      const canonicalAgent: ComponentReferenceAgent | null = bundleId
        ? { kind: 'bundle', value: bundleId }
        : agent.manifestId
          ? { kind: 'id', value: agent.manifestId }
          : null
      return {
        ok: true,
        resolution: {
          found: true,
          component: scanned.info,
          placements: this.placements(userId, agent.id).filter((p) => p.component === scanned.info.name && p.skill === scanned.info.skill),
          canonicalReference: canonicalAgent ? formatComponentReference(canonicalAgent, scanned.info.skill, scanned.info.name) : ref.raw
        }
      }
    }
  }
}

function bundleIdOf(agent: ComponentAgent): string | null {
  try {
    return agent.bundleId?.() ?? null
  } catch {
    return null
  }
}

export type DashboardService = ReturnType<typeof createDashboardService>

export const dashboardService = createDashboardService()
