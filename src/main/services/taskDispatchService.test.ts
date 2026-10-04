vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

const { createTaskDispatchService, WAKE_DEBOUNCE_MS, NOT_DISPATCHABLE_ANSWER, dispatchableAgentIds } = await import('./taskDispatchService')
const { setDispatchableAgentsSource, setDispatchFolderNamesSource } = await import('./taskDispatchInbox')
const { agentService } = await import('./agentService')
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
  /** `grant` hands the slot to the newest waiter instead of the oldest (a reordered production wait). */
  grantNewest: boolean
  refreshed: string[]
  published: (string | null)[]
  /** Stored answers the dispatcher sent, in order. */
  answersSent: { requestId: string; content: string }[]
  /** Chats a turn holds now (`deps.chatRunning`). */
  runningChats: string[]
  /** How many times a flight asked for a runner slot. */
  slotRequests: number
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
    /** As `inboxService.startNextMessageTurn`: the answer resumes the chat, settling the ask in acceptance. */
    async resume(_scope: unknown, ask: { id: string; taskId: string; chatId: string; agentId: string | null }, content: string, options: {
      onRunAccepted: (run: { chatId: string; runId: string }) => void
    }) {
      if (world.startError) throw new Error(world.startError)
      const runId = `run-${world.starts.length + 1}`
      world.answersSent.push({ requestId: ask.id, content })
      inboxService.resumeChat({ userId: USER, chatId: ask.chatId, agentId: ask.agentId, turnId: runId, rootRunId: runId, completionOwner: 'turn' }, content)
      options.onRunAccepted({ chatId: ask.chatId, runId })
      let end!: (outcome: RunOutcome) => void
      const completed = new Promise<RunOutcome>((resolve) => { end = resolve })
      world.starts.push({
        taskId: ask.taskId, agentId: ask.agentId ?? '', chatId: ask.chatId, runId, continueInChat: true,
        end: (state, extra = {}) => end({ state, text: '', runId, accepted: true, inputRequestIds: [], ...extra })
      })
      return { chatId: ask.chatId, runId, completed }
    },
    chatRunning: (chatId: string) => world.runningChats.includes(chatId),
    async withSlot<T>(_agentId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
      world.slotRequests += 1
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
      ;(world.grantNewest ? waiters.pop() : waiters.shift())?.()
    }
  }
}

/**
 * Let a debounced wake and its pass run, and whatever the pass started settle.
 * The clock is fake (timeouts and intervals only): the debounce fires when
 * this advances it, never by wall time, so a slow machine cannot end the wait
 * before the pass a wake queued has run. `setImmediate` stays real.
 */
async function drain(): Promise<void> {
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS + 40)
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

/** The agent's dispatch row with its oldest run in flight, as the single-run columns read before `up_to`. */
function rowOf(agentId: string) {
  const runs = agentTaskDispatchRepo.listRuns(USER, agentId)
  return { ...agentTaskDispatchRepo.get(USER, agentId), activeTaskId: runs[0]?.taskId ?? null, activeChatId: runs[0]?.chatId ?? null, runs }
}

function statusOf(taskId: string): string | undefined {
  return taskRepo.getById(USER, taskId)?.status
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  holder.current = createTestDatabase()
  holder.userData = mkdtempSync(join(tmpdir(), 'cinna-dispatch-ud-'))
  dir = mkdtempSync(join(tmpdir(), 'cinna-dispatch-'))
  world = {
    agents: [{ id: 'agent-a', name: 'Alpha', path: dir }],
    starts: [], live: [], slots: 2, inUse: 0, slotFree: true, startError: null,
    refresh: null, refreshed: [], published: [], ignoreAbort: false, grant: () => {},
    answersSent: [], runningChats: [], slotRequests: 0, grantNewest: false
  }
  const built = deps()
  world.grant = built.grant
  service = createTaskDispatchService(built)
  // The production module registered its own instance; these tests drive theirs.
  setDispatchOwnedTurnSettler((end) => service.settleOwnedTurn(end))
  setDispatchableAgentsSource(async () => new Set(world.agents.map((agent) => agent.id)))
  setDispatchFolderNamesSource(async () => new Map(world.agents.map((agent) => [agent.id, basename(agent.path)])))
  // An Inbox answer checks that the asking agent still exists.
  vi.spyOn(agentService, 'findAgent').mockReturnValue({ row: {} as never, userId: USER })
})

afterEach(async () => {
  vi.restoreAllMocks()
  service.shutdown()
  vi.useRealTimers()
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
        { id: 't-first', taskId: first.id, title: first.title, status: 'open', done: false },
        { id: 't-missing', taskId: null, title: null, status: null, done: false }
      ])
      expect((await service.get(SCOPE, 'agent-a'))?.next?.taskId).toBe(first.id)

      // The first blocker done; the missing id still blocks (mutation: treat a
      // missing id as done → the blocked task becomes next).
      taskService.setStatus(USER, first.id, 'in_progress')
      taskService.setStatus(USER, first.id, 'completed')
      expect(taskService.getById(USER, blocked.id).blockedBy[0].done).toBe(true)
      expect(taskService.getById(USER, blocked.id).blockedBy[0].status).toBe('completed')
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

describe('a Ready task whose chat runs a turn', () => {
  function busyChat(taskId: string): string {
    const chat = chatRepo.create(USER, { agentId: 'agent-a' })
    taskRepo.update(USER, taskId, { chatId: chat.id })
    world.runningChats.push(chat.id)
    return chat.id
  }

  it('is passed over by a One at a time pass without taking a slot, and runs once the turn ends', async () => {
    // Mutation: drop `chatBusy` in `pass` → every pass takes a slot for it, refuses, and wakes again.
    const busy = ready('agent-a', { priority: 'urgent' })
    const other = ready('agent-a')
    const chatId = busyChat(busy.id)
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([other.id])
    expect(world.slotRequests).toBe(1)

    taskService.setStatus(USER, other.id, 'completed')
    world.starts[0].end('completed')
    await drain()
    await drain()
    expect(world.starts).toHaveLength(1)
    expect(world.slotRequests).toBe(1)
    world.runningChats = world.runningChats.filter((id) => id !== chatId)
    service.wake()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([other.id, busy.id])
  })

  it('is refused by Run next as a live turn, which takes the next task instead', async () => {
    // Mutation: drop the `chatBusy` refusal in `runNext` → the named task takes a slot and fails on its chat.
    const busy = ready('agent-a', { priority: 'urgent' })
    const other = ready('agent-a')
    busyChat(busy.id)
    expect(await service.runNext(SCOPE, 'agent-a', busy.id)).toMatchObject({ ok: false, code: 'live_turn' })
    expect(world.slotRequests).toBe(0)
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: true, taskId: other.id })
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
    expect((await service.get(SCOPE, 'agent-a'))?.running).toEqual([{ taskId: first.id, chatId: world.starts[0].chatId, title: first.title }])

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

  describe('a folder reached through a symlink', () => {
    let linkHome: string
    let link: string
    beforeEach(() => {
      linkHome = mkdtempSync(join(tmpdir(), 'cinna-dispatch-link-'))
      link = join(linkHome, 'linked')
      symlinkSync(dir, link, 'dir')
    })
    afterEach(() => { rmSync(linkHome, { recursive: true, force: true }) })

    it('is one folder for two One at a time agents', async () => {
      // Mutation: `folderOf` without realpath → both agents start in the one folder.
      world.agents.push({ id: 'agent-b', name: 'Beta', path: link })
      ready('agent-a')
      ready('agent-b')
      agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
      agentTaskDispatchRepo.setMode(USER, 'agent-b', 'one')
      service.start(SCOPE)
      await drain()
      expect(world.starts).toHaveLength(1)
      const idle = world.starts[0].agentId === 'agent-a' ? 'agent-b' : 'agent-a'
      expect((await service.get(SCOPE, idle))?.waiting).toBe('folder_busy')
    })

    it('makes a One at a time agent wait for a live turn and for an Up to N agent’s runs there', async () => {
      world.slots = 8
      world.agents.push({ id: 'agent-b', name: 'Beta', path: link })
      ready('agent-b')
      agentTaskDispatchRepo.setMode(USER, 'agent-b', 'one')
      world.live = ['agent-a']
      service.start(SCOPE)
      await drain()
      expect(world.starts).toHaveLength(0)
      expect((await service.get(SCOPE, 'agent-b'))?.waiting).toBe('live_turn')

      world.live = []
      const a1 = ready('agent-a', { priority: 'high' })
      agentTaskDispatchRepo.setMode(USER, 'agent-b', 'manual')
      agentTaskDispatchRepo.setMode(USER, 'agent-a', 'up_to', 2)
      service.wake()
      await drain()
      expect(world.starts.map((s) => s.taskId)).toEqual([a1.id])
      agentTaskDispatchRepo.setMode(USER, 'agent-b', 'one')
      service.wake()
      await drain()
      expect(world.starts.map((s) => s.taskId)).toEqual([a1.id])
      expect((await service.get(SCOPE, 'agent-b'))?.waiting).toBe('folder_busy')
    })
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
    expect(await service.get(SCOPE, 'agent-a')).toMatchObject({ waiting: 'slot', next: { taskId: task.id }, running: [] })
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
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'stopped', pausedTaskId: task.id })
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

  it.each(['completed', 'canceled', 'failed'] as const)('lets go of a task archived before its turn ended (%s), writes nothing and continues', async (state) => {
    // Mutation: drop the archived/deleted branch in `settleTask` → the queue pauses (unreported, stopped or error).
    const { task, next, started } = await dispatchOne()
    taskService.setStatus(USER, task.id, 'archived')
    started.end(state, state === 'failed' ? { error: { message: 'boom' } } : {})
    await drain()
    await drain()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'archived', dispatchNote: null, dispatchAgentId: null })
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: null, activeTaskId: next.id })
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id, next.id])
  })

  it.each(['completed', 'canceled'] as const)('lets go of a task deleted before its turn ended (%s) and continues', async (state) => {
    const { task, next, started } = await dispatchOne()
    taskService.remove(USER, task.id)
    started.end(state)
    await drain()
    await drain()
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ dispatchAgentId: null })
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: null, activeTaskId: next.id })
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id, next.id])
  })

  it('pauses on a task the queue could not start', async () => {
    const task = ready('agent-a')
    world.startError = 'That agent is unavailable.'
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    service.start(SCOPE)
    await drain()
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'error', pausedTaskId: task.id, activeTaskId: null })
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
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: taskId })
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
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: null, pausedTaskId: null, activeTaskId: nextId })
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
    expect(rowOf('agent-a')).toMatchObject({
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
    expect(rowOf('agent-a')).toMatchObject({ activeTaskId: task.id, pausedReason: null })
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
    expect(await service.answerGate(SCOPE, first[0].id, 'skip')).toEqual({ ok: true, started: null, mode: 'one', maxRuns: null })
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
    expect(answer).toEqual({ ok: true, started: null, reason: 'live_turn', mode: 'manual', maxRuns: null })
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
      ok: true, started: { taskId: outside.id, chatId: world.starts[0].chatId }, mode: 'one', maxRuns: null
    })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBe('error')

    // Another of agent-a's tasks, approved while its run goes: the agent is
    // busy, not the folder (mutation: fold agent_busy into folder_busy).
    const busy = ready('agent-a', { file: { key: 't-busy', trusted: false, digest: 'd4' } })
    const busyGate = taskDispatchGateRepo.open(USER, { taskId: busy.id, agentId: 'agent-a', digest: 'd4', title: busy.title, filePath: null, body: 'b' })
    expect(await service.answerGate(SCOPE, busyGate.id, 'approve')).toEqual({ ok: true, started: null, reason: 'agent_busy', mode: 'one', maxRuns: null })

    // A second agent in another folder: its approval waits for a slot.
    const other = mkdtempSync(join(tmpdir(), 'cinna-dispatch-b-'))
    try {
      world.agents.push({ id: 'agent-b', name: 'Beta', path: other })
      const second = ready('agent-b', { file: { key: 't-b', trusted: false, digest: 'd2', folder: other } })
      const secondCard = await service.runNext(SCOPE, 'agent-b', second.id) as { gate: string }
      world.slotFree = false
      expect(await service.answerGate(SCOPE, secondCard.gate, 'approve')).toEqual({ ok: true, started: null, reason: 'slot', mode: 'manual', maxRuns: null })
      // And one sharing agent-a's busy folder reports the folder.
      world.slotFree = true
      world.agents.push({ id: 'agent-c', name: 'Gamma', path: dir })
      const third = ready('agent-c', { file: { key: 't-c', trusted: false, digest: 'd3' } })
      const thirdCard = await service.runNext(SCOPE, 'agent-c', third.id)
      expect(thirdCard).toMatchObject({ ok: false, code: 'folder_busy' })
      const gate = taskDispatchGateRepo.open(USER, {
        taskId: third.id, agentId: 'agent-c', digest: 'd3', title: third.title, filePath: null, body: 'b'
      })
      expect(await service.answerGate(SCOPE, gate.id, 'approve')).toEqual({ ok: true, started: null, reason: 'folder_busy', mode: 'manual', maxRuns: null })
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
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: task.id })
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
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'error', pausedTaskId: task.id })
  })

  it('maps a Stop to cancelled and pauses', async () => {
    const { task, end } = await dispatchedThenAsk()
    end({ type: 'done', stopReason: 'canceled' })
    await drain()
    expect(statusOf(task.id)).toBe('cancelled')
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'stopped', pausedTaskId: task.id })
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
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: task.id })
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id])
    expect(statusOf(next.id)).toBe('open')
  })

  it.each(['one', 'up_to'] as const)('starts no %s flight whose slot comes while the resumed turn is being settled, and starts it once settled', async (mode) => {
    // Mutations: drop the `settling` check at the slot grant → the up_to flight
    // starts mid-settle; drop it and the `settlingIn` folder check → the one flight does.
    const { task, end } = await dispatchedThenAsk(null, { file: { key: 't-owned-slot' } })
    if (mode === 'up_to') agentTaskDispatchRepo.setMode(USER, 'agent-a', 'up_to', 2)
    const next = ready('agent-a', { priority: 'low' })
    world.slots = 0
    service.wake()
    await drain()
    expect((await service.get(SCOPE, 'agent-a'))?.waiting).toBe('slot')
    let release!: () => void
    world.refresh = () => new Promise<void>((resolve) => { release = resolve })
    end({ type: 'done', stopReason: 'end_turn' })
    world.grant()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id])
    expect(statusOf(next.id)).toBe('open')

    // The agent reported while its file was read: no pause, and the queue goes on.
    taskService.setStatus(USER, task.id, 'completed')
    release()
    await drain()
    await drain()
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id, next.id])
  })

  it('starts no flight of another One at a time agent in the folder whose slot comes mid-settle', async () => {
    // Mutation: drop the `settlingIn` folder check at the slot grant → agent-b starts beside the settle.
    world.agents.push({ id: 'agent-b', name: 'Beta', path: dir })
    const { task, end } = await dispatchedThenAsk(null, { file: { key: 't-owned-b-slot' } })
    const other = ready('agent-b')
    agentTaskDispatchRepo.setMode(USER, 'agent-b', 'one')
    world.slots = 0
    service.wake()
    await drain()
    expect((await service.get(SCOPE, 'agent-b'))?.waiting).toBe('slot')
    let release!: () => void
    world.refresh = () => new Promise<void>((resolve) => { release = resolve })
    end({ type: 'done', stopReason: 'end_turn' })
    world.grant()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id])

    taskService.setStatus(USER, task.id, 'completed')
    release()
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([task.id, other.id])
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
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'interrupted', pausedTaskId: task.id })
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

  describe('an Inbox answer', () => {
    const ANSWER = { kind: 'question' as const, answers: [['This one.']] }
    const askRow = () => taskInputRequestRepo.getById('ask-r')!
    /** The answered turn ends as the agent left it, through `endTurn` as a real turn's end would. */
    function endSent(state: RunOutcome['state'] = 'completed'): void {
      const sent = world.starts[world.starts.length - 1]
      inboxService.recordRunEvent({ userId: USER, chatId: sent.chatId, agentId: 'agent-a', turnId: sent.runId, rootRunId: sent.runId, completionOwner: 'turn' },
        state === 'canceled' ? { type: 'done', stopReason: 'canceled' } : { type: 'done', stopReason: 'end_turn' })
      sent.end(state)
    }

    it('is stored on the ask, and sent as a flight that waits for a runner slot', async () => {
      // Mutation: drop the stored-answer branch in `inboxService.answer` → the answer starts a turn at once, beside the queue.
      const { task } = await dispatchedThenAsk(() => {})
      world.slots = 0
      expect(await inboxService.answer(USER, 'ask-r', ANSWER)).toEqual({ ok: true, queued: true })
      expect(askRow()).toMatchObject({ status: 'open', queuedAnswer: 'This one.', queuedError: null })
      // Still listed, with the answer and the folder it waits on.
      const { entries } = await inboxService.list(USER)
      expect(entries).toEqual([expect.objectContaining({ requestId: 'ask-r', queuedAnswer: 'This one.', queuedFolder: basename(dir) })])
      expect(entries[0].queuedAt).toBeInstanceOf(Date)

      service.wake()
      await drain()
      expect(world.answersSent).toEqual([])
      expect(await service.get(SCOPE, 'agent-a')).toMatchObject({ waiting: 'slot', next: { taskId: task.id } })
      expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: false, code: 'agent_busy' })

      world.grant()
      await drain()
      expect(world.answersSent).toEqual([{ requestId: 'ask-r', content: 'This one.' }])
      expect(askRow()).toMatchObject({ status: 'answered', queuedAnswer: null })
      expect(statusOf(task.id)).toBe('in_progress')
      const sent = world.starts[1]
      expect(isDispatchedRun(sent.chatId, sent.runId)).toBe(true)
      expect(rowOf('agent-a')).toMatchObject({ activeTaskId: task.id, activeChatId: sent.chatId })

      // Its turn ends without a report: the flight, not `endTurn`, settles it.
      endSent()
      await drain()
      expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', dispatchNote: DISPATCH_NOTE_UNREPORTED, dispatchAgentId: null })
      expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: task.id, activeTaskId: null })
      expect(isDispatchedRun(sent.chatId, sent.runId)).toBe(false)
    })

    it('goes out before the next Ready task, and the queue continues after a report', async () => {
      const { task } = await dispatchedThenAsk(() => {})
      const next = ready('agent-a', { priority: 'urgent' })
      await inboxService.answer(USER, 'ask-r', ANSWER)
      service.wake()
      await drain()
      expect(world.starts.map((s) => s.taskId)).toEqual([task.id, task.id])
      taskService.setStatus(USER, task.id, 'completed')
      endSent()
      await drain()
      await drain()
      expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBeNull()
      expect(world.starts.map((s) => s.taskId)).toEqual([task.id, task.id, next.id])
    })

    it('is sent in Manual mode and while the queue is paused', async () => {
      // Mutation: check mode and pause before stored answers in `pass` → it never goes.
      const { task } = await dispatchedThenAsk(() => {})
      agentTaskDispatchRepo.setMode(USER, 'agent-a', 'manual')
      agentTaskDispatchRepo.pause(USER, 'agent-a', 'error', 'other')
      ready('agent-a')
      await inboxService.answer(USER, 'ask-r', ANSWER)
      service.wake()
      await drain()
      expect(world.answersSent).toHaveLength(1)
      expect(world.starts.map((s) => s.taskId)).toEqual([task.id, task.id])
      expect(agentTaskDispatchRepo.get(USER, 'agent-a').pausedReason).toBe('error')
    })

    it('waits while another dispatched run works in the same folder, or a turn runs there', async () => {
      world.agents.push({ id: 'agent-b', name: 'Beta', path: dir })
      await dispatchedThenAsk(() => {})
      const other = ready('agent-b')
      const run = await service.runNext(SCOPE, 'agent-b')
      expect(run).toMatchObject({ ok: true, taskId: other.id })
      await inboxService.answer(USER, 'ask-r', ANSWER)
      service.wake()
      await drain()
      expect(world.answersSent).toEqual([])

      // The other run reports; a turn is now running in the folder.
      taskService.setStatus(USER, other.id, 'completed')
      world.live = ['agent-b']
      world.starts[1].end('completed')
      await drain()
      expect(world.answersSent).toEqual([])

      world.live = []
      service.wake()
      await drain()
      expect(world.answersSent).toHaveLength(1)
    })

    it('is superseded by a message typed in the chat while it waits', async () => {
      // Mutation: skip the stored-answer recheck after the slot wait → the answer is sent as a second turn.
      const { started } = await dispatchedThenAsk(() => {})
      world.slots = 0
      await inboxService.answer(USER, 'ask-r', ANSWER)
      service.wake()
      await drain()
      inboxService.resumeChat({ userId: USER, chatId: started.chatId, agentId: 'agent-a', turnId: 'typed', rootRunId: 'typed', completionOwner: 'turn' }, 'Typed instead.')
      expect(askRow()).toMatchObject({ status: 'answered', queuedAnswer: null })
      world.grant()
      await drain()
      expect(world.answersSent).toEqual([])
      expect(rowOf('agent-a')).toMatchObject({ pausedReason: null, activeTaskId: null })
    })

    it('is cleared with a reason when its agent can no longer work a queue', async () => {
      // Mutation: drop the clearing of answers for agents missing from the pass → it waits forever.
      await dispatchedThenAsk(() => {})
      world.slots = 0
      expect(await inboxService.answer(USER, 'ask-r', ANSWER)).toEqual({ ok: true, queued: true })
      world.agents = []
      service.wake()
      await drain()
      expect(askRow()).toMatchObject({ status: 'open', queuedAnswer: null, queuedError: NOT_DISPATCHABLE_ANSWER })
      expect(world.answersSent).toEqual([])
    })

    it('goes to the chat at once, unstored, when its agent can no longer work a queue', async () => {
      // Mutation: store whenever the task has a dispatch agent → `queued: true`, and nothing ever sends it.
      await dispatchedThenAsk(() => {})
      world.agents = []
      const startNext = vi.spyOn(inboxService, 'startNextMessageTurn').mockReturnValue({
        id: 'direct', accepted: Promise.resolve(), completed: new Promise(() => {})
      } as never)
      expect(await inboxService.answer(USER, 'ask-r', ANSWER)).toEqual({ ok: true })
      expect(startNext).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'ask-r' }), 'This one.')
      expect(askRow().queuedAnswer).toBeNull()
    })

    it('says why on the ask when it could not be sent, without pausing, and can be answered again', async () => {
      // Mutation: leave the stored answer on a failed send → the card keeps saying it will send.
      await dispatchedThenAsk(() => {})
      world.startError = 'That agent is unavailable.'
      await inboxService.answer(USER, 'ask-r', ANSWER)
      service.wake()
      await drain()
      expect(askRow()).toMatchObject({ status: 'open', queuedAnswer: null, queuedError: 'That agent is unavailable.' })
      expect((await inboxService.list(USER)).entries[0]).toMatchObject({ queuedError: 'That agent is unavailable.' })
      expect((await inboxService.list(USER)).entries[0].queuedAnswer).toBeUndefined()
      expect(rowOf('agent-a')).toMatchObject({ pausedReason: null, activeTaskId: null })

      world.startError = null
      expect(await inboxService.answer(USER, 'ask-r', ANSWER)).toEqual({ ok: true, queued: true })
      expect(askRow().queuedError).toBeNull()
      service.wake()
      await drain()
      expect(world.answersSent).toHaveLength(1)
    })

    it('is not attempted while its chat is still running, and goes once it closes', async () => {
      // Mutation: drop the chatRunning check in `pass` → each pass takes a slot, fails on the running chat and wakes again.
      const { started } = await dispatchedThenAsk(() => {})
      ready('agent-a', { priority: 'urgent' })
      world.runningChats = [started.chatId]
      await inboxService.answer(USER, 'ask-r', ANSWER)
      const before = world.slotRequests
      service.wake()
      await drain()
      service.wake()
      await drain()
      expect(world.slotRequests).toBe(before)
      expect(world.answersSent).toEqual([])
      // Nothing else starts for the agent while its answer waits.
      expect(world.starts).toHaveLength(1)
      expect(askRow()).toMatchObject({ queuedAnswer: 'This one.', queuedError: null })

      world.runningChats = []
      service.wake()
      await drain()
      expect(world.answersSent).toHaveLength(1)
    })

    it('is what Run next sends, before any Ready task; Start on a named task still starts that task', async () => {
      // Mutation: skip stored answers in `runNext` → Run next starts the Ready task instead.
      const { task, started } = await dispatchedThenAsk(() => {})
      agentTaskDispatchRepo.setMode(USER, 'agent-a', 'manual')
      const other = ready('agent-a', { priority: 'urgent' })
      await inboxService.answer(USER, 'ask-r', ANSWER)
      expect(await service.runNext(SCOPE, 'agent-a')).toEqual({ ok: true, taskId: task.id, chatId: started.chatId })
      expect(world.answersSent).toHaveLength(1)
      expect(world.starts.map((s) => s.taskId)).toEqual([task.id, task.id])

      // Its turn reports; another answer waits again on a fresh ask.
      taskService.setStatus(USER, task.id, 'blocked')
      endSent()
      await drain()
      taskInputRequestRepo.open({
        requestId: 'ask-r2', taskId: task.id, chatId: started.chatId, agentId: 'agent-a', resume: 'next_message',
        request: { kind: 'question', questions: [{ question: 'And?', options: [], multiSelect: false }] }
      })
      taskRepo.setDispatchAgent(USER, task.id, 'agent-a')
      await inboxService.answer(USER, 'ask-r2', ANSWER)
      expect(await service.runNext(SCOPE, 'agent-a', other.id)).toMatchObject({ ok: true, taskId: other.id })
      expect(world.answersSent).toHaveLength(1)
    })

    it('Run next says so when the answer’s chat is still running', async () => {
      const { started } = await dispatchedThenAsk(() => {})
      await inboxService.answer(USER, 'ask-r', ANSWER)
      world.runningChats = [started.chatId]
      expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: false, code: 'live_turn' })
      expect(world.answersSent).toEqual([])
    })

    it('refuses a second answer while one waits', async () => {
      await dispatchedThenAsk(() => {})
      world.slots = 0
      await inboxService.answer(USER, 'ask-r', ANSWER)
      expect(await inboxService.answer(USER, 'ask-r', { kind: 'question', answers: [['Another.']] }))
        .toMatchObject({ ok: false, code: 'already_answered' })
      expect(askRow().queuedAnswer).toBe('This one.')
    })

    it('outlives a restart: boot recovery leaves it, and the next start sends it', async () => {
      const { task } = await dispatchedThenAsk(() => {})
      service.shutdown()
      await inboxService.answer(USER, 'ask-r', ANSWER)
      service.recoverInterrupted()
      expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', dispatchAgentId: 'agent-a' })
      expect(askRow().queuedAnswer).toBe('This one.')
      service.start(SCOPE)
      await drain()
      expect(world.answersSent).toHaveLength(1)
    })

    it('is cleared with a reason when its task left the queue before it was sent', async () => {
      const { task } = await dispatchedThenAsk(() => {})
      world.slots = 0
      await inboxService.answer(USER, 'ask-r', ANSWER)
      taskRepo.setDispatchAgent(USER, task.id, null)
      service.wake()
      await drain()
      expect(askRow()).toMatchObject({ status: 'open', queuedAnswer: null, queuedError: expect.stringContaining('left its queue') })
      expect(world.answersSent).toEqual([])
    })
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

describe('up to N', () => {
  function upTo(agentId: string, n: number): void {
    agentTaskDispatchRepo.setMode(USER, agentId, 'up_to', n)
  }

  it('runs up to N of the agent’s tasks at once, never the same task twice, in queue order', async () => {
    // Mutations: drop `held` from `candidates` → the second flight takes the
    // first one's task; launch only once per pass → one start.
    world.slots = 8
    const low = ready('agent-a', { title: 'Low', priority: 'low' })
    const old = ready('agent-a', { title: 'Old', createdAt: new Date('2026-01-01') })
    const urgent = ready('agent-a', { title: 'Urgent', priority: 'urgent' })
    const young = ready('agent-a', { title: 'Young', createdAt: new Date('2026-02-01') })
    upTo('agent-a', 3)
    service.start(SCOPE)
    await drain()
    service.wake()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([urgent.id, old.id, young.id])
    const state = await service.get(SCOPE, 'agent-a')
    expect(state).toMatchObject({ mode: 'up_to', maxRuns: 3, waiting: null, next: { taskId: low.id } })
    expect(state?.running.map((run) => run.taskId)).toEqual([urgent.id, old.id, young.id])
    expect(rowOf('agent-a').runs.map((run) => run.taskId).sort()).toEqual([urgent.id, old.id, young.id].sort())

    taskService.setStatus(USER, old.id, 'completed')
    world.starts[1].end('completed')
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([urgent.id, old.id, young.id, low.id])
    expect(new Set(world.starts.map((s) => s.taskId)).size).toBe(4)
  })

  it('starts beside another agent’s run in the folder, while a One at a time agent there still waits', async () => {
    // Mutation: keep the folder check for `up_to` in `pass` → agent-a waits for agent-b's run.
    world.slots = 8
    world.agents = [{ id: 'agent-b', name: 'Beta', path: dir }, { id: 'agent-a', name: 'Alpha', path: dir }]
    const b1 = ready('agent-b', { createdAt: new Date('2026-01-01') })
    const b2 = ready('agent-b', { createdAt: new Date('2026-02-01') })
    const a1 = ready('agent-a', { priority: 'high' })
    const a2 = ready('agent-a')
    agentTaskDispatchRepo.setMode(USER, 'agent-b', 'one')
    upTo('agent-a', 2)
    service.start(SCOPE)
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([b1.id, a1.id, a2.id])

    // agent-b's run reports; agent-a's runs still work in the folder, so the
    // One at a time agent waits on them (mutation: lift the folder rule for
    // every agent → b2 starts).
    taskService.setStatus(USER, b1.id, 'completed')
    world.starts[0].end('completed')
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([b1.id, a1.id, a2.id])
    expect((await service.get(SCOPE, 'agent-b'))?.waiting).toBe('folder_busy')
    expect(await service.runNext(SCOPE, 'agent-b')).toMatchObject({ ok: false, code: 'folder_busy' })

    taskService.setStatus(USER, a1.id, 'completed')
    world.starts[1].end('completed')
    taskService.setStatus(USER, a2.id, 'completed')
    world.starts[2].end('completed')
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([b1.id, a1.id, a2.id, b2.id])
  })

  it('makes a One at a time flight that gets its slot after an up_to run got going in the folder end quietly, and start later', async () => {
    // Mutation: drop the folder check at the slot grant → b1 starts beside a1.
    world.slots = 0
    world.agents = [{ id: 'agent-b', name: 'Beta', path: dir }, { id: 'agent-a', name: 'Alpha', path: dir }]
    const b1 = ready('agent-b')
    const a1 = ready('agent-a')
    agentTaskDispatchRepo.setMode(USER, 'agent-b', 'one')
    upTo('agent-a', 2)
    service.start(SCOPE)
    await drain()
    expect(world.starts).toHaveLength(0)
    world.grantNewest = true
    world.grant()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([a1.id])
    world.grantNewest = false
    world.grant()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([a1.id])
    expect(rowOf('agent-b')).toMatchObject({ pausedReason: null, runs: [] })
    expect(statusOf(b1.id)).toBe('open')

    taskService.setStatus(USER, a1.id, 'completed')
    world.starts[0].end('completed')
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([a1.id, b1.id])
  })

  it('is not stopped by a live turn in its folder, and neither is its Run next', async () => {
    // Mutation: keep the live-turn check for `up_to` → nothing starts.
    world.live = ['agent-a']
    const first = ready('agent-a', { priority: 'high' })
    const second = ready('agent-a')
    upTo('agent-a', 2)
    agentTaskDispatchRepo.pause(USER, 'agent-a', 'unreported', null)
    service.start(SCOPE)
    await drain()
    expect(world.starts).toHaveLength(0)
    expect((await service.get(SCOPE, 'agent-a'))?.waiting).toBeNull()
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: true, taskId: first.id })
    await service.resume(SCOPE, 'agent-a')
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id, second.id])
  })

  it('passes over a task whose chat runs a turn instead of relaunching it every pass', async () => {
    // Mutation: drop `chatBusy` in `passWide` → a flight takes a slot, refuses, wakes, and does it again.
    const busy = ready('agent-a', { priority: 'urgent' })
    const other = ready('agent-a')
    const chat = chatRepo.create(USER, { agentId: 'agent-a' })
    taskRepo.update(USER, busy.id, { chatId: chat.id })
    world.runningChats = [chat.id]
    upTo('agent-a', 2)
    service.start(SCOPE)
    for (let i = 0; i < 4; i += 1) await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([other.id])
    expect(world.slotRequests).toBe(1)

    world.runningChats = []
    service.wake()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([other.id, busy.id])
  })

  it('starts no queued flight whose slot comes after another run paused the queue, and starts it on Resume', async () => {
    // Mutation: drop the paused check at the slot grant → the waiting flight starts on a paused queue.
    world.slots = 1
    const first = ready('agent-a', { priority: 'urgent' })
    const second = ready('agent-a')
    upTo('agent-a', 2)
    service.start(SCOPE)
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id])
    expect((await service.get(SCOPE, 'agent-a'))?.waiting).toBe('slot')

    // The first run ends without a report: the pause is written, then its slot goes to the waiting flight.
    world.starts[0].end('completed')
    await drain()
    await drain()
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: first.id, runs: [] })
    expect(world.starts).toHaveLength(1)
    expect(statusOf(second.id)).toBe('open')

    await service.resume(SCOPE, 'agent-a')
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id, second.id])
  })

  it('takes no more runner slots than are free: one flight waits, the rest are not launched', async () => {
    // Mutation: drop the one-waiting-flight bound in `passWide` → three slot requests.
    world.slots = 1
    const first = ready('agent-a', { priority: 'urgent' })
    const second = ready('agent-a', { priority: 'high' })
    const third = ready('agent-a')
    upTo('agent-a', 3)
    service.start(SCOPE)
    await drain()
    service.wake()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id])
    expect(world.slotRequests).toBe(2)
    expect(await service.get(SCOPE, 'agent-a')).toMatchObject({ waiting: 'slot', next: { taskId: second.id } })
    expect((await service.get(SCOPE, 'agent-a'))?.running).toHaveLength(1)

    // The waiting flight holds its task, which is still Ready: Run next takes
    // the one after it (mutation: drop `held` from `candidates` → it takes the
    // same task, which is no longer Ready by its turn).
    const pending = service.runNext(SCOPE, 'agent-a')
    await drain()
    taskService.setStatus(USER, first.id, 'completed')
    world.starts[0].end('completed')
    await drain()
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id, second.id])
    expect(world.inUse).toBe(1)
    taskService.setStatus(USER, second.id, 'completed')
    world.starts[1].end('completed')
    await drain()
    await drain()
    expect(await pending).toMatchObject({ ok: true, taskId: third.id })
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id, second.id, third.id])
  })

  it('pauses on the first flagged run, lets the others finish by the report rule, and keeps the first pause', async () => {
    // Mutation: let `pause` overwrite an existing pause → the pause names the second task.
    const first = ready('agent-a', { priority: 'urgent' })
    const second = ready('agent-a', { priority: 'high' })
    const third = ready('agent-a')
    upTo('agent-a', 2)
    service.start(SCOPE)
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id, second.id])

    world.starts[0].end('completed')
    await drain()
    expect(taskRepo.getById(USER, first.id)).toMatchObject({ status: 'blocked', dispatchNote: DISPATCH_NOTE_UNREPORTED })
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: first.id })
    expect(world.starts).toHaveLength(2)

    world.starts[1].end('failed', { error: { message: 'Boom.' } } as Partial<RunOutcome>)
    await drain()
    expect(statusOf(second.id)).toBe('error')
    expect(rowOf('agent-a')).toMatchObject({ pausedReason: 'unreported', pausedTaskId: first.id, runs: [] })
    expect(world.starts).toHaveLength(2)
    const { dispatch } = await inboxService.list(USER)
    expect(dispatch?.filter((item) => item.kind === 'dispatch_paused')).toEqual([expect.objectContaining({ agentId: 'agent-a', taskId: first.id })])

    await service.resume(SCOPE, 'agent-a')
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([first.id, second.id, third.id])
  })

  it('records every run in flight, and boot recovery flags each of them', async () => {
    // Mutation: keep one in-flight record per agent → the second run is not flagged.
    const first = ready('agent-a', { priority: 'urgent' })
    const second = ready('agent-a')
    upTo('agent-a', 2)
    service.start(SCOPE)
    await drain()
    expect(rowOf('agent-a').runs).toHaveLength(2)
    service.shutdown()
    world.starts[0].end('canceled')
    world.starts[1].end('canceled')
    await drain()
    expect(rowOf('agent-a').runs).toHaveLength(2)

    service.recoverInterrupted()
    for (const task of [first, second]) {
      expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', dispatchNote: DISPATCH_NOTE_INTERRUPTED, dispatchAgentId: null })
    }
    expect(rowOf('agent-a')).toMatchObject({ mode: 'up_to', maxRuns: 2, pausedReason: 'interrupted', runs: [] })
    expect([first.id, second.id]).toContain(rowOf('agent-a').pausedTaskId)
  })

  it('refuses Run next as busy only once the agent has N runs', async () => {
    // Mutation: refuse at one flight as before → the second Run next is agent_busy.
    const first = ready('agent-a', { priority: 'urgent' })
    const second = ready('agent-a', { priority: 'high' })
    ready('agent-a')
    upTo('agent-a', 2)
    agentTaskDispatchRepo.pause(USER, 'agent-a', 'unreported', null)
    service.start(SCOPE)
    await drain()
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: true, taskId: first.id })
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: true, taskId: second.id })
    expect(await service.runNext(SCOPE, 'agent-a')).toMatchObject({ ok: false, code: 'agent_busy' })
    expect(await service.runNext(SCOPE, 'agent-a', first.id)).toMatchObject({ ok: false, code: 'agent_busy' })
  })

  it('sends a stored answer beside the agent’s other runs once it has room, not waiting for the folder', async () => {
    // Mutation: keep the folder check for a wide agent's answers → the answer waits until both runs end.
    const asked = ready('agent-a', { priority: 'urgent' })
    const other = ready('agent-a', { priority: 'high' })
    const third = ready('agent-a')
    upTo('agent-a', 2)
    service.start(SCOPE)
    await drain()
    expect(world.starts.map((s) => s.taskId)).toEqual([asked.id, other.id])
    const first = world.starts[0]
    taskInputRequestRepo.open({
      requestId: 'ask-u', taskId: asked.id, chatId: first.chatId, agentId: 'agent-a', resume: 'next_message',
      request: { kind: 'question', questions: [{ question: 'Which?', options: [], multiSelect: false }] }
    })
    taskService.applyRunState(USER, asked.id, 'needs_input')
    inboxService.recordRunEvent({ userId: USER, chatId: first.chatId, agentId: 'agent-a', turnId: first.runId, rootRunId: first.runId, completionOwner: 'turn' },
      { type: 'done', stopReason: 'end_turn' })
    first.end('needs_input')
    await drain()
    // The asked task waits; the queue fills its free run with the next task.
    expect(world.starts.map((s) => s.taskId)).toEqual([asked.id, other.id, third.id])

    expect(await inboxService.answer(USER, 'ask-u', { kind: 'question', answers: [['This one.']] })).toEqual({ ok: true, queued: true })
    service.wake()
    await drain()
    expect(world.answersSent).toEqual([])

    taskService.setStatus(USER, third.id, 'completed')
    world.starts[2].end('completed')
    await drain()
    await drain()
    expect(world.answersSent).toEqual([{ requestId: 'ask-u', content: 'This one.' }])
    expect(world.starts[3]).toMatchObject({ taskId: asked.id })
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
  it('publishes a queue whose state a pass finds changed, and stays quiet when nothing moved', async () => {
    // Mutation: drop `announceChanges` at the end of `pass` → a task made Ready changes "Next" with no push.
    service.start(SCOPE)
    await drain()
    world.published = []
    service.wake()
    await drain()
    expect(world.published).toEqual([])

    const task = ready('agent-a')
    service.wake()
    await drain()
    expect(world.published).toEqual(['agent-a'])
    expect((await service.get(SCOPE, 'agent-a'))?.next?.taskId).toBe(task.id)

    // A turn in the folder is a state of its own ("waiting on a conversation").
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    world.live = ['agent-a']
    world.published = []
    service.wake()
    await drain()
    expect(world.published).toEqual(['agent-a'])
    expect(world.starts).toEqual([])
  })

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

  it('stores N with up_to, refuses one outside 2–8, and drops it with the other modes', async () => {
    expect(await service.setMode(SCOPE, 'agent-a', 'up_to', 9)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.setMode(SCOPE, 'agent-a', 'up_to')).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(agentTaskDispatchRepo.listForUser(USER)).toEqual([])
    expect(await service.setMode(SCOPE, 'agent-a', 'up_to', 4)).toMatchObject({ ok: true, state: { mode: 'up_to', maxRuns: 4 } })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a')).toMatchObject({ mode: 'up_to', maxRuns: 4 })
    expect(await service.setMode(SCOPE, 'agent-a', 'one', 4)).toMatchObject({ ok: true, state: { mode: 'one', maxRuns: null } })
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').maxRuns).toBeNull()
  })

  it('keeps no row for an agent back at manual and idle', async () => {
    await service.setMode(SCOPE, 'agent-a', 'one')
    expect(agentTaskDispatchRepo.listForUser(USER)).toHaveLength(1)
    await service.setMode(SCOPE, 'agent-a', 'manual')
    expect(agentTaskDispatchRepo.listForUser(USER)).toEqual([])
  })
})

describe('migration', () => {
  it('untrusts a folder task whose binding predates trustedDigest, once, and leaves recorded trust alone', () => {
    // Mutation: drop the UPDATE in `migrateTasks` → the legacy task still reads as trusted.
    const legacy = ready('agent-a', { file: { key: 't-legacy' } })
    const recorded = ready('agent-a', { file: { key: 't-recorded' } })
    const recordedNull = ready('agent-a', { file: { key: 't-null' } })
    const put = holder.current!.sqlite.prepare("UPDATE tasks SET remote_adapter = 'folder', remote_state = ? WHERE id = ?")
    const digestOf = (id: string): string => taskRepo.getById(USER, id)!.localFile!.digest
    put.run(JSON.stringify({ file: 'a.md', writtenDigest: digestOf(legacy.id) }), legacy.id)
    put.run(JSON.stringify({ file: 'b.md', writtenDigest: digestOf(recorded.id), trustedDigest: digestOf(recorded.id) }), recorded.id)
    put.run(JSON.stringify({ file: 'c.md', trustedDigest: null }), recordedNull.id)
    expect(taskService.getById(USER, legacy.id).fromOutside).toBe(false)

    migrateTasks(holder.current!.sqlite)
    expect(taskRepo.getById(USER, legacy.id)?.trustedDigest).toBeNull()
    expect(taskService.getById(USER, legacy.id).fromOutside).toBe(true)
    expect(taskService.getById(USER, recorded.id).fromOutside).toBe(false)
    // A recorded null is the binding's own word; the row is left as it is.
    expect(taskRepo.getById(USER, recordedNull.id)?.trustedDigest).toBe(digestOf(recordedNull.id))

    // Once approved, a later boot does not take the approval back.
    taskRepo.setTrustedDigest(USER, legacy.id, digestOf(legacy.id))
    put.run(JSON.stringify({ file: 'a.md', writtenDigest: digestOf(legacy.id), trustedDigest: digestOf(legacy.id) }), legacy.id)
    migrateTasks(holder.current!.sqlite)
    expect(taskService.getById(USER, legacy.id).fromOutside).toBe(false)
  })

  it('is idempotent', () => {
    expect(() => { migrateTasks(holder.current!.sqlite); migrateTasks(holder.current!.sqlite) }).not.toThrow()
    agentTaskDispatchRepo.setMode(USER, 'agent-a', 'one')
    migrateTasks(holder.current!.sqlite)
    expect(agentTaskDispatchRepo.get(USER, 'agent-a').mode).toBe('one')
  })
})
