import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentRow } from '../db/agents'
import type { MessageRow } from '../db/messages'
import type { RunEvent } from '../../shared/runEvents'
const runnerTask = vi.hoisted(() => vi.fn())
const openRunRequests = vi.hoisted(() => vi.fn(() => [] as { id: string; resume: 'reply' | 'next_message' }[]))
const chatTask = vi.hoisted(() => vi.fn((): { id: string } | undefined => undefined))
vi.mock('../db/tasks', () => ({ taskRepo: { getById: runnerTask, getByChatId: chatTask } }))
const handoverOfTask = vi.hoisted(() => vi.fn((): { depth: number } | undefined => undefined))
vi.mock('../db/handovers', () => ({ handoverRepo: { byTaskId: handoverOfTask } }))
vi.mock('../db/taskInputRequests', () => ({ taskInputRequestRepo: { listOpenForRun: openRunRequests } }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))
const handoffPending = vi.hoisted(() => vi.fn(() => false))
vi.mock('../db/taskHandoffs', () => ({ taskHandoffRepo: { unresolvedForChat: handoffPending } }))

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

let profileId = 'profile-user'
let activated = true
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
vi.mock('../index', () => ({ getMainWindow: () => null }))

vi.mock('../auth/activation', () => ({
  userActivation: { isActivated: () => activated, requireActivated: () => undefined }
}))
vi.mock('../auth/scope', () => ({
  getProfileScopeUserId: () => profileId,
  getSettingsScopeUserId: () => 'settings-user'
}))

let chatRow: Record<string, unknown> = {}
let history: MessageRow[] = []
const listMessages = vi.fn(() => history)
const recordChatResult = vi.fn()
vi.mock('../db/chatRunResults', () => ({ chatRunResultRepo: { record: (...args: unknown[]) => recordChatResult(...args) } }))
vi.mock('../db/chats', () => ({
  chatRepo: { listMessageIds: vi.fn(() => []), getOwned: vi.fn(() => chatRow), listMessages }
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
const saveUser = vi.fn()
const touchChat = vi.fn()
const lastAddressedAgentId = vi.fn((): string | null => null)
const lastId = vi.fn((): string | null => 'm-last')
vi.mock('../db/messages', () => ({
  messageRepo: { saveError, saveUser, touchChat, lastAddressedAgentId, lastId }
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
const AGENTS = [agentRow('a-1', 'Research'), agentRow('a-2', 'Builder'), { ...agentRow('a-runtime', 'Chat runtime'), driver: 'acp' as const }]
const bindRuntime = vi.fn((_userId: string, chat: Record<string, unknown>) => { chatRow = { ...chat, agentId: 'a-runtime' }; return chatRow })
vi.mock('../services/chatConductorService', () => ({ chatConductorService: { bind: (...args: Parameters<typeof bindRuntime>) => bindRuntime(...args) } }))

const findAgent = vi.fn((_s: string, _p: string, id: string) => {
  const row = AGENTS.find((a) => a.id === id)
  return row ? { row, userId: 'owner-1' } : null
})
vi.mock('../services/agentService', () => ({
  agentService: { findAgent, listMerged: vi.fn(() => AGENTS) }
}))

const prepareAgentSend = vi.fn((input: { userContent: string }): { wireContent: string; userMessageId?: string } => ({
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


const driverRun = vi.fn(async () => ({ text: '', parts: [], notices: [] }))
/** Whether this turn's agent runs in a folder on this machine (`capabilities.cwd`). */
const caps = vi.hoisted(() => ({ cwd: false }))
vi.mock('../agents/drivers', () => ({
  driverFor: () => ({
    id: 'a2a',
    capabilities: () => ({ commands: 'card', cwd: caps.cwd }),
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

/** Everything the driver was handed on the last turn that reached it. */
async function driverInput(): Promise<{ wireContent: string; messageId?: string }> {
  const input = streamToAgent.mock.calls.at(-1)![0] as {
    run: (io: { signal: AbortSignal; onEvent: () => void }) => Promise<unknown>
  }
  await input.run({ signal: new AbortController().signal, onEvent: vi.fn() })
  return (driverRun.mock.calls.at(-1) as unknown as [string, AgentRow, { wireContent: string; messageId?: string }])[2]
}

/** Which agent the turn was routed to. */
function routedTo(): string {
  return (streamToAgent.mock.calls.at(-1)![0] as { agentId: string }).agentId
}

/** The port the turn was actually handed — the inbox-observing wrapper, not the raw one. */
function portGivenToTheStream(): { postMessage: (msg: RunEvent) => void; close: () => void } {
  const call = streamToAgent.mock.calls.at(-1)![0]
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
})

beforeEach(() => {
  ipcOnHandlers.clear()
  vi.clearAllMocks()
  // `clearAllMocks` drops calls, not implementations — and one test below makes
  // this one throw. Without the reset it would throw for the rest of the file.
  reportRunCompletion.mockReset()
  openRunRequests.mockReturnValue([])
  runnerTask.mockReturnValue(undefined)
  lastId.mockReturnValue('m-last')
  lastAddressedAgentId.mockReturnValue(null)
  cursorGet.mockReturnValue(undefined)
  chatTask.mockReturnValue(undefined)
  handoverOfTask.mockReturnValue(undefined)
  caps.cwd = false
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

  it('binds an agentless coordinated chat to its default runtime', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    await send({ chatId: 'chat-1', content: 'hello', addressedAgentId: 'a-2' })
    expect(prepareLlmSend).not.toHaveBeenCalled()
    expect(routedTo()).toBe('a-runtime')
    expect(prepareAgentSend).toHaveBeenCalled()
  })

  it('runs a plain chat through its default runtime without an SDK model or provider', async () => {
    chatRow = { id: 'chat-1', router: 'direct', agentId: null, providerId: null, modelId: null }
    await send({ chatId: 'chat-1', content: 'hello' })
    expect(routedTo()).toBe('a-runtime')
    expect(prepareLlmSend).not.toHaveBeenCalled()
  })

  it('refuses a failed runtime binding instead of falling back to the retired SDK loop', async () => {
    chatRow = { id: 'chat-1', router: 'direct', agentId: null, providerId: 'legacy', modelId: 'legacy' }
    bindRuntime.mockImplementationOnce((_user, chat) => chat)
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'error', error: 'This conversation has no configured runtime.' })
    expect(reportRunCompletion).toHaveBeenCalledWith('chat-1', 'failed', 'This conversation has no configured runtime.')
    expect(prepareLlmSend).not.toHaveBeenCalled()
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

describe('a message the running turn takes in', () => {
  type SteerOutcome = 'injected' | 'late' | 'unavailable'
  /** Start a turn whose driver offers a steer the test resolves by hand. */
  async function steerableTurn(): Promise<{
    handle: ReturnType<typeof runExecutionService.start>
    resolveSteer: (outcome: SteerOutcome) => void
    close: () => void
  }> {
    let resolveSteer!: (outcome: SteerOutcome) => void
    driverRun.mockImplementationOnce((async (_owner: string, _agent: AgentRow, input: { registerSteer?: (steer: unknown) => void }) => {
      input.registerSteer?.(() => new Promise<SteerOutcome>((resolve) => { resolveSteer = resolve }))
      return { text: '', parts: [], notices: [] }
    }) as never)
    const handle = runExecutionService.start({ profileUserId: 'profile-user', settingsUserId: 'settings-user' },
      { chatId: 'chat-1', content: 'hello' }, { observe: vi.fn() })
    const turn = streamToAgent.mock.calls.at(-1)![0] as unknown as {
      run: (io: { signal: AbortSignal; onEvent: () => void }) => Promise<unknown>
      port: { close(): void }
    }
    await turn.run({ signal: new AbortController().signal, onEvent: vi.fn() })
    return { handle, resolveSteer: (outcome) => resolveSteer(outcome), close: () => turn.port.close() }
  }

  it('knows which agent the turn is for', async () => {
    const { handle } = await steerableTurn()
    expect(handle.agentId).toBe('a-1')
  })

  it('saves a message the engine took after the turn was saved, addressed to the turn’s agent', async () => {
    const { handle, resolveSteer, close } = await steerableTurn()
    const steered = handle.steer('and this')
    close()
    resolveSteer('late')
    expect(await steered).toBe('saved')
    expect(saveUser).toHaveBeenCalledWith({ chatId: 'chat-1', content: 'and this', addressedAgentId: 'a-1' })
  })

  it('answers run:start with a saved injection, and exactly one user row, when the engine takes the message after the turn stopped waiting', async () => {
    const { runQueueService } = await import('../services/runQueueService')
    const scope = { profileUserId: 'profile-user', settingsUserId: 'settings-user' }
    const { resolveSteer, close } = await steerableTurn()
    const submitted = runQueueService.submit(scope, { chatId: 'chat-1', content: 'and this' }, () => ({ observe: vi.fn() }))
    // The driver's grace ran out and the turn ended; only then does the engine confirm.
    close()
    resolveSteer('late')
    expect(await submitted).toEqual({ kind: 'injected', saved: true })
    expect(saveUser).toHaveBeenCalledTimes(1)
    expect(saveUser).toHaveBeenCalledWith({ chatId: 'chat-1', content: 'and this', addressedAgentId: 'a-1' })
    // Neither queued nor started again: that would be the message twice.
    expect(runQueueService.list(scope, 'chat-1').items).toEqual([])
    expect(streamToAgent).toHaveBeenCalledTimes(1)
  })

  it('leaves a message the turn kept to the turn', async () => {
    const { handle, resolveSteer, close } = await steerableTurn()
    const steered = handle.steer('and this')
    resolveSteer('injected')
    expect(await steered).toBe('injected')
    close()
    expect(saveUser).not.toHaveBeenCalled()
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

  it('gives a returning coordinator the specialist result its retained session missed', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: 'a-2' }
    history.unshift(message({ role: 'assistant', content: 'Earlier completed work', sourceAgentId: 'a-1' }))
    cursorGet.mockReturnValue({ lastMessageId: history[0].id })
    await send({ chatId: 'chat-1', content: 'Continue after handback.' })
    const wire = await wireContent()
    expect(routedTo()).toBe('a-2')
    expect(wire).toContain('[Research] Three files in invoices/.')
    expect(wire).not.toContain('Earlier completed work')
    expect(wire.endsWith('Continue after handback.')).toBe(true)
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
      const ended = input as { onFinished: (result: { state: 'completed'; text: string }) => void; port: { postMessage(event: RunEvent): void; close(): void } }
      ended.port.postMessage({ type: 'done' })
      ended.onFinished({ state: 'completed', text: 'saved' })
      ended.port.close()
      throw new Error('the stream blew up')
    })
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    expect(port.postMessage).toHaveBeenCalledTimes(1)
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'done' })
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('does not post over a runtime stream that already owns the port either', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    streamToAgent.mockImplementationOnce(async (input) => {
      const ended = input as { onFinished: (result: { state: 'completed'; text: string }) => void; port: { postMessage(event: RunEvent): void; close(): void } }
      ended.port.postMessage({ type: 'done' })
      ended.onFinished({ state: 'completed', text: 'saved' })
      ended.port.close()
      throw new Error('the stream blew up')
    })
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    expect(port.postMessage).toHaveBeenCalledTimes(1)
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'done' })
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
    expect(prepareLlmSend).not.toHaveBeenCalled()
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

  it('does not register the retired agent/model send channels', () => {
    expect(ipcOnHandlers.has('agent:send-message')).toBe(false)
    expect(ipcOnHandlers.has('llm:send-message')).toBe(false)
  })
})

/**
 * Every turn's events pass through the send path on their way to the renderer,
 * which is what makes this one hook enough to catch an ask from any driver, in
 * any router. What it must not do is get between the stream and the port.
 */
describe('run:send — the inbox tap', () => {
  it('refuses a chat whose handoff acknowledgement is unresolved before dispatching a provider', async () => {
    handoffPending.mockReturnValueOnce(true)
    const port = await send({ chatId: 'chat-1', content: 'Do this twice' })
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', error: expect.stringContaining('pending remote handoff') }))
    expect(streamToAgent).not.toHaveBeenCalled()
    expect(prepareLlmSend).not.toHaveBeenCalled()
  })

  it('mirrors an agent turn’s events into the inbox and still forwards them', async () => {
    const port = await send({ chatId: 'chat-1', content: 'hello' })
    portGivenToTheStream().postMessage(ASK)

    expect(recordRunEvent).toHaveBeenCalledWith(
      { userId: 'profile-user', chatId: 'chat-1', agentId: 'a-1', turnId: expect.any(String), rootRunId: expect.any(String), completionOwner: 'turn' },
      ASK
    )
    expect(port.postMessage).toHaveBeenCalledWith(ASK)
  })

  it('attributes a runtime conductor’s own asks to that runtime', async () => {
    // Root asks belong to the runtime. A child wrapper independently names a specialist.
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    await send({ chatId: 'chat-1', content: 'hello' })
    portGivenToTheStream().postMessage(ASK)

    expect(recordRunEvent).toHaveBeenCalledWith(
      { userId: 'profile-user', chatId: 'chat-1', agentId: 'a-runtime', turnId: expect.any(String), rootRunId: expect.any(String), completionOwner: 'turn' },
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

  it('keeps an early-returning runtime turn alive with no renderer until its stream closes', async () => {
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
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ turnId: handle.id, agentId: 'a-runtime' }), ASK)
    port.close()
    await handle.completed
    expect(runExecutionService.isRunning('chat-1')).toBe(false)
  })

  it('continues the asking agent in a coordinator chat without redirecting the answer to the conductor', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    const handle = runExecutionService.start(scope, payload, { observe: vi.fn(), agentId: 'a-2' })
    await handle.accepted
    expect(routedTo()).toBe('a-2')
    expect(prepareLlmSend).not.toHaveBeenCalled()
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

  it('observes an unexpected runtime setup failure even if the streaming service never closed', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    streamToAgent.mockRejectedValueOnce(new Error('setup failed'))
    const observer = vi.fn()
    const handle = runExecutionService.start(scope, payload, { observe: observer })
    await handle.accepted
    await handle.completed
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a-runtime' }), {
      type: 'error', error: 'setup failed'
    })
    expect(runExecutionService.isRunning('chat-1')).toBe(false)
    expect(reportRunCompletion).toHaveBeenCalledWith('chat-1', 'failed', 'setup failed')
    expect(recordChatResult).toHaveBeenCalledWith('chat-1', handle.id, 'failed')
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


describe('run:watch native subscription', () => {
  afterEach(() => { profileId = 'profile-user'; activated = true })
  function watchPort() {
    let onClose = (): void => {}
    const port = { start: vi.fn(), close: vi.fn(() => onClose()), postMessage: vi.fn(),
      on: vi.fn((_event: string, listener: () => void) => { onClose = listener }) }
    ipcOnHandlers.get('run:watch')?.({ ports: [port] }, 'chat-1')
    return port
  }
  it('attaches to a main-started run and native port closure leaves execution active', async () => {
    const handle = runExecutionService.start({ profileUserId: 'profile-user', settingsUserId: 'settings-user' },
      { chatId: 'chat-1', content: 'Continue' }, { observe: vi.fn() })
    await handle.accepted
    const source = portGivenToTheStream()
    source.postMessage({ type: 'delta', kind: 'text', text: 'before attach' })
    const port = watchPort()
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'snapshot', runId: handle.id,
      events: expect.arrayContaining([{ type: 'delta', kind: 'text', text: 'before attach' }]) }))
    port.close()
    port.postMessage.mockClear()
    source.postMessage({ type: 'delta', kind: 'text', text: 'after detach' })
    expect(port.postMessage).not.toHaveBeenCalled()
    expect(runExecutionService.isRunning('chat-1')).toBe(true)
    source.close()
    await handle.completed
  })
  it('revokes a watcher before delivery after a profile change', async () => {
    const port = watchPort()
    port.postMessage.mockClear()
    profileId = 'another-user'
    const handle = runExecutionService.start({ profileUserId: 'profile-user', settingsUserId: 'settings-user' },
      { chatId: 'chat-1', content: 'Continue' }, { observe: vi.fn() })
    await handle.accepted
    expect(port.close).toHaveBeenCalled()
    expect(port.postMessage).not.toHaveBeenCalled()
    portGivenToTheStream().close()
  })
  it('refuses an unauthenticated watch without exposing a snapshot', () => {
    activated = false
    const port = watchPort()
    expect(port.close).toHaveBeenCalled()
    expect(port.postMessage).not.toHaveBeenCalled()
  })
})


describe('the A2A messageId', () => {
  it('is the id of the user row the send stored', async () => {
    // Mutation: drop `messageId` from the driver input → a fresh nanoid goes
    // out, and the Cinna backend can neither deduplicate nor find the turn.
    prepareAgentSend.mockImplementationOnce((input) => ({ wireContent: input.userContent, userMessageId: 'user-row-1' }))
    await send({ chatId: 'chat-1', content: 'hello' })
    expect((await driverInput()).messageId).toBe('user-row-1')
  })

  it('is not sent for a runner turn, whose stored row is a system row', async () => {
    runnerTask.mockReturnValue({ id: 'task', chatId: 'chat-1', executor: 'desktop', executorDevice: null, status: 'in_progress' })
    prepareAgentSend.mockImplementationOnce((input) => ({ wireContent: input.userContent, userMessageId: 'system-row-1' }))
    const handle = runExecutionService.start(
      { profileUserId: 'profile-user', settingsUserId: 'settings-user' },
      { chatId: 'chat-1', content: 'Continue' },
      { observe: vi.fn(), runnerTaskId: 'task', inputOrigin: 'runner' }
    )
    await handle.accepted
    const input = await driverInput()
    expect(input).not.toHaveProperty('messageId')
    ;(streamToAgent.mock.calls.at(-1)![0] as unknown as { port: { close(): void } }).port.close()
  })
})

describe('the wire-only turn header', () => {
  it('tells a folder agent its chat, task and handover depth, and stores none of it', async () => {
    // A handover brief has to state `origin.chat`, `origin.task` and its own
    // `depth`, and none of the three can live in a system prompt: they change
    // per turn, and a chat id there would start one pooled Codex process per
    // chat. Mutation: drop the header and an agent asked to hand work on has
    // nothing to put in `origin`.
    caps.cwd = true
    chatTask.mockReturnValue({ id: 'task-9' })
    handoverOfTask.mockReturnValue({ depth: 1 })
    await send({ chatId: 'chat-1', content: 'hello' })
    const { wireContent } = await driverInput()
    expect(wireContent).toBe(
      [
        'Turn context from Cinna Desktop, not part of the conversation:',
        '- chat id: `chat-1`',
        '- task id: `task-9`',
        '- handover depth: 1',
        '',
        'hello'
      ].join('\n')
    )
    // **Never stored.** The row is written from the user's text alone, before
    // the header is ever built.
    expect(prepareAgentSend).toHaveBeenCalledWith(expect.objectContaining({ userContent: 'hello' }))
  })

  it('says none and zero for a chat with no task, and nothing at all to a remote agent', async () => {
    caps.cwd = true
    await send({ chatId: 'chat-1', content: 'hello' })
    expect((await driverInput()).wireContent).toContain('- task id: none\n- handover depth: 0')
    // The chat is busy until this turn's port closes; a second send on it would
    // be refused and read back as the first turn's own input.
    portGivenToTheStream().close()
    // A remote agent has no path on this disk to write a brief in, so the
    // header would be noise it cannot act on.
    caps.cwd = false
    await send({ chatId: 'chat-1', content: 'hello again' })
    expect((await driverInput()).wireContent).toBe('hello again')
  })

  it('goes in front of the catch-up packet, so the missed thread reads as one block', async () => {
    caps.cwd = true
    chatRow = { id: 'chat-1', router: 'human', agentId: null }
    attached = ['a-1', 'a-2']
    lastAddressedAgentId.mockReturnValue('a-1')
    history = [message({ role: 'assistant', content: 'earlier answer', sourceAgentId: 'a-2' })]
    await send({ chatId: 'chat-1', content: 'and now?' })
    const { wireContent } = await driverInput()
    expect(wireContent.indexOf('Turn context from Cinna Desktop')).toBe(0)
    expect(wireContent.indexOf('earlier answer')).toBeGreaterThan(0)
    expect(wireContent.endsWith('and now?')).toBe(true)
  })

  it('still runs the turn when the task lookup throws', async () => {
    caps.cwd = true
    chatTask.mockImplementation(() => {
      throw new Error('the database is locked')
    })
    await send({ chatId: 'chat-1', content: 'hello' })
    expect((await driverInput()).wireContent).toContain('- handover depth: 0')
    chatTask.mockReset()
  })
})

describe('inputOrigin: handover', () => {
  const scope = { profileUserId: 'profile-user', settingsUserId: 'settings-user' }

  it('needs no owning task runner, while a runner turn still does', async () => {
    // A handover's return packet is written into the chat that *asked* for the
    // work: it owns no task runner, so the runner guard would refuse every one
    // of them. Mutation: add `handover` to that guard and the return never
    // reaches the chat.
    const handle = runExecutionService.start(
      scope,
      { chatId: 'chat-1', content: 'Report from the uploader project' },
      { observe: vi.fn(), inputOrigin: 'handover' }
    )
    await handle.accepted
    expect(prepareAgentSend).toHaveBeenCalledWith(expect.objectContaining({ origin: 'handover' }))
    ;(streamToAgent.mock.calls.at(-1)![0] as unknown as { port: { close(): void } }).port.close()
    expect(() =>
      runExecutionService.start(scope, { chatId: 'chat-2', content: 'Continue' }, {
        observe: vi.fn(), inputOrigin: 'runner'
      })
    ).toThrow(/owning task runner/)
  })

  it('leaves the in-flight marker without a user message id', async () => {
    // The marker is what recovery offers to send again, and it is matched
    // against a **user** row. Mutation: name the system row here and the next
    // launch tells the user the app closed while *their* message was being
    // answered, about a report another project wrote.
    prepareAgentSend.mockImplementationOnce((input) => ({ wireContent: input.userContent, userMessageId: 'system-row-3' }))
    const handle = runExecutionService.start(
      scope,
      { chatId: 'chat-1', content: 'Report from the uploader project' },
      { observe: vi.fn(), inputOrigin: 'handover' }
    )
    await handle.accepted
    expect((streamToAgent.mock.calls.at(-1)![0] as { marker?: { userMessageId: string | null } }).marker)
      .toEqual({ profileId: 'profile-user', userMessageId: null, driver: 'a2a' })
    ;(streamToAgent.mock.calls.at(-1)![0] as unknown as { port: { close(): void } }).port.close()
  })

  it('sends no A2A messageId, because its stored row is a system row', async () => {
    prepareAgentSend.mockImplementationOnce((input) => ({ wireContent: input.userContent, userMessageId: 'system-row-2' }))
    const handle = runExecutionService.start(
      scope,
      { chatId: 'chat-1', content: 'Report from the uploader project' },
      { observe: vi.fn(), inputOrigin: 'handover' }
    )
    await handle.accepted
    expect(await driverInput()).not.toHaveProperty('messageId')
    ;(streamToAgent.mock.calls.at(-1)![0] as unknown as { port: { close(): void } }).port.close()
  })
})

describe('typed main turn completion', () => {
  const scope = { profileUserId: 'profile-user', settingsUserId: 'settings-user' }
  const payload = { chatId: 'chat-1', content: 'Continue' }
  function serviceInput() {
    return streamToAgent.mock.calls.at(-1)![0] as {
      onFinished: (outcome: { state: 'completed' | 'failed' | 'canceled'; text: string }) => void
      port: { postMessage(event: RunEvent): void; close(): void }
    }
  }
  it('waits for runtime persistence/close, returns final text, and reports exactly once', async () => {
    chatRow = { id: 'chat-1', router: 'coordinator', agentId: null }
    const handle = runExecutionService.start(scope, payload, { observe: vi.fn() })
    await handle.accepted
    const settled = vi.fn()
    void handle.completed.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    const input = serviceInput()
    input.onFinished({ state: 'completed', text: 'saved final answer' })
    expect(settled).not.toHaveBeenCalled()
    input.port.close()
    await expect(handle.completed).resolves.toEqual({ state: 'completed', text: 'saved final answer',
      accepted: true, runId: handle.id, inputRequestIds: [] })
    input.onFinished({ state: 'failed', text: '' })
    expect(reportRunCompletion).toHaveBeenCalledTimes(1)
    expect(reportRunCompletion).toHaveBeenCalledWith('chat-1', 'succeeded', undefined)
    expect(recordChatResult).toHaveBeenCalledWith('chat-1', handle.id, 'completed')
  })
  it('runner-owned completion leaves task/job finalization to its owner and returns remaining asks', async () => {
    runnerTask.mockReturnValue({ id: 'task', chatId: 'chat-1', executor: 'desktop', executorDevice: null, status: 'in_progress' })
    const observer = vi.fn()
    const handle = runExecutionService.start(scope, payload, { observe: observer, runnerTaskId: 'task' })
    await handle.accepted
    const input = serviceInput()
    input.port.postMessage({ type: 'done' })
    input.onFinished({ state: 'completed', text: 'waiting' })
    openRunRequests.mockReturnValue([{ id: 'durable-question', resume: 'next_message' }])
    input.port.close()
    await expect(handle.completed).resolves.toMatchObject({ state: 'needs_input', text: 'waiting', inputRequestIds: ['durable-question'] })
    expect(recordChatResult).not.toHaveBeenCalled()
    expect(reportRunCompletion).not.toHaveBeenCalled()
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ completionOwner: 'runner', rootRunId: handle.id, turnId: handle.id }), { type: 'done' })
  })
  it.each(['completed', 'cancelled', 'archived', 'error', 'open'])('refuses runner admission for %s tasks', (status) => {
    runnerTask.mockReturnValue({ id: 'task', chatId: 'chat-1', executor: 'desktop', executorDevice: null, status })
    expect(() => runExecutionService.start(scope, payload, { observe: vi.fn(), runnerTaskId: 'task' })).toThrow('does not own')
    expect(runExecutionService.isRunning('chat-1')).toBe(false)
  })
  it('records user interruption even if a driver reports completion after cancellation', async () => {
    const handle = runExecutionService.start(scope, payload, { observe: vi.fn() })
    await handle.accepted
    runExecutionService.cancelChat(scope.profileUserId, payload.chatId)
    const input = serviceInput()
    input.onFinished({ state: 'completed', text: 'partial result' })
    input.port.close()
    await handle.completed
    expect(recordChatResult).toHaveBeenCalledWith('chat-1', handle.id, 'canceled')
  })
  it.each([{ deletedAt: new Date() }, { executorDevice: 'another-device' }, { chatId: 'another-chat' }, { executor: 'remote' }])('refuses a deleted or foreign task claim %j', (override) => {
    runnerTask.mockReturnValue({ id: 'task', chatId: 'chat-1', executor: 'desktop', executorDevice: null, status: 'in_progress', ...override })
    expect(() => runExecutionService.start(scope, payload, { observe: vi.fn(), runnerTaskId: 'task' })).toThrow('does not own')
  })
  it('never invents success when a service closes without an outcome', async () => {
    const handle = runExecutionService.start(scope, payload, { observe: vi.fn() })
    await handle.accepted
    serviceInput().port.close()
    await expect(handle.completed).resolves.toMatchObject({ state: 'failed', error: { message: 'The turn closed without a terminal outcome.' } })
  })
  it.each(['read-failed', 'dead-reply'])('keeps execution success separate from unknown request bookkeeping: %s', async (problem) => {
    const observer = vi.fn()
    const handle = runExecutionService.start(scope, payload, { observe: observer })
    await handle.accepted
    const input = serviceInput()
    input.onFinished({ state: 'completed', text: 'saved' })
    if (problem === 'read-failed') openRunRequests.mockImplementationOnce(() => { throw new Error('DB busy') })
    else openRunRequests.mockReturnValueOnce([{ id: 'dead-ask', resume: 'reply' }])
    input.port.close()
    const result = await handle.completed
    expect(result).toMatchObject({ state: 'completed', text: 'saved', inputRequestIds: [] })
    expect(result.inputRequestReadError).toBeTruthy()
    expect(reportRunCompletion).toHaveBeenCalledWith('chat-1', 'succeeded', undefined)
    expect(observer).toHaveBeenCalledWith(expect.anything(), { type: 'done', stopReason: 'end_turn' })
  })
  it('releases execution even if status projection throws', async () => {
    reportRunCompletion.mockImplementation(() => { throw new Error('DB busy') })
    const handle = runExecutionService.start(scope, payload, { observe: vi.fn() })
    await handle.accepted
    const input = serviceInput()
    input.onFinished({ state: 'completed', text: 'saved' }); input.port.close()
    await expect(handle.completed).resolves.toMatchObject({ state: 'completed', text: 'saved' })
    expect(runExecutionService.isRunning('chat-1')).toBe(false)
  })
})
