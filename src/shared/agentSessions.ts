/**
 * Which agents are already working in a session right now — a chat whose turn
 * is running, typed or dispatched. Several sessions on one local agent may run
 * side by side; whether they conflict is the user's call, and the surfaces that
 * start one more only warn (`AgentActiveSessionNotice`).
 *
 * Pure type module plus constants: imported from main, preload and the renderer.
 */

/** One running session: the chat a turn holds now, and the agent answering in it. */
export interface AgentActiveSession {
  agentId: string
  chatId: string
  /** The chat's title; null while it still has none (empty, or the default "New Chat"). */
  title: string | null
  /** Epoch milliseconds the turn took the chat, when main saw it open. */
  startedAt?: number
}

/**
 * `agentSessions:active`. The active profile's running sessions, newest first.
 * Returned as data: a thrown `DomainError.code` does not survive the bridge.
 */
export type AgentActiveSessionsResult =
  | { ok: true; sessions: AgentActiveSession[] }
  | { ok: false; code: 'not_activated'; message: string }

/** Pushed by main whenever a turn or a task runner takes or lets go of a chat; the renderer re-reads on it. */
export const AGENT_SESSIONS_CHANGED_CHANNEL = 'agentSessions:changed'
