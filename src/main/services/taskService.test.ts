import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { TaskError } from '../errors'
import type { TaskStatus } from '../../shared/taskStatus'
import type { RunState } from '../../shared/runEvents'

/**
 * `taskService` against a real database with the real migrations applied — the
 * arrangement `agents.test.ts` uses, and for the same reason: what is being
 * tested here is a set of rules about rows (transitions, device claims, parent
 * depth), and a mocked repo would only assert that the service calls the mock.
 *
 * The one genuinely mocked thing is the sync device id, because "which device
 * am I" is the input the authority rules turn on and the whole point is to
 * drive it from both sides.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  deviceId: null as string | null,
  userData: ''
}))

/**
 * Real enough for `taskFileService`, which is the only thing below this service
 * that asks Electron anything. The exported handoff note is a file, and the
 * claim worth testing here is not that the file is well formed — that is
 * `taskFileService.test.ts` — but that *this* service keeps it in step with the
 * row, including on writes that are not the note.
 */
vi.mock('electron', () => ({
  app: { getPath: () => holder.userData }
}))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
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

vi.mock('../db/sync', () => ({
  syncRepo: {
    getState: () => (holder.deviceId ? { deviceId: holder.deviceId } : null)
  }
}))

const { taskService } = await import('./taskService')
const { taskRepo } = await import('../db/tasks')
type TaskSyncValues = import('../db/tasks').TaskSyncValues
const { parseFrontmatter } = await import('../kit/miniYaml')

const USER = '__default__'
const OTHER_USER = 'someone-else'

beforeEach(() => {
  holder.current = createTestDatabase()
  // Default: a profile with sync off. Null device id means "here".
  holder.deviceId = null
  holder.userData = mkdtempSync(join(tmpdir(), 'cinna-task-service-'))
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
  if (holder.userData) rmSync(holder.userData, { recursive: true, force: true })
})

function makeTask(overrides: Partial<Parameters<typeof taskService.create>[1]> = {}) {
  return taskService.create(USER, {
    title: 'Ship the thing',
    goal: 'Ship the thing by Friday',
    ...overrides
  })
}

/**
 * The row as a peer would have sent it — every synced column, taken from what
 * is in the database now and then overridden.
 *
 * Built from the row rather than written out by hand so a column added to
 * `TaskSyncValues` fails to compile here instead of being silently omitted from
 * every test that applies one.
 */
function syncValues(
  taskId: string,
  overrides: Partial<TaskSyncValues> = {}
): TaskSyncValues {
  const row = taskRepo.getById(USER, taskId)
  if (!row) throw new Error(`no task ${taskId}`)
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    description: row.description,
    status: row.status,
    priority: row.priority,
    router: row.router,
    origin: row.origin,
    executor: row.executor,
    executorDevice: row.executorDevice,
    assigneeAgentId: row.assigneeAgentId,
    assigneeName: row.assigneeName,
    assigneeKind: row.assigneeKind,
    assigneeRef: row.assigneeRef,
    parentTaskId: row.parentTaskId,
    jobId: row.jobId,
    jobRunId: row.jobRunId,
    remoteAdapter: row.remoteAdapter,
    remoteId: row.remoteId,
    remoteKey: row.remoteKey,
    remoteUrl: row.remoteUrl,
    remoteState: row.remoteState,
    handoffNote: row.handoffNote,
    artifacts: row.artifacts,
    budget: row.budget,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    // A peer's edit is newer than what is here, by construction: it is why the
    // server handed it to us.
    updatedAt: new Date(row.updatedAt.getTime() + 60_000),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    deletedAt: row.deletedAt,
    ...overrides
  }
}

/** Walk a task to a status through legal steps, so a test can start where it means to. */
function driveTo(taskId: string, ...path: TaskStatus[]) {
  for (const status of path) taskService.setStatus(USER, taskId, status)
}

describe('what a bound task owes its service', () => {
  function boundTask() {
    return makeTask({ remoteAdapter: 'fake', remoteId: 'r-1', remoteKey: 'FAKE-1' })
  }

  function dirtyOf(taskId: string): string[] {
    return taskRepo.getById(USER, taskId)?.remoteDirty ?? []
  }

  it('writes nothing down for a task with no service to tell', () => {
    const task = makeTask()
    taskService.update(USER, task.id, { title: 'Renamed' })
    taskService.setStatus(USER, task.id, 'in_progress')
    // The column stays null for the overwhelming majority of tasks, so a later
    // `bindRemote` starts from a clean slate rather than a backlog of changes
    // the service was never going to hear about.
    expect(taskRepo.getById(USER, task.id)?.remoteDirty).toBeNull()
  })

  it('marks each field that a remote has somewhere to put', () => {
    const task = boundTask()
    taskService.update(USER, task.id, { title: 'Renamed', description: 'Now understood.' })
    expect(dirtyOf(task.id).sort()).toEqual(['description', 'title'])

    taskService.setStatus(USER, task.id, 'in_progress')
    taskService.setHandoffNote(USER, task.id, 'Half done.')
    taskService.setAssignee(USER, task.id, { agentId: null, name: 'Someone', kind: 'remote_agent' })
    expect(dirtyOf(task.id).sort()).toEqual([
      'assignee',
      'description',
      'handoffNote',
      'status',
      'title'
    ])
  })

  it('does not mark the router, which no remote has a field for', () => {
    const task = boundTask()
    taskService.update(USER, task.id, { router: 'human' })
    expect(dirtyOf(task.id)).toEqual([])
  })

  it('accumulates rather than replaces, so one change cannot erase another', () => {
    const task = boundTask()
    taskService.setStatus(USER, task.id, 'in_progress')
    taskService.update(USER, task.id, { title: 'Renamed' })
    // A title edited while a status push is still outstanding must not throw
    // the status away: the laptop may have been asleep for both.
    expect(dirtyOf(task.id).sort()).toEqual(['status', 'title'])
  })

  it('does not mark a status that came *from* the service', () => {
    const task = boundTask()
    taskService.acceptRemoteStatus(USER, task.id, 'blocked')
    // Otherwise every pull would queue a push of what it had just been told,
    // and the two copies would talk past each other for ever.
    expect(dirtyOf(task.id)).toEqual([])
  })

  it('clears what the push got through, and keeps what it did not', () => {
    const task = boundTask()
    taskService.update(USER, task.id, { title: 'Renamed' })
    taskService.setStatus(USER, task.id, 'in_progress')

    taskService.markRemoteSynced(USER, task.id, ['status'], { contacted: true })
    expect(dirtyOf(task.id)).toEqual(['status'])
    expect(taskRepo.getById(USER, task.id)?.remoteSyncedAt).toBeInstanceOf(Date)

    taskService.markRemoteSynced(USER, task.id, [], { contacted: true })
    expect(taskRepo.getById(USER, task.id)?.remoteDirty).toBeNull()
  })

  it('does not claim the service was reached by a pass that reached nothing', () => {
    const task = boundTask()
    taskService.update(USER, task.id, { title: 'Renamed' })
    // Every marker named a field this remote has no room for, so nothing left
    // the process. A timestamp that advanced here would advance for ever on a
    // service nobody can reach — the one reading it exists to rule out.
    taskService.markRemoteSynced(USER, task.id, [])
    expect(taskRepo.getById(USER, task.id)?.remoteSyncedAt).toBeNull()
    expect(taskRepo.getById(USER, task.id)?.remoteDirty).toBeNull()
  })
})

describe('binding a task to a service', () => {
  it('records the binding and starts from nothing owed', () => {
    const task = makeTask()
    taskService.update(USER, task.id, { title: 'Renamed' })

    const bound = taskService.bindRemote(USER, task.id, {
      adapter: 'fake',
      id: 'r-9',
      key: 'FAKE-9',
      url: 'https://fake.test/tasks/FAKE-9',
      state: { sessionIds: [] }
    })

    expect(bound.remote).toEqual({
      adapter: 'fake',
      id: 'r-9',
      key: 'FAKE-9',
      url: 'https://fake.test/tasks/FAKE-9'
    })
    // A create sends every field the remote takes, so at this instant the two
    // copies agree — including about the title that was dirty a moment ago.
    expect(taskRepo.getById(USER, task.id)?.remoteDirty).toBeNull()
    expect(taskRepo.getById(USER, task.id)?.remoteSyncedAt).toBeInstanceOf(Date)
  })

  it('keeps the whole task when the service says it is gone', () => {
    const task = makeTask({ remoteAdapter: 'fake', remoteId: 'r-1', remoteKey: 'FAKE-1' })
    driveTo(task.id, 'in_progress')
    taskService.handOffToRemote(USER, task.id)

    const unbound = taskService.unbindRemote(USER, task.id, 'the service answered 404')
    expect(unbound.remote).toBeNull()
    expect(unbound.title).toBe(task.title)
    expect(unbound.status).toBe('in_progress')
    // Not moved back to `desktop`: it is not running here, and pretending it
    // was would put a Stop button over nothing. Take over is a person's call.
    expect(unbound.executor).toBe('remote')
    expect(taskRepo.getById(USER, task.id)?.remoteDirty).toBeNull()
  })

  it('keeps the exported note in step with the short code', () => {
    const task = makeTask({ handoffNote: 'Half done.' })
    taskService.bindRemote(USER, task.id, {
      adapter: 'fake',
      id: 'r-9',
      key: 'FAKE-9',
      url: null,
      state: {}
    })
    const file = readFileSync(join(holder.userData, 'tasks', `${task.id}.md`), 'utf8')
    expect(parseFrontmatter(file)!.data.shortCode).toBe('FAKE-9')
  })
})

describe('applying what a pull brought back', () => {
  function replica() {
    return makeTask({
      origin: 'remote',
      executor: 'remote',
      remoteAdapter: 'fake',
      remoteId: 'r-1',
      remoteKey: 'FAKE-1'
    })
  }

  it('takes the remote’s fields, and its modification time with them', () => {
    const task = replica()
    const theirs = new Date('2026-09-11T08:00:00.000Z')
    const next = taskService.applyRemoteSnapshot(USER, task.id, {
      title: 'Renamed on the web',
      description: 'Understood better',
      priority: 'urgent',
      updatedAt: theirs
    })
    expect(next.title).toBe('Renamed on the web')
    expect(next.priority).toBe('urgent')
    // A mirror that always looked newer than the thing it mirrors would win
    // every per-field conflict it should lose.
    expect(next.updatedAt.toISOString()).toBe(theirs.toISOString())
  })

  it('takes a status the transition table calls unreachable', () => {
    const task = replica()
    // cinna's own session handlers bypass its table, so a replica really can
    // arrive somewhere the desktop could not have walked to. Arguing with the
    // system doing the work is how the desktop becomes the one corrupting it.
    const next = taskService.applyRemoteSnapshot(USER, task.id, { status: 'completed' })
    expect(next.status).toBe('completed')
    expect(next.finishedAt).toBeInstanceOf(Date)
  })

  it('does not overwrite a field this device still owes the service', () => {
    const task = replica()
    taskService.update(USER, task.id, { title: 'Renamed here' })

    const next = taskService.applyRemoteSnapshot(USER, task.id, {
      title: 'Renamed there',
      description: 'Also changed there'
    })
    // The marker means "we know something it does not" — taking its value now
    // would throw the user's change away moments before it was to be sent.
    expect(next.title).toBe('Renamed here')
    // Everything not owed still comes through.
    expect(next.description).toBe('Also changed there')
  })

  it('lets the remote’s status through once the push has been made', () => {
    // Desktop-executed and bound: the shape where this device writes the
    // status and the service is told about it afterwards.
    const task = makeTask({ remoteAdapter: 'fake', remoteId: 'r-1', remoteKey: 'FAKE-1' })
    taskService.setStatus(USER, task.id, 'in_progress')
    expect(
      taskService.applyRemoteSnapshot(USER, task.id, { status: 'blocked' }).status
    ).toBe('in_progress')

    taskService.markRemoteSynced(USER, task.id, [])
    expect(taskService.applyRemoteSnapshot(USER, task.id, { status: 'blocked' }).status).toBe(
      'blocked'
    )
  })

  it('does not wipe the reason a task failed while the status is still owed', () => {
    // `errorMessage` is written *by* `statusPatch` — it is part of the status,
    // not a field beside it. A pull always carries one (null when the remote
    // has none), so letting it through on its own wiped the text of a task that
    // had just failed here, on the very next poll, before the push that reports
    // the failure had even left. Nothing puts it back: the status path carries
    // a reason, not the text, and cinna has no field for it.
    const task = makeTask({ remoteAdapter: 'fake', remoteId: 'r-1' })
    driveTo(task.id, 'in_progress')
    taskService.setStatus(USER, task.id, 'error', { errorMessage: 'Agent crashed: ENOENT' })

    const next = taskService.applyRemoteSnapshot(USER, task.id, {
      status: 'in_progress',
      errorMessage: null
    })
    expect(next.status).toBe('error')
    expect(next.errorMessage).toBe('Agent crashed: ENOENT')
  })

  it('takes the remote’s reason once the status has been pushed', () => {
    const task = replica()
    const next = taskService.applyRemoteSnapshot(USER, task.id, {
      status: 'error',
      errorMessage: 'The agent could not reach the ledger'
    })
    expect(next.errorMessage).toBe('The agent could not reach the ledger')
  })

  it('refreshes what the binding displays without re-identifying the task', () => {
    const task = replica()
    const next = taskService.applyRemoteSnapshot(USER, task.id, {
      binding: { key: 'FAKE-42', url: 'https://fake.test/tasks/FAKE-42', state: { seen: 1 } }
    })
    expect(next.remote).toEqual({
      adapter: 'fake',
      id: 'r-1',
      key: 'FAKE-42',
      url: 'https://fake.test/tasks/FAKE-42'
    })
  })
})

describe('create', () => {
  it('starts a task in the server’s create state, owned by the desktop', () => {
    const task = makeTask()
    expect(task.status).toBe('new')
    expect(task.origin).toBe('local')
    expect(task.executor).toBe('desktop')
    expect(task.startedAt).toBeNull()
    expect(task.finishedAt).toBeNull()
  })

  it('refuses an empty title or goal', () => {
    expect(() => makeTask({ title: '   ' })).toThrow(TaskError)
    expect(() => makeTask({ goal: '' })).toThrow(TaskError)
    try {
      makeTask({ title: '' })
    } catch (err) {
      expect((err as TaskError).code).toBe('invalid_input')
    }
  })

  it('trims the title and goal rather than storing the whitespace', () => {
    const task = makeTask({ title: '  Ship it  ', goal: '  Ship it by Friday  ' })
    expect(task.title).toBe('Ship it')
    expect(task.goal).toBe('Ship it by Friday')
  })

  it('claims this device when the profile has one', () => {
    holder.deviceId = 'device-a'
    expect(makeTask().executorDevice).toBe('device-a')
  })

  it('claims nobody in particular when the profile has never synced', () => {
    expect(makeTask().executorDevice).toBeNull()
  })

  it('does not claim a device for a task the remote is running', () => {
    holder.deviceId = 'device-a'
    const task = makeTask({ executor: 'remote', remoteAdapter: 'fake', remoteId: 'r-1' })
    expect(task.executorDevice).toBeNull()
  })

  it('infers the assignee kind from whether an agent was named', () => {
    expect(makeTask().assignee.kind).toBe('model')
    expect(makeTask({ assigneeAgentId: 'a-1' }).assignee.kind).toBe('agent')
    expect(makeTask({ assigneeKind: 'remote_agent', assigneeName: 'Reviewer' }).assignee).toEqual({
      agentId: null,
      name: 'Reviewer',
      kind: 'remote_agent'
    })
  })
})

describe('one level of hierarchy', () => {
  it('allows a subtask of a root task', () => {
    const parent = makeTask()
    const child = makeTask({ title: 'Sub', parentTaskId: parent.id })
    expect(child.parentTaskId).toBe(parent.id)
  })

  it('refuses a subtask of a subtask', () => {
    const parent = makeTask()
    const child = makeTask({ title: 'Sub', parentTaskId: parent.id })
    try {
      makeTask({ title: 'Sub-sub', parentTaskId: child.id })
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(TaskError)
      expect((err as TaskError).code).toBe('nested_too_deep')
    }
  })

  it('refuses a parent that is not this user’s', () => {
    const mine = makeTask()
    expect(() =>
      taskService.create(OTHER_USER, {
        title: 'Sub',
        goal: 'Sub',
        parentTaskId: mine.id
      })
    ).toThrow(TaskError)
  })

  it('reports the subtask pair on the parent, counted in one query', () => {
    const parent = makeTask()
    const a = makeTask({ title: 'A', parentTaskId: parent.id })
    makeTask({ title: 'B', parentTaskId: parent.id })
    driveTo(a.id, 'in_progress', 'completed')

    const listed = taskService.list(USER).find((t) => t.id === parent.id)
    expect(listed).toMatchObject({ subtaskCount: 2, subtaskCompletedCount: 1 })
    expect(taskService.getById(USER, parent.id)).toMatchObject({
      subtaskCount: 2,
      subtaskCompletedCount: 1
    })
  })
})

describe('setStatus — validated, because the desktop initiated it', () => {
  it('walks the ladder', () => {
    const task = makeTask()
    expect(taskService.setStatus(USER, task.id, 'in_progress').status).toBe('in_progress')
    expect(taskService.setStatus(USER, task.id, 'blocked').status).toBe('blocked')
    expect(taskService.setStatus(USER, task.id, 'in_progress').status).toBe('in_progress')
    expect(taskService.setStatus(USER, task.id, 'completed').status).toBe('completed')
  })

  it('refuses the jump a two-second run would attempt', () => {
    const task = makeTask()
    try {
      taskService.setStatus(USER, task.id, 'completed')
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(TaskError)
      expect((err as TaskError).code).toBe('invalid_transition')
      // The detail names the way out, because a refusal nobody can act on is noise.
      expect((err as TaskError).detail).toContain('in_progress')
    }
    expect(taskService.getById(USER, task.id).status).toBe('new')
  })

  it('accepts a no-op without complaining', () => {
    const task = makeTask()
    expect(taskService.setStatus(USER, task.id, 'new').status).toBe('new')
  })

  it('stamps startedAt once and keeps it across a block', () => {
    const task = makeTask()
    const started = taskService.setStatus(USER, task.id, 'in_progress').startedAt
    expect(started).toBeInstanceOf(Date)
    taskService.setStatus(USER, task.id, 'blocked')
    const resumed = taskService.setStatus(USER, task.id, 'in_progress')
    expect(resumed.startedAt?.getTime()).toBe(started?.getTime())
  })

  it('preserves the finish time and the error text when a task is archived', () => {
    // `archived` is not a retry — it is the user filing the task away, and it
    // is the only way out of a terminal status. Clearing on "any status that is
    // not terminal" wiped both, unrecoverably, for every task anybody archived.
    const task = makeTask()
    driveTo(task.id, 'in_progress')
    const failed = taskService.setStatus(USER, task.id, 'error', { errorMessage: 'boom' })
    const archived = taskService.setStatus(USER, task.id, 'archived')
    expect(archived.errorMessage).toBe('boom')
    expect(archived.finishedAt?.getTime()).toBe(failed.finishedAt?.getTime())
  })

  it('preserves them when a completed task is archived too', () => {
    const task = makeTask()
    driveTo(task.id, 'in_progress')
    const done = taskService.setStatus(USER, task.id, 'completed')
    const archived = taskService.setStatus(USER, task.id, 'archived')
    expect(archived.finishedAt?.getTime()).toBe(done.finishedAt?.getTime())
  })

  it('preserves them through an archive arriving from a pull', () => {
    const task = makeTask()
    driveTo(task.id, 'in_progress')
    taskService.setStatus(USER, task.id, 'error', { errorMessage: 'boom' })
    expect(taskService.acceptRemoteStatus(USER, task.id, 'archived').errorMessage).toBe('boom')
  })

  it('clears finishedAt when an errored task is retried', () => {
    const task = makeTask()
    driveTo(task.id, 'in_progress')
    const failed = taskService.setStatus(USER, task.id, 'error', { errorMessage: 'boom' })
    expect(failed.finishedAt).toBeInstanceOf(Date)
    expect(failed.errorMessage).toBe('boom')

    // `error → in_progress` is a legal retry, and a finished-at in the past on
    // a running task is the kind of wrong that only surfaces in a report.
    const retried = taskService.setStatus(USER, task.id, 'in_progress')
    expect(retried.finishedAt).toBeNull()
    expect(retried.errorMessage).toBeNull()
  })
})

describe('acceptRemoteStatus — accepted, because somewhere else initiated it', () => {
  it('takes a status the transition table forbids reaching', () => {
    const task = makeTask()
    // cinna-core's own session handlers bypass its table, so this really does
    // arrive. Refusing it would make the desktop the one corrupting state.
    expect(taskService.acceptRemoteStatus(USER, task.id, 'completed').status).toBe('completed')
  })

  it('accepts a status on a task the remote is running, which setStatus would refuse', () => {
    holder.deviceId = 'device-a'
    const task = makeTask({ executor: 'remote', remoteAdapter: 'fake', remoteId: 'r-1' })
    expect(() => taskService.setStatus(USER, task.id, 'in_progress')).toThrow(TaskError)
    expect(taskService.acceptRemoteStatus(USER, task.id, 'blocked').status).toBe('blocked')
  })

  it('keeps the same timestamp bookkeeping as a local write', () => {
    const task = makeTask()
    const running = taskService.acceptRemoteStatus(USER, task.id, 'in_progress')
    expect(running.startedAt).toBeInstanceOf(Date)
    expect(taskService.acceptRemoteStatus(USER, task.id, 'cancelled').finishedAt).toBeInstanceOf(
      Date
    )
  })
})

describe('applyRunState — the bridge between the two vocabularies', () => {
  it('takes a step the table allows', () => {
    const task = makeTask()
    expect(taskService.applyRunState(USER, task.id, 'working').status).toBe('in_progress')
    expect(taskService.applyRunState(USER, task.id, 'needs_input').status).toBe('blocked')
  })

  it('walks through in_progress when a run ends before it visibly started', () => {
    // `new → completed` is not in the table. A run that finishes in two seconds
    // still has to pass through the middle, and this is the local twin of the
    // status *path* a bound remote needs.
    const task = makeTask()
    const done = taskService.applyRunState(USER, task.id, 'completed')
    expect(done.status).toBe('completed')
    // …and it really passed through, so `startedAt` is set rather than null.
    expect(done.startedAt).toBeInstanceOf(Date)
  })

  it('walks through in_progress for a failure before the first turn, too', () => {
    const task = makeTask()
    expect(taskService.applyRunState(USER, task.id, 'failed').status).toBe('error')
  })

  it('says nothing rather than going backwards', () => {
    // A2A's `submitted` maps to `open`, and a second turn in the same chat
    // starts a new A2A task there. `in_progress → open` is not in the table,
    // and throwing here would break the stream-completion path on the second
    // turn of every agent chat.
    const task = makeTask()
    driveTo(task.id, 'in_progress')
    expect(() => taskService.applyRunState(USER, task.id, 'submitted')).not.toThrow()
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('never throws for any run state from any status', () => {
    const states: RunState[] = [
      'submitted',
      'working',
      'needs_input',
      'completed',
      'failed',
      'canceled',
      'rejected',
      'unknown'
    ]
    for (const from of ['new', 'open', 'in_progress', 'blocked', 'completed', 'archived'] as const) {
      for (const state of states) {
        const task = makeTask()
        // Walk to `from` through whatever legal path exists, then apply.
        if (from === 'open') driveTo(task.id, 'open')
        if (from === 'in_progress') driveTo(task.id, 'in_progress')
        if (from === 'blocked') driveTo(task.id, 'in_progress', 'blocked')
        if (from === 'completed') driveTo(task.id, 'in_progress', 'completed')
        if (from === 'archived') driveTo(task.id, 'archived')
        expect(() => taskService.applyRunState(USER, task.id, state)).not.toThrow()
      }
    }
  })

  it('leaves an archived task where the user put it', () => {
    const task = makeTask()
    driveTo(task.id, 'in_progress', 'completed', 'archived')
    expect(taskService.applyRunState(USER, task.id, 'working').status).toBe('archived')
  })
})

describe('authority follows executor', () => {
  it('lets this device write the fields that follow the run', () => {
    holder.deviceId = 'device-a'
    const task = makeTask()
    expect(taskService.setAssignee(USER, task.id, {
      agentId: 'a-1',
      name: 'Reviewer',
      kind: 'agent'
    }).assignee.agentId).toBe('a-1')
    expect(taskService.setHandoffNote(USER, task.id, '## Where I got to').handoffNote).toContain(
      'Where I got to'
    )
  })

  it('refuses them from a device that is not the one running it', () => {
    holder.deviceId = 'device-a'
    const task = makeTask()
    expect(task.executorDevice).toBe('device-a')

    holder.deviceId = 'device-b'
    for (const write of [
      () => taskService.setStatus(USER, task.id, 'in_progress'),
      () => taskService.setAssignee(USER, task.id, { agentId: null, name: null, kind: 'model' }),
      () => taskService.setHandoffNote(USER, task.id, 'note')
    ]) {
      try {
        write()
        throw new Error('expected a refusal')
      } catch (err) {
        expect(err).toBeInstanceOf(TaskError)
        expect((err as TaskError).code).toBe('running_elsewhere')
      }
    }
  })

  it('lets either device fix a title, a description or a priority', () => {
    holder.deviceId = 'device-a'
    const task = makeTask()
    holder.deviceId = 'device-b'
    const updated = taskService.update(USER, task.id, {
      title: 'Ship it properly',
      description: 'With tests',
      priority: 'high'
    })
    expect(updated).toMatchObject({
      title: 'Ship it properly',
      description: 'With tests',
      priority: 'high'
    })
  })

  it('gives authority back to a device that has left sync', () => {
    // `syncService.disconnect` keeps the `sync_state` row and nulls its
    // `deviceId`; reconnecting enrols a *new* one. Without this, turning sync
    // off locked the only device there is out of every task it had claimed, and
    // a run could never report that it had finished.
    holder.deviceId = 'device-a'
    const task = makeTask()
    expect(task.executorDevice).toBe('device-a')

    holder.deviceId = null
    expect(taskService.setStatus(USER, task.id, 'in_progress').status).toBe('in_progress')
    expect(taskService.setHandoffNote(USER, task.id, 'note').handoffNote).toBe('note')
  })

  it('treats a null executorDevice as here, whatever this device is called', () => {
    // A profile with sync off writes null, and must not lock itself out when
    // it later registers a device id.
    const task = makeTask()
    expect(task.executorDevice).toBeNull()
    holder.deviceId = 'device-a'
    expect(taskService.setStatus(USER, task.id, 'in_progress').status).toBe('in_progress')
  })
})

describe('handover', () => {
  it('takes a task back from another device and claims it', () => {
    holder.deviceId = 'device-a'
    const task = makeTask()
    holder.deviceId = 'device-b'

    const taken = taskService.takeOver(USER, task.id)
    expect(taken.executor).toBe('desktop')
    expect(taken.executorDevice).toBe('device-b')
    // …and the writes that were refused a moment ago now go through.
    expect(taskService.setStatus(USER, task.id, 'in_progress').status).toBe('in_progress')
  })

  it('takes a task back from the remote', () => {
    holder.deviceId = 'device-a'
    const task = makeTask({ executor: 'remote', remoteAdapter: 'fake', remoteId: 'r-1' })
    const taken = taskService.takeOver(USER, task.id)
    expect(taken.executor).toBe('desktop')
    expect(taken.executorDevice).toBe('device-a')
    // Provenance does not move with the run.
    expect(taken.origin).toBe('local')
    expect(taken.remote).toEqual({ adapter: 'fake', id: 'r-1', key: null, url: null })
  })

  it('hands a bound task to the remote and releases the device', () => {
    holder.deviceId = 'device-a'
    const task = makeTask({ remoteAdapter: 'fake', remoteId: 'r-1' })
    const handed = taskService.handOffToRemote(USER, task.id)
    expect(handed.executor).toBe('remote')
    expect(handed.executorDevice).toBeNull()
  })

  it('refuses to hand off a task that is not connected to anything', () => {
    const task = makeTask()
    try {
      taskService.handOffToRemote(USER, task.id)
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as TaskError).code).toBe('invalid_input')
    }
  })
})

describe('start', () => {
  it('moves to in_progress, claims the device and binds the chat', () => {
    holder.deviceId = 'device-a'
    const task = makeTask()
    const started = taskService.start(USER, task.id, { chatId: null })
    expect(started.status).toBe('in_progress')
    expect(started.executorDevice).toBe('device-a')
    expect(started.startedAt).toBeInstanceOf(Date)
  })

  it('claims the device for a task created before this one had an id', () => {
    const task = makeTask()
    expect(task.executorDevice).toBeNull()
    holder.deviceId = 'device-a'
    expect(taskService.start(USER, task.id).executorDevice).toBe('device-a')
  })

  it('leaves the device alone for a remote task', () => {
    holder.deviceId = 'device-a'
    const task = makeTask({ executor: 'remote', remoteAdapter: 'fake', remoteId: 'r-1' })
    expect(taskService.start(USER, task.id).executorDevice).toBeNull()
  })

  it('refuses to start a task another device is already running', () => {
    // Pressing Run on a synced row is not a way to take a live run off a peer.
    // `takeOver` is the write that moves it; this is not.
    holder.deviceId = 'device-a'
    const task = makeTask()
    holder.deviceId = 'device-b'
    try {
      taskService.start(USER, task.id)
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as TaskError).code).toBe('running_elsewhere')
    }
    expect(taskService.getById(USER, task.id).executorDevice).toBe('device-a')
  })

  it('refuses to start an archived task', () => {
    const task = makeTask()
    taskService.setStatus(USER, task.id, 'archived')
    try {
      taskService.start(USER, task.id)
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as TaskError).code).toBe('invalid_transition')
    }
  })
})

describe('reads and deletes', () => {
  it('hides archived tasks from the default list and shows them on request', () => {
    const live = makeTask({ title: 'Live' })
    const filed = makeTask({ title: 'Filed' })
    taskService.setStatus(USER, filed.id, 'archived')

    expect(taskService.list(USER).map((t) => t.id)).toEqual([live.id])
    expect(taskService.list(USER, { includeArchived: true }).map((t) => t.id).sort()).toEqual(
      [live.id, filed.id].sort()
    )
    expect(taskService.list(USER, { statuses: ['archived'] }).map((t) => t.id)).toEqual([filed.id])
  })

  it('filters by executor, which is what the inbox’s remote half is', () => {
    const local = makeTask({ title: 'Here' })
    const remote = makeTask({ title: 'There', executor: 'remote', remoteAdapter: 'fake', remoteId: 'r-1' })
    expect(taskService.list(USER, { executor: 'remote' }).map((t) => t.id)).toEqual([remote.id])
    expect(taskService.list(USER, { executor: 'desktop' }).map((t) => t.id)).toEqual([local.id])
  })

  it('never returns another user’s task', () => {
    const mine = makeTask()
    expect(taskService.list(OTHER_USER)).toEqual([])
    expect(() => taskService.getById(OTHER_USER, mine.id)).toThrow(TaskError)
  })

  it('soft-deletes, so the delete can travel as a tombstone', () => {
    const task = makeTask()
    taskService.remove(USER, task.id)
    expect(taskService.list(USER)).toEqual([])
    expect(() => taskService.getById(USER, task.id)).toThrow(TaskError)
    // The row is still there — app-sync carries deletes as `deletedAt`.
    expect(taskRepo.getById(USER, task.id)?.deletedAt).toBeInstanceOf(Date)
  })

  it('refuses to write a deleted task at the repo, not only at the service', () => {
    // The service refuses through `requireTask`; this is the second lock, for
    // the caller that is not a service method — a sync-apply path writing a row
    // that arrived from another device. Going round the service there would
    // also rewrite the task's exported note, so a file would reappear under
    // `<userData>/tasks/` for a task the user deleted.
    const task = makeTask({ title: 'before' })
    taskService.remove(USER, task.id)

    expect(taskRepo.update(USER, task.id, { title: 'after' })).toBeUndefined()

    const row = taskRepo.getById(USER, task.id)
    expect(row?.title).toBe('before')
    expect(row?.deletedAt).toBeInstanceOf(Date)
  })

  it('keeps the opaque remote state out of the DTO', () => {
    const task = makeTask({
      remoteAdapter: 'fake',
      remoteId: 'r-1',
      remoteKey: 'TASK-7',
      remoteUrl: 'https://example.test/tasks/TASK-7',
      remoteState: { sessionId: 's-1' }
    })
    expect(task.remote).toEqual({
      adapter: 'fake',
      id: 'r-1',
      key: 'TASK-7',
      url: 'https://example.test/tasks/TASK-7'
    })
    expect(JSON.stringify(task)).not.toContain('s-1')
  })

  it('reports no binding for a desktop-only task', () => {
    expect(makeTask().remote).toBeNull()
  })
})

/**
 * The note on disk is a **view** of the row, and these are the two ways a view
 * goes wrong: it is not there when the row says it should be, and it is there
 * saying something the row stopped agreeing with.
 *
 * The second is why the export hangs off every write rather than off
 * `setHandoffNote` alone, as §5.11 specifies. The frontmatter carries `status`,
 * `title`, `assignee`, `parent` and `updated`, every one of which changes from
 * somewhere else — and since nothing ever reads the file back, a stale one is
 * never corrected by anything.
 */
describe('the exported handoff note', () => {
  function noteFile(taskId: string): string | null {
    const path = join(holder.userData, 'tasks', `${taskId}.md`)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }

  it('is written when the note is set, and says what the task is', () => {
    const task = makeTask({ title: 'Ship the thing' })
    taskService.setHandoffNote(USER, task.id, 'Ledger read; two invoices flagged.')

    const parsed = parseFrontmatter(noteFile(task.id)!)
    expect(parsed!.data.id).toBe(task.id)
    expect(parsed!.data.title).toBe('Ship the thing')
    expect(parsed!.data.status).toBe('new')
    expect(parsed!.body).toBe('Ledger read; two invoices flagged.\n')
  })

  it('follows the task’s status, not just its note', () => {
    const task = makeTask()
    taskService.setHandoffNote(USER, task.id, 'Half done.')
    driveTo(task.id, 'in_progress', 'completed')

    expect(parseFrontmatter(noteFile(task.id)!)!.data.status).toBe('completed')
  })

  it('follows a renamed title and a reassignment', () => {
    const task = makeTask()
    taskService.setHandoffNote(USER, task.id, 'Half done.')
    taskService.update(USER, task.id, { title: 'Ship it on Monday' })
    taskService.setAssignee(USER, task.id, {
      agentId: 'agt_2',
      name: 'Ledger agent',
      kind: 'agent'
    })

    const parsed = parseFrontmatter(noteFile(task.id)!)
    expect(parsed!.data.title).toBe('Ship it on Monday')
    expect(parsed!.data.assignee).toBe('Ledger agent')
  })

  it('is not written for a task that has no note', () => {
    const task = makeTask()
    driveTo(task.id, 'in_progress')
    expect(noteFile(task.id)).toBeNull()
  })

  it('goes away when the note is cleared', () => {
    const task = makeTask()
    taskService.setHandoffNote(USER, task.id, 'Half done.')
    expect(noteFile(task.id)).not.toBeNull()

    taskService.setHandoffNote(USER, task.id, null)
    expect(noteFile(task.id)).toBeNull()
  })

  it('goes away when the task is deleted', () => {
    const task = makeTask()
    taskService.setHandoffNote(USER, task.id, 'Half done.')
    expect(noteFile(task.id)).not.toBeNull()

    taskService.remove(USER, task.id)
    expect(noteFile(task.id)).toBeNull()
  })
})

/**
 * **Every mutating method keeps the file in step — enumerated, so a new one
 * cannot quietly skip it.**
 *
 * This is the guard on the deviation above, and it exists because of exactly
 * where the deviation is going to be tested next. Nothing writes
 * `remoteAdapter` / `remoteId` / `remoteKey` today, which is the only reason
 * `shortCode` in the frontmatter cannot go stale — and step 9's
 * `taskSyncService` binding write is precisely such a method. If it ends
 * `return toTaskDto(row)` like the two read paths do, every bound task's file
 * starts claiming the wrong short code, or none, and not one assertion in this
 * suite notices.
 *
 * So the *list* is what is pinned, not the behaviour of one method: adding
 * anything to `taskService` fails the first test here until it is classified as
 * a read or a write, and classifying it as a write immediately demands that it
 * actually touch the file.
 */
describe('every task write keeps the exported note in step', () => {
  /** Methods that only read. A read must not write the file either. */
  const READS = ['list', 'getById', 'getRow']

  const NOTE = 'Half done; the ledger is open.'

  /**
   * One recipe per mutating method. Each runs against a task that already has a
   * note, whose file has been removed first — so the assertion is that *this
   * call* put it back, not that some earlier call had.
   */
  const WRITES: Record<
    string,
    { run: (taskId: string) => string; leaves: 'file' | 'no file' }
  > = {
    create: {
      run: () => makeTask({ handoffNote: NOTE }).id,
      leaves: 'file'
    },
    update: {
      run: (id) => taskService.update(USER, id, { title: 'Renamed' }).id,
      leaves: 'file'
    },
    setStatus: {
      run: (id) => taskService.setStatus(USER, id, 'in_progress').id,
      leaves: 'file'
    },
    acceptRemoteStatus: {
      run: (id) => taskService.acceptRemoteStatus(USER, id, 'blocked').id,
      leaves: 'file'
    },
    applyRunState: {
      run: (id) => taskService.applyRunState(USER, id, 'working').id,
      leaves: 'file'
    },
    setAssignee: {
      run: (id) =>
        taskService.setAssignee(USER, id, { agentId: 'agt_9', name: 'Ledger', kind: 'agent' }).id,
      leaves: 'file'
    },
    setHandoffNote: {
      run: (id) => taskService.setHandoffNote(USER, id, 'A newer note.').id,
      leaves: 'file'
    },
    start: {
      run: (id) => taskService.start(USER, id).id,
      leaves: 'file'
    },
    takeOver: {
      run: (id) => taskService.takeOver(USER, id).id,
      leaves: 'file'
    },
    handOffToRemote: {
      run: (id) => taskService.handOffToRemote(USER, id).id,
      leaves: 'file'
    },
    // The four binding writers. `bindRemote` is the one the step-7 review
    // named in advance: it writes `remoteKey`, which is frontmatter, so a
    // version of it that ended in `toTaskDto(row)` would leave every bound
    // task's file claiming the wrong short code with nothing to correct it.
    bindRemote: {
      run: (id) =>
        taskService.bindRemote(USER, id, {
          adapter: 'fake',
          id: 'r-2',
          key: 'FAKE-2',
          url: 'https://fake.test/tasks/FAKE-2',
          state: {}
        }).id,
      leaves: 'file'
    },
    unbindRemote: {
      run: (id) => taskService.unbindRemote(USER, id, 'the service says it is gone').id,
      leaves: 'file'
    },
    markRemoteSynced: {
      run: (id) => taskService.markRemoteSynced(USER, id, []).id,
      leaves: 'file'
    },
    applyRemoteSnapshot: {
      run: (id) => taskService.applyRemoteSnapshot(USER, id, { title: 'From the web' }).id,
      leaves: 'file'
    },
    // Enrolment's backfill: it bumps `updatedAt`, which is frontmatter, on
    // every task that had no claim.
    adoptUnclaimed: {
      run: (id) => {
        holder.deviceId = 'device-here'
        taskService.adoptUnclaimed(USER, 'device-here')
        return id
      },
      leaves: 'file'
    },
    // The app-sync apply path. It is on this list rather than calling
    // `taskRepo.upsertFromSync` from the mapper for exactly the reason the list
    // exists: a peer's edit changes `title`, `status` and `assigneeName`, all
    // three of which are frontmatter.
    applySyncedTask: {
      run: (id) => taskService.applySyncedTask(USER, syncValues(id, { title: 'From a peer' }))!.id,
      leaves: 'file'
    },
    // And its tombstone arm, which must take the file with it — a file for a
    // task that no longer exists anywhere is the one an agent would still read.
    removeSyncedTask: {
      run: (id) => {
        taskService.removeSyncedTask(USER, id)
        return id
      },
      leaves: 'no file'
    },
    remove: {
      run: (id) => {
        taskService.remove(USER, id)
        return id
      },
      leaves: 'no file'
    }
  }

  function noteFilePath(taskId: string): string {
    return join(holder.userData, 'tasks', `${taskId}.md`)
  }

  it('classifies every method on the service', () => {
    // The whole point: a method added without a line here fails, and the person
    // adding it has to decide whether it writes.
    expect([...READS, ...Object.keys(WRITES)].sort()).toEqual(Object.keys(taskService).sort())
  })

  it.each(Object.entries(WRITES))('%s', (_name, { run, leaves }) => {
    // A bound task, so `handOffToRemote` has something to hand off and every
    // other recipe exercises the `shortCode` field at the same time.
    const task = makeTask({
      handoffNote: NOTE,
      remoteAdapter: 'fake',
      remoteId: 'r-1',
      remoteKey: 'FAKE-1'
    })

    if (leaves === 'file') {
      // Remove it first, so the assertion is about *this* call.
      rmSync(noteFilePath(task.id), { force: true })
    } else {
      expect(existsSync(noteFilePath(task.id))).toBe(true)
    }

    const touched = run(task.id)
    expect(existsSync(noteFilePath(touched))).toBe(leaves === 'file')
  })

  /**
   * Two of the recipes above run methods that are *allowed* to do nothing —
   * `update` with an empty patch returns early, and `applyRunState` no-ops on a
   * state the task cannot reach. A recipe that happened to hit either path
   * would assert nothing while still passing, so what they do is pinned here
   * rather than left to be inferred from the inputs.
   */
  it('the two recipes that could legitimately no-op do not', () => {
    const renamed = makeTask({ handoffNote: NOTE })
    expect(taskService.update(USER, renamed.id, { title: 'Renamed' }).title).toBe('Renamed')

    const running = makeTask({ handoffNote: NOTE })
    expect(taskService.applyRunState(USER, running.id, 'working').status).toBe('in_progress')
  })

  it.each(READS)('%s writes nothing', (name) => {
    const task = makeTask({ handoffNote: NOTE })
    rmSync(noteFilePath(task.id), { force: true })

    if (name === 'list') taskService.list(USER)
    if (name === 'getById') taskService.getById(USER, task.id)
    if (name === 'getRow') taskService.getRow(USER, task.id)

    expect(existsSync(noteFilePath(task.id))).toBe(false)
  })
})

/**
 * The app-sync apply path — a task arriving from another of the user's devices.
 *
 * Against the real database, because every claim here is about what is in the
 * row afterwards. The mapper that decodes the wire payload and resolves the
 * assignee descriptor is `sync/collections.ts` and is tested there; what is
 * tested here is the half `taskService` owns, which is the half with the rules.
 */
describe('a task that arrived from another device', () => {
  const PEER = 'device-peer'

  function noteFilePath(taskId: string): string {
    return join(holder.userData, 'tasks', `${taskId}.md`)
  }

  it('creates a row under the id the peer sent, with the peer’s times', () => {
    const created = new Date('2026-01-02T03:04:05.000Z')
    const updated = new Date('2026-03-04T05:06:07.000Z')
    const dto = taskService.applySyncedTask(USER, {
      ...syncValues(makeTask().id),
      id: 'tsk_from_peer',
      title: 'Written elsewhere',
      createdAt: created,
      updatedAt: updated
    })

    expect(dto?.id).toBe('tsk_from_peer')
    const row = taskRepo.getById(USER, 'tsk_from_peer')
    expect(row?.title).toBe('Written elsewhere')
    // Not "now". A replica that stamped its own arrival time would tell the
    // user every task in their history began the moment this device joined.
    expect(row?.createdAt.getTime()).toBe(created.getTime())
    expect(row?.updatedAt.getTime()).toBe(updated.getTime())
  })

  it('never inherits the three columns that do not travel', () => {
    const local = makeTask()
    taskService.bindRemote(USER, local.id, {
      adapter: 'fake',
      id: 'r-1',
      key: 'FAKE-1',
      url: null,
      state: { session: 's1' }
    })
    taskService.update(USER, local.id, { title: 'Edited here' })
    // Bound, dirty and in a chat — the three things a peer must not be told.
    expect(taskRepo.getById(USER, local.id)?.remoteDirty).toEqual(['title'])

    taskService.applySyncedTask(USER, {
      ...syncValues(local.id),
      id: 'tsk_peer_2',
      title: 'From the peer'
    })

    const row = taskRepo.getById(USER, 'tsk_peer_2')
    // The binding itself DOES travel — a peer must open the same remote task
    // rather than create a second one — but the bookkeeping about it does not.
    expect(row?.remoteId).toBe('r-1')
    expect(row?.remoteSyncedAt).toBeNull()
    expect(row?.remoteDirty).toBeNull()
    expect(row?.chatId).toBeNull()
  })

  it('is read-only here while the peer holds the claim, and writable once it does not', () => {
    holder.deviceId = 'device-here'
    const seed = makeTask()
    const dto = taskService.applySyncedTask(USER, {
      ...syncValues(seed.id),
      id: 'tsk_claimed',
      executor: 'desktop',
      executorDevice: PEER
    })
    expect(dto?.runsHere).toBe(false)
    // And main refuses the write the banner refuses to offer.
    expect(() => taskService.setStatus(USER, 'tsk_claimed', 'in_progress')).toThrow(TaskError)

    taskService.takeOver(USER, 'tsk_claimed')
    expect(taskService.getById(USER, 'tsk_claimed').runsHere).toBe(true)
    expect(() => taskService.setStatus(USER, 'tsk_claimed', 'in_progress')).not.toThrow()
  })

  it('takes the peer’s delete, and the exported note goes with it', () => {
    const task = makeTask({ handoffNote: 'Half done.' })
    expect(existsSync(noteFilePath(task.id))).toBe(true)

    taskService.applySyncedTask(USER, { ...syncValues(task.id), deletedAt: new Date() })

    expect(taskRepo.getById(USER, task.id)?.deletedAt).not.toBeNull()
    expect(existsSync(noteFilePath(task.id))).toBe(false)
    // And it is gone from every list and every service method, as a local
    // delete would be.
    expect(taskService.list(USER)).toHaveLength(0)
    expect(() => taskService.getById(USER, task.id)).toThrow(TaskError)
  })

  /**
   * The one case that separates this writer from `taskRepo.update`, which
   * refuses a soft-deleted row outright.
   *
   * The sync engine only calls apply for a record the server's last-writer-wins
   * has already declared the newer one. Refusing it here would leave the two
   * devices permanently disagreeing about whether the task exists, with nothing
   * that could ever reconcile them.
   */
  it('resurrects a row this device had deleted, which `taskRepo.update` refuses to do', () => {
    const task = makeTask({ handoffNote: 'Half done.' })
    const alive = syncValues(task.id)
    taskService.remove(USER, task.id)
    expect(taskRepo.update(USER, task.id, { title: 'nope' })).toBeUndefined()

    const dto = taskService.applySyncedTask(USER, { ...alive, deletedAt: null })

    expect(dto?.id).toBe(task.id)
    expect(taskRepo.getById(USER, task.id)?.deletedAt).toBeNull()
    // The note comes back with it: the task is a task again.
    expect(existsSync(noteFilePath(task.id))).toBe(true)
  })

  it('writes nothing when the id already belongs to another profile here', () => {
    const mine = makeTask({ title: 'Mine' })
    const theirs = taskService.create(OTHER_USER, { title: 'Theirs', goal: 'Theirs, please' })

    const result = taskService.applySyncedTask(USER, {
      ...syncValues(mine.id),
      id: theirs.id,
      title: 'Stolen'
    })

    expect(result).toBeNull()
    expect(taskRepo.getById(OTHER_USER, theirs.id)?.title).toBe('Theirs')
  })

  /**
   * And the repo *says* it refused, rather than leaving the service to infer it
   * from a read-back that came up empty. The two coincide today only because
   * `getById` does not filter `deletedAt` — an inference that holds by
   * coincidence stops holding silently, and what it would produce is a warning
   * naming a second profile the reader then goes looking for and cannot find.
   */
  it('reports the refusal rather than leaving it to be inferred', () => {
    const mine = makeTask({ title: 'Mine' })
    const theirs = taskService.create(OTHER_USER, { title: 'Theirs', goal: 'Theirs, please' })

    expect(taskRepo.upsertFromSync(USER, { ...syncValues(mine.id), id: theirs.id })).toBe(false)
    expect(taskRepo.upsertFromSync(USER, syncValues(mine.id))).toBe(true)
  })

  /**
   * No transition check, deliberately — the peer is reporting what happened on
   * the device that was running the work, exactly as a pull from a bound
   * service does. `new → completed` is not in the table and `setStatus` would
   * refuse it; a device reporting it is not asking permission.
   */
  it('takes a status the transition table would refuse from a local write', () => {
    const task = makeTask()
    expect(() => taskService.setStatus(USER, task.id, 'completed')).toThrow(TaskError)

    taskService.applySyncedTask(USER, { ...syncValues(task.id), status: 'completed' })
    expect(taskService.getById(USER, task.id).status).toBe('completed')
  })

  it('removeSyncedTask hard-deletes the row and its file', () => {
    const task = makeTask({ handoffNote: 'Half done.' })
    taskService.removeSyncedTask(USER, task.id)
    expect(taskRepo.getById(USER, task.id)).toBeUndefined()
    expect(existsSync(noteFilePath(task.id))).toBe(false)
  })

  /**
   * `<userData>/tasks/` is shared by every profile on this install, and
   * `removeHandoff` is keyed on the task id alone — so a tombstone for an id
   * this profile does not own would leave the owning profile's row intact and
   * silently delete its note, which nothing reads back and nothing would ever
   * recreate.
   */
  it('removeSyncedTask leaves another profile’s task and its file alone', () => {
    const theirs = taskService.create(OTHER_USER, {
      title: 'Theirs',
      goal: 'Theirs, please',
      handoffNote: 'Their note.'
    })
    expect(existsSync(noteFilePath(theirs.id))).toBe(true)

    taskService.removeSyncedTask(USER, theirs.id)

    expect(taskRepo.getById(OTHER_USER, theirs.id)).toBeDefined()
    expect(existsSync(noteFilePath(theirs.id))).toBe(true)
  })
})
