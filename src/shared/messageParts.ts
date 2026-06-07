/**
 * Shared message-part contract used across the main process (DB, IPC, A2A
 * accumulator) and the renderer (store, hooks, components).
 *
 * Each assistant message can be persisted as either:
 *  - a plain `content` string (LLM chats, legacy A2A messages), or
 *  - a structured `MessagePart[]` list (A2A agent messages where the server
 *    tags each TextPart with `metadata['cinna.content_kind']`).
 *
 * The `notice` kind is special: it never appears inside an assistant
 * message's `parts[]`. Notice TextParts are routed by the A2A streaming
 * service to a separate `role: 'agent_transition'` row so they read as
 * system messages in the transcript and are excluded from catch-up replay
 * and LLM history rebuilds.
 *
 * The `command_result` kind carries the synchronous output of a platform
 * slash-command (e.g. `/files`, `/agent-status`, `/run:<name>`). It IS the
 * substantive answer to the user's turn — the agent stream did not run —
 * so it is persisted into the assistant message's `parts[]` and contributes
 * to `messages.content` (for chat previews / titles / search). Rendered in
 * a terminal-style block to signal "platform output, not LLM voice".
 *
 * The `file` kind carries an agent-authored file attachment delivered as a
 * native A2A `FilePart` (`metadata['cinna.content_kind'] = 'file'`). The agent
 * declares it with a `<cinna_attach>` tag; the Cinna backend materialises the
 * bytes into durable storage and references them by `cinna.file_id`. The part's
 * `text` is empty — the payload lives on the {@link MessagePartFile} `file`
 * field. Rendered inline as a downloadable badge at the tag's position in the
 * reply (mirrors how a user's own attachments render under their message).
 *
 * Keep this file purely type-only — it is imported from both Electron
 * processes and must not pull in any runtime dependencies.
 */

export type ContentKind =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'notice'
  | 'command_result'
  | 'file'

export type ToolStream = 'stdout' | 'stderr'

/**
 * Agent-attached file metadata carried on a `file`-kind {@link MessagePart}.
 * Sourced from the `cinna.file_*` metadata on an A2A `FilePart`. `fileId` is
 * the Cinna backend file UUID — the renderer builds a `cinna`-sourced
 * `MessageAttachment` from this and downloads via the OAuth bearer path
 * (`GET /api/v1/files/{fileId}/download`), never the signed `?token=` URI.
 */
export interface MessagePartFile {
  fileId: string
  filename: string
  mimeType: string
  size: number
}

export interface MessagePart {
  kind: ContentKind
  text: string
  /** Set only when `kind === 'tool'`; comes from `metadata['cinna.tool_name']`. */
  toolName?: string
  /** Structured tool arguments from `metadata['cinna.tool_input']`. */
  toolInput?: Record<string, unknown>
  /**
   * Pairing key from `metadata['cinna.tool_id']`. Present on `'tool'` parts
   * (identifies the call) and on `'tool_result'` parts (pairs the result back
   * to the originating call).
   */
  toolId?: string
  /** Only on `'tool_result'` parts: `'stdout' | 'stderr'`. */
  toolStream?: ToolStream
  /**
   * Verbatim slash invocation from `metadata['cinna.command_invocation']`.
   * Presence flags the part as originating from a cinna-core slash command
   * (not an LLM-initiated tool call). Carried on:
   *  - `'command_result'`: always set (synchronous platform commands).
   *  - `'tool'` / `'tool_result'`: set only when the pair was synthesized to
   *     wrap a `/run:*` execution; absent for LLM-initiated tool calls.
   */
  commandInvocation?: string
  /**
   * Set only when `kind === 'file'` — an agent-attached file (A2A FilePart).
   * `text` is empty for file parts; the badge renders from this metadata.
   */
  file?: MessagePartFile
}
