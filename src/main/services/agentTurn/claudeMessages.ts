/**
 * Turning the Claude Agent SDK's message stream into the A2A-shaped message the
 * rest of the pipeline already knows how to read.
 *
 * The sibling of `turnStream.ts`, solving the same problem for a different
 * source, and the same trap applies: `StreamPartsAccumulator` was built for
 * A2A, where every update carries each part's **full text so far** and the
 * accumulator computes the delta itself (`text.slice(prior.length)`). The SDK
 * emits **true deltas**. So this class does not translate an event into a part
 * — it maintains the *cumulative* message and hands the whole thing back for
 * re-ingestion. Feeding a raw SDK delta to the accumulator as if it were an A2A
 * part looks right for one chunk and duplicates every character after it.
 *
 * ## What the wire actually looks like
 *
 * Watched, not assumed — see `docs/agents/local_agents/claude_contract.md` §2.
 * For one tool-calling turn with `includePartialMessages: true`:
 *
 * ```
 * system/init                         apiKeySource, model, cli version
 * stream_event  message_start         ← the only place a message id appears
 * stream_event  content_block_start   {index, content_block:{type,name}}
 * stream_event  content_block_delta   {index, delta:{type:'text_delta'|'input_json_delta'|…}}
 * assistant     [one completed block] ← after that block's deltas, before its stop
 * stream_event  content_block_stop    {index}
 * user          [tool_result]         pairs by tool_use_id; carries no message id
 * result                              ends the turn
 * ```
 *
 * Three consequences shape everything below.
 *
 * **1. `assistant` is emitted per content block, not per message.** Each one
 * carries only the block that just completed (`content.length === 1` in every
 * observed case). It is not a snapshot of the message, so it cannot simply be
 * ingested as one.
 *
 * **2. Only `message_start` names the message.** Every `content_block_*` event
 * carries a bare `index`, so part identity has to be `(current message id,
 * index)` — tracked here, because nothing on the wire repeats it.
 *
 * **3. The union is far wider than the kinds handled here.** `SDKMessage` has
 * 37 members at 0.3.266, and two the plan never mentioned (`system/status`,
 * `rate_limit_event`) arrived in the very first probe turn. **Unknown kinds are
 * ignored silently and by default** — a turn must not die because the CLI
 * learned a new trick.
 *
 * ## Why text comes from the deltas and not from `assistant`
 *
 * Both carry it, and using both double-counts. The choice is deliberate and it
 * is about which failure is survivable.
 *
 * Text is accumulated from `content_block_delta`. An `assistant` text block is
 * used **only to create a part that does not exist yet** — never to overwrite
 * one that does. Pairing an `assistant` block back to the stream index it
 * completed would need an ordering assumption (that it always refers to the
 * most recently started block), and if that assumption ever broke, the text of
 * one block would be written into another's part: a silently corrupted
 * transcript. Not overwriting means the worst case is a *truncated* block if
 * deltas were somehow missed, which is visible and harmless by comparison.
 *
 * A tool call is the opposite way round: its `input_json_delta` stream is
 * partial JSON that is useless until complete, so the **`assistant` message is
 * the source** for tool parts, keyed by the block's own `toolu_*` id — which is
 * stable, and is also what the `tool_result` pairs back to.
 */

import {
  describePermissionAction,
  PERMISSION_TOOL_NAME,
  type LocalPermissionRequest
} from '../../../shared/localAgentRequests'
import {
  KIND_METADATA_KEY,
  TOOL_ID_METADATA_KEY,
  TOOL_INPUT_METADATA_KEY,
  TOOL_NAME_METADATA_KEY,
  TOOL_STREAM_METADATA_KEY,
  type MessageLike,
  type PartLike
} from '../../agents/streamPartsAccumulator'

/** What one folded message produced, for the runner to act on. */
export interface ClaudeStreamUpdate {
  /** The cumulative message to re-ingest, when this fold changed one. */
  message?: MessageLike
  /** Set once, off the init message: what the CLI authenticated with. */
  apiKeySource?: string
  /** Set once, off the init message. */
  model?: string
  /** Set once, off the init message. */
  cliVersion?: string
  /** The session id, reported on nearly every message. */
  sessionId?: string
  /** The turn ended. `result` is the only thing that sets this. */
  ended?: { isError: boolean; text: string; usage?: unknown; numTurns?: number }
  /** A readiness signal from `auth_status`, when one ever arrives. */
  authError?: string
}

/** The subset of an SDK message this translator reads. Structural on purpose. */
interface RawMessage {
  type?: unknown
  subtype?: unknown
  session_id?: unknown
  apiKeySource?: unknown
  model?: unknown
  claude_code_version?: unknown
  event?: Record<string, unknown>
  message?: { id?: unknown; content?: unknown }
  parent_tool_use_id?: unknown
  is_error?: unknown
  result?: unknown
  usage?: unknown
  num_turns?: unknown
  error?: unknown
  isAuthenticating?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * A tool result's content, flattened to text.
 *
 * The SDK sends either a plain string or an array of content blocks (the shape
 * an image-returning tool uses). A reader that knows only the string case
 * renders `[object Object]` into the transcript for every tool that returns
 * structured content, which is worse than saying nothing.
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = record(block)
      if (!b) return ''
      if (typeof b.text === 'string') return b.text
      // A non-text block (an image, say) has no transcript representation, and
      // inventing one would be worse than naming its type.
      return typeof b.type === 'string' ? `[${b.type}]` : ''
    })
    .filter(Boolean)
    .join('\n')
}

interface MessageState {
  parts: PartLike[]
  /** Stream key → index in `parts`. Assigned once, never reassigned. */
  index: Map<string, number>
}

export class ClaudeMessageStream {
  private readonly messages = new Map<string, MessageState>()
  /**
   * The message id the current `content_block_*` events belong to, **per lane**.
   *
   * Only `message_start` carries a message id, so without this every block
   * after the first message would be filed under the wrong one — or, with a
   * fallback key, all of them would collapse into a single message and their
   * part indices would collide.
   *
   * A *lane* is `parent_tool_use_id ?? 'main'`. A single slot would be correct
   * today — verified: with `forwardSubagentText` off (our default) a subagent's
   * frames arrive only as `assistant` / `user` messages, never as
   * `stream_event`, so nothing interleaves. But that is a property of an option
   * we do not set rather than of the protocol, and the failure it would cause
   * is silent: a subagent's `message_start` would capture the slot and the main
   * agent's next delta would be filed into the subagent's message. Keying by
   * lane costs one map and removes the assumption instead of documenting it.
   */
  private readonly currentMessageId = new Map<string, string>()
  /** `(messageId, block index)` → the content type `content_block_start` named. */
  private readonly blockTypes = new Map<string, string>()
  /**
   * Which stream keys have received at least one delta.
   *
   * This is what makes "an `assistant` text block only *creates*, never
   * overwrites" decidable: a text part that streamed is left alone, and one
   * that did not is filled in from the assistant message.
   */
  private readonly streamedText = new Set<string>()
  /** Per message id, how many text blocks the `assistant` messages have settled. */
  private readonly assistantTextSeen = new Map<string, number>()
  /** Which message each permission ask's block lives in, so its decision joins it. */
  private readonly requestMessage = new Map<string, string>()

  /**
   * Fold one SDK message in.
   *
   * Returns an empty update for anything it does not recognise, which is most
   * of the union and deliberately so.
   */
  apply(raw: unknown): ClaudeStreamUpdate {
    const m = record(raw) as RawMessage | undefined
    if (!m) return {}
    const update: ClaudeStreamUpdate = {}
    const sessionId = str(m.session_id)
    if (sessionId) update.sessionId = sessionId

    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          // `apiKeySource` is the **fact** that replaces our belief about which
          // credential paid for the turn. `'none'` is a claude.ai login; the
          // type carries five legacy members current CLIs never emit, so
          // anything else is reported rather than interpreted.
          update.apiKeySource = str(m.apiKeySource) ?? 'unknown'
          update.model = str(m.model)
          update.cliVersion = str(m.claude_code_version)
        }
        return update

      case 'stream_event':
        return { ...update, ...this.streamEvent(m.event ?? {}, str(m.parent_tool_use_id) ?? 'main') }

      case 'assistant':
        return { ...update, ...this.assistant(m) }

      case 'user':
        return { ...update, ...this.userMessage(m) }

      case 'auth_status': {
        // Never observed in any probe, including the not-logged-in run. Handled
        // because it is in the union and would otherwise be a silent drop of
        // the one message that names an auth problem directly.
        const error = str(m.error)
        if (error) update.authError = error
        return update
      }

      case 'result':
        update.ended = {
          isError: m.is_error === true,
          text: typeof m.result === 'string' ? m.result : '',
          usage: m.usage,
          numTurns: typeof m.num_turns === 'number' ? m.num_turns : undefined
        }
        return update

      default:
        return update
    }
  }

  /** The parts of every message this turn produced, in arrival order. */
  private messageState(id: string): MessageState {
    let state = this.messages.get(id)
    if (!state) {
      state = { parts: [], index: new Map() }
      this.messages.set(id, state)
    }
    return state
  }

  private slot(state: MessageState, key: string, make: () => PartLike): number {
    const existing = state.index.get(key)
    if (existing !== undefined) return existing
    const idx = state.parts.length
    state.parts.push(make())
    state.index.set(key, idx)
    return idx
  }

  /**
   * The message a block belongs to.
   *
   * `anon` is a real fallback, not a defensive one: a `content_block_delta` can
   * only arrive after a `message_start` in every observed stream, but filing
   * blocks under a null key would collapse two messages' parts into one array
   * with colliding indices — a corrupted transcript rather than a missing one.
   */
  private owner(lane = 'main'): string {
    return this.currentMessageId.get(lane) ?? `anon:claude:${lane}`
  }

  private streamEvent(event: Record<string, unknown>, lane: string): ClaudeStreamUpdate {
    const type = str(event.type)
    if (type === 'message_start') {
      const id = str(record(event.message)?.id)
      if (id) this.currentMessageId.set(lane, id)
      else this.currentMessageId.delete(lane)
      return {}
    }
    const index = typeof event.index === 'number' ? event.index : null
    if (index === null) return {}
    const key = `${this.owner(lane)}:${index}`

    if (type === 'content_block_start') {
      const blockType = str(record(event.content_block)?.type)
      if (blockType) this.blockTypes.set(key, blockType)
      return {}
    }
    if (type !== 'content_block_delta') return {}

    const delta = record(event.delta)
    if (!delta) return {}
    const deltaType = str(delta.type)
    // `input_json_delta` is deliberately not accumulated: it is partial JSON,
    // meaningless until complete, and the `assistant` message carries the
    // finished input anyway. `signature_delta` likewise carries no transcript.
    if (deltaType === 'text_delta') return this.appendText(key, 'text', str(delta.text), lane)
    if (deltaType === 'thinking_delta')
      return this.appendText(key, 'thinking', str(delta.thinking), lane)
    return {}
  }

  private appendText(
    key: string,
    kind: 'text' | 'thinking',
    delta: string | undefined,
    lane: string
  ): ClaudeStreamUpdate {
    if (delta === undefined || delta === '') return {}
    const messageId = this.owner(lane)
    const state = this.messageState(messageId)
    const partKey = `${kind}:${key}`
    const idx = this.slot(state, partKey, () => ({
      kind: 'text',
      text: '',
      metadata: { [KIND_METADATA_KEY]: kind }
    }))
    this.streamedText.add(partKey)
    state.parts[idx] = { ...state.parts[idx], text: (state.parts[idx].text ?? '') + delta }
    return { message: { messageId, parts: state.parts } }
  }

  private assistant(m: RawMessage): ClaudeStreamUpdate {
    const messageId = str(m.message?.id) ?? this.owner()
    const content = Array.isArray(m.message?.content) ? m.message.content : []
    let changed = false

    for (const block of content) {
      const b = record(block)
      if (!b) continue
      if (b.type === 'tool_use') {
        if (this.toolUse(messageId, b)) changed = true
        continue
      }
      if (b.type === 'text' || b.type === 'thinking') {
        if (this.fillUnstreamedText(messageId, b)) changed = true
      }
    }
    if (!changed) return {}
    return { message: { messageId, parts: this.messageState(messageId).parts } }
  }

  /**
   * A tool call, from the authoritative `assistant` message.
   *
   * Keyed by the block's own `toolu_*` id rather than by a stream index,
   * because that id is what the `tool_result` pairs back to and it is stable
   * across everything on the wire.
   */
  private toolUse(messageId: string, block: Record<string, unknown>): boolean {
    const toolId = str(block.id)
    const name = str(block.name)
    if (!toolId || !name) return false
    const state = this.messageState(messageId)
    const input = record(block.input)
    const idx = this.slot(state, `tool:${toolId}`, () => ({
      kind: 'text',
      // The accumulator drops a part with empty text, so a tool call needs a
      // narration line to exist at all; the structured call rides on metadata.
      text: '',
      metadata: {
        [KIND_METADATA_KEY]: 'tool',
        [TOOL_NAME_METADATA_KEY]: name,
        [TOOL_ID_METADATA_KEY]: toolId,
        ...(input ? { [TOOL_INPUT_METADATA_KEY]: input } : {})
      }
    }))
    const narration = describeClaudeToolCall(name, input)
    if ((state.parts[idx].text ?? '').length >= narration.length) return false
    state.parts[idx] = { ...state.parts[idx], text: narration }
    return true
  }

  /**
   * Fill in a text block that never streamed.
   *
   * The whole point is what it does **not** do: it never rewrites a part that
   * deltas already built. See the header — pairing an `assistant` block back to
   * a stream index needs an ordering assumption, and being wrong about it would
   * write one block's text over another's.
   */
  private fillUnstreamedText(messageId: string, block: Record<string, unknown>): boolean {
    const kind = block.type === 'thinking' ? 'thinking' : 'text'
    const text = str(kind === 'thinking' ? block.thinking : block.text)
    if (!text) return false

    const seenKey = `${messageId}:${kind}`
    const ordinal = this.assistantTextSeen.get(seenKey) ?? 0
    this.assistantTextSeen.set(seenKey, ordinal + 1)

    // Did *any* stream key for this message carry text of this kind? If deltas
    // are flowing at all, they own the text and this message adds nothing.
    for (const streamed of this.streamedText) {
      if (streamed.startsWith(`${kind}:${messageId}:`)) return false
    }

    const state = this.messageState(messageId)
    const partKey = `${kind}:unstreamed:${messageId}:${ordinal}`
    const idx = this.slot(state, partKey, () => ({
      kind: 'text',
      text: '',
      metadata: { [KIND_METADATA_KEY]: kind }
    }))
    if ((state.parts[idx].text ?? '').length >= text.length) return false
    state.parts[idx] = { ...state.parts[idx], text }
    return true
  }

  /**
   * A tool result, off the `user` message.
   *
   * These carry **no message id** — only `tool_use_id` — so they are filed
   * under the message that owns the call they answer. Without that lookup every
   * result would land in a stray message of its own and the renderer could not
   * fold it into the call's block.
   */
  private userMessage(m: RawMessage): ClaudeStreamUpdate {
    const content = Array.isArray(m.message?.content) ? m.message.content : []
    let owner: string | null = null

    for (const block of content) {
      const b = record(block)
      if (!b || b.type !== 'tool_result') continue
      const toolId = str(b.tool_use_id)
      if (!toolId) continue
      const messageId = this.messageOwningTool(toolId) ?? this.owner()
      const text = toolResultText(b.content)
      if (!text) continue
      const state = this.messageState(messageId)
      const idx = this.slot(state, `result:${toolId}`, () => ({
        kind: 'text',
        text: '',
        metadata: {
          [KIND_METADATA_KEY]: 'tool_result',
          [TOOL_ID_METADATA_KEY]: toolId,
          // The renderer always wants a stream label. A tool that failed is
          // `stderr` so it reads as the error it is.
          [TOOL_STREAM_METADATA_KEY]: b.is_error === true ? 'stderr' : 'stdout'
        }
      }))
      if ((state.parts[idx].text ?? '').length < text.length) {
        state.parts[idx] = { ...state.parts[idx], text }
        owner = messageId
      }
    }
    if (!owner) return {}
    return { message: { messageId: owner, parts: this.messageState(owner).parts } }
  }

  /**
   * Write a permission ask into the transcript.
   *
   * Filed under the message that is current when the tool call was made, so the
   * block sits beside the call that raised it rather than in a stray message of
   * its own — the same reason the OpenCode path keeps a `requestMessage` map.
   *
   * Returns nothing when a block for this id already exists, so a re-ask cannot
   * duplicate it.
   */
  askPermission(requestId: string, request: LocalPermissionRequest): ClaudeStreamUpdate {
    const messageId = this.owner()
    this.requestMessage.set(requestId, messageId)
    const state = this.messageState(messageId)
    const idx = this.slot(state, `perm:${requestId}`, () => ({
      kind: 'text',
      text: '',
      metadata: {
        [KIND_METADATA_KEY]: 'tool',
        [TOOL_NAME_METADATA_KEY]: PERMISSION_TOOL_NAME,
        [TOOL_ID_METADATA_KEY]: requestId,
        [TOOL_INPUT_METADATA_KEY]: request as unknown as Record<string, unknown>
      }
    }))
    const narration = describeClaudePermission(request)
    if ((state.parts[idx].text ?? '').length >= narration.length) return {}
    state.parts[idx] = { ...state.parts[idx], text: narration }
    return { message: { messageId, parts: state.parts } }
  }

  /**
   * Record what was decided, paired to the ask by the same `tool_id`.
   *
   * The pairing is not cosmetic: the renderer folds the result into the request
   * block, so without it the persisted transcript shows a permission prompt
   * with no record of the answer — an approval nobody can later account for is
   * the worst kind of audit trail.
   */
  settlePermission(requestId: string, text: string): ClaudeStreamUpdate {
    const messageId = this.requestMessage.get(requestId)
    if (!messageId) return {}
    const state = this.messageState(messageId)
    const idx = this.slot(state, `decision:${requestId}`, () => ({
      kind: 'text',
      text: '',
      metadata: {
        [KIND_METADATA_KEY]: 'tool_result',
        [TOOL_ID_METADATA_KEY]: requestId,
        [TOOL_STREAM_METADATA_KEY]: 'stdout'
      }
    }))
    if ((state.parts[idx].text ?? '').length >= text.length) return {}
    state.parts[idx] = { ...state.parts[idx], text }
    return { message: { messageId, parts: state.parts } }
  }

  private messageOwningTool(toolId: string): string | null {
    for (const [messageId, state] of this.messages) {
      if (state.index.has(`tool:${toolId}`)) return messageId
    }
    return null
  }
}

/**
 * A one-line narration for a tool call.
 *
 * Claude's tool vocabulary is its own (`Bash`, `Edit`, `Read`, `WebFetch`) and
 * deliberately not mapped onto OpenCode's — see the permissions rule in the
 * plan. The narration names the tool and its most identifying argument, because
 * a transcript reading "Read" ten times tells the user nothing about what the
 * agent actually did.
 */
export function describeClaudeToolCall(
  name: string,
  input: Record<string, unknown> | undefined
): string {
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input?.[key]
      if (typeof value === 'string' && value !== '') return value
    }
    return undefined
  }
  const detail = first('command', 'file_path', 'path', 'url', 'pattern', 'query', 'prompt')
  if (!detail) return name
  const trimmed = detail.length > 160 ? `${detail.slice(0, 157)}…` : detail
  return `${name}: ${trimmed}`
}

/**
 * The one line a permission block leads with.
 *
 * Through the shared `describePermissionAction`, which knows both engines'
 * vocabularies, so the user reads the same sentence whichever engine asked —
 * `PermissionRequestBlock` calls the same function on the other side of the
 * bridge, and the two must not be able to disagree.
 */
export function describeClaudePermission(request: LocalPermissionRequest): string {
  const what = request.resources.length > 0 ? request.resources.join(', ') : request.action
  return `Permission needed to ${describePermissionAction(request.action)}: ${what}`
}
