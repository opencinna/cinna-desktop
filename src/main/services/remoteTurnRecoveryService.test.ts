import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { AgentRow } from '../db/agents'
import type { Frame, Reply, RecordedRequest } from '../agents/drivers/__golden__/a2a/fakeAgent'
import type { RunWatchMessage } from '../../shared/runWatch'

/**
 * Relaunch recovery of A2A turns the app was closed under, against a real
 * database and the golden fake A2A server (`fetch` level): the marker a kill
 * left is taken once the profile is ready, the turn shows as a running one
 * while the agent is asked how it ended, and the agent's record replaces what
 * the kill left — or the send, if it never arrived, goes out again.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const auth = vi.hoisted(() => ({ reauth: false, tokens: 0 }))

vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
vi.mock('../auth/scope', () => ({
  getSettingsScopeUserId: () => '__default__',
  getProfileScopeUserId: () => '__default__',
  getAgentLookupScope: () => ['__default__']
}))
vi.mock('../index', () => ({ getMainWindow: () => null }))
vi.mock('./cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('./syncService', () => ({ syncService: { markDirty: () => undefined } }))
vi.mock('./chatTitleService', () => ({ chatTitleService: { autoGenerateForFirstMessage: async () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('./localAgents/commandService', () => ({
  resolveCommandRunner: (_c: unknown, _w: unknown, _o: unknown, _a: unknown, fallback: unknown) => fallback
}))

class ReauthRequired extends Error {}

const AGENT = 'remote:agent-1'
const agentRow = {
  id: AGENT, userId: '__default__', name: 'Research', protocol: 'a2a', source: 'remote', driver: 'a2a',
  cardUrl: 'https://agent.test/a2a', endpointUrl: 'https://agent.test/a2a/', protocolInterfaceUrl: null,
  accessTokenEncrypted: null, driverConfig: null
} as unknown as AgentRow
const agentPresent = vi.hoisted(() => ({ value: true }))
vi.mock('./agentService', () => ({
  agentService: {
    findAgent: (_s: string, _p: string, id: string) => (agentPresent.value && id === 'remote:agent-1' ? { row: agentRow, userId: '__default__' } : null),
    listMerged: () => [agentRow]
  }
}))

const deps = {
  resolveEndpoint: async (_user: string, agent: AgentRow) => agent.endpointUrl,
  resolveAccessToken: async () => {
    if (auth.reauth) throw new ReauthRequired('No Cinna tokens stored')
    auth.tokens++
    return 'jwt-1'
  },
  isReauthRequired: (err: unknown) => err instanceof ReauthRequired
}
vi.mock('../agents/drivers', async () => {
  const { createA2aDriver } = await import('../agents/drivers/a2aDriver')
  const { runAgentTurn } = await import('./a2aStreamingService')
  const { fetchAgentCard } = await import('../agents/a2a-client')
  const driver = createA2aDriver({
    runTurn: runAgentTurn,
    resolveEndpoint: async (_user, agent) => agent.endpointUrl,
    resolveAccessToken: async () => 'jwt-1',
    fetchCard: (url, token) => fetchAgentCard(url, token),
    isReauthRequired: () => false
  })
  return { driverFor: () => driver }
})

const { fakeA2aAgent } = await import('../agents/drivers/__golden__/a2a/fakeAgent')
const { remoteTurnRecoveryService, registerRecoverer, STILL_RUNNING_NOTICE, CUT_OFF_NOTICE, TASK_FAILED_MESSAGE, RECOVERY_RETRY_MS } =
  await import('./remoteTurnRecoveryService')
const { createA2aTurnRecoverer } = await import('../agents/drivers/a2aTurnRecoverer')
const { interruptedTurnService, isRecoverable, INTERRUPTED_TURN_NOTICE } = await import('./interruptedTurnService')
const { collectPollDelays } = await import('../agents/a2aTaskCollect')
const { RECOVERY_GIVE_UP_MS } = await import('./remoteTurnRecoveryService')
const { a2aStreamingService } = await import('./a2aStreamingService')
const { taskRepo } = await import('../db/tasks')
const { inflightTurnRepo, isLiveMarker } = await import('../db/inflightTurns')
const { chatRepo } = await import('../db/chats')
const { messageRepo } = await import('../db/messages')
const { agentSessionRepo } = await import('../db/agents')
const { chatRunResultRepo } = await import('../db/chatRunResults')
const { chatAgentCursorRepo } = await import('../db/chatAgentCursors')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { liveRunHub } = await import('./liveRunHub')
const { activeRunsByChat } = await import('./runExecutionState')
const { runExecutionService } = await import('./runExecutionService')
const { runQueueService } = await import('./runQueueService')
const { inboxService } = await import('./inboxService')

registerRecoverer('a2a', createA2aTurnRecoverer(deps))

const USER = '__default__'
const TASK = 'task-1'
const savedDelays = { ...collectPollDelays }

const CARD: Reply = {
  status: 200,
  json: {
    name: 'Research', description: 'fake', version: '1.0.0', protocolVersion: '0.3.0',
    capabilities: { streaming: true }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: []
  }
}

let chatId = ''

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.prepare("INSERT INTO agents (id, user_id, name, protocol, source, created_at) VALUES (?, ?, 'Research', 'a2a', 'remote', 0)").run(AGENT, USER)
  chatId = chatRepo.create(USER).id
  // A direct chat with the agent: a send is routed to it.
  holder.current.raw.prepare('UPDATE chats SET agent_id = ? WHERE id = ?').run(AGENT, chatId)
  auth.reauth = false
  auth.tokens = 0
  agentPresent.value = true
  Object.assign(collectPollDelays, { fastMs: 5, slowMs: 5 })
})

afterEach(() => {
  Object.assign(collectPollDelays, savedDelays)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  holder.current?.close()
  holder.current = null
})

/** What a kill leaves: the user row, what the quit flush saved, the draft, and the marker. */
function killedTurn(options: { flush?: boolean; draft?: boolean; session?: boolean } = {}): { userMessageId: string; markerId: string } {
  const userMessageId = messageRepo.saveUser({ chatId, content: 'Find the bug', addressedAgentId: AGENT })
  const markerId = `req-${chatId}`
  inflightTurnRepo.open({ id: markerId, profileId: USER, chatId, agentId: AGENT, driver: 'a2a', userMessageId })
  if (options.flush !== false) {
    messageRepo.saveTransition({ chatId, content: 'Environment starting', sourceAgentId: AGENT })
    messageRepo.saveAssistant({ chatId, content: 'Half an', parts: [{ kind: 'text', text: 'Half an' }], sourceAgentId: AGENT })
  }
  if (options.draft) {
    inflightTurnRepo.writeDraft({ markerId, draftId: null, chatId, agentId: AGENT, content: ' answer', parts: [{ kind: 'text', text: ' answer' }] })
  }
  if (options.session !== false) {
    agentSessionRepo.upsert({ chatId, agentId: AGENT, contextId: TASK, taskId: TASK, taskState: null })
  }
  return { userMessageId, markerId }
}

const userMessage = (clientMessageId: string) => ({
  kind: 'message', role: 'user', messageId: 'srv-user', parts: [{ kind: 'text', text: 'Find the bug' }],
  metadata: { 'cinna.client_message_id': clientMessageId }
})
const agentMessage = (text: string, state = 'complete') => ({
  kind: 'message', role: 'agent', messageId: `srv-${text.length}`,
  parts: [{ kind: 'text', text, metadata: { 'cinna.content_kind': 'text' } }],
  metadata: { 'cinna.message_state': state }
})
const noticeMessage = (text: string) => ({
  kind: 'message', role: 'agent', messageId: 'srv-notice',
  parts: [{ kind: 'text', text, metadata: { 'cinna.content_kind': 'notice' } }],
  metadata: { 'cinna.message_state': 'complete' }
})
const task = (state: string, history: unknown[]): Frame => ({
  result: { kind: 'task', id: TASK, contextId: TASK, status: { state }, history }
})

/**
 * The fake agent. A `gate` holds the `tasks/get` call of that number (1-based)
 * of task {@link TASK} until released, or until the request's signal aborts.
 * `gets` answers the `tasks/get` call of that number (counted per task) with a
 * 401, a gateway's 502 or a dropped connection instead.
 */
type GetFailure = 'drop' | 401 | 502

function server(http: { tasksGet?: Frame[]; rpc?: Reply; cancel?: Frame; card?: Reply; firstGet?: GetFailure },
  gateAt?: number, gets: Record<number, GetFailure> | ((call: number, taskId: string) => GetFailure | undefined) = {}) {
  const agent = fakeA2aAgent({ recorded_from: 'test', description: '', input: {} as never, http: { card: CARD, ...http } })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let reached!: () => void
  const atGate = new Promise<void>((resolve) => { reached = resolve })
  const calls = new Map<string, number>()
  const special = typeof gets === 'function' ? gets : (call: number) => gets[call]
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string; params?: { id?: string } } : undefined
    const taskId = body?.params?.id ?? ''
    // Counted per task: the gate and `firstGet` are about the main task's reads.
    const call = body?.method === 'tasks/get' ? (calls.get(taskId) ?? 0) + 1 : 0
    if (call) calls.set(taskId, call)
    if (call && call === gateAt && taskId === TASK) {
      reached()
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve)
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
    }
    const answer = body?.method === 'tasks/get'
      ? (call === 1 && taskId === TASK && http.firstGet) || special(call, taskId)
      : undefined
    if (answer) {
      agent.requests.push({ method: 'POST', url: String(input), authorization: null, signal: false, body })
      if (answer === 401) return new Response(null, { status: 401, statusText: 'Unauthorized' })
      if (answer === 502) return new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    }
    return agent.fetch(input, init)
  }) as typeof globalThis.fetch
  vi.stubGlobal('fetch', fetch)
  const rpc = (method: string): RecordedRequest[] => agent.requests.filter((request) => request.body?.method === method)
  return { requests: agent.requests, rpc, release, atGate, agent }
}

function watch(): RunWatchMessage[] {
  const seen: RunWatchMessage[] = []
  liveRunHub.watch(USER, chatId, (message) => { seen.push(message) })
  return seen
}

/** The session row's ids and state, as a relaunch would read them. */
const sessionOf = () => {
  const row = agentSessionRepo.getByChatAndAgent(chatId, AGENT)
  return row && { contextId: row.contextId, taskId: row.taskId, taskState: row.taskState }
}

const transcript = (): [string, string][] =>
  chatRepo.listMessages(chatId).map((row) => [row.role, row.role === 'error' ? JSON.parse(row.content).short : row.content])

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

describe('a turn still running on the agent', () => {
  it('shows as a running turn with a live notice, then replaces the killed rows with the agent’s', async () => {
    const { userMessageId, markerId } = killedTurn({ draft: true })
    const agent = server({
      tasksGet: [
        task('working', [userMessage(userMessageId), agentMessage('Half an answer', 'streaming')]),
        task('completed', [userMessage(userMessageId), noticeMessage('Environment starting'), agentMessage('Half an answer, now whole.')])
      ]
    }, 2)
    const seen = watch()

    const done = remoteTurnRecoveryService.resume(USER)
    await agent.atGate

    expect(activeRunsByChat.get(chatId)?.id).toBe(markerId)
    expect(runExecutionService.isRunning(chatId)).toBe(true)
    const snapshot = seen.find((m) => m.type === 'snapshot' && m.active && m.runId === markerId)
    // A polled turn has no live replay: what the kill left stays in view
    // under the notice until the rows are swapped.
    // Mutation: hide the turn's rows for every recoverer → only the user row.
    expect(snapshot?.type === 'snapshot' && snapshot.baselineMessageIds).toEqual(chatRepo.listMessageIds(chatId))
    expect(snapshot?.type === 'snapshot' && snapshot.baselineMessageIds).toHaveLength(4)
    const notices = seen.flatMap((m) => m.type === 'event' && m.event.type === 'delta' && m.event.kind === 'notice' ? [m.event.text] : [])
    expect(notices).toEqual([STILL_RUNNING_NOTICE])
    // Until the agent answers, the transcript is what the kill left.
    expect(transcript().map(([role]) => role)).toEqual(['user', 'agent_transition', 'assistant', 'assistant'])

    agent.release()
    await done

    // Mutation: skip `replaceTurnRows` in `applyCollected` → the flush rows
    // and the draft stay beside the collected turn, which is never written.
    expect(transcript()).toEqual([
      ['user', 'Find the bug'],
      ['agent_transition', 'Environment starting'],
      ['assistant', 'Half an answer, now whole.']
    ])
    expect(inflightTurnRepo.list()).toEqual([])
    expect(activeRunsByChat.has(chatId)).toBe(false)
    expect(seen.at(-1)).toMatchObject({ type: 'closed', runId: markerId })
    expect(seen.some((m) => m.type === 'event' && m.event.type === 'done')).toBe(true)
    expect(chatRunResultRepo.get(USER, chatId)).toMatchObject({ runId: markerId, status: 'completed' })
    expect(chatAgentCursorRepo.get(chatId, AGENT)?.lastMessageId).toBe(chatRepo.listMessages(chatId).at(-1)!.id)
  })
})

describe('a turn that already finished', () => {
  it('is replaced without a “still running” notice', async () => {
    const { userMessageId } = killedTurn()
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Found it.')])] })
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Found it.']])
    expect(seen.some((m) => m.type === 'event' && m.event.type === 'delta')).toBe(false)
  })

  it.each([
    ['completed', 'completed'],
    ['input-required', 'input-required'],
    ['failed', 'failed']
  ])('saves the collected state %s on the session, keeping its ids', async (taskState, saved) => {
    // Mutation: drop `onSettled` in `applyCollected` (or in `collectedResult`)
    // → the session's task state stays null after recovery.
    const { userMessageId } = killedTurn()
    server({ tasksGet: [task(taskState, [userMessage(userMessageId), agentMessage('Found it.')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(sessionOf()).toEqual({ contextId: TASK, taskId: TASK, taskState: saved })
  })

  it('saves a reply cut off under a completed task as aborted, as a live turn does', async () => {
    const { userMessageId } = killedTurn()
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Cut', 'aborted')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(sessionOf()?.taskState).toBe('aborted')
  })

  it('keeps a row sent after the turn below the recovered reply, and leaves the later turn’s bookkeeping alone', async () => {
    const { userMessageId } = killedTurn()
    const later = messageRepo.saveUser({ chatId, content: 'Any news?', addressedAgentId: AGENT })
    chatAgentCursorRepo.advance(chatId, AGENT, later)
    chatRunResultRepo.record(chatId, 'later-run', 'completed')
    server({ tasksGet: [task('input-required', [userMessage(userMessageId), agentMessage('Which branch?')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Which branch?'], ['user', 'Any news?']])
    // Mutation: drop the `superseded` checks → the old turn's result, ask and
    // cursor overwrite the later turn's.
    expect(chatRunResultRepo.get(USER, chatId)).toMatchObject({ runId: 'later-run', status: 'completed' })
    expect(chatAgentCursorRepo.get(chatId, AGENT)?.lastMessageId).toBe(later)
    expect(taskInputRequestRepo.listOpenForChat(chatId)).toEqual([])
    expect(inflightTurnRepo.list()).toEqual([])
    // The session's state is the later turn's too.
    expect(sessionOf()?.taskState).toBeNull()
  })

  it('moves the cursor to the recovered turn’s last row, not the chat’s', async () => {
    const { userMessageId } = killedTurn()
    messageRepo.saveError({ chatId, short: 'Something else failed' })
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Found it.')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Found it.'], ['error', 'Something else failed']])
    expect(chatAgentCursorRepo.get(chatId, AGENT)?.lastMessageId).toBe(chatRepo.listMessages(chatId)[1].id)
  })

  it('settles the turn as interrupted when its user row is gone before the rows are swapped', async () => {
    const { userMessageId } = killedTurn()
    const agent = server({
      tasksGet: [task('working', [userMessage(userMessageId)]), task('completed', [userMessage(userMessageId), agentMessage('Found it.')])]
    }, 2)

    const done = remoteTurnRecoveryService.resume(USER)
    await agent.atGate
    messageRepo.deleteById(userMessageId)
    agent.release()
    await done

    // Mutation: rethrow `TurnUserRowGone` in `applyCollected` → the marker
    // stays and every later pass fails on it again.
    expect(inflightTurnRepo.list()).toEqual([])
    expect(transcript().at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
    expect(activeRunsByChat.has(chatId)).toBe(false)
  })

  it('saves a cut-off reply’s ending as an error card, even under a failed task', async () => {
    const { userMessageId } = killedTurn({ flush: false })
    server({ tasksGet: [task('failed', [userMessage(userMessageId), agentMessage('Tried', 'aborted')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Tried'], ['error', CUT_OFF_NOTICE]])
    expect(JSON.parse(chatRepo.listMessages(chatId)[2].content)).toMatchObject({
      short: 'The agent’s reply was cut off before it finished. Send your message again to retry.',
      code: 'reply_cut_off'
    })
  })

  it('does not move the chat up the list when it writes the collected turn (a Stop writes through the same path)', async () => {
    const { userMessageId } = killedTurn()
    const past = new Date(Date.now() - 60 * 60_000)
    holder.current!.raw.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Math.floor(past.getTime() / 1000), chatId)
    const before = chatRepo.getOwned(USER, chatId)!.updatedAt
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Found it.')])] })

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: `touchChat` in `applyCollected` → the chat jumps to the top.
    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Found it.']])
    expect(chatRepo.getOwned(USER, chatId)!.updatedAt).toEqual(before)
  })

  it('marks a reply the agent reports cut off as failed, whatever the task says', async () => {
    const { userMessageId } = killedTurn({ flush: false })
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Half', 'aborted')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['assistant', 'Half'], ['error', CUT_OFF_NOTICE]
    ])
    // Mutation: report an aborted reply under a completed task as completed
    // → the sidebar shows a success.
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
  })

  it('puts an error row under a turn whose task failed, and records it failed', async () => {
    const { userMessageId } = killedTurn()
    // Richer than the rows the kill left: a failed turn's copy is weighed.
    server({ tasksGet: [task('failed', [userMessage(userMessageId), agentMessage('Tried hard')])] })
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['assistant', 'Tried hard'], ['error', TASK_FAILED_MESSAGE]
    ])
    expect(JSON.parse(chatRepo.listMessages(chatId)[2].content)).toEqual({
      short: 'The agent reported that its task failed. Send your message again to retry.',
      detail: 'The agent’s task ended as failed.'
    })
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
    expect(seen.some((m) => m.type === 'event' && m.event.type === 'error')).toBe(true)
  })

  it('opens the next-message ask of a turn that ended asking', async () => {
    const { userMessageId } = killedTurn()
    server({ tasksGet: [task('input-required', [userMessage(userMessageId), agentMessage('Which branch?')])] })
    const observe = vi.spyOn(inboxService, 'recordRunEvent')

    await remoteTurnRecoveryService.resume(USER)

    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ chatId, agentId: AGENT }),
      expect.objectContaining({ type: 'needs_input', requestId: TASK, resume: 'next_message' }))
    const asks = taskInputRequestRepo.listOpenForChat(chatId)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ agentId: AGENT, resume: 'next_message' })
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('needs_input')
    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Which branch?']])
  })
})

describe('a turn the agent has no reply for', () => {
  it.each([
    ['what the quit flush saved', { flush: true }, [['agent_transition', 'Environment starting'], ['assistant', 'Half an']]],
    ['the draft', { flush: false, draft: true }, [['assistant', ' answer']]]
  ])('keeps %s and ends cut off when the server lost the reply', async (_label, left, kept) => {
    // The backend crashed; its orphan repair ended the turn `completed`
    // without writing the agent's row. Mutation: drop the no-reply branch in
    // `collectedResult` → the kept rows are replaced with nothing and the
    // turn reads completed.
    const { userMessageId } = killedTurn(left)
    server({ tasksGet: [task('completed', [userMessage(userMessageId)])] })
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ...kept, ['error', CUT_OFF_NOTICE]])
    expect(JSON.parse(chatRepo.listMessages(chatId).at(-1)!.content)).toEqual({ short: CUT_OFF_NOTICE, code: 'reply_cut_off' })
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
    expect(sessionOf()?.taskState).toBe('aborted')
    expect(inflightTurnRepo.list()).toEqual([])
    expect(seen.some((m) => m.type === 'event' && m.event.type === 'error')).toBe(true)
    // Mutation: skip `keepRows` in `applyCollected` → the draft is deleted
    // with the other rows the kill left.
    expect(chatRepo.listMessages(chatId)).toHaveLength(2 + kept.length)
  })

  it('puts the cut-off card under the kept rows, above a message sent after the turn', async () => {
    const { userMessageId } = killedTurn()
    messageRepo.saveUser({ chatId, content: 'Any news?', addressedAgentId: AGENT })
    server({ tasksGet: [task('failed', [userMessage(userMessageId), userMessage('later-row')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an'],
      ['error', CUT_OFF_NOTICE], ['user', 'Any news?']
    ])
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('keeps the rows of a turn the server reports canceled with no reply, and records it canceled', async () => {
    const { userMessageId } = killedTurn()
    server({ tasksGet: [task('canceled', [userMessage(userMessageId)])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an']])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('canceled')
    expect(sessionOf()?.taskState).toBe('canceled')
  })

  it('ends cut off when the kill left no rows either, and leaves the cursor before the message', async () => {
    // Mutation: require kept rows for the lost-reply branch in
    // `collectedResult` → the turn reads completed with no reply, no card,
    // and the cursor moves past the unanswered message.
    const { userMessageId } = killedTurn({ flush: false })
    server({ tasksGet: [task('completed', [userMessage(userMessageId)])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['error', CUT_OFF_NOTICE]])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
    expect(sessionOf()?.taskState).toBe('aborted')
    expect(chatAgentCursorRepo.get(chatId, AGENT)).toBeFalsy()
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it.each(['aborted', 'complete'])('keeps the rows under a %s row whose only part is empty text, and ends cut off', async (rowState) => {
    // Mutation: `hasReply: !!lastAgentMessage` in `readTurn` → under
    // `complete`, the kill's rows are replaced with nothing and the turn
    // reads completed (under `aborted` the richness check still keeps them).
    const { userMessageId } = killedTurn({ draft: true })
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('', rowState)])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an'], ['assistant', ' answer'],
      ['error', CUT_OFF_NOTICE]
    ])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
    expect(sessionOf()?.taskState).toBe('aborted')
  })
})

describe('a cut-off reply on the agent beside the rows the kill left', () => {
  it('keeps the rows when the agent’s aborted row holds less, and ends cut off', async () => {
    // Mutation: drop the richness check in `serverCopyWins` → "Half" replaces
    // the draft and the flushed rows.
    const { userMessageId } = killedTurn({ draft: true })
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Half', 'aborted')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an'], ['assistant', ' answer'],
      ['error', CUT_OFF_NOTICE]
    ])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
    expect(sessionOf()?.taskState).toBe('aborted')
    expect(chatAgentCursorRepo.get(chatId, AGENT)).toBeFalsy()
  })

  it('takes the agent’s aborted row when it holds more than the rows', async () => {
    // Mutation: never let a cut-off copy win → the kill's rows stay.
    const { userMessageId } = killedTurn({ draft: true })
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Half an answer, and a bit', 'aborted')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Half an answer, and a bit'], ['error', CUT_OFF_NOTICE]])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
  })

  it.each([
    ['failed', 'complete'],
    ['failed', 'streaming'],
    ['rejected', 'complete']
  ])('keeps the rows under a thinner reply of a %s task (row %s), with the task-failed card', async (state, rowState) => {
    // Mutation: `isCutOff` back to `aborted`/`canceled` only → "Half"
    // replaces the draft and the flushed rows.
    const { userMessageId } = killedTurn({ draft: true })
    server({ tasksGet: [task(state, [userMessage(userMessageId), agentMessage('Half', rowState)])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an'], ['assistant', ' answer'],
      ['error', TASK_FAILED_MESSAGE]
    ])
    // Mutation: no card for a failed `keptEnding` → the kept rows end with no error row.
    expect(JSON.parse(chatRepo.listMessages(chatId).at(-1)!.content)).toEqual({ short: TASK_FAILED_MESSAGE, code: 'agent_task_failed' })
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
    expect(sessionOf()?.taskState).toBe(state)
  })

  it('keeps the rows under a thinner completed reply whose last row is still streaming, with no card', async () => {
    const { userMessageId } = killedTurn({ draft: true })
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Half', 'streaming')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an'], ['assistant', ' answer']
    ])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('completed')
  })

  it('keeps the rows under a thinner canceled row, with no card', async () => {
    const { userMessageId } = killedTurn()
    server({ tasksGet: [task('canceled', [userMessage(userMessageId), agentMessage('Half', 'canceled')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an']])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('canceled')
    expect(sessionOf()?.taskState).toBe('canceled')
  })

  it.each([
    ['no reply', []],
    // The backend writes a canceled row with no events as one empty text part.
    ['a canceled row with only empty text', [agentMessage('', 'canceled')]],
    ['a canceled row thinner than the rows', [agentMessage('Half', 'canceled')]]
  ])('keeps the rows when Stop finds %s on the server', async (_label, reply) => {
    const { userMessageId } = killedTurn({ draft: true })
    const agent = server({
      tasksGet: [task('working', [userMessage(userMessageId)]), task('canceled', [userMessage(userMessageId), ...reply])]
    }, 2)

    const done = remoteTurnRecoveryService.resume(USER)
    await agent.atGate
    runExecutionService.cancelChat(USER, chatId)
    await done

    // Mutation: drop the keep-rows branch in `stopTurn` → only the user row
    // (or "Half").
    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an'], ['assistant', ' answer']
    ])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('canceled')
    expect(inflightTurnRepo.list()).toEqual([])
  })
})

describe('a send that never reached the agent', () => {
  it('goes out again with the same message id and task id, without a second user row', async () => {
    const { userMessageId } = killedTurn({ flush: false })
    const agent = server({
      tasksGet: [task('completed', [userMessage('an-earlier-message'), agentMessage('Earlier answer')])],
      rpc: {
        sse: [
          { result: { kind: 'status-update', taskId: TASK, contextId: TASK, status: { state: 'working' }, final: false } },
          { result: { kind: 'artifact-update', taskId: TASK, contextId: TASK, artifact: { artifactId: 'a1', parts: [{ kind: 'text', text: 'Fresh answer', metadata: { 'cinna.content_kind': 'text' } }] } } },
          { result: { kind: 'status-update', taskId: TASK, contextId: TASK, status: { state: 'completed' }, final: true } }
        ]
      }
    })
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: return `interrupted` instead of resending → no stream request.
    const sends = agent.rpc('message/stream')
    expect(sends).toHaveLength(1)
    const message = (sends[0].body!.params as { message: { messageId: string; taskId?: string; parts: { text: string }[] } }).message
    expect(message).toMatchObject({ messageId: userMessageId, taskId: TASK })
    expect(message.parts[0].text).toContain('Find the bug')
    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Fresh answer']])
    expect(inflightTurnRepo.list()).toEqual([])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('completed')
    expect(seen.some((m) => m.type === 'event' && m.event.type === 'delta' && m.event.text === 'Fresh answer')).toBe(true)
  })

  it('is not sent again when the chat has moved on past it; the notice goes under the turn', async () => {
    const { userMessageId } = killedTurn({ flush: false })
    messageRepo.saveUser({ chatId, content: 'Any news?', addressedAgentId: AGENT })
    const agent = server({ tasksGet: [task('completed', [userMessage('other')])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(agent.rpc('message/stream')).toEqual([])
    // Mutation: settle with the notice at the chat's end, and record the
    // result → the notice lands under the later message, which reads failed.
    expect(transcript().map(([, content]) => content)).toEqual(['Find the bug', INTERRUPTED_TURN_NOTICE, 'Any news?'])
    expect(chatRunResultRepo.get(USER, chatId)).toBeNull()
    expect(userMessageId).toBeTruthy()
  })

  it('is not sent again when the turn already has rows: they prove it arrived', async () => {
    killedTurn({ draft: true })
    const agent = server({ tasksGet: [task('completed', [userMessage('other'), agentMessage('Other answer')])] })

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: drop the rows check in `resend` → the rows are deleted and
    // the message goes out again.
    expect(agent.rpc('message/stream')).toEqual([])
    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an'], ['assistant', ' answer'],
      ['error', INTERRUPTED_TURN_NOTICE]
    ])
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('is not sent again when the history came back full', async () => {
    killedTurn({ flush: false })
    const full = Array.from({ length: 50 }, (_, i) => (i % 2 ? agentMessage(`answer ${i}`) : userMessage(`earlier-${i}`)))
    const agent = server({ tasksGet: [task('completed', full)] })

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: ignore `historyFull` → the message goes out again.
    expect(agent.rpc('message/stream')).toEqual([])
    expect(transcript()).toEqual([['user', 'Find the bug'], ['error', INTERRUPTED_TURN_NOTICE]])
  })

  it('leaves an error row when the resend fails before it streams', async () => {
    const { userMessageId } = killedTurn({ flush: false })
    const agent = server({
      tasksGet: [task('working', [userMessage('other')]), task('completed', [userMessage('other')])]
    }, 2)
    const seen = watch()

    const done = remoteTurnRecoveryService.resume(USER)
    await agent.atGate
    agentPresent.value = false
    agent.release()
    await done

    // Mutation: `refuse` → `fail` in `resendAgentTurn` → the transcript keeps
    // only the user row and the live view gets a generic error.
    expect(agent.rpc('message/stream')).toEqual([])
    expect(transcript()).toEqual([['user', 'Find the bug'], ['error', 'Agent not found or not configured']])
    expect(seen.filter((m) => m.type === 'event' && m.event.type === 'error').map((m) => m.type === 'event' && m.event)).toEqual([
      { type: 'error', error: 'Agent not found or not configured' }
    ])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
    expect(inflightTurnRepo.list()).toEqual([])
    expect(userMessageId).toBeTruthy()
  })
})

describe('a resend whose stream fails after it owns the port', () => {
  it('leaves an error row and posts one error', async () => {
    killedTurn({ flush: false })
    server({ tasksGet: [task('completed', [userMessage('other')])] })
    vi.spyOn(a2aStreamingService, 'streamToAgent').mockRejectedValueOnce(new Error('The stream broke.'))
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: `fail` alone in the `handOff` refusal → only the user row is left.
    expect(transcript()).toEqual([['user', 'Find the bug'], ['error', 'The stream broke.']])
    const errors = seen.flatMap((m) => (m.type === 'event' && m.event.type === 'error' ? [m.event] : []))
    expect(errors).toEqual([{ type: 'error', error: 'The stream broke.' }])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
    expect(inflightTurnRepo.list()).toEqual([])
  })
})

describe('a turn nothing can be learned about', () => {
  it('without a task id is settled as interrupted and never sent again', async () => {
    killedTurn({ session: false })
    const agent = server({ tasksGet: [task('completed', [])] })

    await remoteTurnRecoveryService.resume(USER)

    expect(agent.requests).toEqual([])
    expect(transcript().at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
    expect(inflightTurnRepo.list()).toEqual([])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
  })

  it('leaves the session state alone when the turn settles as interrupted', async () => {
    killedTurn()
    server({})

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript().at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
    expect(sessionOf()).toEqual({ contextId: TASK, taskId: TASK, taskState: null })
  })

  it('on a backend that cannot report it is settled as interrupted, keeping the flushed rows', async () => {
    killedTurn()
    const agent = server({})

    await remoteTurnRecoveryService.resume(USER)

    expect(agent.rpc('tasks/get')).toHaveLength(1)
    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an'],
      ['error', INTERRUPTED_TURN_NOTICE]
    ])
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('at a bad URL is settled as interrupted, not left for later', async () => {
    killedTurn()
    server({ card: { network: { message: 'fetch failed', causeCode: 'ERR_INVALID_URL' } } })

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: count any `TypeError` as a drop → the marker is kept.
    expect(inflightTurnRepo.list()).toEqual([])
    expect(transcript().at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
  })

  it('whose agent is gone is settled as interrupted', async () => {
    killedTurn()
    agentPresent.value = false
    server({})

    await remoteTurnRecoveryService.resume(USER)

    expect(transcript().at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
  })
})

describe('Stop during recovery', () => {
  it('cancels the task, keeps what the agent has, and records the turn canceled', async () => {
    const { userMessageId } = killedTurn()
    // The held poll is never released: Stop has to end it through the signal.
    const agent = server({
      tasksGet: [
        task('working', [userMessage(userMessageId), agentMessage('Half an answer', 'streaming')]),
        task('canceled', [userMessage(userMessageId), agentMessage('Half an answer', 'canceled')])
      ]
    }, 2)

    const done = remoteTurnRecoveryService.resume(USER)
    await agent.atGate
    runExecutionService.cancelChat(USER, chatId)
    // Mutation: build the poll client without `io.signal` → the hung poll
    // holds the run until the test times out.
    await done

    expect(agent.rpc('tasks/cancel')).toHaveLength(1)
    expect((agent.rpc('tasks/cancel')[0].body!.params as { id: string }).id).toBe(TASK)
    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Half an answer']])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('canceled')
    expect(inflightTurnRepo.list()).toEqual([])
    expect(sessionOf()).toEqual({ contextId: TASK, taskId: TASK, taskState: 'canceled' })
  })
})

describe('credentials that need the user', () => {
  it('leave the marker and the rows alone until the profile is ready again', async () => {
    const { userMessageId } = killedTurn()
    auth.reauth = true
    const agent = server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Found it.')])] })
    const before = transcript()

    await remoteTurnRecoveryService.resume(USER)

    expect(inflightTurnRepo.list()).toHaveLength(1)
    expect(transcript()).toEqual(before)
    expect(agent.requests).toEqual([])
    expect(chatRunResultRepo.get(USER, chatId)).toBeNull()

    auth.reauth = false
    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Found it.']])
    expect(inflightTurnRepo.list()).toEqual([])
  })
})

describe('an agent that cannot be reached', () => {
  afterEach(() => {
    remoteTurnRecoveryService.onRetryDue(null)
    vi.useRealTimers()
  })

  /** Nothing changed, nothing shown: the marker waits. */
  function expectKept(before: [string, string][], seen: RunWatchMessage[]): void {
    expect(inflightTurnRepo.list()).toHaveLength(1)
    expect(transcript()).toEqual(before)
    expect(activeRunsByChat.has(chatId)).toBe(false)
    expect(seen.filter((m) => m.type !== 'snapshot' || m.active)).toEqual([])
    expect(chatRunResultRepo.get(USER, chatId)).toBeNull()
  }

  it('offline at the card: keeps the marker, asks for a retry, and recovers once the agent answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const retries: string[] = []
    remoteTurnRecoveryService.onRetryDue((id) => { retries.push(id) })
    const { userMessageId } = killedTurn()
    server({ card: { network: { message: 'fetch failed', causeCode: 'ENOTFOUND' } } })
    const before = transcript()
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: settle a transport drop as interrupted in `plan` → the
    // interrupted notice is written and the marker is gone.
    expectKept(before, seen)
    expect(retries).toEqual([])
    vi.advanceTimersByTime(RECOVERY_RETRY_MS)
    expect(retries).toEqual([USER])
    vi.useRealTimers()

    // The wake hook and the retry both call `resume` again.
    server({ tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Found it.')])] })
    await remoteTurnRecoveryService.resume(USER)

    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Found it.']])
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('keeps the marker when the first tasks/get drops', async () => {
    const { userMessageId } = killedTurn()
    const agent = server({ firstGet: 'drop', tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Found it.')])] })
    const before = transcript()
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    expect(agent.rpc('tasks/get')).toHaveLength(1)
    expectKept(before, seen)
  })

  it('keeps the marker when the first tasks/get answers 502', async () => {
    const { userMessageId } = killedTurn()
    const agent = server({ firstGet: 502, tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Found it.')])] })
    const before = transcript()
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: drop `transientStatusUnreachable` from the plan's read → settled as interrupted.
    expect(agent.rpc('tasks/get')).toHaveLength(1)
    expectKept(before, seen)
  })

  it('keeps the marker when the card answers 503', async () => {
    killedTurn()
    server({ card: { status: 503, statusText: 'Service Unavailable' } })
    const before = transcript()
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: drop `isTransientHttpStatus` from the plan's catch → settled as interrupted.
    expectKept(before, seen)
  })

  it('keeps the marker when the endpoint or the token takes longer than the plan’s bound', async () => {
    killedTurn()
    const agent = server({})
    const marker = inflightTurnRepo.list()[0]
    const scope = { profileUserId: USER, settingsUserId: USER }
    const hang = () => new Promise<never>(() => {})
    // Mutation: await the resolution without `within` → the plan never settles.
    const slowEndpoint = createA2aTurnRecoverer({ ...deps, resolveEndpoint: hang, planTimeoutMs: 20 }).plan(marker, scope)
    const slowToken = createA2aTurnRecoverer({ ...deps, resolveAccessToken: hang, planTimeoutMs: 20 }).plan(marker, scope)
    await expect(slowEndpoint).resolves.toEqual({ kind: 'defer', reason: 'network' })
    await expect(slowToken).resolves.toEqual({ kind: 'defer', reason: 'network' })
    expect(agent.requests).toEqual([])
  })

  it('settles a turn older than the give-up age as interrupted when its agent is still unreachable', async () => {
    const retries: string[] = []
    remoteTurnRecoveryService.onRetryDue((id) => { retries.push(id) })
    const { markerId } = killedTurn()
    holder.current!.raw.prepare('UPDATE inflight_turns SET started_at = ? WHERE id = ?').run(Date.now() - RECOVERY_GIVE_UP_MS - 1_000, markerId)
    server({ firstGet: 'drop' })

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: skip `waitedTooLong` in the plan branch → the marker is kept.
    expect(inflightTurnRepo.list()).toEqual([])
    expect(transcript().at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
  })

  it('keeps a turn younger than the give-up age, and an old one that waits for sign-in', async () => {
    const { markerId } = killedTurn()
    holder.current!.raw.prepare('UPDATE inflight_turns SET started_at = ? WHERE id = ?').run(Date.now() - RECOVERY_GIVE_UP_MS + 60_000, markerId)
    server({ firstGet: 'drop' })
    await remoteTurnRecoveryService.resume(USER)
    expect(inflightTurnRepo.list()).toHaveLength(1)

    holder.current!.raw.prepare('UPDATE inflight_turns SET started_at = ? WHERE id = ?').run(Date.now() - 2 * RECOVERY_GIVE_UP_MS, markerId)
    server({ firstGet: 401 })
    await remoteTurnRecoveryService.resume(USER)
    // Mutation: give up on `auth` too → the marker is gone.
    expect(inflightTurnRepo.list()).toHaveLength(1)
  })

  it('keeps the marker when tasks/get refuses a Cinna agent’s session', async () => {
    const { userMessageId } = killedTurn()
    const agent = server({ firstGet: 401, tasksGet: [task('completed', [userMessage(userMessageId), agentMessage('Found it.')])] })
    const before = transcript()
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    expect(agent.rpc('tasks/get')).toHaveLength(1)
    expectKept(before, seen)
  })
})

describe('a poll the agent stops answering', () => {
  afterEach(() => {
    remoteTurnRecoveryService.onRetryDue(null)
    vi.useRealTimers()
  })

  it('asks again with a freshly resolved token after a refusal', async () => {
    const { userMessageId } = killedTurn()
    server({
      tasksGet: [task('working', [userMessage(userMessageId)]), task('completed', [userMessage(userMessageId), agentMessage('Found it.')])]
    }, undefined, { 2: 401 })

    await remoteTurnRecoveryService.resume(USER)

    // Plan, first poll client, the client after the refusal.
    expect(auth.tokens).toBe(3)
    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Found it.']])
  })

  it('refused again for an agent that is not Cinna: settles the turn as interrupted, as the plan phase does', async () => {
    // Mutation: defer every `unauthorized` collection as `auth` → the marker
    // is kept, waiting for a sign-in that cannot fix a typed token.
    const { userMessageId } = killedTurn()
    server({ tasksGet: [task('working', [userMessage(userMessageId)])] }, undefined, (call) => (call > 1 ? 401 : undefined))
    const row = agentRow as unknown as { source: string }
    row.source = 'local'
    try {
      await remoteTurnRecoveryService.resume(USER)
    } finally {
      row.source = 'remote'
    }

    expect(inflightTurnRepo.list()).toEqual([])
    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['agent_transition', 'Environment starting'], ['assistant', 'Half an'],
      ['error', INTERRUPTED_TURN_NOTICE]
    ])
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
  })

  it('refused again: closes the run with no outcome, keeps the marker and the rows, and waits for sign-in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const retries: string[] = []
    remoteTurnRecoveryService.onRetryDue((id) => { retries.push(id) })
    const { userMessageId, markerId } = killedTurn()
    server({ tasksGet: [task('working', [userMessage(userMessageId)])] }, undefined, (call) => (call > 1 ? 401 : undefined))
    const before = transcript()
    const seen = watch()

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: treat `defer` from `recover` as interrupted → the notice is
    // written and the marker is gone.
    expect(inflightTurnRepo.list().map((marker) => marker.id)).toEqual([markerId])
    expect(transcript()).toEqual(before)
    expect(chatRunResultRepo.get(USER, chatId)).toBeNull()
    expect(activeRunsByChat.has(chatId)).toBe(false)
    const terminal = seen.flatMap((m) => (m.type === 'event' && (m.event.type === 'done' || m.event.type === 'error') ? [m.event] : []))
    expect(terminal).toEqual([{ type: 'done' }])
    expect(seen.at(-1)).toMatchObject({ type: 'closed', runId: markerId })
    vi.advanceTimersByTime(RECOVERY_RETRY_MS)
    expect(retries).toEqual([])
  })

  it('dropping for longer than the poll rides out: left for later, with a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const retries: string[] = []
    remoteTurnRecoveryService.onRetryDue((id) => { retries.push(id) })
    const saved = collectPollDelays.dropsForMs
    collectPollDelays.dropsForMs = 20
    try {
      const { userMessageId } = killedTurn()
      server({ tasksGet: [task('working', [userMessage(userMessageId)])] }, undefined, (call) => (call > 1 ? 'drop' : undefined))
      const before = transcript()

      await remoteTurnRecoveryService.resume(USER)

      expect(inflightTurnRepo.list()).toHaveLength(1)
      expect(transcript()).toEqual(before)
      vi.advanceTimersByTime(RECOVERY_RETRY_MS)
      expect(retries).toEqual([USER])
    } finally {
      collectPollDelays.dropsForMs = saved
    }
  })

  it('rides out a gateway’s 502 while polling, and collects the turn', async () => {
    const { userMessageId } = killedTurn()
    const agent = server({
      tasksGet: [task('working', [userMessage(userMessageId)]), task('completed', [userMessage(userMessageId), agentMessage('Found it.')])]
    }, undefined, { 2: 502 })

    await remoteTurnRecoveryService.resume(USER)

    // Mutation: drop `transientStatusUnreachable` from the poll → settled as interrupted.
    expect(agent.rpc('tasks/get').length).toBeGreaterThanOrEqual(3)
    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Found it.']])
  })

  it('settles an old turn as interrupted when its poll gives up as unreachable', async () => {
    const saved = collectPollDelays.dropsForMs
    collectPollDelays.dropsForMs = 20
    try {
      const { userMessageId, markerId } = killedTurn()
      holder.current!.raw.prepare('UPDATE inflight_turns SET started_at = ? WHERE id = ?').run(Date.now() - RECOVERY_GIVE_UP_MS - 1_000, markerId)
      server({ tasksGet: [task('working', [userMessage(userMessageId)])] }, undefined, (call) => (call > 1 ? 'drop' : undefined))

      await remoteTurnRecoveryService.resume(USER)

      // Mutation: skip `waitedTooLong` in the `defer` result → the marker is kept.
      expect(inflightTurnRepo.list()).toEqual([])
      expect(transcript().at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
    } finally {
      collectPollDelays.dropsForMs = saved
    }
  })

  it('schedules the retry for an unreachable chat while another chat’s recovery still runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const retries: string[] = []
    remoteTurnRecoveryService.onRetryDue((id) => { retries.push(id) })
    const { userMessageId } = killedTurn()
    const firstChat = chatId
    chatId = chatRepo.create(USER).id
    holder.current!.raw.prepare('UPDATE chats SET agent_id = ? WHERE id = ?').run(AGENT, chatId)
    const other = messageRepo.saveUser({ chatId, content: 'Other chat', addressedAgentId: AGENT })
    inflightTurnRepo.open({ id: 'req-other', profileId: USER, chatId, agentId: AGENT, driver: 'a2a', userMessageId: other })
    agentSessionRepo.upsert({ chatId, agentId: AGENT, contextId: 'task-b', taskId: 'task-b', taskState: null })
    // The first chat's poll hangs; every read of the second chat's task drops.
    const agent = server({
      tasksGet: [task('working', [userMessage(userMessageId)]), task('completed', [userMessage(userMessageId), agentMessage('Found it.')])]
    }, 2, (_call, taskId) => (taskId === 'task-b' ? 'drop' : undefined))

    const done = remoteTurnRecoveryService.resume(USER)
    await agent.atGate
    await until(() => inflightTurnRepo.get('req-other') !== null && !activeRunsByChat.has(chatId) && agent.rpc('tasks/get').length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Mutation: schedule the retry after `Promise.all` → nothing is due while
    // the first chat still polls.
    vi.advanceTimersByTime(RECOVERY_RETRY_MS)
    expect(retries).toEqual([USER])
    expect(activeRunsByChat.get(firstChat)).toBeDefined()

    agent.release()
    await done
    expect(inflightTurnRepo.list().map((marker) => marker.id)).toEqual(['req-other'])
  })
})

describe('a turn this process is running', () => {
  it('is left alone by a recovery pass while it streams', async () => {
    const agent = server({
      rpc: {
        sse: [
          { result: { kind: 'status-update', taskId: TASK, contextId: TASK, status: { state: 'working' }, final: false } },
          { result: { kind: 'artifact-update', taskId: TASK, contextId: TASK, artifact: { artifactId: 'a3', parts: [{ kind: 'text', text: 'Live answer', metadata: { 'cinna.content_kind': 'text' } }] } } }
        ],
        hold: true
      },
      tasksGet: [task('completed', [userMessage('whatever'), agentMessage('Wrong answer')])]
    })
    const scope = { profileUserId: USER, settingsUserId: USER }
    const handle = runExecutionService.start(scope, { chatId, content: 'Find the bug', addressedAgentId: AGENT }, {
      observe: (ctx, event) => inboxService.recordRunEvent(ctx, event)
    })
    await until(() => inflightTurnRepo.list().length === 1 && !!agentSessionRepo.getByChatAndAgent(chatId, AGENT)?.taskId)
    const [marker] = inflightTurnRepo.list()
    expect(isLiveMarker(marker.id)).toBe(true)

    // Mutation: drop the `isLiveMarker` filter in `resume` → the pass asks
    // the agent about the live turn and waits for it to end.
    const pass = await Promise.race([
      remoteTurnRecoveryService.resume(USER).then(() => 'settled' as const),
      new Promise((resolve) => setTimeout(() => resolve('waiting on the live turn'), 300))
    ])
    expect(pass).toBe('settled')
    expect(agent.rpc('tasks/get')).toEqual([])
    expect(inflightTurnRepo.get(marker.id)).not.toBeNull()
    expect(activeRunsByChat.get(chatId)).toBe(handle)

    agent.agent.close()
    await handle.completed
    expect(inflightTurnRepo.list()).toEqual([])
    expect(isLiveMarker(marker.id)).toBe(false)
    expect(transcript()).toEqual([['user', 'Find the bug'], ['assistant', 'Live answer']])
  })
})

describe('a message sent while a turn is recovered', () => {
  it('queues behind it and lands below the recovered reply', async () => {
    const { userMessageId } = killedTurn()
    const agent = server({
      tasksGet: [
        task('working', [userMessage(userMessageId)]),
        task('completed', [userMessage(userMessageId), agentMessage('Found it.')])
      ],
      rpc: {
        sse: [
          { result: { kind: 'status-update', taskId: TASK, contextId: TASK, status: { state: 'working' }, final: false } },
          { result: { kind: 'artifact-update', taskId: TASK, contextId: TASK, artifact: { artifactId: 'a2', parts: [{ kind: 'text', text: 'No news.', metadata: { 'cinna.content_kind': 'text' } }] } } },
          { result: { kind: 'status-update', taskId: TASK, contextId: TASK, status: { state: 'completed' }, final: true } }
        ]
      }
    }, 2)

    const done = remoteTurnRecoveryService.resume(USER)
    await agent.atGate
    const scope = { profileUserId: USER, settingsUserId: USER }
    const sent = await runQueueService.submit(scope, { chatId, content: 'Any news?', addressedAgentId: AGENT }, () => ({
      observe: (ctx, event) => inboxService.recordRunEvent(ctx, event)
    }))
    expect(sent.kind).toBe('queued')
    expect(agent.rpc('message/stream')).toEqual([])

    agent.release()
    await done
    await until(() => transcript().length === 4 && !activeRunsByChat.has(chatId))

    expect(transcript()).toEqual([
      ['user', 'Find the bug'], ['assistant', 'Found it.'], ['user', 'Any news?'], ['assistant', 'No news.']
    ])
    expect(agent.rpc('message/stream')).toHaveLength(1)
  })
})

describe('a recovery that opens an ask and is then left for later', () => {
  it('expires the ask and takes the task off needs_input, leaving the marker', async () => {
    const userMessageId = messageRepo.saveUser({ chatId, content: 'Deploy it', addressedAgentId: AGENT })
    inflightTurnRepo.open({ id: 'req-follow', profileId: USER, chatId, agentId: AGENT, driver: 'follow-stub', userMessageId })
    let asked!: () => void
    const askOpen = new Promise<void>((resolve) => { asked = resolve })
    let lose!: () => void
    const lost = new Promise<void>((resolve) => { lose = resolve })
    registerRecoverer('follow-stub', {
      plan: async () => ({
        kind: 'recover',
        replaysLive: true,
        async recover(io) {
          io.event({ type: 'needs_input', requestId: 'per-1', resume: 'reply',
            request: { kind: 'permission', action: 'Bash', resources: ['ls'], callId: 'tool-1', allowRemember: false } })
          asked()
          await lost
          return { kind: 'defer', reason: 'network' }
        }
      })
    })

    const done = remoteTurnRecoveryService.resume(USER)
    await askOpen
    expect(taskInputRequestRepo.listOpenForChat(chatId)).toHaveLength(1)
    const taskId = taskRepo.getByChatId(USER, chatId)!.id
    expect(taskRepo.getById(USER, taskId)!.status).toBe('blocked')
    lose()
    await done

    // Mutation: drop `abandonReplyAsks` → the ask stays open and the task blocked.
    expect(taskInputRequestRepo.listOpenForChat(chatId)).toEqual([])
    expect(taskRepo.getById(USER, taskId)!.status).toBe('in_progress')
    expect(inflightTurnRepo.list().map((marker) => marker.id)).toEqual(['req-follow'])
    expect(chatRunResultRepo.get(USER, chatId)).toBeNull()
    remoteTurnRecoveryService.onRetryDue(null)
  })
})

describe('isRecoverable', () => {
  it('is true only for a driver with a registered recoverer, and the boot pass leaves those alone', () => {
    const { markerId } = killedTurn()
    inflightTurnRepo.open({ id: 'acp-turn', profileId: USER, chatId, agentId: 'folder:x', driver: 'acp', userMessageId: null })
    const a2a = inflightTurnRepo.get(markerId)!
    const acp = inflightTurnRepo.get('acp-turn')!

    expect(isRecoverable(a2a)).toBe(true)
    expect(isRecoverable(acp)).toBe(false)

    interruptedTurnService.finalizeLeftovers()
    expect(inflightTurnRepo.list().map((marker) => marker.id)).toEqual([markerId])
  })
})
