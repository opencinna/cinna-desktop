import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

/**
 * A refusal is an ending, and this is the only thing that hears one.
 *
 * A turn that never reached a streaming service used to report nothing: the two
 * services report their own endings, and neither of them ran. So the job run
 * that asked for the turn stayed `running` for the life of the app, and its
 * task stayed wherever the caller had put it — which is what let the task
 * page's re-run claim a stuck task `in_progress` and then leave it there when
 * the turn was refused for a missing agent.
 */
const reportRunCompletion = vi.fn()
vi.mock('../services/jobService', () => ({
  jobService: {
    reportRunCompletion: (chatId: string, status: string, message?: string) =>
      reportRunCompletion(chatId, status, message)
  }
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
  inboxService: { recordRunEvent: (...args: unknown[]) => recordRunEvent(...args), resumeChat: vi.fn(), hasNextMessage: () => false }
}))

// The real command dispatch short-circuits for a `card` agent by handing the
// fallback straight back — which is what this file wants: the driver's own turn.
vi.mock('../services/localAgents/commandService', () => ({
  resolveCommandRunner: (..._args: unknown[]) => _args[4]
}))

const { registerRunHandlers } = await import('./run.ipc')
const { runExecutionService } = await import('../services/runExecutionService')

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

afterEach(() => {
  // The fake services leave the stream open for event-forwarding assertions.
  // Close those fake turns so the main execution owner releases the chat.
  for (const call of streamToAgent.mock.calls) {
    ;(call[0] as unknown as { port: { close(): void } }).port.close()
  }
  for (const call of llmStream.mock.calls) {
    ;(call[0] as { port: { close(): void } }).port.close()
  }
})

beforeEach(() => {
  ipcOnHandlers.clear()
  vi.clearAllMocks()
  // `clearAllMocks` drops calls, not implementations — and one test below makes
  // this one throw. Without the reset it would throw for the rest of the file.
  reportRunCompletion.mockReset()
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
    streamToAgent.mockImplementationOnce(async (input) => {
      ;(input as { port: { close(): void } }).port.close()
      throw new Error('the stream blew up')
    })
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    expect(port.postMessage).not.toHaveBeenCalled()
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('does not post over an llm stream that already owns the port either', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    llmStream.mockImplementationOnce(async (input) => {
      ;(input as { port: { close(): void } }).port.close()
      throw new Error('the stream blew up')
    })
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    expect(port.postMessage).not.toHaveBeenCalled()
    expect(port.close).toHaveBeenCalledTimes(1)
  })
})

describe('run:send — refusals and the channels it replaced', () => {
  it('keeps acceptance after persistence even when command setup then fails', async () => {
    const commands = await import('../services/localAgents/commandService')
    vi.spyOn(commands, 'resolveCommandRunner').mockImplementationOnce(() => { throw new Error('Command catalog unavailable') })
    const observe = vi.fn()
    const handle = runExecutionService.start(
      { profileUserId: 'profile-user', settingsUserId: 'settings-user' },
      { chatId: 'chat-1', content: '/run:check' },
      { observe, preserveOnRefusal: true }
    )
    await expect(handle.accepted).resolves.toBeUndefined()
    await handle.completed
    expect(observe).toHaveBeenCalledWith(expect.anything(), { type: 'error', error: 'Command catalog unavailable' })
    expect(reportRunCompletion).toHaveBeenCalledWith('chat-1', 'failed', 'Command catalog unavailable')
  })

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

  it('reports a missing agent as an ending, so the run and its task stop hanging', async () => {
    // Mutation: drop `reportRefusal` from `runAgentTurn` and this fails — the
    // job run stays `running` (the sidebar's busy badge with it) and the task
    // the re-run just claimed is never moved again.
    chatRow = { id: 'chat-1', router: 'direct', agentId: 'a-gone' }
    await send({ chatId: 'chat-1', content: 'hello' })
    expect(reportRunCompletion).toHaveBeenCalledWith(
      'chat-1',
      'failed',
      'Agent not found or not configured'
    )
  })

  it('cannot finalize another profile’s job through an unowned chat id', async () => {
    chatRow = undefined as unknown as Record<string, unknown>
    await send({ chatId: 'chat-9', content: 'hello' })
    expect(reportRunCompletion).not.toHaveBeenCalled()
    expect(recordRunEvent).not.toHaveBeenCalled()
  })

  it('does not finalize a job when ownership lookup itself fails', async () => {
    const { chatRepo } = await import('../db/chats')
    vi.mocked(chatRepo.getOwned).mockImplementationOnce(() => { throw new Error('database unavailable') })
    const port = await send({ chatId: 'chat-9', content: 'hello' })
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'error', error: 'database unavailable' })
    expect(port.close).toHaveBeenCalled()
    expect(reportRunCompletion).not.toHaveBeenCalled()
    expect(recordRunEvent).not.toHaveBeenCalled()
  })

  it('never lets that bookkeeping fail the turn it is reporting', async () => {
    // The call inside `dispatchRun`'s catch is the one that matters: that
    // function's whole guarantee is that it does not throw, because a rejection
    // there is invisible — `void dispatchRun(...)` in an `ipcMain.on` listener
    // posts nothing, closes nothing, and leaves the renderer streaming.
    // **What catches the mutation is the runner, not the two assertions
    // below.** `send` does not await `dispatchRun` — the listener is
    // `void dispatchRun(...)`, which is the whole reason the guarantee matters
    // — so a rejection surfaces as an unhandled one. Verified: removing the
    // try/catch in `reportRefusal` makes this file exit 1 with
    // "Unhandled Rejection", while the assertions still pass. They pin the
    // other half: the turn still ends on the port.
    reportRunCompletion.mockImplementation(() => {
      throw new Error('database is locked')
    })
    prepareAgentSend.mockImplementationOnce(() => {
      throw new Error('Chat not found')
    })
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    expect(port.close).toHaveBeenCalled()
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', error: 'Chat not found' })
    )
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
      { userId: 'profile-user', chatId: 'chat-1', agentId: 'a-1', turnId: expect.any(String) },
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
      { userId: 'profile-user', chatId: 'chat-1', agentId: null, turnId: expect.any(String) },
      ASK
    )
  })

  it('closes the real port when the stream closes the one it was given', async () => {
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    portGivenToTheStream().close()
    expect(port.close).toHaveBeenCalled()
  })
})


describe('main-owned turn lifetime', () => {
  const scope = { profileUserId: 'profile-user', settingsUserId: 'settings-user' }
  const payload = { chatId: 'chat-1', content: 'Continue' }

  it('cancels a main-owned turn by owned chat and refuses a foreign chat', async () => {
    const handle = runExecutionService.start(scope, payload, { observe: vi.fn() })
    await handle.accepted
    const cancel = vi.spyOn(handle, 'cancel')
    runExecutionService.cancelChat('profile-user', 'chat-1')
    expect(cancel).toHaveBeenCalledTimes(1)
    chatRow = undefined as unknown as Record<string, unknown>
    expect(() => runExecutionService.cancelChat('other-profile', 'chat-1')).toThrow('Chat not found')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps an early-returning model turn alive with no renderer until its stream closes', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    const observer = vi.fn()
    const handle = runExecutionService.start(scope, payload, { observe: observer })
    await handle.accepted
    let complete = false
    void handle.completed.then(() => { complete = true })
    await Promise.resolve()
    expect(complete).toBe(false)
    expect(runExecutionService.isRunning('chat-1')).toBe(true)
    expect(() => runExecutionService.start(scope, payload, { observe: observer })).toThrow('already has a turn')
    const port = portGivenToTheStream()
    port.postMessage(ASK)
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ turnId: handle.id, agentId: null }), ASK)
    port.close()
    await handle.completed
    expect(runExecutionService.isRunning('chat-1')).toBe(false)
  })

  it('continues the asking agent in a coordinator chat without redirecting the answer to the model', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    const handle = runExecutionService.start(scope, payload, { observe: vi.fn(), agentId: 'a-2' })
    await handle.accepted
    expect(routedTo()).toBe('a-2')
    expect(llmStream).not.toHaveBeenCalled()
    expect(prepareAgentSend).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a-2', userContent: 'Continue' }))
  })

  it('keeps observing events after its renderer disconnects', async () => {
    const observer = vi.fn()
    const handle = runExecutionService.start(scope, payload, {
      observe: observer,
      port: { postMessage: () => { throw new Error('closed view') }, close: () => { throw new Error('closed view') } }
    })
    await handle.accepted
    const port = portGivenToTheStream()
    expect(() => port.postMessage(ASK)).not.toThrow()
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a-1' }), ASK)
    port.close()
    await handle.completed
  })

  it('observes preparation failures on an owned chat and releases the active turn', async () => {
    prepareAgentSend.mockImplementationOnce(() => { throw new Error('write failed') })
    const observer = vi.fn()
    const handle = runExecutionService.start(scope, payload, { observe: observer })
    await expect(handle.accepted).rejects.toThrow('write failed')
    await handle.completed
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a-1' }), {
      type: 'error', error: 'write failed'
    })
    expect(runExecutionService.isRunning('chat-1')).toBe(false)
  })

  it('observes an unexpected model setup failure even if the streaming service never closed', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    llmStream.mockRejectedValueOnce(new Error('setup failed'))
    const observer = vi.fn()
    const handle = runExecutionService.start(scope, payload, { observe: observer })
    await handle.accepted
    await handle.completed
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ agentId: null }), {
      type: 'error', error: 'setup failed'
    })
    expect(runExecutionService.isRunning('chat-1')).toBe(false)
    expect(reportRunCompletion).toHaveBeenCalledWith('chat-1', 'failed', 'setup failed')
  })

  it('leaves a pending Inbox ask and job alone when answer preparation refuses', async () => {
    prepareAgentSend.mockImplementationOnce(() => { throw new Error('write failed') })
    const observer = vi.fn()
    const handle = runExecutionService.start(scope, payload, { observe: observer, preserveOnRefusal: true })
    await expect(handle.accepted).rejects.toThrow('write failed')
    await handle.completed
    expect(observer).not.toHaveBeenCalled()
    expect(reportRunCompletion).not.toHaveBeenCalled()
  })
})
