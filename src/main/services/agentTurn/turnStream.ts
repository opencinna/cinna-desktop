/**
 * Turning one session's engine events into the A2A-shaped message the rest of
 * the pipeline already knows how to read.
 *
 * ## The contract this has to satisfy, and the trap in it
 *
 * `StreamPartsAccumulator` was built for A2A, where each `status-update`
 * carries the message **as it stands** — every part's full text so far — and
 * the accumulator computes the delta itself (`text.slice(prior.length)`,
 * keyed by `(messageId, partIndex)`). OpenCode's stream is the opposite shape:
 * it emits true deltas.
 *
 * So this class does not translate an event into a part; it maintains the
 * *cumulative* message and hands the whole thing back for re-ingestion. Feeding
 * the accumulator a raw OpenCode delta as if it were an A2A part would look
 * right in a test with one chunk and duplicate every character from the second
 * chunk onwards, because the accumulator would take `slice(prior.length)` of
 * text that never included the prior.
 *
 * ## Part identity
 *
 * The accumulator's key is `(messageId, index-in-parts-array)`, so an index
 * must never be reused for a different logical stream and never shift. Each
 * engine stream id — `textID`, `reasoningID`, `callID` — is therefore assigned
 * an index on first sight and keeps it for the life of the message. Parts are
 * appended, never spliced.
 *
 * ## What is deliberately not here
 *
 * No IO, no engine, no persistence, no clock. Everything this class does is a
 * function of the events it has been given, which is what makes the whole
 * event→UI mapping testable without a binary — the one part of Phase 6 that a
 * live turn is not required to verify.
 */

import {
  FILE_ID_METADATA_KEY,
  FILE_MIME_METADATA_KEY,
  FILE_NAME_METADATA_KEY,
  KIND_METADATA_KEY,
  TOOL_ID_METADATA_KEY,
  TOOL_INPUT_METADATA_KEY,
  TOOL_NAME_METADATA_KEY,
  TOOL_STREAM_METADATA_KEY,
  type MessageLike,
  type PartLike
} from '../../agents/streamPartsAccumulator'
import {
  PERMISSION_TOOL_NAME,
  QUESTION_TOOL_NAME,
  type LocalPermissionRequest
} from '../../../shared/localAgentRequests'
import { ENGINE_EVENT, type EngineEvent } from './engineEvents'

/** A question or permission the engine is blocked on. */
export interface PendingRequest {
  kind: 'permission' | 'question'
  /** `per_*` or `que_*` — the address a reply is posted to. */
  requestId: string
}

/** What one applied event changed, for the runner to act on. */
export interface TurnStreamUpdate {
  /** Re-ingest this into the accumulator, when the message content moved. */
  message?: MessageLike
  /** The engine is blocked on a human. */
  asked?: PendingRequest
  /** A pending request was answered or withdrawn — engine-side, not by us. */
  settled?: string
  /** The agent loop went idle: the turn is over. */
  idle?: boolean
  /** The turn failed. Already humanised. */
  error?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/**
 * A human-readable message out of any of the eight error shapes the engine can
 * report.
 *
 * They are not one shape: most are `{name, data:{message}}` (`ProviderAuthError`,
 * `APIError`, `MessageAbortedError`, …) while `SessionErrorUnknown` — the one on
 * `tool.failed` and `step.failed` — is `{type:'unknown', message}`. A reader
 * that knows only one of those renders "the agent failed" with no reason
 * attached, which is exactly the case a user most needs the reason for.
 */
export function engineErrorMessage(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return 'The agent stopped with an unspecified error.'
  const obj = raw as Record<string, unknown>
  const flat = str(obj.message)
  if (flat) return flat
  const data = obj.data
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    const nested = str(d.message)
    if (nested) {
      // `ProviderAuthError` names the credential that was rejected, and a
      // rotated key is the failure a user is most likely to hit — Phase 5
      // already fought it once, where a stale key made every turn 401 while
      // the UI showed a valid credential and a green engine. "Invalid API key"
      // with no provider attached leaves the user guessing which of theirs.
      const provider = str(d.providerID)
      return provider ? `${provider}: ${nested}` : nested
    }
  }
  const name = str(obj.name) ?? str(obj.type)
  return name ? `The agent stopped: ${name}.` : 'The agent stopped with an unspecified error.'
}

/**
 * Values of `step.ended`'s `finish` that mean **the agent loop continues**.
 *
 * The direction of this test is the whole point, and it is deliberately the
 * opposite of the obvious one. The obvious rule — "settle when
 * `finish === 'stop'`" — hangs the turn forever the moment a real turn ends
 * with any other terminal value, and a hang is invisible, holds the per-agent
 * lock for the life of the app, and (through `turnLock.anyHeld()`) stops the
 * engine being reconciled for every other agent. Ending a turn early is
 * visible, recoverable, and the user can simply ask again.
 *
 * So termination is the default and continuation is the enumerated exception.
 *
 * **The OpenAPI document does not constrain this field** — it is declared as a
 * bare `"type": "string"` with no enum — so the set below cannot be read off
 * the spec. It comes from two places: `'tool-calls'` was *observed* on a real
 * tool-calling turn (`'tool-calls'` per tool round, `'stop'` last), and the
 * vocabulary matches the AI SDK's `FinishReason`, whose other members
 * (`stop`, `length`, `content-filter`, `error`, `other`, `unknown`) are all
 * terminal. An unknown value is logged by the caller so a future addition
 * surfaces in a log rather than silently changing behaviour.
 */
const CONTINUING_FINISH_REASONS: ReadonlySet<string> = new Set(['tool-calls'])

/** True when a `step.ended` ends the whole turn rather than one step of it. */
export function isTurnOver(finish: string | undefined): boolean {
  if (finish === undefined) return true
  return !CONTINUING_FINISH_REASONS.has(finish)
}

interface MessageState {
  parts: PartLike[]
  /** Engine stream id → index in `parts`. Assigned once, never reassigned. */
  index: Map<string, number>
}

export class TurnStream {
  private readonly messages = new Map<string, MessageState>()
  /**
   * Which message each request's part lives in.
   *
   * `permission.v2.replied` and `question.v2.replied` carry only
   * `{sessionID, requestID, reply|answers}` — no `assistantMessageID` — so the
   * decision could not otherwise be filed next to the ask it answers, and would
   * land in a stray message of its own.
   */
  private readonly requestMessage = new Map<string, string>()
  /**
   * Which message each text / reasoning stream id first appeared under.
   *
   * `assistantMessageID` is required on these events by the schema, but the
   * fallback below is `anon:${kind}` — and if a `session.next.text.ended` ever
   * arrives carrying a different (or absent) message id from the deltas that
   * built it, the block is filed under a second key and the whole answer is
   * duplicated into the transcript. That is not hypothetical here: the heal
   * path deliberately replays `text.ended` off the durable stream. Live turns
   * have now been watched — `text.ended` carries the cumulative text there, as
   * expected — but no turn has been watched *through a reconnect*, so the
   * durable stream's own field set on this event is still unobserved.
   * Remembering the first owner
   * costs one map and makes the identity of a block depend on the stream id
   * alone, which is the thing that is actually stable.
   */
  private readonly streamOwner = new Map<string, string>()
  /** Highest `durable.seq` seen, for the gap-fill cursor after a reconnect. */
  private highestSeq: number | null = null

  /** The durable cursor to resume the per-session stream from, if any. */
  lastSeq(): number | null {
    return this.highestSeq
  }

  /**
   * Fold one event in.
   *
   * Unknown event types return an empty update rather than throwing: the global
   * stream has 88 variants and a later OpenCode will have more, and a turn must
   * not die because the engine learned a new trick.
   */
  apply(event: EngineEvent): TurnStreamUpdate {
    if (event.durable && (this.highestSeq === null || event.durable.seq > this.highestSeq)) {
      this.highestSeq = event.durable.seq
    }
    const data = event.data ?? {}

    switch (event.type) {
      case ENGINE_EVENT.textDelta:
        return this.appendText(data, 'text', str(data.textID), str(data.delta))
      case ENGINE_EVENT.textEnded:
        // Block-level, and the durable stream's *only* text event. Live it is
        // redundant with the deltas; after a reconnect it is how the hole gets
        // filled. Either way `setText` is idempotent — it sets the cumulative
        // text rather than appending, so replaying an ended over text already
        // streamed is a no-op, and replaying one whose deltas were lost
        // restores it whole.
        return this.setText(data, 'text', str(data.textID), str(data.text))
      case ENGINE_EVENT.reasoningDelta:
        return this.appendText(data, 'thinking', str(data.reasoningID), str(data.delta))
      case ENGINE_EVENT.toolCalled:
        return this.toolCalled(data)
      case ENGINE_EVENT.toolSuccess:
        return this.toolResult(data, 'stdout', renderToolOutput(data))
      case ENGINE_EVENT.toolFailed:
        return this.toolResult(data, 'stderr', engineErrorMessage(data.error))
      case ENGINE_EVENT.stepEnded:
        return isTurnOver(str(data.finish)) ? { idle: true } : {}
      case ENGINE_EVENT.stepFailed:
        return { error: engineErrorMessage(data.error) }
      case ENGINE_EVENT.permissionAsked:
        return this.permissionAsked(data)
      case ENGINE_EVENT.questionAsked:
        return this.questionAsked(data)
      case ENGINE_EVENT.permissionReplied:
        return this.settleRequest(data, permissionDecisionText(str(data.reply)))
      case ENGINE_EVENT.questionReplied:
        return this.settleRequest(data, questionDecisionText(data.answers))
      case ENGINE_EVENT.questionRejected:
        return this.settleRequest(data, 'No answer was given.')
      case ENGINE_EVENT.idle:
        // Never emitted by 1.18.27 — kept as belt and braces because it costs
        // nothing if a later version starts emitting it, and `settle` is
        // idempotent so a turn already ended by `step.ended` ignores it.
        return { idle: true }
      case ENGINE_EVENT.error:
        return { error: engineErrorMessage(data.error) }
      default:
        return {}
    }
  }

  /**
   * The message id to file a part under.
   *
   * `assistantMessageID` is on every content event, but permission and question
   * asks carry only a `source`/`tool` sub-object — and after a reconnect an
   * event may arrive with neither. A synthetic per-session id keeps those parts
   * in one stable namespace instead of scattering them across a new key each
   * time, which would make every ask render as a fresh block.
   */
  private messageState(id: string): MessageState {
    let state = this.messages.get(id)
    if (!state) {
      state = { parts: [], index: new Map() }
      this.messages.set(id, state)
    }
    return state
  }

  private slot(state: MessageState, streamId: string, make: () => PartLike): number {
    const existing = state.index.get(streamId)
    if (existing !== undefined) return existing
    const idx = state.parts.length
    state.parts.push(make())
    state.index.set(streamId, idx)
    return idx
  }

  private appendText(
    data: Record<string, unknown>,
    kind: 'text' | 'thinking',
    streamId: string | undefined,
    delta: string | undefined
  ): TurnStreamUpdate {
    if (!streamId || delta === undefined || delta === '') return {}
    const key = `${kind}:${streamId}`
    // First owner wins: a later event naming a different message for the same
    // stream id is filed where the block already lives, not in a new one.
    const messageId =
      this.streamOwner.get(key) ?? str(data.assistantMessageID) ?? `anon:${kind}`
    this.streamOwner.set(key, messageId)
    const state = this.messageState(messageId)
    const idx = this.slot(state, key, () => ({
      kind: 'text',
      text: '',
      metadata: { [KIND_METADATA_KEY]: kind }
    }))
    state.parts[idx] = { ...state.parts[idx], text: (state.parts[idx].text ?? '') + delta }
    return { message: { messageId, parts: state.parts } }
  }

  private setText(
    data: Record<string, unknown>,
    kind: 'text' | 'thinking',
    streamId: string | undefined,
    text: string | undefined
  ): TurnStreamUpdate {
    if (!streamId || text === undefined) return {}
    const key = `${kind}:${streamId}`
    // First owner wins: a later event naming a different message for the same
    // stream id is filed where the block already lives, not in a new one.
    const messageId =
      this.streamOwner.get(key) ?? str(data.assistantMessageID) ?? `anon:${kind}`
    this.streamOwner.set(key, messageId)
    const state = this.messageState(messageId)
    const idx = this.slot(state, key, () => ({
      kind: 'text',
      text: '',
      metadata: { [KIND_METADATA_KEY]: kind }
    }))
    const current = state.parts[idx].text ?? ''
    // Never shrink. The accumulator computes `text.slice(prior.length)` and a
    // shorter string would make the delta the *whole* new text, duplicating
    // everything already rendered. A block-level `ended` that is somehow
    // shorter than what streamed is a bug upstream, not licence to corrupt the
    // transcript.
    if (text.length <= current.length) return {}
    state.parts[idx] = { ...state.parts[idx], text }
    return { message: { messageId, parts: state.parts } }
  }

  private toolCalled(data: Record<string, unknown>): TurnStreamUpdate {
    const callId = str(data.callID)
    const tool = str(data.tool)
    if (!callId || !tool) return {}
    const messageId = str(data.assistantMessageID) ?? 'anon:tool'
    const state = this.messageState(messageId)
    const input =
      data.input && typeof data.input === 'object' && !Array.isArray(data.input)
        ? (data.input as Record<string, unknown>)
        : undefined
    const idx = this.slot(state, `tool:${callId}`, () => ({
      kind: 'text',
      // The accumulator drops a part with empty text, so a tool call needs a
      // narration line to exist at all — the structured call rides on the
      // metadata beside it.
      text: '',
      metadata: {
        [KIND_METADATA_KEY]: 'tool',
        [TOOL_NAME_METADATA_KEY]: tool,
        [TOOL_ID_METADATA_KEY]: callId,
        ...(input ? { [TOOL_INPUT_METADATA_KEY]: input } : {})
      }
    }))
    const narration = describeToolCall(tool, input)
    if ((state.parts[idx].text ?? '').length >= narration.length) return {}
    state.parts[idx] = { ...state.parts[idx], text: narration }
    return { message: { messageId, parts: state.parts } }
  }

  private toolResult(
    data: Record<string, unknown>,
    stream: 'stdout' | 'stderr',
    text: string
  ): TurnStreamUpdate {
    const callId = str(data.callID)
    if (!callId || text === '') return {}
    const messageId = str(data.assistantMessageID) ?? 'anon:tool'
    const state = this.messageState(messageId)
    const idx = this.slot(state, `result:${callId}:${stream}`, () => ({
      kind: 'text',
      text: '',
      metadata: {
        [KIND_METADATA_KEY]: 'tool_result',
        [TOOL_ID_METADATA_KEY]: callId,
        [TOOL_STREAM_METADATA_KEY]: stream
      }
    }))
    if ((state.parts[idx].text ?? '').length >= text.length) return {}
    state.parts[idx] = { ...state.parts[idx], text }
    return { message: { messageId, parts: state.parts } }
  }

  /**
   * Record the outcome of a request in the transcript, and report it settled.
   *
   * The closing part is a `tool_result` carrying the **same** `cinna.tool_id`
   * as the ask. Two things need that pairing and neither is cosmetic. The
   * renderer folds the result into the request block, so the persisted
   * transcript says what was decided instead of showing a permission prompt
   * with no record of the answer — an approval nobody can later account for is
   * the worst kind of audit trail. And the pairing is what lets the three
   * render sites *consume* the result through the machinery already there,
   * rather than leaving a bare terminal-style block next to every decision.
   *
   * The event that triggers this is the **engine's**, not our own reply — so
   * what is recorded is what the engine acted on, including a decision made
   * from somewhere other than this window.
   */
  private settleRequest(data: Record<string, unknown>, text: string): TurnStreamUpdate {
    const requestId = str(data.requestID)
    if (!requestId) return {}
    const messageId = this.requestMessage.get(requestId)
    if (!messageId) return { settled: requestId }
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
    if ((state.parts[idx].text ?? '').length >= text.length) return { settled: requestId }
    state.parts[idx] = { ...state.parts[idx], text }
    return { settled: requestId, message: { messageId, parts: state.parts } }
  }

  private permissionAsked(data: Record<string, unknown>): TurnStreamUpdate {
    const requestId = str(data.id)
    const action = str(data.action)
    if (!requestId || !action) return {}
    const source = data.source as Record<string, unknown> | undefined
    const messageId = str(source?.messageID) ?? 'anon:requests'
    const state = this.messageState(messageId)
    const request: LocalPermissionRequest = {
      action,
      resources: Array.isArray(data.resources)
        ? data.resources.filter((r): r is string => typeof r === 'string')
        : [],
      // `save[]` is what an "always" answer would persist. When the engine
      // offers none, "always" is not on the table and the renderer must not
      // show the button — an answer the engine will not save reads to the user
      // as a grant that silently did not stick.
      savable: Array.isArray(data.save)
        ? data.save.filter((r): r is string => typeof r === 'string')
        : [],
      callId: str(source?.callID)
    }
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
    this.requestMessage.set(requestId, messageId)
    const narration = describePermission(request)
    if ((state.parts[idx].text ?? '').length >= narration.length) return {}
    state.parts[idx] = { ...state.parts[idx], text: narration }
    return {
      message: { messageId, parts: state.parts },
      asked: { kind: 'permission', requestId }
    }
  }

  private questionAsked(data: Record<string, unknown>): TurnStreamUpdate {
    const requestId = str(data.id)
    if (!requestId || !Array.isArray(data.questions)) return {}
    const questions = mapQuestions(data.questions)
    if (questions.length === 0) return {}
    const tool = data.tool as Record<string, unknown> | undefined
    const messageId = str(tool?.messageID) ?? 'anon:requests'
    const state = this.messageState(messageId)
    const idx = this.slot(state, `question:${requestId}`, () => ({
      kind: 'text',
      text: '',
      metadata: {
        [KIND_METADATA_KEY]: 'tool',
        [TOOL_NAME_METADATA_KEY]: QUESTION_TOOL_NAME,
        [TOOL_ID_METADATA_KEY]: requestId,
        [TOOL_INPUT_METADATA_KEY]: { questions }
      }
    }))
    this.requestMessage.set(requestId, messageId)
    const narration =
      questions.length > 1 ? `Asked ${questions.length} questions.` : 'Asked a question.'
    if ((state.parts[idx].text ?? '').length >= narration.length) return {}
    state.parts[idx] = { ...state.parts[idx], text: narration }
    return {
      message: { messageId, parts: state.parts },
      asked: { kind: 'question', requestId }
    }
  }
}

/**
 * OpenCode's question shape into the desktop's.
 *
 * A mapping, not a cast, and the differences are small but real: OpenCode says
 * `multiple`, the desktop's `AskQuestion` says `multiSelect`; OpenCode requires
 * `header` and an option `description`, the desktop treats both as optional.
 * The renderer's `parseAskQuestions` happens to accept `multiple` as well, but
 * relying on that would leave the wire ambiguous — a reader of a persisted part
 * could not tell which producer wrote it. Normalising here means everything
 * downstream sees one shape.
 *
 * `custom` is dropped on purpose: the desktop's answer modal always offers a
 * free-text "Other" option, so there is nothing for a `custom: false` to turn
 * off, and carrying a flag nothing honours is worse than not carrying it.
 */
export function mapQuestions(raw: unknown[]): {
  question: string
  header?: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
}[] {
  const out: ReturnType<typeof mapQuestions> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const question = str(obj.question)
    if (!question) continue
    const options: { label: string; description?: string }[] = []
    if (Array.isArray(obj.options)) {
      for (const opt of obj.options) {
        if (!opt || typeof opt !== 'object') continue
        const o = opt as Record<string, unknown>
        const label = str(o.label)
        if (!label) continue
        options.push({ label, description: str(o.description) })
      }
    }
    out.push({
      question,
      header: str(obj.header),
      multiSelect: obj.multiple === true,
      options
    })
  }
  return out
}

/** A one-line narration for a tool call, since a part with no text is dropped. */
function describeToolCall(tool: string, input?: Record<string, unknown>): string {
  const hint =
    str(input?.command) ??
    str(input?.filePath) ??
    str(input?.path) ??
    str(input?.url) ??
    str(input?.pattern)
  return hint ? `${tool}: ${hint}` : tool
}

/** What a permission decision reads as in the transcript. */
export function permissionDecisionText(reply: string | undefined): string {
  // **Not "for this agent", and that is now settled rather than cautious.** An
  // `always` grant was observed writing `{projectID: "global", action,
  // resource: "*"}` into a user-global store, after which a *different* folder
  // agent wrote a file with no prompt at all. "For this agent" would be a false
  // statement in the transcript, which is the one place a permission decision
  // has to be trustworthy.
  //
  // Unreachable today — the Always answer is not offered (see
  // `ALWAYS_GRANTS_ENABLED`) — and kept because the engine can still report an
  // `always` reply made by another client on the same `opencode serve`, and
  // because a decision arriving from outside this window must still be
  // recorded accurately.
  if (reply === 'always') return 'Allowed, and remembered.'
  if (reply === 'reject') return 'Denied.'
  if (reply === 'once') return 'Allowed once.'
  // An engine that grows a fourth reply must still leave a legible record
  // rather than an empty block the renderer then drops.
  return `Answered: ${reply ?? 'unknown'}.`
}

/** What an answered question reads as in the transcript. */
export function questionDecisionText(answers: unknown): string {
  if (!Array.isArray(answers)) return 'Answered.'
  const flat = answers
    .flatMap((a) => (Array.isArray(a) ? a : []))
    .filter((a): a is string => typeof a === 'string')
  return flat.length > 0 ? `Answered: ${flat.join(', ')}.` : 'Answered.'
}

/** A one-line narration for a permission ask. */
function describePermission(request: LocalPermissionRequest): string {
  const what = request.resources.length > 0 ? request.resources.join(', ') : request.action
  return `Permission needed for ${request.action}: ${what}`
}

/**
 * Readable text out of a tool success.
 *
 * `content[]` is the model-facing rendering and is what the user should see;
 * `structured` is a machine payload and is used only when there is no content,
 * so a tool that returns data and no prose still shows something rather than an
 * empty block. File content is named rather than inlined — the bytes are not
 * ours to render here.
 */
export function renderToolOutput(data: Record<string, unknown>): string {
  const content = data.content
  if (Array.isArray(content)) {
    const lines: string[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      if (obj.type === 'text') {
        const text = str(obj.text)
        if (text) lines.push(text)
      } else if (obj.type === 'file') {
        lines.push(`[file] ${str(obj.name) ?? str(obj.uri) ?? 'attachment'}`)
      }
    }
    if (lines.length > 0) return lines.join('\n')
  }
  const structured = data.structured
  if (structured && typeof structured === 'object' && Object.keys(structured).length > 0) {
    try {
      return JSON.stringify(structured, null, 2)
    } catch {
      return ''
    }
  }
  return ''
}

/** Re-exported so the runner's metadata keys stay in one import. */
export const PART_METADATA_KEYS = {
  kind: KIND_METADATA_KEY,
  toolName: TOOL_NAME_METADATA_KEY,
  toolInput: TOOL_INPUT_METADATA_KEY,
  toolId: TOOL_ID_METADATA_KEY,
  toolStream: TOOL_STREAM_METADATA_KEY,
  fileId: FILE_ID_METADATA_KEY,
  fileName: FILE_NAME_METADATA_KEY,
  fileMime: FILE_MIME_METADATA_KEY
} as const
