vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { RemoteTaskAdapter } from '../tasks/adapters/adapter'

/**
 * The agent task tools over a real database, the real task, authoring and
 * sync services, and the real `folder` adapter over a temp folder. Stand-ins:
 * the adapter registry, the agent lookups, the session check (whose rules are
 * `delegationService`'s and tested there), the delegation itself (its route is
 * asserted by what it is called with) and whether a chat has a live turn.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  userData: '',
  adapters: [] as RemoteTaskAdapter[],
  agentPath: '',
  live: new Set<string>(),
  delegate: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']>,
  report: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']>
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
vi.mock('./agentService', () => ({
  agentService: {
    findAgent: (_settings: string, _profile: string, agentId: string) =>
      ['bare-1', 'kit-1'].includes(agentId) ? { row: { id: agentId, name: agentId === 'bare-1' ? 'Uploader' : 'Kit', enabled: true }, userId: 'settings' } : null
  }
}))
vi.mock('./localAgents/localAgentService', () => ({
  localAgentService: { get: (_settings: string, agentId: string) => ({ id: agentId, name: agentId === 'bare-1' ? 'Uploader' : 'Kit' }) }
}))
vi.mock('./chatRemoval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatRemoval')>()),
  activeChatRunId: (chatId: string) => (holder.live.has(chatId) ? 'run-1' : null)
}))
vi.mock('./delegationService', async () => {
  const { taskRepo } = await import('../db/tasks')
  const { delegationRepo } = await import('../db/delegations')
  holder.delegate = vi.fn(async () => ({ delegationId: 'd-1', state: 'gated' }))
  holder.report = vi.fn(async () => ({ delegationId: 'd-1', status: 'done' }))
  return {
    validateSession: (session: { scope: { profileUserId: string }; chatId: string }) => {
      const task = taskRepo.getByChatId(session.scope.profileUserId, session.chatId)
      return { source: { path: holder.agentPath }, task, parent: task ? delegationRepo.byTaskId(session.scope.profileUserId, task.id) : undefined }
    },
    delegationService: { create: (...args: unknown[]) => holder.delegate(...args), report: (...args: unknown[]) => holder.report(...args) }
  }
})
vi.mock('../tasks/adapters', async () => {
  const adapter = await import('../tasks/adapters/adapter')
  const nullAdapter = await import('../tasks/adapters/nullAdapter')
  return {
    ...adapter,
    allAdapters: () => holder.adapters,
    adapterFor: (id: string) => holder.adapters.find((a) => a.id === id) ?? nullAdapter.createNullAdapter(id),
    localHomeFor: async (agentId: string) => {
      for (const a of holder.adapters) if (a.localHome && (await a.localHome.accepts(agentId))) return a
      return null
    }
  }
})

const { taskToolService, TASK_TOOL_CHAT_CAP } = await import('./taskToolService')
const { taskSyncService } = await import('./taskSyncService')
const { taskService } = await import('./taskService')
const { taskRepo } = await import('../db/tasks')
const { delegationRepo } = await import('../db/delegations')
const { taskCommentRepo } = await import('../db/taskComments')
const { chatRepo } = await import('../db/chats')
const { createFolderTaskAdapter } = await import('../tasks/adapters/folderTaskAdapter')
const { folderTaskFs } = await import('../tasks/adapters/folderTaskFs')
const { createFakeRemote } = await import('../tasks/adapters/testSupport/fakeRemote')
const { installStatusWordResolver } = await import('../tasks/adapters/statusWords')
const { takeAgentStatusReport } = await import('../tasks/agentStatusReports')
const { handoverRepo } = await import('../db/handovers')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { taskRunnersByChat } = await import('./taskRunnerState')
const { LOG_CLOSE, LOG_OPEN } = await import('../../shared/folderTasks')

installStatusWordResolver('folder', (remoteId, status, current) =>
  holder.adapters.find((a) => a.id === 'folder')?.localHome?.statusWord(remoteId, status, current))

const USER = '__default__' // the seeded user: delegations reference users(id)
const SCOPE = { profileUserId: USER, settingsUserId: 'settings' }
let seed = 0

function folderAdapter(): RemoteTaskAdapter {
  return createFolderTaskAdapter({
    agents: async () => [{ id: 'bare-1', name: 'Uploader', path: holder.agentPath }],
    states: async (userId) => new Map(taskRepo.list(userId, { remoteAdapter: 'folder', includeArchived: true })
      .filter((row) => row.remoteId && row.remoteState)
      .map((row) => [row.remoteId as string, row.remoteState as Record<string, unknown>])),
    fs: folderTaskFs,
    randomBytes: (size) => new Uint8Array(size).fill(seed++)
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** A session of `agentId` in a fresh chat, optionally working on a task. */
function session(agentId: string, task?: { chainDepth?: number }) {
  const chat = chatRepo.create(USER)
  if (task) taskService.create(USER, { title: 'Chat task', goal: 'Work', chatId: chat.id, assigneeAgentId: agentId, chainDepth: task.chainDepth ?? 0 })
  return { scope: SCOPE, chatId: chat.id, agentId }
}

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.userData = mkdtempSync(join(tmpdir(), 'cinna-task-tools-data-'))
  holder.agentPath = mkdtempSync(join(tmpdir(), 'cinna-task-tools-agent-'))
  holder.adapters = [folderAdapter()]
  holder.live.clear()
  holder.delegate.mockClear()
  taskSyncService.resetCursors()
})

afterEach(async () => {
  await settle()
  holder.current?.close()
  holder.current = null
  rmSync(holder.userData, { recursive: true, force: true })
  rmSync(holder.agentPath, { recursive: true, force: true })
})

describe('tasks_create into the agent’s own queue', () => {
  it('makes a native task for a kit agent, assigned to it, with the agent, the chat and depth 1 recorded', async () => {
    const kit = session('kit-1')
    const created = await taskToolService.tasksCreate(kit, { title: 'Write docs', description: 'The upload docs.', category: 'ready', priority: 'high' }) as { ref: string; file: string | null }
    const row = taskRepo.getById(USER, created.ref)!
    expect(row).toMatchObject({ title: 'Write docs', description: 'The upload docs.', status: 'open', priority: 'high',
      assigneeAgentId: 'kit-1', createdByAgentId: 'kit-1', createdByChatId: kit.chatId, chainDepth: 1, deviceLocal: false, remoteAdapter: null })
    expect(created.file).toBeNull()
    expect(holder.delegate).not.toHaveBeenCalled()
    // Backlog is the default.
    const backlog = await taskToolService.tasksCreate(kit, { title: 'Later', description: 'Some day.' }) as { ref: string }
    expect(taskRepo.getById(USER, backlog.ref)?.status).toBe('new')
  })

  it('writes a bare agent’s task into its .cinna/tasks as a trusted device-local file', async () => {
    const bare = session('bare-1')
    const created = await taskToolService.tasksCreate(bare, { title: 'Fix login', description: 'It loops.', category: 'ready' }) as { ref: string; file: string }
    const files = readdirSync(join(holder.agentPath, '.cinna', 'tasks'))
    expect(files).toEqual(['fix-login.md'])
    expect(created.file).toBe('.cinna/tasks/fix-login.md')
    const text = readFileSync(join(holder.agentPath, '.cinna', 'tasks', 'fix-login.md'), 'utf8')
    expect(text).toContain('status: open')
    expect(text).toContain('It loops.')
    const dto = taskService.getById(USER, created.ref)
    expect(dto).toMatchObject({ fromOutside: false, assignee: { agentId: 'bare-1' } })
    expect(taskRepo.getById(USER, created.ref)).toMatchObject({ deviceLocal: true, createdByAgentId: 'bare-1', createdByChatId: bare.chatId })
  })

  it('treats an assignee naming the calling agent as its own queue, not a delegation', async () => {
    const kit = session('kit-1')
    const created = await taskToolService.tasksCreate(kit, { title: 'Mine', description: 'Mine.', assignee: 'kit:kit-1' }) as { ref: string }
    expect(holder.delegate).not.toHaveBeenCalled()
    expect(taskRepo.getById(USER, created.ref)?.assigneeAgentId).toBe('kit-1')
  })

  it('takes a parent only from the agent’s own queue', async () => {
    const kit = session('kit-1')
    const parent = await taskToolService.tasksCreate(kit, { title: 'Parent', description: 'P.' }) as { ref: string }
    const child = await taskToolService.tasksCreate(kit, { title: 'Child', description: 'C.', parent: parent.ref }) as { ref: string }
    expect(taskRepo.getById(USER, child.ref)?.parentTaskId).toBe(parent.ref)
    const stranger = taskService.create(USER, { title: 'Not yours', goal: 'x', assigneeAgentId: 'other' })
    await expect(taskToolService.tasksCreate(kit, { title: 'Child', description: 'C.', parent: stranger.id })).rejects.toThrow('own queue')
  })

  it('refuses delegation-only arguments without an assignee', async () => {
    const kit = session('kit-1')
    await expect(taskToolService.tasksCreate(kit, { title: 'X', description: 'Y', id: 'abc' })).rejects.toThrow('only when delegating')
    await expect(taskToolService.tasksCreate(kit, { title: 'X', description: 'Y', category: 'draft' })).rejects.toThrow('backlog or ready')
    await expect(taskToolService.tasksCreate(kit, { title: 'X', description: 'Y', assignee: { kind: 'kit', agentId: 'kit-2' } })).rejects.toThrow('tasks_targets')
    // A remote target with the agent's own id is somebody else, not its own queue.
    await taskToolService.tasksCreate(kit, { title: 'X', description: 'Y', assignee: 'cinna:svc:kit-1', id: 'remote-x' })
    expect(holder.delegate).toHaveBeenCalledTimes(1)
  })
})

describe('chain depth and the per-chat cap', () => {
  it('starts an own-queue task from a chat with no task at depth 1, like a delegation from it', async () => {
    const plainChat = session('kit-1')
    const first = await taskToolService.tasksCreate(plainChat, { title: 'First', description: 'F.' }) as { ref: string }
    expect(taskRepo.getById(USER, first.ref)?.chainDepth).toBe(1)
  })

  it('puts a task one deeper than the chat’s own task, and refuses past depth 2', async () => {
    const atOne = session('kit-1', { chainDepth: 1 })
    const created = await taskToolService.tasksCreate(atOne, { title: 'Deeper', description: 'D.' }) as { ref: string }
    expect(taskRepo.getById(USER, created.ref)?.chainDepth).toBe(2)
    const atTwo = session('kit-1', { chainDepth: 2 })
    await expect(taskToolService.tasksCreate(atTwo, { title: 'Too deep', description: 'D.' })).rejects.toThrow('depth 2')
  })

  it('reads a delegated chat task’s depth from its delegation', async () => {
    const chat = session('kit-1', {})
    const task = taskRepo.getByChatId(USER, chat.chatId)!
    delegationRepo.insert({ userId: USER, requesterKey: 'r', originKind: 'local_chat', originChatId: 'elsewhere', targetKind: 'kit', targetAgentId: 'kit-1', channel: 'local', depth: 2, taskId: task.id })
    await expect(taskToolService.tasksCreate(chat, { title: 'Too deep', description: 'D.' })).rejects.toThrow('depth 2')
  })

  it('counts an own-queue chat task’s chain depth even under a shallower delegation', async () => {
    const chat = session('kit-1', { chainDepth: 2 })
    const task = taskRepo.getByChatId(USER, chat.chatId)!
    delegationRepo.insert({ userId: USER, requesterKey: 'r', originKind: 'local_chat', originChatId: 'elsewhere', targetKind: 'kit', targetAgentId: 'kit-1', channel: 'local', depth: 1, taskId: task.id })
    await expect(taskToolService.tasksCreate(chat, { title: 'Too deep', description: 'D.' })).rejects.toThrow('depth 2')
  })

  it('lets only one of two parallel creates through at the last place, own queue and delegation alike', async () => {
    const kit = session('kit-1')
    for (let i = 0; i < TASK_TOOL_CHAT_CAP - 1; i += 1) await taskToolService.tasksCreate(kit, { title: `T${i}`, description: 'x' })
    const own = await Promise.allSettled([
      taskToolService.tasksCreate(kit, { title: 'A', description: 'x' }),
      taskToolService.tasksCreate(kit, { title: 'B', description: 'x' })
    ])
    expect(own.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(taskRepo.countCreatedInChat(USER, kit.chatId)).toBe(TASK_TOOL_CHAT_CAP)

    // A delegation checks the cap in its new-request hook and writes after an await.
    const other = session('kit-1')
    for (let i = 0; i < TASK_TOOL_CHAT_CAP - 1; i += 1) await taskToolService.tasksCreate(other, { title: `U${i}`, description: 'x' })
    holder.delegate.mockImplementation(async (calledSession: { chatId: string }, _request: unknown, _signal: unknown, options: { beforeNew(): void }) => {
      options.beforeNew()
      await settle()
      delegationRepo.insert({ userId: USER, requesterKey: `r-${Math.random()}`, originKind: 'local_chat', originChatId: calledSession.chatId, targetKind: 'kit', targetAgentId: 'kit-2', channel: 'local', depth: 1 })
      return { delegationId: 'd-1', state: 'gated' }
    })
    try {
      const mixed = await Promise.allSettled([
        taskToolService.tasksCreate(other, { title: 'D', description: 'x', assignee: 'kit:kit-2', id: 'work-d' }),
        taskToolService.tasksCreate(other, { title: 'C', description: 'x' })
      ])
      expect(mixed.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    } finally {
      holder.delegate.mockImplementation(async () => ({ delegationId: 'd-1', state: 'gated' }))
    }
  })

  it(`stops one chat at ${20} tool-created tasks, own and delegated together, and survives a restart by counting rows`, async () => {
    const kit = session('kit-1')
    for (let i = 0; i < TASK_TOOL_CHAT_CAP - 2; i += 1) await taskToolService.tasksCreate(kit, { title: `T${i}`, description: 'x' })
    delegationRepo.insert({ userId: USER, requesterKey: 'r1', originKind: 'local_chat', originChatId: kit.chatId, targetKind: 'kit', targetAgentId: 'kit-2', channel: 'local', depth: 1 })
    await taskToolService.tasksCreate(kit, { title: 'Last', description: 'x' })
    await expect(taskToolService.tasksCreate(kit, { title: 'One more', description: 'x' })).rejects.toThrow(`${TASK_TOOL_CHAT_CAP} tasks`)
    // A deleted task still counts: the cap is on creations.
    taskRepo.softDelete(USER, taskRepo.list(USER).find((row) => row.title === 'Last')!.id)
    await expect(taskToolService.tasksCreate(kit, { title: 'One more', description: 'x' })).rejects.toThrow(`${TASK_TOOL_CHAT_CAP} tasks`)
    // Another chat has its own allowance.
    await expect(taskToolService.tasksCreate(session('kit-1'), { title: 'Fresh', description: 'x' })).resolves.toBeTruthy()
  })
})

describe('tasks_create with an assignee is a delegation', () => {
  it('hands delegationService the same request, the description as the brief, and the cap as its new-request hook', async () => {
    const kit = session('kit-1')
    const result = await taskToolService.tasksCreate(kit, {
      title: 'Build it', description: 'The brief.', assignee: 'cinna:cinna:a',
      id: 'build-it', execution: 'ask', group: 'g1', category: 'ready'
    })
    expect(result).toEqual({ delegationId: 'd-1', state: 'gated' })
    const [calledSession, request, , options] = holder.delegate.mock.calls[0] as [unknown, unknown, unknown, { beforeNew(): void }]
    expect(calledSession).toBe(kit)
    expect(request).toEqual({ target: { kind: 'cloud', agentId: 'a', adapter: 'cinna' }, id: 'build-it', title: 'Build it', brief: 'The brief.', execution: 'ask', group: 'g1', status: 'ready' })
    expect(() => options.beforeNew()).not.toThrow()
    for (let i = 0; i < TASK_TOOL_CHAT_CAP; i += 1) {
      delegationRepo.insert({ userId: USER, requesterKey: `r${i}`, originKind: 'local_chat', originChatId: kit.chatId, targetKind: 'kit', targetAgentId: 'kit-2', channel: 'local', depth: 1 })
    }
    expect(() => options.beforeNew()).toThrow(`${TASK_TOOL_CHAT_CAP} tasks`)
  })

  it('refuses a parent on a delegation', async () => {
    await expect(taskToolService.tasksCreate(session('kit-1'), { title: 'X', description: 'Y', assignee: 'kit:kit-2', id: 'x-1', parent: 'p-1' }))
      .rejects.toThrow('own queue')
    expect(holder.delegate).not.toHaveBeenCalled()
  })

  it('hands priority and custom fields to the delegation, which puts them in a bare brief', async () => {
    await taskToolService.tasksCreate(session('kit-1'), {
      title: 'X', description: 'Y', assignee: 'folder:bare-2', id: 'x-1', priority: 'high', custom_fields: { estimate: 3 }
    })
    expect(holder.delegate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ priority: 'high', customFields: { estimate: 3 } }), undefined, expect.anything())
    await expect(taskToolService.tasksCreate(session('kit-1'), { title: 'X', description: 'Y', assignee: 'folder:bare-2', id: 'x-2', priority: 'soon' }))
      .rejects.toThrow('Choose a priority')
  })
})

describe('tasks_list', () => {
  it('lists what is assigned to, created by or delegated by the agent, open ones newest first, with their relations', async () => {
    const kit = session('kit-1')
    const own = await taskToolService.tasksCreate(kit, { title: 'Own', description: 'x' }) as { ref: string }
    const assigned = taskService.create(USER, { title: 'Assigned', goal: 'x', assigneeAgentId: 'kit-1', status: 'open' })
    const delegatedTask = taskService.create(USER, { title: 'Delegated', goal: 'x', assigneeAgentId: 'kit-2', createdByAgentId: 'kit-1' })
    delegationRepo.insert({ userId: USER, requesterKey: 'r', originKind: 'local_chat', originChatId: kit.chatId, originAgentId: 'kit-1', targetKind: 'kit', targetAgentId: 'kit-2', channel: 'local', depth: 1, taskId: delegatedTask.id, state: 'running' })
    const closed = taskService.create(USER, { title: 'Closed', goal: 'x', assigneeAgentId: 'kit-1' })
    taskService.setStatus(USER, closed.id, 'in_progress'); taskService.setStatus(USER, closed.id, 'completed')
    taskService.create(USER, { title: 'Someone else', goal: 'x', assigneeAgentId: 'kit-2' })
    // Another profile's task assigned to the same agent id is never listed.
    taskService.create('profile-2', { title: 'Other profile', goal: 'x', assigneeAgentId: 'kit-1' })

    const all = taskToolService.tasksList(kit, {}).tasks
    expect(all.map((task) => task.title).sort()).toEqual(['Assigned', 'Delegated', 'Own'])
    expect(all.find((task) => task.ref === own.ref)?.relations).toEqual(['assigned', 'created'])
    expect(all.find((task) => task.ref === delegatedTask.id)).toMatchObject({ relations: ['created', 'delegated'], delegation: { state: 'running' }, assignee: { agentId: 'kit-2' } })
    expect(all.find((task) => task.ref === assigned.id)).toMatchObject({ relations: ['assigned'], category: 'ready', status: 'open' })
    expect(taskToolService.tasksList(kit, { relation: 'delegated' }).tasks.map((task) => task.ref)).toEqual([delegatedTask.id])
    expect(taskToolService.tasksList(kit, { category: 'ready' }).tasks.map((task) => task.ref)).toEqual([assigned.id])
    expect(taskToolService.tasksList(kit, { include_closed: true }).tasks.map((task) => task.title)).toContain('Closed')
    expect(taskToolService.tasksList(kit, { category: 'done' }).tasks.map((task) => task.title)).toEqual(['Closed'])
    expect(() => taskToolService.tasksList(kit, { relation: 'mine' })).toThrow('relation')
  })

  it('answers at most 50, newest first', async () => {
    for (let i = 0; i < 55; i += 1) {
      taskRepo.create(USER, { title: `T${i}`, goal: 'x', assigneeAgentId: 'kit-1', createdAt: new Date(1_000_000 + i * 1000) })
    }
    const listed = taskToolService.tasksList(session('kit-1'), {})
    expect(listed.tasks).toHaveLength(50)
    expect(listed.tasks[0].title).toBe('T54')
    expect(listed).toMatchObject({ truncated: true, total: 55 })
  })
})

describe('tasks_update', () => {
  it('edits a task assigned to the agent and moves it by the board’s manual rules', async () => {
    const kit = session('kit-1')
    const task = taskService.create(USER, { title: 'Old', goal: 'x', assigneeAgentId: 'kit-1' })
    await taskToolService.tasksUpdate(kit, { ref: task.id, title: 'New', priority: 'urgent', category: 'ready' })
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ title: 'New', priority: 'urgent', status: 'open' })
    await expect(taskToolService.tasksUpdate(kit, { ref: task.id, category: 'in_progress' })).rejects.toThrow('tasks_report')
    await taskToolService.tasksUpdate(kit, { ref: task.id, category: 'done' })
    expect(taskRepo.getById(USER, task.id)?.status).toBe('completed')
  })

  it('edits a task the agent created only until a conversation ran it, and never a stranger’s', async () => {
    const kit = session('kit-1')
    const mine = taskService.create(USER, { title: 'Mine', goal: 'x', assigneeAgentId: 'kit-2', createdByAgentId: 'kit-1' })
    await taskToolService.tasksUpdate(kit, { ref: mine.id, description: 'Clearer.' })
    expect(taskRepo.getById(USER, mine.id)?.description).toBe('Clearer.')
    const started = taskService.create(USER, { title: 'Started', goal: 'x', assigneeAgentId: 'kit-2', createdByAgentId: 'kit-1', chatId: chatRepo.create(USER).id })
    await expect(taskToolService.tasksUpdate(kit, { ref: started.id, title: 'No' })).rejects.toThrow('until a conversation')
    const stranger = taskService.create(USER, { title: 'Stranger', goal: 'x', assigneeAgentId: 'kit-2' })
    await expect(taskToolService.tasksUpdate(kit, { ref: stranger.id, title: 'No' })).rejects.toThrow('assigned to you')
  })

  it('refuses a task with a live turn in another conversation', async () => {
    const kit = session('kit-1')
    const busyChat = chatRepo.create(USER)
    const task = taskService.create(USER, { title: 'Busy', goal: 'x', assigneeAgentId: 'kit-1', chatId: busyChat.id })
    holder.live.add(busyChat.id)
    await expect(taskToolService.tasksUpdate(kit, { ref: task.id, title: 'No' })).rejects.toThrow('another conversation')
    expect(taskRepo.getById(USER, task.id)?.title).toBe('Busy')
  })

  it('refuses a report-style move and points at tasks_report, on the current task and any other', async () => {
    const kit = session('kit-1', {})
    const task = taskRepo.getByChatId(USER, kit.chatId)!
    taskService.setStatus(USER, task.id, 'in_progress')
    for (const category of ['done', 'completed', 'blocked', 'error', 'failed', 'in_progress']) {
      await expect(taskToolService.tasksUpdate(kit, { ref: task.id, category })).rejects.toThrow('tasks_report')
    }
    expect(taskRepo.getById(USER, task.id)?.status).toBe('in_progress')
    const other = taskService.create(USER, { title: 'Other', goal: 'x', assigneeAgentId: 'kit-1' })
    await expect(taskToolService.tasksUpdate(kit, { ref: other.id, category: 'blocked' })).rejects.toThrow('tasks_report')
  })

  it('sends a delegated current task to tasks_report instead', async () => {
    const kit = session('kit-1', {})
    const task = taskRepo.getByChatId(USER, kit.chatId)!
    taskService.setStatus(USER, task.id, 'in_progress')
    delegationRepo.insert({ userId: USER, requesterKey: 'r', originKind: 'local_chat', originChatId: 'x', targetKind: 'kit', targetAgentId: 'kit-1', channel: 'local', depth: 1, taskId: task.id })
    await expect(taskToolService.tasksUpdate(kit, { ref: task.id, title: 'Renamed' })).rejects.toThrow('tasks_report')
    expect(taskRepo.getById(USER, task.id)?.status).toBe('in_progress')
  })

  it('never changes delegated work: its executor goes to tasks_report, its requester to tasks_reply', async () => {
    const executor = session('kit-2')
    const requester = session('kit-1')
    const task = taskService.create(USER, { title: 'Delegated', goal: 'x', assigneeAgentId: 'kit-2', createdByAgentId: 'kit-1' })
    delegationRepo.insert({ userId: USER, requesterKey: 'r', originKind: 'local_chat', originChatId: requester.chatId, originAgentId: 'kit-1', targetKind: 'kit', targetAgentId: 'kit-2', channel: 'local', depth: 1, taskId: task.id })
    await expect(taskToolService.tasksUpdate(executor, { ref: task.id, title: 'Renamed' })).rejects.toThrow('tasks_report')
    await expect(taskToolService.tasksUpdate(executor, { ref: task.id, category: 'ready' })).rejects.toThrow('tasks_report')
    await expect(taskToolService.tasksUpdate(requester, { ref: task.id, description: 'Changed brief' })).rejects.toThrow('tasks_reply')
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ title: 'Delegated', status: 'new' })
  })

  it('never changes a folder handover’s task either', async () => {
    const executor = session('kit-2')
    const task = taskService.create(USER, { title: 'Brief', goal: 'x', assigneeAgentId: 'kit-2' })
    const handover = vi.spyOn(handoverRepo, 'byTaskId').mockImplementation((_user, taskId) =>
      taskId === task.id ? ({ id: 'h-1', taskId, agentId: 'kit-2', originAgentId: 'kit-1' } as never) : undefined)
    try {
      await expect(taskToolService.tasksUpdate(executor, { ref: task.id, priority: 'high' })).rejects.toThrow('tasks_report')
      await expect(taskToolService.tasksUpdate(session('kit-1'), { ref: task.id, category: 'ready' })).rejects.toThrow()
    } finally {
      handover.mockRestore()
    }
    expect(taskRepo.getById(USER, task.id)?.priority).toBe('normal')
  })

  it('never closes a dispatched task, not even by cancelling it — that is tasks_report’s', async () => {
    const kit = session('kit-1', {})
    const task = taskRepo.getByChatId(USER, kit.chatId)!
    taskService.setStatus(USER, task.id, 'in_progress')
    holder.current!.sqlite.prepare('UPDATE tasks SET dispatch_agent_id = ? WHERE id = ?').run('kit-1', task.id)
    for (const category of ['cancelled', 'done']) {
      await expect(taskToolService.tasksUpdate(kit, { ref: task.id, category })).rejects.toThrow('tasks_report')
    }
    expect(taskRepo.getById(USER, task.id)?.status).toBe('in_progress')
    // Queued but never run: no chat yet, the dispatcher's mark alone refuses it.
    const queued = taskService.create(USER, { title: 'Queued', goal: 'x', assigneeAgentId: 'kit-1', status: 'open' })
    holder.current!.sqlite.prepare('UPDATE tasks SET dispatch_agent_id = ? WHERE id = ?').run('kit-1', queued.id)
    await expect(taskToolService.tasksUpdate(session('kit-1'), { ref: queued.id, category: 'cancelled' })).rejects.toThrow('tasks_report')
    expect(taskRepo.getById(USER, queued.id)?.status).toBe('open')
  })

  it('never closes from another chat a task a conversation ran, but still moves it between Backlog and Ready', async () => {
    const ranIn = chatRepo.create(USER)
    const ended = taskService.create(USER, { title: 'Ended', goal: 'x', assigneeAgentId: 'kit-1', chatId: ranIn.id })
    taskService.setStatus(USER, ended.id, 'in_progress')
    taskService.setStatus(USER, ended.id, 'blocked')
    taskService.setHandoffNote(USER, ended.id, 'Ended without reporting')
    const other = session('kit-1')
    for (const category of ['done', 'cancelled']) {
      await expect(taskToolService.tasksUpdate(other, { ref: ended.id, category })).rejects.toThrow('tasks_report')
    }
    expect(taskRepo.getById(USER, ended.id)?.status).toBe('blocked')

    const requeued = taskService.create(USER, { title: 'Ran once', goal: 'x', assigneeAgentId: 'kit-1', chatId: chatRepo.create(USER).id, status: 'open' })
    await taskToolService.tasksUpdate(other, { ref: requeued.id, category: 'backlog' })
    expect(taskRepo.getById(USER, requeued.id)?.status).toBe('new')
    await taskToolService.tasksUpdate(other, { ref: requeued.id, category: 'ready' })
    expect(taskRepo.getById(USER, requeued.id)?.status).toBe('open')
    await expect(taskToolService.tasksUpdate(other, { ref: requeued.id, category: 'cancelled' })).rejects.toThrow('tasks_report')
  })

  it('never closes a task with an open question on it', async () => {
    const kit = session('kit-1')
    const asked = taskService.create(USER, { title: 'Asked', goal: 'x', assigneeAgentId: 'kit-1', status: 'open' })
    const open = vi.spyOn(taskInputRequestRepo, 'listOpenForTask').mockImplementation((taskId) => (taskId === asked.id ? [{ id: 'ask-1' } as never] : []))
    try {
      await expect(taskToolService.tasksUpdate(kit, { ref: asked.id, category: 'cancelled' })).rejects.toThrow('tasks_report')
    } finally {
      open.mockRestore()
    }
    // The ask answered and gone, a never-run task closes like any person's.
    await taskToolService.tasksUpdate(kit, { ref: asked.id, category: 'cancelled' })
    expect(taskRepo.getById(USER, asked.id)?.status).toBe('cancelled')
  })

  it('takes a folder task’s own status word and writes it to the file', async () => {
    const bare = session('bare-1')
    const created = await taskToolService.tasksCreate(bare, { title: 'Word', description: 'x' }) as { ref: string; file: string }
    await taskToolService.tasksUpdate(bare, { ref: created.ref, category: 'next' })
    expect(taskRepo.getById(USER, created.ref)).toMatchObject({ status: 'open', statusLabel: 'next' })
    await settle()
    expect(readFileSync(join(holder.agentPath, created.file), 'utf8')).toContain('status: next')
    await expect(taskToolService.tasksUpdate(bare, { ref: created.ref, category: 'nonsense' })).rejects.toThrow('not a status')
  })
})

describe('tasks_comment', () => {
  it('stores the comment and lists it with the agent’s name; a native task has nowhere to copy it', async () => {
    const kit = session('kit-1')
    const task = taskService.create(USER, { title: 'T', goal: 'x', assigneeAgentId: 'kit-1' })
    const result = await taskToolService.tasksComment(kit, { ref: task.id, body: 'Halfway there.' }) as { commentId: string }
    expect(taskToolService.comments(SCOPE, task.id)).toEqual([expect.objectContaining({ id: result.commentId, authorKind: 'agent', authorAgentId: 'kit-1', authorName: 'Kit', body: 'Halfway there.', remoteStatus: null })])
    expect(taskCommentRepo.listForTask(USER, task.id)[0].remoteStatus).toBeNull()
    expect(taskToolService.comments({ ...SCOPE, profileUserId: 'profile-2' }, task.id)).toEqual([])
  })

  it('comments on tasks assigned to, created by or delegated by the agent, and refuses others and long bodies', async () => {
    const kit = session('kit-1')
    const delegated = taskService.create(USER, { title: 'D', goal: 'x', assigneeAgentId: 'kit-2' })
    delegationRepo.insert({ userId: USER, requesterKey: 'r', originKind: 'local_chat', originChatId: kit.chatId, originAgentId: 'kit-1', targetKind: 'kit', targetAgentId: 'kit-2', channel: 'local', depth: 1, taskId: delegated.id })
    await expect(taskToolService.tasksComment(kit, { ref: delegated.id, body: 'Ping.' })).resolves.toBeTruthy()
    const stranger = taskService.create(USER, { title: 'S', goal: 'x', assigneeAgentId: 'kit-2' })
    await expect(taskToolService.tasksComment(kit, { ref: stranger.id, body: 'Hi.' })).rejects.toThrow('only on tasks')
    await expect(taskToolService.tasksComment(kit, { ref: delegated.id, body: 'x'.repeat(8001) })).rejects.toThrow('8000')
  })

  it('appends to a folder task’s log section, leaving every other byte, and keeps Cinna’s file trusted', async () => {
    const bare = session('bare-1')
    const created = await taskToolService.tasksCreate(bare, { title: 'Logged', description: 'Do it.' }) as { ref: string; file: string }
    const path = join(holder.agentPath, created.file)
    const before = readFileSync(path, 'utf8')
    await taskToolService.tasksComment(bare, { ref: created.ref, body: 'Started.' })
    const after = readFileSync(path, 'utf8')
    expect(after.startsWith(before.trimEnd())).toBe(true)
    expect(after).toMatch(new RegExp(`${LOG_OPEN}\\n\\*\\*Uploader\\*\\* · .* UTC\\nStarted\\.\\n${LOG_CLOSE}\\n$`))
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, created.ref)).toMatchObject({ fromOutside: false, description: 'Do it.' })
    expect(taskCommentRepo.listForTask(USER, created.ref)[0].remoteStatus).toBe('sent')
  })

  it('does not make a file someone else changed look like Cinna’s', async () => {
    const bare = session('bare-1')
    const created = await taskToolService.tasksCreate(bare, { title: 'Edited', description: 'Do it.' }) as { ref: string; file: string }
    const path = join(holder.agentPath, created.file)
    writeFileSync(path, readFileSync(path, 'utf8').replace('Do it.', 'Do it differently.'))
    const when = new Date(Date.now() + 5_000)
    utimesSync(path, when, when)
    await taskToolService.tasksComment(bare, { ref: created.ref, body: 'Noted.' })
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, created.ref)).toMatchObject({ fromOutside: true, description: 'Do it differently.' })
    expect(readFileSync(path, 'utf8')).toContain('Noted.')
  })

  it('posts to a bound service’s comments, and a failed post fails nothing', async () => {
    const remote = createFakeRemote({ id: 'fake-service' })
    holder.adapters = [...holder.adapters, remote.adapter]
    const kit = session('kit-1')
    const task = taskService.create(USER, { title: 'Bound', goal: 'x', assigneeAgentId: 'kit-1' })
    const binding = remote.seed(taskService.getById(USER, task.id))
    taskService.bindRemote(USER, task.id, binding)
    await taskToolService.tasksComment(kit, { ref: task.id, body: 'First.' })
    expect(remote.stored(binding.id)?.comments.map((comment) => comment.body)).toEqual(['**Kit:** First.'])
    remote.behave('transport')
    const failed = await taskToolService.tasksComment(kit, { ref: task.id, body: 'Second.' }) as { warning?: string }
    expect(failed.warning).toContain('failed')
    expect(taskCommentRepo.listForTask(USER, task.id).map((row) => [row.body, row.remoteStatus])).toEqual([['First.', 'sent'], ['Second.', 'failed']])
  })
})

describe('tasks_report', () => {
  it('reports the chat’s own task done, blocked or failed, writes the note, and marks it reported for the turn end', async () => {
    const kit = session('kit-1', {})
    holder.live.add(kit.chatId)
    const task = taskRepo.getByChatId(USER, kit.chatId)!
    taskService.setStatus(USER, task.id, 'in_progress')
    await expect(taskToolService.tasksReport(kit, { status: 'blocked', summary: 'Stuck' })).rejects.toThrow('question')
    const result = await taskToolService.tasksReport(kit, { status: 'blocked', summary: 'Need the key', question: 'Which API key?', body: 'Tried env.' })
    expect(result).toEqual({ ref: task.id, status: 'blocked', taskStatus: 'blocked', category: 'waiting' })
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'blocked', handoffNote: 'Need the key\n\nQuestion: Which API key?\n\nTried env.' })
    // Marked for the run that reported it: only that run's end reads it.
    expect(takeAgentStatusReport(task.id, 'run-1')).toBe('blocked')
    expect(takeAgentStatusReport(task.id, 'run-1')).toBeUndefined()
  })

  it('maps done to completed and failed to error, keeps artifacts, and answers an identical repeat without writing', async () => {
    const bare = session('bare-1', {})
    const task = taskRepo.getByChatId(USER, bare.chatId)!
    taskService.setStatus(USER, task.id, 'in_progress')
    const report = { status: 'done', summary: 'Shipped', artifacts: ['out/report.md', { ref: 'https://x.test/pr/1', kind: 'link', name: 'PR' }] }
    const first = await taskToolService.tasksReport(bare, report)
    expect(taskRepo.getById(USER, task.id)).toMatchObject({ status: 'completed', handoffNote: 'Shipped',
      artifacts: [{ kind: 'file', name: 'report.md', ref: join(holder.agentPath, 'out/report.md') }, { kind: 'link', name: 'PR', ref: 'https://x.test/pr/1' }] })
    const setStatus = vi.spyOn(taskService, 'setHandoffNote')
    try {
      expect(await taskToolService.tasksReport(bare, report)).toEqual(first)
      expect(setStatus).not.toHaveBeenCalled()
    } finally {
      setStatus.mockRestore()
    }
    const other = session('kit-1', {})
    const failing = taskRepo.getByChatId(USER, other.chatId)!
    taskService.setStatus(USER, failing.id, 'in_progress')
    await taskToolService.tasksReport(other, { status: 'failed', summary: 'Build broke' })
    expect(taskRepo.getById(USER, failing.id)?.status).toBe('error')
  })

  it('refuses audience requester where no agent asked, and a chat with no task and no ref', async () => {
    const kit = session('kit-1', {})
    const task = taskRepo.getByChatId(USER, kit.chatId)!
    taskService.setStatus(USER, task.id, 'in_progress')
    await expect(taskToolService.tasksReport(kit, { status: 'blocked', summary: 'S', question: 'Q?', audience: 'requester' })).rejects.toThrow('requester')
    await expect(taskToolService.tasksReport(session('kit-1'), { status: 'done', summary: 'S' })).rejects.toThrow('pass ref')
  })

  it('marks a repeated identical report for the turn it came in, though it writes nothing', async () => {
    const kit = session('kit-1', {})
    holder.live.add(kit.chatId)
    const task = taskRepo.getByChatId(USER, kit.chatId)!
    taskService.setStatus(USER, task.id, 'in_progress')
    const report = { status: 'blocked', summary: 'Need the key', question: 'Which API key?' }
    await taskToolService.tasksReport(kit, report)
    // The first turn's end took its mark; the next turn repeats the report with the status unchanged.
    expect(takeAgentStatusReport(task.id, 'run-1')).toBe('blocked')
    expect(taskRepo.getById(USER, task.id)?.status).toBe('blocked')
    await taskToolService.tasksReport(kit, report)
    expect(takeAgentStatusReport(task.id, 'run-1')).toBe('blocked')
  })

  it('takes a bare executor’s report on a folder brief with no delegation behind it, through the handover', async () => {
    holder.report.mockClear()
    const executor = session('kit-2', {})
    const task = taskRepo.getByChatId(USER, executor.chatId)!
    taskService.setStatus(USER, task.id, 'in_progress')
    const handover = { id: 'h-1', userId: USER, taskId: task.id, agentId: 'kit-2', originAgentId: 'kit-1', folderPath: holder.agentPath }
    const byTask = vi.spyOn(handoverRepo, 'byTaskId').mockImplementation((_user, taskId) => (taskId === task.id ? handover as never : undefined))
    const { handoverService } = await import('./handoverService')
    const apply = vi.spyOn(handoverService, 'applyReport').mockImplementation(() => {})
    try {
      const result = await taskToolService.tasksReport(executor, {
        status: 'done', summary: 'Shipped', body: 'Notes.', artifacts: ['out/report.md', 'https://x.test/pr/1']
      })
      expect(result).toEqual({ handoverId: 'h-1', ref: task.id, status: 'done' })
      expect(apply).toHaveBeenCalledWith(SCOPE, handover, {
        status: 'done', summary: 'Shipped', question: null, artifacts: ['out/report.md'], body: 'Notes.\n\n- https://x.test/pr/1: https://x.test/pr/1'
      })
      expect(holder.report).not.toHaveBeenCalled()
    } finally {
      apply.mockRestore()
      byTask.mockRestore()
    }
  })

  it('sends a delegation executor’s report through the bus, and a requester to tasks_reply', async () => {
    holder.report.mockClear()
    const executor = session('kit-2', {})
    const task = taskRepo.getByChatId(USER, executor.chatId)!
    const requester = session('kit-1')
    delegationRepo.insert({ userId: USER, requesterKey: 'r', originKind: 'local_chat', originChatId: requester.chatId, originAgentId: 'kit-1', targetKind: 'kit', targetAgentId: 'kit-2', channel: 'local', depth: 1, taskId: task.id })
    const input = { status: 'done', summary: 'Done' }
    await taskToolService.tasksReport(executor, input)
    expect(holder.report).toHaveBeenCalledWith(executor, input)
    await expect(taskToolService.tasksReport(requester, { ref: task.id, status: 'done', summary: 'x' })).rejects.toThrow('tasks_reply')
    expect(holder.report).toHaveBeenCalledTimes(1)
  })

  it('takes the report on a job run’s task too, but never on a runtime’s', async () => {
    const kit = session('kit-1', {})
    holder.live.add(kit.chatId)
    const task = taskRepo.getByChatId(USER, kit.chatId)!
    taskService.setStatus(USER, task.id, 'in_progress')
    holder.current!.sqlite.prepare('UPDATE tasks SET job_run_id = ? WHERE id = ?').run('job-run-1', task.id)
    await taskToolService.tasksReport(kit, { status: 'blocked', summary: 'Waiting', question: 'Go on?' })
    expect(taskRepo.getById(USER, task.id)?.status).toBe('blocked')
    expect(takeAgentStatusReport(task.id, 'run-1')).toBe('blocked')

    holder.current!.sqlite.prepare("UPDATE tasks SET job_run_id = NULL, status = 'in_progress' WHERE id = ?").run(task.id)
    taskRunnersByChat.set(kit.chatId, { userId: USER, taskId: task.id, id: 'runner-1', working: true, cancel: () => {} })
    try {
      await expect(taskToolService.tasksReport(kit, { status: 'failed', summary: 'No' })).rejects.toThrow('runtime')
    } finally {
      taskRunnersByChat.delete(kit.chatId)
    }
    expect(taskRepo.getById(USER, task.id)?.status).toBe('in_progress')
  })
})

describe('tasks_get', () => {
  it('reads a task that concerns the agent in full, and refuses a stranger’s', async () => {
    const bare = session('bare-1')
    const created = await taskToolService.tasksCreate(bare, { title: 'Read me', description: 'All of it.', priority: 'high', custom_fields: { estimate: 2 } }) as { ref: string; file: string }
    await taskToolService.tasksComment(bare, { ref: created.ref, body: 'One.' })
    const got = await taskToolService.tasksGet(bare, { ref: created.ref })
    expect(got).toMatchObject({ ref: created.ref, title: 'Read me', goal: 'All of it.', status: 'new', category: 'backlog', priority: 'high',
      relations: ['assigned', 'created'], custom_fields: { estimate: 2 }, file: created.file, blocked_by: [], report: null, delegation: null, delegations: [],
      comments: [{ author: 'Uploader', body: 'One.' }] })
    const stranger = taskService.create(USER, { title: 'S', goal: 'x', assigneeAgentId: 'kit-2' })
    await expect(taskToolService.tasksGet(bare, { ref: stranger.id })).rejects.toThrow('only tasks')
  })
})

describe('tasks_comment defaults and files', () => {
  it('comments on the chat’s own task without a ref', async () => {
    const kit = session('kit-1', {})
    const task = taskRepo.getByChatId(USER, kit.chatId)!
    expect(await taskToolService.tasksComment(kit, { body: 'Here.' })).toMatchObject({ ref: task.id })
  })

  it('refuses files where the task has nowhere to keep them, and a missing file, posting nothing', async () => {
    const bare = session('bare-1')
    const created = await taskToolService.tasksCreate(bare, { title: 'Files', description: 'x' }) as { ref: string }
    writeFileSync(join(holder.agentPath, 'notes.txt'), 'n')
    await expect(taskToolService.tasksComment(bare, { ref: created.ref, body: 'See.', files: ['notes.txt'] })).rejects.toThrow('Attachments are not supported for this task')
    await expect(taskToolService.tasksComment(bare, { ref: created.ref, body: 'See.', files: ['missing.txt'] })).rejects.toThrow('nothing was posted')
    await expect(taskToolService.tasksComment(bare, { ref: created.ref, body: 'See.', files: ['../escape.txt'] })).rejects.toThrow('outside your folder')
    expect(taskCommentRepo.listForTask(USER, created.ref)).toEqual([])
  })

  it('uploads files to a bound service that stores them', async () => {
    const remote = createFakeRemote({ id: 'fake-files', capabilities: { writeArtifactKinds: ['file'] } })
    holder.adapters = [...holder.adapters, remote.adapter]
    const bare = session('bare-1')
    const task = taskService.create(USER, { title: 'Bound', goal: 'x', assigneeAgentId: 'bare-1' })
    taskService.bindRemote(USER, task.id, remote.seed(taskService.getById(USER, task.id)))
    writeFileSync(join(holder.agentPath, 'notes.txt'), 'n')
    const put = vi.spyOn(remote.adapter, 'putArtifact')
    const result = await taskToolService.tasksComment(bare, { ref: task.id, body: 'See.', files: ['notes.txt'] })
    expect(result).toMatchObject({ ref: task.id, attached: ['notes.txt'] })
    expect(put).toHaveBeenCalledWith(USER, expect.anything(), { kind: 'file', name: 'notes.txt', ref: join(holder.agentPath, 'notes.txt') })
  })
})

describe('the turn header count', () => {
  it('counts ready tasks assigned to the agent in this profile, not deleted', () => {
    taskService.create(USER, { title: 'A', goal: 'x', assigneeAgentId: 'kit-1', status: 'open' })
    const gone = taskService.create(USER, { title: 'B', goal: 'x', assigneeAgentId: 'kit-1', status: 'open' })
    taskService.create(USER, { title: 'C', goal: 'x', assigneeAgentId: 'kit-1', status: 'new' })
    taskService.create(USER, { title: 'D', goal: 'x', assigneeAgentId: 'kit-2', status: 'open' })
    taskService.create('profile-2', { title: 'E', goal: 'x', assigneeAgentId: 'kit-1', status: 'open' })
    taskRepo.softDelete(USER, gone.id)
    expect(taskRepo.countReadyFor(USER, 'kit-1')).toBe(1)
  })
})

describe('a conversation taking a task on itself (session-owned)', () => {
  const ALREADY = (ref: string): string => `This conversation is already working on ${ref}`

  it('creates an `active` task in its own queue In progress, bound to this chat and owned by it', async () => {
    const kit = session('kit-1')
    const created = await taskToolService.tasksCreate(kit, { title: 'Ship it', description: 'Now.', category: 'active' }) as Record<string, unknown>
    expect(created).toMatchObject({ status: 'in_progress', category: 'active', attached: true })
    const row = taskRepo.getById(USER, created.ref as string)!
    expect(row).toMatchObject({ chatId: kit.chatId, sessionOwned: true, status: 'in_progress', assigneeAgentId: 'kit-1', createdByChatId: kit.chatId })
    expect(row.startedAt).not.toBeNull()
    expect(taskService.getById(USER, row.id)).toMatchObject({ sessionOwned: true, chat: { id: kit.chatId, title: 'New Chat', running: false } })
    holder.live.add(kit.chatId)
    expect(taskService.list(USER).find((task) => task.id === row.id)?.chat).toEqual({ id: kit.chatId, title: 'New Chat', running: true })
    // A task with no chat names none.
    const later = await taskToolService.tasksCreate(kit, { title: 'Later', description: 'x' }) as { ref: string }
    expect(taskService.getById(USER, later.ref)).toMatchObject({ chat: null, sessionOwned: false })
  })

  it('writes a bare agent’s `active` task to its file with the folder’s active word', async () => {
    const bare = session('bare-1')
    const created = await taskToolService.tasksCreate(bare, { title: 'Fix it now', description: 'x', category: 'active' }) as { ref: string; file: string }
    expect(taskRepo.getById(USER, created.ref)).toMatchObject({ chatId: bare.chatId, sessionOwned: true, status: 'in_progress', deviceLocal: true })
    await settle()
    expect(readFileSync(join(holder.agentPath, created.file), 'utf8')).toContain('status: in_progress')
  })

  it('refuses `active` with an assignee, and from a chat that already has a task, creating nothing', async () => {
    const kit = session('kit-1')
    await expect(taskToolService.tasksCreate(kit, { title: 'X', description: 'Y', category: 'active', assignee: 'kit:kit-2' }))
      .rejects.toThrow('`category: active` is for your own queue; a delegation starts at once')
    expect(holder.delegate).not.toHaveBeenCalled()
    const first = await taskToolService.tasksCreate(kit, { title: 'First', description: 'Y', category: 'active' }) as { ref: string }
    const before = taskRepo.list(USER).length
    await expect(taskToolService.tasksCreate(kit, { title: 'Second', description: 'Y', category: 'active' })).rejects.toThrow(ALREADY(first.ref))
    expect(taskRepo.list(USER)).toHaveLength(before)
    // A plain create from the bound chat still goes to the queue.
    const plainCreate = await taskToolService.tasksCreate(kit, { title: 'Later', description: 'Y' }) as Record<string, unknown>
    expect(plainCreate).not.toHaveProperty('attached')
    expect(taskRepo.getById(USER, plainCreate.ref as string)).toMatchObject({ status: 'new', chatId: null, sessionOwned: false })
  })

  it('binds a chat with no task to a task the agent created, by an `in_progress` report', async () => {
    const created = await taskToolService.tasksCreate(session('kit-1'), { title: 'Queued', description: 'x', category: 'ready' }) as { ref: string }
    const kit = session('kit-1')
    holder.live.add(kit.chatId)
    const result = await taskToolService.tasksReport(kit, { ref: created.ref, status: 'in_progress', summary: 'Starting' })
    expect(result).toEqual({ ref: created.ref, status: 'in_progress', taskStatus: 'in_progress', category: 'active', attached: true })
    expect(taskRepo.getById(USER, created.ref)).toMatchObject({ chatId: kit.chatId, sessionOwned: true, status: 'in_progress', handoffNote: 'Starting' })
    expect(taskRepo.getByChatId(USER, kit.chatId)?.id).toBe(created.ref)
    // Marked like the chat's own task.
    expect(takeAgentStatusReport(created.ref, 'run-1')).toBe('in_progress')
  })

  it('binds to a task a person assigned it, and `blocked` lands Waiting with the question', async () => {
    const assigned = taskService.create(USER, { title: 'From a person', goal: 'x', assigneeAgentId: 'kit-1' })
    const kit = session('kit-1')
    const result = await taskToolService.tasksReport(kit, { ref: assigned.id, status: 'blocked', summary: 'Need input', question: 'Which branch?' })
    expect(result).toMatchObject({ ref: assigned.id, status: 'blocked', taskStatus: 'blocked', attached: true })
    expect(taskRepo.getById(USER, assigned.id)).toMatchObject({ chatId: kit.chatId, sessionOwned: true, status: 'blocked', handoffNote: 'Need input\n\nQuestion: Which branch?' })
  })

  it('assigns an unassigned task it created to the caller on bind', async () => {
    const mine = taskService.create(USER, { title: 'Unassigned', goal: 'x', createdByAgentId: 'kit-1' })
    const kit = session('kit-1')
    await taskToolService.tasksReport(kit, { ref: mine.id, status: 'in_progress', summary: 'On it' })
    expect(taskRepo.getById(USER, mine.id)).toMatchObject({ chatId: kit.chatId, sessionOwned: true, assigneeAgentId: 'kit-1', assigneeKind: 'agent', assigneeName: 'Kit' })
  })

  it('takes a folder task’s file id as its ref, for the agent whose folder it is, and answers the row id', async () => {
    mkdirSync(join(holder.agentPath, '.cinna', 'tasks'), { recursive: true })
    writeFileSync(join(holder.agentPath, '.cinna', 'tasks', 'ITAN-2026-0019.md'), '---\ncinna_task: 1\nid: ITAN-2026-0019\ntitle: Ticket\nstatus: todo\n---\nThe ticket.\n')
    await taskSyncService.pull(USER)
    const row = taskRepo.list(USER).find((candidate) => candidate.title === 'Ticket')!
    expect(row.remoteId).toBe('bare-1:ITAN-2026-0019')
    // Another agent's chat does not see this folder's ids.
    await expect(taskToolService.tasksGet(session('kit-1'), { ref: 'ITAN-2026-0019' })).rejects.toThrow('No task with that ref.')
    const bare = session('bare-1')
    expect(await taskToolService.tasksGet(bare, { ref: 'ITAN-2026-0019' })).toMatchObject({ ref: row.id, title: 'Ticket' })
    const result = await taskToolService.tasksReport(bare, { ref: 'ITAN-2026-0019', status: 'in_progress', summary: 'Picked up' })
    expect(result).toMatchObject({ ref: row.id, attached: true })
    expect(taskRepo.getById(USER, row.id)).toMatchObject({ chatId: bare.chatId, sessionOwned: true, status: 'in_progress' })
  })

  it('finds a file id written a moment ago after one index pass', async () => {
    const { taskSyncScheduler } = await import('./taskSyncScheduler')
    const refresh = vi.spyOn(taskSyncScheduler, 'refresh').mockImplementation(() => taskSyncService.pull(USER))
    try {
      mkdirSync(join(holder.agentPath, '.cinna', 'tasks'), { recursive: true })
      writeFileSync(join(holder.agentPath, '.cinna', 'tasks', 'fresh.md'), '---\ncinna_task: 1\nid: ITAN-2026-0020\ntitle: Fresh\nstatus: todo\n---\n')
      const bare = session('bare-1')
      const result = await taskToolService.tasksReport(bare, { ref: 'ITAN-2026-0020', status: 'in_progress', summary: 'Go' }) as { ref: string }
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(taskRepo.getById(USER, result.ref)).toMatchObject({ title: 'Fresh', chatId: bare.chatId, sessionOwned: true })
      await expect(taskToolService.tasksGet(bare, { ref: 'ITAN-2026-9999' })).rejects.toThrow('No task with that ref.')
      expect(refresh).toHaveBeenCalledTimes(2)
    } finally {
      refresh.mockRestore()
    }
  })

  it('refuses a report on a task another conversation took on itself, in cinna-core’s words, until that one is in the trash', async () => {
    const other = session('kit-1')
    const owned = await taskToolService.tasksCreate(other, { title: 'Elsewhere', description: 'x', category: 'active' }) as { ref: string }
    const kit = session('kit-1')
    for (const status of ['in_progress', 'done']) {
      await expect(taskToolService.tasksReport(kit, { ref: owned.ref, status, summary: 'Mine now' }))
        .rejects.toThrow(`${owned.ref} is being worked on in another conversation; only that conversation can report on it`)
    }
    expect(taskRepo.getById(USER, owned.ref)).toMatchObject({ chatId: other.chatId, sessionOwned: true, status: 'in_progress' })
    // In the trash: the row names no chat, though `chatId` keeps it; another conversation may close it.
    chatRepo.softDelete(USER, other.chatId)
    expect(taskService.getById(USER, owned.ref)).toMatchObject({ chatId: other.chatId, chat: null })
    const result = await taskToolService.tasksReport(kit, { ref: owned.ref, status: 'done', summary: 'Finished it' })
    expect(result).toEqual({ ref: owned.ref, status: 'done', taskStatus: 'completed', category: 'done' })
  })

  it('closes from another conversation a dispatched task one left “Ended without reporting”, unless a turn runs there', async () => {
    const other = session('kit-1')
    const dispatched = taskService.create(USER, { title: 'Dispatched', goal: 'x', assigneeAgentId: 'kit-1' })
    taskService.start(USER, dispatched.id, { chatId: other.chatId })
    taskService.setStatus(USER, dispatched.id, 'blocked')
    const kit = session('kit-1')
    holder.live.add(other.chatId)
    await expect(taskToolService.tasksReport(kit, { ref: dispatched.id, status: 'done', summary: 'Done' }))
      .rejects.toThrow('This task has a turn running in another conversation; try again once it ends.')
    holder.live.delete(other.chatId)
    const result = await taskToolService.tasksReport(kit, { ref: dispatched.id, status: 'done', summary: 'Done' })
    expect(result).toEqual({ ref: dispatched.id, status: 'done', taskStatus: 'completed', category: 'done' })
    expect(taskRepo.getById(USER, dispatched.id)).toMatchObject({ chatId: other.chatId, sessionOwned: false, status: 'completed' })
  })

  /** A chat's lazy task as an ask makes it (`inboxService.taskForChat`), Done at that turn's end. */
  function lazyDoneTask(chatId: string) {
    const lazy = taskService.create(USER, { title: 'Chat', goal: 'Hello', origin: 'local', executor: 'desktop', chatId, assigneeAgentId: 'kit-1', assigneeKind: 'agent', askBorn: true })
    taskService.start(USER, lazy.id, { chatId })
    taskService.setStatus(USER, lazy.id, 'completed')
    return lazy
  }

  /** The next typed message, through the real acceptance path: it reopens a lazy task. */
  async function typeMessage(chatId: string, turnId: string): Promise<void> {
    const { inboxService } = await import('./inboxService')
    inboxService.resumeChat({ userId: USER, chatId, agentId: 'kit-1', turnId }, 'one more thing')
  }

  it('takes an `active` create in a chat whose lazy task a typed message reopened, settling that one Done, and the new task stays the chat’s', async () => {
    const kit = session('kit-1')
    const lazy = lazyDoneTask(kit.chatId)
    await typeMessage(kit.chatId, 'run-2')
    expect(taskRepo.getById(USER, lazy.id)?.status).toBe('in_progress')
    const created = await taskToolService.tasksCreate(kit, { title: 'Next', description: 'x', category: 'active' }) as { ref: string }
    expect(created).toMatchObject({ status: 'in_progress', attached: true })
    expect(taskRepo.getById(USER, lazy.id)).toMatchObject({ status: 'completed', sessionOwned: false, chatId: kit.chatId })
    expect(taskRepo.getById(USER, created.ref)).toMatchObject({ chatId: kit.chatId, sessionOwned: true })
    // Whatever touches the settled one later, the chat's task is the one in hand.
    holder.current!.sqlite.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) + 3600, lazy.id)
    expect(taskRepo.getByChatId(USER, kit.chatId)?.id).toBe(created.ref)
    await expect(taskToolService.tasksCreate(kit, { title: 'Third', description: 'x', category: 'active' })).rejects.toThrow(ALREADY(created.ref))
    const report = await taskToolService.tasksReport(kit, { status: 'in_progress', summary: 'Going' })
    expect(report).toMatchObject({ ref: created.ref })
  })

  it('attaches by report in a chat whose lazy task a typed message reopened, settling that one Done', async () => {
    const kit = session('kit-1')
    const lazy = lazyDoneTask(kit.chatId)
    await typeMessage(kit.chatId, 'run-2')
    const queued = taskService.create(USER, { title: 'Queued', goal: 'x', assigneeAgentId: 'kit-1' })
    const result = await taskToolService.tasksReport(kit, { ref: queued.id, status: 'in_progress', summary: 'On it' })
    expect(result).toMatchObject({ ref: queued.id, taskStatus: 'in_progress', attached: true })
    expect(taskRepo.getById(USER, queued.id)).toMatchObject({ chatId: kit.chatId, sessionOwned: true })
    expect(taskRepo.getById(USER, lazy.id)?.status).toBe('completed')
    expect(taskRepo.getByChatId(USER, kit.chatId)?.id).toBe(queued.id)
  })

  it('refuses an `active` create in a chat a person’s task was continued into, leaving that task in progress', async () => {
    const kit = session('kit-1')
    // A task the person made, taken over and continued into this fresh chat
    // (`taskStartService`): In progress, bound here, not owned, no ask — but not ask-born.
    const person = taskService.create(USER, { title: 'Mine', goal: 'Do it', origin: 'local', executor: 'desktop', assigneeAgentId: 'kit-1', assigneeKind: 'agent' })
    taskService.start(USER, person.id, { chatId: kit.chatId })
    expect(taskRepo.getById(USER, person.id)).toMatchObject({ chatId: kit.chatId, status: 'in_progress', sessionOwned: false, askBorn: false })
    await expect(taskToolService.tasksCreate(kit, { title: 'Next', description: 'x', category: 'active' })).rejects.toThrow(ALREADY(person.id))
    const queued = taskService.create(USER, { title: 'Queued', goal: 'x', assigneeAgentId: 'kit-1' })
    const result = await taskToolService.tasksReport(kit, { ref: queued.id, status: 'in_progress', summary: 'Noted' })
    expect(result).not.toHaveProperty('attached')
    expect(taskRepo.getById(USER, person.id)).toMatchObject({ status: 'in_progress', chatId: kit.chatId })
    expect(taskRepo.getByChatId(USER, kit.chatId)?.id).toBe(person.id)
  })

  it('keeps refusing while the reopened lazy task has an open ask', async () => {
    const kit = session('kit-1')
    const lazy = lazyDoneTask(kit.chatId)
    await typeMessage(kit.chatId, 'run-2')
    taskInputRequestRepo.open({ requestId: 'ask-1', taskId: lazy.id, chatId: kit.chatId, agentId: 'kit-1', invocationId: 'run-2', request: { kind: 'question', questions: [{ question: 'Which?' }] } as never, resume: 'next_message' })
    await expect(taskToolService.tasksCreate(kit, { title: 'Next', description: 'x', category: 'active' })).rejects.toThrow(ALREADY(lazy.id))
    const queued = taskService.create(USER, { title: 'Queued', goal: 'x', assigneeAgentId: 'kit-1' })
    const result = await taskToolService.tasksReport(kit, { ref: queued.id, status: 'in_progress', summary: 'Noted' })
    expect(result).not.toHaveProperty('attached')
    expect(taskRepo.getById(USER, lazy.id)?.status).toBe('in_progress')
  })

  it('attaches a task whose ownership is stale: owned, with no chat (a peer never receives `chat_id`)', async () => {
    const queued = taskService.create(USER, { title: 'From a peer', goal: 'x', assigneeAgentId: 'kit-1' })
    holder.current!.sqlite.prepare('UPDATE tasks SET session_owned = 1 WHERE id = ?').run(queued.id)
    expect(taskRepo.getById(USER, queued.id)).toMatchObject({ sessionOwned: true, chatId: null })
    const kit = session('kit-1')
    const result = await taskToolService.tasksReport(kit, { ref: queued.id, status: 'in_progress', summary: 'Mine' })
    expect(result).toMatchObject({ ref: queued.id, attached: true })
    expect(taskRepo.getById(USER, queued.id)).toMatchObject({ chatId: kit.chatId, sessionOwned: true, status: 'in_progress' })
  })

  it('sees a dispatcher flight that took the task while the bind was waiting, and binds nothing', async () => {
    const { setDispatchHoldsTask } = await import('../tasks/dispatchedTurns')
    const queued = taskService.create(USER, { title: 'Contended', goal: 'x', assigneeAgentId: 'kit-1' })
    // Free when the report looks, held by the time the bind checks.
    let looks = 0
    setDispatchHoldsTask((_user, taskId) => taskId === queued.id && looks++ > 0)
    try {
      await expect(taskToolService.tasksReport(session('kit-1'), { ref: queued.id, status: 'in_progress', summary: 'S' }))
        .rejects.toThrow(`${queued.id} is no longer waiting to be picked up; read it with tasks_get`)
    } finally {
      setDispatchHoldsTask(null)
    }
    expect(taskRepo.getById(USER, queued.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'new' })
  })

  it('refuses a report from another conversation on a task a dispatcher flight holds, leaving its status', async () => {
    const { setDispatchHoldsTask } = await import('../tasks/dispatchedTurns')
    const kit = session('kit-1', {})
    const waiting = taskService.create(USER, { title: 'Queued', goal: 'x', assigneeAgentId: 'kit-1' })
    const running = taskService.create(USER, { title: 'Running', goal: 'x', assigneeAgentId: 'kit-1' })
    taskService.setStatus(USER, running.id, 'in_progress')
    setDispatchHoldsTask((_user, taskId) => taskId === waiting.id || taskId === running.id)
    try {
      await expect(taskToolService.tasksReport(kit, { ref: waiting.id, status: 'done', summary: 'S' }))
        .rejects.toThrow(`${waiting.id} is no longer waiting to be picked up; read it with tasks_get`)
      await expect(taskToolService.tasksReport(kit, { ref: running.id, status: 'done', summary: 'S' }))
        .rejects.toThrow('This task has a turn running in another conversation; try again once it ends.')
    } finally {
      setDispatchHoldsTask(null)
    }
    expect(taskRepo.getById(USER, waiting.id)?.status).toBe('new')
    expect(taskRepo.getById(USER, running.id)?.status).toBe('in_progress')
  })

  it('puts back the assignee it gave an unassigned task when the start fails', async () => {
    const mine = taskService.create(USER, { title: 'Unassigned', goal: 'x', createdByAgentId: 'kit-1' })
    const before = taskRepo.getById(USER, mine.id)!
    const start = vi.spyOn(taskService, 'start').mockImplementationOnce(() => { throw new Error('disk full') })
    try {
      await expect(taskToolService.tasksReport(session('kit-1'), { ref: mine.id, status: 'in_progress', summary: 'S' })).rejects.toThrow('disk full')
    } finally {
      start.mockRestore()
    }
    expect(taskRepo.getById(USER, mine.id)).toMatchObject({
      chatId: null, sessionOwned: false, status: 'new',
      assigneeAgentId: before.assigneeAgentId, assigneeKind: before.assigneeKind, assigneeName: before.assigneeName
    })
  })

  it('takes `blocked` on a never-started task from a chat with a task of its own through In progress', async () => {
    const kit = session('kit-1', {})
    const fresh = taskService.create(USER, { title: 'Fresh', goal: 'x', assigneeAgentId: 'kit-1' })
    const result = await taskToolService.tasksReport(kit, { ref: fresh.id, status: 'blocked', summary: 'Stuck', question: 'Which?' })
    expect(result).toMatchObject({ ref: fresh.id, status: 'blocked', taskStatus: 'blocked' })
    expect(result).not.toHaveProperty('attached')
    expect(taskRepo.getById(USER, fresh.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'blocked' })
  })

  it('attaches a second task by report once the chat’s session-owned task was reported done', async () => {
    const kit = session('kit-1')
    holder.live.add(kit.chatId)
    const first = await taskToolService.tasksCreate(kit, { title: 'First', description: 'x', category: 'active' }) as { ref: string }
    await taskToolService.tasksReport(kit, { status: 'done', summary: 'Shipped' })
    expect(taskRepo.getById(USER, first.ref)?.status).toBe('completed')
    const queued = taskService.create(USER, { title: 'Queued', goal: 'x', assigneeAgentId: 'kit-1' })
    const result = await taskToolService.tasksReport(kit, { ref: queued.id, status: 'in_progress', summary: 'Next one' })
    expect(result).toMatchObject({ ref: queued.id, taskStatus: 'in_progress', attached: true })
    expect(taskRepo.getById(USER, queued.id)).toMatchObject({ chatId: kit.chatId, sessionOwned: true, status: 'in_progress' })
    expect(taskRepo.getByChatId(USER, kit.chatId)?.id).toBe(queued.id)
  })

  it.each([['done', 'completed'], ['failed', 'error']] as const)('closes a session-owned task from Waiting with `%s`', async (status, taskStatus) => {
    const kit = session('kit-1')
    const created = await taskToolService.tasksCreate(kit, { title: 'Ask first', description: 'x', category: 'active' }) as { ref: string }
    await taskToolService.tasksReport(kit, { status: 'blocked', summary: 'Need input', question: 'Which branch?' })
    expect(taskRepo.getById(USER, created.ref)?.status).toBe('blocked')
    const result = await taskToolService.tasksReport(kit, { status, summary: 'Ended' })
    expect(result).toMatchObject({ ref: created.ref, status, taskStatus })
    expect(taskRepo.getById(USER, created.ref)).toMatchObject({ chatId: kit.chatId, sessionOwned: true, status: taskStatus })
  })

  it('fails a kit agent’s unknown ref at once, with no index pass', async () => {
    const { taskSyncScheduler } = await import('./taskSyncScheduler')
    const refresh = vi.spyOn(taskSyncScheduler, 'refresh').mockResolvedValue(undefined as never)
    try {
      await expect(taskToolService.tasksReport(session('kit-1'), { ref: 'ITAN-2026-0404', status: 'in_progress', summary: 'S' })).rejects.toThrow('No task with that ref.')
      await expect(taskToolService.tasksCreate(session('kit-1'), { title: 'Sub', description: 'x', parent: 'ITAN-2026-0404' })).rejects.toThrow('No task with that ref.')
      expect(refresh).not.toHaveBeenCalled()
    } finally {
      refresh.mockRestore()
    }
  })

  it('waits for a folder agent’s index pass outside the chat’s lock, and stops waiting when the call is aborted', async () => {
    const { taskSyncScheduler } = await import('./taskSyncScheduler')
    let finish: () => void = () => {}
    const pass = new Promise<void>((resolve) => { finish = resolve })
    const refresh = vi.spyOn(taskSyncScheduler, 'refresh').mockImplementation(() => pass as never)
    try {
      const bare = session('bare-1')
      const controller = new AbortController()
      const waiting = taskToolService.tasksReport(bare, { ref: 'ITAN-2026-0505', status: 'in_progress', summary: 'S' }, controller.signal)
      void waiting.catch(() => {})
      await settle()
      expect(refresh).toHaveBeenCalledTimes(1)
      // Another call in the same chat is not held behind the wait.
      await expect(taskToolService.tasksReport(bare, { status: 'in_progress', summary: 'S' })).rejects.toThrow('pass ref')
      controller.abort()
      await expect(waiting).rejects.toThrow()
    } finally {
      finish()
      refresh.mockRestore()
    }
  })

  it('never attaches a script task, one with an unresolved remote handoff, or one a dispatcher flight holds', async () => {
    const { taskHandoffRepo } = await import('../db/taskHandoffs')
    const { setDispatchHoldsTask } = await import('../tasks/dispatchedTurns')
    const scripted = taskService.create(USER, { title: 'Scripted', goal: 'x', assigneeAgentId: 'kit-1' })
    holder.current!.sqlite.prepare("UPDATE tasks SET router = 'script' WHERE id = ?").run(scripted.id)
    const handedOff = taskService.create(USER, { title: 'Handed off', goal: 'x', assigneeAgentId: 'kit-1' })
    const flown = taskService.create(USER, { title: 'In flight', goal: 'x', assigneeAgentId: 'kit-1' })
    const unresolved = vi.spyOn(taskHandoffRepo, 'unresolved').mockImplementation((_user, taskId) => taskId === handedOff.id)
    setDispatchHoldsTask((_user, taskId) => taskId === flown.id)
    try {
      for (const task of [scripted, handedOff]) {
        const kit = session('kit-1')
        const result = await taskToolService.tasksReport(kit, { ref: task.id, status: 'in_progress', summary: 'S' })
        expect(result).not.toHaveProperty('attached')
        expect(taskRepo.getById(USER, task.id)).toMatchObject({ chatId: null, sessionOwned: false })
      }
      // The flight's task takes no report from a conversation at all.
      await expect(taskToolService.tasksReport(session('kit-1'), { ref: flown.id, status: 'in_progress', summary: 'S' }))
        .rejects.toThrow(`${flown.id} is no longer waiting to be picked up; read it with tasks_get`)
      expect(taskRepo.getById(USER, flown.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'new' })
    } finally {
      unresolved.mockRestore()
      setDispatchHoldsTask(null)
    }
  })

  it('answers in cinna-core’s words when the task moved on before the bind could start it', async () => {
    const queued = taskService.create(USER, { title: 'Raced', goal: 'x', assigneeAgentId: 'kit-1' })
    const start = vi.spyOn(taskService, 'start').mockImplementationOnce((_user, taskId) => {
      holder.current!.sqlite.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(taskId)
      throw new Error('Task cannot go from cancelled to in_progress')
    })
    try {
      await expect(taskToolService.tasksReport(session('kit-1'), { ref: queued.id, status: 'in_progress', summary: 'S' }))
        .rejects.toThrow(`${queued.id} is no longer waiting to be picked up; read it with tasks_get`)
    } finally {
      start.mockRestore()
    }
    expect(taskRepo.getById(USER, queued.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'cancelled' })
  })

  it('loses the ownership with the chat when the chat is hard-deleted', async () => {
    const kit = session('kit-1')
    const created = await taskToolService.tasksCreate(kit, { title: 'Owned', description: 'x', category: 'active' }) as { ref: string }
    expect(taskRepo.getById(USER, created.ref)?.sessionOwned).toBe(true)
    chatRepo.permanentDelete(USER, kit.chatId)
    expect(taskRepo.getById(USER, created.ref)).toMatchObject({ chatId: null, sessionOwned: false, status: 'in_progress' })
  })

  it('never binds a task with a delegation or a handover behind it', async () => {
    const executorChat = session('kit-2')
    const delegated = taskService.create(USER, { title: 'Delegated', goal: 'x', assigneeAgentId: 'kit-2' })
    const requester = session('kit-1')
    delegationRepo.insert({ userId: USER, requesterKey: 'r', originKind: 'local_chat', originChatId: requester.chatId, originAgentId: 'kit-1', targetKind: 'kit', targetAgentId: 'kit-2', channel: 'local', depth: 1, taskId: delegated.id })
    await expect(taskToolService.tasksReport(executorChat, { ref: delegated.id, status: 'in_progress', summary: 'S' })).rejects.toThrow('Report on delegated work')
    expect(taskRepo.getById(USER, delegated.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'new' })

    const handedOver = taskService.create(USER, { title: 'Handed over', goal: 'x', assigneeAgentId: 'kit-2' })
    const handover = { id: 'h-1', userId: USER, taskId: handedOver.id, agentId: 'kit-2', originAgentId: 'kit-1', folderPath: holder.agentPath }
    const byTask = vi.spyOn(handoverRepo, 'byTaskId').mockImplementation((_user, taskId) => (taskId === handedOver.id ? handover as never : undefined))
    try {
      await expect(taskToolService.tasksReport(session('kit-2'), { ref: handedOver.id, status: 'in_progress', summary: 'S' })).rejects.toThrow('Report on delegated work')
    } finally {
      byTask.mockRestore()
    }
    expect(taskRepo.getById(USER, handedOver.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'new' })
  })

  it('does not bind from a chat that already has a task: the report goes to the task named, unbound', async () => {
    const kit = session('kit-1', {})
    const own = taskRepo.getByChatId(USER, kit.chatId)!
    const other = taskService.create(USER, { title: 'Other', goal: 'x', assigneeAgentId: 'kit-1' })
    const result = await taskToolService.tasksReport(kit, { ref: other.id, status: 'in_progress', summary: 'Noted' })
    expect(result).not.toHaveProperty('attached')
    expect(taskRepo.getById(USER, other.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'in_progress' })
    expect(taskRepo.getByChatId(USER, kit.chatId)?.id).toBe(own.id)
  })

  it('closes a task with `done` without binding, and binds nothing on a malformed `blocked`', async () => {
    // A task nothing has run, which an `in_progress` report would bind: `done`
    // closes it through In progress, as cinna-core does, and binds nothing.
    const fresh = taskService.create(USER, { title: 'Quick', goal: 'x', assigneeAgentId: 'kit-1' })
    const kit = session('kit-1')
    const closed = await taskToolService.tasksReport(kit, { ref: fresh.id, status: 'done', summary: 'Done' })
    expect(closed).toEqual({ ref: fresh.id, status: 'done', taskStatus: 'completed', category: 'done' })
    expect(taskRepo.getById(USER, fresh.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'completed' })
    expect(taskRepo.getByChatId(USER, kit.chatId)).toBeUndefined()
    // A started one closes, still unbound.
    const assigned = taskService.create(USER, { title: 'Quick 2', goal: 'x', assigneeAgentId: 'kit-1' })
    taskService.setStatus(USER, assigned.id, 'in_progress')
    const result = await taskToolService.tasksReport(kit, { ref: assigned.id, status: 'done', summary: 'Done' })
    expect(result).not.toHaveProperty('attached')
    expect(taskRepo.getById(USER, assigned.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'completed' })

    const waiting = taskService.create(USER, { title: 'Ask', goal: 'x', assigneeAgentId: 'kit-1' })
    await expect(taskToolService.tasksReport(kit, { ref: waiting.id, status: 'blocked', summary: 'S' })).rejects.toThrow('question')
    expect(taskRepo.getById(USER, waiting.id)).toMatchObject({ chatId: null, sessionOwned: false, status: 'new' })
  })

  it('never binds a task a person has started or one of another agent', async () => {
    const started = taskService.create(USER, { title: 'Started', goal: 'x', assigneeAgentId: 'kit-1' })
    taskService.setStatus(USER, started.id, 'in_progress')
    const kit = session('kit-1')
    await taskToolService.tasksReport(kit, { ref: started.id, status: 'in_progress', summary: 'Still' })
    expect(taskRepo.getById(USER, started.id)).toMatchObject({ chatId: null, sessionOwned: false })
    const stranger = taskService.create(USER, { title: 'Stranger', goal: 'x', assigneeAgentId: 'kit-2' })
    await expect(taskToolService.tasksReport(kit, { ref: stranger.id, status: 'in_progress', summary: 'S' })).rejects.toThrow('assigned to you')
  })
})
