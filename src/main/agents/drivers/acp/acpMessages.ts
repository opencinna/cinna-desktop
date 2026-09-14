/**
 * Turning an ACP agent's `session/update` notifications into the A2A-shaped
 * message the rest of the pipeline already knows how to read.
 *
 * The successor to `turnStream.ts` (OpenCode over HTTP) and `claudeMessages.ts`
 * (the Claude Agent SDK in-process), both deleted with the runners they served:
 * one wire replaces both, and the same trap applies.
 * `StreamPartsAccumulator` was built for A2A, where every update carries each
 * part's **full text so far** and the accumulator computes the delta itself
 * (`text.slice(prior.length)`). ACP emits **true deltas**: one
 * `agent_message_chunk` per token-ish fragment. So this class does not
 * translate an update into a part — it maintains the *cumulative* message and
 * hands the whole thing back for re-ingestion. Feeding a raw ACP chunk to the
 * accumulator as if it were an A2A part looks right for one chunk and
 * duplicates every character after it.
 *
 * ## What the wire actually looks like
 *
 * Watched, not assumed. Every rule below is checkable against the spike
 * recordings in `../cinna-desktop-spike-acp/spike/acp/{opencode,claude}/
 * recordings/*.ndjson`, distilled into `__fixtures__/` beside this file. One
 * OpenCode turn that calls a tool:
 *
 * ```
 * available_commands_update                  at session/new and session/load
 * agent_thought_chunk  {messageId, content}  ~400 of them, one per fragment
 * tool_call            {toolCallId, title}   title IS the tool name: "write"
 * tool_call_update     status:in_progress    rawInput fills in
 * tool_call_update     status:completed      content[] + rawOutput.output
 * agent_thought_chunk  {messageId: NEW}      the reply after the call
 * agent_message_chunk  {messageId: same}
 * usage_update                               ignored
 * ```
 *
 * Four consequences shape everything below.
 *
 * **1. Only a chunk names a message.** `tool_call` and `tool_call_update` carry
 * no `messageId` at all — in either launcher. So a tool call is filed under the
 * message that was current when it arrived, tracked here because nothing on the
 * wire repeats it. Under the Claude adapter the tool calls of a turn arrive
 * *before* its first chunk (`claude/s2-perms-turn.ndjson`: five tool calls,
 * then the reply), so they land in an anonymous message of their own — which is
 * fine, and far better than adopting the id of whatever message comes next.
 *
 * **2. The first title wins as the tool name.** OpenCode's `tool_call` titles
 * itself `"write"` and its *completed* update retitles the same call
 * `"private/tmp/…/notes.txt"` (`opencode/q2-permission.ndjson`); the Claude
 * adapter goes the other way, titling a Bash call `"Terminal"` and then the
 * command. Neither later title is a tool name. What is authoritative is
 * `_meta.claudeCode.toolName`, then the unstable `name` field, and only then
 * the first title — see {@link resolveToolName}.
 *
 * **3. A tool call ends a run of text.** A turn is text → tool → more text, and
 * the second run must not be appended to the first part: the renderer would
 * show the tool block after a paragraph it interrupted. Every text part is
 * therefore keyed by a generation that a new tool call bumps. Both launchers
 * happen to start a fresh `messageId` after a call as well, so no recording
 * *forces* this rule — it is here so the transcript does not depend on that
 * being true of every agent, which the protocol never promised.
 *
 * **4. The union is far wider than the kinds handled here**, and it grows.
 * `SessionUpdate` has 15 members at SDK 1.4.0 and four of them are marked
 * unstable. **Unknown kinds are ignored silently and by default**, and nothing
 * in this file throws: a turn that was going fine must not die because the
 * agent learned a new trick.
 *
 * ## What is deliberately not here
 *
 * No Electron, no filesystem, no process, no clock. Everything this class does
 * is a function of the notifications it has been given, which is what makes the
 * whole update→transcript mapping testable without a binary.
 */

import {
  describePermissionAction,
  PERMISSION_TOOL_NAME,
  QUESTION_TOOL_NAME,
  type LocalPermissionRequest
} from '../../../../shared/localAgentRequests'
import type { InputQuestion } from '../../../../shared/runEvents'
import {
  KIND_METADATA_KEY,
  TOOL_ID_METADATA_KEY,
  TOOL_INPUT_METADATA_KEY,
  TOOL_NAME_METADATA_KEY,
  TOOL_STREAM_METADATA_KEY,
  type PartLike
} from '../../streamPartsAccumulator'
import type { AcpLauncherId, AcpStreamUpdate } from './types'
import type { SessionNotification } from '@agentclientprotocol/sdk'

/** The message a block belongs to when no chunk has named one yet. */
const ANON_MESSAGE_ID = 'anon:acp'

/** How much of a tool's most identifying argument a narration line shows. */
const NARRATION_LIMIT = 160

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

interface MessageState {
  parts: PartLike[]
  /** Part key → index in `parts`. Assigned once, never reassigned. */
  index: Map<string, number>
}

export class AcpMessageStream {
  /**
   * Which engine is on the other end.
   *
   * Recorded rather than used: every rule in this file held for both launchers
   * across the spike recordings, so there is nothing to branch on today. It is
   * a constructor argument anyway because the first launcher-specific quirk —
   * Gemini and Codex are not even installed on the machine this was written on
   * — should land in one named place here rather than be discovered at a call
   * site that has no idea which agent it is talking to.
   */
  readonly launcher: AcpLauncherId | undefined

  private readonly messages = new Map<string, MessageState>()
  /**
   * The message id the current tool calls and notices belong to.
   *
   * Only a chunk carries one, so without this every tool call would be filed
   * under a key of its own and the renderer could not fold a call, its result
   * and the permission ask it raised into one block.
   */
  private currentMessageId: string | undefined
  /** `toolCallId` → the tool name, resolved once on first sight (see rule 2). */
  private readonly toolNames = new Map<string, string>()
  /** `toolCallId` → the message its call part lives in, so its result joins it. */
  private readonly toolMessage = new Map<string, string>()
  /** Which message each ask's block lives in, so its decision joins it. */
  private readonly requestMessage = new Map<string, string>()
  /** Bumped by every new tool call: what makes text after a call a new part. */
  private generation = 0
  /** One slot per note, so a turn that says two things says them twice. */
  private notes = 0
  /** The last plan rendered, to swallow a re-send that changed nothing. */
  private lastPlan: string | undefined

  constructor(options?: { launcher?: AcpLauncherId }) {
    this.launcher = options?.launcher
  }

  /**
   * Fold one `session/update` in.
   *
   * Returns an empty update for anything it does not recognise, which is most
   * of the union and deliberately so. The `try` is the backstop behind the
   * structural checks, not a substitute for them: a translator that throws
   * takes down a turn that the agent itself was running perfectly well.
   */
  apply(notification: SessionNotification): AcpStreamUpdate {
    try {
      return this.applyUpdate(notification)
    } catch {
      return {}
    }
  }

  /**
   * An extension notification — `_auth/status_update`, `_session/steering`,
   * `_session/goal`, whatever the next adapter version invents.
   *
   * Nothing here reaches the transcript, and that is the whole point of the
   * method existing: the Claude adapter volunteers the account's **email
   * address** in `_auth/status_update` after every `session/new`, unasked and
   * with no way to switch it off short of refusing subscription use
   * (`claude/s2-perms-turn.ndjson`). Funnelling every extension through one
   * function that keeps nothing is what makes "the driver drops it" a fact
   * about the code rather than a promise about every call site.
   */
  applyExt(_method: string, _params: Record<string, unknown>): AcpStreamUpdate {
    return {}
  }

  /**
   * Write a permission ask into the transcript.
   *
   * Filed under the message that owns the tool call the ask is about, so the
   * block sits beside the call that raised it rather than in a stray message of
   * its own. `callId` is what the driver read off `params.toolCall.toolCallId`;
   * an ask that names no call falls back to the current message, which is where
   * the agent was talking when it stopped to ask.
   *
   * Returns nothing when a block for this id already exists, so a re-ask cannot
   * duplicate it.
   */
  askPermission(requestId: string, request: LocalPermissionRequest): AcpStreamUpdate {
    const messageId =
      (request.callId ? this.toolMessage.get(request.callId) : undefined) ?? this.owner()
    this.requestMessage.set(requestId, messageId)
    return this.writePart(
      messageId,
      `perm:${requestId}`,
      {
        [KIND_METADATA_KEY]: 'tool',
        [TOOL_NAME_METADATA_KEY]: PERMISSION_TOOL_NAME,
        [TOOL_ID_METADATA_KEY]: requestId,
        [TOOL_INPUT_METADATA_KEY]: request as unknown as Record<string, unknown>
      },
      describeAcpPermission(request)
    )
  }

  /**
   * Record what was decided, paired to the ask by the same `cinna.tool_id`.
   *
   * The pairing is not cosmetic: the renderer folds the result into the request
   * block, so without it the persisted transcript shows a permission prompt
   * with no record of the answer — an approval nobody can later account for is
   * the worst kind of audit trail.
   */
  settlePermission(requestId: string, text: string): AcpStreamUpdate {
    return this.settle(requestId, text)
  }

  /**
   * Write a question into the transcript, under the reserved tool name the
   * renderer already pattern-matches to show its answer widget.
   *
   * OpenCode asks by calling its own `question` tool with the questions in
   * `rawInput` (`opencode/q3-question-enabled.ndjson`); the Claude adapter
   * would ask through `elicitation/create`, which never fired in the spike
   * because the probe declared no elicitation capability. Either way the driver
   * has already normalised them to {@link InputQuestion}, so this end of the
   * pipe writes the same shape the HTTP path used to.
   *
   * `callId` is the tool call the elicitation names, when it names one — the
   * Claude adapter sends its own `AskUserQuestion` call's id as `toolCallId`.
   * The question is filed beside that call, as a permission ask is, and the id
   * rides in the input: that call's result only restates the answer, and the
   * renderer needs the id to fold it into this block rather than show it twice.
   */
  askQuestion(requestId: string, questions: InputQuestion[], callId?: string): AcpStreamUpdate {
    if (questions.length === 0) return {}
    const messageId =
      (callId ? this.toolMessage.get(callId) : undefined) ??
      this.requestMessage.get(requestId) ??
      this.owner()
    this.requestMessage.set(requestId, messageId)
    return this.writePart(
      messageId,
      `question:${requestId}`,
      {
        [KIND_METADATA_KEY]: 'tool',
        [TOOL_NAME_METADATA_KEY]: QUESTION_TOOL_NAME,
        [TOOL_ID_METADATA_KEY]: requestId,
        [TOOL_INPUT_METADATA_KEY]: callId ? { questions, callId } : { questions }
      },
      questions.length > 1 ? `Asked ${questions.length} questions.` : 'Asked a question.'
    )
  }

  /** The answer, paired to the question by the same id. See {@link settlePermission}. */
  settleQuestion(requestId: string, text: string): AcpStreamUpdate {
    return this.settle(requestId, text)
  }

  /**
   * The desktop speaking in the transcript, as a notice under the current
   * message — a notice rather than text because it is not the agent talking,
   * and notices are the channel for that.
   */
  note(text: string): AcpStreamUpdate {
    if (!str(text)) return {}
    this.notes += 1
    return this.writePart(
      this.owner(),
      `note:${this.notes}`,
      { [KIND_METADATA_KEY]: 'notice' },
      text
    )
  }

  /**
   * The tool name recorded for a tool call id.
   *
   * The driver needs it because a permission ask often names no tool: OpenCode's
   * `session/request_permission` carries a `toolCall` whose `title` is by then
   * the *file path* and which has no `name` at all
   * (`opencode/q2-permission.ndjson` line 274), so the only place the word
   * "write" still exists is the `tool_call` this class already folded in.
   */
  toolName(toolCallId: string): string | undefined {
    return this.toolNames.get(toolCallId)
  }

  // ── translation ───────────────────────────────────────────────────────────

  private applyUpdate(notification: SessionNotification): AcpStreamUpdate {
    const update = record(notification?.update)
    if (!update) return {}

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.chunk(update, 'text')
      case 'agent_thought_chunk':
        return this.chunk(update, 'thinking')
      case 'user_message_chunk':
        // The desktop's own message coming back during a `session/load` replay
        // — it is already in the transcript. Dropped **including its
        // `messageId`**: adopting it would file the replayed tool calls under
        // the user's message (`claude/s2-load-after-restart.ndjson`, where the
        // user chunk leads and five tool calls follow).
        return {}
      case 'tool_call':
      case 'tool_call_update':
        return this.toolCall(update)
      case 'plan':
        return this.plan(update)
      case 'current_mode_update': {
        const modeId = str(update.currentModeId)
        return modeId ? { modeId } : {}
      }
      case 'config_option_update':
        return this.configOptions(update)
      default:
        // `usage_update`, `compaction_*`, `plan_update`, `plan_removed` and
        // whatever comes next. Silence is the contract, not an oversight.
        return {}
    }
  }

  private chunk(update: Record<string, unknown>, kind: 'text' | 'thinking'): AcpStreamUpdate {
    const content = record(update.content)
    // Only text has a transcript representation. An image or an embedded
    // resource in a message chunk is dropped rather than announced, because a
    // `[image]` placeholder spliced into a sentence reads worse than the gap.
    const text = content?.type === 'text' ? str(content.text) : undefined
    const messageId = str(update.messageId) ?? this.owner()
    this.currentMessageId = messageId
    if (text === undefined) return {}

    const state = this.messageState(messageId)
    const key = `${kind}:${messageId}:${this.generation}`
    const idx = this.slot(state, key, () => ({
      kind: 'text',
      text: '',
      metadata: { [KIND_METADATA_KEY]: kind }
    }))
    state.parts[idx] = { ...state.parts[idx], text: (state.parts[idx].text ?? '') + text }
    return { message: { messageId, parts: state.parts } }
  }

  /**
   * One tool call, folded from however many updates describe it.
   *
   * `tool_call` and `tool_call_update` are handled by the same code on purpose:
   * a `session/load` replay collapses a whole call into a single already-
   * completed `tool_call` (`claude/s2-load-after-restart.ndjson`), so a reader
   * that only produced results from `tool_call_update` would replay a session
   * as a list of calls with no outputs.
   */
  private toolCall(update: Record<string, unknown>): AcpStreamUpdate {
    const toolCallId = str(update.toolCallId)
    if (!toolCallId) return {}

    const fresh = !this.toolNames.has(toolCallId)
    if (fresh) {
      this.toolNames.set(toolCallId, resolveToolName(update))
      // Rule 3: whatever text was streaming has ended. The next chunk opens a
      // new part instead of continuing the paragraph this call interrupted.
      this.generation += 1
    }
    const name = this.toolNames.get(toolCallId) ?? 'tool'
    const messageId = this.toolMessage.get(toolCallId) ?? this.owner()
    this.toolMessage.set(toolCallId, messageId)

    const state = this.messageState(messageId)
    const input = nonEmptyRecord(update.rawInput)
    const idx = this.slot(state, `tool:${toolCallId}`, () => ({
      kind: 'text',
      // The accumulator drops a part with empty text, so a tool call needs a
      // narration line to exist at all; the structured call rides on metadata.
      text: '',
      metadata: {
        [KIND_METADATA_KEY]: 'tool',
        [TOOL_NAME_METADATA_KEY]: name,
        [TOOL_ID_METADATA_KEY]: toolCallId
      }
    }))

    let changed = false
    if (input) {
      // `rawInput` streams in as the model writes it — `{}`, then `{file_path}`,
      // then the whole call (`claude/s2-perms-turn.ndjson` lines 28-30). The
      // last one seen is the complete one, so it replaces rather than merges.
      const prior = state.parts[idx].metadata?.[TOOL_INPUT_METADATA_KEY]
      if (prior !== input) {
        state.parts[idx] = {
          ...state.parts[idx],
          metadata: { ...state.parts[idx].metadata, [TOOL_INPUT_METADATA_KEY]: input }
        }
        changed = true
      }
    }
    const narration = describeAcpToolCall(name, input)
    if ((state.parts[idx].text ?? '').length < narration.length) {
      state.parts[idx] = { ...state.parts[idx], text: narration }
      changed = true
    }
    if (this.toolResult(update, toolCallId, state)) changed = true

    return changed ? { message: { messageId, parts: state.parts } } : {}
  }

  /**
   * The tool's output, as a `tool_result` part paired to the call by id.
   *
   * **Only a terminal status produces one.** An in-progress update carries
   * `content` too, but it is a preview of the *input* — the Write call in
   * `claude/s2-perms-turn.ndjson` sends the diff it is about to apply while it
   * is still waiting for permission, and reading that as output would put the
   * result of a tool into the transcript before the user had allowed it to run.
   */
  private toolResult(
    update: Record<string, unknown>,
    toolCallId: string,
    state: MessageState
  ): boolean {
    const status = str(update.status)
    if (status !== 'completed' && status !== 'failed') return false
    const text = toolOutputText(update.content) || toolOutputText(update.rawOutput)
    if (!text) return false

    const idx = this.slot(state, `result:${toolCallId}`, () => ({
      kind: 'text',
      text: '',
      metadata: {
        [KIND_METADATA_KEY]: 'tool_result',
        [TOOL_ID_METADATA_KEY]: toolCallId,
        // The renderer always wants a stream label. A tool that failed is
        // `stderr` so it reads as the error it is — which is also how a refused
        // permission arrives ("User refused permission to run tool").
        [TOOL_STREAM_METADATA_KEY]: status === 'failed' ? 'stderr' : 'stdout'
      }
    }))
    if ((state.parts[idx].text ?? '').length >= text.length) return false
    state.parts[idx] = { ...state.parts[idx], text }
    return true
  }

  /**
   * The agent's plan, as a notice.
   *
   * A plan is **replace** semantics — every update is the whole list again —
   * but the accumulator can only ever append to a part (it computes deltas as
   * `text.slice(prior.length)`), so a plan that changed cannot rewrite its own
   * block. Each distinct plan therefore gets a notice of its own, and a re-send
   * that renders identically is swallowed so a plan restated ten times without
   * moving does not fill the transcript with ten copies of itself.
   *
   * No spike recording contains a `plan`: the OpenCode model never produced one
   * and the Claude adapter reports its todo list as a `TodoWrite` tool call.
   * The shape here is the SDK's `Plan`, and the fixture says so.
   */
  private plan(update: Record<string, unknown>): AcpStreamUpdate {
    const entries = Array.isArray(update.entries) ? update.entries : []
    const lines = entries.flatMap((entry): string[] => {
      const e = record(entry)
      const content = e ? str(e.content) : undefined
      if (!content) return []
      const status = e ? str(e.status) : undefined
      const mark = status === 'completed' ? 'x' : status === 'in_progress' ? '~' : ' '
      return [`- [${mark}] ${content}`]
    })
    if (lines.length === 0) return {}
    const text = `Plan:\n${lines.join('\n')}`
    if (text === this.lastPlan) return {}
    this.lastPlan = text
    this.notes += 1
    const metadata = { [KIND_METADATA_KEY]: 'notice' }
    return this.writePart(this.owner(), `note:${this.notes}`, metadata, text)
  }

  /**
   * The session mode, out of a config option.
   *
   * The Claude adapter answers `session/set_mode` with `{}` and reports the new
   * mode only here (`claude/s6-load-set-mode-noturn.ndjson`); it emits no
   * `current_mode_update` at all. Everything but the `mode` option is ignored —
   * the same notification also carries the model and thinking-level options,
   * and this class has nowhere to put them.
   */
  private configOptions(update: Record<string, unknown>): AcpStreamUpdate {
    const options = Array.isArray(update.configOptions) ? update.configOptions : []
    for (const option of options) {
      const o = record(option)
      if (!o || o.id !== 'mode') continue
      const modeId = str(o.currentValue)
      if (modeId) return { modeId }
    }
    return {}
  }

  // ── message bookkeeping ───────────────────────────────────────────────────

  private owner(): string {
    return this.currentMessageId ?? ANON_MESSAGE_ID
  }

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
   * A desktop-authored block: created once, and its text only ever grows.
   *
   * Grow-only rather than overwrite because the accumulator computes deltas by
   * slicing off the prior text — a part whose text shrank or diverged would
   * post a delta that is neither.
   */
  private writePart(
    messageId: string,
    key: string,
    metadata: Record<string, unknown>,
    text: string
  ): AcpStreamUpdate {
    const state = this.messageState(messageId)
    const idx = this.slot(state, key, () => ({ kind: 'text', text: '', metadata }))
    if ((state.parts[idx].text ?? '').length >= text.length) return {}
    state.parts[idx] = { ...state.parts[idx], text }
    return { message: { messageId, parts: state.parts } }
  }

  private settle(requestId: string, text: string): AcpStreamUpdate {
    const messageId = this.requestMessage.get(requestId)
    if (!messageId || !str(text)) return {}
    return this.writePart(
      messageId,
      `decision:${requestId}`,
      {
        [KIND_METADATA_KEY]: 'tool_result',
        [TOOL_ID_METADATA_KEY]: requestId,
        [TOOL_STREAM_METADATA_KEY]: 'stdout'
      },
      text
    )
  }
}

/**
 * What to call a tool, in the order the recordings say is trustworthy.
 *
 * `_meta.claudeCode.toolName` is the adapter telling us the real name and it is
 * always right. `name` is ACP's own field for it, marked unstable and absent
 * from every `session/update` in the spike — carried because it is the field
 * the protocol intends for this and a newer agent may start sending it. `title`
 * is a **human sentence** that only happens to be the tool name in OpenCode,
 * and only on the first update; `kind` (`edit`, `execute`, `other`) is the last
 * resort, because a transcript saying "edit" is still better than one saying
 * "Preparing file…".
 */
function resolveToolName(update: Record<string, unknown>): string {
  const claudeCode = record(record(update._meta)?.claudeCode)
  return (
    str(claudeCode?.toolName) ?? str(update.name) ?? str(update.title) ?? str(update.kind) ?? 'tool'
  )
}

/** `rawInput` when it says something. An empty object is the model still writing. */
function nonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
  const r = record(value)
  return r && Object.keys(r).length > 0 ? r : undefined
}

/**
 * A tool's output flattened to text, from either place it can arrive.
 *
 * Both launchers use both. OpenCode puts it in `content[].content.text` and
 * again in `rawOutput.output`; the Claude adapter sends a bare string
 * `rawOutput` for Bash and Write, an array of blocks for an MCP tool, and a
 * fenced copy in `content[]`. A reader that knew only one of those would render
 * `[object Object]` — or nothing — for half the tools in a turn.
 */
function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const block = record(item)
        if (!block) return ''
        // A `ToolCallContent` wrapper (`{type:'content', content:{…}}`) or a
        // bare content block; both appear, so unwrap one level when it is there.
        const inner = record(block.content) ?? block
        if (typeof inner.text === 'string') return inner.text
        if (block.type === 'diff') return `[diff] ${str(block.path) ?? ''}`.trim()
        // Naming the type beats inventing a representation for it.
        return typeof block.type === 'string' ? `[${block.type}]` : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  const r = record(value)
  if (!r) return ''
  return str(r.output) ?? str(r.error) ?? ''
}

/**
 * A one-line narration for a tool call, since a part with no text is dropped.
 *
 * The narration names the tool and its most identifying argument, because a
 * transcript reading "Read" ten times tells the user nothing about what the
 * agent actually did. The key list is the **union** of both vocabularies —
 * OpenCode writes `filePath`, Claude writes `file_path` — rather than a mapping
 * per launcher, because the two never collide and a tool from an agent nobody
 * has run yet still gets a chance at a useful line.
 */
export function describeAcpToolCall(name: string, input?: Record<string, unknown>): string {
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input?.[key]
      if (typeof value === 'string' && value !== '') return value
    }
    return undefined
  }
  const detail = first(
    'command',
    'filePath',
    'file_path',
    'path',
    'notebook_path',
    'url',
    'pattern',
    'query',
    'prompt',
    'description'
  )
  if (!detail) return name
  const trimmed =
    detail.length > NARRATION_LIMIT ? `${detail.slice(0, NARRATION_LIMIT - 1)}…` : detail
  return `${name}: ${trimmed}`
}

/**
 * The one line a permission block leads with.
 *
 * Through the shared `describePermissionAction`, which knows every engine's
 * vocabulary, so the user reads the same sentence whichever agent asked —
 * `PermissionRequestBlock` calls the same function on the other side of the
 * bridge, and the two must not be able to disagree.
 */
export function describeAcpPermission(request: LocalPermissionRequest): string {
  const what = request.resources.length > 0 ? request.resources.join(', ') : request.action
  return `Permission needed to ${describePermissionAction(request.action)}: ${what}`
}
