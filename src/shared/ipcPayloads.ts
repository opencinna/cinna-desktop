/**
 * Shared payload shape for invoke-based run:start and port-based run:send.
 * The latter uses ipcRenderer.postMessage because it carries a MessagePort,
 * so the payload arrives as a single argument to the handler — keeping it as
 * a named-field object instead of a positional array prevents foot-guns when
 * fields are added later.
 */

import type { MessageAttachment } from './attachments'

/**
 * One user message for run:start or the generic run:send port interface.
 * Main resolves the recipient from chats.router; addressing is the user's
 * explicit gesture in a human-routed chat.
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

/**
 * What `run:start` did with a message. A chat with a turn already running
 * either takes it into that turn (`injected`, where the engine supports it) or
 * holds it in main until the turn ends (`queued`).
 */
export type RunStartResult =
  | { kind: 'started'; runId: string }
  /**
   * `saved`: the engine took the message only after the turn's rows were
   * saved, so main saved it as a row of its own — possibly after a view had
   * already refetched the chat, which then has to read it again.
   */
  | { kind: 'injected'; saved?: true }
  | { kind: 'queued'; queuedId: string }

/** One message waiting for the chat's running turn to end. Text only. */
export interface RunQueueItem {
  id: string
  content: string
  createdAt: number
}

/**
 * A chat's queue. `held` means the turn ended without finishing (stopped,
 * failed, out of budget): nothing is sent, and the composer takes the items
 * back.
 */
export interface RunQueueView {
  items: RunQueueItem[]
  held: boolean
}

/** Main → renderer: a chat's queue changed. Payload `{ chatId, view }`, `view` being the queue as it now stands. */
export const RUN_QUEUE_CHANGED_CHANNEL = 'run:queue-changed'
