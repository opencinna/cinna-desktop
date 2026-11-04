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
import { dashboardRepo, type DashboardRow, type DashboardTileRow } from '../../db/dashboards'
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
import { formatComponentReference, parseComponentReference } from '../../../shared/componentReference'
import {
  MAX_DASHBOARDS_PER_PROFILE,
  MAX_DASHBOARD_NAME_LENGTH,
  MAX_TILES_PER_DASHBOARD,
  MAX_TILE_TITLE_LENGTH,
  isTileSize,
  parseDuration,
  type AddTileInput,
  type ComponentInfo,
  type ComponentPlacement,
  type ComponentReferenceAgent,
  type ComponentReferenceMiss,
  type ComponentReferenceResolution,
  type DashboardDto,
  type DashboardsErrorCode,
  type DashboardsOutcome,
  type TileDto,
  type TileRefreshOverride,
  type TileScheduleState,
  type TileView,
  type ResolveReferenceOutcome,
  type UpdateTileInput
} from '../../../shared/dashboards'
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

export function toTileDto(row: DashboardTileRow): TileDto {
  const override = normalizeRefreshOverride(parseJsonObject(row.refreshOverrideJson))
  return {
    id: row.id,
    dashboardId: row.dashboardId,
    agentManifestId: row.agentManifestId,
    component: row.component,
    skill: row.skill ?? null,
    title: row.title,
    size: isTileSize(row.size) ? row.size : 'm',
    position: row.position,
    params: parseJsonObject(row.paramsJson) ?? {},
    refreshOverride: override === 'invalid' ? null : override
  }
}

/** A tile with the agent and component behind it, found again now. */
export interface ResolvedTile {
  tile: TileDto
  view: TileView
  agent: ComponentAgent | null
  scanned: ScannedComponent | null
}

export function createDashboardService(deps: DashboardServiceDeps = { agents: defaultAgents, otherAgents: defaultOtherAgents }) {
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

  function resolveRow(userId: string, row: DashboardTileRow): ResolvedTile {
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
      return row ? { ok: true, dashboard: toDashboardDto(row) } : refuse('not_found', 'That dashboard is gone.')
    },

    delete(userId: string, dashboardId: unknown): DashboardsOutcome<object> {
      if (typeof dashboardId !== 'string' || !dashboardRepo.delete(userId, dashboardId)) return refuse('not_found', 'That dashboard is gone.')
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
      return { ok: true, dashboard: toDashboardDto(row), tiles: dashboardRepo.tiles(userId, dashboardId).map((tile) => resolveRow(userId, tile).view) }
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
      if (value.size !== undefined) {
        if (!isTileSize(value.size)) return refuse('invalid_input', 'That is not a tile size.')
        patch.size = value.size
      }
      if (value.refreshOverride !== undefined) {
        const override = normalizeRefreshOverride(value.refreshOverride)
        if (override === 'invalid') return refuse('invalid_input', 'That refresh rule is not valid.')
        patch.refreshOverrideJson = override ? JSON.stringify(override) : null
      }
      const row = dashboardRepo.updateTile(userId, value.tileId, patch)
      return row ? { ok: true, tile: toTileDto(row) } : refuse('not_found', 'That tile is gone.')
    },

    moveTile(userId: string, tileId: unknown, toIndex: unknown): DashboardsOutcome<object> {
      if (typeof tileId !== 'string' || typeof toIndex !== 'number' || !Number.isFinite(toIndex)) return refuse('invalid_input', 'Nothing to move.')
      return dashboardRepo.moveTile(userId, tileId, toIndex) ? { ok: true } : refuse('not_found', 'That tile is gone.')
    },

    removeTile(userId: string, tileId: unknown): DashboardsOutcome<object> {
      if (typeof tileId !== 'string' || !dashboardRepo.removeTile(userId, tileId)) return refuse('not_found', 'That tile is gone.')
      return { ok: true }
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
      if (!agent?.manifestId) return []
      return dashboardRepo.tilesForAgent(userId, agent.manifestId).map(({ tile, dashboardName }) => ({
        component: tile.component,
        skill: tile.skill ?? null,
        tileId: tile.id,
        dashboardId: tile.dashboardId,
        dashboardName
      }))
    },

    /**
     * A component reference (README §5.5) resolved to a component on this
     * machine, or the reason there is none, as data. Main parses the reference
     * again; the chat's own agent (`chatAgentId`, a row id) wins a clash.
     * Reading runs nothing (README D8).
     */
    resolveReference(userId: string, input: unknown): ResolveReferenceOutcome {
      const value = isRecord(input) ? input : {}
      const ref = typeof value.reference === 'string' ? parseComponentReference(value.reference) : null
      if (!ref) return refuse('invalid_input', 'That is not a component reference.')
      const chatAgentId = typeof value.chatAgentId === 'string' ? value.chatAgentId : null
      const miss = (reason: ComponentReferenceMiss, extra: Partial<Extract<ComponentReferenceResolution, { found: false }>> = {}): ResolveReferenceOutcome => ({
        ok: true,
        resolution: { found: false, reason, agentName: null, agentId: null, bundleId: null, ...extra }
      })

      const { kind, value: wanted } = ref.agent
      const kits = deps.agents()
      const others = kind === 'bundle' ? [] : (deps.otherAgents?.() ?? [])
      const matchesKit = (agent: ComponentAgent): boolean =>
        kind === 'id' ? agent.manifestId.toLowerCase() === wanted : kind === 'slug' ? agent.slug === wanted : bundleIdOf(agent) === wanted
      const matchesOther = (agent: OtherAgent): boolean => (kind === 'id' ? agent.manifestId.toLowerCase() === wanted : agent.slug === wanted)
      const candidates: Array<{ id: string; kit: ComponentAgent | null; other: OtherAgent | null }> = [
        ...kits.filter(matchesKit).map((agent) => ({ id: agent.id, kit: agent, other: null })),
        ...others.filter(matchesOther).map((agent) => ({ id: agent.id, kit: null, other: agent }))
      ]
      if (candidates.length === 0) return kind === 'bundle' ? miss('bundle_not_installed', { bundleId: wanted }) : miss('agent_not_here')
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
