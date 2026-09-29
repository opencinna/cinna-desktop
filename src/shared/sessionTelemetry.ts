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
  }
  totals: {
    tokens: TokenTally
    costUsd?: number
    costSource: 'runtime' | 'estimated'
    turns: number
    /** `last_request` once any counted turn was: the token totals are then a lower bound. */
    tokenScope: TokenScope
    byModel: Record<string, TokenTally & { costUsd?: number }>
    /** Per ACP session id. Kept for later; not shown. */
    bySession: Record<string, SessionTelemetrySessionTotals>
  }
  cache: {
    lastRequestAt?: number
    ttlMs?: number
    ttlSource: 'observed' | 'assumed'
    expiresAt?: number
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
}

/** One finished turn, counted once. */
export interface SessionTelemetryTurnChange {
  type: 'turn'
  engine: TelemetryEngine
  sessionId: string
  message: MessageTelemetry
  /** Tokens per model, subagents' models included. */
  byModel?: Record<string, TokenTally>
  selectedModel?: string
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

/**
 * The port a driver receives in its deps. Drivers report; the one thing they
 * read back is a session's last cost reading, which the runtime carries
 * across a restart and this app must measure the next reading against.
 */
export interface SessionTelemetryReporter {
  report(chatId: string, change: SessionTelemetryChange): void
  /** The last `cost.amount` recorded for the chat's ACP session, if any. */
  lastCostReading?(chatId: string, sessionId: string): number | undefined
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
