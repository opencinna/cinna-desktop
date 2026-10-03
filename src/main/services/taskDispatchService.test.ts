vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { RunOutcome } from './runExecutionService'

/**
 * The task dispatcher over a real database and the real task and Inbox
 * services. Stand-ins, through its deps: the agent list, the start (which does
 * what `taskExecutionService.start` does to the task — a chat, `in_progress` —
 * and hands the test the turn's ending), the runner slots, the live turns and
 * the folder re-read.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  userData: ''
}))

vi.mock('electron', () => ({ app: { getPath: () => holder.userData } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))

const { createTaskDispatchService, WAKE_DEBOUNCE_MS, dispatchableAgentIds } = await import('./taskDispatchService')
const { setDispatchableAgentsSource } = await import('./taskDispatchInbox')
const { setDispatchOwnedTurnSettler } = await import('../tasks/dispatchedTurns')
const { installTaskRunnerHooks } = await import('./taskRunnerBridge')
const { localAgentService } = await import('./localAgents/localAgentService')
const { agentOverrideRepo } = await import('../db/agents')
const { taskService } = await import('./taskService')
const { taskRepo } = await import('../db/tasks')
const { chatRepo } = await import('../db/chats')
const { agentTaskDispatchRepo, taskDispatchGateRepo } = await import('../db/taskDispatch')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { inboxService } = await import('./inboxService')
const { isDispatchedRun, markDispatchedRun, clearDispatchedRun } = await import('../tasks/dispatchedTurns')
const { migrateTasks } = await import('../db/migrations/tasks')
const { taskContinuationPrompt } = await import('./taskExecutionService')
const { DISPATCH_NOTE_INTERRUPTED, DISPATCH_NOTE_UNREPORTED } = await import('../../shared/taskDispatch')

const USER = '__default__'
const SCOPE = { profileUserId: USER, settingsUserId: USER }

interface Started {
  taskId: string
  agentId: string
  chatId: string
  runId: string
  continueInChat: boolean
  end(state: RunOutcome['state'], extra?: Partial<RunOutcome>): void
}

/** The world the dispatcher runs in, rebuilt per test. */
interface World {
  agents: { id: string; name: string; path: string }[]
  starts: Started[]
  live: string[]
  slots: number
  inUse: number
  slotFree: boolean
  startError: string | null
  refresh: ((taskId: string) => void | Promise<void>) | null
  /** The slot wait ignores its abort signal, as a slot granted in the same tick would. */
  ignoreAbort: boolean
  /** Hand a waiting flight the slot it waits for. */
  grant: () => void
  refreshed: string[]
  published: (string | null)[]
}

let world: World
let dir = ''
let service: ReturnType<typeof createTaskDispatchService>

function deps() {
  const waiters: (() => void)[] = []
  return {
    agents: async () => world.agents,
    async start(_scope: unknown, taskId: string, agentId: string, options: {
      continueInChat: boolean
      onRunAccepted: (run: { chatId: string; runId: string }) => void
    }) {
      if (world.startError) throw new Error(world.startError)
      const task = taskRepo.getById(USER, taskId)!
      // As `taskExecutionService.start` refuses.
      if (!['new', 'refining', 'open', 'error'].includes(task.status)) throw new Error(`A ${task.status} task cannot be started.`)
      const chatId = options.continueInChat && task.chatId ? task.chatId : chatRepo.create(USER, { title: task.title, agentId }).id
      const runId = `run-${world.starts.length + 1}`
      taskService.beginDesktopChat(USER, taskId, chatId, { kind: 'agent', agentId, name: agentId })
      options.onRunAccepted?.({ chatId, runId })
      let end!: (outcome: RunOutcome) => void
      const completed = new Promise<RunOutcome>((resolve) => { end = resolve })
      world.starts.push({
        taskId, agentId, chatId, runId, continueInChat: options.continueInChat,
        end: (state, extra = {}) => end({ state, text: '', runId, accepted: true, inputRequestIds: [], ...extra })
      })
      return { chatId, runId, completed }
    },
    async withSlot<T>(_agentId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
      while (world.inUse >= world.slots) {
        await new Promise<void>((resolve, reject) => {
          waiters.push(resolve)
          if (!world.ignoreAbort) signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
        })
      }
      world.inUse += 1
      try { return await run() } finally {
        world.inUse -= 1
        waiters.shift()?.()
      }
    },
    slotFree: () => world.slotFree,
    async trust(_userId: string, taskId: string, digest: string) { taskRepo.setTrustedDigest(USER, taskId, digest) },
    async refreshTask(_userId: string, taskId: string) {
      world.refreshed.push(taskId)
      await world.refresh?.(taskId)
    },
    liveAgentIds: () => world.live,
    publish: (agentId: string | null) => { world.published.push(agentId) },
    grant: () => {
      world.slots += 1
      waiters.shift()?.()
    }
  }
}

/** Let a debounced wake and its pass run, and whatever the pass started settle. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, WAKE_DEBOUNCE_MS + 40))
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

let seq = 0
/** A Ready task assigned to `agentId`; `file` makes it a folder task in `dir`. */
function ready(agentId: string, options: {
  title?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  createdAt?: Date
  file?: { key: string; blockedBy?: string[]; digest?: string; trusted?: boolean; folder?: string }
} = {}) {
  seq += 1
  const file = options.file
  const folder = file?.folder ?? dir
  const digest = file?.digest ?? `digest-${seq}`
  const created = taskRepo.create(USER, {
    title: options.title ?? `Task ${seq}`,
    goal: options.title ?? `Task ${seq}`,
    priority: options.priority,
    status: 'open',
    assigneeAgentId: agentId,
    assigneeName: agentId,
    assigneeKind: 'agent',
    ...(file ? {
      remoteKey: file.key,
      localFile: { path: join(folder, '.cinna', 'tasks', `${file.key}.md`), digest, readOnlyFields: [], blockedBy: file.blockedBy ?? [] },
      trustedDigest: file.trusted === false ? null : digest,
      deviceLocal: true
    } : {})
  })
  if (options.createdAt) holder.current!.sqlite.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Math.floor(options.createdAt.getTime() / 1000), created.id)
  return created
}

function statusOf(taskId: string): string | undefined {
  return taskRepo.getById(USER, taskId)?.status
}

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.userData = mkdtempSync(join(tmpdir(), 'cinna-dispatch-ud-'))
  dir = mkdtempSync(join(tmpdir(), 'cinna-dispatch-'))
  world = {
    agents: [{ id: 'agent-a', name: 'Alpha', path: dir }],
    starts: [], live: [], slots: 2, inUse: 0, slotFree: true, startError: null,
    refresh: null, refreshed: [], published: [], ignoreAbort: false, grant: () => {}
  }
  const built = deps()
  world.grant = built.grant
  service = createTaskDispatchService(built)
  // The production module registered its own instance; these tests drive theirs.
  setDispatchOwnedTurnSettler((end) => service.settleOwnedTurn(end))
  setDispatchableAgentsSource(async () => new Set(world.agents.map((agent) => agent.id)))
})

afterEach(async () => {
  service.shutdown()
  await new Promise((resolve) => setImmediate(resolve))
  holder.current?.close()
  holder.current = null
  rmSync(holder.userData, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe('selection', () => {
  it('takes the highest priority first, then the oldest, and never another agent’s or a non-Ready task', async () => {
    const old = ready('agent-a', { title: 'Old normal', createdAt: new Date('2026-01-01') })
    ready('agent-a', { title: 'New normal', createdAt: new Date('2026-02-01') })
    const urgent = ready('agent-a', { title: 'Urgent', priority: 'urgent', createdAt: new Date('2026-03-01') })
    ready('agent-b', { title: 'Someone else’s', priority: 'urgent' })
    const backlog = taskService.create(USER, { title: 'Backlog', goal: 'B', assigneeAgentId: 'agent-a', assigneeKind: 'agent', priority: 'urgent' })

    expect((await service.get(SCOPE, 'agent-a'))?.next?.taskId).toBe(urgent.id)
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([urgent.id])

    world.starts[0].end('completed')
    taskService.setStatus(USER, urgent.id, 'completed')
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([urgent.id, old.id])
    expect(statusOf(backlog.id)).toBe('new')
  })

  it('skips a task with an open ask', async () => {
    const asked = ready('agent-a', { priority: 'urgent' })
    const plain = ready('agent-a')
    const chat = chatRepo.create(USER, { agentId: 'agent-a' })
    taskInputRequestRepo.open({
      requestId: 'ask-1', taskId: asked.id, chatId: chat.id, agentId: 'agent-a', resume: 'next_message',
      request: { kind: 'question', questions: [{ question: 'Which?', options: [], multiSelect: false }] }
    })
    expect((await service.get(SCOPE, 'agent-a'))?.next?.taskId).toBe(plain.id)
  })

  it('runs a file task only when every blocked_by id is a completed task in the same folder', async () => {
    const other = mkdtempSync(join(tmpdir(), 'cinna-dispatch-other-'))
    try {
      const blocked = ready('agent-a', { priority: 'urgent', file: { key: 't-blocked', blockedBy: ['t-first', 't-missing'] } })
      const first = ready('agent-a', { priority: 'low', file: { key: 't-first' } })
      // The same key in another folder is not the blocker.
      const elsewhere = ready('agent-z', { file: { key: 't-missing', folder: other } })
      taskService.setStatus(USER, elsewhere.id, 'in_progress')
      taskService.setStatus(USER, elsewhere.id, 'completed')

      const dto = taskService.getById(USER, blocked.id)
      expect(dto.blockedBy).toEqual([
        { id: 't-first', taskId: first.id, title: first.title, done: false },
        { id: 't-missing', taskId: null, title: null, done: false }
      ])
      expect((await service.get(SCOPE, 'agent-a'))?.next?.taskId).toBe(first.id)

      // The first blocker done; the missing id still blocks (mutation: treat a
      // missing id as done → the blocked task becomes next).
      taskService.setStatus(USER, first.id, 'in_progress')
      taskService.setStatus(USER, first.id, 'completed')
      expect(taskService.getById(USER, blocked.id).blockedBy[0].done).toBe(true)
      expect((await service.get(SCOPE, 'agent-a'))?.next).toBeNull()

      ready('agent-a', { file: { key: 't-missing' } })
      const missing = taskRepo.list(USER).find((row) => row.remoteKey === 't-missing' && row.assigneeAgentId === 'agent-a')!
      taskService.setStatus(USER, missing.id, 'in_progress')
      taskService.setStatus(USER, missing.id, 'completed')
      expect((await service.get(SCOPE, 'agent-a'))?.next?.taskId).toBe(blocked.id)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('continues a Ready task that already has a conversation in it', async () => {
    const task = ready('agent-a')
    const chat = chatRepo.create(USER, { agentId: 'agent-a' })
    taskRepo.update(USER, task.id, { chatId: chat.id })
    const result = await service.runNext(SCOPE, 'agent-a')
    expect(result).toEqual({ ok: true, taskId: task.id, chatId: chat.id })
    expect(world.starts[0].continueInChat).toBe(true)
  })
})

describe('exclusivity', () => {
  it('runs one dispatched task per agent and holds a runner slot until the turn ends', async () => {
    const first = ready('agent-a', { priority: 'high' })
    const second = ready('agent-a')
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    service.wake()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id])
    expect(world.inUse).toBe(1)
    expect((await service.get(SCOPE, 'agent-a'))?.running).toEqual({ taskId: first.id, chatId: world.starts[0].chatId, title: first.title })

    taskService.setStatus(USER, first.id, 'completed')
    world.starts[0].end('completed')
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id, second.id])
    expect(world.inUse).toBe(1)
  })

  it('runs one dispatched task per folder, across agents that share it', async () => {
    world.agents.push({ id: 'agent-b', name: 'Beta', path: join(dir, '.') })
    ready('agent-a')
    ready('agent-b')
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    agentTaskDispatchRepo.setMode(USER, 'agent-b', 'one')
    service.start(SCOPE)
    await drain()
    expect(world.starts).toHaveLength(1)
    const idle = world.starts[0].agentId === 'agent-a' ? 'agent-b' : 'agent-a'
    expect((await service.get(SCOPE, idle))?.waiting).toBe('folder_busy')
    expect(await service.runNext(SCOPE, idle)).toMatchObject({ ok: false, code: 'folder_busy' })
  })

  it('never starts while any turn runs in the folder, and starts once it ends', async () => {
    ready('agent-a')
    world.live = ['agent-a']
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    expect(world.starts).toHaveLength(0)
    expect((await service.get(SCOPE, 'agent-a'))?.waiting).toBe('live_turn')
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: false, code: 'live_turn' })

    world.live = []
    service.wake()
    await drain()
    expect(world.starts).toHaveLength(1)
  })

  it('waits for a global slot, showing why', async () => {
    const task = ready('agent-a')
    world.slots = 0
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    expect(world.starts).toHaveLength(0)
    expect(await service.get(SCOPE, 'agent-a')).toMatchObject({ waiting: 'slot', next: { taskId: task.id }, running: null })
    // Switching to manual abandons the queue's own wait.
    await service.setMode(SCOPE, 'agent-a', 'manual')
    await drain()
    expect((await service.get(SCOPE, 'agent-a'))?.waiting).toBeNull()
  })
})

describe('the report rule', () => {
  async function dispatchOne(options: Parameters<typeof ready>[1] = {}) {
    const task = ready('agent-a', { priority: 'urgent', ...options })
    const next = ready('agent-a', { priority: 'low' })
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id])
    expect(isDispatchedRun(world.starts[0].chatId, world.starts[0].runId)).toBe(true)
    return { task, next, started: world.starts[0] }
  }

  it('continues the queue when the agent reported with task_update', async () => {
    const { task, next, started } = await dispatchOne()
    taskService.setStatus(USER, task.id, 'blocked')
    started.end('completed')
    await drain()
    await drain()
    expect(statusOf(task.id)).toBe('blocked')
    expect(taskRepo.getById(USER, task.id)?.dispatchNote).toBeNull()
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id, next.id])
    expect(isDispatchedRun(started.chatId, started.runId)).toBe(false)
  })

  it('reads the task file again before deciding, so a status word the agent wrote counts', async () => {
    // Mutation: skip the re-read → the in-flight word is missed and the task is flagged.
    const { task, started } = await dispatchOne({ file: { key: 't-word' } })
    world.refresh = (taskId) => { taskService.acceptRemoteStatus(USER, taskId, 'completed') }
    started.end('completed')
    await drain()
    expect(world.refreshed).toContain(task.id)
    expect(statusOf(task.id)).toBe('completed')
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
  })

  it('takes a delegated task’s handover_report (its status write) as the report', async () => {
    const { task, started } = await dispatchOne()
    taskService.acceptRemoteResult(USER, task.id, { status: 'completed', handoffNote: 'Done.', artifacts: [] })
    started.end('completed')
    await drain()
    expect(statusOf(task.id)).toBe('completed')
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
  })

  it('flags a task whose turn ended without a report, and pauses the queue', async () => {
    // Mutation: let `endTurn` settle a dispatched task → it completes instead.
    const { task, next, started } = await dispatchOne()
    inboxService.recordRunEvent({ userId: USER, chatId: started.chatId, agentId: 'agent-a', turnId: started.runId, rootRunId: started.runId, completionOwner: 'turn' },
      { type: 'done', stopReason: 'end_turn' })
    expect(statusOf(task.id)).toBe('in_progress')
    started.end('completed')
    await drain()
    await drain()
    const row = taskRepo.getById(USER, task.id)!
    expect(row.status).toBe('blocked')
    expect(row.dispatchNote).toBe(DISPATCH_NOTE_UNREPORTED)
    expect(taskService.getById(USER, task.id).dispatchNote).toBe(DISPATCH_NOTE_UNREPORTED)
    const state = await service.get(SCOPE, 'agent-a')
    expect(state?.paused).toMatchObject({ reason: 'unreported', taskId: task.id, taskTitle: task.title })
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id])
    expect(statusOf(next.id)).toBe('open')
    // The Inbox names the paused queue on the flagged task.
    const inbox = await inboxService.list(USER)
    expect(inbox.dispatch).toEqual([expect.objectContaining({
      kind: 'dispatch_paused', agentId: 'agent-a', reason: 'unreported', taskId: task.id, note: DISPATCH_NOTE_UNREPORTED
    })])
    // Moving the task on clears the note.
    taskService.setStatus(USER, task.id, 'in_progress')
    expect(taskRepo.getById(USER, task.id)?.dispatchNote).toBeNull()
  })

  it('maps a failed turn to error and pauses', async () => {
    const { task, started } = await dispatchOne()
    started.end('failed', { error: { message: 'The engine crashed.' } })
    await drain()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'error', errorMessage: 'The engine crashed.' })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBe('error')
  })

  it('maps a Stop to cancelled and pauses', async () => {
    const { task, started } = await dispatchOne()
    started.end('canceled')
    await drain()
    expect(statusOf(task.id)).toBe('cancelled')
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ pausedReason: 'stopped', pausedTaskId: task.id })
  })

  it('leaves a task that ended on an open question to its ask, and the queue continues', async () => {
    const { task, next, started } = await dispatchOne()
    taskInputRequestRepo.open({
      requestId: 'ask-2', taskId: task.id, chatId: started.chatId, agentId: 'agent-a', resume: 'next_message',
      request: { kind: 'question', questions: [{ question: 'Which?', options: [], multiSelect: false }] }
    })
    taskService.applyRunState(USER, task.id, 'needs_input')
    started.end('needs_input')
    await drain()
    await drain()
    expect(statusOf(task.id)).toBe('blocked')
    expect(taskRepo.getById(USER, task.id)?.dispatchNote).toBeNull()
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id, next.id])
  })

  it('pauses on a task the queue could not start', async () => {
    const task = ready('agent-a')
    world.startError = 'That agent is unavailable.'
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ pausedReason: 'error', pausedTaskId: task.id, activeTaskId: null })
  })
})

describe('back in Ready or Backlog is no report', () => {
  async function dispatchFile(key: string) {
    const task = ready('agent-a', { priority: 'urgent', file: { key } })
    const next = ready('agent-a', { priority: 'low' })
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id])
    return { task, next, started: world.starts[0] }
  }

  function expectFlagged(taskId: string, nextId: string) {
    expect(taskRepo.getById(USER, taskId)).toMatchObject({ status: 'blocked', dispatchNote: DISPATCH_NOTE_UNREPORTED })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: taskId })
    // Not run again.
    expect(world.starts.map((s) => s.taskId)).toEqual([taskId])
    expect(statusOf(nextId)).toBe('open')
  }

  it('flags a task the agent moved back to Ready with task_update', async () => {
    // Mutation: count any status but in_progress as a report → the queue runs it again.
    const { task, next, started } = await dispatchFile('t-back')
    taskService.acceptRemoteStatus(USER, task.id, 'open')
    started.end('completed')
    await drain()
    await drain()
    expectFlagged(task.id, next.id)
  })

  it('flags a task whose file word now maps to Ready or Backlog', async () => {
    const { task, next, started } = await dispatchFile('t-word-ready')
    // The re-read finds the word `next` (Ready) the agent wrote.
    world.refresh = (taskId) => { taskService.acceptRemoteStatus(USER, taskId, 'open') }
    started.end('completed')
    await drain()
    await drain()
    expect(world.refreshed).toContain(task.id)
    expectFlagged(task.id, next.id)
  })

  it('flags a task whose file word now maps to Backlog', async () => {
    const { task, next, started } = await dispatchFile('t-word-backlog')
    world.refresh = (taskId) => { taskService.acceptRemoteStatus(USER, taskId, 'new') }
    started.end('completed')
    await drain()
    await drain()
    expectFlagged(task.id, next.id)
  })
})

describe('after the slot wait', () => {
  async function waiting() {
    const task = ready('agent-a', { priority: 'high', file: { key: 't-wait', digest: 'd1' } })
    const next = ready('agent-a', { priority: 'low' })
    world.slots = 0
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    expect(await service.get(SCOPE, 'agent-a')).toMatchObject({ waiting: 'slot', next: { taskId: task.id } })
    return { task, next }
  }

  /** No pause; whatever runs now is the next task, not the one that waited. */
  function expectQuietEnd(nextId: string | null) {
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ pausedReason: null, pausedTaskId: null, activeTaskId: nextId })
  }

  it('lets the user’s own turn on the waiting task settle normally, then ends the flight quietly and moves on', async () => {
    // Mutations: mark the task (not the dispatched run) at launch → the user's
    // turn is skipped and the task stays in_progress; drop the re-check → the
    // flight starts a completed task and pauses on the refusal.
    const { task, next } = await waiting()
    const chat = chatRepo.create(USER, { agentId: 'agent-a' })
    taskService.beginDesktopChat(USER, task.id, chat.id, { kind: 'agent', agentId: 'agent-a', name: 'a' })
    inboxService.recordRunEvent({ userId: USER, chatId: chat.id, agentId: 'agent-a', turnId: 'user-run', rootRunId: 'user-run', completionOwner: 'turn' },
      { type: 'done', stopReason: 'end_turn' })
    expect(statusOf(task.id)).toBe('completed')

    world.grant()
    await drain()
    await drain()
    expectQuietEnd(next.id)
    expect(statusOf(task.id)).toBe('completed')
    expect(world.starts.map((s) => s.taskId)).toEqual([next.id])
  })

  it('ends quietly when the task was reassigned or deleted meanwhile', async () => {
    const { task, next } = await waiting()
    taskRepo.update(USER, task.id, { assigneeAgentId: 'agent-z', assigneeName: 'agent-z' })
    world.grant()
    await drain()
    await drain()
    expectQuietEnd(next.id)
    expect(world.starts.map((s) => s.taskId)).toEqual([next.id])
  })

  it('sends content rewritten outside Cinna meanwhile to the gate instead of running it', async () => {
    const { task, next } = await waiting()
    const row = taskRepo.getById(USER, task.id)!
    taskRepo.update(USER, task.id, { localFile: { ...row.localFile!, digest: 'd2' } })
    world.grant()
    await drain()
    await drain()
    expectQuietEnd(next.id)
    expect(taskDispatchGateRepo.listOpen(USER)).toEqual([expect.objectContaining({ taskId: task.id, digest: 'd2' })])
    expect(world.starts.map((s) => s.taskId)).toEqual([next.id])
  })

  it('starts nothing when Cinna is quitting by the time the slot comes', async () => {
    // Mutation: drop the quitting/abort check → the task starts during shutdown.
    world.ignoreAbort = true
    await waiting()
    service.shutdown()
    world.grant()
    await drain()
    expect(world.starts).toHaveLength(0)
  })

  it('starts nothing when the queue’s wait was abandoned by the time the slot comes', async () => {
    world.ignoreAbort = true
    const { task } = await waiting()
    await service.setMode(SCOPE, 'agent-a', 'manual')
    world.grant()
    await drain()
    expect(world.starts).toHaveLength(0)
    expect(statusOf(task.id)).toBe('open')
    expectQuietEnd(null)
  })
})

describe('a non-dispatched turn', () => {
  it('keeps today’s settlement', () => {
    const task = ready('agent-a')
    const chat = chatRepo.create(USER, { agentId: 'agent-a' })
    taskService.beginDesktopChat(USER, task.id, chat.id, { kind: 'agent', agentId: 'agent-a', name: 'a' })
    // Another run of the same chat is dispatched; this one is not.
    markDispatchedRun(chat.id, 'another-run')
    try {
      inboxService.recordRunEvent({ userId: USER, chatId: chat.id, agentId: 'agent-a', turnId: 't', rootRunId: 't', completionOwner: 'turn' },
        { type: 'done', stopReason: 'end_turn' })
    } finally {
      clearDispatchedRun(chat.id, 'another-run')
    }
    expect(statusOf(task.id)).toBe('completed')
  })
})

describe('boot recovery', () => {
  it('flags the task a run was interrupted on, pauses its queue and clears the in-flight row', () => {
    const task = ready('agent-a')
    const chat = chatRepo.create(USER, { agentId: 'agent-a' })
    taskService.beginDesktopChat(USER, task.id, chat.id, { kind: 'agent', agentId: 'agent-a', name: 'a' })
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    agentTaskDispatchRepo.setActive(USER, 'agent-a', task.id, chat.id)

    service.recoverInterrupted()

    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', dispatchNote: DISPATCH_NOTE_INTERRUPTED })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({
      mode: 'one', pausedReason: 'interrupted', pausedTaskId: task.id, activeTaskId: null, activeChatId: null
    })
  })

  it('leaves the in-flight row for the next boot when Cinna quits under a run', async () => {
    const task = ready('agent-a')
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    service.shutdown()
    world.starts[0].end('canceled')
    await drain()
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ activeTaskId: task.id, pausedReason: null })
    expect(statusOf(task.id)).toBe('in_progress')
  })
})

describe('the outside-content gate', () => {
  it('asks once per content, moves on meanwhile, and runs the task once approved', async () => {
    const outside = ready('agent-a', { priority: 'urgent', file: { key: 't-out', trusted: false, digest: 'd1' } })
    const plain = ready('agent-a', { priority: 'low' })
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    service.wake()
    await drain()
    // The queue moved on to the next task; one card for the outside one.
    expect(world.starts.map((s) => s.taskId)).toEqual([plain.id])
    const cards = (await inboxService.list(USER)).dispatch!.filter((item) => item.kind === 'dispatch_gate')
    expect(cards).toHaveLength(1)
    const card = cards[0] as Extract<typeof cards[number], { kind: 'dispatch_gate' }>
    expect(card).toMatchObject({ taskId: outside.id, agentId: 'agent-a', filePath: join(dir, '.cinna', 'tasks', 't-out.md') })
    expect(card.body).toBe(taskContinuationPrompt(taskService.getById(USER, outside.id)))
    expect(JSON.stringify(card)).not.toContain('d1')

    // Run next on the gated task opens the card instead of running it.
    world.starts[0].end('completed')
    taskService.setStatus(USER, plain.id, 'completed')
    await drain()
    expect(await service.runNext(SCOPE, 'agent-a', outside.id)).toEqual({ ok: true, gate: card.gateId })

    // Approve: trusted, and run at once since the folder is free.
    const answer = await service.answerGate(SCOPE, card.gateId, 'approve')
    expect(answer).toMatchObject({ ok: true, started: { taskId: outside.id } })
    expect(taskRepo.getById(USER, outside.id)?.trustedDigest).toBe('d1')
    expect(world.starts.at(-1)?.taskId).toBe(outside.id)
    expect(await service.answerGate(SCOPE, card.gateId, 'approve')).toMatchObject({ ok: false, code: 'already_answered' })
  })

  it('reports a gated queue as the next task needing approval until a card is open, in manual mode too', async () => {
    // Mutation: report `waiting: 'gate'` without an open card → no `next`, and the state reads as a card that is not there.
    const outside = ready('agent-a', { file: { key: 't-out', trusted: false, digest: 'd1' } })
    expect(await service.get(SCOPE, 'agent-a')).toMatchObject({
      mode: 'manual', next: { taskId: outside.id, title: outside.title, needsApproval: true }, waiting: null
    })
    // Run next opens the card: now the queue waits on it.
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: true, gate: expect.any(String) })
    expect(await service.get(SCOPE, 'agent-a')).toMatchObject({ next: null, waiting: 'gate' })
    expect(world.starts).toHaveLength(0)
  })

  it('reports the top gated task as needing approval while the queue is paused', async () => {
    const outside = ready('agent-a', { file: { key: 't-out', trusted: false, digest: 'd1' } })
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    agentTaskDispatchRepo.pause(USER, 'agent-a', 'unreported', null)
    service.start(SCOPE)
    await drain()
    expect(taskDispatchGateRepo.listOpen(USER)).toHaveLength(0)
    expect(await service.get(SCOPE, 'agent-a')).toMatchObject({ next: { taskId: outside.id, needsApproval: true }, waiting: null })
  })

  it('asks no more for skipped content, and asks again when the file changes', async () => {
    const outside = ready('agent-a', { file: { key: 't-out', trusted: false, digest: 'd1' } })
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    expect((await service.get(SCOPE, 'agent-a'))?.waiting).toBe('gate')
    const first = taskDispatchGateRepo.listOpen(USER)
    expect(first).toHaveLength(1)
    world.published = []
    expect(await service.answerGate(SCOPE, first[0].id, 'skip')).toEqual({ ok: true, started: null, mode: 'one' })
    // Mutation: drop the skip's notification → other surfaces keep the card.
    expect(world.published).toContain('agent-a')
    service.wake()
    await drain()
    expect(taskDispatchGateRepo.listOpen(USER)).toHaveLength(0)
    expect(world.starts).toHaveLength(0)
    // Skipped: no card is open, so the task is next and needs approval.
    expect(await service.get(SCOPE, 'agent-a')).toMatchObject({ next: { taskId: outside.id, needsApproval: true }, waiting: null })

    // The file changes: a new card for the new content.
    const row = taskRepo.getById(USER, outside.id)!
    taskRepo.update(USER, outside.id, { localFile: { ...row.localFile!, digest: 'd2' } })
    service.wake()
    await drain()
    const second = taskDispatchGateRepo.listOpen(USER)
    expect(second).toHaveLength(1)
    expect(second[0].digest).toBe('d2')

    // An answer to a card whose content changed under it is refused.
    taskRepo.update(USER, outside.id, { localFile: { ...row.localFile!, digest: 'd3' } })
    expect(await service.answerGate(SCOPE, second[0].id, 'approve')).toMatchObject({ ok: false, code: 'changed' })
    expect(taskRepo.getById(USER, outside.id)?.trustedDigest).toBeNull()
  })

  it('makes an approved task eligible when its agent is busy', async () => {
    const plain = ready('agent-a', { priority: 'urgent' })
    const outside = ready('agent-a', { file: { key: 't-out', trusted: false, digest: 'd1' } })
    expect(await service.runNext(SCOPE, 'agent-a', plain.id)).toMatchObject({ ok: true, taskId: plain.id })
    expect(await service.runNext(SCOPE, 'agent-a', outside.id)).toMatchObject({ ok: false, code: 'agent_busy' })
    // In manual mode only Run next opens the card; approve it while a turn
    // holds the folder.
    world.starts[0].end('completed')
    taskService.setStatus(USER, plain.id, 'completed')
    await drain()
    const card = await service.runNext(SCOPE, 'agent-a', outside.id)
    expect(card).toMatchObject({ ok: true, gate: expect.any(String) })
    world.live = ['agent-a']
    world.published = []
    const changed: string[] = []
    installTaskRunnerHooks({ answer: () => null, taskChanged: (_u, taskId) => { changed.push(taskId) }, chatRemoved: () => {}, profileRemoved: () => {} }, 'dispatch-test')
    const answer = await service.answerGate(SCOPE, (card as { gate: string }).gate, 'approve')
    expect(answer).toEqual({ ok: true, started: null, reason: 'live_turn', mode: 'manual' })
    expect(taskService.getById(USER, outside.id).fromOutside).toBe(false)
    // Mutation: drop the approval's notifications → nothing tells the task page or the queue.
    expect(world.published).toContain('agent-a')
    expect(changed).toContain(outside.id)
    world.live = []
    expect((await service.get(SCOPE, 'agent-a'))?.next).toEqual({ taskId: outside.id, title: outside.title, needsApproval: false })
  })

  it('approves and runs in manual mode and while paused, without resuming, and says why when it cannot start', async () => {
    // Mutation: approve only trusting (no start) → `started` stays null.
    const outside = ready('agent-a', { file: { key: 't-out', trusted: false, digest: 'd1' } })
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    agentTaskDispatchRepo.pause(USER, 'agent-a', 'error', null)
    const card = await service.runNext(SCOPE, 'agent-a', outside.id) as { gate: string }
    expect(await service.answerGate(SCOPE, card.gate, 'approve')).toEqual({
      ok: true, started: { taskId: outside.id, chatId: world.starts[0].chatId }, mode: 'one'
    })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBe('error')

    // A second agent in another folder: its approval waits for a slot.
    const other = mkdtempSync(join(tmpdir(), 'cinna-dispatch-b-'))
    try {
      world.agents.push({ id: 'agent-b', name: 'Beta', path: other })
      const second = ready('agent-b', { file: { key: 't-b', trusted: false, digest: 'd2', folder: other } })
      const secondCard = await service.runNext(SCOPE, 'agent-b', second.id) as { gate: string }
      world.slotFree = false
      expect(await service.answerGate(SCOPE, secondCard.gate, 'approve')).toEqual({ ok: true, started: null, reason: 'slot', mode: 'manual' })
      // And one sharing agent-a's busy folder reports the folder.
      world.slotFree = true
      world.agents.push({ id: 'agent-c', name: 'Gamma', path: dir })
      const third = ready('agent-c', { file: { key: 't-c', trusted: false, digest: 'd3' } })
      const thirdCard = await service.runNext(SCOPE, 'agent-c', third.id)
      expect(thirdCard).toMatchObject({ ok: false, code: 'folder_busy' })
      const gate = taskDispatchGateRepo.open(USER, {
        taskId: third.id, agentId: 'agent-c', digest: 'd3', title: third.title, filePath: null, body: 'b'
      })
      expect(await service.answerGate(SCOPE, gate.id, 'approve')).toEqual({ ok: true, started: null, reason: 'folder_busy', mode: 'manual' })
      expect(taskRepo.getById(USER, third.id)?.trustedDigest).toBe('d3')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('pause cards', () => {
  it('lists a paused queue only for an agent that can still work one (disabled or gone agents drop out)', async () => {
    // Mutation: drop the dispatchable filter → the orphan cards are listed.
    vi.spyOn(localAgentService, 'list').mockReturnValue({
      agents: [
        { id: 'agent-a', name: 'Alpha', path: dir, enabled: true },
        { id: 'agent-off', name: 'Off', path: dir, enabled: false },
        { id: 'agent-overridden', name: 'Overridden', path: dir, enabled: true }
      ]
    } as unknown as ReturnType<typeof localAgentService.list>)
    agentOverrideRepo.set(USER, 'agent-overridden', false)
    setDispatchableAgentsSource(dispatchableAgentIds)
    try {
      for (const agentId of ['agent-a', 'agent-off', 'agent-overridden', 'agent-gone']) {
        agentTaskDispatchRepo.pause(USER, agentId, 'unreported', null)
      }
      const paused = (await inboxService.list(USER)).dispatch!.filter((item) => item.kind === 'dispatch_paused')
      expect(paused.map((item) => item.agentId)).toEqual(['agent-a'])
      // The rows stay, so an agent that comes back keeps its pause.
      expect(agentTaskDispatchRepo.get(USER, 'agent-gone').pausedReason).toBe('unreported')

      // The same for an approval card: nobody can run that queue.
      for (const agentId of ['agent-a', 'agent-off']) {
        const gated = ready(agentId, { file: { key: `t-${agentId}`, trusted: false, digest: `d-${agentId}` } })
        taskDispatchGateRepo.open(USER, { taskId: gated.id, agentId, digest: `d-${agentId}`, title: gated.title, filePath: null, body: 'Continue this task.' })
      }
      const gates = (await inboxService.list(USER)).dispatch!.filter((item) => item.kind === 'dispatch_gate')
      expect(gates.map((item) => item.agentId)).toEqual(['agent-a'])
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('a turn resumed after a dispatched ask', () => {
  /** A dispatched turn that ends on a next_message ask; the queue moves on. */
  async function dispatchedThenAsk(beforeAnswer: ((taskId: string) => void) | null = null, options: Parameters<typeof ready>[1] = {}) {
    const task = ready('agent-a', { priority: 'urgent', ...options })
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    const started = world.starts[0]
    taskInputRequestRepo.open({
      requestId: 'ask-r', taskId: task.id, chatId: started.chatId, agentId: 'agent-a', resume: 'next_message',
      request: { kind: 'question', questions: [{ question: 'Which?', options: [], multiSelect: false }] }
    })
    taskService.applyRunState(USER, task.id, 'needs_input')
    inboxService.recordRunEvent({ userId: USER, chatId: started.chatId, agentId: 'agent-a', turnId: started.runId, rootRunId: started.runId, completionOwner: 'turn' },
      { type: 'done', stopReason: 'end_turn' })
    started.end('needs_input')
    await drain()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', dispatchAgentId: 'agent-a' })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
    beforeAnswer?.(task.id)
    // The answer resumes the chat (as `inboxService.resumeChat` does).
    if (!beforeAnswer) inboxService.resumeChat({ userId: USER, chatId: started.chatId, agentId: 'agent-a', turnId: 'resumed', rootRunId: 'resumed', completionOwner: 'turn' }, 'This one.')
    if (!beforeAnswer) expect(statusOf(task.id)).toBe('in_progress')
    const end = (event: { type: 'done'; stopReason?: string } | { type: 'error'; error: string }): void => {
      inboxService.recordRunEvent({ userId: USER, chatId: started.chatId, agentId: 'agent-a', turnId: 'resumed', rootRunId: 'resumed', completionOwner: 'turn' },
        event as Parameters<typeof inboxService.recordRunEvent>[1])
    }
    return { task, started, end }
  }

  it('flags the task and pauses the queue when the resumed turn ends without a report', async () => {
    // Mutation: drop the owned-turn hand-over in `endTurn` → the task completes as an ordinary turn.
    const { task, end } = await dispatchedThenAsk()
    end({ type: 'done', stopReason: 'end_turn' })
    await drain()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', dispatchNote: DISPATCH_NOTE_UNREPORTED, dispatchAgentId: null })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: task.id })
  })

  it('keeps the report when the resumed turn reported', async () => {
    const { task, end } = await dispatchedThenAsk()
    taskService.setStatus(USER, task.id, 'completed')
    expect(taskRepo.getById(USER, task.id)?.dispatchAgentId).toBeNull()
    end({ type: 'done', stopReason: 'end_turn' })
    await drain()
    expect(statusOf(task.id)).toBe('completed')
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
  })

  it('keeps a blocked report, and gives the task up', async () => {
    // Mutation: skip the release on a report → the task stays the queue's.
    const { task, end } = await dispatchedThenAsk()
    taskService.setStatus(USER, task.id, 'blocked')
    end({ type: 'done', stopReason: 'end_turn' })
    await drain()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', dispatchNote: null, dispatchAgentId: null })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
  })

  it('maps an error to error and pauses', async () => {
    const { task, end } = await dispatchedThenAsk()
    end({ type: 'error', error: 'The engine crashed.' })
    await drain()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'error', errorMessage: 'The engine crashed.', dispatchAgentId: null })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ pausedReason: 'error', pausedTaskId: task.id })
  })

  it('maps a Stop to cancelled and pauses', async () => {
    const { task, end } = await dispatchedThenAsk()
    end({ type: 'done', stopReason: 'canceled' })
    await drain()
    expect(statusOf(task.id)).toBe('cancelled')
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ pausedReason: 'stopped', pausedTaskId: task.id })
  })

  it('starts no next task while the resumed turn is being settled, and moves on once its pause is written', async () => {
    // Mutation: drop the settling checks (agent and folder) in `pass` → the slow re-read lets a pass start the next task first.
    const { task, end } = await dispatchedThenAsk(null, { file: { key: 't-owned' } })
    const next = ready('agent-a', { priority: 'low' })
    let release!: () => void
    world.refresh = () => new Promise<void>((resolve) => { release = resolve })
    end({ type: 'done', stopReason: 'end_turn' })
    // The turn closing wakes the queue while the file is still being read.
    service.wake()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id])
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: false, code: 'agent_busy' })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()

    release()
    await drain()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', dispatchNote: DISPATCH_NOTE_UNREPORTED })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: task.id })
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id])
    expect(statusOf(next.id)).toBe('open')
  })

  it('treats the settling agent’s folder as busy for another agent there', async () => {
    // Mutation: drop the settling-folder check in `pass` → the other agent starts in the folder mid-settle.
    world.agents.push({ id: 'agent-b', name: 'Beta', path: dir })
    const { task, end } = await dispatchedThenAsk(null, { file: { key: 't-owned-b' } })
    const other = ready('agent-b')
    agentTaskDispatchRepo.setMode(USER, 'agent-b', 'one')
    let release!: () => void
    world.refresh = () => new Promise<void>((resolve) => { release = resolve })
    end({ type: 'done', stopReason: 'end_turn' })
    service.wake()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id])
    expect((await service.get(SCOPE, 'agent-b'))?.waiting).toBe('folder_busy')
    expect(await service.runNext(SCOPE, 'agent-b')).toMatchObject({ ok: false, code: 'folder_busy' })

    release()
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id, other.id])
  })

  it('is flagged at the next boot when Cinna quit under it, and its end on the way out completes nothing', async () => {
    // Mutation: drop the owned-task pass in `recoverInterrupted` → the task stays Active and the queue unpaused.
    const { task, end } = await dispatchedThenAsk()
    service.shutdown()
    end({ type: 'done', stopReason: 'end_turn' })
    await drain()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'in_progress', dispatchAgentId: 'agent-a' })

    service.recoverInterrupted()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', dispatchNote: DISPATCH_NOTE_INTERRUPTED, dispatchAgentId: null })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ pausedReason: 'interrupted', pausedTaskId: task.id })
  })

  it('is left alone at boot while it still waits on an open ask', async () => {
    const { task } = await dispatchedThenAsk((taskId) => {
      // Back in Active with its ask still open (the answer never resumed it).
      holder.current!.sqlite.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId)
    })
    service.shutdown()
    service.recoverInterrupted()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'in_progress', dispatchAgentId: 'agent-a' })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
  })

  it('is given up when the task is taken over or handed to its remote', async () => {
    // Mutation: drop the clear in `taskService.takeOver` / `handOffToRemote` → the hold survives.
    const taken = ready('agent-a')
    taskRepo.setDispatchAgent(USER, taken.id, 'agent-a')
    taskService.takeOver(USER, taken.id)
    expect(taskRepo.getById(USER, taken.id)?.dispatchAgentId).toBeNull()

    const handed = ready('agent-a')
    taskRepo.update(USER, handed.id, { remoteAdapter: 'fake' })
    taskRepo.setDispatchAgent(USER, handed.id, 'agent-a')
    taskService.handOffToRemote(USER, handed.id)
    expect(taskRepo.getById(USER, handed.id)?.dispatchAgentId).toBeNull()
  })

  it('is given up when the task leaves Active and Waiting outside a turn', async () => {
    // Mutation: drop the ownership clear in `statusPatch` → a later turn in the chat is settled by the queue and pauses it.
    // While it waits on the ask, the task file's word is edited to Ready.
    const { end } = await dispatchedThenAsk((taskId) => {
      taskService.acceptRemoteStatus(USER, taskId, 'open')
      expect(taskRepo.getById(USER, taskId)?.dispatchAgentId).toBeNull()
    })
    end({ type: 'done', stopReason: 'end_turn' })
    await drain()
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
  })
})

describe('Run next', () => {
  it('runs the top task in manual mode', async () => {
    const task = ready('agent-a')
    expect((await service.get(SCOPE, 'agent-a'))?.mode).toBe('manual')
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: true, taskId: task.id })
  })

  it('works while the queue is paused, and leaves it paused', async () => {
    const task = ready('agent-a')
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    agentTaskDispatchRepo.pause(USER, 'agent-a', 'unreported', null)
    service.start(SCOPE)
    await drain()
    expect(world.starts).toHaveLength(0)
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: true, taskId: task.id })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBe('unreported')
  })

  it('refuses clearly when nothing can run, a slot is not free, or the task is not eligible', async () => {
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: false, code: 'nothing_eligible' })
    expect(await service.runNext(SCOPE, 'remote-agent')).toMatchObject({ ok: false, code: 'not_dispatchable' })
    const task = ready('agent-a')
    world.slotFree = false
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: false, code: 'slot' })
    world.slotFree = true
    const backlog = taskService.create(USER, { title: 'Later', goal: 'Later', assigneeAgentId: 'agent-a', assigneeKind: 'agent' })
    expect(await service.runNext(SCOPE, 'agent-a', backlog.id)).toMatchObject({ ok: false, code: 'not_eligible', message: 'Only a Ready task can be run.' })
    expect(world.starts).toHaveLength(0)
    expect(statusOf(task.id)).toBe('open')
  })

  it('does not pause the queue when a start it asked for fails', async () => {
    ready('agent-a')
    world.startError = 'That agent is unavailable.'
    expect(await service.runNext(SCOPE, 'agent-a')).toEqual({ ok: false, code: 'start_failed', message: 'That agent is unavailable.' })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
  })
})

describe('mode and resume', () => {
  it('resumes a paused queue, leaving the flagged task blocked, and starts the next', async () => {
    const flagged = ready('agent-a')
    const chat = chatRepo.create(USER, { agentId: 'agent-a' })
    taskService.beginDesktopChat(USER, flagged.id, chat.id, { kind: 'agent', agentId: 'agent-a', name: 'a' })
    taskService.setStatus(USER, flagged.id, 'blocked', { dispatchNote: DISPATCH_NOTE_UNREPORTED })
    const next = ready('agent-a')
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    agentTaskDispatchRepo.pause(USER, 'agent-a', 'unreported', flagged.id)
    service.start(SCOPE)
    await drain()
    expect(world.starts).toHaveLength(0)

    const resumed = await service.resume(SCOPE, 'agent-a')
    expect(resumed).toMatchObject({ ok: true, state: { paused: null, mode: 'one' } })
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([next.id])
    expect(statusOf(flagged.id)).toBe('blocked')
    expect(world.published).toContain('agent-a')
  })

  it('refuses an agent that cannot work a queue', async () => {
    expect(await service.setMode(SCOPE, 'remote-agent', 'one')).toMatchObject({ ok: false, code: 'not_dispatchable' })
    expect(agentTaskDispatchRepo.listForUser(USER)).toEqual([])
  })

  it('keeps no row for an agent back at manual and idle', async () => {
    await service.setMode(SCOPE, 'agent-a', 'one')
    expect(agentTaskDispatchRepo.listForUser(USER)).toHaveLength(1)
    await service.setMode(SCOPE, 'agent-a', 'manual')
    expect(agentTaskDispatchRepo.listForUser(USER)).toEqual([])
  })
})

describe('migration', () => {
  it('is idempotent', () => {
    expect(() => { migrateTasks(holder.current!.sqlite); migrateTasks(holder.current!.sqlite) }).not.toThrow()
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    migrateTasks(holder.current!.sqlite)
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').mode).toBe('one')
  })
})
