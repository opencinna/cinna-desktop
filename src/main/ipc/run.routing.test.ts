import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentRow } from '../db/agents'
import type { MessageRow } from '../db/messages'
import type { RunEvent } from '../../shared/runEvents'

/**
 * `run:send` resolves who answers, and hands an agent the thread it missed.
 *
 * This is the seam phase 4 moved out of the renderer: the composer used to pick
 * between two IPC channels, which *was* the routing decision. Main takes it now,
 * from `chats.router`, and the claims worth pinning are the ones a renderer
 * cache cannot be trusted with — which agent a `human` chat addresses, what
 * reaches that agent ahead of the user's text, and when its cursor moves.
 *
 * Everything past the decision is mocked to a canned happy path. The driver, the
 * streaming service and the packet builder each have their own tests; what is
 * asserted here is what this handler *chooses* and what it *passes on*.
 */

const ipcOnHandlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcOnHandlers.set(channel, handler)
    },
    handle: () => undefined
  }
}))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('./_wrap', () => ({ ipcHandle: () => undefined }))

vi.mock('../auth/activation', () => ({
  userActivation: { isActivated: () => true, requireActivated: () => undefined }
}))
vi.mock('../auth/scope', () => ({
  getProfileScopeUserId: () => 'profile-user',
  getSettingsScopeUserId: () => 'settings-user'
}))

let chatRow: Record<string, unknown> = {}
let history: MessageRow[] = []
const listMessages = vi.fn(() => history)
vi.mock('../db/chats', () => ({
  chatRepo: { getOwned: vi.fn(() => chatRow), listMessages }
}))

const saveError = vi.fn()
const lastAddressedAgentId = vi.fn((): string | null => null)
const lastId = vi.fn((): string | null => 'm-last')
vi.mock('../db/messages', () => ({
  messageRepo: { saveError, lastAddressedAgentId, lastId }
}))

let attached: string[] = []
vi.mock('../db/chatOnDemandAgent', () => ({
  chatOnDemandAgentRepo: { listAgentIds: vi.fn(() => attached) }
}))

const cursorGet = vi.fn((): { lastMessageId: string | null } | undefined => undefined)
const cursorAdvance = vi.fn()
vi.mock('../db/chatAgentCursors', () => ({
  chatAgentCursorRepo: { get: cursorGet, advance: cursorAdvance }
}))

function agentRow(id: string, name: string): AgentRow {
  return { id, name, source: 'remote', driver: 'a2a', cardUrl: 'https://x.test/c' } as AgentRow
}
const AGENTS = [agentRow('a-1', 'Research'), agentRow('a-2', 'Builder')]

const findAgent = vi.fn((_s: string, _p: string, id: string) => {
  const row = AGENTS.find((a) => a.id === id)
  return row ? { row, userId: 'owner-1' } : null
})
vi.mock('../services/agentService', () => ({
  agentService: { findAgent, listMerged: vi.fn(() => AGENTS) }
}))

const prepareAgentSend = vi.fn((input: { userContent: string }) => ({
  wireContent: input.userContent
}))
const prepareLlmSend = vi.fn((input: { userContent: string }) => ({
  wireContent: input.userContent
}))
vi.mock('../services/messageRoutingService', () => ({
  messageRoutingService: { prepareAgentSend, prepareLlmSend }
}))

const streamToAgent = vi.fn(async (_input: unknown) => undefined)
vi.mock('../services/a2aStreamingService', () => ({
  a2aStreamingService: { streamToAgent }
}))

const llmStream = vi.fn(async (_input: unknown) => undefined)
vi.mock('../services/chatStreamingService', () => ({
  chatStreamingService: { stream: llmStream }
}))

const driverRun = vi.fn(async () => ({ text: '', parts: [], notices: [] }))
vi.mock('../agents/drivers', () => ({
  driverFor: () => ({
    id: 'a2a',
    capabilities: () => ({ commands: 'card' }),
    run: driverRun,
    readiness: vi.fn(),
    respond: vi.fn()
  })
}))

const recordRunEvent = vi.fn()
vi.mock('../services/inboxService', () => ({
  inboxService: { recordRunEvent: (...args: unknown[]) => recordRunEvent(...args) }
}))

// The real command dispatch short-circuits for a `card` agent by handing the
// fallback straight back — which is what this file wants: the driver's own turn.
vi.mock('../services/localAgents/commandService', () => ({
  resolveCommandRunner: (..._args: unknown[]) => _args[4]
}))

const { registerRunHandlers } = await import('./run.ipc')

function fakePort() {
  return { start: vi.fn(), close: vi.fn(), postMessage: vi.fn() }
}

let order = 0
function message(over: Partial<MessageRow>): MessageRow {
  return {
    id: `m-${++order}`,
    chatId: 'chat-1',
    role: 'user',
    content: '',
    addressedAgentId: null,
    sourceAgentId: null,
    attachments: null,
    toolName: null,
    toolAgentId: null,
    toolError: null,
    sortOrder: order,
    createdAt: new Date(),
    ...over
  } as MessageRow
}

async function send(
  payload: Record<string, unknown>,
  channel = 'run:send'
): Promise<ReturnType<typeof fakePort>> {
  const port = fakePort()
  await ipcOnHandlers.get(channel)?.({ ports: [port] }, payload)
  return port
}

/** What the driver was actually told to say, on the last turn that reached it. */
async function wireContent(): Promise<string> {
  const input = streamToAgent.mock.calls.at(-1)![0] as {
    run: (io: { signal: AbortSignal; onEvent: () => void }) => Promise<unknown>
  }
  await input.run({ signal: new AbortController().signal, onEvent: vi.fn() })
  return (driverRun.mock.calls.at(-1) as unknown as [string, AgentRow, { wireContent: string }])[2]
    .wireContent
}

/** Which agent the turn was routed to. */
function routedTo(): string {
  return (streamToAgent.mock.calls.at(-1)![0] as { agentId: string }).agentId
}

/** The port the turn was actually handed — the inbox-observing wrapper, not the raw one. */
function portGivenToTheStream(): { postMessage: (msg: RunEvent) => void; close: () => void } {
  const call = (streamToAgent.mock.calls.at(-1) ?? llmStream.mock.calls.at(-1))![0]
  return (call as { port: { postMessage: (msg: RunEvent) => void; close: () => void } }).port
}

const ASK: RunEvent = {
  type: 'needs_input',
  requestId: 'per_1',
  request: { kind: 'permission', action: 'bash', resources: ['ls'] },
  resume: 'reply'
}

beforeEach(() => {
  ipcOnHandlers.clear()
  vi.clearAllMocks()
  lastId.mockReturnValue('m-last')
  lastAddressedAgentId.mockReturnValue(null)
  cursorGet.mockReturnValue(undefined)
  history = []
  attached = []
  chatRow = { id: 'chat-1', router: 'direct', agentId: 'a-1' }
  registerRunHandlers()
})

describe('run:send — who answers', () => {
  it('sends a direct chat to its bound agent, whatever the payload says', async () => {
    // The renderer's `addressedAgentId` is a gesture, not an instruction: a
    // stale cache naming another agent must not redirect a direct chat.
    await send({ chatId: 'chat-1', content: 'hello', addressedAgentId: 'a-2' })
    expect(routedTo()).toBe('a-1')
  })

  it('sends a coordinated chat to the local model', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    await send({ chatId: 'chat-1', content: 'hello', addressedAgentId: 'a-2' })
    expect(llmStream).toHaveBeenCalledTimes(1)
    expect(streamToAgent).not.toHaveBeenCalled()
    expect(prepareAgentSend).not.toHaveBeenCalled()
  })

  it('sends a human chat to the agent the message addresses', async () => {
    chatRow = { id: 'chat-1', router: 'human', agentId: null }
    attached = ['a-1', 'a-2']
    lastAddressedAgentId.mockReturnValue('a-1')
    await send({ chatId: 'chat-1', content: 'now build it', addressedAgentId: 'a-2' })
    expect(routedTo()).toBe('a-2')
    // And the user row records who it was for, which is what makes the next
    // message sticky.
    expect(prepareAgentSend).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a-2' }))
  })

  it('is sticky when the message addresses nobody', async () => {
    chatRow = { id: 'chat-1', router: 'human', agentId: null }
    attached = ['a-1', 'a-2']
    lastAddressedAgentId.mockReturnValue('a-2')
    await send({ chatId: 'chat-1', content: 'and again' })
    expect(routedTo()).toBe('a-2')
  })

  it('reads none of the addressing bookkeeping for a chat that is not human', async () => {
    await send({ chatId: 'chat-1', content: 'hello' })
    expect(lastAddressedAgentId).not.toHaveBeenCalled()
  })
})

describe('run:send — the catch-up packet', () => {
  beforeEach(() => {
    chatRow = { id: 'chat-1', router: 'human', agentId: null }
    attached = ['a-1', 'a-2']
    history = [
      message({ role: 'user', content: 'what changed?', addressedAgentId: 'a-1' }),
      message({ role: 'assistant', content: 'Three files in invoices/.', sourceAgentId: 'a-1' })
    ]
  })

  it('puts what the addressed agent missed in front of the user’s text', async () => {
    await send({ chatId: 'chat-1', content: 'now build it', addressedAgentId: 'a-2' })
    const wire = await wireContent()
    expect(wire).toContain('[Research] Three files in invoices/.')
    expect(wire.endsWith('now build it')).toBe(true)
    // The packet travels on the wire only — the transcript keeps what the user
    // typed.
    expect(prepareAgentSend).toHaveBeenCalledWith(
      expect.objectContaining({ userContent: 'now build it' })
    )
  })

  it('builds the packet from the thread before this message is persisted', async () => {
    // `prepareAgentSend` is what writes the user row. Building the packet after
    // it would put the question the agent is being asked inside the transcript
    // of what it missed.
    let historyReadAt = -1
    let persistedAt = -1
    let tick = 0
    listMessages.mockImplementation(() => {
      historyReadAt = ++tick
      return history
    })
    prepareAgentSend.mockImplementation((input: { userContent: string }) => {
      persistedAt = ++tick
      return { wireContent: input.userContent }
    })
    await send({ chatId: 'chat-1', content: 'now build it', addressedAgentId: 'a-2' })
    expect(historyReadAt).toBeGreaterThan(0)
    expect(historyReadAt).toBeLessThan(persistedAt)
  })

  it('sends no packet in a direct chat — there is nobody else in it', async () => {
    chatRow = { id: 'chat-1', router: 'direct', agentId: 'a-1' }
    await send({ chatId: 'chat-1', content: 'hello' })
    expect(await wireContent()).toBe('hello')
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('sends no packet when the addressed agent has seen everything', async () => {
    cursorGet.mockReturnValue({ lastMessageId: history.at(-1)!.id })
    await send({ chatId: 'chat-1', content: 'and again', addressedAgentId: 'a-1' })
    expect(await wireContent()).toBe('and again')
  })
})

describe('run:send — the cursor', () => {
  beforeEach(() => {
    chatRow = { id: 'chat-1', router: 'human', agentId: null }
    attached = ['a-1', 'a-2']
  })

  it('moves only when the turn completes', async () => {
    await send({ chatId: 'chat-1', content: 'go', addressedAgentId: 'a-2' })
    // Nothing yet: `streamToAgent` fires `onCompleted` only on the path where
    // the turn actually finished — not on an error, and not on a stop.
    expect(cursorAdvance).not.toHaveBeenCalled()

    const input = streamToAgent.mock.calls.at(-1)![0] as { onCompleted?: () => void }
    input.onCompleted?.()
    expect(cursorAdvance).toHaveBeenCalledWith('chat-1', 'a-2', 'm-last')
  })

  it('leaves the cursor alone when the chat has no messages to point at', async () => {
    lastId.mockReturnValue(null)
    await send({ chatId: 'chat-1', content: 'go', addressedAgentId: 'a-2' })
    const input = streamToAgent.mock.calls.at(-1)![0] as { onCompleted?: () => void }
    input.onCompleted?.()
    expect(cursorAdvance).not.toHaveBeenCalled()
  })
})

describe('run:send — a throw before the turn has an owner', () => {
  it('reports it on the port and closes it, rather than leaving the chat streaming', async () => {
    // The caller is `void dispatchRun(...)` inside an `ipcMain.on` listener, so
    // a rejection here is invisible: nothing posts, the port never closes, and
    // the renderer streams until the user navigates away. There is real work
    // between `port.start()` and the streaming service that can throw —
    // persisting the user row, reading the thread, resolving a `/run:`.
    prepareAgentSend.mockImplementationOnce(() => {
      throw new Error('Chat not found')
    })
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', error: 'Chat not found' })
    )
    expect(port.close).toHaveBeenCalled()
  })

  it('does not post over a stream that already owns the port', async () => {
    // Both services post a terminal event and close in their own `finally`, so
    // re-raising their failure would have the wrapper post to a closed port and
    // report as unhandled a turn the user has already been told about.
    streamToAgent.mockRejectedValueOnce(new Error('the stream blew up'))
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    expect(port.postMessage).not.toHaveBeenCalled()
    expect(port.close).not.toHaveBeenCalled()
  })

  it('does not post over an llm stream that already owns the port either', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    llmStream.mockRejectedValueOnce(new Error('the stream blew up'))
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    expect(port.postMessage).not.toHaveBeenCalled()
    expect(port.close).not.toHaveBeenCalled()
  })
})

describe('run:send — refusals and the channels it replaced', () => {
  it('refuses a chat the caller does not own, and closes the port', async () => {
    chatRow = undefined as unknown as Record<string, unknown>
    const port = await send({ chatId: 'chat-9', content: 'hello' })
    expect(port.close).toHaveBeenCalled()
    expect(streamToAgent).not.toHaveBeenCalled()
    expect(llmStream).not.toHaveBeenCalled()
  })

  it('records a missing agent in the transcript rather than only on the port', async () => {
    chatRow = { id: 'chat-1', router: 'direct', agentId: 'a-gone' }
    await send({ chatId: 'chat-1', content: 'hello' })
    expect(saveError).toHaveBeenCalledWith({
      chatId: 'chat-1',
      short: 'Agent not found or not configured'
    })
  })

  it('routes agent:send-message through the same decision', async () => {
    chatRow = { id: 'chat-1', router: 'human', agentId: null }
    attached = ['a-1', 'a-2']
    // The old channel named its agent; that becomes the addressing gesture.
    await send({ agentId: 'a-2', chatId: 'chat-1', content: 'hello' }, 'agent:send-message')
    expect(routedTo()).toBe('a-2')
  })

  it('routes llm:send-message through the same decision', async () => {
    // …which means a chat whose router says an agent answers gets the agent,
    // even on the channel that used to mean "the model".
    await send({ chatId: 'chat-1', content: 'hello' }, 'llm:send-message')
    expect(routedTo()).toBe('a-1')
    expect(llmStream).not.toHaveBeenCalled()
  })
})

/**
 * Every turn's events pass through the send path on their way to the renderer,
 * which is what makes this one hook enough to catch an ask from any driver, in
 * any router. What it must not do is get between the stream and the port.
 */
describe('run:send — the inbox tap', () => {
  it('mirrors an agent turn’s events into the inbox and still forwards them', async () => {
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    portGivenToTheStream().postMessage(ASK)

    expect(recordRunEvent).toHaveBeenCalledWith(
      { userId: 'profile-user', chatId: 'chat-1', agentId: 'a-1' },
      ASK
    )
    expect(port.postMessage).toHaveBeenCalledWith(ASK)
  })

  it('names no agent on the model’s own turn', async () => {
    // A coordinated chat's turn belongs to the model; an ask inside it comes
    // from a nested agent, and the `child` wrapper is what names that one.
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    await send({ chatId: 'chat-1', content: 'hello' })
    portGivenToTheStream().postMessage(ASK)

    expect(recordRunEvent).toHaveBeenCalledWith(
      { userId: 'profile-user', chatId: 'chat-1', agentId: null },
      ASK
    )
  })

  it('closes the real port when the stream closes the one it was given', async () => {
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    portGivenToTheStream().close()
    expect(port.close).toHaveBeenCalled()
  })
})
