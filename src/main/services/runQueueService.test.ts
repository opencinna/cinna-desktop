import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunHandle, RunOutcome } from './runExecutionService'
import type { RunSendPayload } from '../../shared/ipcPayloads'
import type { RunTarget } from '../../shared/chatRouting'

const start = vi.hoisted(() => vi.fn())
const answererOf = vi.hoisted(() => vi.fn((_chat?: unknown, _sent?: Pick<RunSendPayload, 'addressedAgentId'>): RunTarget => ({ kind: 'agent', agentId: 'agent-a' })))
const unresolvedHandoff = vi.hoisted(() => vi.fn(() => false))
const ownedChat = vi.hoisted(() => vi.fn((): unknown => ({ id: 'chat-1' })))
vi.mock('./runExecutionService', () => ({ runExecutionService: { start, answererOf } }))
vi.mock('../db/taskHandoffs', () => ({ taskHandoffRepo: { unresolvedForChat: unresolvedHandoff } }))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: ownedChat } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createRunQueueService, RUN_QUEUE_ATTACHMENTS_REFUSAL } = await import('./runQueueService')
const { activeRunsByChat } = await import('./runExecutionState')
const { taskRunnersByChat } = await import('./taskRunnerState')

const CHAT = 'chat-1'
const SCOPE = { profileUserId: 'user-1', settingsUserId: 'settings-1' }

interface FakeRun {
  handle: RunHandle
  steer: ReturnType<typeof vi.fn>
  end(state: RunOutcome['state']): void
}

let runs: FakeRun[] = []

function fakeRun(
  id: string,
  agentId: string | null = 'agent-a',
  steer: (content: string) => ReturnType<RunHandle['steer']> = async () => 'unavailable'
): FakeRun {
  let complete!: (outcome: RunOutcome) => void
  const steerFn = vi.fn(steer)
  const handle: RunHandle = {
    id,
    agentId,
    accepted: Promise.resolve(),
    completed: new Promise<RunOutcome>((resolve) => { complete = resolve }),
    cancel: vi.fn(),
    steer: steerFn
  }
  const run = {
    handle,
    steer: steerFn,
    end(state: RunOutcome['state']) {
      if (activeRunsByChat.get(CHAT) === handle) activeRunsByChat.delete(CHAT)
      complete({ state, text: '', runId: id, accepted: true, inputRequestIds: [] })
    }
  }
  runs.push(run)
  return run
}

/** A turn already running in the chat, started by someone else, answered by agent-a. */
function running(steer?: (content: string) => ReturnType<RunHandle['steer']>): FakeRun {
  const run = fakeRun('active', 'agent-a', steer)
  activeRunsByChat.set(CHAT, run.handle)
  return run
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const payload = (content: string, extra: Partial<RunSendPayload> = {}): RunSendPayload => ({ chatId: CHAT, content, ...extra })
const options = vi.fn((sent: RunSendPayload) => ({ observe: () => {}, sent }))

beforeEach(() => {
  runs = []
  activeRunsByChat.clear()
  taskRunnersByChat.clear()
  vi.clearAllMocks()
  unresolvedHandoff.mockReturnValue(false)
  ownedChat.mockReturnValue({ id: CHAT })
  answererOf.mockReturnValue({ kind: 'agent', agentId: 'agent-a' })
  start.mockImplementation((_scope, sent: RunSendPayload) => {
    const run = fakeRun(`started-${runs.length}`)
    activeRunsByChat.set(sent.chatId, run.handle)
    return run.handle
  })
})

describe('runQueueService.submit', () => {
  it('starts a turn when nothing is running', async () => {
    const service = createRunQueueService()
    const result = await service.submit(SCOPE, payload('hello'), options)
    expect(result).toEqual({ kind: 'started', runId: 'started-0' })
    expect(start).toHaveBeenCalledWith(SCOPE, payload('hello'), { observe: expect.any(Function), sent: payload('hello') })
    expect(service.list(SCOPE, CHAT)).toEqual({ items: [], held: false })
  })

  it('queues behind a running turn that cannot be steered', async () => {
    const service = createRunQueueService()
    const listener = vi.fn()
    service.onChange(listener)
    const active = running()
    const result = await service.submit(SCOPE, payload('also this'), options)
    expect(active.steer).toHaveBeenCalledWith('also this')
    expect(result).toEqual({ kind: 'queued', queuedId: expect.any(String) })
    expect(start).not.toHaveBeenCalled()
    expect(service.list(SCOPE, CHAT)).toEqual({
      items: [{ id: (result as { queuedId: string }).queuedId, content: 'also this', createdAt: expect.any(Number) }],
      held: false
    })
    expect(listener).toHaveBeenCalledWith(CHAT, service.list(SCOPE, CHAT))
  })

  it('hands the message to a turn that takes it mid-flight, and queues nothing', async () => {
    const service = createRunQueueService()
    running(async () => 'injected')
    expect(await service.submit(SCOPE, payload('steer'), options)).toEqual({ kind: 'injected' })
    expect(answererOf).toHaveBeenCalledWith({ id: CHAT }, payload('steer'))
    expect(service.list(SCOPE, CHAT).items).toEqual([])
  })

  it('says so when the turn could only save the message as a row of its own, and queues nothing', async () => {
    const service = createRunQueueService()
    running(async () => 'saved')
    expect(await service.submit(SCOPE, payload('late steer'), options)).toEqual({ kind: 'injected', saved: true })
    expect(service.list(SCOPE, CHAT).items).toEqual([])
    expect(start).not.toHaveBeenCalled()
  })

  it('never steers a message that would go to another agent than the running turn’s', async () => {
    const service = createRunQueueService()
    const active = running(async () => 'injected')
    answererOf.mockReturnValue({ kind: 'agent', agentId: 'agent-b' })
    const result = await service.submit(SCOPE, payload('for b', { addressedAgentId: 'agent-b' }), options)
    expect(active.steer).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'queued', queuedId: expect.any(String) })
  })

  it('does not steer past a message already queued, so the order the user sent in holds', async () => {
    const service = createRunQueueService()
    let takes = false
    const active = running(async () => (takes ? 'injected' : 'unavailable'))
    await service.submit(SCOPE, payload('first'), options)
    takes = true
    expect(await service.submit(SCOPE, payload('second'), options)).toEqual({ kind: 'queued', queuedId: expect.any(String) })
    expect(active.steer).toHaveBeenCalledTimes(1)
    expect(service.list(SCOPE, CHAT).items.map((item) => item.content)).toEqual(['first', 'second'])
  })

  it.each(['completed', 'needs_input'] as const)('sends the messages for one agent as one start when the turn ends %s', async (state) => {
    const service = createRunQueueService()
    const active = running()
    await service.submit(SCOPE, payload('first', { addressedAgentId: 'agent-a' }), options)
    await service.submit(SCOPE, payload('second', { addressedAgentId: 'agent-a' }), options)
    active.end(state)
    await flush()
    const merged = { chatId: CHAT, content: 'first\n\nsecond', addressedAgentId: 'agent-a' }
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith(SCOPE, merged, { observe: expect.any(Function), sent: merged })
    expect(options).toHaveBeenLastCalledWith(merged)
    expect(service.list(SCOPE, CHAT)).toEqual({ items: [], held: false })
  })

  it('sends each run of messages to the agent it was addressed to, one turn after another', async () => {
    const service = createRunQueueService()
    answererOf.mockImplementation((_chat, sent) => ({ kind: 'agent', agentId: sent?.addressedAgentId ?? 'agent-a' }))
    const active = running()
    for (const [content, address] of [['a1', 'agent-a'], ['a2', 'agent-a'], ['b1', 'agent-b'], ['a3', 'agent-a']]) {
      await service.submit(SCOPE, payload(content, { addressedAgentId: address }), options)
    }
    active.end('completed')
    await flush()
    expect(start.mock.calls.map((call) => call[1])).toEqual([{ chatId: CHAT, content: 'a1\n\na2', addressedAgentId: 'agent-a' }])
    expect(service.list(SCOPE, CHAT).items.map((item) => item.content)).toEqual(['b1', 'a3'])

    runs.at(-1)!.end('completed')
    await flush()
    runs.at(-1)!.end('completed')
    await flush()
    expect(start.mock.calls.map((call) => [call[1].content, call[1].addressedAgentId])).toEqual([
      ['a1\n\na2', 'agent-a'], ['b1', 'agent-b'], ['a3', 'agent-a']
    ])
    expect(service.list(SCOPE, CHAT).items).toEqual([])
  })

  it('sends an unaddressed message to the agent it would have gone to when it was queued', async () => {
    const service = createRunQueueService()
    // The human rule: the agent the message addresses, else the one the last user row did.
    let lastAddressed = 'agent-a'
    answererOf.mockImplementation((_chat, sent) => ({ kind: 'agent', agentId: sent?.addressedAgentId ?? lastAddressed }))
    const answered: string[] = []
    start.mockImplementation((_scope, sent: RunSendPayload) => {
      // `start` resolves the answerer again, and the user row it saves addresses that agent.
      const target = answererOf(undefined, sent)
      const agentId = target.kind === 'agent' ? target.agentId : lastAddressed
      answered.push(agentId)
      lastAddressed = agentId
      const run = fakeRun(`started-${runs.length}`, agentId)
      activeRunsByChat.set(sent.chatId, run.handle)
      return run.handle
    })
    const active = running()
    await service.submit(SCOPE, payload('first'), options)
    await service.submit(SCOPE, payload('for b', { addressedAgentId: 'agent-b' }), options)
    await service.submit(SCOPE, payload('again'), options)
    active.end('completed')
    await flush()
    runs.at(-1)!.end('completed')
    await flush()
    runs.at(-1)!.end('completed')
    await flush()
    expect(start.mock.calls.map((call) => call[1].content)).toEqual(['first', 'for b', 'again'])
    expect(answered).toEqual(['agent-a', 'agent-b', 'agent-a'])
  })

  it.each(['canceled', 'failed', 'budget'] as const)('holds the queue and sends nothing when the turn ends %s', async (state) => {
    const service = createRunQueueService()
    const active = running()
    await service.submit(SCOPE, payload('wait'), options)
    active.end(state)
    await flush()
    expect(start).not.toHaveBeenCalled()
    expect(service.list(SCOPE, CHAT)).toMatchObject({ items: [{ content: 'wait' }], held: true })
  })

  it('holds the items when the drained start is refused', async () => {
    const service = createRunQueueService()
    const active = running()
    await service.submit(SCOPE, payload('wait'), options)
    start.mockImplementationOnce(() => { throw new Error('Chat not found') })
    active.end('completed')
    await flush()
    expect(service.list(SCOPE, CHAT)).toMatchObject({ items: [{ content: 'wait' }], held: true })
  })

  it('sends at once when the turn ended while the steer was being asked', async () => {
    const service = createRunQueueService()
    const active = running(async () => {
      active.end('completed')
      await flush()
      return 'unavailable'
    })
    const result = await service.submit(SCOPE, payload('late'), options)
    expect(result).toEqual({ kind: 'queued', queuedId: expect.any(String) })
    expect(start).toHaveBeenCalledWith(SCOPE, { chatId: CHAT, content: 'late', addressedAgentId: 'agent-a' }, expect.anything())
    expect(service.list(SCOPE, CHAT).items).toEqual([])
  })

  it('lets start refuse a chat an autonomous task owns, without steering or queueing', async () => {
    const service = createRunQueueService()
    const active = running()
    taskRunnersByChat.set(CHAT, { userId: 'user-1', taskId: 'task-1', id: 'r', working: true, cancel: () => {} })
    start.mockImplementationOnce(() => {
      throw new Error('This conversation belongs to an autonomous task. Answer in the Inbox or use the task controls.')
    })
    await expect(service.submit(SCOPE, payload('hi'), options)).rejects.toThrow('belongs to an autonomous task')
    expect(active.steer).not.toHaveBeenCalled()
    expect(service.list(SCOPE, CHAT).items).toEqual([])
  })

  it('refuses files while a turn runs', async () => {
    const service = createRunQueueService()
    const active = running()
    const attachments = [{ id: 'f1', source: 'cinna' }] as unknown as RunSendPayload['attachments']
    await expect(service.submit(SCOPE, payload('see file', { attachments }), options)).rejects.toThrow(RUN_QUEUE_ATTACHMENTS_REFUSAL)
    expect(active.steer).not.toHaveBeenCalled()
    expect(service.list(SCOPE, CHAT).items).toEqual([])
  })

  it('refuses a chat the profile does not own', async () => {
    const service = createRunQueueService()
    running()
    ownedChat.mockReturnValueOnce(undefined)
    await expect(service.submit(SCOPE, payload('hi'), options)).rejects.toThrow('Chat not found')
  })
})

describe('runQueueService take, remove, edit and clear', () => {
  it('take returns the texts in order and clears the queue, held or not', async () => {
    const service = createRunQueueService()
    const active = running()
    await service.submit(SCOPE, payload('one'), options)
    await service.submit(SCOPE, payload('two'), options)
    active.end('canceled')
    await flush()
    expect(service.take(SCOPE, CHAT)).toEqual(['one', 'two'])
    expect(service.list(SCOPE, CHAT)).toEqual({ items: [], held: false })
    expect(service.take(SCOPE, CHAT)).toEqual([])
  })

  it('remove drops one message and the rest still send', async () => {
    const service = createRunQueueService()
    const active = running()
    const first = await service.submit(SCOPE, payload('one'), options) as { queuedId: string }
    await service.submit(SCOPE, payload('two'), options)
    expect(service.remove(SCOPE, CHAT, first.queuedId)).toBe(true)
    expect(service.remove(SCOPE, CHAT, first.queuedId)).toBe(false)
    active.end('completed')
    await flush()
    expect(start).toHaveBeenCalledWith(SCOPE, { chatId: CHAT, content: 'two', addressedAgentId: 'agent-a' }, expect.anything())
  })

  it('edit replaces a queued message’s text and tells the renderer', async () => {
    const service = createRunQueueService()
    const listener = vi.fn()
    const active = running()
    const queued = await service.submit(SCOPE, payload('draft'), options) as { queuedId: string }
    service.onChange(listener)
    expect(service.edit(SCOPE, CHAT, queued.queuedId, 'final')).toBe(true)
    expect(listener).toHaveBeenCalledWith(CHAT, {
      items: [{ id: queued.queuedId, content: 'final', createdAt: expect.any(Number) }],
      held: false
    })
    expect(service.list(SCOPE, CHAT).items.map((item) => item.content)).toEqual(['final'])
    active.end('completed')
    await flush()
    expect(start).toHaveBeenCalledWith(SCOPE, { chatId: CHAT, content: 'final', addressedAgentId: 'agent-a' }, expect.anything())
  })

  it('edit answers false for a message that is no longer queued, and refuses empty text', async () => {
    const service = createRunQueueService()
    const active = running()
    const queued = await service.submit(SCOPE, payload('draft'), options) as { queuedId: string }
    expect(() => service.edit(SCOPE, CHAT, queued.queuedId, '  ')).toThrow('cannot be empty')
    active.end('completed')
    await flush()
    expect(service.edit(SCOPE, CHAT, queued.queuedId, 'too late')).toBe(false)
    expect(start).toHaveBeenCalledWith(SCOPE, { chatId: CHAT, content: 'draft', addressedAgentId: 'agent-a' }, expect.anything())
  })

  it('clear forgets a chat’s queue', async () => {
    const service = createRunQueueService()
    const active = running()
    await service.submit(SCOPE, payload('one'), options)
    service.clear(SCOPE.profileUserId, CHAT)
    expect(service.list(SCOPE, CHAT)).toEqual({ items: [], held: false })
    active.end('completed')
    await flush()
    expect(start).not.toHaveBeenCalled()
  })

  it('is cleared when the chat or the profile is removed', async () => {
    const { taskRunnerBridge } = await import('./taskRunnerBridge')
    const { runQueueService } = await import('./runQueueService')
    running()
    await runQueueService.submit(SCOPE, payload('one'), options)
    taskRunnerBridge.chatRemoved(SCOPE.profileUserId, CHAT)
    expect(runQueueService.list(SCOPE, CHAT).items).toEqual([])
    await runQueueService.submit(SCOPE, payload('two'), options)
    taskRunnerBridge.profileRemoved(SCOPE.profileUserId)
    expect(runQueueService.list(SCOPE, CHAT).items).toEqual([])
  })

  it('keeps one profile’s queue apart from another’s', async () => {
    const service = createRunQueueService()
    running()
    await service.submit(SCOPE, payload('mine'), options)
    expect(service.list({ profileUserId: 'user-2', settingsUserId: 's' }, CHAT).items).toEqual([])
  })
})
