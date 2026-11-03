/**
 * Dashboards: per-profile grids of tiles, each tile a placement of a
 * component an agent built in its folder (`dashboards/<name>/`). The
 * renderer names dashboards, tiles, agents and components by id and name,
 * never by path; every answer, refusals included, is data.
 */

/** How a component draws: the four native views, or the agent's own page. */
export const DASHBOARD_VIEW_KINDS = ['markdown', 'table', 'list', 'metrics', 'html'] as const
export type DashboardViewKind = (typeof DASHBOARD_VIEW_KINDS)[number]

/** Tile size presets: grid cells on a 12-column grid. */
export const TILE_SIZES = ['s', 'm', 'l', 'wide', 'tall'] as const
export type TileSize = (typeof TILE_SIZES)[number]

export const TILE_SIZE_SPANS: Record<TileSize, { cols: number; rows: number }> = {
  s: { cols: 3, rows: 2 },
  m: { cols: 6, rows: 2 },
  l: { cols: 6, rows: 4 },
  wide: { cols: 12, rows: 2 },
  tall: { cols: 3, rows: 4 }
}

export const TILE_SIZE_LABELS: Record<TileSize, string> = {
  s: 'Small',
  m: 'Medium',
  l: 'Large',
  wide: 'Wide',
  tall: 'Tall'
}

export function isTileSize(value: unknown): value is TileSize {
  return typeof value === 'string' && (TILE_SIZES as readonly string[]).includes(value)
}

export const MAX_DASHBOARDS_PER_PROFILE = 20
export const MAX_TILES_PER_DASHBOARD = 24
export const MAX_DASHBOARD_NAME_LENGTH = 80
export const MAX_TILE_TITLE_LENGTH = 120

/** The default `refresh.max_age` when a component states none. */
export const DEFAULT_MAX_AGE = '15m'

/** The renderer renews the visibility lease this often while tiles are on screen. */
export const DASHBOARD_LEASE_RENEW_MS = 20_000
/** A lease not renewed within this is gone: a reloaded or hidden renderer stops recomputes within one TTL. */
export const DASHBOARD_LEASE_TTL_MS = 30_000

/** `30s`, `15m`, `6h`, `1d` → milliseconds; null for anything else (the schema's `duration`). */
export function parseDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^([1-9][0-9]{0,6})(s|m|h|d)$/.exec(value)
  if (!match) return null
  const n = Number(match[1])
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd']
  return n * unit
}

/** A component's source: one of its endpoints, or a file in the agent folder. */
export type ComponentSource = { endpoint: string } | { file: string }

/**
 * One finding about a component, as cinna-core's `check_component.py --json`
 * reports it (`x-check-codes` in `protocols/dashboards.schema.json`): the
 * desktop applies the same rules and reports the same `(path, code, field)`
 * triples, so a card and the agent's check never disagree.
 */
export interface ComponentFinding {
  /** Agent-relative (`dashboards/deals/component.json`, `skills/crm/dashboards/deals/app.js`). */
  path: string
  /** A code from the schema's `x-check-codes` (`script_missing`, `network_reference`, …). */
  code: string
  /** The `component.json` field (`endpoints.items.script`), a content-scan trigger (`fetch`), or null. */
  field: string | null
  /** An error makes the component invalid; a warning is shown and changes nothing. */
  severity: 'error' | 'warning'
  /** One sentence a person reads. */
  message: string
}

/** One suggested question: `label` on the button, `prompt` the text sent. */
export interface ComponentPrompt {
  label: string
  prompt: string
}

/** What a scanned component is, valid or not. */
export interface ComponentInfo {
  /** `folder:<manifest id>` — the agent's row id. */
  agentId: string
  /** The agent manifest's `id`; `''` for a legacy manifest, which cannot have tiles. */
  manifestId: string
  agentName: string
  /** The folder name under `dashboards/`. */
  name: string
  /**
   * The skill that ships it (`<skill>/dashboards/<name>/`, README D15), or
   * null for the agent's own `dashboards/`. A component is named by
   * (agent, skill, name) everywhere.
   */
  skill: string | null
  title: string
  description: string
  view: DashboardViewKind | null
  size: TileSize
  source: ComponentSource | null
  /** `refresh.max_age` as written, or the default. */
  maxAge: string
  /** `refresh.command` (`/run:<name>`), or null. */
  refreshCommand: string | null
  /** The params the owner can set, with their types and defaults; `{}` when invalid. */
  params: Record<string, { type: string; default?: unknown }>
  /** `prompts[]`: suggested questions the agent wrote (README D13); on the hover bar and as panel starters. */
  prompts: ComponentPrompt[]
  /** No error finding. Warnings never make a component invalid. */
  valid: boolean
  /** Every finding, errors first; empty when there is nothing to say. */
  findings: ComponentFinding[]
  /**
   * `requires_credentials` names the agent has not attached (README D16).
   * Non-empty means nothing runs: the card and tile say which, and link to
   * the agent's Credentials tab.
   */
  missingCredentials: string[]
}

/** The user's per-tile change to the component's refresh rule (D1: max-age and manual only). */
export interface TileRefreshOverride {
  /** Replaces `refresh.max_age`. */
  maxAge?: string
  /** Never recompute on its own once it has data; only on Refresh. */
  manual?: boolean
}

export interface DashboardDto {
  id: string
  name: string
  sortOrder: number
  tileCount: number
  createdAt: number
  updatedAt: number
}

export interface TileDto {
  id: string
  dashboardId: string
  agentManifestId: string
  component: string
  /** The skill that ships the component, or null for the agent's own. */
  skill: string | null
  /** The user's title, or null for the component's own. */
  title: string | null
  size: TileSize
  position: number
  params: Record<string, unknown>
  refreshOverride: TileRefreshOverride | null
}

/**
 * Whether a tile's component can be drawn:
 * - `ok`;
 * - `agent_missing` — no agent with that manifest id on this machine;
 * - `component_missing` — the agent has no such folder under `dashboards/`;
 * - `invalid` — the folder is there but its `component.json` has problems.
 */
export type TileComponentState = 'ok' | 'agent_missing' | 'component_missing' | 'invalid'

export interface TileView {
  tile: TileDto
  /** The title the tile shows: the user's, the component's, or its name. */
  displayTitle: string
  state: TileComponentState
  component: ComponentInfo | null
}

/**
 * A tile's data as main has it: the last good result (cached in the DB) and,
 * beside it, the last error. `data` survives a failure.
 */
export interface TileResultDto {
  tileId: string
  /** The last good result, or null when there has never been one (or it was too large to keep). */
  data: unknown
  /** When `data` was computed (epoch ms), or null. */
  fetchedAt: number | null
  /** The last run's failure, kept beside the data until a run succeeds. */
  error: string | null
  /** A run for these params is in flight. */
  refreshing: boolean
  /** `data` is older than the tile's max age. */
  stale: boolean
  /** The last result was over the cache's limit: it is shown now but not kept. */
  tooLarge: boolean
  /** The result's own one-line `notice`, which becomes the tile's mark. */
  notice: string | null
}

/** `after_turn`: main's own reason when a turn of the tile's agent ended (only where `refresh.after_turn` and a live lease). */
export type DashboardRefreshReason = 'visible' | 'manual' | 'after_turn'

/** Where a component sits: one row per tile showing it. */
export interface ComponentPlacement {
  component: string
  skill: string | null
  tileId: string
  dashboardId: string
  dashboardName: string
}

export type DashboardsErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'limit_reached'
  | 'component_invalid'
  | 'needs_identity'
  | 'not_kit_agent'

export type DashboardsOutcome<T> = ({ ok: true } & T) | { ok: false; code: DashboardsErrorCode; message: string }

/** A frame for a tile, or for a component that is not on a dashboard yet (Preview, the Add dialog). */
export type DashboardFrameTarget = { tileId: string } | { agentId: string; component: string; skill?: string | null }

export type DashboardFrameOutcome = DashboardsOutcome<{ token: string; url: string }>

export interface AddTileInput {
  /** An existing dashboard, or a name to create one with. */
  dashboardId?: string
  newDashboardName?: string
  agentId: string
  component: string
  /** The skill that ships it; omitted or null for the agent's own. */
  skill?: string | null
  title?: string | null
  size?: TileSize
  refreshOverride?: TileRefreshOverride | null
}

export interface UpdateTileInput {
  tileId: string
  title?: string | null
  size?: TileSize
  refreshOverride?: TileRefreshOverride | null
}

/** Main pushes this when a tile's data or refresh state changed. */
export const DASHBOARDS_TILE_CHANGED_CHANNEL = 'dashboards:tile-changed'
export interface DashboardsTileChangedPayload {
  tileId: string
}

/** The JSON-RPC protocol version the bridge answers `ui/initialize` with (MCP Apps). */
export const DASHBOARD_BRIDGE_PROTOCOL = '2026-01-26'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Params as a source receives them: the tile's values over each param's
 * default, with `current` (a month) and `today` (a date) resolved to a value,
 * so an endpoint never sees the words (schema `params[].default`). The tile
 * keeps the words, so "current" follows the calendar. Local time.
 */
export function resolveParamWords(
  params: Record<string, unknown>,
  specs: Record<string, { type: string; default?: unknown }>,
  now = new Date()
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(specs)) if (spec.default !== undefined) out[name] = spec.default
  Object.assign(out, params)
  const types: Record<string, string> = Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, spec.type]))
  for (const [name, value] of Object.entries(out)) {
    if (types[name] === 'month' && value === 'current') out[name] = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
    if (types[name] === 'date' && value === 'today') out[name] = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }
  return out
}

/**
 * A component reference (README §5.5, `x-references` in the schema):
 * `cinna://component/<agent>/<name>` or `cinna://component/<agent>/<skill>/<name>`,
 * where `<agent>` is `id:<manifest id>`, `bundle:<bundle id>` or a bare slug.
 * The prefix is always written; a form is never guessed from its shape.
 * Parsed by `shared/componentReference.ts`.
 */
export type ComponentReferenceAgent =
  | { kind: 'id'; value: string }
  | { kind: 'bundle'; value: string }
  | { kind: 'slug'; value: string }

export interface ComponentReference {
  /** The reference as written, for Copy and for the fallback text. */
  raw: string
  agent: ComponentReferenceAgent
  skill: string | null
  name: string
}

/**
 * Why a reference has no component here, as data (ux rule 9: never a broken link):
 * - `agent_not_here` — no local agent has that id or slug;
 * - `bundle_not_installed` — no local agent records that bundle id;
 * - `ambiguous` — two agents match and the chat's own is neither;
 * - `gone` — the agent is here but has no such component (or skill);
 * - `not_in_this_copy` — a bundle install that lacks it (an older copy);
 * - `not_kit_agent` — the agent is a legacy one with no `dashboards/`.
 */
export type ComponentReferenceMiss =
  | 'agent_not_here'
  | 'bundle_not_installed'
  | 'ambiguous'
  | 'gone'
  | 'not_in_this_copy'
  | 'not_kit_agent'

export interface ResolveReferenceInput {
  /** The reference as written. Main parses it again; the renderer's parse is for rendering only. */
  reference: string
  /** The agent whose chat shows the reference; it wins a clash. */
  chatAgentId?: string | null
}

export type ComponentReferenceResolution =
  | {
      found: true
      component: ComponentInfo
      placements: ComponentPlacement[]
      /** The reference Copy writes: the bundle form when the agent has a bundle id, else the id form. */
      canonicalReference: string
    }
  | {
      found: false
      reason: ComponentReferenceMiss
      /** The agent's name when it is known (`gone`, `not_in_this_copy`, `not_kit_agent`). */
      agentName: string | null
      /** The agent's row id, for links to its page (`gone`, `not_in_this_copy`). */
      agentId: string | null
      /** For `bundle_not_installed`: the renderer looks the name up in the catalog. */
      bundleId: string | null
    }

/** A malformed reference never reaches main as a card; this is main's answer if one does. */
export type ResolveReferenceOutcome = DashboardsOutcome<{ resolution: ComponentReferenceResolution }>

/**
 * The dashboard context (README D7, §5.6): what the user sees, assembled by the
 * renderer from the panel's dashboard and focused tile, shown as the composer's
 * chip, and sent beside a panel message as `RunSendPayload.dashboardContext`.
 * Main validates it, caps `focused.summary` and the whole block at
 * `DASHBOARD_CONTEXT_MAX_CHARS`, and adds it to the turn as a wire-only
 * `<dashboard_context>` section — never persisted, sent in full on a
 * session's first message and then only when it changed. It is data, never
 * instructions: tiles show untrusted text.
 */
export interface DashboardContext {
  dashboardId: string
  /** The dashboard's name, as the user sees it. */
  dashboard: string
  focused: {
    tileId: string
    component: string
    skill: string | null
    /** The tile's display title. */
    title: string
    params: Record<string, unknown>
    /** Selected row/item ids (native views) or the page's `setContext` selection. */
    selection: string[]
    /** "12 min", or null when the tile has no data yet. */
    dataAge: string | null
    /** The first rows / the metrics / the page's `setContext` summary; capped. */
    summary: string
  }
  /** Other tiles of the focused tile's agent on this dashboard, by title. */
  alsoYours: string[]
  /** Tiles of other agents, as "Title (Agent name)"; never their data. */
  otherTiles: string[]
}

/** The cap on the context's summary, and on the whole serialized block. */
export const DASHBOARD_CONTEXT_MAX_CHARS = 8_000

/**
 * The panel's chat for (dashboard, agent) (README D12): one session per agent
 * per dashboard. The latest such chat is resumed; `fresh` starts a new one
 * ("New chat"). The chat is an ordinary chat bound to the agent, with
 * `originDashboardId` set, listed in Chats with a "From dashboard" pill.
 */
export interface PanelChatInput {
  dashboardId: string
  /** The focused tile's agent (row id, `folder:<manifest id>`). */
  agentId: string
  fresh?: boolean
}

export type PanelChatOutcome = DashboardsOutcome<{ chatId: string }>
