import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TaskError } from '../errors'
import type { IpcMainInvokeEvent } from 'electron'

/**
 * **Which task writes tell the user's other devices, and which do not.**
 *
 * Notes and jobs nudge sync from their *services*. Tasks cannot: the app-sync
 * apply path goes through `taskService` (so the exported handoff note follows a
 * row that arrives from a peer), and `syncService → syncEngine → collections →
 * taskService` would close a cycle if the service imported `syncService` back.
 * The nudge therefore lives in the IPC layer, which nothing imports.
 *
 * That makes the split a deliberate one rather than an accident of layering,
 * and it is the split this file pins: **a person's write is nudged; a run's
 * own progress is not.** `applyRunState` fires several times a turn, and
 * debouncing a full sync cycle onto each would be chatty for a row that moves
 * on its own. A take-over is the opposite case — its whole purpose is to tell
 * another device it has lost the claim, and until that lands both devices pass
 * `taskRunsHere` and both will write the run.
 *
 * It is a test rather than a comment because of what the step-9a review found
 * about one-line call sites: the unit tests drive `markDirty` directly, so
 * deleting a call to it here would leave the whole suite green and the failure
 * — a minute of two devices each believing they own a run — announces itself to
 * nobody.
 */

const runner = vi.hoisted(() => ({ start: vi.fn(() => ({ taskId: 't1', chatId: 'c1' })), resume: vi.fn(), cancel: vi.fn() }))
vi.mock('../services/taskRunnerService', () => ({ taskRunnerService: runner }))
const runtime = vi.hoisted(() => ({ resume: vi.fn(), cancel: vi.fn() }))
vi.mock('../services/taskRuntimeService', () => ({ taskRuntimeService: runtime }))
const markDirty = vi.hoisted(() => vi.fn())
const startTask = vi.hoisted(() => vi.fn(async () => ({ task: { id: 't1' }, chatId: 'c1', runId: 'run1' })))
const service = vi.hoisted(() => ({
  update: vi.fn(() => ({ id: 't1' })),
  setStatus: vi.fn(() => ({ id: 't1' })),
  reopenForRerun: vi.fn(() => ({ id: 't1' })),
  remove: vi.fn(),
  removeWithJobRun: vi.fn((_userId: string, _taskId: string) => ({ jobRunId: 'run-1', jobId: 'job-1', chatId: 'chat-1', chatDeleted: true })),
  deletePreview: vi.fn(() => ({ deletesRun: true, chat: 'deleted_with_run', jobStays: true })),
  list: vi.fn(() => []),
  getById: vi.fn(() => ({ id: 't1' }))
}))
/**
 * The two gestures that move work between here and a service go through
 * `taskSyncService`, not `taskService`: one of the two elsewheres a task can be
 * in is on a network, and the refusal that belongs to it (§5.10 — a take-over
 * of a task an agent is working on right now) costs a request.
 */
const sync = vi.hoisted(() => ({
  handoffReceipt: vi.fn(() => null),
  getChildren: vi.fn(() => ({ tasks: [], refreshed: true })),
  getWatched: vi.fn(() => ({ id: 't1' })),
  takeOver: vi.fn(async () => ({ id: 't1' })),
  handOff: vi.fn(async () => ({ id: 't1' })),
  liveSession: vi.fn(async () => false),
  folderBoard: vi.fn(async () => null as unknown),
  // The core delete: the row through `taskService`, then a folder task's file.
  removeTask: vi.fn(async (userId: string, taskId: string) => service.removeWithJobRun(userId, taskId))
}))

/** Captured `channel → handler`, instead of touching `ipcMain`. */
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }
}))
vi.mock('../services/syncService', () => ({ syncService: { markDirty } }))
vi.mock('../services/taskService', () => ({ taskService: service }))
const authoring = vi.hoisted(() => ({
  createRouted: vi.fn(async () => ({ id: 't-new' })),
  update: vi.fn(() => ({ id: 't1' })),
  setStatus: vi.fn(async () => ({ id: 't1' }))
}))
vi.mock('../services/taskAuthoringService', () => ({ taskAuthoringService: authoring }))
vi.mock('../services/taskSyncService', () => ({ taskSyncService: sync }))
vi.mock('../services/taskExecutionService', () => ({ taskExecutionService: { start: startTask } }))
vi.mock('../services/inboxService', () => ({
  inboxService: { list: vi.fn(() => []), answer: vi.fn() }
}))
vi.mock('../services/askDelivery', () => ({ parseAnswerPayload: vi.fn(() => null) }))
const delegationLinks = vi.hoisted(() => vi.fn(() => ({ from: null, to: [] })))
vi.mock('../services/delegationQueryService', () => ({ delegationQueryService: { forTask: delegationLinks } }))
const forTask = vi.hoisted(() => vi.fn(() => null as unknown))
vi.mock('../services/handoverService', () => ({ handoverService: { forTask } }))
vi.mock('../auth/activation', () => ({
  userActivation: { requireActivated: vi.fn() }
}))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile-1', getSettingsScopeUserId: () => 'settings-1' }))
const comments = vi.hoisted(() => vi.fn(() => [] as unknown[]))
vi.mock('../services/taskToolService', () => ({ taskToolService: { comments } }))

const { registerTaskHandlers } = await import('./task.ipc')

const event = {} as IpcMainInvokeEvent

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  registerTaskHandlers()
})

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  expect(handler, `${channel} is not registered`).toBeTruthy()
  return (handler as (...a: unknown[]) => unknown)(event, ...args)
}

describe('a task write a person made reaches the other devices without waiting a minute', () => {
  it.each([
    ['task:take-over', ['t1']],
    ['task:start', ['t1', { kind: 'model' }]],
    ['task:update', ['t1', { title: 'Renamed' }]],
    ['task:create', [{ title: 'New' }]],
    ['task:set-status', ['t1', 'in_progress']],
    ['task:reopen-for-rerun', ['t1']],
    ['task:delete', ['t1']]
  ] as const)('%s nudges sync', async (channel, args) => {
    await invoke(channel, ...args)
    expect(markDirty).toHaveBeenCalledWith('profile-1')
  })

  it('returns what the delete removed, as data the renderer can invalidate from', async () => {
    await expect(invoke('task:delete', 't1')).resolves.toEqual({
      success: true, jobRunId: 'run-1', jobId: 'job-1', chatId: 'chat-1', chatDeleted: true
    })
    expect(service.removeWithJobRun).toHaveBeenCalledWith('profile-1', 't1')
    service.removeWithJobRun.mockImplementationOnce(() => { throw new Error('Task not found') })
    markDirty.mockClear()
    await expect(invoke('task:delete', 't1')).rejects.toThrow('Task not found')
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('previews a delete from the captured profile, as data', async () => {
    await expect(invoke('task:delete-preview', 't1')).resolves.toEqual({
      deletesRun: true, chat: 'deleted_with_run', jobStays: true
    })
    expect(service.deletePreview).toHaveBeenCalledWith('profile-1', 't1')
    expect(service.removeWithJobRun).not.toHaveBeenCalled()
  })

  it('nudges *after* the write, so a refused write never announces itself', async () => {
    sync.takeOver.mockImplementationOnce(() => {
      throw new Error('Task not found')
    })
    await expect(invoke('task:take-over', 't1')).rejects.toThrow('Task not found')
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('captures both start scopes and nudges only after acceptance', async () => {
    await invoke('task:start', 't1', { kind: 'agent', agentId: 'a1' })
    expect(startTask).toHaveBeenCalledWith({ profileUserId: 'profile-1', settingsUserId: 'settings-1' }, 't1', { kind: 'agent', agentId: 'a1' })
    markDirty.mockClear()
    startTask.mockRejectedValueOnce(new Error('not ready'))
    await expect(invoke('task:start', 't1', { kind: 'model' })).rejects.toThrow('not ready')
    expect(markDirty).not.toHaveBeenCalled()
  })

  it.each([
    ['task:list', []],
    ['task:get', ['t1']],
    // A probe, and nothing about this device changed by asking.
    ['task:remote-live', ['t1']],
    // What a delete would remove, read before its dialog opens.
    ['task:delete-preview', ['t1']]
  ] as const)(
    '%s is a read and nudges nothing',
    async (channel, args) => {
      await invoke(channel, ...args)
      expect(markDirty).not.toHaveBeenCalled()
    }
  )
})

it('reads saved children with refresh metadata in the captured profile', async () => {
  expect(await invoke('task:children', 'parent')).toEqual({ tasks: [], refreshed: true })
  expect(sync.getChildren).toHaveBeenCalledWith('profile-1', 'parent')
  expect(markDirty).not.toHaveBeenCalled()
})


describe('task:list chat filter', () => {
  it('passes a chat id through with the other filters', async () => {
    await invoke('task:list', { chatId: 'c1', rootOnly: true })
    expect(service.list).toHaveBeenCalledWith('profile-1', expect.objectContaining({ chatId: 'c1', rootOnly: true }))
  })

  it('leaves the filter out when none was asked for', async () => {
    await invoke('task:list', { rootOnly: true })
    expect(service.list).toHaveBeenCalledWith('profile-1', expect.objectContaining({ chatId: undefined }))
  })

  // Dropped instead of refused, a malformed filter would widen one chat's list
  // into every task the profile has.
  it.each([[42], [''], [null], [{ id: 'c1' }]])('refuses a chat id of %j', async (chatId) => {
    await expect(invoke('task:list', { chatId })).rejects.toThrow()
    expect(service.list).not.toHaveBeenCalled()
  })
})

describe('remote handoff outcomes', () => {
  it('returns accepted data and nudges sync after the service accepts', async () => {
    const result = await handlers.get('task:hand-off')!({}, 't1', { adapterId: 'service', ref: 'agent' }, 'Continue here')
    expect(result).toMatchObject({ kind: 'accepted', task: { id: 't1' } })
    expect(sync.handOff).toHaveBeenCalledWith('profile-1', 't1', { adapterId: 'service', ref: 'agent' }, 'Continue here')
    expect(markDirty).toHaveBeenCalledWith('profile-1')
  })
  it.each([['handed_over', 'attention'], ['handoff_uncertain', 'uncertain']] as const)('preserves the %s outcome across IPC', async (code, kind) => {
    sync.handOff.mockRejectedValueOnce(new TaskError(code, 'Check the service'))
    const result = await handlers.get('task:hand-off')!({}, 't1', { adapterId: 'service', ref: 'agent' }, null)
    expect(result).toMatchObject({ kind, message: 'Check the service' })
    expect(markDirty).not.toHaveBeenCalled()
  })
})


describe('autonomous task IPC', () => {
  it('captures profile and settings scopes and nudges accepted work', async () => {
    const input = { chatId: 'c1', goal: 'Ship it', budget: { maxRounds: 4 } }
    expect(await invoke('task:run-autonomously', input)).toEqual({ taskId: 't1', chatId: 'c1' })
    expect(runner.start).toHaveBeenCalledWith({ profileUserId: 'profile-1', settingsUserId: 'settings-1' }, input)
    expect(markDirty).toHaveBeenCalledWith('profile-1')
    await invoke('task:resume-runtime', 't1')
    expect(runtime.resume).toHaveBeenCalledWith('profile-1', 't1')
    await invoke('task:stop-runtime', 't1')
    expect(runtime.cancel).toHaveBeenCalledWith('profile-1', 't1')
  })
})

describe('the handover behind a task', () => {
  it('reads it in the profile scope, and answers null for a request with no task id', async () => {
    forTask.mockReturnValueOnce({ id: 'row-1', state: 'gated' })
    expect(await invoke('handover:for-task', { taskId: 't1' })).toMatchObject({ id: 'row-1' })
    expect(forTask).toHaveBeenCalledWith('profile-1', 't1')

    // A missing or malformed id never reaches the service: there is nothing to
    // look up, and a `''` would be a scan of the profile's whole table.
    forTask.mockClear()
    expect(await invoke('handover:for-task', {})).toBeNull()
    expect(await invoke('handover:for-task', { taskId: 42 })).toBeNull()
    expect(forTask).not.toHaveBeenCalled()
  })
})

describe('delegation task links use the active profile', () => {
  it('passes profile authority from main and rejects an empty task id', async () => {
    await expect(invoke('delegation:for-task', { taskId: 't1', userId: 'injected-profile' })).resolves.toEqual({ from: null, to: [] })
    expect(delegationLinks).toHaveBeenCalledWith('profile-1', 't1')
    delegationLinks.mockClear()
    await expect(invoke('delegation:for-task', { taskId: null })).resolves.toEqual({ from: null, to: [] })
    expect(delegationLinks).not.toHaveBeenCalled()
  })
})

describe('task:create and task:update payloads', () => {
  it('rebuilds a create field by field, dropping what the renderer has no say in', async () => {
    await expect(invoke('task:create', {
      title: 'Write notes', goal: 'Release notes for 1.0', description: 'Short', priority: 'high', status: 'open',
      assignee: { kind: 'agent', agentId: 'a1', name: 'Spoofed' }, customFields: { area: 'docs' },
      origin: 'remote', executor: 'remote', executorDevice: 'other', router: 'script', chatId: 'c9', id: 'chosen'
    })).resolves.toEqual({ id: 't-new' })
    expect(authoring.createRouted).toHaveBeenCalledWith({ profileUserId: 'profile-1', settingsUserId: 'settings-1' }, {
      title: 'Write notes', goal: 'Release notes for 1.0', description: 'Short', priority: 'high', status: 'open',
      assignee: { kind: 'agent', agentId: 'a1' }, customFields: { area: 'docs' }
    })
  })

  it('passes a bare title and an explicit unassigned choice', async () => {
    await invoke('task:create', { title: 'Only a title' })
    expect(authoring.createRouted).toHaveBeenLastCalledWith(expect.anything(), { title: 'Only a title' })
    await invoke('task:create', { title: 'T', assignee: null })
    expect(authoring.createRouted).toHaveBeenLastCalledWith(expect.anything(), { title: 'T', assignee: null })
  })

  it.each([
    [{ goal: 'no title' }, 'title'],
    [{ title: 'T', status: 'in_progress' }, 'Backlog or Ready'],
    [{ title: 'T', priority: 'max' }, 'priority'],
    [{ title: 'T', assignee: { kind: 'remote_agent', agentId: 'x' } }, 'Choose an agent'],
    [{ title: 'T', customFields: ['a'] }, 'named values']
  ] as const)('refuses %j before it reaches the service', async (payload, message) => {
    await expect(invoke('task:create', payload)).rejects.toThrow(message)
    expect(authoring.createRouted).not.toHaveBeenCalled()
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('rebuilds an update and forwards assignee and custom fields', async () => {
    await invoke('task:update', 't1', { title: 'T', assignee: { kind: 'model', modeId: 'x' }, customFields: null, status: 'completed' })
    expect(authoring.update).toHaveBeenCalledWith({ profileUserId: 'profile-1', settingsUserId: 'settings-1' }, 't1',
      { title: 'T', assignee: { kind: 'model' }, customFields: null })
  })
})

it('task:set-status is a person’s move: main judges it, and the renderer sends a word at most, never a flag', async () => {
  const scope = { profileUserId: 'profile-1', settingsUserId: 'settings-1' }
  await invoke('task:set-status', 't1', 'completed')
  expect(authoring.setStatus).toHaveBeenLastCalledWith(scope, 't1', 'completed', null)
  await invoke('task:set-status', 't1', 'completed', 'Shipped')
  expect(authoring.setStatus).toHaveBeenLastCalledWith(scope, 't1', 'completed', 'Shipped')
  authoring.setStatus.mockClear()
  await expect(invoke('task:set-status', 't1', 'completed', { bound: false })).rejects.toThrow('status word')
  await expect(invoke('task:set-status', 't1', 'completed', 'x'.repeat(201))).rejects.toThrow('status word')
  expect(authoring.setStatus).not.toHaveBeenCalled()
  expect(service.setStatus).not.toHaveBeenCalled()
})

it('task:folder-board answers the four column fields and nothing else, or null', async () => {
  sync.folderBoard.mockResolvedValueOnce([
    { label: 'Doing', category: 'active', status: 'in_progress', droppable: false, extra: 'dropped' }
  ])
  await expect(invoke('task:folder-board', 'agent-1')).resolves.toEqual([
    { label: 'Doing', category: 'active', status: 'in_progress', droppable: false }
  ])
  expect(sync.folderBoard).toHaveBeenCalledWith('profile-1', 'agent-1')
  await expect(invoke('task:folder-board', 'agent-2')).resolves.toBeNull()
  await expect(invoke('task:folder-board', 42)).rejects.toThrow('agent id')
})

it('task:comments answers the comment fields and nothing else, in the active profile', async () => {
  const at = new Date('2026-10-03T12:00:00Z')
  comments.mockReturnValueOnce([{ id: 'c1', authorKind: 'agent', authorAgentId: 'a1', authorName: 'Uploader', body: 'Done.', createdAt: at, remoteStatus: 'sent', userId: 'profile-1' }])
  await expect(invoke('task:comments', 't1')).resolves.toEqual([
    { id: 'c1', authorKind: 'agent', authorAgentId: 'a1', authorName: 'Uploader', body: 'Done.', createdAt: at, remoteStatus: 'sent' }
  ])
  expect(comments).toHaveBeenCalledWith({ profileUserId: 'profile-1', settingsUserId: 'settings-1' }, 't1')
  await expect(invoke('task:comments', 42)).rejects.toThrow('task id')
})
