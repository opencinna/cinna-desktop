/**
 * Shared payload shapes for the streaming IPC channels. These channels use
 * `ipcRenderer.postMessage` (not `invoke`) because they carry a MessagePort,
 * so the payload arrives as a single argument to the handler — keeping it as
 * a named-field object instead of a positional array prevents foot-guns when
 * fields are added later.
 */

import type { MessageAttachment } from './attachments'

/**
 * One user message, sent without saying who answers it.
 *
 * `run:send` replaced `agent:send-message` and `llm:send-message` in phase 4 of
 * the agent runtime plan. The two channels existed because the *renderer*
 * decided the destination — it read `chat.agentId && !chat.orchestrated` and
 * picked a channel — which meant the routing rule lived in the composer and had
 * to be re-derived by everything else that wanted to know it. Main resolves it
 * now, from `chats.router`, and the two old channels are thin forwards onto
 * this one for one phase.
 */
export interface RunSendPayload {
  chatId: string
  content: string
  /**
   * File attachments to ship with this user turn. Persisted on the user message
   * either way; what happens to them next depends on who answers (the Cinna
   * backend's file ids for an agent, provider-native content blocks for the
   * model).
   */
  attachments?: MessageAttachment[]
  /**
   * The agent this message addresses, in a `human`-routed chat — the user's own
   * gesture in the composer, which is the one input main cannot derive from the
   * chat row. Ignored by every other router, and ignored here too if it names
   * an agent the chat is not carrying. Absent means "whoever answered last".
   */
  addressedAgentId?: string | null
}

export interface AgentSendPayload {
  agentId: string
  chatId: string
  content: string
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
  /**
   * File attachments to ship with this user turn. Persisted on the user
   * message and resolved by the chat-streaming service into provider-native
   * content blocks (image inputs for vision-capable models). Provider/model
   * combos without file support drop the attachments silently — the badge
   * is gated upstream by `llm:get-model-capability`.
   */
  attachments?: MessageAttachment[]
}
