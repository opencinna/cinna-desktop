/**
 * Shared payload shapes for the streaming IPC channels. These channels use
 * `ipcRenderer.postMessage` (not `invoke`) because they carry a MessagePort,
 * so the payload arrives as a single argument to the handler — keeping it as
 * a named-field object instead of a positional array prevents foot-guns when
 * fields are added later.
 */

import type { MessageAttachment } from './attachments'

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
  /**
   * File attachments to ship with this user turn. Persisted on the user
   * message (so the bubble can re-render badges from history) and forwarded
   * to the Cinna backend via A2A message `metadata.cinna_file_ids`.
   */
  attachments?: MessageAttachment[]
}

export interface LlmSendPayload {
  chatId: string
  content: string
  /** Catch-up replay packet to prepend to wire content. Empty when unused. */
  catchupPacket?: string
  /**
   * File attachments to ship with this user turn. Persisted on the user
   * message and resolved by the chat-streaming service into provider-native
   * content blocks (image inputs for vision-capable models). Provider/model
   * combos without file support drop the attachments silently — the badge
   * is gated upstream by `llm:get-model-capability`.
   */
  attachments?: MessageAttachment[]
}
