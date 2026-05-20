/**
 * Persistent file-attachment DTO — the shape that travels over IPC and
 * lives on the `messages.attachments` JSON column. Two backing stores:
 *
 *  - `cinna` — `id` is the Cinna backend file UUID. Bytes live on the
 *    user's Cinna server. Used by remote-agent (A2A) sends.
 *  - `local` — `id` is the row id in the local `chat_files` table.
 *    Bytes live under `userData/files/...`. Used by raw-LLM chats.
 *
 * `source` is optional so historical rows (pre-feature) read as
 * Cinna-sourced, preserving the existing remote-agent download path.
 */
export interface MessageAttachment {
  id: string
  filename: string
  size: number
  mimeType: string
  source?: 'cinna' | 'local'
}

/**
 * Composer-only state — paths the user has picked or dropped but
 * haven't been ingested yet. Used by the new-chat composer because
 * scope (Cinna vs local) isn't known until the destination is picked.
 *
 * `id` carries the absolute OS path (not a UUID); `mimeType` / `size`
 * come from a `stat()` + extension probe so badges can render
 * immediately. At send time, `useNewChatFlow.startNewChat` calls
 * `files.ingestPaths` with these paths and swaps them for real
 * {@link MessageAttachment}s — pending values never reach a message
 * row, the download path, or any provider adapter.
 */
export interface PendingAttachment {
  id: string
  filename: string
  size: number
  mimeType: string
  source: 'pending'
}

/** Anything the composer's pending list can hold. */
export type ComposerAttachment = MessageAttachment | PendingAttachment

export function isPendingAttachment(a: ComposerAttachment): a is PendingAttachment {
  return a.source === 'pending'
}
