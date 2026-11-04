import { cinnaSend } from '../../cinna-http'
import { CinnaApiError } from '../../../errors'
import { CinnaSessionChanged } from '../../../auth/cinna-session'
import type { DashboardsErrorCode } from '../../../../shared/dashboards'

/**
 * Typed calls to cinna-core's dashboard API (C2, D6) for the active profile,
 * over {@link cinnaSend}: core's coded refusals (`{error: {code, message,
 * retry_after_s?, field?}}` on the component routes, `{detail}` elsewhere)
 * come back as data, never thrown. The D6.0 contract between the main-process
 * pieces: backing dashboards, the remote tile source, the frame relay, the
 * panel chat and cards all call core through here and nowhere else.
 *
 * Never logs a frame URL (the cap is its auth). Answers are core's wire shapes
 * (snake_case), typed below; turning them into `TileResultDto`/`ComponentInfo`
 * is the caller's job.
 */

const API = '/api/v1'

// ---------------------------------------------------------------------------
// Wire shapes (cinna-core `models/dashboards/*`, `models/users/user_dashboard.py`)
// ---------------------------------------------------------------------------

export type CoreTileRefreshReason = 'open' | 'reshow' | 'manual' | 'interval' | 'after_turn' | 'params'

export interface CoreFinding {
  path: string
  code: string
  field: string | null
  severity: 'error' | 'warning'
  message: string
}

export interface CorePlacement {
  dashboard_id: string
  dashboard_name: string
  block_id: string
  /** Core brief A5: present once core ships desktop-owned dashboards. */
  origin?: 'web' | 'desktop'
}

export interface CoreComponent {
  name: string
  skill: string | null
  title: string | null
  view: string | null
  /** component.json as written; null when it does not parse. */
  component_json: Record<string, unknown> | null
  findings: CoreFinding[]
  has_errors: boolean
  size_bytes: number
  placements: CorePlacement[]
}

export interface CoreRunResult {
  value: unknown
  fetched_at: string
  notice: string | null
  params_resolved: Record<string, unknown>
}

export interface CoreFrame {
  /** `<content origin>/d/v/<cap>/<entry>`: secret; never logged, never sent to the renderer. */
  frame_url: string
  expires_at: string
}

export interface CoreTileData {
  data: unknown
  stale: boolean
  fetched_at: string | null
  mark: string | null
  mark_at: string | null
  notice: string | null
  params_resolved: Record<string, unknown>
  missing_credentials: string[]
  /** e.g. `env_asleep` when an `interval` refresh did not run. */
  skipped: string | null
}

export interface CoreRefreshOverrides {
  max_age?: string | null
  while_open_every?: string | null
  after_turn?: boolean | null
}

export interface CoreBlockConfig {
  component: string
  skill?: string | null
  params?: Record<string, unknown>
  refresh?: CoreRefreshOverrides
}

export interface CoreBlock {
  id: string
  agent_id: string
  view_type: string
  title: string | null
  config: CoreBlockConfig | null
}

export interface CoreDashboard {
  id: string
  name: string
  /** Core brief A1; absent until core ships it. */
  origin?: 'web' | 'desktop'
  blocks: CoreBlock[]
}

export interface CoreSession {
  id: string
  [key: string]: unknown
}

export interface CoreRefResolved {
  ref: string
  status: 'ok' | 'ambiguous' | 'not_installed' | 'gone' | 'invalid' | 'env_asleep' | 'adapter_unsupported'
  message: string | null
  agent: { id: string; name: string } | null
  component: { name: string; skill: string | null; title: string | null; view: string | null } | null
  from_skill: string | null
  findings: CoreFinding[]
  placements: Array<{ dashboard_id: string; name: string }>
  catalog_name: string | null
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type CoreErrorCode = Extract<
  DashboardsErrorCode,
  | 'invalid_input'
  | 'not_found'
  | 'limit_reached'
  | 'rate_limited'
  | 'needs_credentials'
  | 'call_failed'
  | 'unreachable'
  | 'reauth_required'
  | 'env_unavailable'
  | 'adapter_unsupported'
  | 'not_owner'
>

export type CoreOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false
      code: CoreErrorCode
      /** Core's own sentence, or a transport one. Callers write the D6.10 sentence from `code`. */
      message: string
      status: number | null
      retryAfterS?: number
      field?: string
    }

const PASSED_CODES = new Set<string>([
  'rate_limited',
  'needs_credentials',
  'call_failed',
  'invalid_input',
  'not_found',
  'env_unavailable',
  'adapter_unsupported'
])

function fromStatus(status: number): CoreErrorCode {
  if (status === 403) return 'not_owner'
  if (status === 404) return 'not_found'
  if (status === 400 || status === 422) return 'invalid_input'
  if (status === 409) return 'limit_reached'
  if (status === 429) return 'rate_limited'
  if (status === 502 || status === 503 || status === 504) return 'unreachable'
  return 'call_failed'
}

/** Core's answer → outcome. Exported for tests. */
export function toOutcome<T>(status: number, ok: boolean, body: unknown, retryAfter?: string | null): CoreOutcome<T> {
  if (ok) return { ok: true, value: body as T }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const error = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : null
  if (error && typeof error.code === 'string' && PASSED_CODES.has(error.code)) {
    const retry = typeof error.retry_after_s === 'number' ? error.retry_after_s : retryAfter ? Number(retryAfter) : undefined
    return {
      ok: false,
      code: error.code as CoreErrorCode,
      message: typeof error.message === 'string' ? error.message : '',
      status,
      ...(retry !== undefined && Number.isFinite(retry) ? { retryAfterS: retry } : {}),
      ...(typeof error.field === 'string' ? { field: error.field } : {})
    }
  }
  const detail = record.detail
  const message =
    typeof detail === 'string'
      ? detail
      : detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).message === 'string'
        ? ((detail as Record<string, unknown>).message as string)
        : `Cinna answered ${status}.`
  return { ok: false, code: fromStatus(status), message, status }
}

function transportFailure(err: unknown): CoreOutcome<never> {
  if (err instanceof CinnaSessionChanged) return { ok: false, code: 'unreachable', message: 'The profile changed.', status: null }
  if (err instanceof CinnaApiError) {
    if (err.code === 'reauth_required' || err.code === 'not_cinna_user' || err.code === 'missing_server_url') {
      return { ok: false, code: 'reauth_required', message: err.message, status: err.status ?? null }
    }
    return { ok: false, code: 'unreachable', message: err.message, status: err.status ?? null }
  }
  return { ok: false, code: 'unreachable', message: err instanceof Error ? err.message : String(err), status: null }
}

async function call<T>(
  userId: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  json?: unknown,
  signal?: AbortSignal
): Promise<CoreOutcome<T>> {
  try {
    const answer = await cinnaSend(userId, `${API}${path}`, { method, ...(json !== undefined ? { json } : {}), ...(signal ? { signal } : {}) })
    return toOutcome<T>(answer.status, answer.ok, answer.body, answer.retryAfter)
  } catch (err) {
    return transportFailure(err)
  }
}

const seg = encodeURIComponent

function blockPath(dashboardId: string, blockId: string): string {
  return `/dashboards/${seg(dashboardId)}/blocks/${seg(blockId)}/component`
}

function componentPath(agentId: string, name: string): string {
  return `/agents/${seg(agentId)}/dashboards/${seg(name)}`
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const coreDashboardsClient = {
  // Backing dashboards (D6.1; core brief A).

  /** A desktop-owned dashboard; `origin` is ignored by a core before brief A. */
  createDashboard(userId: string, name: string): Promise<CoreOutcome<CoreDashboard>> {
    return call(userId, 'POST', '/dashboards/', { name, origin: 'desktop' })
  },
  getDashboard(userId: string, dashboardId: string): Promise<CoreOutcome<CoreDashboard>> {
    return call(userId, 'GET', `/dashboards/${seg(dashboardId)}`)
  },
  renameDashboard(userId: string, dashboardId: string, name: string): Promise<CoreOutcome<CoreDashboard>> {
    return call(userId, 'PUT', `/dashboards/${seg(dashboardId)}`, { name })
  },
  deleteDashboard(userId: string, dashboardId: string): Promise<CoreOutcome<unknown>> {
    return call(userId, 'DELETE', `/dashboards/${seg(dashboardId)}`)
  },

  /** An `agent_component` block. Grid fields are not maintained (D6.1): `0,0` and the size's spans. */
  addBlock(
    userId: string,
    dashboardId: string,
    input: { agentId: string; title: string | null; gridW: number; gridH: number; config: CoreBlockConfig }
  ): Promise<CoreOutcome<CoreBlock>> {
    return call(userId, 'POST', `/dashboards/${seg(dashboardId)}/blocks`, {
      agent_id: input.agentId,
      view_type: 'agent_component',
      title: input.title,
      grid_x: 0,
      grid_y: 0,
      grid_w: input.gridW,
      grid_h: input.gridH,
      config: input.config
    })
  },
  /** Title and/or the whole config (core replaces `config`; send params and refresh together). */
  updateBlock(
    userId: string,
    dashboardId: string,
    blockId: string,
    input: { title?: string | null; config?: CoreBlockConfig }
  ): Promise<CoreOutcome<CoreBlock>> {
    return call(userId, 'PUT', `/dashboards/${seg(dashboardId)}/blocks/${seg(blockId)}`, input)
  },
  deleteBlock(userId: string, dashboardId: string, blockId: string): Promise<CoreOutcome<unknown>> {
    return call(userId, 'DELETE', `/dashboards/${seg(dashboardId)}/blocks/${seg(blockId)}`)
  },

  // A block's tile (core `dashboard_tiles.py`).

  /** Cached data, stale or not; never wakes the environment, never runs anything (brief C1). */
  tileData(userId: string, dashboardId: string, blockId: string, signal?: AbortSignal): Promise<CoreOutcome<CoreTileData>> {
    return call(userId, 'GET', `${blockPath(dashboardId, blockId)}/data`, undefined, signal)
  },
  /** `open`/`reshow` wake a suspended environment; `interval` never does (`skipped: env_asleep`). */
  refreshTile(userId: string, dashboardId: string, blockId: string, reason: CoreTileRefreshReason): Promise<CoreOutcome<CoreTileData>> {
    return call(userId, 'POST', `${blockPath(dashboardId, blockId)}/refresh`, { reason })
  },
  /** The whole param set; keys left out go back to their default. Core recomputes (budgeted). */
  setTileParams(userId: string, dashboardId: string, blockId: string, params: Record<string, unknown>): Promise<CoreOutcome<CoreTileData>> {
    return call(userId, 'PUT', `${blockPath(dashboardId, blockId)}/params`, { params })
  },
  callTile(
    userId: string,
    dashboardId: string,
    blockId: string,
    endpoint: string,
    params: Record<string, unknown>
  ): Promise<CoreOutcome<{ value: unknown }>> {
    return call(userId, 'POST', `${blockPath(dashboardId, blockId)}/call`, { endpoint, params })
  },
  /** Wakes the environment. */
  mintTileFrame(userId: string, dashboardId: string, blockId: string): Promise<CoreOutcome<CoreFrame>> {
    return call(userId, 'POST', `${blockPath(dashboardId, blockId)}/frame`, {})
  },
  /** `seq` increases per tile across reloads (µs since epoch); `ifPageDoc` withdraws only our own state. */
  putPageState(
    userId: string,
    dashboardId: string,
    blockId: string,
    state: { pageDoc: string | null; highlightReady: boolean; seq: number; ifPageDoc?: string | null }
  ): Promise<CoreOutcome<unknown>> {
    return call(userId, 'PUT', `${blockPath(dashboardId, blockId)}/page-state`, {
      page_doc: state.pageDoc,
      highlight_ready: state.highlightReady,
      seq: state.seq,
      ...(state.ifPageDoc !== undefined ? { if_page_doc: state.ifPageDoc } : {})
    })
  },

  // An agent's components (core `agent_dashboards.py`; cards, the Dashboards tab, Preview).

  listComponents(userId: string, agentId: string): Promise<CoreOutcome<{ components: CoreComponent[] }>> {
    return call(userId, 'GET', `/agents/${seg(agentId)}/dashboards/`)
  },
  getComponent(userId: string, agentId: string, name: string, skill: string | null): Promise<CoreOutcome<CoreComponent>> {
    const query = skill ? `?skill=${seg(skill)}` : ''
    return call(userId, 'GET', `${componentPath(agentId, name)}${query}`)
  },
  /** A preview run (`tileKey` = `preview`) or an endpoint for a preview frame's call; budgeted per tile key. */
  runComponent(
    userId: string,
    agentId: string,
    name: string,
    input: { skill: string | null; endpoint?: string | null; params?: Record<string, unknown>; tileKey: string }
  ): Promise<CoreOutcome<CoreRunResult>> {
    return call(userId, 'POST', `${componentPath(agentId, name)}/run`, {
      skill: input.skill,
      endpoint: input.endpoint ?? null,
      params: input.params ?? {},
      tile_key: input.tileKey
    })
  },
  mintComponentFrame(userId: string, agentId: string, name: string, input: { skill: string | null; tileKey: string }): Promise<CoreOutcome<CoreFrame>> {
    return call(userId, 'POST', `${componentPath(agentId, name)}/frame`, { skill: input.skill, tile_key: input.tileKey })
  },
  /** Up to 20 references; never wakes anything. `sessionId`: the chat's core session, whose agent wins. */
  resolveRefs(userId: string, refs: string[], sessionId?: string | null): Promise<CoreOutcome<{ results: CoreRefResolved[] }>> {
    return call(userId, 'POST', '/dashboards/component-refs/resolve', { refs, ...(sessionId ? { session_id: sessionId } : {}) })
  },

  // The dashboard chat (D6.6).

  /** The (dashboard, agent) chat session; `fresh` starts a new one ("New chat"). */
  openChat(userId: string, dashboardId: string, agentId: string, fresh: boolean): Promise<CoreOutcome<{ session: CoreSession | null }>> {
    return call(userId, 'POST', `/dashboards/${seg(dashboardId)}/chat`, { agent_id: agentId, new: fresh })
  }
}
