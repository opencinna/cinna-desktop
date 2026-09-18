import { create } from 'zustand'
import type {
  ContentKind,
  MessagePart,
  MessagePartFile,
  ToolStream
} from '../../../shared/messageParts'
import type { InputRequest, InputResumeMode, RunEvent } from '../../../shared/runEvents'
import type { MessageAttachment } from '../../../shared/attachments'
import { continuingPartIndex } from '../../../shared/partMerge'

export type { ContentKind, ToolStream }

/**
 * A run waiting on a human, as announced by a `needs_input` stream event.
 *
 * `toolCallId` is set when the ask came from a nested agent (a `child` event),
 * naming the orchestrator's tool call whose sub-thread raised it.
 */
export interface PendingInputRequest {
  requestId: string
  request: InputRequest
  resume: InputResumeMode
  toolCallId?: string
}

/**
 * Whether the stream says `requestId` is answerable **now**, by id.
 *
 * Only a `reply` entry counts: that run is parked on the ask and the answer is
 * posted to its address. A `next_message` entry is a turn that already ended
 * waiting — its answer path is the composer, so it never makes a block live.
 */
export function isLiveInputRequest(
  state: { inputRequests: PendingInputRequest[] },
  requestId: string | undefined
): boolean {
  if (!requestId) return false
  return state.inputRequests.some((r) => r.requestId === requestId && r.resume === 'reply')
}

/**
 * Whether the stream has said `requestId` is settled — `input_resolved`, or an
 * answer this window delivered.
 *
 * Checked before either source that can call a block live, because the
 * registry poll (`useAgentRequests`) can go on listing a settled ask for up to
 * a tick: a park that timed out, or an ask answered elsewhere, would otherwise
 * keep offering buttons whose answer can only be refused.
 */
export function isSettledInputRequest(
  state: { settledInputRequestIds: string[] },
  requestId: string | undefined
): boolean {
  return !!requestId && state.settledInputRequestIds.includes(requestId)
}

/**
 * What ending a stream leaves behind: a `reply` address dies with its turn, an
 * A2A question stays answerable by the next message.
 */
function withoutReplyRequests(requests: PendingInputRequest[]): PendingInputRequest[] {
  return requests.some((r) => r.resume === 'reply')
    ? requests.filter((r) => r.resume !== 'reply')
    : requests
}

export interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
  result?: unknown
  error?: string
  provider?: string
  status: 'pending' | 'done' | 'error'
  /** Tool source — `'agent'` tools accumulate a `subParts` sub-thread. */
  providerType?: 'mcp' | 'agent' | 'coordinator'
  /** Agent id backing an agent tool — drives the sub-thread hash color. */
  agentId?: string
  /**
   * Live agent sub-thread (orchestrated mode): the agent's `parts[]` built up
   * from `child` deltas keyed by this block's `id`. Rendered as a
   * nested `<AgentContribution>` inside the tool-call block.
   */
  subParts?: MessagePart[]
}

/**
 * Apply one A2A delta to a `MessagePart[]`, mirroring the main-process
 * `StreamPartsAccumulator.appendToList` merge rules so the live sub-thread
 * matches what gets persisted on the tool_call row.
 */
function appendAgentDeltaPart(
  parts: MessagePart[],
  delta: {
    kind: ContentKind
    text: string
    toolName?: string
    toolInput?: Record<string, unknown>
    toolId?: string
    toolStream?: ToolStream
    commandInvocation?: string
    file?: MessagePartFile
    parentToolId?: string
    newPart?: boolean
  }
): MessagePart[] {
  const { kind, text, toolName, toolInput, toolId, toolStream, commandInvocation, file, parentToolId, newPart } = delta
  const out = parts.slice()
  // Lanes as on the top-level path: a delegated agent's own subagent keeps its
  // parts apart, and `newPart` is main's word that this fragment starts one.
  // (A sub-thread has no user blocks, so nothing else ends a lane here.)
  const index = newPart ? -1 : continuingPartIndex(out, { kind, toolName, toolId, toolStream, parentToolId })
  const last = out[index]
  // The accumulator's own rule (`shared/partMerge.ts`), so the live sub-thread
  // splits exactly where the persisted one will.
  if (last) {
    out[index] = {
      ...last,
      text: last.text + text,
      toolInput: last.toolInput ?? toolInput,
      toolId: last.toolId ?? toolId,
      commandInvocation: last.commandInvocation ?? commandInvocation
    }
  } else {
    const next: MessagePart = { kind, text }
    if (toolName) next.toolName = toolName
    if (toolInput) next.toolInput = toolInput
    if (toolId) next.toolId = toolId
    if (toolStream) next.toolStream = toolStream
    if (commandInvocation) next.commandInvocation = commandInvocation
    if (file) next.file = file
    if (parentToolId) next.parentToolId = parentToolId
    out.push(next)
  }
  return out
}

interface TextBlock {
  type: 'text'
  kind: ContentKind
  content: string
  toolName?: string
  /** Structured tool arguments from `cinna.tool_input` metadata (tool kind). */
  toolInput?: Record<string, unknown>
  /** Pairing key from `cinna.tool_id` (tool + tool_result kinds). */
  toolId?: string
  /** Stream classification from `cinna.tool_stream` (tool_result only). */
  toolStream?: ToolStream
  /** Slash invocation from `cinna.command_invocation` — see MessagePart. */
  commandInvocation?: string
  /** Set only when `kind === 'file'` — agent-attached file (A2A FilePart). */
  file?: MessagePartFile
  /** A subagent's block: the Agent call it runs under — see MessagePart. */
  parentToolId?: string
}

/**
 * A message the user sent that the running turn took in (a `user_message`
 * event), at the point in the live output where it landed. The turn persists it
 * as a user row in the same place.
 */
export interface UserBlock {
  type: 'user'
  content: string
}

export type StreamBlock = TextBlock | ToolCallBlock | UserBlock

/**
 * Optimistic user message — rendered the instant the user sends, before the
 * persisted row arrives via the `['chat', chatId]` refetch. Keyed by a
 * snapshot of how many user rows the chat already had at send time
 * (`baselineUserCount`) rather than by content, so `MessageStream` can drop the
 * optimistic copy the moment a *new* user row appears even when its text is
 * identical to a previous turn (content-keyed dedup hid the second of two
 * identical consecutive messages until its own row refetched).
 */
export interface PendingUserMessage {
  content: string
  baselineUserCount: number
  // Attachments already ingested at send time, so the optimistic bubble shows
  // its file badges immediately — without this the badges only appear once the
  // persisted row refetches, lagging the bubble itself.
  attachments?: MessageAttachment[]
}

interface ChatStore {
  activeChatId: string | null
  liveProjectionVersion: number
  liveRunId: string | null
  liveBaselineMessageIds: string[] | null
  streamingBlocks: StreamBlock[]
  isStreaming: boolean
  activeRequestId: string | null
  pendingUserMessage: PendingUserMessage | null
  // Chat ID of the most recent stream that produced gradual deltas. Scoped
  // per-chat so MessageStream only suppresses the DB-arrival fade-in for the
  // exact chat whose stream just finished — out-of-band message arrivals on
  // other chats still animate normally.
  streamedIncrementallyChatId: string | null
  // User-facing send error surfaced above the chat input (e.g. "no provider
  // configured"). Set by the new-chat pre-flight check and by stream `error`
  // events; cleared on next user action.
  sendError: string | null
  // Asks the stream has announced and not yet settled, in arrival order. Only
  // the current stream's: starting one or switching chats clears the list, and
  // ending one drops the `reply` entries whose parked turn just died.
  inputRequests: PendingInputRequest[]
  // Ids the stream has said are settled, so a block stops being live before
  // the registry poll catches up. Cleared only when a stream starts or the chat
  // changes: the poll's last read can land after the stream has ended.
  settledInputRequestIds: string[]
  // Who the next message in a `human`-routed chat is addressed to, per chat.
  //
  // Keyed by chat id and kept out of the composer's own state on purpose: the
  // gesture that sets it (an `@` pick, a chip click) and the badge that reads it
  // live in different components, and switching away from a chat and back must
  // not silently re-point the message at somebody else. `null` — or no entry —
  // means "whoever answered last", which main resolves from the transcript.
  addressedAgentByChat: Record<string, string>
  /**
   * Bumped by every send from this window, whatever main does with it —
   * started, taken into the running turn or queued. The transcript re-engages
   * following on it: the user just acted, and what they acted on is at the bottom.
   */
  sentVersion: number
  /** The queued message the active composer is editing, so its bubble can say so. */
  editingQueued: { chatId: string; id: string } | null
  /**
   * Queued messages the user cancelled from their bubble, most recent last, so
   * the composer editing one can tell a cancel from main sending it first.
   * Queue ids are unique across chats; only the last few are kept.
   */
  cancelledQueuedIds: string[]

  setActiveChatId: (id: string | null) => void
  noteSent: () => void
  setEditingQueued: (editing: { chatId: string; id: string } | null) => void
  /** The user cancelled this queued message from its bubble. */
  noteQueuedCancelled: (id: string) => void
  /** Main answered that the cancel came too late: the message was sent, not cancelled. */
  forgetQueuedCancelled: (id: string) => void
  setAddressedAgent: (chatId: string, agentId: string) => void
  startStreaming: (requestId: string) => void
  setPendingUserMessage: (message: PendingUserMessage | null) => void
  appendDelta: (
    text: string,
    kind?: ContentKind,
    toolName?: string,
    toolInput?: Record<string, unknown>,
    toolId?: string,
    toolStream?: ToolStream,
    commandInvocation?: string,
    file?: MessagePartFile,
    parentToolId?: string,
    newPart?: boolean
  ) => void
  addToolCall: (tc: {
    id: string
    name: string
    input: Record<string, unknown>
    provider?: string
    providerType?: 'mcp' | 'agent' | 'coordinator'
    agentId?: string
  }) => void
  /** A user message taken into the running turn, after the blocks so far. */
  appendUserMessage: (text: string) => void
  resolveToolCall: (id: string, result: unknown) => void
  failToolCall: (id: string, error: string) => void
  /** Accumulate one nested agent's stream event into an agent tool's sub-thread. */
  appendToolSubEvent: (toolCallId: string, event: RunEvent) => void
  /** Record a `needs_input`; a repeat of a known `requestId` replaces it in place. */
  addInputRequest: (entry: PendingInputRequest) => void
  /** Forget a settled ask, and remember its id as settled — known to the store or not. */
  resolveInputRequest: (requestId: string) => void
  /** Drop the asks a nested agent raised under this tool call, once the call has ended. */
  dropInputRequestsFor: (toolCallId: string) => void
  finishStreaming: () => void
  clearStreamingBlocks: () => void
  stopStreaming: () => void
  setSendError: (error: string | null) => void
  reset: () => void
}

/** A cancel is read back within one queue refresh; this many is ample. */
const CANCELLED_QUEUED_KEPT = 20

export const useChatStore = create<ChatStore>((set) => ({
  activeChatId: null,
  liveProjectionVersion: 0,
  liveRunId: null,
  liveBaselineMessageIds: null,
  streamingBlocks: [],
  isStreaming: false,
  activeRequestId: null,
  pendingUserMessage: null,
  streamedIncrementallyChatId: null,
  sendError: null,
  inputRequests: [],
  settledInputRequestIds: [],
  addressedAgentByChat: {},
  sentVersion: 0,
  editingQueued: null,
  cancelledQueuedIds: [],

  noteSent: () => set((state) => ({ sentVersion: state.sentVersion + 1 })),

  noteQueuedCancelled: (id) =>
    set((state) => ({
      cancelledQueuedIds: [...state.cancelledQueuedIds.filter((known) => known !== id).slice(-(CANCELLED_QUEUED_KEPT - 1)), id]
    })),

  forgetQueuedCancelled: (id) =>
    set((state) =>
      state.cancelledQueuedIds.includes(id)
        ? { cancelledQueuedIds: state.cancelledQueuedIds.filter((known) => known !== id) }
        : state
    ),

  setEditingQueued: (editing) =>
    set((state) =>
      state.editingQueued?.chatId === editing?.chatId && state.editingQueued?.id === editing?.id
        ? state
        : { editingQueued: editing }
    ),

  setAddressedAgent: (chatId, agentId) =>
    set((state) => ({
      addressedAgentByChat: { ...state.addressedAgentByChat, [chatId]: agentId }
    })),

  setActiveChatId: (id) =>
    // Re-selecting the chat on screen (its sidebar row, or the Chats tab
    // landing on it) changes nothing. The live watcher re-subscribes only when
    // the id changes, so a reset here wiped a running turn's blocks and its
    // streaming state with no snapshot coming to restore them. Selecting no
    // chat always resets: there is no watcher to lose, and profile switches and
    // the new-chat screen rely on it to clear a stale `sendError`.
    set((state) => id !== null && state.activeChatId === id ? state : ({
      liveProjectionVersion: state.liveProjectionVersion + 1,
      activeChatId: id,
      activeRequestId: null,
      liveRunId: null,
      liveBaselineMessageIds: null,
      streamingBlocks: [],
      isStreaming: false,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null,
      sendError: null,
      inputRequests: [],
      settledInputRequestIds: [],
      editingQueued: null
    })),

  setPendingUserMessage: (message) =>
    set({ pendingUserMessage: message }),

  startStreaming: (requestId) =>
    // Deliberately does NOT clear `pendingUserMessage`. The optimistic user
    // bubble must stay rendered until the persisted row arrives via the
    // `['chat', chatId]` refetch — `MessageStream` suppresses it once the user
    // row count grows past `baselineUserCount` (the same "no visual gap"
    // handoff that keeps `streamingBlocks` until `clearStreamingBlocks`).
    // Clearing it here left a window where neither the optimistic bubble nor
    // the (not-yet-refetched) persisted row was visible, so the user's message
    // vanished while the assistant reply streamed in.
    set({
      isStreaming: true,
      streamingBlocks: [],
      activeRequestId: requestId,
      streamedIncrementallyChatId: null,
      sendError: null,
      // A new turn is the answer to any `next_message` ask the last one ended
      // on, and a `reply` ask cannot outlive its own turn.
      inputRequests: [],
      settledInputRequestIds: []
    }),

  appendDelta: (
    text,
    kind = 'text',
    toolName,
    toolInput,
    toolId,
    toolStream,
    commandInvocation,
    file,
    parentToolId,
    newPart
  ) =>
    set((state) => {
      const blocks = [...state.streamingBlocks]
      // A non-text block is `undefined` here, which the rule counts as the
      // main lane: it ends the agent's own run of text, not a subagent's.
      let index = continuingPartIndex(blocks.map((block) => block.type === 'text' ? block : undefined), { kind, toolName, toolId, toolStream, parentToolId })
      // A user message taken into the turn ends every lane, as the
      // accumulator's `breakContinuation` does: only a tool call named by id
      // may still grow on its far side. Otherwise a subagent's text would run
      // on across it live and split there once saved.
      const userAt = blocks.findLastIndex((block) => block.type === 'user')
      if (index >= 0 && index < userAt && !(kind === 'tool' && toolId)) index = -1
      // Main decided this fragment opens a part (another source part, with
      // another lane's parts between) — see `RunDeltaEvent.newPart`.
      if (newPart) index = -1
      const last = blocks[index]
      // The main-process accumulator's rule, from one place
      // (`shared/partMerge.ts`), so live blocks split where persisted parts do.
      if (last?.type === 'text') {
        blocks[index] = {
          ...last,
          content: last.content + text,
          toolInput: last.toolInput ?? toolInput,
          toolId: last.toolId ?? toolId,
          commandInvocation: last.commandInvocation ?? commandInvocation
        }
      } else {
        const next: TextBlock = { type: 'text', kind, content: text }
        if (toolName) next.toolName = toolName
        if (toolInput) next.toolInput = toolInput
        if (toolId) next.toolId = toolId
        if (toolStream) next.toolStream = toolStream
        if (commandInvocation) next.commandInvocation = commandInvocation
        if (file) next.file = file
        if (parentToolId) next.parentToolId = parentToolId
        blocks.push(next)
      }
      return {
        streamingBlocks: blocks,
        streamedIncrementallyChatId: state.activeChatId
      }
    }),

  addToolCall: (tc) =>
    set((state) => ({
      streamingBlocks: [
        ...state.streamingBlocks,
        { type: 'tool_call', ...tc, status: 'pending' as const }
      ],
      streamedIncrementallyChatId: state.activeChatId
    })),

  appendUserMessage: (text) =>
    // A block that is not text also ends the run of text before it, so the
    // agent's next words start a block of their own below the message.
    set((state) => ({ streamingBlocks: [...state.streamingBlocks, { type: 'user', content: text }] })),

  appendToolSubEvent: (toolCallId, event) =>
    set((state) => {
      // Only `delta` events carry parts. Notices are agent-side system pings,
      // excluded from the persisted `parts[]` — skip them here too so the live
      // sub-thread matches the reloaded one.
      if (event.type !== 'delta' || event.kind === 'notice') return state
      return {
        streamingBlocks: state.streamingBlocks.map((b) =>
          b.type === 'tool_call' && b.id === toolCallId
            ? {
                ...b,
                subParts: appendAgentDeltaPart(b.subParts ?? [], {
                  kind: event.kind,
                  text: event.text,
                  toolName: event.toolName,
                  toolInput: event.toolInput,
                  toolId: event.toolId,
                  toolStream: event.toolStream,
                  commandInvocation: event.commandInvocation,
                  file: event.file,
                  parentToolId: event.parentToolId,
                  newPart: event.newPart
                })
              }
            : b
        ),
        streamedIncrementallyChatId: state.activeChatId
      }
    }),

  addInputRequest: (entry) =>
    set((state) => {
      // An id asked again is open again.
      const settledInputRequestIds = state.settledInputRequestIds.includes(entry.requestId)
        ? state.settledInputRequestIds.filter((id) => id !== entry.requestId)
        : state.settledInputRequestIds
      const index = state.inputRequests.findIndex((r) => r.requestId === entry.requestId)
      if (index === -1) {
        return { inputRequests: [...state.inputRequests, entry], settledInputRequestIds }
      }
      const inputRequests = state.inputRequests.slice()
      inputRequests[index] = entry
      return { inputRequests, settledInputRequestIds }
    }),

  resolveInputRequest: (requestId) =>
    set((state) => {
      const held = state.inputRequests.some((r) => r.requestId === requestId)
      const known = state.settledInputRequestIds.includes(requestId)
      // The usual second call — the runner's echo after an optimistic answer —
      // changes nothing, and returning the same state spares every whole-store
      // subscriber a render.
      if (!held && known) return state
      return {
        inputRequests: held
          ? state.inputRequests.filter((r) => r.requestId !== requestId)
          : state.inputRequests,
        // Remembered even for an id the store never held: an ask known only
        // through the registry poll is just as settled.
        settledInputRequestIds: known
          ? state.settledInputRequestIds
          : [...state.settledInputRequestIds, requestId]
      }
    }),

  dropInputRequestsFor: (toolCallId) =>
    set((state) =>
      toolCallId && state.inputRequests.some((r) => r.toolCallId === toolCallId)
        ? { inputRequests: state.inputRequests.filter((r) => r.toolCallId !== toolCallId) }
        : state
    ),

  resolveToolCall: (id, result) =>
    set((state) => ({
      streamingBlocks: state.streamingBlocks.map((b) =>
        b.type === 'tool_call' && b.id === id ? { ...b, result, status: 'done' as const } : b
      )
    })),

  failToolCall: (id, error) =>
    set((state) => ({
      streamingBlocks: state.streamingBlocks.map((b) =>
        b.type === 'tool_call' && b.id === id ? { ...b, error, status: 'error' as const } : b
      )
    })),

  finishStreaming: () =>
    // Keep `pendingUserMessage` set past `done`: the `done` handler keeps
    // `streamingBlocks` visible until the watcher fetches the saved transcript,
    // then drops both together — the user bubble
    // follows the same lifecycle so there's no gap when `done` beats the
    // refetch. The post-refetch clear (not this transition) is what finally
    // retires the optimistic copy, by which point its persisted row is in view.
    set((state) => ({
      isStreaming: false,
      inputRequests: withoutReplyRequests(state.inputRequests)
    })),

  clearStreamingBlocks: () =>
    set((state) => ({
      streamingBlocks: [],
      activeRequestId: null,
      inputRequests: withoutReplyRequests(state.inputRequests)
    })),

  stopStreaming: () =>
    set((state) => ({
      isStreaming: false,
      streamingBlocks: [],
      activeRequestId: null,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null,
      inputRequests: withoutReplyRequests(state.inputRequests)
    })),

  setSendError: (error) => set({ sendError: error }),

  reset: () =>
    set((state) => ({
      liveProjectionVersion: state.liveProjectionVersion + 1,
      activeChatId: null,
      liveRunId: null,
      liveBaselineMessageIds: null,
      streamingBlocks: [],
      isStreaming: false,
      activeRequestId: null,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null,
      sendError: null,
      inputRequests: [],
      settledInputRequestIds: [],
      addressedAgentByChat: {},
      editingQueued: null,
      cancelledQueuedIds: []
    }))
}))
