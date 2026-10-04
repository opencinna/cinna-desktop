import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * Tasks a person writes down and edits (`task:create`, `task:update`) against a
 * real database. `agentService` is the one stand-in: which agents exist is the
 * input the assignee rules turn on, and the real lookup needs the whole agent
 * stack. The profile's enable/disable override is the real repo.
 */
const state = vi.hoisted(() => ({
  database: null as TestDatabase | null,
  deviceId: null as string | null,
  agents: new Map<string, { id: string; name: string; enabled: boolean }>()
}))
vi.mock('../db/client', () => ({ getDb: () => state.database!.db, getRawSqlite: () => state.database!.sqlite }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => (state.deviceId ? { deviceId: state.deviceId } : null) } }))
vi.mock('./taskFileService', () => ({ taskFileService: { exportHandoff() {}, removeHandoff() {} } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }) }))
vi.mock('./agentService', () => ({
  agentService: {
    findAgent: (_settings: string, _profile: string, agentId: string) => {
      const row = state.agents.get(agentId)
      return row ? { row, userId: 'settings-1' } : null
    }
  }
}))

const { taskAuthoringService } = await import('./taskAuthoringService')
const { taskService } = await import('./taskService')
const { taskRepo } = await import('../db/tasks')
const { taskRuntimeRepo } = await import('../db/taskRuntimes')
const { scriptRuntimeRepo } = await import('../db/scriptRuntimes')
const { activeRunsByChat } = await import('./runExecutionState')
const { agentOverrideRepo } = await import('../db/agents')
const { chatRepo } = await import('../db/chats')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { COLLECTION_MAPPERS, newResolveCache } = await import('../sync/collections')

const USER = 'profile-1'
const SCOPE = { profileUserId: USER, settingsUserId: 'settings-1' }

beforeEach(() => {
  state.database = createTestDatabase()
  state.deviceId = null
  state.agents = new Map([
    ['agent-on', { id: 'agent-on', name: 'Writer', enabled: true }],
    ['agent-off', { id: 'agent-off', name: 'Sleeper', enabled: false }]
  ])
})
afterEach(() => { state.database?.close(); state.database = null })

describe('task:create', () => {
  it('asks only for a title and defaults the rest in main', () => {
    const task = taskAuthoringService.create(SCOPE, { title: '  Write the release notes  ' })
    expect(task).toMatchObject({
      title: 'Write the release notes',
      goal: 'Write the release notes',
      description: null,
      status: 'new',
      priority: 'normal',
      router: 'direct',
      origin: 'local',
      executor: 'desktop',
      executorDevice: null,
      runsHere: true,
      chatId: null,
      customFields: null,
      assignee: { kind: 'model', agentId: null, name: null }
    })
  })

  it('claims the task for this device when it has a sync identity', () => {
    state.deviceId = 'device-a'
    expect(taskAuthoringService.create(SCOPE, { title: 'T' }).executorDevice).toBe('device-a')
  })

  it('keeps a written goal, description, priority, Ready status and custom fields', () => {
    const task = taskAuthoringService.create(SCOPE, {
      title: 'Ship', goal: 'Ship 1.0 to everyone', description: 'Notes first', priority: 'high', status: 'open',
      customFields: { estimate: 3, area: 'docs', labels: ['ui', 'docs'], urgent: true }
    })
    expect(task).toMatchObject({
      goal: 'Ship 1.0 to everyone', description: 'Notes first', priority: 'high', status: 'open',
      customFields: { estimate: 3, area: 'docs', labels: ['ui', 'docs'], urgent: true }
    })
    expect(taskService.getById(USER, task.id).customFields).toEqual(task.customFields)
  })

  it('stores an enabled agent with its name', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T', assignee: { kind: 'agent', agentId: 'agent-on' } })
    expect(task.assignee).toEqual({ kind: 'agent', agentId: 'agent-on', name: 'Writer' })
  })

  it('refuses a missing or disabled agent, and one the profile switched off, and writes nothing', () => {
    for (const agentId of ['agent-gone', 'agent-off']) {
      expect(() => taskAuthoringService.create(SCOPE, { title: 'T', assignee: { kind: 'agent', agentId } }))
        .toThrow('That agent is unavailable')
    }
    agentOverrideRepo.set(USER, 'agent-on', false)
    expect(() => taskAuthoringService.create(SCOPE, { title: 'T', assignee: { kind: 'agent', agentId: 'agent-on' } }))
      .toThrow('That agent is unavailable')
    expect(taskRepo.list(USER)).toEqual([])
  })

  it('refuses an empty title and bad custom fields before writing', () => {
    expect(() => taskAuthoringService.create(SCOPE, { title: '   ' })).toThrow('Title is required')
    expect(() => taskAuthoringService.create(SCOPE, { title: 'T', customFields: { status: 'x' } })).toThrow(/built-in/)
    expect(() => taskAuthoringService.create(SCOPE, { title: 'T', customFields: { '1bad': 'x' } })).toThrow(/not a field name/)
    expect(() => taskAuthoringService.create(SCOPE, { title: 'T', customFields: { deep: { a: 1 } } as never })).toThrow(/must be text/)
    expect(taskRepo.list(USER)).toEqual([])
  })
})

describe('task:create with a parent (Add subtask)', () => {
  it('makes a subtask of a live parent with the same assignee', async () => {
    const unassigned = taskAuthoringService.create(SCOPE, { title: 'Parent' })
    const child = await taskAuthoringService.createRouted(SCOPE, { title: 'Child', parentTaskId: unassigned.id })
    expect(child.parentTaskId).toBe(unassigned.id)
    const agents = taskAuthoringService.create(SCOPE, { title: 'Agent parent', assignee: { kind: 'agent', agentId: 'agent-on' } })
    const agentChild = await taskAuthoringService.createRouted(SCOPE, { title: 'Agent child', parentTaskId: agents.id, assignee: { kind: 'agent', agentId: 'agent-on' } })
    expect(agentChild).toMatchObject({ parentTaskId: agents.id, assignee: { agentId: 'agent-on' } })
  })

  it('refuses a missing, deleted or archived parent, or another assignee, and writes nothing', async () => {
    const parent = taskAuthoringService.create(SCOPE, { title: 'Parent', assignee: { kind: 'agent', agentId: 'agent-on' } })
    await expect(taskAuthoringService.createRouted(SCOPE, { title: 'C', parentTaskId: 'nope', assignee: { kind: 'agent', agentId: 'agent-on' } }))
      .rejects.toThrow('no longer exists')
    await expect(taskAuthoringService.createRouted(SCOPE, { title: 'C', parentTaskId: parent.id }))
      .rejects.toThrow('parent’s assignee')
    const otherProfile = { profileUserId: 'profile-2', settingsUserId: 'settings-1' }
    await expect(taskAuthoringService.createRouted(otherProfile, { title: 'C', parentTaskId: parent.id, assignee: { kind: 'agent', agentId: 'agent-on' } }))
      .rejects.toThrow('no longer exists')
    taskRepo.update(USER, parent.id, { status: 'archived' })
    await expect(taskAuthoringService.createRouted(SCOPE, { title: 'C', parentTaskId: parent.id, assignee: { kind: 'agent', agentId: 'agent-on' } }))
      .rejects.toThrow('archived')
    taskRepo.update(USER, parent.id, { status: 'new' })
    taskRepo.softDelete(USER, parent.id)
    await expect(taskAuthoringService.createRouted(SCOPE, { title: 'C', parentTaskId: parent.id, assignee: { kind: 'agent', agentId: 'agent-on' } }))
      .rejects.toThrow('no longer exists')
    expect(taskRepo.list(USER).filter((row) => row.title === 'C')).toEqual([])
  })
})

describe('task:update', () => {
  it('changes the assignee of a task nothing has started', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T' })
    expect(taskAuthoringService.update(SCOPE, task.id, { assignee: { kind: 'agent', agentId: 'agent-on' } }).assignee)
      .toEqual({ kind: 'agent', agentId: 'agent-on', name: 'Writer' })
    expect(taskAuthoringService.update(SCOPE, task.id, { assignee: null }).assignee)
      .toEqual({ kind: 'model', agentId: null, name: null })
  })

  it('refuses the assignee once the task has a chat', () => {
    const chat = chatRepo.create(USER, { title: 'Chat' })
    const task = taskService.create(USER, { title: 'T', goal: 'G', chatId: chat.id })
    expect(() => taskAuthoringService.update(SCOPE, task.id, { assignee: null })).toThrow(/already has a conversation/)
  })

  it('refuses the assignee of a task another device holds, or a service runs', () => {
    state.deviceId = 'device-a'
    const elsewhere = taskService.create(USER, { title: 'T', goal: 'G', executorDevice: 'device-b' })
    expect(() => taskAuthoringService.update(SCOPE, elsewhere.id, { assignee: null })).toThrow(/another device/)
    const remote = taskService.create(USER, { title: 'T', goal: 'G', executor: 'remote' })
    expect(() => taskAuthoringService.update(SCOPE, remote.id, { assignee: null })).toThrow(/connected service/)
  })

  it('refuses the assignee of a bound task', () => {
    const task = taskService.create(USER, { title: 'T', goal: 'G' })
    taskService.bindRemote(USER, task.id, { adapter: 'fake', id: 'r1', key: null, url: null, state: {} })
    expect(() => taskAuthoringService.update(SCOPE, task.id, { assignee: null })).toThrow(/connected to a service/)
  })

  it('refuses the assignee of a script task', () => {
    const row = taskRepo.create(USER, { title: 'T', goal: 'G', router: 'script' })
    expect(() => taskAuthoringService.update(SCOPE, row.id, { assignee: null })).toThrow(/steps name their own agents/)
  })

  it('refuses the assignee of a task a runtime owns', () => {
    const task = taskService.create(USER, { title: 'T', goal: 'G' })
    const owned = vi.spyOn(taskRuntimeRepo, 'get').mockImplementation((_user, id) => (id === task.id ? ({} as never) : null))
    try {
      expect(() => taskAuthoringService.update(SCOPE, task.id, { assignee: null })).toThrow(/runtime owns/)
    } finally { owned.mockRestore() }
  })

  it('leaves the other fields writable when the assignee is not', () => {
    const chat = chatRepo.create(USER, { title: 'Chat' })
    const task = taskService.create(USER, { title: 'T', goal: 'G', chatId: chat.id })
    const updated = taskAuthoringService.update(SCOPE, task.id, { title: 'Renamed', customFields: { area: 'ops' } })
    expect(updated).toMatchObject({ title: 'Renamed', customFields: { area: 'ops' } })
    expect(taskAuthoringService.update(SCOPE, task.id, { customFields: null }).customFields).toBeNull()
    expect(taskAuthoringService.update(SCOPE, task.id, { customFields: { area: 'ops' } }).customFields).toEqual({ area: 'ops' })
    expect(taskAuthoringService.update(SCOPE, task.id, { customFields: {} }).customFields).toBeNull()
    expect(() => taskAuthoringService.update(SCOPE, task.id, { customFields: { goal: 'x' } })).toThrow(/built-in/)
  })
})

describe('custom fields over device sync', () => {
  const mapper = COLLECTION_MAPPERS.find((item) => item.collection === 'task')!
  const apply = (id: string, fields: Record<string, unknown>): void => mapper.apply(USER, id, {
    title: 'Synced', goal: 'Goal', status: 'new', priority: 'normal', router: 'direct', origin: 'local', executor: 'desktop', ...fields
  }, false, { clientUpdatedAt: Date.now() + 1000, cache: newResolveCache() })

  it('travels in the payload', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T', customFields: { area: 'ops' } })
    expect(mapper.listDirty(USER, 0).find((item) => item.clientEntityId === task.id)!.plaintext)
      .toMatchObject({ customFields: { area: 'ops' } })
  })

  it('keeps the local value when an older peer’s payload has no key, and clears on an explicit null', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T', customFields: { area: 'ops' } })
    apply(task.id, { title: 'From an older peer' })
    expect(taskService.getById(USER, task.id)).toMatchObject({ title: 'From an older peer', customFields: { area: 'ops' } })
    apply(task.id, { customFields: { area: 'billing', estimate: 2 } })
    expect(taskService.getById(USER, task.id).customFields).toEqual({ area: 'billing', estimate: 2 })
    apply(task.id, { customFields: null })
    expect(taskService.getById(USER, task.id).customFields).toBeNull()
  })

  it('still pushes a custom-field edit on a bound task after a pull carrying an older remote time', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T' })
    taskService.bindRemote(USER, task.id, { adapter: 'fake', id: 'r1', key: null, url: null, state: {} })
    const edited = taskAuthoringService.update(SCOPE, task.id, { customFields: { area: 'ops' } })
    // The last device-sync push happened just before the edit.
    const watermark = edited.updatedAt.getTime() - 1
    // The service changed the title a minute earlier (or its clock is behind).
    taskService.applyRemoteSnapshot(USER, task.id, { title: 'Renamed there', updatedAt: new Date(watermark - 60_000) })
    const dirty = mapper.listDirty(USER, watermark).find((item) => item.clientEntityId === task.id)
    expect(dirty?.plaintext).toMatchObject({ title: 'Renamed there', customFields: { area: 'ops' } })
    expect(taskService.getById(USER, task.id).updatedAt.getTime()).toBe(edited.updatedAt.getTime())
  })

  it('inserts a new replica with no fields when the key is absent', () => {
    apply('peer-task', {})
    expect(taskService.getById(USER, 'peer-task').customFields).toBeNull()
  })
})

describe('a person moving a task by hand (setStatus manual)', () => {
  it('reshuffles and closes an unbound task outside the remote table', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T', status: 'open' })
    expect(taskService.setStatus(USER, task.id, 'new', { manual: true }).status).toBe('new')
    const done = taskService.setStatus(USER, task.id, 'completed', { manual: true })
    expect(done.status).toBe('completed')
    expect(done.finishedAt).toBeInstanceOf(Date)
    // The internal (non-manual) path still follows the table.
    const other = taskAuthoringService.create(SCOPE, { title: 'U' })
    expect(() => taskService.setStatus(USER, other.id, 'completed')).toThrow('A task cannot go from new to completed')
  })

  it('refuses a bound task the step the service does not allow, in category words', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T', status: 'open' })
    taskService.bindRemote(USER, task.id, { adapter: 'fake', id: 'r1', key: null, url: null, state: {} })
    expect(() => taskService.setStatus(USER, task.id, 'new', { manual: true })).toThrow(
      'This task can’t move from Ready to Backlog: it is tracked on the connected service, which doesn’t allow that step.')
    expect(() => taskService.setStatus(USER, task.id, 'completed', { manual: true })).toThrow(/from Ready to Done/)
    expect(taskService.getById(USER, task.id).status).toBe('open')
    // A step in the table to a status a person may set is still fine for it.
    expect(taskService.setStatus(USER, task.id, 'cancelled', { manual: true }).status).toBe('cancelled')
  })

  it('refuses a move out of In progress or Waiting: a run or a question holds the task', () => {
    const active = taskService.create(USER, { title: 'T', goal: 'G', status: 'in_progress' })
    expect(() => taskService.setStatus(USER, active.id, 'completed', { manual: true })).toThrow(
      'This task is in progress — let its run finish it, or stop the run.')
    expect(() => taskService.setStatus(USER, active.id, 'cancelled', { manual: true })).toThrow(/in progress/)
    const waiting = taskService.create(USER, { title: 'T', goal: 'G', status: 'blocked' })
    expect(() => taskService.setStatus(USER, waiting.id, 'completed', { manual: true })).toThrow(/waiting on an answer/)
    expect(taskService.getById(USER, active.id).status).toBe('in_progress')
    expect(taskService.getById(USER, waiting.id).status).toBe('blocked')
  })

  it('refuses a move to a status only a run writes, and lets an error task go back to Backlog', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T', status: 'open' })
    expect(() => taskService.setStatus(USER, task.id, 'in_progress', { manual: true })).toThrow(
      'A run puts a task in In progress; it can’t be moved there by hand.')
    expect(() => taskService.setStatus(USER, task.id, 'archived', { manual: true })).toThrow('A task can’t be set to archived by hand.')
    const failed = taskService.create(USER, { title: 'T', goal: 'G', status: 'error' })
    expect(taskService.setStatus(USER, failed.id, 'new', { manual: true }).status).toBe('new')
  })

  it('refuses a move while a coordinator or script runtime owns the task', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T', status: 'open' })
    taskRuntimeRepo.save(USER, task.id, { state: 'running' } as never)
    expect(() => taskService.setStatus(USER, task.id, 'completed', { manual: true })).toThrow(/run by its runtime/)
    taskRuntimeRepo.remove(USER, task.id)
    const scripted = taskAuthoringService.create(SCOPE, { title: 'S', status: 'open' })
    const owner = vi.spyOn(scriptRuntimeRepo, 'owner').mockImplementation((_user, id) => (id === scripted.id ? ({} as never) : null))
    try {
      expect(() => taskService.setStatus(USER, scripted.id, 'new', { manual: true })).toThrow(/run by its runtime/)
    } finally { owner.mockRestore() }
    expect(taskService.getById(USER, task.id).status).toBe('open')
    expect(taskService.getById(USER, scripted.id).status).toBe('open')
  })

  it('refuses a move while a turn is live in the task’s chat', () => {
    const chat = chatRepo.create(USER, { title: 'Chat' })
    const task = taskService.create(USER, { title: 'T', goal: 'G', status: 'open', chatId: chat.id })
    activeRunsByChat.set(chat.id, { id: 'run-1' } as never)
    try {
      expect(() => taskService.setStatus(USER, task.id, 'completed', { manual: true })).toThrow(/has a run going/)
      expect(taskService.getById(USER, task.id).status).toBe('open')
    } finally { activeRunsByChat.delete(chat.id) }
    expect(taskService.setStatus(USER, task.id, 'completed', { manual: true }).status).toBe('completed')
  })

  describe('a task the dispatcher flagged (blocked with a dispatch note)', () => {
    function flagged(chatId?: string) {
      const task = taskService.create(USER, { title: 'T', goal: 'G', status: 'in_progress', ...(chatId ? { chatId } : {}) })
      return taskService.setStatus(USER, task.id, 'blocked', { dispatchNote: 'Ended without reporting' })
    }

    it('moves to Ready, Backlog, Done or Cancelled by hand, and the note goes', () => {
      const ready = taskService.setStatus(USER, flagged().id, 'open', { manual: true })
      expect(ready).toMatchObject({ status: 'open', dispatchNote: null })
      expect(taskService.setStatus(USER, flagged().id, 'new', { manual: true }).status).toBe('new')
      expect(taskService.setStatus(USER, flagged().id, 'completed', { manual: true }).status).toBe('completed')
      expect(taskService.setStatus(USER, flagged().id, 'cancelled', { manual: true }).status).toBe('cancelled')
      expect(() => taskService.setStatus(USER, flagged().id, 'in_progress', { manual: true })).toThrow(/A run puts a task in In progress/)
    })

    it('still refuses while an ask is open for it, a turn is live in its chat, or a runtime owns it', () => {
      const asked = flagged()
      taskInputRequestRepo.open({
        requestId: 'ask-1', taskId: asked.id, chatId: 'chat-x', agentId: null, deliveryOwner: 'handover',
        request: { kind: 'question', questions: [{ question: 'Go?', multiSelect: false, options: [{ label: 'Go' }] }] },
        resume: 'reply'
      })
      expect(() => taskService.setStatus(USER, asked.id, 'open', { manual: true })).toThrow(/waiting on an answer/)

      const chat = chatRepo.create(USER, { title: 'Chat' })
      const live = flagged(chat.id)
      activeRunsByChat.set(chat.id, { id: 'run-1' } as never)
      try {
        expect(() => taskService.setStatus(USER, live.id, 'open', { manual: true })).toThrow(/has a run going/)
      } finally { activeRunsByChat.delete(chat.id) }

      const owned = flagged()
      taskRuntimeRepo.save(USER, owned.id, { state: 'running' } as never)
      expect(() => taskService.setStatus(USER, owned.id, 'open', { manual: true })).toThrow(/run by its runtime/)
      for (const task of [asked, live, owned]) expect(taskService.getById(USER, task.id).status).toBe('blocked')
    })

    it('keeps a bound flagged task to the table: Cancelled, not Ready', () => {
      const task = flagged()
      taskService.bindRemote(USER, task.id, { adapter: 'fake', id: 'r1', key: null, url: null, state: {} })
      expect(() => taskService.setStatus(USER, task.id, 'open', { manual: true })).toThrow(/connected service/)
      expect(taskService.setStatus(USER, task.id, 'cancelled', { manual: true }).status).toBe('cancelled')
    })
  })

  it('refuses an unbound task a move nothing allows, without raw status words', () => {
    const task = taskAuthoringService.create(SCOPE, { title: 'T', status: 'open' })
    taskService.setStatus(USER, task.id, 'completed', { manual: true })
    expect(() => taskService.setStatus(USER, task.id, 'open', { manual: true })).toThrow('This task can’t move from Done to Ready.')
  })

  it('refuses a manual close while a linked job run is still going, and settles a finished one alone', () => {
    const job = jobsRepo.create(USER, { type: 'local', title: 'Job', prompt: 'Work' })
    const task = taskAuthoringService.create(SCOPE, { title: 'T' })
    const run = jobRunsRepo.create({ jobId: job.id, userId: USER, type: 'local', taskId: task.id, status: 'pending' })
    taskService.linkJobRun(USER, task.id, run.id)
    expect(() => taskService.setStatus(USER, task.id, 'completed', { manual: true })).toThrow(/job run is still going/)
    expect(jobRunsRepo.getById(USER, run.id)?.status).toBe('pending')
    // Backlog ↔ Ready has no side effect on the run, so it stays allowed.
    expect(taskService.setStatus(USER, task.id, 'open', { manual: true }).status).toBe('open')
    jobRunsRepo.updateStatus(run.id, 'cancelled', { errorMessage: null })
    expect(taskService.setStatus(USER, task.id, 'completed', { manual: true }).status).toBe('completed')
    expect(jobRunsRepo.getById(USER, run.id)?.status).toBe('cancelled')
  })
})
