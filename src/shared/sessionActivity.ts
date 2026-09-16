/**
 * Session activity: the subagents and background processes a chat's agent
 * session is running, beside and between its turns.
 *
 * One engine-neutral model shared by main, preload and renderer. A provider
 * (a driver) maps its own messages into `SessionActivityChange`s and hands
 * them to a `SessionActivityReporter`; the main-process hub keeps the state
 * and pushes a `SessionActivitySnapshot` per chat. No engine or vendor names
 * belong in this module.
 *
 * Dates cross IPC as `Date` (structured clone keeps them), as `TaskDto` does.
 */

export type SessionActivityKind = 'subagent' | 'background'

/**
 * `lost` means the desktop can no longer see the item: its process exited or
 * was reaped, or the app restarted. It is never presented as completed.
 */
export type SessionActivityState = 'running' | 'completed' | 'failed' | 'stopped' | 'lost'

export type SessionActivityTerminalState = Exclude<SessionActivityState, 'running'>

export interface SessionActivityItem {
  /** Provider-scoped, unique within the chat. */
  id: string
  kind: SessionActivityKind
  /** Which agent of the chat owns it (multi-agent chats). */
  agentId: string
  /** Name or command; never empty. */
  title: string
  /** Task, description, or the last summary. */
  detail: string | null
  state: SessionActivityState
  startedAt: Date
  endedAt: Date | null
  /** Shown, not opened, in v1. */
  outputPath: string | null
  /** Whether the provider can stop it. Nothing renders it before Stop exists. */
  canStop: boolean
}

export interface SessionActivitySnapshot {
  chatId: string
  /** Running first (oldest start first), then ended (most recently ended first). */
  items: SessionActivityItem[]
}

/**
 * An item started or progressed. The first upsert for an id creates the item;
 * later ones merge only the fields they carry — an absent (`undefined`) or
 * `null` field never overwrites a known value. An upsert never moves an ended
 * item back to running.
 */
export interface SessionActivityUpsert {
  type: 'upsert'
  id: string
  kind: SessionActivityKind
  title?: string
  detail?: string | null
  outputPath?: string | null
  canStop?: boolean
}

/**
 * An item ended. A later end replaces an earlier terminal state (engines do
 * correct themselves: `stopped`, then `completed`). An end for an id the hub
 * has never seen creates nothing. `summary`, when given, replaces `detail`.
 */
export interface SessionActivityEnd {
  type: 'end'
  id: string
  state: SessionActivityTerminalState
  summary?: string | null
}

export type SessionActivityChange = SessionActivityUpsert | SessionActivityEnd

/**
 * The port a driver receives in its deps. Drivers report; they never read
 * the hub or know how the state reaches the renderer.
 */
export interface SessionActivityReporter {
  report(chatId: string, agentId: string, change: SessionActivityChange): void
}

/** Main → renderer: a chat's activity changed. */
export const SESSION_ACTIVITY_CHANGED_CHANNEL = 'session-activity:changed'

export interface SessionActivityChangedPayload {
  chatId: string
  snapshot: SessionActivitySnapshot
}

/**
 * `sessionActivity:get`. A chat the active profile does not own answers as
 * data, never as a throw.
 */
export type SessionActivityGetResult =
  | { ok: true; snapshot: SessionActivitySnapshot }
  | { ok: false; code: 'chat_not_found' }

/**
 * `sessionActivity:stop(chatId, itemId)` stops one running item. Why a stop did not happen. Answered as data, never thrown.
 *
 * - `already_ended` — the item had ended (or ended while the request ran).
 * - `not_stoppable` — nothing here can stop it (any more).
 * - `unavailable` — the agent's process did not answer in time, or is gone.
 * - `chat_not_found` — not a chat of the active profile, or it is trashed.
 */
export type SessionActivityStopFailure = 'already_ended' | 'not_stoppable' | 'unavailable' | 'chat_not_found'

export type SessionActivityStopResult =
  | { ok: true }
  | { ok: false; code: SessionActivityStopFailure; reason: string }

/** The sentence the renderer shows for each refusal. */
export const SESSION_ACTIVITY_STOP_REASONS: Record<SessionActivityStopFailure, string> = {
  already_ended: 'This process had already ended.',
  not_stoppable: 'This process can no longer be stopped from here.',
  unavailable: 'The agent did not answer. Try again in a moment.',
  chat_not_found: 'This chat is no longer available.'
}

export function sessionActivityStopRefusal(code: SessionActivityStopFailure): SessionActivityStopResult {
  return { ok: false, code, reason: SESSION_ACTIVITY_STOP_REASONS[code] }
}
