import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type {
  InputRequest,
  RunEvent,
  RunInputResolvedEvent,
  RunNeedsInputEvent,
  RunState
} from '../../../shared/runEvents'
import type { ContentKind } from '../../../shared/messageParts'
import { PERMISSION_TOOL_NAME, QUESTION_TOOL_NAME } from '../../../shared/localAgentRequests'

/**
 * Event-by-event characterization of the selected chat's projection. The
 * lifecycle watcher owns subscription, persistence refresh and agent status;
 * this table pins the shared event handler's text, tool and ask semantics.
 */

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { useRunEventHandler } = await import('./useChatStream')
const { useChatStore, isLiveInputRequest, isSettledInputRequest } = await import('../stores/chat.store')
const { useAuthStore } = await import('../stores/auth.store')

const CHAT_ID = 'chat-1'
// A folder agent under a local account: the one combination where the post-turn
// status pull is a plain `forceRefresh: false` read, so it is observable here.

const AGENT_ID = 'folder:alpha'
const SNAPSHOT_KEYS = [
  'activeChatId',
  'isStreaming',
  'activeRequestId',
  'streamingBlocks',
  'pendingUserMessage',
  'streamedIncrementallyChatId',
  'sendError',
  'inputRequests',
  'settledInputRequestIds'
] as const
type SnapshotKey = (typeof SNAPSHOT_KEYS)[number]
type Snapshot = Record<SnapshotKey, unknown>
type Changes = Partial<Snapshot>
type ChatState = ReturnType<typeof useChatStore.getState>

interface Row<E> {
  name: string
  /** Events emitted before the one under test, to put the turn in a state. */
  seed: E[]
  /** Store fields forced after the seed, so a field the event leaves alone is visible. */
  seedState?: Partial<Pick<ChatState, SnapshotKey>>
  event: E
  /** Fields changed when the handler returns. Defaults to `settled`. */
  sync?: Changes
  /** Fields changed once pending promises settle. `{}` = the hook ignores the event. */
  settled: Changes
  /** Query keys invalidated by the event itself, in call order. */
  invalidates: unknown[][]
  /** The post-turn status pull (`agentStatus.get`) — agent sends only. */
  pullsStatus?: boolean
  /** The handler's own `console.error` line. */
  logged?: [string, string]
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let client: QueryClient
let runSend: ReturnType<typeof vi.fn>
let statusGet: ReturnType<typeof vi.fn>
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  runSend = vi.fn()
  statusGet = vi.fn().mockResolvedValue({ success: true, item: null })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    run: { send: runSend, cancel: vi.fn() },
    agents: { checkReadiness: vi.fn().mockResolvedValue(null) },
    agentStatus: { list: vi.fn().mockResolvedValue({ success: true, items: [] }), get: statusGet },
    chat: { get: vi.fn() }
  }
  useChatStore.getState().reset()
  // `streamedIncrementallyChatId` is copied from `activeChatId`, so it needs one.
  useChatStore.getState().setActiveChatId(CHAT_ID)
  useAuthStore.setState({
    currentUser: {
      id: 'u1',
      type: 'local_user',
      username: 'u',
      displayName: 'U',
      hasPassword: false
    }
  })
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function snapshot(): Snapshot {
  const state = useChatStore.getState()
  return Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, state[key]])) as Snapshot
}

/** Key-order-independent serialization; every snapshot value is plain data. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  ) ?? 'undefined'
}

function changes(before: Snapshot, after: Snapshot): Changes {
  const out: Changes = {}
  for (const key of SNAPSHOT_KEYS) {
    if (stable(before[key]) !== stable(after[key])) out[key] = after[key]
  }
  return out
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Mount the projection handler and seed an optimistic send. */
function mount(_path: 'llm' | 'agent'): (event: RunEvent) => void {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useRunEventHandler(), { wrapper })
  act(() => useChatStore.getState().setPendingUserMessage(PENDING))
  return (event) => result.current(CHAT_ID, event)
}

async function runRow(path: 'llm' | 'agent', row: Row<RunEvent>): Promise<void> {
  const emit = mount(path)

  act(() => {
    for (const event of row.seed) emit(event)
  })
  if (row.seedState) {
    const seedState = row.seedState
    act(() => useChatStore.setState(seedState))
  }
  await flush()
  statusGet.mockClear()
  consoleError.mockClear()

  // The event projector has no persistence side effects; the watch owns them.
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const before = snapshot()
  act(() => emit(row.event))
  const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
  const sync = changes(before, snapshot())

  await flush()
  await flush()
  const settled = changes(before, snapshot())

  expect(sync).toEqual(row.sync ?? row.settled)
  expect(settled).toEqual(row.settled)
  expect(invalidated).toEqual(row.invalidates)
  expect(statusGet).not.toHaveBeenCalled() // Lifecycle effects belong to the watcher.
  // Any handler log line (`… error:`), so one under a stale prefix would still
  // show up as a mismatch rather than be filtered out.
  const handlerLogs = consoleError.mock.calls.filter(
    ([first]) => typeof first === 'string' && / error:$/.test(first)
  )
  expect(handlerLogs).toEqual(row.logged ? [row.logged] : [])
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST_ID = { type: 'request-id', requestId: 'req-1' } as const
const PENDING = { content: 'hello', baselineUserCount: 0 }
const STALE_BLOCK = { type: 'text', kind: 'text', content: 'from the last turn' } as const

const DONE_SETTLED: Changes = { isStreaming: false }
const DONE_INVALIDATES: unknown[][] = []
const ERROR_CHANGES: Changes = { isStreaming: false }

const FILE = { fileId: 'f-1', filename: 'report.pdf', mimeType: 'application/pdf', size: 1024 }
const FILE_2 = { fileId: 'f-2', filename: 'chart.png', mimeType: 'image/png', size: 2048 }
const PERMISSION_INPUT = { action: 'bash', resources: ['rm -rf build'], savable: ['*'] }
const QUESTION_INPUT = { questions: [{ question: 'Which branch?', options: ['main', 'dev'] }] }

function textBlock(kind: ContentKind, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'text', kind, content, ...extra }
}

const MCP_CALL: RunEvent = {
  type: 'tool_use',
  id: 'call-1',
  name: 'search_docs',
  input: { q: 'streams' },
  provider: 'Docs',
  providerType: 'mcp'
}
const MCP_BLOCK = {
  type: 'tool_call',
  id: 'call-1',
  name: 'search_docs',
  input: { q: 'streams' },
  provider: 'Docs',
  providerType: 'mcp',
  status: 'pending'
}

// Asks as `needs_input` announces them. A local agent's is `reply` and keyed by
// its engine request id; an A2A agent's is `next_message` and keyed by its task.
const PERMISSION_REQUEST: InputRequest = { kind: 'permission', action: 'bash', resources: ['rm -rf build'] }
const EDIT_REQUEST: InputRequest = { kind: 'permission', action: 'edit', resources: ['notes.txt'] }
const QUESTION_REQUEST: InputRequest = {
  kind: 'question',
  questions: [{ question: 'Which branch?', multiSelect: false, options: [{ label: 'main' }, { label: 'dev' }] }]
}
const ASK_REPLY: RunNeedsInputEvent = { type: 'needs_input', requestId: 'per_1', request: PERMISSION_REQUEST, resume: 'reply' }
const ASK_REPLY_2: RunNeedsInputEvent = { type: 'needs_input', requestId: 'per_2', request: EDIT_REQUEST, resume: 'reply' }
const ASK_NEXT: RunNeedsInputEvent = { type: 'needs_input', requestId: 'task-1', request: QUESTION_REQUEST, resume: 'next_message' }

/** The store entry a `needs_input` becomes. */
function entry(ask: RunNeedsInputEvent, toolCallId?: string): Record<string, unknown> {
  return {
    requestId: ask.requestId,
    request: ask.request,
    resume: ask.resume,
    ...(toolCallId ? { toolCallId } : {})
  }
}

function resolved(requestId: string): RunInputResolvedEvent {
  return { type: 'input_resolved', requestId, resolution: { kind: 'permission', reply: 'once' } }
}

// ---------------------------------------------------------------------------
// The agent path — `window.api.agents.sendMessage`
// ---------------------------------------------------------------------------

const AGENT_TEXT: RunEvent = { type: 'delta', kind: 'text', text: 'Working on it' }

// Edited on purpose: A2A's `input-required` and `auth-required` both arrive as
// `needs_input` now, so the two rows that pinned them became one.
const ALL_RUN_STATES: Record<RunState, true> = {
  submitted: true,
  working: true,
  needs_input: true,
  completed: true,
  canceled: true,
  failed: true,
  rejected: true,
  unknown: true
}

const AGENT_ROWS: Row<RunEvent>[] = [
  {
    name: 'request-id starts the stream: blocks, sendError and incremental flag reset, pending bubble kept',
    seed: [],
    seedState: {
      streamingBlocks: [STALE_BLOCK],
      sendError: 'No provider configured',
      streamedIncrementallyChatId: CHAT_ID
    },
    event: REQUEST_ID,
    settled: {
      isStreaming: true,
      activeRequestId: 'req-1',
      streamingBlocks: [],
      streamedIncrementallyChatId: null,
      sendError: null
    },
    invalidates: []
  },
  {
    name: 'delta before any request-id still appends, but does not start streaming',
    seed: [],
    event: AGENT_TEXT,
    settled: {
      streamingBlocks: [textBlock('text', 'Working on it')],
      streamedIncrementallyChatId: CHAT_ID
    },
    invalidates: []
  },
  // PINNED: every run state is ignored — including the terminal `failed` /
  // `canceled` / `rejected`. A stream that reports `failed` and never sends
  // `error` or `done` leaves `isStreaming` true.
  ...(Object.keys(ALL_RUN_STATES) as RunState[]).map(
    (state): Row<RunEvent> => ({
      name: `status ${state} is ignored`,
      seed: [REQUEST_ID, AGENT_TEXT],
      event: { type: 'status', state, taskId: 't-1', contextId: 'ctx-1' },
      settled: {},
      invalidates: []
    })
  ),
  {
    name: 'delta text appends a text block',
    seed: [REQUEST_ID],
    event: AGENT_TEXT,
    settled: {
      streamingBlocks: [textBlock('text', 'Working on it')],
      streamedIncrementallyChatId: CHAT_ID
    },
    invalidates: []
  },
  {
    name: 'delta text merges into a preceding text block',
    seed: [REQUEST_ID, { type: 'delta', kind: 'text', text: 'Hel' }],
    event: { type: 'delta', kind: 'text', text: 'lo' },
    settled: { streamingBlocks: [textBlock('text', 'Hello')] },
    invalidates: []
  },
  {
    name: 'delta thinking appends a thinking block, separate from text',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: { type: 'delta', kind: 'thinking', text: 'Considering' },
    settled: {
      streamingBlocks: [textBlock('text', 'Working on it'), textBlock('thinking', 'Considering')]
    },
    invalidates: []
  },
  {
    name: 'delta tool carries toolId, toolName and toolInput onto the block',
    seed: [REQUEST_ID],
    event: {
      type: 'delta',
      kind: 'tool',
      text: 'ls -la',
      toolId: 'toolu_1',
      toolName: 'Bash',
      toolInput: { command: 'ls -la' }
    },
    settled: {
      streamingBlocks: [
        textBlock('tool', 'ls -la', { toolId: 'toolu_1', toolName: 'Bash', toolInput: { command: 'ls -la' } })
      ],
      streamedIncrementallyChatId: CHAT_ID
    },
    invalidates: []
  },
  {
    name: 'delta tool_result carries toolId and toolStream',
    seed: [REQUEST_ID],
    event: { type: 'delta', kind: 'tool_result', text: 'total 0', toolId: 'toolu_1', toolStream: 'stdout' },
    settled: {
      streamingBlocks: [textBlock('tool_result', 'total 0', { toolId: 'toolu_1', toolStream: 'stdout' })],
      streamedIncrementallyChatId: CHAT_ID
    },
    invalidates: []
  },
  {
    name: 'delta tool_result on another stream of the same tool does not merge',
    seed: [REQUEST_ID, { type: 'delta', kind: 'tool_result', text: 'out', toolId: 'toolu_1', toolStream: 'stdout' }],
    event: { type: 'delta', kind: 'tool_result', text: 'err', toolId: 'toolu_1', toolStream: 'stderr' },
    settled: {
      streamingBlocks: [
        textBlock('tool_result', 'out', { toolId: 'toolu_1', toolStream: 'stdout' }),
        textBlock('tool_result', 'err', { toolId: 'toolu_1', toolStream: 'stderr' })
      ]
    },
    invalidates: []
  },
  {
    // Contrast with the `child` notice row, which is skipped.
    name: 'delta notice is appended as a block at top level',
    seed: [REQUEST_ID],
    event: { type: 'delta', kind: 'notice', text: 'Agent restarted' },
    settled: {
      streamingBlocks: [textBlock('notice', 'Agent restarted')],
      streamedIncrementallyChatId: CHAT_ID
    },
    invalidates: []
  },
  {
    name: 'delta command_result carries commandInvocation',
    seed: [REQUEST_ID],
    event: { type: 'delta', kind: 'command_result', text: '3 files', commandInvocation: '/files' },
    settled: {
      streamingBlocks: [textBlock('command_result', '3 files', { commandInvocation: '/files' })],
      streamedIncrementallyChatId: CHAT_ID
    },
    invalidates: []
  },
  {
    name: 'delta file carries the file and an empty body',
    seed: [REQUEST_ID],
    event: { type: 'delta', kind: 'file', text: '', file: FILE },
    settled: {
      streamingBlocks: [textBlock('file', '', { file: FILE })],
      streamedIncrementallyChatId: CHAT_ID
    },
    invalidates: []
  },
  {
    name: 'delta file never merges with an adjacent file',
    seed: [REQUEST_ID, { type: 'delta', kind: 'file', text: '', file: FILE }],
    event: { type: 'delta', kind: 'file', text: '', file: FILE_2 },
    settled: {
      streamingBlocks: [textBlock('file', '', { file: FILE }), textBlock('file', '', { file: FILE_2 })]
    },
    invalidates: []
  },

  // Local-agent asks as transcript parts. The `tool` delta is still an ordinary
  // block with no streaming change, no invalidation and no status pull; what
  // makes it answerable arrives separately as `needs_input` (rows below), and a
  // persisted transcript still recognises an ask by its `per_` / `que_` id.
  {
    name: 'local-agent permission ask (per_ id) is a plain tool block',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: {
      type: 'delta',
      kind: 'tool',
      text: '',
      toolName: PERMISSION_TOOL_NAME,
      toolId: 'per_abc',
      toolInput: PERMISSION_INPUT
    },
    settled: {
      streamingBlocks: [
        textBlock('text', 'Working on it'),
        textBlock('tool', '', { toolName: PERMISSION_TOOL_NAME, toolId: 'per_abc', toolInput: PERMISSION_INPUT })
      ]
    },
    invalidates: []
  },
  {
    name: 'local-agent question (que_ id) is a plain tool block',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: {
      type: 'delta',
      kind: 'tool',
      text: '',
      toolName: QUESTION_TOOL_NAME,
      toolId: 'que_abc',
      toolInput: QUESTION_INPUT
    },
    settled: {
      streamingBlocks: [
        textBlock('text', 'Working on it'),
        textBlock('tool', '', { toolName: QUESTION_TOOL_NAME, toolId: 'que_abc', toolInput: QUESTION_INPUT })
      ]
    },
    invalidates: []
  },
  {
    name: 'a cloud question (non-engine id) produces the same block shape',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: {
      type: 'delta',
      kind: 'tool',
      text: '',
      toolName: QUESTION_TOOL_NAME,
      toolId: 'toolu_q',
      toolInput: QUESTION_INPUT
    },
    settled: {
      streamingBlocks: [
        textBlock('text', 'Working on it'),
        textBlock('tool', '', { toolName: QUESTION_TOOL_NAME, toolId: 'toolu_q', toolInput: QUESTION_INPUT })
      ]
    },
    invalidates: []
  },
  {
    name: 'a permission ask followed by a question stays two blocks',
    seed: [
      REQUEST_ID,
      { type: 'delta', kind: 'tool', text: '', toolName: PERMISSION_TOOL_NAME, toolId: 'per_1', toolInput: PERMISSION_INPUT }
    ],
    event: { type: 'delta', kind: 'tool', text: '', toolName: QUESTION_TOOL_NAME, toolId: 'que_1', toolInput: QUESTION_INPUT },
    settled: {
      streamingBlocks: [
        textBlock('tool', '', { toolName: PERMISSION_TOOL_NAME, toolId: 'per_1', toolInput: PERMISSION_INPUT }),
        textBlock('tool', '', { toolName: QUESTION_TOOL_NAME, toolId: 'que_1', toolInput: QUESTION_INPUT })
      ]
    },
    invalidates: []
  },
  {
    // Fixed in phase 1, was PINNED: `tool` blocks merged on `toolName` alone, so
    // the second ask folded into the first block and its `per_` id — the
    // address its answer is posted to — never reached the store, leaving that
    // ask parked until its timeout. A `tool` block now also splits on a
    // different `toolId` (`shared/partMerge.ts`).
    name: 'a second back-to-back permission ask with its own id is its own block',
    seed: [
      REQUEST_ID,
      { type: 'delta', kind: 'tool', text: '', toolName: PERMISSION_TOOL_NAME, toolId: 'per_1', toolInput: PERMISSION_INPUT }
    ],
    event: {
      type: 'delta',
      kind: 'tool',
      text: '',
      toolName: PERMISSION_TOOL_NAME,
      toolId: 'per_2',
      toolInput: { action: 'edit', resources: ['notes.txt'], savable: [] }
    },
    settled: {
      streamingBlocks: [
        textBlock('tool', '', { toolName: PERMISSION_TOOL_NAME, toolId: 'per_1', toolInput: PERMISSION_INPUT }),
        textBlock('tool', '', {
          toolName: PERMISSION_TOOL_NAME,
          toolId: 'per_2',
          toolInput: { action: 'edit', resources: ['notes.txt'], savable: [] }
        })
      ]
    },
    invalidates: []
  },

  // `needs_input` / `input_resolved`: the asks the stream says are open. They
  // touch `inputRequests` and nothing else — no block, no streaming change.
  {
    name: 'needs_input reply adds an entry and changes nothing else',
    seed: [
      REQUEST_ID,
      { type: 'delta', kind: 'tool', text: '', toolName: PERMISSION_TOOL_NAME, toolId: 'per_1', toolInput: PERMISSION_INPUT }
    ],
    seedState: { streamedIncrementallyChatId: null },
    event: ASK_REPLY,
    settled: { inputRequests: [entry(ASK_REPLY)] },
    invalidates: []
  },
  {
    // The A2A shape: the turn ends waiting, so the status comes first.
    name: 'needs_input next_message adds an entry',
    seed: [REQUEST_ID, AGENT_TEXT, { type: 'status', state: 'needs_input', taskId: 'task-1' }],
    event: ASK_NEXT,
    settled: { inputRequests: [entry(ASK_NEXT)] },
    invalidates: []
  },
  {
    name: 'a second needs_input with a different id keeps both, in arrival order',
    seed: [REQUEST_ID, ASK_REPLY],
    event: ASK_REPLY_2,
    settled: { inputRequests: [entry(ASK_REPLY), entry(ASK_REPLY_2)] },
    invalidates: []
  },
  {
    name: 'needs_input repeating a known id replaces that entry where it stands',
    seed: [REQUEST_ID, ASK_REPLY, ASK_REPLY_2],
    event: { ...ASK_REPLY, request: EDIT_REQUEST },
    settled: { inputRequests: [entry({ ...ASK_REPLY, request: EDIT_REQUEST }), entry(ASK_REPLY_2)] },
    invalidates: []
  },
  {
    name: 'input_resolved removes only its own id, and records it as settled',
    seed: [REQUEST_ID, ASK_REPLY, ASK_REPLY_2],
    event: resolved('per_1'),
    settled: { inputRequests: [entry(ASK_REPLY_2)], settledInputRequestIds: ['per_1'] },
    invalidates: []
  },
  {
    // An ask known only through the registry poll (no `needs_input` reached
    // this store) is just as settled, so the id is recorded anyway.
    name: 'input_resolved for an id the store never held only records it as settled',
    seed: [REQUEST_ID, ASK_REPLY],
    event: resolved('per_nope'),
    settled: { settledInputRequestIds: ['per_nope'] },
    invalidates: []
  },
  {
    name: 'needs_input for a settled id opens it again',
    seed: [REQUEST_ID, ASK_REPLY, resolved('per_1')],
    event: ASK_REPLY,
    settled: { inputRequests: [entry(ASK_REPLY)], settledInputRequestIds: [] },
    invalidates: []
  },
  {
    name: 'request-id forgets settled ids',
    seed: [REQUEST_ID, ASK_REPLY, resolved('per_1')],
    event: { type: 'request-id', requestId: 'req-2' },
    settled: { activeRequestId: 'req-2', settledInputRequestIds: [] },
    invalidates: []
  },
  {
    name: 'request-id clears every input request, reply and next_message alike',
    seed: [REQUEST_ID, ASK_REPLY, ASK_NEXT],
    event: { type: 'request-id', requestId: 'req-2' },
    settled: { activeRequestId: 'req-2', inputRequests: [] },
    invalidates: []
  },

  // Behaviour change: `handleAgent` had no case for the tool-call events and
  // ignored them. One handler means the agent path now does what the LLM path
  // does; main never sends them on this channel.
  {
    name: 'tool_use on the agent path appends a pending tool_call block',
    seed: [REQUEST_ID],
    event: MCP_CALL,
    settled: { streamingBlocks: [MCP_BLOCK], streamedIncrementallyChatId: CHAT_ID },
    invalidates: []
  },
  {
    name: 'tool_result on the agent path resolves the matching call',
    seed: [REQUEST_ID, MCP_CALL],
    seedState: { streamedIncrementallyChatId: null },
    event: { type: 'tool_result', id: 'call-1', result: { hits: 3 } },
    settled: { streamingBlocks: [{ ...MCP_BLOCK, status: 'done', result: { hits: 3 } }] },
    invalidates: []
  },
  {
    name: 'tool_error on the agent path fails the matching call',
    seed: [REQUEST_ID, MCP_CALL],
    seedState: { streamedIncrementallyChatId: null },
    event: { type: 'tool_error', id: 'call-1', error: 'timeout' },
    settled: { streamingBlocks: [{ ...MCP_BLOCK, status: 'error', error: 'timeout' }] },
    invalidates: []
  },

  {
    name: 'done hides the cursor; watch settlement owns projection cleanup',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: { type: 'done' },
    sync: { isStreaming: false },
    settled: DONE_SETTLED,
    invalidates: DONE_INVALIDATES,
    pullsStatus: true
  },
  {
    // A parked address dies with its turn; an A2A question stays answerable by
    // the next message.
    name: 'done drops a reply ask at once and keeps a next_message ask',
    seed: [REQUEST_ID, AGENT_TEXT, ASK_REPLY, ASK_NEXT],
    event: { type: 'done', stopReason: 'end_turn' },
    sync: { isStreaming: false, inputRequests: [entry(ASK_NEXT)] },
    settled: { ...DONE_SETTLED, inputRequests: [entry(ASK_NEXT)] },
    invalidates: DONE_INVALIDATES,
    pullsStatus: true
  },
  {
    // PINNED: unlike `done`, blocks and the optimistic bubble are dropped
    // before the `['chat', id]` refetch lands, and `['chats']` / `['jobs']` are
    // not invalidated. `sendError` is left alone by design (the error arrives
    // as a persisted SystemMessage row).
    // Edited on purpose: one handler, one log prefix (was `Agent error:`).
    name: 'error without code hides the cursor and leaves projection cleanup to the watcher',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: { type: 'error', error: 'boom' },
    settled: ERROR_CHANGES,
    invalidates: [],
    pullsStatus: true,
    logged: ['Stream error:', 'boom']
  },
  {
    // Edited on purpose: one handler, one log prefix (was `Agent error:`).
    name: 'error with code behaves identically — the code is not read here',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: { type: 'error', error: 'Sign in again', code: 'cinna_reauth_required' },
    settled: ERROR_CHANGES,
    invalidates: [],
    pullsStatus: true,
    logged: ['Stream error:', 'Sign in again']
  },
  {
    name: 'error drops a reply ask and keeps a next_message ask',
    seed: [REQUEST_ID, AGENT_TEXT, ASK_REPLY, ASK_NEXT],
    event: { type: 'error', error: 'boom' },
    settled: { ...ERROR_CHANGES, inputRequests: [entry(ASK_NEXT)] },
    invalidates: [],
    pullsStatus: true,
    logged: ['Stream error:', 'boom']
  }
]

// ---------------------------------------------------------------------------
// The LLM path — `window.api.llm.sendMessage`
// ---------------------------------------------------------------------------

const AGENT_CALL: RunEvent = {
  type: 'tool_use',
  id: 'call-2',
  name: 'ask_alpha',
  input: { message: 'hi' },
  provider: 'Alpha',
  providerType: 'agent',
  providerAgentId: AGENT_ID
}
function agentCallBlock(subParts?: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: 'tool_call',
    id: 'call-2',
    name: 'ask_alpha',
    input: { message: 'hi' },
    provider: 'Alpha',
    providerType: 'agent',
    agentId: AGENT_ID,
    status: 'pending',
    ...(subParts ? { subParts } : {})
  }
}

// Edited on purpose: an LLM delta now carries `kind: 'text'`; the store result
// is the one the bare `{ text }` delta produced.
const LLM_TEXT: RunEvent = { type: 'delta', kind: 'text', text: 'Hello' }

function child(event: RunEvent, toolCallId = 'call-2'): RunEvent {
  return { type: 'child', toolCallId, agentId: AGENT_ID, event }
}

/** A child-event row: seeded with an agent tool call, incremental flag cleared so it is visible. */
function childRow(
  name: string,
  event: RunEvent,
  subParts: Record<string, unknown>[] | null
): Row<RunEvent> {
  return {
    name,
    seed: [REQUEST_ID, AGENT_CALL],
    seedState: { streamedIncrementallyChatId: null },
    event: child(event),
    settled: subParts
      ? { streamingBlocks: [agentCallBlock(subParts)], streamedIncrementallyChatId: CHAT_ID }
      : {},
    invalidates: []
  }
}

const LLM_ROWS: Row<RunEvent>[] = [
  {
    name: 'request-id starts the stream: blocks, sendError and incremental flag reset, pending bubble kept',
    seed: [],
    seedState: {
      streamingBlocks: [STALE_BLOCK],
      sendError: 'No provider configured',
      streamedIncrementallyChatId: CHAT_ID
    },
    event: REQUEST_ID,
    settled: {
      isStreaming: true,
      activeRequestId: 'req-1',
      streamingBlocks: [],
      streamedIncrementallyChatId: null,
      sendError: null
    },
    invalidates: []
  },
  {
    name: 'delta before any request-id still appends, but does not start streaming',
    seed: [],
    event: LLM_TEXT,
    settled: { streamingBlocks: [textBlock('text', 'Hello')], streamedIncrementallyChatId: CHAT_ID },
    invalidates: []
  },
  {
    name: 'delta appends a text-kind block',
    seed: [REQUEST_ID],
    event: LLM_TEXT,
    settled: { streamingBlocks: [textBlock('text', 'Hello')], streamedIncrementallyChatId: CHAT_ID },
    invalidates: []
  },
  {
    // Edited on purpose: both deltas carry `kind: 'text'` (see `LLM_TEXT`).
    name: 'delta merges into a preceding text block',
    seed: [REQUEST_ID, { type: 'delta', kind: 'text', text: 'Hel' }],
    event: { type: 'delta', kind: 'text', text: 'lo' },
    settled: { streamingBlocks: [textBlock('text', 'Hello')] },
    invalidates: []
  },
  {
    name: 'delta after a tool call opens a new text block',
    seed: [REQUEST_ID, MCP_CALL],
    event: LLM_TEXT,
    settled: { streamingBlocks: [MCP_BLOCK, textBlock('text', 'Hello')] },
    invalidates: []
  },
  {
    name: 'tool_use (mcp) appends a pending tool_call block',
    seed: [REQUEST_ID],
    event: MCP_CALL,
    settled: { streamingBlocks: [MCP_BLOCK], streamedIncrementallyChatId: CHAT_ID },
    invalidates: []
  },
  {
    name: 'tool_use (agent) maps providerAgentId to the block’s agentId',
    seed: [REQUEST_ID],
    event: AGENT_CALL,
    settled: { streamingBlocks: [agentCallBlock()], streamedIncrementallyChatId: CHAT_ID },
    invalidates: []
  },
  {
    name: 'tool_result resolves the matching call (incremental flag untouched)',
    seed: [REQUEST_ID, MCP_CALL],
    seedState: { streamedIncrementallyChatId: null },
    event: { type: 'tool_result', id: 'call-1', result: { hits: 3 } },
    settled: { streamingBlocks: [{ ...MCP_BLOCK, status: 'done', result: { hits: 3 } }] },
    invalidates: []
  },
  {
    name: 'tool_result for an unknown id changes nothing',
    seed: [REQUEST_ID, MCP_CALL],
    event: { type: 'tool_result', id: 'nope', result: 'x' },
    settled: {},
    invalidates: []
  },
  {
    name: 'tool_error fails the matching call (incremental flag untouched)',
    seed: [REQUEST_ID, MCP_CALL],
    seedState: { streamedIncrementallyChatId: null },
    event: { type: 'tool_error', id: 'call-1', error: 'timeout' },
    settled: { streamingBlocks: [{ ...MCP_BLOCK, status: 'error', error: 'timeout' }] },
    invalidates: []
  },
  {
    name: 'tool_error for an unknown id changes nothing',
    seed: [REQUEST_ID, MCP_CALL],
    event: { type: 'tool_error', id: 'nope', error: 'x' },
    settled: {},
    invalidates: []
  },

  // child: only nested deltas reach the sub-thread; every other nested event —
  // including a nested `done` or `error` — leaves the outer turn alone.
  //
  // Edited on purpose, every row down to the `child` ask rows: these were the
  // `tool_subevent` rows. Only the wrapper changed (`child`, which also names
  // the nested agent); each expectation is as it was. The nested statuses lost
  // `input-required` / `auth-required`, which are both `needs_input` now.
  childRow('child request-id is ignored', REQUEST_ID, null),
  ...(['working', 'needs_input', 'completed', 'failed', 'canceled'] as const).map(
    (state) => childRow(`child status ${state} is ignored`, { type: 'status', state, taskId: 't-1' }, null)
  ),
  childRow('child delta text appends a sub-part', { type: 'delta', kind: 'text', text: 'Hi' }, [
    { kind: 'text', text: 'Hi' }
  ]),
  childRow('child delta thinking appends a sub-part', { type: 'delta', kind: 'thinking', text: 'Hmm' }, [
    { kind: 'thinking', text: 'Hmm' }
  ]),
  childRow(
    'child delta tool carries toolId, toolName and toolInput',
    { type: 'delta', kind: 'tool', text: 'ls', toolId: 'toolu_1', toolName: 'Bash', toolInput: { command: 'ls' } },
    [{ kind: 'tool', text: 'ls', toolId: 'toolu_1', toolName: 'Bash', toolInput: { command: 'ls' } }]
  ),
  childRow(
    'child delta tool_result carries toolId and toolStream',
    { type: 'delta', kind: 'tool_result', text: 'ok', toolId: 'toolu_1', toolStream: 'stderr' },
    [{ kind: 'tool_result', text: 'ok', toolId: 'toolu_1', toolStream: 'stderr' }]
  ),
  // Contrast with the top-level agent notice row, which is appended.
  childRow('child delta notice is skipped', { type: 'delta', kind: 'notice', text: 'restarted' }, null),
  childRow(
    'child delta command_result carries commandInvocation',
    { type: 'delta', kind: 'command_result', text: '3 files', commandInvocation: '/files' },
    [{ kind: 'command_result', text: '3 files', commandInvocation: '/files' }]
  ),
  childRow('child delta file carries the file', { type: 'delta', kind: 'file', text: '', file: FILE }, [
    { kind: 'file', text: '', file: FILE }
  ]),
  childRow(
    'child local-agent permission ask (per_ id) is a plain sub-part',
    { type: 'delta', kind: 'tool', text: '', toolName: PERMISSION_TOOL_NAME, toolId: 'per_abc', toolInput: PERMISSION_INPUT },
    [{ kind: 'tool', text: '', toolName: PERMISSION_TOOL_NAME, toolId: 'per_abc', toolInput: PERMISSION_INPUT }]
  ),
  childRow(
    'child local-agent question (que_ id) is a plain sub-part',
    { type: 'delta', kind: 'tool', text: '', toolName: QUESTION_TOOL_NAME, toolId: 'que_abc', toolInput: QUESTION_INPUT },
    [{ kind: 'tool', text: '', toolName: QUESTION_TOOL_NAME, toolId: 'que_abc', toolInput: QUESTION_INPUT }]
  ),
  childRow('child done does not finish the outer turn', { type: 'done' }, null),
  childRow(
    'child error does not stop the outer turn',
    { type: 'error', error: 'agent failed', code: 'cinna_reauth_required' },
    null
  ),
  {
    name: 'child delta merges into the previous sub-part',
    seed: [REQUEST_ID, AGENT_CALL, child({ type: 'delta', kind: 'text', text: 'Hel' })],
    event: child({ type: 'delta', kind: 'text', text: 'lo' }),
    settled: { streamingBlocks: [agentCallBlock([{ kind: 'text', text: 'Hello' }])] },
    invalidates: []
  },
  {
    name: 'child on an mcp tool call still grows a sub-thread (matched by id only)',
    seed: [REQUEST_ID, MCP_CALL],
    event: child({ type: 'delta', kind: 'text', text: 'Hi' }, 'call-1'),
    settled: { streamingBlocks: [{ ...MCP_BLOCK, subParts: [{ kind: 'text', text: 'Hi' }] }] },
    invalidates: []
  },
  {
    // PINNED: no block matches, yet the incremental flag is still set.
    name: 'PINNED: child delta for an unknown toolCallId sets the incremental flag and nothing else',
    seed: [REQUEST_ID, AGENT_CALL],
    seedState: { streamedIncrementallyChatId: null },
    event: child({ type: 'delta', kind: 'text', text: 'Hi' }, 'nope'),
    settled: { streamedIncrementallyChatId: CHAT_ID },
    invalidates: []
  },

  // New with `child`: a nested agent's tool-call events carry no parts, and its
  // asks are the chat's asks.
  childRow('child tool_use is ignored', MCP_CALL, null),
  childRow('child tool_result is ignored', { type: 'tool_result', id: 'call-1', result: 'x' }, null),
  childRow('child tool_error is ignored', { type: 'tool_error', id: 'call-1', error: 'x' }, null),
  {
    name: 'child needs_input adds an entry naming the tool call that raised it',
    seed: [REQUEST_ID, AGENT_CALL],
    seedState: { streamedIncrementallyChatId: null },
    event: child(ASK_REPLY),
    settled: { inputRequests: [entry(ASK_REPLY, 'call-2')] },
    invalidates: []
  },
  {
    name: 'child input_resolved removes it and records it as settled',
    seed: [REQUEST_ID, AGENT_CALL, child(ASK_REPLY)],
    event: child(resolved('per_1')),
    settled: { inputRequests: [], settledInputRequestIds: ['per_1'] },
    invalidates: []
  },
  {
    // The nested agent's turn ended with its call, so an ask it parked is gone
    // even if no `input_resolved` said so (teardown posts none).
    name: 'tool_result drops the asks its nested agent raised',
    seed: [REQUEST_ID, AGENT_CALL, child(ASK_REPLY)],
    event: { type: 'tool_result', id: 'call-2', result: 'done' },
    settled: {
      streamingBlocks: [{ ...agentCallBlock(), status: 'done', result: 'done' }],
      inputRequests: []
    },
    invalidates: []
  },
  {
    name: 'tool_error drops the asks its nested agent raised',
    seed: [REQUEST_ID, AGENT_CALL, child(ASK_REPLY)],
    event: { type: 'tool_error', id: 'call-2', error: 'agent failed' },
    settled: {
      streamingBlocks: [{ ...agentCallBlock(), status: 'error', error: 'agent failed' }],
      inputRequests: []
    },
    invalidates: []
  },
  // One level of hierarchy: even a delta that would append is dropped.
  childRow('child inside a child is ignored', child({ type: 'delta', kind: 'text', text: 'Hi' }), null),

  {
    name: 'done hides the cursor; watch settlement owns projection cleanup',
    seed: [REQUEST_ID, LLM_TEXT],
    event: { type: 'done' },
    sync: { isStreaming: false },
    settled: DONE_SETTLED,
    invalidates: DONE_INVALIDATES
  },
  {
    // Edited on purpose: one handler, one log prefix (was `LLM error:`).
    name: 'error without errorDetail hides the cursor and leaves projection cleanup to the watcher',
    seed: [REQUEST_ID, LLM_TEXT],
    event: { type: 'error', error: 'rate limited' },
    settled: ERROR_CHANGES,
    invalidates: [],
    logged: ['Stream error:', 'rate limited']
  },
  {
    // Edited on purpose: one handler, one log prefix (was `LLM error:`).
    name: 'error with errorDetail behaves identically — the detail is not read here',
    seed: [REQUEST_ID, LLM_TEXT],
    event: { type: 'error', error: 'rate limited', errorDetail: '429 Too Many Requests' },
    settled: ERROR_CHANGES,
    invalidates: [],
    logged: ['Stream error:', 'rate limited']
  }
]

// Both tables stay: they drive `handleRun` for a turn an agent answers and one
// the model answers, which is what the two used to be.
describe('useChatStream — handleRun for an agent turn, one row per event', () => {
  it.each(AGENT_ROWS)('$name', async (row) => {
    await runRow('agent', row)
  })
})

describe('useChatStream — handleRun for a model turn, one row per event', () => {
  it.each(LLM_ROWS)('$name', async (row) => {
    await runRow('llm', row)
  })
})

// ---------------------------------------------------------------------------
// What `renderRequestBlock` reads
// ---------------------------------------------------------------------------

describe('isLiveInputRequest — which answer path a needs_input opens', () => {
  it('a reply ask makes its block answerable; a next_message ask leaves the composer as the answer path', () => {
    const emit = mount('agent')
    act(() => {
      for (const event of [REQUEST_ID, ASK_REPLY, ASK_NEXT]) emit(event)
    })
    const state = useChatStore.getState()
    expect(isLiveInputRequest(state, 'per_1')).toBe(true)
    expect(isLiveInputRequest(state, 'task-1')).toBe(false)
    // A block with no id and a block nobody asked about are never live.
    expect(isLiveInputRequest(state, undefined)).toBe(false)
    expect(isLiveInputRequest(state, 'per_nope')).toBe(false)
  })

  it('a nested agent’s reply ask is recorded as a reply ask — though no sub-thread renders a control for it yet', () => {
    const emit = mount('llm')
    act(() => {
      for (const event of [REQUEST_ID, AGENT_CALL, child(ASK_REPLY)]) emit(event)
    })
    expect(isLiveInputRequest(useChatStore.getState(), 'per_1')).toBe(true)
  })

  it('stops being answerable once answered', () => {
    const emit = mount('agent')
    act(() => {
      for (const event of [REQUEST_ID, ASK_REPLY, resolved('per_1')]) emit(event)
    })
    expect(isLiveInputRequest(useChatStore.getState(), 'per_1')).toBe(false)
  })

  it('a settled id outranks the registry poll until the next stream starts', () => {
    // `renderRequestBlock` checks `isSettledInputRequest` before the poll's
    // `isPending`, which can still list a timed-out ask for up to a tick.
    const emit = mount('agent')
    act(() => {
      for (const event of [REQUEST_ID, ASK_REPLY, resolved('per_1')]) emit(event)
    })
    expect(isSettledInputRequest(useChatStore.getState(), 'per_1')).toBe(true)
    expect(isSettledInputRequest(useChatStore.getState(), 'per_2')).toBe(false)
    expect(isSettledInputRequest(useChatStore.getState(), undefined)).toBe(false)

    // The poll's last read can land after the stream ends, so ending it keeps the id.
    act(() => useChatStore.getState().finishStreaming())
    expect(isSettledInputRequest(useChatStore.getState(), 'per_1')).toBe(true)

    act(() => useChatStore.getState().startStreaming('req-2'))
    expect(isSettledInputRequest(useChatStore.getState(), 'per_1')).toBe(false)
  })

  it('a reply ask dies with its turn; a next_message ask survives finishStreaming but not the next stream', () => {
    const emit = mount('agent')
    act(() => {
      for (const event of [REQUEST_ID, ASK_REPLY, ASK_NEXT]) emit(event)
    })

    act(() => useChatStore.getState().finishStreaming())
    expect(isLiveInputRequest(useChatStore.getState(), 'per_1')).toBe(false)
    expect(useChatStore.getState().inputRequests).toEqual([entry(ASK_NEXT)])

    act(() => useChatStore.getState().startStreaming('req-2'))
    expect(useChatStore.getState().inputRequests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Coverage guards — a new variant fails the typecheck here until it has a row.
// ---------------------------------------------------------------------------

const RUN_EVENT_TYPES: Record<RunEvent['type'], true> = {
  'request-id': true,
  status: true,
  delta: true,
  tool_use: true,
  tool_result: true,
  tool_error: true,
  needs_input: true,
  input_resolved: true,
  child: true,
  done: true,
  error: true
}
const CONTENT_KINDS: Record<ContentKind, true> = {
  text: true,
  thinking: true,
  tool: true,
  tool_result: true,
  notice: true,
  command_result: true,
  file: true
}

describe('useChatStream event tables — coverage', () => {
  it('has a row for every RunEvent variant in at least one table', () => {
    const events = [...AGENT_ROWS, ...LLM_ROWS].map((row) => row.event)
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(Object.keys(RUN_EVENT_TYPES)))
  })

  it('has an agent row for every content kind and run state', () => {
    const events = AGENT_ROWS.map((row) => row.event)
    expect(
      new Set(events.flatMap((e) => (e.type === 'delta' ? [e.kind] : [])))
    ).toEqual(new Set(Object.keys(CONTENT_KINDS)))
    expect(
      new Set(events.flatMap((e) => (e.type === 'status' ? [e.state] : [])))
    ).toEqual(new Set(Object.keys(ALL_RUN_STATES)))
  })

  it('has a child row for every nested variant and content kind', () => {
    const nested = LLM_ROWS.flatMap((row) => (row.event.type === 'child' ? [row.event.event] : []))
    expect(new Set(nested.map((e) => e.type))).toEqual(new Set(Object.keys(RUN_EVENT_TYPES)))
    expect(
      new Set(nested.flatMap((e) => (e.type === 'delta' ? [e.kind] : [])))
    ).toEqual(new Set(Object.keys(CONTENT_KINDS)))
  })
})
