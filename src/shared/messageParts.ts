/**
 * Shared message-part contract used across the main process (DB, IPC, A2A
 * accumulator) and the renderer (store, hooks, components).
 *
 * Each assistant message can be persisted as either:
 *  - a plain `content` string (LLM chats, legacy A2A messages), or
 *  - a structured `MessagePart[]` list (A2A agent messages where the server
 *    tags each TextPart with `metadata['cinna.content_kind']`).
 *
 * Keep this file purely type-only — it is imported from both Electron
 * processes and must not pull in any runtime dependencies.
 */

export type ContentKind = 'text' | 'thinking' | 'tool'

export interface MessagePart {
  kind: ContentKind
  text: string
  /** Set only when `kind === 'tool'`; comes from `metadata['cinna.tool_name']`. */
  toolName?: string
}
