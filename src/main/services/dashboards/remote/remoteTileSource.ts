/**
 * A cloud tile's data (D6.4), behind the calls the renderer makes for any tile
 * (`tileResult`, `ensureFresh`, `setParams`, `call`, `preview`): core owns the
 * result, the params, the budget and the schedule; main keeps a **mirror** of
 * the last data (one `dashboard_tile_results` row, params hash `cloud`) so a
 * tile draws at once and offline, and a mark that says why it is not newer.
 *
 * - **On screen** a tile reads `…/component/data`, which never wakes anything,
 *   when it comes on screen. Only when that says `stale` (and the tile is not
 *   Manual with data) does it ask `refresh {reason: open}` — `reshow` after the
 *   first time in this app run — which wakes a suspended environment; the mark
 *   is "Waking <agent>…" meanwhile. The cached data stays.
 * - **Refresh** → `manual`; **while open** → `interval` (core skips it while
 *   asleep, `skipped: env_asleep`: no error); **after a turn** → `after_turn`
 *   for a tile on screen; **launch** and **schedule** run nothing (core).
 * - **Without core's events** (no live socket) every on-screen cloud tile of
 *   the profile re-reads its data each `CLOUD_TILE_POLL_MS`; the same tick
 *   notices leases that lapsed. `coreEvents.want` follows whether any cloud
 *   tile is on screen.
 * - **Core's events**: a tile updated → re-read its data and its block's
 *   params; a highlight → the highlight store, as a local one.
 * - Failures never clear the mirror; they set the mark (D6.10 sentences, with
 *   the agent's display name and the server's host). A page only ever sees
 *   `call_failed` for a cloud-only refusal (addendum §3).
 *
 * Core module: no Electron.
 */

import { dashboardRepo } from '../../../db/dashboards'
import { createLogger } from '../../../logger/logger'
import { coreDashboardsClient, type CoreOutcome, type CoreTileData, type CoreTileRefreshReason } from './coreDashboardsClient'
import type { CoreEvents } from './coreEvents'
import { serverHost } from './cloudComponent'
import type { ComponentSpec } from '../componentScanner'
import { effectiveRefresh } from '../tileParams'
import {
  CLOUD_TILE_POLL_MS,
  DASHBOARD_CALLS_PER_MINUTE,
  type CloudTileMarkCode,
  type CloudTileStatus,
  type DashboardCallOutcome,
  type DashboardRefreshReason,
  type DashboardsErrorCode,
  type TileDto,
  type TileResultDto
} from '../../../../shared/dashboards'

const logger = createLogger('dashboards-cloud')

/** The mirror's params hash: core keeps one result per block. */
export const CLOUD_PARAMS_HASH = 'cloud'

/** A mirror over this (as JSON) is shown but kept in memory only (as a local tile's cache). */
const MAX_MIRROR_BYTES = 1_000_000

/** A read this recent is joined rather than repeated (a mount's `visible` and the first renewal). */
const READ_DEDUPE_MS = 2_000

/** What main needs to talk to core about one cloud tile. Never sent to the renderer. */
export interface CloudTileRef {
  tile: TileDto
  coreDashboardId: string
  coreBlockId: string
  /** The core agent's id. */
  remoteAgentId: string
  agentName: string
  /** The profile's server URL (for the host in a sentence; never logged). */
  serverUrl: string | null
  /** The component as parsed here, for the refresh rule; null when it did not parse. */
  spec: ComponentSpec | null
}

type Mark = { code: CloudTileMarkCode; message: string }

interface CloudState {
  stale: boolean | null
  mark: Mark | null
  /** A failure with no mark code (core's own refusal sentence). */
  failure: string | null
  paramsResolved: Record<string, unknown>
  missingCredentials: string[]
  notice: string | null
  readAt: number | null
  /** The last read was one that may wake (`visible`): a lease landing within the dedupe window adds nothing. */
  readWoke: boolean
}

export interface RemoteTileSourceDeps {
  client?: Pick<typeof coreDashboardsClient, 'tileData' | 'refreshTile' | 'setTileParams' | 'callTile' | 'runComponent' | 'getDashboard'>
  events: Pick<CoreEvents, 'want' | 'isLive'>
  /** The cloud tile `tileId` of this profile now, or null (gone, local, or not in a state to run). */
  resolve: (userId: string, tileId: string) => CloudTileRef | null
  /** This profile's cloud tile backed by `coreBlockId`, or null. */
  byBlock: (userId: string, coreBlockId: string) => CloudTileRef | null
  /** Keep core's stored params on the tile row (the owner's values, never sent from here except by a params change). */
  mirrorParams: (userId: string, tileId: string, params: Record<string, unknown>) => void
  isLeased: (tileId: string, userId: string) => boolean
  publish: (tileId: string) => void
  highlight: (tileId: string, ids: string[]) => void
  /** A refresh core ran (not skipped): the environment is up. Edit tile's pending refresh change is sent again then. */
  refreshed?: (userId: string, tileId: string) => void
  now?: () => number
  timers?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void }
}


function quoteList(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`)
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}

/** "Needs the <name> credential" (D6.10). */
export function needsCredentialsMessage(names: readonly string[]): string {
  if (names.length === 0) return 'Needs a credential that is not set up for this agent yet.'
  return names.length === 1 ? `Needs the ${quoteList(names)} credential.` : `Needs the ${quoteList(names)} credentials.`
}

/** The D6.10 mark for a refusal, with the names filled in; null for a refusal that has none (core's own sentence then). */
export function markFor(outcome: Extract<CoreOutcome<unknown>, { ok: false }>, ref: Pick<CloudTileRef, 'agentName' | 'serverUrl'>, missing: readonly string[] = []): Mark | null {
  switch (outcome.code) {
    case 'unreachable':
      return { code: 'unreachable', message: `Can’t reach ${serverHost(ref.serverUrl)}.` }
    case 'reauth_required':
      return { code: 'reauth_required', message: `Sign in to ${serverHost(ref.serverUrl)} again.` }
    case 'not_found':
    case 'not_owner':
      return { code: 'agent_gone', message: `${ref.agentName} is no longer available.` }
    case 'env_unavailable':
      return { code: 'env_unavailable', message: `${ref.agentName}’s environment isn’t running.` }
    case 'adapter_unsupported':
      return { code: 'adapter_unsupported', message: outcome.message || 'Rebuild the environment to show components.' }
    case 'needs_credentials':
      return { code: 'needs_credentials', message: needsCredentialsMessage(missing) }
    case 'rate_limited':
      return { code: 'rate_limited', message: `This tile ran its endpoints more than ${DASHBOARD_CALLS_PER_MINUTE} times in a minute; wait a moment and try again.` }
    default:
      return null
  }
}

function notice(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const value = (data as Record<string, unknown>).notice
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null
}

function parse(json: string | null | undefined): unknown {
  if (json === null || json === undefined) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

const nodeTimers = {
  setInterval: (fn: () => void, ms: number): unknown => {
    const handle = setInterval(fn, ms)
    if (typeof handle === 'object' && handle && 'unref' in handle) (handle as { unref: () => void }).unref()
    return handle
  },
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>)
}

export function createRemoteTileSource(deps: RemoteTileSourceDeps) {
  const client = deps.client ?? coreDashboardsClient
  const now = deps.now ?? Date.now
  const clock = deps.timers ?? nodeTimers
  const states = new Map<string, CloudState>()
  /** Mirrors over the size limit, kept in memory only. */
  const uncached = new Map<string, unknown>()
  const reads = new Map<string, Promise<void>>()
  /** Whether the read running for a tile may wake it. */
  const readWakes = new Map<string, boolean>()
  /** Tiles that came on screen while a read that may not wake ran: decide the wake when it settles. */
  const pendingWake = new Set<string>()
  const refreshes = new Map<string, Promise<void>>()
  const waking = new Set<string>()
  /** Tiles shown at least once in this app run (`open` the first time, `reshow` after). */
  const shownThisRun = new Set<string>()
  /** Cloud tiles on screen by a lease, and whose. */
  const leased = new Map<string, string>()
  /** Per profile: the poll timer, and whether `coreEvents.want` was last told yes. */
  const polls = new Map<string, unknown>()
  const wanted = new Set<string>()
  /** Each tile's agent display name, from the last time it was resolved. */
  const names = new Map<string, string>()
  let epoch = 0

  function state(tileId: string): CloudState {
    let entry = states.get(tileId)
    if (!entry) {
      entry = { stale: null, mark: null, failure: null, paramsResolved: {}, missingCredentials: [], notice: null, readAt: null, readWoke: false }
      states.set(tileId, entry)
    }
    return entry
  }

  function hasData(tileId: string): boolean {
    const row = dashboardRepo.result(tileId, CLOUD_PARAMS_HASH)
    return !!row && row.fetchedAt !== null
  }

  function manualWithData(ref: CloudTileRef): boolean {
    return effectiveRefresh(ref.spec, ref.tile.refreshOverride).manual && hasData(ref.tile.id)
  }

  /**
   * Whether a turn of the tile's agent should recompute it: the same rule as a
   * local tile's (`refresh.after_turn`, or the tile's override; a plain file
   * source with no command always). Core recomputes on every `after_turn` it
   * gets, and each one spends the tile's per-minute budget, so it is asked only then.
   */
  function wantsAfterTurn(ref: CloudTileRef): boolean {
    const effective = effectiveRefresh(ref.spec, ref.tile.refreshOverride)
    if (effective.manual && hasData(ref.tile.id)) return false
    const spec = ref.spec
    if (spec && spec.source && 'file' in spec.source && !spec.refreshCommand) return true
    return effective.afterTurn
  }

  /** Core's answer with data: into the mirror and the state. */
  function apply(ref: CloudTileRef, data: CoreTileData): void {
    const tileId = ref.tile.id
    const entry = state(tileId)
    const missing = Array.isArray(data.missing_credentials) ? data.missing_credentials.filter((n): n is string => typeof n === 'string') : []
    entry.stale = data.stale === true
    entry.paramsResolved = data.params_resolved && typeof data.params_resolved === 'object' ? data.params_resolved : {}
    entry.missingCredentials = missing
    entry.notice = typeof data.notice === 'string' && data.notice.trim() ? data.notice.trim().slice(0, 200) : null
    entry.mark = missing.length > 0 ? { code: 'needs_credentials', message: needsCredentialsMessage(missing) } : null
    entry.failure = null
    entry.readAt = now()
    const fetchedAt = data.fetched_at ? Date.parse(data.fetched_at) : NaN
    const hasValue = data.fetched_at !== null || data.data !== null
    try {
      if (hasValue) {
        const json = JSON.stringify(data.data ?? null) ?? 'null'
        const at = Number.isFinite(fetchedAt) ? fetchedAt : now()
        if (Buffer.byteLength(json) > MAX_MIRROR_BYTES) {
          uncached.set(tileId, data.data)
          dashboardRepo.saveResult(tileId, CLOUD_PARAMS_HASH, { resultJson: null, fetchedAt: at, error: data.mark ?? null, durationMs: null, tooLarge: true }, now())
        } else {
          uncached.delete(tileId)
          dashboardRepo.saveResult(tileId, CLOUD_PARAMS_HASH, { resultJson: json, fetchedAt: at, error: data.mark ?? null, durationMs: null }, now())
        }
      } else {
        dashboardRepo.saveResult(tileId, CLOUD_PARAMS_HASH, { error: data.mark ?? null, durationMs: null }, now())
      }
    } catch (err) {
      // The tile was removed while core answered.
      logger.debug('a cloud tile mirror could not be written', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  function fail(ref: CloudTileRef, outcome: Extract<CoreOutcome<unknown>, { ok: false }>): void {
    const entry = state(ref.tile.id)
    entry.mark = markFor(outcome, ref, entry.missingCredentials)
    entry.failure = entry.mark ? null : outcome.message || null
  }

  function result(tile: TileDto): TileResultDto {
    const row = dashboardRepo.result(tile.id, CLOUD_PARAMS_HASH)
    const data = row?.tooLarge ? (uncached.get(tile.id) ?? null) : parse(row?.resultJson)
    const entry = states.get(tile.id)
    const mark: Mark | null = waking.has(tile.id) ? { code: 'waking', message: `Waking ${resolveName(tile)}…` } : (entry?.mark ?? null)
    const cloud: CloudTileStatus = { mark, paramsResolved: entry?.paramsResolved ?? {}, missingCredentials: entry?.missingCredentials ?? [] }
    return {
      tileId: tile.id,
      data,
      fetchedAt: row?.fetchedAt ?? null,
      error: mark?.message ?? entry?.failure ?? row?.error ?? null,
      refreshing: reads.has(tile.id) || refreshes.has(tile.id),
      stale: entry?.stale ?? (row?.fetchedAt === null || row?.fetchedAt === undefined),
      tooLarge: row?.tooLarge ?? false,
      notice: entry?.notice ?? notice(data),
      cloud
    }
  }

  /** The agent name a waking mark uses: known from the last resolve. */
  function resolveName(tile: TileDto): string {
    return names.get(tile.id) ?? 'the agent'
  }

  function refresh(userId: string, ref: CloudTileRef, reason: CoreTileRefreshReason): Promise<void> {
    const tileId = ref.tile.id
    const running = refreshes.get(tileId)
    if (running) return running
    const startedEpoch = epoch
    const wakes = reason === 'open' || reason === 'reshow'
    if (wakes) waking.add(tileId)
    const run = (async () => {
      try {
        const answer = await client.refreshTile(userId, ref.coreDashboardId, ref.coreBlockId, reason)
        if (startedEpoch !== epoch) return
        if (answer.ok) {
          apply(ref, answer.value)
          if (!answer.value.skipped) deps.refreshed?.(userId, tileId)
        } else fail(ref, answer)
      } catch (err) {
        logger.warn('a cloud tile refresh failed', { error: err instanceof Error ? err.name : 'error' })
      } finally {
        waking.delete(tileId)
        refreshes.delete(tileId)
        deps.publish(tileId)
      }
    })()
    refreshes.set(tileId, run)
    deps.publish(tileId)
    return run
  }

  /** The tile is on screen and core's last answer said stale: `open` (first time this run) or `reshow`, unless Manual with data. */
  function wakeIfStale(userId: string, ref: CloudTileRef): Promise<void> | null {
    const tileId = ref.tile.id
    const stale = states.get(tileId)?.stale === true
    const first = !shownThisRun.has(tileId)
    shownThisRun.add(tileId)
    if (!stale || manualWithData(ref)) return null
    return refresh(userId, ref, first ? 'open' : 'reshow')
  }

  /**
   * Re-read core's cached data (never wakes); when `wake`, a stale answer asks
   * for an `open`/`reshow` refresh. A tile that comes on screen while a read
   * that may not wake runs (the poll, core's event) is marked: the wake is
   * decided when that read settles.
   */
  function read(userId: string, ref: CloudTileRef, options: { wake: boolean }): Promise<void> {
    const tileId = ref.tile.id
    const running = reads.get(tileId)
    if (running) {
      if (options.wake && !readWakes.get(tileId)) pendingWake.add(tileId)
      return running
    }
    const startedEpoch = epoch
    readWakes.set(tileId, options.wake)
    const run = (async () => {
      let followUp: Promise<void> | null = null
      let answered = false
      try {
        const answer = await client.tileData(userId, ref.coreDashboardId, ref.coreBlockId)
        if (startedEpoch !== epoch) return
        if (!answer.ok) {
          fail(ref, answer)
          return
        }
        apply(ref, answer.value)
        answered = true
        state(tileId).readWoke = options.wake
        if (options.wake) followUp = wakeIfStale(userId, ref)
      } catch (err) {
        logger.warn('a cloud tile read failed', { error: err instanceof Error ? err.name : 'error' })
      } finally {
        reads.delete(tileId)
        readWakes.delete(tileId)
        const wanted = pendingWake.delete(tileId)
        if (wanted && answered && !followUp && startedEpoch === epoch) {
          state(tileId).readWoke = true
          followUp = wakeIfStale(userId, ref)
        }
        deps.publish(tileId)
      }
      if (followUp) await followUp
    })()
    reads.set(tileId, run)
    deps.publish(tileId)
    return run
  }

  /** Whether any of the profile's cloud tiles is on screen; tells `coreEvents` and starts or stops the poll. */
  function syncWanted(userId: string): void {
    const any = [...leased.values()].some((owner) => owner === userId)
    if (any && !wanted.has(userId)) {
      wanted.add(userId)
      deps.events.want(userId, true)
    } else if (!any && wanted.has(userId)) {
      wanted.delete(userId)
      deps.events.want(userId, false)
    }
    const poll = polls.get(userId)
    if (any && poll === undefined) {
      polls.set(userId, clock.setInterval(() => service.pollTick(userId), CLOUD_TILE_POLL_MS))
    } else if (!any && poll !== undefined) {
      clock.clearInterval(poll)
      polls.delete(userId)
    }
  }

  function track(ref: CloudTileRef): void {
    names.set(ref.tile.id, ref.agentName)
  }

  const service = {
    /** What a cloud tile shows now, from the mirror and what is in flight. Runs nothing. */
    result(ref: CloudTileRef): TileResultDto {
      track(ref)
      return result(ref.tile)
    },

    /**
     * A refresh reason for a cloud tile (see the module comment). `renewal`
     * is a lease renewal: it reads only when the tile has just come on
     * screen (the poll and core's events keep it current after that).
     */
    async ensureFresh(userId: string, ref: CloudTileRef, reason: DashboardRefreshReason, options: { wait?: boolean; renewal?: boolean } = {}): Promise<TileResultDto> {
      track(ref)
      const tileId = ref.tile.id
      let work: Promise<void> | null = null
      if (reason === 'visible') {
        const fresh = !leased.has(tileId)
        if (options.renewal) {
          leased.set(tileId, userId)
          syncWanted(userId)
        }
        const entry = states.get(tileId)
        const lastRead = entry?.readAt ?? null
        const recent = lastRead !== null && now() - lastRead < READ_DEDUPE_MS
        if (!options.renewal || fresh) {
          if (reads.has(tileId) || !recent) work = read(userId, ref, { wake: true })
          // A read just answered but may not wake (the poll, core's event): decide the wake from its answer.
          else if (!entry?.readWoke) {
            entry!.readWoke = true
            work = wakeIfStale(userId, ref)
          }
        }
      } else if (reason === 'manual') {
        work = refresh(userId, ref, 'manual')
      } else if (reason === 'interval') {
        if (!manualWithData(ref)) work = refresh(userId, ref, 'interval')
      } else if (reason === 'after_turn') {
        if (wantsAfterTurn(ref)) work = refresh(userId, ref, 'after_turn')
      }
      // `launch` (no warm-up for cloud tiles), `schedule` (core's lazy rule) and `params` (setParams) run nothing here.
      if (work && options.wait) await work
      return result(ref.tile)
    },

    /** The tile went off screen. */
    unlease(tileIds: readonly string[]): void {
      const owners = new Set<string>()
      for (const tileId of tileIds) {
        const owner = leased.get(tileId)
        if (owner === undefined) continue
        leased.delete(tileId)
        owners.add(owner)
      }
      for (const owner of owners) syncWanted(owner)
    },

    /** The poll: lapsed leases are dropped; without a live socket each on-screen tile re-reads its data. */
    pollTick(userId: string): void {
      for (const [tileId, owner] of [...leased]) {
        if (owner === userId && !deps.isLeased(tileId, userId)) leased.delete(tileId)
      }
      syncWanted(userId)
      if (deps.events.isLive(userId)) return
      for (const [tileId, owner] of leased) {
        if (owner !== userId) continue
        const ref = deps.resolve(userId, tileId)
        if (ref) void read(userId, ref, { wake: false })
      }
    },

    /**
     * Core's socket (re)connected: every on-screen cloud tile of the profile
     * re-reads its data (never waking), so a mark from an outage goes as soon
     * as core answers again, and a failed page reopens on the new result.
     */
    reconnected(userId: string): void {
      for (const [tileId, owner] of leased) {
        if (owner !== userId) continue
        const ref = deps.resolve(userId, tileId)
        if (ref) void read(userId, ref, { wake: false })
      }
    },

    /** A params change: core's whole set; on success the owner's values are mirrored on the row. */
    async setParams(userId: string, ref: CloudTileRef, params: Record<string, unknown>): Promise<{ ok: true } | { ok: false; code: DashboardsErrorCode; message: string }> {
      track(ref)
      const answer = await client.setTileParams(userId, ref.coreDashboardId, ref.coreBlockId, params)
      if (!answer.ok) {
        const mark = markFor(answer, ref, states.get(ref.tile.id)?.missingCredentials ?? [])
        return { ok: false, code: answer.code, message: mark?.message ?? (answer.message || 'Cinna refused the change.') }
      }
      apply(ref, answer.value)
      deps.mirrorParams(userId, ref.tile.id, params)
      deps.publish(ref.tile.id)
      return { ok: true }
    },

    /** `tools/call` from the tile's page → core's block call. Cloud-only refusals reach the page as `call_failed`. */
    async call(userId: string, ref: CloudTileRef, endpoint: string, params: Record<string, unknown>): Promise<DashboardCallOutcome> {
      const answer = await client.callTile(userId, ref.coreDashboardId, ref.coreBlockId, endpoint, params)
      if (answer.ok) return { ok: true, value: answer.value?.value ?? null }
      return callRefusal(answer, ref)
    },

    /** A preview run of a cloud component (`tile_key` = `preview`). Refusals for the input are data; the rest a result with a mark. */
    async preview(
      userId: string,
      target: { remoteAgentId: string; agentName: string; serverUrl: string | null; component: string; skill: string | null },
      params: Record<string, unknown>
    ): Promise<{ ok: true; result: TileResultDto } | { ok: false; code: DashboardsErrorCode; message: string }> {
      const answer = await client.runComponent(userId, target.remoteAgentId, target.component, { skill: target.skill, params, tileKey: 'preview' })
      if (answer.ok) {
        const at = Date.parse(answer.value.fetched_at)
        const data = answer.value.value
        return {
          ok: true,
          result: {
            tileId: '',
            data,
            fetchedAt: Number.isFinite(at) ? at : now(),
            error: null,
            refreshing: false,
            stale: false,
            tooLarge: false,
            notice: answer.value.notice ?? notice(data),
            cloud: { mark: null, paramsResolved: answer.value.params_resolved ?? {}, missingCredentials: [] }
          }
        }
      }
      if (answer.code === 'invalid_input' || answer.code === 'not_owner' || answer.code === 'not_found') {
        return { ok: false, code: answer.code, message: answer.message || 'Cinna refused the preview.' }
      }
      const mark = markFor(answer, target)
      return {
        ok: true,
        result: {
          tileId: '',
          data: null,
          fetchedAt: null,
          error: mark?.message ?? (answer.message || 'The preview did not run.'),
          refreshing: false,
          stale: false,
          tooLarge: false,
          notice: null,
          cloud: { mark, paramsResolved: {}, missingCredentials: [] }
        }
      }
    },

    /** Core said the block's tile changed: re-read its data and the params core holds for it. */
    async tileUpdated(userId: string, coreBlockId: string): Promise<void> {
      const ref = deps.byBlock(userId, coreBlockId)
      if (!ref) return
      track(ref)
      const startedEpoch = epoch
      const [, board] = await Promise.all([read(userId, ref, { wake: false }), client.getDashboard(userId, ref.coreDashboardId)])
      if (startedEpoch !== epoch || !board.ok) return
      const block = board.value.blocks.find((entry) => entry.id === coreBlockId)
      const params = block?.config?.params
      if (params && typeof params === 'object' && !Array.isArray(params)) {
        deps.mirrorParams(userId, ref.tile.id, params)
        deps.publish(ref.tile.id)
      }
    },

    /** Core's agent highlighted rows on the block's tile. */
    tileHighlight(userId: string, coreBlockId: string, ids: string[]): void {
      const ref = deps.byBlock(userId, coreBlockId)
      if (!ref) return
      deps.highlight(ref.tile.id, ids.filter((id): id is string => typeof id === 'string'))
    },

    /** Profile close or quit: forget everything in memory; the mirror stays. */
    cancelAll(): void {
      epoch++
      for (const handle of polls.values()) clock.clearInterval(handle)
      polls.clear()
      for (const userId of wanted) deps.events.want(userId, false)
      wanted.clear()
      leased.clear()
      states.clear()
      uncached.clear()
      waking.clear()
      reads.clear()
      readWakes.clear()
      pendingWake.clear()
      refreshes.clear()
    },

    /** For tests. */
    isPolling(userId: string): boolean {
      return polls.has(userId)
    },

    /** For tests: everything in flight has settled. */
    async settled(): Promise<void> {
      while (reads.size > 0 || refreshes.size > 0) await Promise.allSettled([...reads.values(), ...refreshes.values()])
    }
  }
  return service
}

/** A failed block call as the page reads it: cloud-only codes become `call_failed` (addendum §3). */
function callRefusal(answer: Extract<CoreOutcome<unknown>, { ok: false }>, ref: Pick<CloudTileRef, 'agentName' | 'serverUrl'>): DashboardCallOutcome {
  const passed: DashboardsErrorCode[] = ['invalid_input', 'not_found', 'rate_limited', 'needs_credentials', 'call_failed']
  const mark = markFor(answer, ref)
  const message = mark?.message ?? (answer.message || 'The call failed.')
  if (passed.includes(answer.code)) return { ok: false, code: answer.code, message }
  return { ok: false, code: 'call_failed', message }
}

export type RemoteTileSource = ReturnType<typeof createRemoteTileSource>
