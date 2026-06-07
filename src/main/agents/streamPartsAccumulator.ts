/**
 * Accumulates A2A streaming text parts into a structured list, computing
 * per-part deltas and routing each delta to the renderer with its content kind.
 *
 * Each text Part may carry `metadata['cinna.content_kind']` ∈
 * {text, thinking, tool, tool_result, notice, command_result}.
 *
 * - `tool` parts also carry `cinna.tool_name`, optional `cinna.tool_input`,
 *   and `cinna.tool_id` (pairing key).
 * - `tool_result` parts carry `cinna.tool_id` (matching the originating tool
 *   part) and `cinna.tool_stream` ∈ {stdout, stderr}.
 * - `notice` parts are system-style transitions from the agent (e.g. the
 *   startup ping "Starting up the agent environment, this may take a
 *   moment..."). They are NEVER added to the assistant message's `parts[]`
 *   or `answerText` — instead, the caller iterates `snapshotNotices()` after
 *   the stream completes and persists each as a separate `agent_transition`
 *   row. Notice deltas still post to the port so the live UI can render
 *   them as streaming system messages.
 * - `command_result` parts carry the synchronous output of a platform
 *   slash-command (`/files`, `/agent-status`, `/run:<name>`, …). The agent
 *   stream did not run — the command_result IS the assistant turn — so it
 *   joins the assistant message's `parts[]` and contributes to `answerText()`
 *   so chat previews / titles / search show the command output.
 * - A2A `FilePart`s (`kind: 'file'`) are agent-authored file attachments. They
 *   carry no text — the file metadata lives on `cinna.file_*` — and are
 *   appended as `file` parts (deduped by `file_id`), rendered inline as a
 *   downloadable badge. They contribute nothing to `answerText()`.
 * - `cinna.command_invocation` (any kind): verbatim slash invocation, e.g.
 *   "/files" or "/run:rotate_status". Always set on `command_result` parts;
 *   set on `tool` / `tool_result` parts only when the pair was synthesized to
 *   wrap a `/run:*` execution (absent for LLM-initiated tool calls). Used by
 *   the renderer to wrap the affected blocks in a "Command: <invocation>"
 *   frame so the user sees a slash-command UI instead of bare tool plumbing.
 *
 * Merge rules:
 * - Consecutive `text` / `thinking` / `command_result` parts merge into one
 *   entry when the kind matches.
 * - Consecutive `tool` parts merge only when `toolName` matches.
 * - Consecutive `tool_result` parts merge only when `toolId` AND `toolStream`
 *   match — preserves interleaved stdout/stderr chronology as separate parts.
 * - `notice` parts never merge with surrounding parts; each unique
 *   `(messageId|artifactId, partIndex)` is one persisted notice row.
 *
 * `answerText()` returns concat of `text` and `command_result` parts — used as
 * the message preview/fallback content (`messages.content`).
 */
import type {
  ContentKind,
  MessagePart,
  MessagePartFile,
  ToolStream
} from '../../shared/messageParts'
import type { AgentDeltaEvent } from '../../shared/agentStreamEvents'
import { stripCinnaAttachTags } from '../../shared/cinnaAttach'

export const KIND_METADATA_KEY = 'cinna.content_kind'
export const TOOL_NAME_METADATA_KEY = 'cinna.tool_name'
export const TOOL_INPUT_METADATA_KEY = 'cinna.tool_input'
export const TOOL_ID_METADATA_KEY = 'cinna.tool_id'
export const TOOL_STREAM_METADATA_KEY = 'cinna.tool_stream'
export const COMMAND_INVOCATION_METADATA_KEY = 'cinna.command_invocation'
// Agent-attachment FilePart metadata (see backend a2a_event_mapper.py).
export const FILE_ID_METADATA_KEY = 'cinna.file_id'
export const FILE_NAME_METADATA_KEY = 'cinna.file_name'
export const FILE_MIME_METADATA_KEY = 'cinna.file_mime'
export const FILE_SIZE_METADATA_KEY = 'cinna.file_size'

const VALID_KINDS: readonly ContentKind[] = [
  'text',
  'thinking',
  'tool',
  'tool_result',
  'notice',
  'command_result',
  'file'
] as const
const VALID_STREAMS: readonly ToolStream[] = ['stdout', 'stderr'] as const

export interface PartLike {
  kind: string
  text?: string
  /** Present on A2A FileParts (`kind: 'file'`); `name`/`mimeType` fall back
   *  when the `cinna.file_*` metadata is absent. */
  file?: { uri?: string; name?: string; mimeType?: string } | null
  metadata?: Record<string, unknown> | null
}

export interface MessageLike {
  messageId: string
  parts: PartLike[]
}

export interface ArtifactLike {
  artifactId: string
  parts: PartLike[]
}

/**
 * Sender-side narrow view of the agent stream port — accepts only delta
 * events (the only shape the accumulator emits). Any `StreamPort` typed with
 * the wider `AgentStreamEvent` union is assignable here.
 */
export interface DeltaPort {
  postMessage: (msg: AgentDeltaEvent) => void
}

export function partKindOf(part: PartLike): ContentKind {
  const k = part.metadata?.[KIND_METADATA_KEY]
  if (typeof k === 'string' && (VALID_KINDS as readonly string[]).includes(k)) {
    return k as ContentKind
  }
  return 'text'
}

export function partToolNameOf(part: PartLike): string | undefined {
  const n = part.metadata?.[TOOL_NAME_METADATA_KEY]
  return typeof n === 'string' ? n : undefined
}

export function partToolInputOf(part: PartLike): Record<string, unknown> | undefined {
  const v = part.metadata?.[TOOL_INPUT_METADATA_KEY]
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return undefined
}

export function partToolIdOf(part: PartLike): string | undefined {
  const v = part.metadata?.[TOOL_ID_METADATA_KEY]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function partToolStreamOf(part: PartLike): ToolStream | undefined {
  const v = part.metadata?.[TOOL_STREAM_METADATA_KEY]
  if (typeof v === 'string' && (VALID_STREAMS as readonly string[]).includes(v)) {
    return v as ToolStream
  }
  return undefined
}

export function partCommandInvocationOf(part: PartLike): string | undefined {
  const v = part.metadata?.[COMMAND_INVOCATION_METADATA_KEY]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Read the agent-attachment metadata off an A2A FilePart. Returns `undefined`
 * (so the part is skipped) when there's no `cinna.file_id` — without it the
 * renderer can't route to the OAuth download path, and a bare signed URI isn't
 * something we surface. Name/mime fall back to the `file` field, then to
 * sensible defaults; size defaults to 0 when the backend omits it.
 */
export function partFileOf(part: PartLike): MessagePartFile | undefined {
  const meta = part.metadata ?? undefined
  const rawId = meta?.[FILE_ID_METADATA_KEY]
  if (typeof rawId !== 'string' || !rawId) return undefined
  const nameMeta = meta?.[FILE_NAME_METADATA_KEY]
  const mimeMeta = meta?.[FILE_MIME_METADATA_KEY]
  const sizeMeta = meta?.[FILE_SIZE_METADATA_KEY]
  const filename =
    (typeof nameMeta === 'string' && nameMeta) ||
    (typeof part.file?.name === 'string' && part.file.name) ||
    'attachment'
  const mimeType =
    (typeof mimeMeta === 'string' && mimeMeta) ||
    (typeof part.file?.mimeType === 'string' && part.file.mimeType) ||
    'application/octet-stream'
  const size = typeof sizeMeta === 'number' && sizeMeta >= 0 ? sizeMeta : 0
  return { fileId: rawId, filename, mimeType, size }
}

/**
 * Outcome of routing one A2A `FilePart`. Surfaced via
 * {@link StreamPartsAccumulatorOptions.onFile} so the host can trace agent
 * attachments — including the *dropped* ones, which otherwise leave no signal
 * for "my agent attached a file but nothing showed up" debugging.
 */
export interface AccumulatedFileEvent {
  status: 'attached' | 'duplicate' | 'skipped'
  fileId?: string
  filename?: string
  /** Set on `'skipped'` — why the part was dropped (e.g. missing file id). */
  reason?: string
}

export interface StreamPartsAccumulatorOptions {
  /**
   * Called once per (part, name+input) pair the first time a tool part is
   * received with structured input metadata. Lets the host (IPC handler) log
   * a friendly tool-call summary alongside the raw event dump.
   */
  onToolCall?: (call: { partKey: string; name: string; input: Record<string, unknown> }) => void
  /**
   * Called for every A2A `FilePart` the accumulator routes — `attached` (new
   * download badge), `duplicate` (deduped by file id; expected on replay), or
   * `skipped` (no usable `cinna.file_id`). Lets the host log attachment
   * outcomes since the accumulator itself stays logger-free.
   */
  onFile?: (event: AccumulatedFileEvent) => void
}

export interface AccumulatedNotice {
  /** Stable identifier per notice part — `(messageId|artifactId, partIndex)`. */
  partKey: string
  /** Final accumulated text for the notice. */
  text: string
}

export class StreamPartsAccumulator {
  private seenPartText = new Map<string, string>()
  private loggedToolCalls = new Set<string>()
  /**
   * File ids already appended as `file` parts. The backend may emit the same
   * attachment more than once (the same path declared twice shares one
   * `file_id`, and history replay re-sends every part), so we attach each
   * `file_id` exactly once — mirrors the backend's per-message dedup rule.
   */
  private seenFileIds = new Set<string>()
  private parts: MessagePart[] = []
  private answer = ''
  /**
   * Per-part-key accumulated text for `notice`-kind parts. Insertion order is
   * the stream-arrival order of each distinct notice part, which is what
   * `snapshotNotices()` returns — callers persist notices in that order to
   * keep transcript chronology stable.
   */
  private notices = new Map<string, string>()
  private readonly opts: StreamPartsAccumulatorOptions

  constructor(opts: StreamPartsAccumulatorOptions = {}) {
    this.opts = opts
  }

  ingestMessage(message: MessageLike, port: DeltaPort): void {
    this.ingest(`msg:${message.messageId}`, message.parts, port)
  }

  ingestArtifact(artifact: ArtifactLike, port: DeltaPort): void {
    this.ingest(`art:${artifact.artifactId}`, artifact.parts, port)
  }

  private ingest(idPrefix: string, parts: PartLike[] | undefined, port: DeltaPort): void {
    if (!Array.isArray(parts)) return
    parts.forEach((part, idx) => {
      // A2A FileParts (agent attachments) carry no text — the payload is on
      // `metadata['cinna.file_*']`. Route them through the file path and bail
      // before the text-delta logic, which assumes a growing `text` string.
      if (part.kind === 'file') {
        this.ingestFilePart(part, port)
        return
      }
      if (part.kind !== 'text' || typeof part.text !== 'string' || !part.text) return
      const key = `${idPrefix}:${idx}`
      const prior = this.seenPartText.get(key) ?? ''
      const text = part.text
      const delta = text.startsWith(prior) ? text.slice(prior.length) : text
      if (!delta) return
      this.seenPartText.set(key, text)
      const kind = partKindOf(part)

      // Notice parts are agent-side system messages (startup pings, env
      // transitions). They never become part of the assistant message — the
      // streaming service persists each notice as its own `agent_transition`
      // row after the stream completes. Live deltas still post to the port
      // so the renderer can show a streaming system block during startup.
      if (kind === 'notice') {
        this.notices.set(key, (this.notices.get(key) ?? '') + delta)
        port.postMessage({ type: 'delta', kind, text: delta })
        return
      }

      const isTool = kind === 'tool'
      const isToolResult = kind === 'tool_result'
      const toolName = isTool ? partToolNameOf(part) : undefined
      const toolInput = isTool ? partToolInputOf(part) : undefined
      const toolId = isTool || isToolResult ? partToolIdOf(part) : undefined
      // Backend coerces unknown values to 'stdout' server-side; default here
      // covers the absent-metadata case so the renderer always has a stream label.
      const toolStream: ToolStream | undefined = isToolResult
        ? partToolStreamOf(part) ?? 'stdout'
        : undefined
      // Presence flags this part as originating from a cinna-core slash
      // command (`/run:*` synthesized tool calls; all `command_result` parts).
      // Absent → LLM-initiated tool call, unchanged routing.
      const commandInvocation = partCommandInvocationOf(part)
      this.appendToList(kind, delta, toolName, toolInput, toolId, toolStream, commandInvocation)
      port.postMessage({
        type: 'delta',
        kind,
        text: delta,
        toolName,
        toolInput,
        toolId,
        toolStream,
        commandInvocation
      })

      if (toolName && toolInput && !this.loggedToolCalls.has(key)) {
        this.loggedToolCalls.add(key)
        this.opts.onToolCall?.({ partKey: key, name: toolName, input: toolInput })
      }
    })
  }

  /**
   * Append an agent-attached file as a `file` part and emit a `file` delta.
   * Deduped by `file_id` (see {@link seenFileIds}). File parts never merge —
   * each is a discrete attachment — and contribute nothing to `answerText`.
   */
  private ingestFilePart(part: PartLike, port: DeltaPort): void {
    const file = partFileOf(part)
    if (!file) {
      this.opts.onFile?.({ status: 'skipped', reason: 'missing cinna.file_id' })
      return
    }
    if (this.seenFileIds.has(file.fileId)) {
      this.opts.onFile?.({ status: 'duplicate', fileId: file.fileId, filename: file.filename })
      return
    }
    this.seenFileIds.add(file.fileId)
    this.parts.push({ kind: 'file', text: '', file })
    port.postMessage({ type: 'delta', kind: 'file', text: '', file })
    this.opts.onFile?.({ status: 'attached', fileId: file.fileId, filename: file.filename })
  }

  private appendToList(
    kind: ContentKind,
    delta: string,
    toolName?: string,
    toolInput?: Record<string, unknown>,
    toolId?: string,
    toolStream?: ToolStream,
    commandInvocation?: string
  ): void {
    const last = this.parts[this.parts.length - 1]
    const sameKind = last && last.kind === kind
    const mergeable =
      sameKind &&
      (kind === 'tool_result'
        ? last.toolId === toolId && last.toolStream === toolStream
        : last.toolName === toolName)
    if (last && mergeable) {
      last.text += delta
      // Backend may attach `tool_input` / `tool_id` / `command_invocation` only
      // on the first frame of a part — preserve once captured rather than
      // overwriting with undefined.
      if (toolInput && !last.toolInput) last.toolInput = toolInput
      if (toolId && !last.toolId) last.toolId = toolId
      if (commandInvocation && !last.commandInvocation) last.commandInvocation = commandInvocation
    } else {
      const next: MessagePart = { kind, text: delta }
      if (toolName) next.toolName = toolName
      if (toolInput) next.toolInput = toolInput
      if (toolId) next.toolId = toolId
      if (toolStream) next.toolStream = toolStream
      if (commandInvocation) next.commandInvocation = commandInvocation
      this.parts.push(next)
    }
    // `command_result` is the substantive answer for slash-command turns
    // (the agent stream did not run), so it joins `text` in the preview
    // string used for chat list snippets and title generation.
    if (kind === 'text' || kind === 'command_result') this.answer += delta
  }

  snapshotParts(): MessagePart[] {
    // Strip `<cinna_attach>` tags from text the agent streamed raw — the file
    // itself rides a separate `file` part / FilePart, so the literal tag must
    // not persist in the visible text. Only `text`-kind parts can carry it.
    return this.parts.map((p) =>
      p.kind === 'text' ? { ...p, text: stripCinnaAttachTags(p.text) } : p
    )
  }

  answerText(): string {
    // Cleaned for the `messages.content` column (chat preview / title / search).
    return stripCinnaAttachTags(this.answer)
  }

  /**
   * Notices ingested during this stream, in arrival order. Each entry is one
   * persisted `agent_transition` row. Returns an empty array when the agent
   * sent no notice-kind parts (the common case for non-Cinna agents and for
   * Cinna agents that don't emit startup pings).
   */
  snapshotNotices(): AccumulatedNotice[] {
    const out: AccumulatedNotice[] = []
    for (const [partKey, text] of this.notices) {
      if (text) out.push({ partKey, text })
    }
    return out
  }
}
