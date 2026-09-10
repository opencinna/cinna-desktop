import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { AgentStreamEvent, AgentTaskState } from '../../../shared/agentStreamEvents'
import type { LlmStreamEvent } from '../../../shared/llmStreamEvents'
import type { ContentKind } from '../../../shared/messageParts'
import { PERMISSION_TOOL_NAME, QUESTION_TOOL_NAME } from '../../../shared/localAgentRequests'

/**
 * What every stream event does to renderer state, as `useChatStream` handles it
 * today — the receiver-side characterization for the agent-runtime refactor.
 *
 * Phase 1 merges `handleLlm` and `handleAgent` into one `handleRun` and the two
 * event unions into one. A merge like that fails quietly: a `case` that was in
 * one switch and not the other disappears, or an event one handler ignored
 * starts doing something, and every surface still renders. So each row here
 * feeds one event through the hook the way production does — mount, send,
 * capture the callback `window.api` was handed, emit — and records **exactly
 * which chat-store fields changed and which queries were invalidated**. A field
 * a row does not name is asserted unchanged, so "the hook ignores this" is a
 * pinned fact rather than an absence of assertions.
 *
 * Two snapshots per row, because `done` is two-phase on purpose: the cursor
 * goes away at once, but the streaming blocks and the optimistic user bubble
 * stay until the `['chat', id]` refetch settles, so there is no visual gap.
 * `sync` is the state when the handler returns; `settled` is after pending
 * promises run. A row that omits `sync` changes nothing asynchronously.
 *
 * Some rows pin behaviour that looks wrong. They are marked `PINNED:` and are
 * not fixed here — this file records what is, so the merge can show it changed
 * nothing, and a fix can show it changed exactly one row.
 *
 * The coverage guards at the bottom are typed `Record<Union, true>`, so adding
 * an event variant, a content kind or a task state fails the typecheck until a
 * row for it exists.
 */

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { useChatStream } = await import('./useChatStream')
const { useChatStore } = await import('../stores/chat.store')
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
  'sendError'
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
let llmSend: ReturnType<typeof vi.fn>
let agentSend: ReturnType<typeof vi.fn>
let statusGet: ReturnType<typeof vi.fn>
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  llmSend = vi.fn()
  agentSend = vi.fn()
  statusGet = vi.fn().mockResolvedValue({ success: true, item: null })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    llm: { sendMessage: llmSend, cancel: vi.fn() },
    agents: { sendMessage: agentSend, cancelMessage: vi.fn() },
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

async function runRow<E>(path: 'llm' | 'agent', row: Row<E>): Promise<void> {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useChatStream(), { wrapper })

  act(() => {
    if (path === 'llm') result.current.startLlm(CHAT_ID, 'hello')
    else result.current.startAgent(AGENT_ID, CHAT_ID, 'hello')
  })
  const send = path === 'llm' ? llmSend : agentSend
  expect(send).toHaveBeenCalledTimes(1)
  // The optimistic bubble is set by the send, before any event arrives.
  expect(useChatStore.getState().pendingUserMessage).toEqual(PENDING)
  const emit = send.mock.calls[0][path === 'llm' ? 2 : 3] as (event: E) => void

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

  // Read synchronously after the emit: the send's own 300 ms `['chat', id]`
  // refetch is a timer, so it cannot land between these two lines.
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
  expect(statusGet.mock.calls.map(([args]) => args)).toEqual(
    row.pullsStatus ? [{ agentId: AGENT_ID, forceRefresh: false }] : []
  )
  const handlerLogs = consoleError.mock.calls.filter(
    ([first]) => first === 'LLM error:' || first === 'Agent error:'
  )
  expect(handlerLogs).toEqual(row.logged ? [row.logged] : [])
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST_ID = { type: 'request-id', requestId: 'req-1' } as const
const PENDING = { content: 'hello', baselineUserCount: 0 }
const STALE_BLOCK = { type: 'text', kind: 'text', content: 'from the last turn' } as const

const DONE_SETTLED: Changes = {
  isStreaming: false,
  streamingBlocks: [],
  activeRequestId: null,
  pendingUserMessage: null
}
const DONE_INVALIDATES = [['chat', CHAT_ID], ['chats'], ['jobs']]

const ERROR_CHANGES: Changes = {
  isStreaming: false,
  streamingBlocks: [],
  activeRequestId: null,
  pendingUserMessage: null,
  streamedIncrementallyChatId: null
}

const FILE = { fileId: 'f-1', filename: 'report.pdf', mimeType: 'application/pdf', size: 1024 }
const FILE_2 = { fileId: 'f-2', filename: 'chart.png', mimeType: 'image/png', size: 2048 }
const PERMISSION_INPUT = { action: 'bash', resources: ['rm -rf build'], savable: ['*'] }
const QUESTION_INPUT = { questions: [{ question: 'Which branch?', options: ['main', 'dev'] }] }

function textBlock(kind: ContentKind, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'text', kind, content, ...extra }
}

// ---------------------------------------------------------------------------
// handleAgent — `window.api.agents.sendMessage`
// ---------------------------------------------------------------------------

const AGENT_TEXT: AgentStreamEvent = { type: 'delta', kind: 'text', text: 'Working on it' }

const ALL_TASK_STATES: Record<AgentTaskState, true> = {
  submitted: true,
  working: true,
  'input-required': true,
  completed: true,
  canceled: true,
  failed: true,
  rejected: true,
  'auth-required': true,
  unknown: true
}

const AGENT_ROWS: Row<AgentStreamEvent>[] = [
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
  // PINNED: every task state is ignored — including the terminal `failed` /
  // `canceled` / `rejected`. A stream that reports `failed` and never sends
  // `error` or `done` leaves `isStreaming` true.
  ...(Object.keys(ALL_TASK_STATES) as AgentTaskState[]).map(
    (state): Row<AgentStreamEvent> => ({
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
    // Contrast with the `tool_subevent` notice row, which is skipped.
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

  // Local-agent asks. The hook does nothing special: an ask is an ordinary
  // `tool` block, and "is it answerable" is decided downstream from the
  // `per_` / `que_` id. No streaming change, no invalidation, no status pull.
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
    // PINNED: `tool` blocks merge on `toolName` alone, not `toolId`. The second
    // ask folds into the first block, which keeps the first ask's id and input
    // — and since an ask's text is empty the block comes out byte-identical, so
    // the second ask produces no mutation at all. Its `per_` id, the address its
    // answer must be posted to, never reaches the store. The same rule merges
    // any two back-to-back calls to one tool.
    name: 'PINNED: a second back-to-back permission ask is swallowed by the first block',
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
    settled: {},
    invalidates: []
  },

  {
    name: 'done: cursor off at once; blocks, request id and pending bubble cleared after the refetch',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: { type: 'done' },
    sync: { isStreaming: false },
    settled: DONE_SETTLED,
    invalidates: DONE_INVALIDATES,
    pullsStatus: true
  },
  {
    // PINNED: unlike `done`, blocks and the optimistic bubble are dropped
    // before the `['chat', id]` refetch lands, and `['chats']` / `['jobs']` are
    // not invalidated. `sendError` is left alone by design (the error arrives
    // as a persisted SystemMessage row).
    name: 'error without code stops streaming immediately and refetches the chat only',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: { type: 'error', error: 'boom' },
    settled: ERROR_CHANGES,
    invalidates: [['chat', CHAT_ID]],
    pullsStatus: true,
    logged: ['Agent error:', 'boom']
  },
  {
    name: 'error with code behaves identically — the code is not read here',
    seed: [REQUEST_ID, AGENT_TEXT],
    event: { type: 'error', error: 'Sign in again', code: 'cinna_reauth_required' },
    settled: ERROR_CHANGES,
    invalidates: [['chat', CHAT_ID]],
    pullsStatus: true,
    logged: ['Agent error:', 'Sign in again']
  }
]

// ---------------------------------------------------------------------------
// handleLlm — `window.api.llm.sendMessage`
// ---------------------------------------------------------------------------

const MCP_CALL: LlmStreamEvent = {
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

const AGENT_CALL: LlmStreamEvent = {
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

const LLM_TEXT: LlmStreamEvent = { type: 'delta', text: 'Hello' }

function sub(event: AgentStreamEvent, toolCallId = 'call-2'): LlmStreamEvent {
  return { type: 'tool_subevent', toolCallId, event }
}

/** A sub-event row: seeded with an agent tool call, incremental flag cleared so it is visible. */
function subRow(
  name: string,
  event: AgentStreamEvent,
  subParts: Record<string, unknown>[] | null
): Row<LlmStreamEvent> {
  return {
    name,
    seed: [REQUEST_ID, AGENT_CALL],
    seedState: { streamedIncrementallyChatId: null },
    event: sub(event),
    settled: subParts
      ? { streamingBlocks: [agentCallBlock(subParts)], streamedIncrementallyChatId: CHAT_ID }
      : {},
    invalidates: []
  }
}

const LLM_ROWS: Row<LlmStreamEvent>[] = [
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
    name: 'delta merges into a preceding text block',
    seed: [REQUEST_ID, { type: 'delta', text: 'Hel' }],
    event: { type: 'delta', text: 'lo' },
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

  // tool_subevent: only nested deltas reach the sub-thread; every other nested
  // event — including a nested `done` or `error` — leaves the outer turn alone.
  subRow('tool_subevent request-id is ignored', REQUEST_ID, null),
  ...(['working', 'input-required', 'auth-required', 'completed', 'failed', 'canceled'] as const).map(
    (state) => subRow(`tool_subevent status ${state} is ignored`, { type: 'status', state, taskId: 't-1' }, null)
  ),
  subRow('tool_subevent delta text appends a sub-part', { type: 'delta', kind: 'text', text: 'Hi' }, [
    { kind: 'text', text: 'Hi' }
  ]),
  subRow('tool_subevent delta thinking appends a sub-part', { type: 'delta', kind: 'thinking', text: 'Hmm' }, [
    { kind: 'thinking', text: 'Hmm' }
  ]),
  subRow(
    'tool_subevent delta tool carries toolId, toolName and toolInput',
    { type: 'delta', kind: 'tool', text: 'ls', toolId: 'toolu_1', toolName: 'Bash', toolInput: { command: 'ls' } },
    [{ kind: 'tool', text: 'ls', toolId: 'toolu_1', toolName: 'Bash', toolInput: { command: 'ls' } }]
  ),
  subRow(
    'tool_subevent delta tool_result carries toolId and toolStream',
    { type: 'delta', kind: 'tool_result', text: 'ok', toolId: 'toolu_1', toolStream: 'stderr' },
    [{ kind: 'tool_result', text: 'ok', toolId: 'toolu_1', toolStream: 'stderr' }]
  ),
  // Contrast with the top-level agent notice row, which is appended.
  subRow('tool_subevent delta notice is skipped', { type: 'delta', kind: 'notice', text: 'restarted' }, null),
  subRow(
    'tool_subevent delta command_result carries commandInvocation',
    { type: 'delta', kind: 'command_result', text: '3 files', commandInvocation: '/files' },
    [{ kind: 'command_result', text: '3 files', commandInvocation: '/files' }]
  ),
  subRow('tool_subevent delta file carries the file', { type: 'delta', kind: 'file', text: '', file: FILE }, [
    { kind: 'file', text: '', file: FILE }
  ]),
  subRow(
    'tool_subevent local-agent permission ask (per_ id) is a plain sub-part',
    { type: 'delta', kind: 'tool', text: '', toolName: PERMISSION_TOOL_NAME, toolId: 'per_abc', toolInput: PERMISSION_INPUT },
    [{ kind: 'tool', text: '', toolName: PERMISSION_TOOL_NAME, toolId: 'per_abc', toolInput: PERMISSION_INPUT }]
  ),
  subRow(
    'tool_subevent local-agent question (que_ id) is a plain sub-part',
    { type: 'delta', kind: 'tool', text: '', toolName: QUESTION_TOOL_NAME, toolId: 'que_abc', toolInput: QUESTION_INPUT },
    [{ kind: 'tool', text: '', toolName: QUESTION_TOOL_NAME, toolId: 'que_abc', toolInput: QUESTION_INPUT }]
  ),
  subRow('tool_subevent done does not finish the outer turn', { type: 'done' }, null),
  subRow(
    'tool_subevent error does not stop the outer turn',
    { type: 'error', error: 'agent failed', code: 'cinna_reauth_required' },
    null
  ),
  {
    name: 'tool_subevent delta merges into the previous sub-part',
    seed: [REQUEST_ID, AGENT_CALL, sub({ type: 'delta', kind: 'text', text: 'Hel' })],
    event: sub({ type: 'delta', kind: 'text', text: 'lo' }),
    settled: { streamingBlocks: [agentCallBlock([{ kind: 'text', text: 'Hello' }])] },
    invalidates: []
  },
  {
    name: 'tool_subevent on an mcp tool call still grows a sub-thread (matched by id only)',
    seed: [REQUEST_ID, MCP_CALL],
    event: sub({ type: 'delta', kind: 'text', text: 'Hi' }, 'call-1'),
    settled: { streamingBlocks: [{ ...MCP_BLOCK, subParts: [{ kind: 'text', text: 'Hi' }] }] },
    invalidates: []
  },
  {
    // PINNED: no block matches, yet the incremental flag is still set.
    name: 'PINNED: tool_subevent delta for an unknown toolCallId sets the incremental flag and nothing else',
    seed: [REQUEST_ID, AGENT_CALL],
    seedState: { streamedIncrementallyChatId: null },
    event: sub({ type: 'delta', kind: 'text', text: 'Hi' }, 'nope'),
    settled: { streamedIncrementallyChatId: CHAT_ID },
    invalidates: []
  },

  {
    name: 'done: cursor off at once; blocks, request id and pending bubble cleared after the refetch',
    seed: [REQUEST_ID, LLM_TEXT],
    event: { type: 'done' },
    sync: { isStreaming: false },
    settled: DONE_SETTLED,
    invalidates: DONE_INVALIDATES
  },
  {
    name: 'error without errorDetail stops streaming immediately and refetches the chat only',
    seed: [REQUEST_ID, LLM_TEXT],
    event: { type: 'error', error: 'rate limited' },
    settled: ERROR_CHANGES,
    invalidates: [['chat', CHAT_ID]],
    logged: ['LLM error:', 'rate limited']
  },
  {
    name: 'error with errorDetail behaves identically — the detail is not read here',
    seed: [REQUEST_ID, LLM_TEXT],
    event: { type: 'error', error: 'rate limited', errorDetail: '429 Too Many Requests' },
    settled: ERROR_CHANGES,
    invalidates: [['chat', CHAT_ID]],
    logged: ['LLM error:', 'rate limited']
  }
]

describe('useChatStream — handleAgent, one row per event', () => {
  it.each(AGENT_ROWS)('$name', async (row) => {
    await runRow('agent', row)
  })
})

describe('useChatStream — handleLlm, one row per event', () => {
  it.each(LLM_ROWS)('$name', async (row) => {
    await runRow('llm', row)
  })
})

// ---------------------------------------------------------------------------
// Coverage guards — a new variant fails the typecheck here until it has a row.
// ---------------------------------------------------------------------------

const AGENT_EVENT_TYPES: Record<AgentStreamEvent['type'], true> = {
  'request-id': true,
  status: true,
  delta: true,
  done: true,
  error: true
}
const LLM_EVENT_TYPES: Record<LlmStreamEvent['type'], true> = {
  'request-id': true,
  delta: true,
  tool_use: true,
  tool_result: true,
  tool_error: true,
  tool_subevent: true,
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
  it('has an agent row for every AgentStreamEvent variant, content kind and task state', () => {
    const events = AGENT_ROWS.map((row) => row.event)
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(Object.keys(AGENT_EVENT_TYPES)))
    expect(
      new Set(events.flatMap((e) => (e.type === 'delta' ? [e.kind] : [])))
    ).toEqual(new Set(Object.keys(CONTENT_KINDS)))
    expect(
      new Set(events.flatMap((e) => (e.type === 'status' ? [e.state] : [])))
    ).toEqual(new Set(Object.keys(ALL_TASK_STATES)))
  })

  it('has an llm row for every LlmStreamEvent variant, and a sub-event row for every nested variant and kind', () => {
    const events = LLM_ROWS.map((row) => row.event)
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(Object.keys(LLM_EVENT_TYPES)))
    const nested = events.flatMap((e) => (e.type === 'tool_subevent' ? [e.event] : []))
    expect(new Set(nested.map((e) => e.type))).toEqual(new Set(Object.keys(AGENT_EVENT_TYPES)))
    expect(
      new Set(nested.flatMap((e) => (e.type === 'delta' ? [e.kind] : [])))
    ).toEqual(new Set(Object.keys(CONTENT_KINDS)))
  })
})
