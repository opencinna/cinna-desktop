/**
 * Shared payload shapes for the streaming IPC channels. These channels use
 * `ipcRenderer.postMessage` (not `invoke`) because they carry a MessagePort,
 * so the payload arrives as a single argument to the handler — keeping it as
 * a named-field object instead of a positional array prevents foot-guns when
 * fields are added later.
 */

export interface AgentSendPayload {
  agentId: string
  chatId: string
  content: string
  /** Catch-up replay packet to prepend to wire content. Empty when unused. */
  catchupPacket?: string
  /** Smart Rewrite output (persisted on the user message). */
  rewrittenText?: string | null
  /** User's literal pre-rewrite text (persisted on the user message). */
  originalText?: string | null
}

export interface LlmSendPayload {
  chatId: string
  content: string
  /** Catch-up replay packet to prepend to wire content. Empty when unused. */
  catchupPacket?: string
}
