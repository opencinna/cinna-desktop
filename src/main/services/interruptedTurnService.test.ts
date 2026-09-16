import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * The boot pass for turns the app was killed under, against a real database:
 * each marker ends with a notice row, a failed outcome on the task, job run
 * and sidebar result, and no marker — unless a recovery service claims it, or
 * the turn is parked on an answerable next-message ask. Job runs a kill left
 * `running` before markers existed are finalized only when nothing else owns
 * them.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

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
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { interruptedTurnService, finalizeInterrupted, INTERRUPTED_TURN_NOTICE, INTERRUPTED_FOLLOW_UP_NOTICE, INTERRUPTED_RUN_MESSAGE } =
  await import('./interruptedTurnService')
const { inflightTurnRepo, markLiveMarker } = await import('../db/inflightTurns')
const { chatRepo } = await import('../db/chats')
const { messageRepo } = await import('../db/messages')
const { chatRunResultRepo } = await import('../db/chatRunResults')
const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { taskService } = await import('./taskService')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { taskRuntimeRepo } = await import('../db/taskRuntimes')

const USER = '__default__'
const AGENT = 'agent-1'

beforeEach(() => {
  holder.current = createTestDatabase()
})

afterEach(() => {
  vi.restoreAllMocks()
  holder.current?.close()
  holder.current = null
})

/** A chat the user opened by hand, whose first ask gave it a task. */
function handOpenedChat(): { chatId: string; taskId: string } {
  const chatId = chatRepo.create(USER).id
  const task = taskService.create(USER, { title: 'Chat', goal: 'Help', chatId, origin: 'local', executor: 'desktop' })
  taskService.start(USER, task.id, { chatId })
  return { chatId, taskId: task.id }
}

/** A legacy renderer-turn job run, `running`, with its task. */
function jobChat(options: { router?: 'coordinator' } = {}): { chatId: string; taskId: string; runId: string } {
  const job = jobsRepo.create(USER, { type: 'local', title: 'Nightly', prompt: 'Check' })
  if (options.router) holder.current!.raw.prepare('UPDATE jobs SET router = ? WHERE id = ?').run(options.router, job.id)
  const { chatId, runId } = jobRunsRepo.createLocalChatAndRun({
    userId: USER, jobId: job.id, title: 'Nightly', prompt: 'Check', rootAgentId: null, router: 'direct',
    modeId: null, providerId: null, modelId: null, onDemandAgentIds: [], onDemandMcpIds: []
  })
  const task = taskService.create(USER, { title: 'Nightly', goal: 'Check', chatId, jobId: job.id, jobRunId: runId })
  jobRunsRepo.setTaskId(runId, task.id)
  taskService.start(USER, task.id, { chatId })
  return { chatId, taskId: task.id, runId }
}

/** What a kill leaves: the user row, maybe a draft, and the marker. */
function killedTurn(chatId: string, options: { draft?: string; id?: string } = {}): string {
  const userMessageId = messageRepo.saveUser({ chatId, content: 'Do it', addressedAgentId: AGENT })
  const id = options.id ?? `req-${chatId}`
  inflightTurnRepo.open({ id, profileId: USER, chatId, agentId: AGENT, driver: 'acp', userMessageId })
  if (options.draft) {
    inflightTurnRepo.writeDraft({
      markerId: id, draftId: null, chatId, agentId: AGENT, content: options.draft, parts: [{ kind: 'text', text: options.draft }]
    })
  }
  return id
}

function openNextMessageAsk(chatId: string, taskId: string): void {
  taskInputRequestRepo.open({
    requestId: `ask-${chatId}`, taskId, chatId, agentId: AGENT, resume: 'next_message',
    request: { kind: 'question', questions: [{ question: 'Which branch?', options: [], multiSelect: false }] }
  })
  taskService.applyRunState(USER, taskId, 'needs_input')
}

const transcript = (chatId: string): [string, string][] =>
  chatRepo.listMessages(chatId).map((row) => [row.role, row.role === 'error' ? JSON.parse(row.content).short : row.content])

describe('interruptedTurnService.finalizeLeftovers', () => {
  it('keeps the draft, adds the notice, fails the task and the run result, and drops the marker', () => {
    const { chatId, taskId } = handOpenedChat()
    killedTurn(chatId, { draft: 'Half an answer' })
    holder.current!.raw.prepare('UPDATE chats SET updated_at = 1000 WHERE id = ?').run(chatId)

    interruptedTurnService.finalizeLeftovers()

    expect(transcript(chatId)).toEqual([
      ['user', 'Do it'],
      ['assistant', 'Half an answer'],
      ['error', INTERRUPTED_TURN_NOTICE]
    ])
    // A readable card, not a notice compact mode folds away, and no Details
    // that would only repeat it.
    expect(JSON.parse(chatRepo.listMessages(chatId)[2].content)).toEqual({
      short: 'The app closed before this turn finished. Send your message again to retry.',
      code: 'turn_interrupted'
    })
    // The boot pass leaves the chat's place in the list alone.
    expect(chatRepo.getOwned(USER, chatId)!.updatedAt).toEqual(new Date(1000 * 1000))
    expect(taskService.getById(USER, taskId).status).toBe('error')
    expect(chatRunResultRepo.get(USER, chatId)).toMatchObject({ status: 'failed', unread: true })
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('says the agent was working on its own, not to send a message again, for a turn the agent started', () => {
    const { chatId } = handOpenedChat()
    messageRepo.saveUser({ chatId, content: 'Watch CI and merge', addressedAgentId: AGENT })
    const id = 'follow-up-1'
    inflightTurnRepo.open({ id, profileId: USER, chatId, agentId: AGENT, driver: 'acp', userMessageId: null })
    inflightTurnRepo.writeDraft({
      markerId: id, draftId: null, chatId, agentId: AGENT, content: 'CI is green; merging', parts: [{ kind: 'text', text: 'CI is green; merging' }]
    })

    interruptedTurnService.finalizeLeftovers()

    expect(transcript(chatId)).toEqual([
      ['user', 'Watch CI and merge'],
      ['assistant', 'CI is green; merging'],
      ['error', INTERRUPTED_FOLLOW_UP_NOTICE]
    ])
    expect(JSON.parse(chatRepo.listMessages(chatId)[2].content)).toEqual({
      short: 'The app closed while the agent was working on its own. What it wrote before that is above.',
      code: 'turn_interrupted'
    })
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('finalizes the job run a killed turn left running, with its task', () => {
    const { chatId, taskId, runId } = jobChat()
    killedTurn(chatId)

    interruptedTurnService.finalizeLeftovers()

    expect(jobRunsRepo.getById(USER, runId)).toMatchObject({ status: 'failed', errorMessage: 'The app closed before this turn finished.' })
    expect(taskService.getById(USER, taskId).status).toBe('error')
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('failed')
    expect(transcript(chatId).at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
  })

  it('leaves a task parked on an answerable next-message ask as it is', () => {
    const { chatId, taskId, runId } = jobChat()
    openNextMessageAsk(chatId, taskId)
    killedTurn(chatId, { draft: 'Which branch?' })

    interruptedTurnService.finalizeLeftovers()

    expect(taskService.getById(USER, taskId).status).toBe('blocked')
    expect(taskInputRequestRepo.listOpenForChat(chatId)).toHaveLength(1)
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('running')
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('needs_input')
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('skips a marker a recovery service will settle, and the job run under it', () => {
    const { chatId, runId } = jobChat()
    const id = killedTurn(chatId, { draft: 'streamed' })

    interruptedTurnService.finalizeLeftovers({ recoverable: (marker) => marker.id === id })

    expect(inflightTurnRepo.get(id)).not.toBeNull()
    expect(transcript(chatId).map(([role]) => role)).toEqual(['user', 'assistant'])
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('running')
    expect(chatRunResultRepo.get(USER, chatId)).toBeNull()
  })

  it('never touches the marker of a turn this process is running', () => {
    const { chatId, taskId } = handOpenedChat()
    const id = killedTurn(chatId, { draft: 'streaming now' })
    markLiveMarker(id)

    // Mutation: drop the `isLiveMarker` check → the live turn gets the
    // interrupted notice and its task fails under it.
    interruptedTurnService.finalizeLeftovers({ recoverable: () => false })

    expect(inflightTurnRepo.get(id)).not.toBeNull()
    expect(transcript(chatId)).toEqual([['user', 'Do it'], ['assistant', 'streaming now']])
    expect(taskService.getById(USER, taskId).status).not.toBe('error')
    inflightTurnRepo.delete(id)
  })

  it('puts the notice of a turn the chat moved on from under its own rows, and records nothing for it', () => {
    const { chatId, taskId } = handOpenedChat()
    killedTurn(chatId, { draft: 'Half an answer' })
    messageRepo.saveError({ chatId, short: 'unrelated' })
    messageRepo.saveUser({ chatId, content: 'Something else', addressedAgentId: AGENT })
    messageRepo.saveAssistant({ chatId, content: 'Done', parts: [{ kind: 'text', text: 'Done' }], sourceAgentId: AGENT })
    chatRunResultRepo.record(chatId, 'later-run', 'completed')
    const statusBefore = taskService.getById(USER, taskId).status

    interruptedTurnService.finalizeLeftovers()

    // Mutation: settle without `under` and record the result → the notice
    // lands at the end, under the later turn, which then reads failed.
    expect(transcript(chatId)).toEqual([
      ['user', 'Do it'],
      ['assistant', 'Half an answer'],
      ['error', INTERRUPTED_TURN_NOTICE],
      ['error', 'unrelated'],
      ['user', 'Something else'],
      ['assistant', 'Done']
    ])
    expect(chatRunResultRepo.get(USER, chatId)).toMatchObject({ runId: 'later-run', status: 'completed' })
    expect(taskService.getById(USER, taskId).status).toBe(statusBefore)
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('finalizes the other markers when one of them fails', () => {
    const first = handOpenedChat()
    const second = handOpenedChat()
    const failing = killedTurn(first.chatId)
    killedTurn(second.chatId)
    const settle = inflightTurnRepo.settle.bind(inflightTurnRepo)
    vi.spyOn(inflightTurnRepo, 'settle').mockImplementation((marker, notice) => {
      if (marker.id === failing) throw new Error('disk full')
      settle(marker, notice)
    })

    expect(() => interruptedTurnService.finalizeLeftovers()).not.toThrow()

    expect(inflightTurnRepo.list().map((marker) => marker.id)).toEqual([failing])
    expect(transcript(second.chatId).at(-1)).toEqual(['error', INTERRUPTED_TURN_NOTICE])
    // The failed one wrote no notice, so the next boot does not write two.
    expect(transcript(first.chatId)).toEqual([['user', 'Do it']])
  })
})

describe('finalizeInterrupted with the agent’s real outcome', () => {
  it('records a completed turn as completed, with no notice', () => {
    const { chatId, taskId } = handOpenedChat()
    const id = killedTurn(chatId)
    finalizeInterrupted(inflightTurnRepo.get(id)!, { state: 'completed', text: 'Done' })
    expect(taskService.getById(USER, taskId).status).toBe('completed')
    expect(chatRunResultRepo.get(USER, chatId)?.status).toBe('completed')
    expect(transcript(chatId)).toEqual([['user', 'Do it']])
    expect(inflightTurnRepo.list()).toEqual([])
  })

  it('records a canceled turn as canceled', () => {
    const { chatId, runId } = jobChat()
    const id = killedTurn(chatId)
    finalizeInterrupted(inflightTurnRepo.get(id)!, { state: 'canceled', text: '' })
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('cancelled')
    expect(chatRunResultRepo.get(USER, chatId)).toMatchObject({ status: 'canceled', unread: false })
  })
})

describe('job runs a kill left running before markers existed', () => {
  it('fails a plain chat-turn run with nothing else owning it', () => {
    const { runId, taskId } = jobChat()
    interruptedTurnService.finalizeLeftovers()
    expect(jobRunsRepo.getById(USER, runId)).toMatchObject({ status: 'failed', errorMessage: INTERRUPTED_RUN_MESSAGE })
    expect(taskService.getById(USER, taskId).status).toBe('error')
  })

  it('leaves coordinator runs, runs with a runtime checkpoint and runs waiting on an answer alone', () => {
    const coordinator = jobChat({ router: 'coordinator' })
    const checkpointed = jobChat()
    taskRuntimeRepo.save(USER, checkpointed.taskId, { state: 'interrupted', chatId: checkpointed.chatId } as never)
    const waiting = jobChat()
    openNextMessageAsk(waiting.chatId, waiting.taskId)

    interruptedTurnService.finalizeLeftovers()

    for (const run of [coordinator, checkpointed, waiting]) {
      expect(jobRunsRepo.getById(USER, run.runId)?.status).toBe('running')
    }
  })
})
