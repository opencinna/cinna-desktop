/**
 * Whether a tile's data is fresh, and recomputing it when it is not. Main owns
 * freshness: the renderer only says "these tiles are on screen" (a lease it
 * renews) and "Refresh was pressed".
 *
 * - **Re-read versus recompute.** The last good result per (tile, params) is
 *   cached in the DB and shown at once (stale-while-revalidate). A recompute
 *   runs the source: an endpoint through {@link endpointRunner}, or a file
 *   source re-read after its `refresh.command` (`/run:<name>`, with the
 *   yielding lock) when it has one.
 * - **When (D1).** On screen and older than the tile's max age (`visible`), or
 *   Refresh (`manual`). A tile set to Manual recomputes on its own only while
 *   it has no data yet.
 * - **After a turn (D3).** When a turn of an agent ends, each of its tiles
 *   that holds a live lease is asked again with `after_turn`. A plain file
 *   source (no `refresh.command`) is re-read, which costs nothing; anything
 *   that would run a script recomputes only where the component says
 *   `refresh.after_turn: true`. A tile set to Manual that has data, or that
 *   nobody is looking at, runs nothing.
 * - **Credentials first (D16).** A component whose `requires_credentials`
 *   names a slot not ready for the agent runs nothing: the answer carries a
 *   sentence naming the credential(s), stored nowhere.
 * - **A skill's component** (D15) runs its script from the skill's folder,
 *   by absolute path, with cwd and credentials at the agent that has it.
 * - **A failure keeps the data** and stores the error beside it. A busy agent
 *   (an exclusive folder write held or queued) keeps the data and skips the
 *   tick, with no error; so does a run an exclusive write preempted mid-run
 *   (`interrupted`) — the next refresh simply runs it again.
 * - **Output is data.** A file source's values are redacted as an endpoint's
 *   are, before they are cached or shown.
 * - **In flight** runs are joined per (tile, params hash): a second request
 *   with the same params gets the running one; new params supersede it.
 * - **The lease.** Renewed every 20 s by the renderer for the tiles on screen
 *   and dropped on hide or blur; a renewal re-checks those tiles. Core cannot
 *   see window state, so a reloaded or hidden renderer simply stops renewing.
 * - **Profile close** cancels every run and drops every lease.
 *
 * Core module: no Electron. Pushes `dashboards:tile-changed {tileId}` through
 * `host/events`.
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { dashboardRepo } from '../../db/dashboards'
import { publishEvent } from '../../host/events'
import { getSettingsScopeUserId } from '../../auth/scope'
import { createLogger } from '../../logger/logger'
import { isCredentialFilePath } from '../../../shared/agentFiles'
import { redactCredentialValues } from '../../security/serviceCredentialRedaction'
import { commandService } from '../localAgents/commandService'
import { RUN_REFERENCE_PATTERN } from '../../../shared/kit/manifest'
import { dashboardsFolderRole, type ComponentAgent, type ScannedComponent } from './componentScanner'
import { dashboardService, type DashboardService } from './dashboardService'
import { DASHBOARD_LOCK_OWNER, MAX_ENDPOINT_STDOUT_BYTES, endpointRunner, type EndpointOutcome, type EndpointRunner } from './endpointRunner'
import {
  DASHBOARDS_TILE_CHANGED_CHANNEL,
  DASHBOARD_LEASE_TTL_MS,
  parseDuration,
  resolveParamWords,
  type DashboardRefreshReason,
  type DashboardsOutcome,
  type TileDto,
  type TileResultDto
} from '../../../shared/dashboards'

const logger = createLogger('dashboard-refresh')

/** A result over this (as JSON) is shown but not kept: the tile says "too large to keep". */
export const MAX_CACHED_RESULT_BYTES = 1_000_000

/** Tile ids one lease renewal takes; the rest are ignored. */
export const MAX_LEASED_TILES = 100

/** A file source larger than this is not read. */
const MAX_FILE_SOURCE_BYTES = MAX_ENDPOINT_STDOUT_BYTES

type SourceOutcome = EndpointOutcome

export interface RefreshServiceDeps {
  dashboards: Pick<DashboardService, 'resolveTile' | 'resolveComponent' | 'placements'>
  runner: Pick<EndpointRunner, 'run'>
  /** A file source's `refresh.command`, through `/run:` with the yielding lock. */
  runCommand: (agentId: string, name: string, signal: AbortSignal) => Promise<{ ok: boolean; busy: boolean; aborted: boolean; error?: string }>
  publish: (tileId: string) => void
  now?: () => number
}

/** The hash a tile's cached result is keyed by: its params, keys sorted. */
export function paramsHash(params: Record<string, unknown>): string {
  const sorted = Object.keys(params).sort().reduce<Record<string, unknown>>((out, key) => { out[key] = params[key]; return out }, {})
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32)
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

/** A file source, read: JSON as is, markdown and CSV as `{markdown}` / `{csv}`. */
async function readFileSource(agentDir: string, relPath: string): Promise<SourceOutcome> {
  const startedAt = Date.now()
  const fail = (message: string): SourceOutcome => ({ ok: false, code: 'failed', message, durationMs: Date.now() - startedAt })
  let real: string
  let agentReal: string
  try {
    agentReal = await realpath(agentDir)
    real = await realpath(join(agentReal, relPath))
  } catch {
    return fail(`${relPath} is not there yet.`)
  }
  if (!isWithin(agentReal, real) || isCredentialFilePath(real, agentReal)) return fail(`${relPath} cannot be read.`)
  try {
    const info = await stat(real)
    if (!info.isFile()) return fail(`${relPath} is not a file.`)
    if (info.size > MAX_FILE_SOURCE_BYTES) return { ok: false, code: 'too_large', message: `${relPath} is too large (over 5 MB).`, durationMs: Date.now() - startedAt }
    const text = await readFile(real, 'utf8')
    const ext = extname(real).toLowerCase()
    if (ext === '.json') {
      try {
        return { ok: true, value: redactCredentialValues(JSON.parse(text) as unknown), durationMs: Date.now() - startedAt }
      } catch {
        return { ok: false, code: 'not_json', message: `${relPath} is not valid JSON.`, durationMs: Date.now() - startedAt }
      }
    }
    return { ok: true, value: redactCredentialValues(ext === '.csv' ? { csv: text } : { markdown: text }), durationMs: Date.now() - startedAt }
  } catch {
    return fail(`${relPath} could not be read.`)
  }
}

/** The sentence a tile or preview shows when credentials are missing; names each one. */
export function missingCredentialsMessage(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`)
  const list = quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
  return quoted.length === 1
    ? `This needs the ${list} credential, which is not set up for this agent yet.`
    : `This needs the ${list} credentials, which are not set up for this agent yet.`
}

function notice(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const value = (data as Record<string, unknown>).notice
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null
}

function parse(json: string | null): unknown {
  if (json === null) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

export function createDashboardRefreshService(deps: RefreshServiceDeps) {
  const now = deps.now ?? Date.now
  /** Runs in flight, per `${tileId}|${paramsHash}`. */
  const inFlight = new Map<string, Promise<void>>()
  /** Every run's controller, so a profile close can stop them all. */
  const controllers = new Set<AbortController>()
  /** Every run and preview still going, so a quit can wait for their processes to end. */
  const pending = new Set<Promise<unknown>>()
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => {})
    return work
  }
  /** Results over the cache limit, kept in memory only: `${tileId}|${hash}`. */
  const uncached = new Map<string, unknown>()
  const leases = new Map<string, { userId: string; expiresAt: number }>()
  let epoch = 0

  function maxAgeMs(tile: TileDto, scanned: ScannedComponent | null): number {
    return parseDuration(tile.refreshOverride?.maxAge) ?? scanned?.spec?.maxAgeMs ?? 15 * 60_000
  }

  /** The source's params: the tile's values over the component's defaults, `current`/`today` resolved. */
  function effectiveParams(tile: TileDto, scanned: ScannedComponent): Record<string, unknown> {
    return resolveParamWords(tile.params, scanned.spec?.params ?? {}, new Date(now()))
  }

  async function runSource(agent: ComponentAgent, scanned: ScannedComponent, params: Record<string, unknown>, key: string, signal: AbortSignal): Promise<SourceOutcome> {
    const spec = scanned.spec!
    if ('endpoint' in spec.source) {
      const endpoint = spec.endpoints[spec.source.endpoint]
      return deps.runner.run({
        agentId: agent.id,
        agentDir: agent.path,
        rootPath: agent.rootPath,
        // The agent's own: agent-relative, as it runs from the agent folder. A
        // skill's: the script in the skill's folder (perhaps a cache outside
        // the agent), absolute; cwd and credentials stay the agent's.
        script: scanned.info.skill === null
          ? `${dashboardsFolderRole(agent.rootPath)}/${scanned.info.name}/${endpoint.script}`
          : join(scanned.dir, ...endpoint.script.split('/')),
        runtime: endpoint.runtime,
        params,
        timeoutS: endpoint.timeoutS,
        key: `${key}:${endpoint.name}`,
        signal
      })
    }
    if (spec.refreshCommand) {
      const name = RUN_REFERENCE_PATTERN.exec(spec.refreshCommand)?.[1]
      if (name) {
        const startedAt = Date.now()
        const ran = await deps.runCommand(agent.id, name, signal)
        if (ran.aborted) return { ok: false, code: 'cancelled', message: 'The run was cancelled.', durationMs: Date.now() - startedAt }
        if (ran.busy) return { ok: false, code: 'busy', message: 'The agent is busy; the tile keeps its data.', durationMs: Date.now() - startedAt }
        if (!ran.ok) return { ok: false, code: 'failed', message: ran.error ?? `${spec.refreshCommand} failed.`, durationMs: Date.now() - startedAt }
      }
    }
    return readFileSource(agent.path, spec.source.file)
  }

  /** What the tile shows now, from the cache and what is in flight. Runs nothing. */
  function resultFor(tile: TileDto, scanned: ScannedComponent | null, hash = paramsHash(tile.params)): TileResultDto {
    const row = dashboardRepo.result(tile.id, hash)
    const memKey = `${tile.id}|${hash}`
    const data = row?.tooLarge ? (uncached.get(memKey) ?? null) : parse(row?.resultJson ?? null)
    const fetchedAt = row?.fetchedAt ?? null
    return {
      tileId: tile.id,
      data,
      fetchedAt,
      error: row?.error ?? null,
      refreshing: inFlight.has(memKey),
      stale: fetchedAt === null || now() - fetchedAt > maxAgeMs(tile, scanned),
      tooLarge: row?.tooLarge ?? false,
      notice: notice(data)
    }
  }

  function record(tileId: string, hash: string, outcome: SourceOutcome): void {
    const memKey = `${tileId}|${hash}`
    try {
      if (outcome.ok) {
        const json = JSON.stringify(outcome.value) ?? 'null'
        if (Buffer.byteLength(json) > MAX_CACHED_RESULT_BYTES) {
          uncached.set(memKey, outcome.value)
          dashboardRepo.saveResult(tileId, hash, { resultJson: null, fetchedAt: now(), error: null, durationMs: outcome.durationMs, tooLarge: true }, now())
        } else {
          uncached.delete(memKey)
          dashboardRepo.saveResult(tileId, hash, { resultJson: json, fetchedAt: now(), error: null, durationMs: outcome.durationMs }, now())
        }
      } else {
        dashboardRepo.saveResult(tileId, hash, { error: outcome.message, durationMs: outcome.durationMs }, now())
      }
    } catch (err) {
      // The tile was removed while its run was in flight.
      logger.debug('a tile result could not be written', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Start (or join) a recompute of `tile` with its current params. */
  function recompute(agent: ComponentAgent, scanned: ScannedComponent, tile: TileDto): Promise<void> {
    const hash = paramsHash(tile.params)
    const memKey = `${tile.id}|${hash}`
    const running = inFlight.get(memKey)
    if (running) return running
    const controller = new AbortController()
    controllers.add(controller)
    const startedEpoch = epoch
    const run = (async () => {
      try {
        const outcome = await runSource(agent, scanned, effectiveParams(tile, scanned), tile.id, controller.signal)
        // Skipped, replaced or cancelled: the tile keeps what it has, with no error.
        if (!outcome.ok && (outcome.code === 'busy' || outcome.code === 'superseded' || outcome.code === 'cancelled' || outcome.code === 'interrupted')) return
        if (startedEpoch !== epoch) return
        record(tile.id, hash, outcome)
      } catch (err) {
        logger.warn('a tile recompute failed', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        controllers.delete(controller)
        inFlight.delete(memKey)
        deps.publish(tile.id)
      }
    })()
    inFlight.set(memKey, run)
    track(run)
    deps.publish(tile.id)
    return run
  }

  /** Whether `reason` asks for a recompute of a tile in this state. */
  function wantsRun(reason: DashboardRefreshReason, tile: TileDto, scanned: ScannedComponent): boolean {
    if (reason === 'manual') return true
    const row = dashboardRepo.result(tile.id, paramsHash(tile.params))
    if (reason === 'after_turn') {
      if (tile.refreshOverride?.manual && row && row.fetchedAt !== null) return false
      const spec = scanned.spec
      // A plain file re-read costs nothing; a script runs only when asked for.
      if (spec && 'file' in spec.source && !spec.refreshCommand) return true
      return spec?.afterTurn === true
    }
    if (!row || (row.fetchedAt === null && row.error === null)) return true
    if (tile.refreshOverride?.manual && row.fetchedAt !== null) return false
    // The last attempt, good or failed: a failing script is retried once per max age, not per renewal.
    return now() - row.updatedAt > maxAgeMs(tile, scanned)
  }

  return {
    /** A tile's cached data and state; runs nothing. */
    tileResult(userId: string, tileId: unknown): DashboardsOutcome<{ result: TileResultDto }> {
      const resolved = deps.dashboards.resolveTile(userId, tileId)
      if (!resolved) return { ok: false, code: 'not_found', message: 'That tile is gone.' }
      return { ok: true, result: resultFor(resolved.tile, resolved.scanned) }
    },

    /**
     * Recompute `tileId` if `reason` and its state call for it; answers with
     * the state at once (`refreshing` set when a run started or was joined).
     * `wait` resolves only after the run, for tests and callers that need it.
     */
    async ensureFresh(userId: string, tileId: unknown, reason: unknown, options: { wait?: boolean } = {}): Promise<DashboardsOutcome<{ result: TileResultDto }>> {
      if (reason !== 'visible' && reason !== 'manual' && reason !== 'after_turn') return { ok: false, code: 'invalid_input', message: 'Unknown refresh reason.' }
      const resolved = deps.dashboards.resolveTile(userId, tileId)
      if (!resolved) return { ok: false, code: 'not_found', message: 'That tile is gone.' }
      const { agent, scanned, tile } = resolved
      if (resolved.view.state !== 'ok' || !agent || !scanned?.spec) return { ok: true, result: resultFor(tile, scanned) }
      // Nothing is spawned without the credentials it needs; the cached data stays beside the sentence.
      const missing = scanned.info.missingCredentials
      if (missing.length > 0) return { ok: true, result: { ...resultFor(tile, scanned), error: missingCredentialsMessage(missing) } }
      if (wantsRun(reason, tile, scanned)) {
        const run = recompute(agent, scanned, tile)
        if (options.wait) await run
      }
      return { ok: true, result: resultFor(tile, scanned) }
    },

    /**
     * A component's data for a preview (the agent tab, the Add dialog): run
     * once, never cached. Nothing runs unless the user asked for the preview.
     */
    async preview(userId: string, agentId: unknown, component: unknown, skill?: unknown): Promise<DashboardsOutcome<{ result: TileResultDto }>> {
      const found = deps.dashboards.resolveComponent(agentId, component, skill)
      if (!found) return { ok: false, code: 'not_found', message: 'That component is no longer in the agent’s folder.' }
      if (!found.scanned.spec) return { ok: false, code: 'component_invalid', message: 'This component has problems to fix before it can run.' }
      const missing = found.scanned.info.missingCredentials
      if (missing.length > 0) {
        const result: TileResultDto = { tileId: '', data: null, fetchedAt: null, error: missingCredentialsMessage(missing), refreshing: false, stale: false, tooLarge: false, notice: null }
        return { ok: true, result }
      }
      const controller = new AbortController()
      controllers.add(controller)
      try {
        const tile: TileDto = { id: '', dashboardId: '', agentManifestId: found.agent.manifestId, component: found.scanned.info.name, skill: found.scanned.info.skill, title: null, size: found.scanned.spec.size, position: 0, params: {}, refreshOverride: null }
        const outcome = await track(runSource(found.agent, found.scanned, effectiveParams(tile, found.scanned), `preview:${userId}:${found.agent.id}:${found.scanned.info.skill ?? ''}:${found.scanned.info.name}`, controller.signal))
        const at = now()
        const data = outcome.ok ? outcome.value : null
        return {
          ok: true,
          result: {
            tileId: '',
            data,
            fetchedAt: outcome.ok ? at : null,
            error: outcome.ok ? null : outcome.code === 'superseded' ? null : outcome.message,
            refreshing: false,
            stale: false,
            tooLarge: false,
            notice: notice(data)
          }
        }
      } finally {
        controllers.delete(controller)
      }
    },

    /**
     * The renderer's "these tiles are on screen", renewed every 20 s. Each
     * leased tile is re-checked, so one that went stale while shown recomputes.
     */
    renewLease(userId: string, tileIds: unknown): DashboardsOutcome<object> {
      if (!Array.isArray(tileIds) || !tileIds.every((id) => typeof id === 'string')) return { ok: false, code: 'invalid_input', message: 'No tiles named.' }
      const expiresAt = now() + DASHBOARD_LEASE_TTL_MS
      // Deduped and capped: a renderer cannot make one renewal start unbounded work.
      for (const tileId of [...new Set(tileIds as string[])].slice(0, MAX_LEASED_TILES)) {
        leases.set(tileId, { userId, expiresAt })
        void this.ensureFresh(userId, tileId, 'visible').catch(() => {})
      }
      return { ok: true }
    },

    /** The window was hidden or lost focus, or the dashboard closed: no tile of it is on screen. */
    dropLease(userId: string, tileIds?: unknown): DashboardsOutcome<object> {
      const ids = Array.isArray(tileIds) ? tileIds.filter((id): id is string => typeof id === 'string') : null
      for (const [tileId, lease] of leases) {
        if (lease.userId === userId && (!ids || ids.includes(tileId))) leases.delete(tileId)
      }
      return { ok: true }
    },

    /**
     * A turn of `agentId` (a row id) ended: each of its tiles on this
     * profile's dashboards that is on screen by a live lease is asked again
     * with `after_turn`. Answers the tile ids asked.
     */
    afterTurn(userId: string, agentId: string): string[] {
      let tileIds: string[] = []
      try {
        tileIds = deps.dashboards.placements(userId, agentId).map((placement) => placement.tileId)
      } catch (err) {
        logger.warn('could not list an agent’s tiles after its turn', { agentId, error: err instanceof Error ? err.message : String(err) })
        return []
      }
      const asked = tileIds.filter((tileId) => this.isLeased(tileId, userId))
      for (const tileId of asked) void this.ensureFresh(userId, tileId, 'after_turn').catch(() => {})
      return asked
    },

    /** Whether a tile is on screen by a live lease (the profile's, when `userId` is given). */
    isLeased(tileId: string, userId?: string): boolean {
      const lease = leases.get(tileId)
      if (!lease || (userId !== undefined && lease.userId !== userId)) return false
      if (lease.expiresAt <= now()) {
        leases.delete(tileId)
        return false
      }
      return true
    },

    /**
     * The profile is being left, or the app quits: stop every run (each
     * endpoint's process group is killed as the abort lands), forget every
     * lease and in-memory result. Resolves once every run has ended, for a
     * host that awaits process exit.
     */
    cancelAll(): Promise<void> {
      epoch++
      for (const controller of controllers) controller.abort()
      controllers.clear()
      leases.clear()
      uncached.clear()
      return Promise.allSettled([...pending]).then(() => undefined)
    },

    /** For tests: runs in flight now. */
    inFlightCount(): number {
      return inFlight.size
    }
  }
}

export type DashboardRefreshService = ReturnType<typeof createDashboardRefreshService>

export const dashboardRefreshService = createDashboardRefreshService({
  dashboards: dashboardService,
  runner: endpointRunner,
  runCommand: (agentId, name, signal) =>
    commandService.run(getSettingsScopeUserId(), agentId, name, signal, undefined, { yieldingOwner: DASHBOARD_LOCK_OWNER }),
  publish: (tileId) => publishEvent(DASHBOARDS_TILE_CHANGED_CHANNEL, { tileId })
})
