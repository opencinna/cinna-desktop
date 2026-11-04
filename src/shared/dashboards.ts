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

/**
 * One param the owner can set (`params.<name>` in component.json). Native
 * views draw a control per param in a fixed filter row (D4): `enum` a select
 * of `values`, `month` a month picker, `date` / `date_range` date inputs,
 * `text`, `number`, `boolean`.
 */
export interface ComponentParamSpec {
  type: string
  label?: string
  default?: unknown
  /** `enum` only. */
  values?: string[]
}

/** `refresh` as the component states it, defaults applied. */
export interface ComponentRefreshRule {
  maxAge: string
  /** Recompute this often while the tile is on screen (≥ 1m), or null. */
  whileOpenEvery: string | null
  afterTurn: boolean
  onAppStart: boolean
  /** `/run:<name>`, or null. */
  command: string | null
  /** The agent schedule that feeds this tile (its runs write the data the source reads), or null. */
  schedule: string | null
}

/** One suggested question: `label` on the button, `prompt` the text sent. */
export interface ComponentPrompt {
  label: string
  prompt: string
}

/**
 * Where a cloud component or tile lives (D6): one of the profile's own agents
 * on its Cinna server. Present only for cloud ones; absent means a folder
 * agent on this computer. The renderer never sees core's dashboard or block
 * ids, a frame cap or a URL on the server.
 */
export interface CloudOrigin {
  /** The core agent's id (the remote agent row's `remoteTargetId`). */
  remoteAgentId: string
  /** The server's host as the user knows it (`cinna.example.com`), for "Can't reach <server>.". */
  server: string
}

/** A cloud tile is on a dashboard backed by one core dashboard; core caps its blocks at this. */
export const MAX_CLOUD_TILES_PER_DASHBOARD = 20

/** Without core's events (offline, no socket), an on-screen cloud tile re-reads its data this often. */
export const CLOUD_TILE_POLL_MS = 30_000

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
  params: Record<string, ComponentParamSpec>
  /** The component's own refresh rule, for Edit tile and the tile's hover line (the tile override wins). */
  refresh: ComponentRefreshRule
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
  /**
   * Set for a component of a cloud agent (D6). Then `agentId` is the remote
   * agent's row id, `manifestId` is `''`, and `findings`, `params`, `refresh`
   * and `prompts` come from core's component list (its `component_json`).
   * `missingCredentials` is what core's last tile data said, else `[]`.
   */
  cloud?: CloudOrigin
}

/** The user's per-tile change to the component's refresh rule (Edit tile). Absent fields keep the component's. */
export interface TileRefreshOverride {
  /** Replaces `refresh.max_age`. */
  maxAge?: string
  /** Never recompute on its own once it has data; only on Refresh. */
  manual?: boolean
  /** Replaces `refresh.while_open_every`; null turns it off. */
  whileOpenEvery?: string | null
  /** Replaces `refresh.after_turn`. */
  afterTurn?: boolean
  /** Replaces `refresh.on_app_start`. */
  onAppStart?: boolean
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
  /** The folder agent's manifest id; `''` for a cloud tile. */
  agentManifestId: string
  /**
   * Set for a cloud tile (D6). Its `params` mirror core's stored set (core
   * owns them); its `refreshOverride` is sent to core's block config, where
   * `manual` and `onAppStart` mean nothing (core has no launch warm-up, and
   * Manual is kept on this side only: main never asks core to recompute it on
   * its own).
   */
  cloud?: CloudOrigin
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
 * - `invalid` — the folder is there but its `component.json` has problems;
 * - `wrong_server` — a cloud tile made while the profile was signed in to
 *   another server: "Not on this server." with Remove; nothing runs.
 *
 * For a cloud tile, `agent_missing` means the remote agent is no longer in the
 * synced list or core answered `not_found` for it: "<agent> is no longer
 * available." with Remove (D6.10).
 */
export type TileComponentState = 'ok' | 'agent_missing' | 'component_missing' | 'invalid' | 'wrong_server'

export interface TileView {
  tile: TileDto
  /** The title the tile shows: the user's, the component's, or its name. */
  displayTitle: string
  state: TileComponentState
  /**
   * For a cloud tile, the component as core last described it (cached in
   * main, so a tile draws offline), or null before main has ever read it.
   */
  component: ComponentInfo | null
  /** The agent's display name even when `component` is null (a gone agent, a cloud tile not read yet); null when unknown. */
  agentName?: string | null
  /** The schedule that feeds the tile (`refresh.schedule`), as it stands on this device; null when none. */
  schedule: TileScheduleState | null
}

/**
 * A schedule-fed tile (D4): the tile re-reads when that schedule's run
 * completes; Refresh only re-reads. A schedule that is off on this device
 * (schedules run only after the device opts in) is said, never silent:
 * "Fed by <name>, which is off on this device" with Turn on… → the agent's
 * Schedules tab.
 */
export interface TileScheduleState {
  name: string
  /** The schedule exists in the agent's manifest. */
  exists: boolean
  /** It runs on this device. */
  onThisDevice: boolean
  /** Epoch ms of its next run here, or null (off, or unknown). */
  nextRunAt: number | null
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
  /**
   * A cloud tile's state beyond the data (D6). `data`, `fetchedAt` and
   * `stale` are core's (mirrored in main's cache, so they survive offline);
   * `error` is core's `mark`, or main's own failure sentence.
   */
  cloud?: CloudTileStatus
}

/**
 * Why a cloud tile cannot be brought up to date just now (D6.10). The cached
 * data always stays on the tile; the mark says why, in `message`, which main
 * writes with the agent and server names filled in. The renderer adds the
 * action by code:
 * - `unreachable` — "Can't reach <server>."; an html tile shows it with Retry
 *   in place of the frame;
 * - `reauth_required` — "Sign in to <server> again." → the Cinna settings;
 * - `agent_gone` — "<agent> is no longer available." → Remove;
 * - `waking` — "Waking <agent>…": a refresh that wakes the environment is in flight;
 * - `env_unavailable` — "<agent>'s environment isn't running.";
 * - `adapter_unsupported` — core's sentence (rebuild the environment);
 * - `needs_credentials` — "Needs the <name> credential" → the agent's page;
 * - `rate_limited` — the D4 sentence.
 */
export type CloudTileMarkCode =
  | 'unreachable'
  | 'reauth_required'
  | 'agent_gone'
  | 'waking'
  | 'env_unavailable'
  | 'adapter_unsupported'
  | 'needs_credentials'
  | 'rate_limited'

export interface CloudTileStatus {
  mark: { code: CloudTileMarkCode; message: string } | null
  /** The params core computed with (`params_resolved`), shown on the tile instead of resolving words here. */
  paramsResolved: Record<string, unknown>
  /** Core's credential names when it answered `needs_credentials` or listed `missing_credentials`. */
  missingCredentials: string[]
}

/**
 * Why a tile is asked to be fresh. Only `visible` and `manual` come from the
 * renderer; the rest are main's own: `after_turn` (a turn of its agent ended),
 * `interval` (`while_open_every` while leased), `launch` (the `on_app_start`
 * warm-up), `params` (its params changed), `schedule` (its feeding schedule ran).
 */
export type DashboardRefreshReason = 'visible' | 'manual' | 'after_turn' | 'interval' | 'launch' | 'params' | 'schedule'

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
  /** `tools/call` above `DASHBOARD_CALLS_PER_MINUTE` for its tile or preview frame. */
  | 'rate_limited'
  /** A `requires_credentials` slot is not ready: nothing ran. */
  | 'needs_credentials'
  /** The endpoint ran (or was stopped) and gave no value: timeout, non-zero exit, not JSON, too large, busy, replaced. */
  | 'call_failed'
  /**
   * Cloud (D6) only, never passed on to a page (a page sees `call_failed`,
   * addendum §3): the server did not answer; the session needs a new sign-in;
   * the agent's environment is not running or cannot run components; the
   * agent is not the profile's own (D6.9); the dashboard was made on another server.
   */
  | 'unreachable'
  | 'reauth_required'
  | 'env_unavailable'
  | 'adapter_unsupported'
  | 'not_owner'
  | 'wrong_server'

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

/**
 * Main pushes this when an agent's `dashboards_update_tile` set or cleared a
 * tile's highlight (`ids: []` clears). The highlight lives in main, in memory,
 * until the owner selects something on the tile or the app quits.
 */
export const DASHBOARDS_TILE_HIGHLIGHT_CHANNEL = 'dashboards:tile-highlight'
export interface DashboardsTileHighlightPayload {
  tileId: string
  ids: string[]
}

/** The `cinna/collect-context` answer of core's bridge (contract 1.20.0). */
export interface CollectedPageContext {
  /** `set_context`: the page's last `setContext`; `collected`: read from its microdata and text selection. */
  source: 'set_context' | 'collected'
  summary: string
  selection: string[]
  visible: string[]
  microdata: Array<{ id?: string; type?: string; properties: Record<string, unknown> }>
  /** At most 2,000 characters. */
  selected_text: string
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
 * - `not_kit_agent` — the agent is a legacy one with no `dashboards/`;
 * - `not_owner` (D6.9) — a cloud agent the profile does not own (shared,
 *   identity, app route): "Only <agent>'s owner can add its components to a
 *   dashboard.", no Add;
 * - `unreachable` (D6) — the reference names a cloud agent and the server
 *   did not answer; the card says so and can be tried again.
 *
 * Resolution order for `bundle:` (D6.8): the chat's own agent, then a local
 * agent, then the profile's own cloud agent with that bundle id. `id:` and
 * slug forms reach a cloud agent only when it is the chat's own agent.
 */
export type ComponentReferenceMiss =
  | 'agent_not_here'
  | 'bundle_not_installed'
  | 'ambiguous'
  | 'gone'
  | 'not_in_this_copy'
  | 'not_kit_agent'
  | 'not_owner'
  | 'unreachable'

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
 * A cloud agent's components (D6.8, its Dashboards tab and the Add dialog),
 * from core's `GET /agents/{id}/dashboards/`, which never wakes anything.
 * `placements` are this profile's desktop tiles showing them. Refusals:
 * `not_owner`, `unreachable`, `reauth_required`, `not_found`.
 */
export type CloudComponentsOutcome = DashboardsOutcome<{ components: ComponentInfo[]; placements: ComponentPlacement[] }>

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
    /** Text the owner selected inside a web view (`cinna/collect-context`), at most 2,000 chars. */
    selectedText?: string
  }
  /** Other tiles of the focused tile's agent on this dashboard, by title. */
  alsoYours: string[]
  /** Tiles of other agents, as "Title (Agent name)"; never their data. */
  otherTiles: string[]
}

/** The cap on the whole serialized `<dashboard_context>` block (the same in cinna-core). */
export const DASHBOARD_CONTEXT_MAX_CHARS = 12_000

/** The cap on the focused tile's summary inside the block. */
export const DASHBOARD_CONTEXT_SUMMARY_MAX_CHARS = 8_000

/**
 * The panel's chat for (dashboard, agent) (README D12): one session per agent
 * per dashboard. The latest such chat is resumed; `fresh` starts a new one
 * ("New chat"). The chat is an ordinary chat bound to the agent, with
 * `originDashboardId` set, listed in Chats with a "From dashboard" pill.
 *
 * For a cloud agent (D6.6) the chat is a remote-agent chat continuing the
 * core session `POST /dashboards/{backing}/chat` gave (`fresh` → `new: true`);
 * its `dashboardContext` travels as A2A `message.metadata.cinna_dashboard_context`,
 * never in the message text. Refusals add `unreachable` and `reauth_required`.
 */
export interface PanelChatInput {
  dashboardId: string
  /** The focused tile's agent (row id: `folder:<manifest id>`, or the remote agent's row id for a cloud tile). */
  agentId: string
  fresh?: boolean
}

export type PanelChatOutcome = DashboardsOutcome<{ chatId: string }>

/** At most this many `tools/call`s per minute per tile (or per preview frame); above it the page gets a refusal. */
export const DASHBOARD_CALLS_PER_MINUTE = 30

/**
 * `cinna.call(endpoint, params)` / `tools/call` from a component's page (D4):
 * one of the component's own endpoints, run once, never cached — a
 * drill-down. Main checks the endpoint exists in the spec, the rate limit,
 * credentials and the timeout; the newest call per (frame, endpoint) wins.
 */
export interface DashboardCallInput {
  target: DashboardFrameTarget
  endpoint: string
  params?: Record<string, unknown>
}

/** The endpoint's JSON value, or a refusal/failure the page receives as an `isError` result. */
export type DashboardCallOutcome = DashboardsOutcome<{ value: unknown }>

/**
 * `cinna.setParams` / `cinna/params-changed`, or a native filter control:
 * main validates each value against the component's params (unknown names
 * dropped, a bad value refused), persists them on the tile, and recomputes
 * it (reason `params`); the result arrives as a tile change.
 */
export interface SetTileParamsInput {
  tileId: string
  params: Record<string, unknown>
}
