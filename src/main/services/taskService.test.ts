import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { TaskError } from '../errors'
import type { TaskStatus } from '../../shared/taskStatus'

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
  deviceId: null as string | null
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

const USER = '__default__'
const OTHER_USER = 'someone-else'

beforeEach(() => {
  holder.current = createTestDatabase()
  // Default: a profile with sync off. Null device id means "here".
  holder.deviceId = null
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

function makeTask(overrides: Partial<Parameters<typeof taskService.create>[1]> = {}) {
  return taskService.create(USER, {
    title: 'Ship the thing',
    goal: 'Ship the thing by Friday',
    ...overrides
  })
}

/** Walk a task to a status through legal steps, so a test can start where it means to. */
function driveTo(taskId: string, ...path: TaskStatus[]) {
  for (const status of path) taskService.setStatus(USER, taskId, status)
}

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
