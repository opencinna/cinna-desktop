/**
 * Session telemetry: what a chat's agent session has cost and where its
 * context stands — the model that actually ran, tokens, cost, context window,
 * and which login paid.
 *
 * One model shared by main, preload and renderer. A provider (the ACP driver)
 * reads its runtime's usage reports into `SessionTelemetryChange`s and hands
 * them to a `SessionTelemetryReporter`; the main-process service folds them
 * into one `SessionTelemetry` per chat, persists it and pushes it.
 *
 * **No account identity crosses into this module.** An auth report carries a
 * kind, a label and a plan name — never an email, an organisation or a key.
 *
 * Derived values (price of the next message, warm or cold cache) are not
 * stored: they change with the clock and are computed where they are shown.
 */

export type AuthKind = 'subscription' | 'api_key' | 'gateway' | 'cloud' | 'none' | 'unknown'

export type TelemetryEngine = 'claude' | 'codex'

/**
 * Whether the engine's prompt-cache TTL is known, so the cache has an expiry,
 * a warm or cold state and invalidations. Claude's writes show their TTL;
 * Codex caches on its own with a TTL nobody reports.
 */
export const CACHE_TTL_KNOWN: Readonly<Record<TelemetryEngine, boolean>> = Object.freeze({ claude: true, codex: false })

export interface TokenTally {
  /** Uncached input. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
}

/**
 * How much of a turn its token counts cover.
 *
 * - `turn` — every request of the turn, subagents and compaction included (Claude).
 * - `last_request` — only the turn's last model request (`codex-acp` reports
 *   `tokenUsage.last`), so totals built from it are a lower bound.
 * - `none` — the runtime reported no tokens for the turn (a follow-up turn the
 *   agent started on its own: no prompt response). Only cost, if any.
 */
export type TokenScope = 'turn' | 'last_request' | 'none'

export interface SessionTelemetryAuth {
  kind: AuthKind
  /** Scrubbed of anything email-shaped. */
  label?: string
  plan?: string
}

export interface SessionTelemetrySessionTotals {
  tokens: TokenTally
  costUsd?: number
  turns: number
  /**
   * The session's last `usage_update.cost.amount` — a running total the
   * runtime restores when the session is resumed — so the first reading after
   * a restart is measured against it instead of counted whole.
   */
  lastCostReading?: number
  /**
   * The session's last `result.modelUsage[model].costUSD` per model (Claude's
   * raw stream) — running totals like {@link lastCostReading}, kept for the
   * same reason.
   */
  modelCostReadings?: Record<string, number>
  /**
   * A digest of the params the session was last set up under (cwd and MCP
   * servers; never the params themselves, which can hold secrets). A load
   * under another one rebuilt the session and invalidated its cache.
   */
  fingerprint?: string
}

/** Why a session's prompt cache went cold before its TTL ran out. */
export type CacheInvalidationReason = 'model_change' | 'session_params_change' | 'compaction' | 'new_session'

/**
 * A coarse split of the main agent's context (Claude's raw stream only).
 * `baseline` is the whole input of the session's first main-agent request
 * (system prompt, tools, memory, the first message); `conversation` is what
 * has been added since (`used − baseline`, never below 0).
 */
export interface ContextBreakdown {
  baseline: number
  conversation: number
}

export interface SessionTelemetry {
  chatId: string
  engine: TelemetryEngine
  auth: SessionTelemetryAuth
  model: {
    /** What the session's model option says (an alias for Claude). */
    selected?: string
    /** What actually answered, e.g. `claude-sonnet-5[1m]`. */
    resolved?: string
    source: 'init' | 'quota' | 'config'
  }
  context: {
    used: number
    size: number
    /**
     * False while `size` is the adapter's guess (Claude, before its first
     * result). Reset when the context's session or model changes.
     */
    sizeAuthoritative: boolean
    maxOutput?: number
    /** The ACP session the reading is from. */
    sessionId?: string
    /** The selected model the reading was taken under. */
    model?: string
    /** Absent without Claude's raw stream, and until the first request after a reset. */
    breakdown?: ContextBreakdown
    /** The next main-agent request sets `breakdown.baseline` (after a new session or a compaction). */
    awaitingBaseline?: boolean
  }
  totals: {
    tokens: TokenTally
    costUsd?: number
    costSource: 'runtime' | 'estimated'
    turns: number
    /** `last_request` once any counted turn was: the token totals are then a lower bound. */
    tokenScope: TokenScope
    byModel: Record<string, TokenTally & { costUsd?: number }>
    /** The last counted turn's tokens, for its cache hit ratio. */
    lastTurn?: TokenTally
    /** Per ACP session id. Kept for later; not shown. */
    bySession: Record<string, SessionTelemetrySessionTotals>
  }
  /**
   * The prompt cache (Claude only for TTL, expiry and invalidation; Codex
   * reports no TTL, so those stay unset for it). Warm or cold is derived at
   * read time (`sessionTelemetryDerived.ts`).
   */
  cache: {
    lastRequestAt?: number
    ttlMs?: number
    /** `observed` from the TTL of a main-agent request's cache writes; `assumed` 5m until one is seen. */
    ttlSource: 'observed' | 'assumed'
    /**
     * `lastRequestAt + ttlMs`. Approximate: the TTL runs from when the
     * request reached the API, and `lastRequestAt` is when its first frame
     * reached this app, a little later.
     */
    expiresAt?: number
    /** The cache went cold here, whatever the TTL says, until the next request writes it again. */
    invalidatedAt?: number
    invalidationReason?: CacheInvalidationReason
  }
  /** What Claude's `system/init` said. */
  runtime?: {
    cliVersion?: string
    betas?: string[]
    /** The effort applied; null when none is sent. */
    effort?: string | null
    /** `off`, `cooldown` or `on`. */
    fastMode?: string
  }
  rateLimit?: unknown
  updatedAt: number
}

/** Per assistant message, persisted on the row. */
export interface MessageTelemetry {
  model?: string
  tokens: TokenTally
  tokenScope: TokenScope
  costUsd?: number
  costSource: 'runtime' | 'estimated'
  requests?: number
  durationMs?: number
  apiDurationMs?: number
  contextUsedAfter?: number
}

/** Which login the runtime reported. Latest wins. */
export interface SessionTelemetryAuthChange {
  type: 'auth'
  engine: TelemetryEngine
  auth: SessionTelemetryAuth
}

/**
 * A context reading from the session's main agent (a `usage_update`), mid-turn
 * or at its end. Never adds to the totals: totals come only from `turn`.
 */
export interface SessionTelemetryContextChange {
  type: 'context'
  engine: TelemetryEngine
  sessionId: string
  used?: number
  size?: number
  /** The reading came with a cost: the adapter's size is authoritative from here. */
  costed: boolean
  /** That cost reading (`cost.amount`), kept per session to measure the next one against. */
  costReading?: number
  rateLimit?: unknown
  at: number
  /**
   * The raw stream timed this turn's requests ({@link SessionTelemetryRequestChange}),
   * so this reading does not move the cache clock.
   */
  cacheTimed?: boolean
}

/** One finished turn, counted once. */
export interface SessionTelemetryTurnChange {
  type: 'turn'
  engine: TelemetryEngine
  sessionId: string
  message: MessageTelemetry
  /** Tokens per model, subagents' models included. */
  byModel?: Record<string, TokenTally>
  /** The turn's cost per model: runtime deltas (Claude's raw `result`) or estimates (Codex). */
  byModelCost?: Record<string, number>
  /** The session's latest per-model cost readings (Claude's raw `result`), to keep. */
  modelCostReadings?: Record<string, number>
  /** The main model's window per the raw `result`: authoritative. */
  contextWindow?: number
  maxOutputTokens?: number
  selectedModel?: string
}

/** What Claude's raw `system/init` said about the session's runtime. */
export interface SessionTelemetryRuntimeChange {
  type: 'runtime'
  engine: TelemetryEngine
  sessionId: string
  /** The model the session runs. */
  model?: string
  cliVersion?: string
  betas?: string[]
  effort?: string | null
  fastMode?: string
  /**
   * The SDK's `apiKeySource`, mapped: `api_key` when a key is in use. It
   * refines an `unknown` login only; it never replaces a reported one.
   */
  authHint?: 'api_key'
}

/**
 * One main-agent model request (Claude's raw `assistant`, first frame of a
 * message). Never a subagent's.
 */
export interface SessionTelemetryRequestChange {
  type: 'request'
  engine: TelemetryEngine
  sessionId: string
  model?: string
  /** Input of the request: uncached plus cache read and write. */
  input: number
  cacheWrite5m: number
  cacheWrite1h: number
  at: number
}

/** Claude compacted the session's context (raw `compact_boundary`). */
export interface SessionTelemetryCompactionChange {
  type: 'compaction'
  engine: TelemetryEngine
  sessionId: string
  at: number
}

/** The turn's ACP session was created, or loaded under `fingerprint`. */
export interface SessionTelemetrySessionChange {
  type: 'session'
  engine: TelemetryEngine
  sessionId: string
  /** `session/new`: a new session, a cold cache and a new context baseline. */
  fresh: boolean
  /** Digest of the params (see {@link SessionTelemetrySessionTotals.fingerprint}). */
  fingerprint: string
  at: number
}

/** The session's model option changed (or was first reported). */
export interface SessionTelemetryModelChange {
  type: 'model'
  engine: TelemetryEngine
  selected: string
}

export type SessionTelemetryChange =
  | SessionTelemetryAuthChange
  | SessionTelemetryContextChange
  | SessionTelemetryTurnChange
  | SessionTelemetryModelChange
  | SessionTelemetryRuntimeChange
  | SessionTelemetryRequestChange
  | SessionTelemetryCompactionChange
  | SessionTelemetrySessionChange

/**
 * The port a driver receives in its deps. Drivers report; the one thing they
 * read back is a session's last cost reading, which the runtime carries
 * across a restart and this app must measure the next reading against.
 */
export interface SessionTelemetryReporter {
  report(chatId: string, change: SessionTelemetryChange): void
  /** The last `cost.amount` recorded for the chat's ACP session, if any. */
  lastCostReading?(chatId: string, sessionId: string): number | undefined
  /** The last per-model cost readings recorded for the chat's ACP session, if any. */
  lastModelCostReadings?(chatId: string, sessionId: string): Record<string, number> | undefined
}

/** Main → renderer: a chat's telemetry changed. */
export const SESSION_TELEMETRY_CHANGED_CHANNEL = 'session-telemetry:changed'

export interface SessionTelemetryChangedPayload {
  chatId: string
  telemetry: SessionTelemetry
}

/**
 * `sessionTelemetry:get`. `telemetry: null` for a chat with none yet. A chat the
 * active profile does not own answers as data, never as a throw.
 */
export type SessionTelemetryGetResult =
  | { ok: true; telemetry: SessionTelemetry | null }
  | { ok: false; code: 'chat_not_found' }

export const EMPTY_TOKEN_TALLY: Readonly<TokenTally> = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
