import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { RemoteTaskAdapter } from '../tasks/adapters/adapter'
import type { TaskDto } from '../../shared/tasks'
import { CinnaApiError, TaskError } from '../errors'

/**
 * `taskSyncService` against a real database, the real `cinnaTaskAdapter`, and a
 * fake cinna server — three of the four layers, with only the socket replaced.
 *
 * The alternative would have been a mocked adapter, and it would have asserted
 * that this service calls a mock in an order this file also chose. What is
 * actually worth pinning is the *end to end*: a task finishes locally in one
 * step, and two status requests leave for a server that would 400 on one. That
 * cannot be observed without something on the other end that refuses the way
 * cinna refuses.
 *
 * The registry is mocked rather than used, so these tests neither depend on
 * which adapters this build ships nor pollute the module-level map for whatever
 * runs next.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  deviceId: null as string | null,
  userData: '',
  adapters: [] as RemoteTaskAdapter[]
}))

vi.mock('electron', () => ({ app: { getPath: () => holder.userData } }))
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
  syncRepo: { getState: () => (holder.deviceId ? { deviceId: holder.deviceId } : null) }
}))
vi.mock('../tasks/adapters', async () => {
  const adapter = await import('../tasks/adapters/adapter')
  const nullAdapter = await import('../tasks/adapters/nullAdapter')
  return {
    ...adapter,
    allAdapters: () => holder.adapters,
    adapterFor: (id: string) =>
      holder.adapters.find((a) => a.id === id) ?? nullAdapter.createNullAdapter(id)
  }
})

const { taskSyncService } = await import('./taskSyncService')
const { taskService } = await import('./taskService')
const { taskRepo } = await import('../db/tasks')
const { taskHandoffRepo } = await import('../db/taskHandoffs')
const { createCinnaTaskAdapter } = await import('../tasks/adapters/cinnaTaskAdapter')
const { createFakeCinnaServer } = await import('../tasks/adapters/testSupport/fakeCinnaServer')
const { createFakeRemote, CAPABILITY_SHAPES } = await import(
  '../tasks/adapters/testSupport/fakeRemote'
)

type FakeCinna = ReturnType<typeof createFakeCinnaServer>

const USER = '__default__'

let cinna: FakeCinna

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.deviceId = null
  holder.userData = mkdtempSync(join(tmpdir(), 'cinna-task-sync-'))
  cinna = createFakeCinnaServer()
  holder.adapters = [createCinnaTaskAdapter(cinna.world)]
  taskSyncService.resetCursors()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
  if (holder.userData) rmSync(holder.userData, { recursive: true, force: true })
})

/** A local task that has been put on the service, exactly as step 11 will do it. */
async function bound(
  overrides: Partial<Parameters<typeof taskService.create>[1]> = {}
): Promise<string> {
  const task = taskService.create(USER, {
    title: 'Reconcile payouts',
    goal: 'Reconcile payouts for the last 7 days',
    ...overrides
  })
  const binding = await holder.adapters[0].create(USER, task, null)
  taskService.bindRemote(USER, task.id, binding)
  return task.id
}

/** A `TaskDto` that never touches the database — for seeding a fake remote. */
function sampleTask(title: string): TaskDto {
  const now = new Date()
  return {
    id: `tsk_${title.length}`,
    title,
    goal: `${title}, please`,
    description: null,
    status: 'open',
    priority: 'normal',
    router: 'direct',
    origin: 'remote',
    executor: 'remote',
    executorDevice: null,
    runsHere: false,
    chatId: null,
    assignee: { agentId: null, name: null, kind: 'remote_agent' },
    parentTaskId: null,
    subtaskCount: 0,
    subtaskCompletedCount: 0,
    remote: null,
    handoffNote: null,
    artifacts: [],
    budget: null,
    errorMessage: null,
    jobId: null,
    jobRunId: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null
  }
}

function statusCalls(): string[] {
  return cinna
    .calls()
    .filter((call) => call.path.endsWith('/status'))
    .map((call) => (call.body as { status: string }).status)
}

function dirtyOf(taskId: string): string[] {
  return taskRepo.getById(USER, taskId)?.remoteDirty ?? []
}

function remoteIdOf(taskId: string): string {
  return taskRepo.getById(USER, taskId)?.remoteId as string
}

describe('pushing the status', () => {
  /**
   * §5.12 rule 2, end to end and with a server that would refuse the shortcut.
   *
   * A desktop job that runs and finishes between two polls leaves the local
   * task at `completed` and the remote copy at `new`, and `new` to `completed`
   * is not a transition cinna allows. Sending the destination 400s on every
   * completed task, on a status code that also means "not your task".
   */
  it('sends two requests for a task that finished in one local step', async () => {
    const taskId = await bound()
    taskService.applyRunState(USER, taskId, 'completed')

    await taskSyncService.push(USER, taskId)

    expect(statusCalls()).toEqual(['in_progress', 'completed'])
    expect(cinna.task(remoteIdOf(taskId))?.status).toBe('completed')
    expect(dirtyOf(taskId)).toEqual([])
  })

  it('sends one where the service can take the step', async () => {
    const taskId = await bound()
    taskService.setStatus(USER, taskId, 'in_progress')
    await taskSyncService.push(USER, taskId)
    expect(statusCalls()).toEqual(['in_progress'])
  })

  it('carries a reason, because the status history is an audit trail', async () => {
    const taskId = await bound()
    taskService.setStatus(USER, taskId, 'in_progress')
    await taskSyncService.push(USER, taskId)
    const call = cinna.calls().find((c) => c.path.endsWith('/status'))
    expect((call?.body as { reason: string }).reason).toBeTruthy()
  })

  it('asks where the service is rather than assuming, so a change made there is not undone', async () => {
    const taskId = await bound()
    // Somebody moved it on the web while this device was not looking. The
    // remembered starting point would have been `new` and the path wrong.
    cinna.touch(remoteIdOf(taskId), { status: 'in_progress' })
    taskService.applyRunState(USER, taskId, 'completed')

    await taskSyncService.push(USER, taskId)
    expect(statusCalls()).toEqual(['completed'])
  })

  it('files a task away through the archive route, not as a status', async () => {
    const taskId = await bound()
    taskService.setStatus(USER, taskId, 'cancelled')
    await taskSyncService.push(USER, taskId)
    taskService.setStatus(USER, taskId, 'archived')
    await taskSyncService.push(USER, taskId)

    expect(cinna.calls().map((c) => c.path)).toContain(
      `/api/v1/tasks/${remoteIdOf(taskId)}/archive`
    )
    expect(statusCalls()).not.toContain('archived')
    expect(dirtyOf(taskId)).toEqual([])
  })

  it('says nothing about the status of a task the service is running', async () => {
    const taskId = await bound()
    taskService.setStatus(USER, taskId, 'in_progress')
    taskService.handOffToRemote(USER, taskId)

    await taskSyncService.push(USER, taskId)
    // §5.12 rule 4: the server recomputes the status of a task it is executing
    // from its own sessions, so a write from here is overwritten — correctly.
    expect(statusCalls()).toEqual([])
    expect(dirtyOf(taskId)).toEqual([])
  })

  it('gives up on a status the service has no way to reach, instead of retrying for ever', async () => {
    const taskId = await bound()
    taskService.setStatus(USER, taskId, 'in_progress')
    // The service finished it from its own sessions while this device was
    // still calling it in progress. On the remote's table `completed` reaches
    // only `archived`, so there is no sequence of legal steps back.
    cinna.touch(remoteIdOf(taskId), { status: 'completed' })

    await taskSyncService.push(USER, taskId)
    await taskSyncService.push(USER, taskId)

    expect(statusCalls()).toEqual([])
    // Dropped rather than queued: queueing it would be a 400 per poll for the
    // life of the app, and the local task is not wrong.
    expect(dirtyOf(taskId)).toEqual([])
  })
})

describe('pushing the fields', () => {
  it('sends only what changed', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed' })
    await taskSyncService.push(USER, taskId)

    const patch = cinna.calls().find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ title: 'Renamed' })
    expect(dirtyOf(taskId)).toEqual([])
  })

  it('posts the handoff note where the next agent reads it', async () => {
    const taskId = await bound()
    taskService.setHandoffNote(USER, taskId, 'Half done; the ledger is open.')
    await taskSyncService.push(USER, taskId)

    expect(cinna.calls().find((c) => c.path.endsWith('/comments/'))?.body).toEqual({
      content: 'Half done; the ledger is open.',
      comment_type: 'result'
    })
  })

  it('posts nothing for a note that was cleared', async () => {
    const taskId = await bound()
    taskService.setHandoffNote(USER, taskId, 'Half done.')
    await taskSyncService.push(USER, taskId)
    const before = cinna.calls().length

    taskService.setHandoffNote(USER, taskId, null)
    await taskSyncService.push(USER, taskId)
    // A comment stream is append-only; there is no unposting. Queueing an
    // empty body would be a 422 on every pass for ever.
    expect(cinna.calls().length).toBe(before)
    expect(dirtyOf(taskId)).toEqual([])
  })

  it('assigns an agent the service knows, and refuses to name one that is only here', async () => {
    const taskId = await bound()
    // `assigneeAgentId` is an id in the space `kind` names: the *remote's* id
    // for a `remote_agent`. It is not read out of the binding state, which is
    // opaque outside `tasks/adapters/` — a field the only possible writer
    // cannot read is not a field.
    taskService.setAssignee(USER, taskId, {
      agentId: 'agt-cloud-9',
      name: 'Ledger agent',
      kind: 'remote_agent'
    })
    await taskSyncService.push(USER, taskId)
    expect(cinna.task(remoteIdOf(taskId))?.selected_agent_id).toBe('agt-cloud-9')

    // A folder agent on this laptop has no counterpart there. Sending its row
    // id would either 400 or, worse, match somebody else's agent.
    taskService.setAssignee(USER, taskId, {
      agentId: 'agt_local_1',
      name: 'A folder agent',
      kind: 'agent'
    })
    await taskSyncService.push(USER, taskId)
    expect(cinna.task(remoteIdOf(taskId))?.selected_agent_id).toBeNull()
  })

  /**
   * A PATCH is refused as a unit, but the refusal is about one field.
   *
   * Dropping the whole batch's markers discards the user's other edits with
   * nothing on screen to say so — and worse, the field is then no longer dirty,
   * so the next pull overwrites the local value with the remote's.
   */
  it('does not lose a good edit because a field beside it was refused', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed' })
    // An agent id this account cannot use: `verify_agent_access` answers 400
    // with "Not enough permissions for this agent", and the PATCH carrying
    // both fields is refused whole.
    taskService.setAssignee(USER, taskId, {
      agentId: 'someone-elses-agent',
      name: 'Not mine',
      kind: 'remote_agent'
    })

    await taskSyncService.push(USER, taskId)

    expect(cinna.task(remoteIdOf(taskId))?.title).toBe('Renamed')
    expect(cinna.task(remoteIdOf(taskId))?.selected_agent_id).toBeNull()
    // Both settled: the title because it landed, the assignee because asking
    // again unchanged would fail the same way for ever.
    expect(dirtyOf(taskId)).toEqual([])
  })

  it('does not claim the service was reached by a pass that sent nothing', async () => {
    const github = createFakeRemote({ id: 'github', capabilities: CAPABILITY_SHAPES.github })
    holder.adapters = [github.adapter]
    const taskId = await bound()
    taskRepo.update(USER, taskId, { remoteSyncedAt: null })

    // GitHub Issues has no priority, so the one marker names a field with
    // nowhere to go and nothing leaves the process.
    taskService.update(USER, taskId, { priority: 'urgent' })
    await taskSyncService.push(USER, taskId)

    expect(dirtyOf(taskId)).toEqual([])
    // A timestamp that advanced here would advance for ever on a service
    // nobody can reach, which is the one reading it exists to rule out.
    expect(taskRepo.getById(USER, taskId)?.remoteSyncedAt).toBeNull()
  })

  it('drops a field the service has nowhere to put, rather than retrying it', async () => {
    const github = createFakeRemote({ id: 'github', capabilities: CAPABILITY_SHAPES.github })
    holder.adapters = [github.adapter]
    const taskId = await bound()

    taskService.update(USER, taskId, { title: 'Renamed', priority: 'urgent' })
    await taskSyncService.push(USER, taskId)

    // GitHub Issues has no priority. "This service has no such field" and
    // "this service is down" are different answers and only one is worth
    // retrying.
    expect(dirtyOf(taskId)).toEqual([])
    expect(github.stored(remoteIdOf(taskId))?.title).toBe('Renamed')
  })
})

describe('a local edit made while the push is in flight', () => {
  /**
   * Every adapter call is an `await`, so a write from the UI can land in the
   * middle of one. Two ways to get this wrong and they fail differently:
   * writing the remaining markers back wholesale erases one that was added
   * during the push, and clearing by name alone erases the marker for a field
   * the user changed *after* the old value had gone up — which is worse,
   * because the field is then no longer dirty and the next pull overwrites the
   * newer local value with the older one the remote was given.
   */
  it('is still owed afterwards, not lost under the marker the push cleared', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed' })

    // Edit again at the exact moment the patch is on the wire.
    let edited = false
    holder.adapters = [
      createCinnaTaskAdapter({
        ...cinna.world,
        request: async (userId, path, opts) => {
          if (opts?.method === 'PATCH' && !edited) {
            edited = true
            taskService.update(USER, taskId, { title: 'Renamed again' })
          }
          return cinna.world.request(userId, path, opts)
        }
      })
    ]

    await taskSyncService.push(USER, taskId)

    expect(edited).toBe(true)
    expect(cinna.task(remoteIdOf(taskId))?.title).toBe('Renamed')
    expect(dirtyOf(taskId)).toEqual(['title'])

    await taskSyncService.push(USER, taskId)
    expect(cinna.task(remoteIdOf(taskId))?.title).toBe('Renamed again')
    expect(dirtyOf(taskId)).toEqual([])
  })

  it('keeps a marker for a different field added during the push', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed' })

    holder.adapters = [
      createCinnaTaskAdapter({
        ...cinna.world,
        request: async (userId, path, opts) => {
          if (opts?.method === 'PATCH') {
            taskService.setHandoffNote(USER, taskId, 'Written mid-push.')
          }
          return cinna.world.request(userId, path, opts)
        }
      })
    ]

    await taskSyncService.push(USER, taskId)
    expect(dirtyOf(taskId)).toEqual(['handoffNote'])
  })
})

describe('when a push fails', () => {
  it('keeps what it could not send, and sends it on the next pass', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed' })

    cinna.behave('transport')
    await taskSyncService.push(USER, taskId)
    // The local write already happened and must not be undone by a network
    // that was not there.
    expect(dirtyOf(taskId)).toEqual(['title'])
    expect(taskRepo.getById(USER, taskId)?.title).toBe('Renamed')

    cinna.behave(null)
    await taskSyncService.push(USER, taskId)
    expect(dirtyOf(taskId)).toEqual([])
    expect(cinna.task(remoteIdOf(taskId))?.title).toBe('Renamed')
  })

  it('keeps the binding when a write is refused, and stops asking', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed' })

    cinna.behave('rejected')
    await taskSyncService.push(USER, taskId)

    // `rejected` and `not_ours` are both 400 on cinna-core. Getting this wrong
    // would unbind a task whose only problem was a field the server refused.
    expect(taskRepo.getById(USER, taskId)?.remoteAdapter).toBe('cinna')
    expect(dirtyOf(taskId)).toEqual([])
  })

  it('unbinds when the service says the task is not this account’s', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed' })

    cinna.behave('not_ours')
    await taskSyncService.push(USER, taskId)

    const row = taskRepo.getById(USER, taskId)
    expect(row?.remoteAdapter).toBeNull()
    expect(row?.remoteId).toBeNull()
    // Everything the user can see survives; what goes is the claim that a copy
    // exists somewhere else, which had stopped being true.
    expect(row?.title).toBe('Renamed')
  })

  it('does nothing at all for an unlinked profile, and forgets nothing', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed' })

    holder.adapters = [createCinnaTaskAdapter(createFakeCinnaServer({ ready: false }).world)]
    await taskSyncService.push(USER, taskId)
    expect(dirtyOf(taskId)).toEqual(['title'])
  })
})

describe('pushing every task that owes something', () => {
  it('does not let one failing task cancel the rest of the pass', async () => {
    const first = await bound()
    const second = await bound({ title: 'The other one' })
    taskService.update(USER, first, { title: 'Renamed' })
    taskService.update(USER, second, { title: 'Also renamed' })

    // The user deletes the first task while its patch is on the wire, and the
    // service answers that the task is not this account's — so the push tries
    // to unbind a task that is no longer there and throws. Without per-task
    // isolation that silently skips every task after it in the list.
    holder.adapters = [
      createCinnaTaskAdapter({
        ...cinna.world,
        request: async (userId, path, opts) => {
          if (opts?.method === 'PATCH' && path.includes(remoteIdOf(first))) {
            taskService.remove(USER, first)
            throw new CinnaApiError(
              'request_failed',
              'Cinna API 400: Not enough permissions',
              'Not enough permissions',
              400
            )
          }
          return cinna.world.request(userId, path, opts)
        }
      })
    ]

    await taskSyncService.pushAll(USER)

    expect(taskService.getById(USER, second).title).toBe('Also renamed')
    expect(dirtyOf(second)).toEqual([])
  })
})

describe('bookkeeping that must not look like a change', () => {
  it('does not float a task to the top of the list because a push succeeded', async () => {
    const taskId = await bound()
    // A distinct time in the past: created and cleared in the same millisecond
    // would make this pass whether or not the column is preserved, which is how
    // the first version of this test failed to catch anything.
    const before = new Date('2026-09-01T09:00:00.000Z')
    taskRepo.update(USER, taskId, { updatedAt: before })
    taskService.markRemoteSynced(USER, taskId, [], { contacted: true })

    // `taskRepo.list` orders by `updatedAt`, so stamping it here would reorder
    // the user's list every time a marker cleared — and would make the mirror
    // look newer than the thing it mirrors, which is the conflict rule
    // `applyRemoteSnapshot` is careful to avoid.
    expect(taskService.getById(USER, taskId).updatedAt.getTime()).toBe(before.getTime())
  })

  it('sends the whole path but does not describe a catch-up as two events', async () => {
    const taskId = await bound()
    taskService.applyRunState(USER, taskId, 'completed')
    await taskSyncService.push(USER, taskId)

    // Each step writes a history row and posts a comment on the web. The same
    // sentence twice would read as two things happening, rather than as one
    // thing reported late.
    const reasons = cinna
      .calls()
      .filter((c) => c.path.endsWith('/status'))
      .map((c) => (c.body as { reason: string }).reason)
    expect(reasons).toHaveLength(2)
    expect(reasons[0]).toContain('catching up')
    expect(reasons[1]).not.toContain('catching up')
  })
})

describe('two pushes for one task', () => {
  /**
   * The one failure the "clear only if the value has not moved" rule cannot
   * catch, because the conflict is manufactured by this process rather than by
   * the user.
   *
   * Two passes interleave at every `await`. Pass B's `fetch` predates pass A's
   * writes, so B computes the path `in_progress → completed` for a remote A has
   * already moved to `completed` — and `completed` reaches only `archived`, so
   * B's first step is a 400. That reads as `rejected`, which **drops a status
   * marker that was legitimately owed**. The local value is innocent, so no
   * amount of comparing it helps.
   */
  it('do not race each other into a refusal', async () => {
    const taskId = await bound()
    taskService.applyRunState(USER, taskId, 'completed')

    await Promise.all([taskSyncService.push(USER, taskId), taskSyncService.push(USER, taskId)])

    expect(cinna.task(remoteIdOf(taskId))?.status).toBe('completed')
    expect(dirtyOf(taskId)).toEqual([])
    // Exactly the path, once. A second pass that started from stale state would
    // have sent `in_progress` again and been refused — and the web feed would
    // show the same transition twice, because every step writes a history row
    // and posts a comment.
    expect(statusCalls()).toEqual(['in_progress', 'completed'])
  })

  it('still run one after the other, rather than the second being dropped', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed' })

    const first = taskSyncService.push(USER, taskId)
    taskService.setHandoffNote(USER, taskId, 'Written between the two.')
    const second = taskSyncService.push(USER, taskId)
    await Promise.all([first, second])

    // A caller that asked for a push wants one; the second starting from the
    // first's finished state is exactly right.
    expect(dirtyOf(taskId)).toEqual([])
    expect(cinna.task(remoteIdOf(taskId))?.comments.map((c) => c.content)).toContain(
      'Written between the two.'
    )
  })
})

describe('pulling what changed there', () => {
  it('brings in a task nobody here has seen', async () => {
    const remote = cinna.seed({
      title: 'Raised on the web',
      original_message: 'Look at the payouts',
      status: 'in_progress',
      priority: 'urgent'
    })

    await taskSyncService.pull(USER)

    const [task] = taskService.list(USER)
    expect(task.title).toBe('Raised on the web')
    // The goal is the reason the snapshot carries one: `taskRepo.create`
    // requires it and `TaskPatch` refuses to update it, so an invented goal
    // could never be corrected.
    expect(task.goal).toBe('Look at the payouts')
    expect(task.status).toBe('in_progress')
    expect(task.origin).toBe('remote')
    expect(task.executor).toBe('remote')
    expect(task.remote?.adapter).toBe('cinna')
    expect(task.remote?.id).toBe(remote.id)
  })

  it('keeps the remote’s id for the agent holding it, so the replica can be reassigned', async () => {
    cinna.seed({ title: 'Raised on the web', selected_agent_id: 'agt-cloud-9', agent_name: 'Ledger' })
    await taskSyncService.pull(USER)

    const [task] = taskService.list(USER)
    // The pull is the *only* place a remote agent's id ever arrives. Dropping
    // it leaves a replica that can never push an assignee at all.
    expect(task.assignee).toEqual({ agentId: 'agt-cloud-9', name: 'Ledger', kind: 'remote_agent' })

    // And it survives the *update* path too, which is a second mapping and was
    // the one that dropped it: a replica is created once and refreshed for ever.
    cinna.touch(task.remote?.id as string, { title: 'Renamed on the web' })
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id).assignee.agentId).toBe('agt-cloud-9')
  })

  it('updates in place on the next pass rather than making a second copy', async () => {
    const remote = cinna.seed({ title: 'Raised on the web' })
    await taskSyncService.pull(USER)
    cinna.touch(remote.id, { title: 'Renamed on the web' })
    await taskSyncService.pull(USER)

    const tasks = taskService.list(USER)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('Renamed on the web')
  })

  it('asks for only what changed once it has a cursor', async () => {
    cinna.seed({ title: 'Raised on the web' })
    await taskSyncService.pull(USER)
    await taskSyncService.pull(USER)

    const lists = cinna.calls().filter((c) => c.path.startsWith('/api/v1/tasks/?'))
    expect(lists[0].path).toContain('status=active')
    expect(lists.at(-1)?.path).toContain('updated_since=')
  })

  it('does not overwrite a field this device still owes the service', async () => {
    const taskId = await bound()
    taskService.update(USER, taskId, { title: 'Renamed here' })
    cinna.touch(remoteIdOf(taskId), { title: 'Renamed there' })

    await taskSyncService.pull(USER)
    // The marker means "we know something it does not". Taking the remote's
    // value now would throw the user's change away moments before sending it.
    expect(taskService.getById(USER, taskId).title).toBe('Renamed here')
  })

  it('does not resurrect a task the user deleted here', async () => {
    const remote = cinna.seed({ title: 'Raised on the web' })
    await taskSyncService.pull(USER)
    const [task] = taskService.list(USER)
    taskService.remove(USER, task.id)

    cinna.touch(remote.id, { title: 'Poked on the web' })
    await taskSyncService.pull(USER)

    expect(taskService.list(USER)).toEqual([])
    // And it did not make a second one either, which is what a lookup that
    // skipped soft-deleted rows would have done.
    expect(taskRepo.getByRemote(USER, 'cinna', remote.id)?.deletedAt).toBeInstanceOf(Date)
  })

  /**
   * The pull sees the child **before** the parent, and has to cope.
   *
   * An uncursored `GET /tasks/` orders `created_at DESC` — newest first — and a
   * subtask is younger than the task it hangs off. Resolving the parent by
   * looking it up locally therefore finds nothing on the first pass, and a
   * single-pass upsert leaves every pulled subtask at top level, reading as
   * unrelated work nobody asked for. It does not heal either: the next pull is
   * a delta and the child is only in it if it changed on the server.
   */
  it('hangs a subtask off its parent even though it arrives first', async () => {
    const parent = cinna.seed({ title: 'The parent' })
    const child = cinna.seed({ title: 'The child', parent_task_id: parent.id })
    cinna.seed({ title: 'The grandchild', parent_task_id: child.id })

    await taskSyncService.pull(USER)

    // The order really is the hostile one, so this test cannot pass by accident
    // on a fake that hands rows back oldest-first.
    const listed = await holder.adapters[0].list(USER, null)
    expect(listed.map((s) => s.title)).toEqual(['The grandchild', 'The child', 'The parent'])

    const byTitle = new Map(taskService.list(USER).map((t) => [t.title, t]))
    expect(byTitle.get('The child')?.parentTaskId).toBe(byTitle.get('The parent')?.id)
    // And still one level: a deeper tree is shown flat with a depth badge
    // rather than pretended to nest. Depth is decided from the batch, because
    // mid-pass the child's own link has not been written and it still looks
    // like a root.
    expect(byTitle.get('The grandchild')?.parentTaskId).toBeNull()
  })

  it('lets one unreachable service fail without stopping another', async () => {
    const other = createFakeRemote({ id: 'linear', capabilities: CAPABILITY_SHAPES.linear })
    other.seed(sampleTask('Raised in Linear'))
    holder.adapters = [createCinnaTaskAdapter(cinna.world), other.adapter]
    cinna.seed({ title: 'Raised on the web' })
    cinna.behave('transport')

    await taskSyncService.pull(USER)
    // The cinna half failed; the Linear half still ran. One unreachable
    // service must not take the others down with it.
    const pulled = taskService.list(USER)
    expect(pulled.map((t) => t.remote?.adapter)).toEqual(['linear'])
  })

  it('does not re-write the same row on every quiet poll', async () => {
    const remote = cinna.seed({ title: 'Raised on the web' })
    await taskSyncService.pull(USER)
    const taskId = taskRepo.getByRemote(USER, 'cinna', remote.id)?.id as string

    // A distinct marker for "this row was written". `applyRemoteSnapshot`
    // stamps `remoteSyncedAt`, so a quiet pass that touches nothing leaves it
    // exactly where it was.
    // Only `remoteSyncedAt` — `updatedAt` has to stay as the pull left it,
    // because "the remote's modification time matches what we stored" is
    // exactly the comparison under test.
    const untouched = new Date('2026-09-01T09:00:00.000Z')
    const pulledAt = taskRepo.getById(USER, taskId)?.updatedAt as Date
    taskRepo.update(USER, taskId, { remoteSyncedAt: untouched, updatedAt: pulledAt })

    await taskSyncService.pull(USER)
    await taskSyncService.pull(USER)

    // The cost of rewinding on a pull that found nothing is not a request —
    // the list goes out either way. It is that the newest row keeps falling
    // inside the window and is upserted for ever, and an upsert ends in
    // `written(row)`: a filesystem write, on a timer, in the steady state.
    expect(taskRepo.getById(USER, taskId)?.remoteSyncedAt?.getTime()).toBe(untouched.getTime())
  })

  it('leaves the cursor where it was when a pull fails, so nothing is skipped', async () => {
    cinna.seed({ title: 'Raised on the web' })
    cinna.behave('transport')
    await taskSyncService.pull(USER)
    cinna.behave(null)
    await taskSyncService.pull(USER)

    expect(taskService.list(USER)).toHaveLength(1)
  })
})

describe('history the first pull brings in', () => {
  /**
   * The real adapter over the fake server, with one request intercepted. The
   * interceptor sees every path and may throw, or mutate the far side before
   * letting the call through — which is how "the service changed between the
   * two list requests" becomes reachable at all.
   */
  function interceptWith(hook: (path: string) => void): void {
    holder.adapters = [
      createCinnaTaskAdapter({
        ...cinna.world,
        request: async (userId, path, opts) => {
          hook(path)
          return cinna.world.request(userId, path, opts)
        }
      })
    ]
  }

  it('keeps the active set when the history request fails', async () => {
    cinna.seed({ title: 'Live', status: 'in_progress' })
    interceptWith((path) => {
      if (path.includes('updated_since=')) throw new Error('gateway timeout')
    })

    await taskSyncService.pull(USER)

    // The active set was already in hand when the history call failed. Losing
    // it would leave the pass count at zero as well, so every later pass would
    // repeat both requests and fail identically — a profile that syncs nothing
    // at all, while its primary request works perfectly.
    expect(taskService.list(USER).map((t) => t.title)).toEqual(['Live'])
  })

  it('counts a pass whose history failed, so the next one is a delta', async () => {
    cinna.seed({ title: 'Live', status: 'in_progress' })
    interceptWith((path) => {
      if (path.includes('updated_since=')) throw new Error('gateway timeout')
    })
    await taskSyncService.pull(USER)

    const mark = cinna.calls().length
    await taskSyncService.pull(USER)

    expect(
      cinna.calls().slice(mark).some((c) => c.path.includes('status=active'))
    ).toBe(false)
  })

  it('takes the later copy of a task that changed between the two requests', async () => {
    const task = cinna.seed({ title: 'Before', status: 'in_progress' })
    // Two sequential round trips, not one instant. The active set is fetched
    // first, so its copy is the stale one; keeping it would record a task that
    // finished mid-pass as still running.
    interceptWith((path) => {
      if (path.includes('updated_since=')) cinna.touch(task.id, { title: 'After' })
    })

    await taskSyncService.pull(USER)

    expect(taskService.list(USER).map((t) => t.title)).toEqual(['After'])
  })

  it('keeps the cursor it earned when the periodic reconcile throws', async () => {
    // The reconcile runs after every upsert is already written, and on a
    // periodic pass it makes its own uncursored `list` — outside the per-task
    // catch inside `dropMissing`, so a failure there propagates out of the
    // pass. With the cursor written after it, that throw discarded a cursor the
    // pull had legitimately earned, and every later pass re-read the same rows.
    // An hour of daylight between the two cursor positions, so the assertion
    // is about which one was kept rather than about milliseconds.
    const first = cinna.seed({ title: 'Live', status: 'in_progress' })
    cinna.touch(first.id, { updated_at: new Date(Date.now() - 60 * 60 * 1000) })
    await taskSyncService.pull(USER)

    // Up to the pass before the periodic reconcile (every 20th).
    for (let i = 0; i < 18; i++) await taskSyncService.pull(USER)

    const renamedAt = new Date()
    cinna.touch(first.id, { title: 'Renamed', updated_at: renamedAt })
    interceptWith((path) => {
      if (path.includes('status=active')) throw new Error('reconcile list failed')
    })
    await taskSyncService.pull(USER)
    expect(taskService.list(USER).map((t) => t.title)).toEqual(['Renamed'])

    // The rename was upserted *before* the reconcile ran, so the cursor that
    // covers it was earned and must survive the reconcile's failure. The next
    // pass asking from an hour ago is the symptom of losing it: every row in
    // between is read again on every poll, for ever.
    const mark = cinna.calls().length
    await taskSyncService.pull(USER)
    const delta = cinna.calls().slice(mark).find((c) => c.path.includes('updated_since='))
    const asked = new Date(decodeURIComponent(/updated_since=([^&]+)/.exec(delta?.path ?? '')?.[1] ?? ''))
    expect(asked.getTime()).toBeGreaterThan(renamedAt.getTime() - 5_000)
  })

  it('finds a task that had already finished, which the active set omits', async () => {
    // Finished before this profile ever pulled. `status=active` excludes it, so
    // without the first-pass window there is no route by which it arrives: the
    // first pass filters it out and every later pass is a delta.
    const done = cinna.seed({ title: 'Finished before we linked', status: 'completed' })
    cinna.touch(done.id, { updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })

    await taskSyncService.pull(USER)

    const [task] = taskService.list(USER)
    expect(task?.title).toBe('Finished before we linked')
    expect(task?.status).toBe('completed')
  })

  it('stops at the window, so linking does not drag in a year of history', async () => {
    const ancient = cinna.seed({ title: 'Finished last spring', status: 'completed' })
    cinna.touch(ancient.id, { updated_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) })

    await taskSyncService.pull(USER)

    expect(taskService.list(USER)).toEqual([])
  })

  it('does not ask for history again on later passes', async () => {
    cinna.seed({ title: 'Live' })
    await taskSyncService.pull(USER)
    const afterFirst = cinna.calls().length

    await taskSyncService.pull(USER)

    // One request, not two: the window is a cost paid per app start.
    expect(cinna.calls().length - afterFirst).toBe(1)
  })

  it('writes a task in both lists only once', async () => {
    // Active *and* touched inside the window — in both responses, and an upsert
    // of the same task twice in one pass is a wasted write and a duplicate in
    // the parent-resolution batch.
    cinna.seed({ title: 'Live and recently touched', status: 'in_progress' })

    await taskSyncService.pull(USER)

    expect(taskService.list(USER).map((t) => t.title)).toEqual(['Live and recently touched'])
  })
})

describe('forgetting what a profile held for a previous account', () => {
  it('unbinds every task and keeps all of them', async () => {
    // A mirror: created here, also put on the service.
    const mine = await bound({ title: 'Mine' })
    // A replica that has finished. This is the set the reconcile can never
    // clean up — it skips mirrors by design, and skips terminal replicas as a
    // per-poll cost it refuses to pay.
    const done = cinna.seed({ title: 'Theirs, finished', status: 'completed' })
    cinna.touch(done.id, { updated_at: new Date(Date.now() - 60 * 60 * 1000) })
    await taskSyncService.pull(USER)
    expect(taskService.list(USER)).toHaveLength(2)

    taskSyncService.forgetBindings(USER)

    // Nothing destroyed — a replica degrades to an ordinary local task, which
    // is an honest record of work that really happened.
    const after = taskService.list(USER)
    expect(after).toHaveLength(2)
    expect(after.map((t) => t.title).sort()).toEqual(['Mine', 'Theirs, finished'])
    // ...and no task still points at the previous account.
    expect(after.every((t) => t.remote === null || t.remote === undefined)).toBe(true)
    expect(taskRepo.getById(USER, mine)?.remoteId).toBeNull()
    expect(taskRepo.getById(USER, mine)?.remoteDirty).toBeNull()
  })

  it('forgets the cursors too, so the next pull is a first pass', async () => {
    cinna.seed({ title: 'Live' })
    await taskSyncService.pull(USER)

    taskSyncService.forgetBindings(USER)

    const mark = cinna.calls().length
    await taskSyncService.pull(USER)
    expect(
      cinna.calls().slice(mark).some((c) => c.path.includes('status=active'))
    ).toBe(true)
  })
})

describe('forgetting a profile’s cursors', () => {
  /**
   * Did the pass that just ran ask for the uncursored active set? That request
   * is made on a first pass and on no other, so it is the observable for "this
   * profile's cursor was forgotten".
   */
  function askedForActiveSet(from: number): boolean {
    return cinna
      .calls()
      .slice(from)
      .some((c) => c.method === 'GET' && c.path.includes('status=active'))
  }

  it('makes the next pull a first pass again, and only for the profile named', async () => {
    cinna.seed({ title: 'Raised on the web' })

    let mark = cinna.calls().length
    await taskSyncService.pull(USER)
    expect(askedForActiveSet(mark)).toBe(true)

    // With a cursor, a pass is a delta — which is the whole point of the
    // cursor, and the thing that goes wrong when it outlives its account.
    mark = cinna.calls().length
    await taskSyncService.pull(USER)
    expect(askedForActiveSet(mark)).toBe(false)

    // Another profile's reset must not touch this one. The map is keyed
    // `<profile> <adapter>`, so this is the assertion that a prefix match
    // cannot be a substring match.
    taskSyncService.resetCursors('some-other-profile')
    mark = cinna.calls().length
    await taskSyncService.pull(USER)
    expect(askedForActiveSet(mark)).toBe(false)

    // The re-link case: the profile keeps its id and gets a different account.
    taskSyncService.resetCursors(USER)
    mark = cinna.calls().length
    await taskSyncService.pull(USER)
    expect(askedForActiveSet(mark)).toBe(true)
  })

  it('brings in a task older than the cursor, which is what the re-link needs', async () => {
    // The account the profile had.
    const old = cinna.seed({ title: 'From the old account' })
    await taskSyncService.pull(USER)
    expect(taskService.list(USER).map((t) => t.title)).toEqual(['From the old account'])

    // `registerCinna`'s rebind: same profile row, same id, a different account
    // behind it. Its tasks are older than the cursor this profile is still
    // carrying, so a delta can never mention them.
    for (const task of taskService.list(USER)) taskService.remove(USER, task.id)
    cinna.forget(old.id)
    const fresh = cinna.seed({ title: 'From the new account' })
    cinna.touch(fresh.id, { updated_at: new Date(Date.now() - 60 * 60 * 1000) })

    await taskSyncService.pull(USER)
    expect(taskService.list(USER)).toEqual([])

    taskSyncService.resetCursors(USER)
    await taskSyncService.pull(USER)
    expect(taskService.list(USER).map((t) => t.title)).toEqual(['From the new account'])
  })
})

describe('pulling one task', () => {
  it('takes the service’s view of it', async () => {
    const taskId = await bound()
    cinna.touch(remoteIdOf(taskId), { title: 'Renamed there', status: 'blocked' })

    const next = await taskSyncService.pullOne(USER, taskId)
    expect(next?.title).toBe('Renamed there')
    expect(next?.status).toBe('blocked')
  })

  it('unbinds when the task is gone, and keeps the local one', async () => {
    const taskId = await bound()
    cinna.behave('not_ours')

    expect(await taskSyncService.pullOne(USER, taskId)).toBeNull()
    expect(taskRepo.getById(USER, taskId)?.remoteAdapter).toBeNull()
    expect(taskService.getById(USER, taskId).title).toBe('Reconcile payouts')
  })

  it('keeps the binding through a network failure', async () => {
    const taskId = await bound()
    cinna.behave('transport')

    expect(await taskSyncService.pullOne(USER, taskId)).toBeNull()
    expect(taskRepo.getById(USER, taskId)?.remoteAdapter).toBe('cinna')
  })
})

describe('what is waiting on the user', () => {
  it('says whether anything is waiting, and does not hand out a number', async () => {
    const taskId = await bound()
    expect(await taskSyncService.remoteWork(USER)).toEqual({ waiting: false, complete: true })

    cinna.plantAsk(remoteIdOf(taskId))
    cinna.plantAsk(remoteIdOf(taskId))
    // Two asks, and still a boolean. cinna's number is profile-wide, raises two
    // activity rows per ask, and is cleared only by its own web UI — so for a
    // user who lives here it can never reach zero however much work they do,
    // and a badge that cannot be cleared by doing the work teaches its user to
    // ignore the badge.
    expect(await taskSyncService.remoteWork(USER)).toEqual({ waiting: true, complete: true })
  })

  it('says so when a service could not be asked, rather than saying nothing is waiting', async () => {
    cinna.behave('transport')
    // A failed read is not an empty inbox. A caller that renders `waiting`
    // without looking at this tells the user nothing is waiting when the truth
    // is that nobody knows.
    expect(await taskSyncService.remoteWork(USER)).toEqual({ waiting: false, complete: false })
  })
})

describe('moving the work across the seam (§5.10)', () => {
  describe('handing a task to a service', () => {
    it('creates it, executes it, and only then says the service is running it', async () => {
      const task = taskService.create(USER, {
        title: 'Reconcile payouts',
        goal: 'Reconcile payouts for the last 7 days',
        assigneeAgentId: 'agent-on-the-service',
        assigneeKind: 'remote_agent'
      })

      const handed = await taskSyncService.handOff(USER, task.id)

      expect(handed.executor).toBe('remote')
      expect(handed.remote?.adapter).toBe('cinna')
      const remote = cinna.task(handed.remote!.id)
      // The desktop's own id, so a create retried after a lost response returns
      // the first task rather than making a second one.
      expect(remote?.external_ref).toBe(task.id)
      expect(remote?.selected_agent_id).toBe('agent-on-the-service')
      expect(cinna.calls().some((c) => c.path.endsWith('/execute'))).toBe(true)
    })

    it('blocks a repeated start and outgoing status after losing execute acknowledgement, including restart', async () => {
      const remote = createFakeRemote()
      holder.adapters = [remote.adapter]
      const task = taskService.create(USER, { title: 'Lost ack', goal: 'Only run once' })
      const execute = remote.adapter.execute.bind(remote.adapter)
      const spy = vi.spyOn(remote.adapter, 'execute').mockImplementationOnce(async (...args) => {
        await execute(...args)
        throw new Error('Connection closed after accepting work')
      })
      await expect(taskSyncService.handOff(USER, task.id)).rejects.toMatchObject({ code: 'handoff_uncertain' })
      const binding = taskService.getById(USER, task.id).remote!
      expect(remote.stored(binding.id)?.executed).toBe(true)
      expect(taskHandoffRepo.get(USER, task.id)?.state).toBe('uncertain')
      taskSyncService.resetCursors()
      taskService.setStatus(USER, task.id, 'cancelled')
      const before = remote.requests()
      await taskSyncService.push(USER, task.id)
      expect(remote.requests()).toBe(before)
      expect(remote.stored(binding.id)?.status).toBe('in_progress')
      await expect(taskSyncService.handOff(USER, task.id)).rejects.toThrow()
      expect(spy).toHaveBeenCalledTimes(1)
      await expect(taskSyncService.takeOver(USER, task.id, { force: true })).rejects.toMatchObject({ code: 'remote_busy' })
      spy.mockRestore()
    })

    it('keeps accepted work blocked when committing the local executor fails', async () => {
      const task = taskService.create(USER, { title: 'Accepted', goal: 'Only run once' })
      const spy = vi.spyOn(taskService, 'handOffToRemote').mockImplementationOnce(() => { throw new Error('Write failed') })
      await expect(taskSyncService.handOff(USER, task.id)).rejects.toMatchObject({ code: 'handed_over' })
      spy.mockRestore()
      expect(taskHandoffRepo.get(USER, task.id)?.state).toBe('accepted_pending')
      taskSyncService.resetCursors()
      await expect(taskSyncService.handOff(USER, task.id)).rejects.toMatchObject({ code: 'handoff_uncertain' })
      expect(cinna.calls().filter((call) => call.path.endsWith('/execute'))).toHaveLength(1)
    })

    it('does not discover a duplicate after a lost create acknowledgement', async () => {
      const task = taskService.create(USER, { title: 'One original', goal: 'Keep one identity' })
      const adapter = holder.adapters[0]
      const create = adapter.create.bind(adapter)
      const spy = vi.spyOn(adapter, 'create').mockImplementationOnce(async (...args) => {
        await create(...args)
        throw new Error('Lost create acknowledgement')
      })
      await expect(taskSyncService.handOff(USER, task.id)).rejects.toMatchObject({ code: 'handoff_uncertain' })
      taskSyncService.resetCursors()
      await taskSyncService.pull(USER)
      expect(taskService.list(USER).map((row) => row.id)).toEqual([task.id])
      expect(taskHandoffRepo.get(USER, task.id)).toMatchObject({ state: 'uncertain', bindingPending: true })
      spy.mockRestore()
    })

    it('resolves a deleted task receipt without recreating the task, after remote work stops', async () => {
      const remote = createFakeRemote()
      holder.adapters = [remote.adapter]
      const task = taskService.create(USER, { title: 'Deleted', goal: 'Do once' })
      const execute = remote.adapter.execute.bind(remote.adapter)
      const spy = vi.spyOn(remote.adapter, 'execute').mockImplementationOnce(async (...args) => {
        const binding = await execute(...args)
        taskService.remove(USER, task.id)
        return binding
      })
      await expect(taskSyncService.handOff(USER, task.id)).rejects.toMatchObject({ code: 'handed_over' })
      const receipt = taskSyncService.handoffReceipt(USER, task.id)!
      expect(receipt.state).toBe('accepted_pending')
      expect(taskSyncService.handoffReceipt('another-user', task.id)).toBeNull()
      await expect(taskSyncService.resolveHandoff(USER, task.id)).rejects.toMatchObject({ code: 'remote_busy' })
      remote.touch(receipt.remote!.id, { executed: false })
      await taskSyncService.resolveHandoff(USER, task.id)
      expect(taskHandoffRepo.unresolved(USER, task.id)).toBe(false)
      expect(() => taskService.getById(USER, task.id)).toThrow()
      spy.mockRestore()
    })

    it('joins identical handoffs and refuses a competing assignment while creation is pending', async () => {
      const adapter = holder.adapters[0]
      const create = adapter.create.bind(adapter)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let arrived!: () => void
      const entered = new Promise<void>((resolve) => { arrived = resolve })
      const spy = vi.spyOn(adapter, 'create').mockImplementationOnce(async (...args) => {
        const binding = await create(...args)
        arrived()
        await gate
        return binding
      })
      const task = taskService.create(USER, { title: 'Joined', goal: 'One execution' })
      const first = taskSyncService.handOff(USER, task.id)
      await entered
      const second = taskSyncService.handOff(USER, task.id)
      await expect(taskSyncService.handOff(USER, task.id, { adapterId: adapter.id, ref: 'different' })).rejects.toMatchObject({ code: 'invalid_input' })
      await taskSyncService.pull(USER)
      expect(taskService.list(USER)).toHaveLength(1)
      release()
      const results = await Promise.all([first, second])
      expect(results[0].remote?.id).toBe(results[1].remote?.id)
      expect(cinna.calls().filter((call) => call.path.endsWith('/execute'))).toHaveLength(1)
      spy.mockRestore()
    })

    it('does not let an older recovery dismiss a replacement uncertain receipt', async () => {
      const taskId = await bound()
      const receipt = { taskId, chatId: null, state: 'uncertain' as const, adapterId: 'cinna', bindingPending: false,
        remote: taskService.getById(USER, taskId).remote!, assignee: { ref: 'agent', name: 'Agent' }, message: 'First attempt', updatedAt: 1 }
      taskHandoffRepo.put(USER, receipt)
      let release!: (value: boolean) => void
      const gate = new Promise<boolean>((resolve) => { release = resolve })
      const probe = vi.spyOn(holder.adapters[0], 'liveSession').mockReturnValueOnce(gate)
      const oldRecovery = taskSyncService.takeOver(USER, taskId, { force: true })
      taskHandoffRepo.put(USER, { ...receipt, message: 'New uncertain attempt', updatedAt: 2 })
      release(false)
      await expect(oldRecovery).rejects.toMatchObject({ code: 'invalid_input' })
      expect(taskHandoffRepo.get(USER, taskId)).toMatchObject({ state: 'uncertain', updatedAt: 2 })
      probe.mockRestore()
    })

    it.each(['create', 'execute'] as const)('does not recreate an account receipt after a delayed %s result', async (operation) => {
      const { userRepo } = await import('../db/users')
      const task = taskService.create(USER, { title: 'Account removed', goal: 'Keep erased data erased' })
      const adapter = holder.adapters[0]
      const original = adapter[operation].bind(adapter)
      const spy = vi.spyOn(adapter, operation).mockImplementationOnce(async (...args) => {
        const result = await Reflect.apply(original, adapter, args)
        userRepo.deleteWithCascade(USER)
        return result
      })
      await expect(taskSyncService.handOff(USER, task.id)).rejects.toThrow()
      expect(taskHandoffRepo.get(USER, task.id)).toBeNull()
      expect(taskRepo.getById(USER, task.id)).toBeUndefined()
      spy.mockRestore()
    })

    it('keeps a parent refresh from importing a child whose create acknowledgement is pending', async () => {
      const remote = createFakeRemote()
      holder.adapters = [remote.adapter]
      const parent = taskService.create(USER, { title: 'Parent', goal: 'Parent goal' })
      taskService.bindRemote(USER, parent.id, remote.seed(parent))
      const child = taskService.create(USER, { title: 'Child', goal: 'Child goal', parentTaskId: parent.id })
      const create = remote.adapter.create.bind(remote.adapter)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let arrived!: () => void
      const entered = new Promise<void>((resolve) => { arrived = resolve })
      const spy = vi.spyOn(remote.adapter, 'create').mockImplementationOnce(async (...args) => {
        const binding = await create(...args)
        arrived()
        await gate
        return binding
      })
      const handoff = taskSyncService.handOff(USER, child.id)
      await entered
      await expect(taskSyncService.listChildren(USER, parent.id)).rejects.toMatchObject({ code: 'handoff_uncertain' })
      expect(taskService.list(USER, { parentTaskId: parent.id }).map((row) => row.id)).toEqual([child.id])
      release()
      await handoff
      const refreshed = await taskSyncService.listChildren(USER, parent.id)
      expect(refreshed.map((row) => row.id)).toEqual([child.id])
      spy.mockRestore()
    })

    it.each(['completed', 'error', 'cancelled'] as const)('projects remote %s onto the original active local job attempt', async (status) => {
      const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
      const { chatRepo } = await import('../db/chats')
      const job = jobsRepo.create(USER, { type: 'local', title: 'Original job', prompt: 'Finish remotely' })
      const chat = chatRepo.create(USER)
      const task = taskService.create(USER, { title: job.title, goal: job.prompt, chatId: chat.id, jobId: job.id })
      const run = jobRunsRepo.create({ userId: USER, jobId: job.id, type: 'local', localChatId: chat.id,
        taskId: task.id, status: 'running' })
      taskService.linkJobRun(USER, task.id, run.id)
      const handed = await taskSyncService.handOff(USER, task.id)
      cinna.touch(handed.remote!.id, { status, error_message: status === 'error' ? 'Remote failed' : null })
      await taskSyncService.pullOne(USER, task.id)
      const expected = status === 'completed' ? 'succeeded' : status === 'error' ? 'failed' : 'cancelled'
      expect(jobRunsRepo.listByJob(USER, job.id)[0]).toMatchObject({ status: expected })
      expect(jobRunsRepo.countInProgressByJob(USER).get(job.id) ?? 0).toBe(0)
      expect(jobRunsRepo.getById(USER, run.id)?.finishedAt).not.toBeNull()
      if (status === 'error') expect(jobRunsRepo.getById(USER, run.id)?.errorMessage).toBe('Remote failed')
    })

    it.each(['terminal', 'different-chat', 'deleted-chat'] as const)('does not rewrite %s job provenance from remote pulls', async (history) => {
      const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
      const { chatRepo } = await import('../db/chats')
      const job = jobsRepo.create(USER, { type: 'local', title: 'History', prompt: 'Original attempt' })
      const chat = chatRepo.create(USER)
      const currentChat = history !== 'terminal' ? chatRepo.create(USER) : chat
      const task = taskService.create(USER, { title: job.title, goal: job.prompt, chatId: currentChat.id, jobId: job.id })
      const status = history === 'terminal' ? 'failed' : 'running'
      const run = jobRunsRepo.create({ userId: USER, jobId: job.id, type: 'local', localChatId: history === 'deleted-chat' ? null : chat.id, taskId: task.id, status })
      taskService.linkJobRun(USER, task.id, run.id)
      const handed = await taskSyncService.handOff(USER, task.id)
      cinna.touch(handed.remote!.id, { status: 'completed' })
      await taskSyncService.pullOne(USER, task.id)
      expect(jobRunsRepo.getById(USER, run.id)?.status).toBe(status)
    })

    it('leaves the task on this device when the service will not start it', async () => {
      // **The ordering that matters.** `executor` is what the push reads to
      // decide whether this device may still write the status, and what the
      // page reads to decide whether to offer a re-run. Flipped before a failed
      // execute, the task would be marked as running on a service that never
      // picked it up: no agent there, no controls here.
      cinna.refuseExecute()
      const task = taskService.create(USER, { title: 'Reconcile', goal: 'Reconcile payouts' })

      await expect(taskSyncService.handOff(USER, task.id)).rejects.toThrow()

      const after = taskService.getById(USER, task.id)
      expect(after.executor).toBe('desktop')
      // The binding survives, because the task really is on the service now —
      // a second attempt re-binds to the same row through `external_ref`
      // instead of creating a second one.
      expect(after.remote?.adapter).toBe('cinna')
    })

    it('refuses a task that is already with a service, rather than running it twice', async () => {
      // The sequence would re-post the note, re-assign and `execute` again, and
      // cinna starts a second session on the same task — the race the other
      // direction refuses with `remote_busy`.
      const taskId = await bound()
      taskService.handOffToRemote(USER, taskId)
      const before = cinna.calls().length

      await expect(taskSyncService.handOff(USER, taskId)).rejects.toMatchObject({
        code: 'remote_busy'
      })
      expect(cinna.calls().length).toBe(before)
    })

    it('keeps the hand-over when the bookkeeping after it fails', async () => {
      // Three local writes follow the call that starts an agent, and each goes
      // through `requireTask`. Left to throw, the caller's catch soft-deletes
      // the task and writes no run row — so the user is told the run was
      // refused while an agent burns tokens on a task that, by the rest of the
      // app's reckoning, does not exist.
      const task = taskService.create(USER, { title: 'Reconcile', goal: 'Reconcile payouts' })
      const spy = vi.spyOn(taskService, 'handOffToRemote').mockImplementationOnce(() => {
        throw new TaskError('not_found', 'Task not found')
      })

      await expect(taskSyncService.handOff(USER, task.id)).rejects.toMatchObject({ code: 'handed_over' })

      expect(spy).toHaveBeenCalled()
      // The binding is what the caller needs, and it was committed before the
      // network call.
      expect(taskService.getById(USER, task.id).remote?.adapter).toBe('cinna')
      expect(cinna.calls().some((c) => c.path.endsWith('/execute'))).toBe(true)
      spy.mockRestore()
    })

    it('says the work started when the task went while it was starting', async () => {
      // The one sub-case with nothing local left to return. What must not
      // happen is the caller reporting a refusal and cleaning up: an agent is
      // running, and there is nothing to clean up anyway.
      const task = taskService.create(USER, { title: 'Reconcile', goal: 'Reconcile payouts' })
      const execute = holder.adapters[0].execute.bind(holder.adapters[0])
      const spy = vi.spyOn(holder.adapters[0], 'execute').mockImplementationOnce(async (...args) => {
        const binding = await execute(...args)
        taskService.remove(USER, task.id)
        return binding
      })

      await expect(taskSyncService.handOff(USER, task.id)).rejects.toMatchObject({
        code: 'handed_over'
      })
      expect(cinna.calls().some((c) => c.path.endsWith('/execute'))).toBe(true)
      spy.mockRestore()
    })

    it('refuses when the profile is connected to no service', async () => {
      holder.adapters = []
      const task = taskService.create(USER, { title: 'Reconcile', goal: 'Reconcile payouts' })
      await expect(taskSyncService.handOff(USER, task.id)).rejects.toMatchObject({
        code: 'no_service'
      })
      expect(taskService.getById(USER, task.id).executor).toBe('desktop')
    })

    it('does not re-send the assignee a create already carried', async () => {
      const task = taskService.create(USER, {
        title: 'Reconcile',
        goal: 'Reconcile payouts',
        assigneeAgentId: 'agent-on-the-service',
        assigneeKind: 'remote_agent'
      })
      await taskSyncService.handOff(USER, task.id)
      // One PATCH would be a request that can only confirm what the create said.
      expect(cinna.calls().filter((c) => c.method === 'PATCH')).toHaveLength(0)
    })
  })

  describe('taking a task back from a service', () => {
    it('refuses while an agent is working on it there', async () => {
      const taskId = await bound()
      taskService.handOffToRemote(USER, taskId)
      cinna.touch(remoteIdOf(taskId), { status: 'in_progress' })
      cinna.startSession(remoteIdOf(taskId), 'running')

      // §5.10, and the device-to-device twin decision 8 settled: claiming does
      // not stop the agent, so the outcomes are two runners on one task or a
      // claim the service's next status recompute undoes.
      await expect(taskSyncService.takeOver(USER, taskId)).rejects.toMatchObject({
        code: 'remote_busy'
      })
      expect(taskService.getById(USER, taskId).executor).toBe('remote')
    })

    it('allows it once nothing is working on it there', async () => {
      const taskId = await bound()
      taskService.handOffToRemote(USER, taskId)
      // A task can sit `in_progress` on cinna with nothing live: the status is
      // recomputed *from* the sessions, so it is not the question to ask.
      cinna.touch(remoteIdOf(taskId), { status: 'in_progress' })

      const task = await taskSyncService.takeOver(USER, taskId)
      expect(task.executor).toBe('desktop')
    })

    it('confirms rather than refusing when the service cannot be asked', async () => {
      const taskId = await bound()
      taskService.handOffToRemote(USER, taskId)
      cinna.behave('transport')

      // Refusing would strand the task on a service that cannot answer for it.
      await expect(taskSyncService.takeOver(USER, taskId)).rejects.toMatchObject({
        code: 'remote_unknown'
      })
      expect(taskService.getById(USER, taskId).executor).toBe('remote')

      const task = await taskSyncService.takeOver(USER, taskId, { force: true })
      expect(task.executor).toBe('desktop')
    })

    it('asks the service nothing for a task held by another device', async () => {
      // The device half of the same gesture needs no network, and paying for
      // one would make a claim fail because somebody else's server was down.
      holder.deviceId = 'device-here'
      const task = taskService.create(USER, { title: 'Local', goal: 'Do the thing' })
      taskRepo.update(USER, task.id, { executorDevice: 'device-there' })
      const before = cinna.calls().length

      const after = await taskSyncService.takeOver(USER, task.id)

      expect(after.runsHere).toBe(true)
      expect(cinna.calls().length).toBe(before)
    })
  })

  describe('is anything working on it there', () => {
    it('answers from the sessions, not from the status', async () => {
      const taskId = await bound()
      taskService.handOffToRemote(USER, taskId)
      cinna.touch(remoteIdOf(taskId), { status: 'in_progress' })
      expect(await taskSyncService.liveSession(USER, taskId)).toBe(false)

      cinna.startSession(remoteIdOf(taskId), 'running')
      expect(await taskSyncService.liveSession(USER, taskId)).toBe(true)
    })

    it('says nobody can tell when the service cannot be reached', async () => {
      const taskId = await bound()
      taskService.handOffToRemote(USER, taskId)
      cinna.behave('transport')
      expect(await taskSyncService.liveSession(USER, taskId)).toBeNull()
    })

    it('says no for a task no service holds, which is a real answer', async () => {
      const task = taskService.create(USER, { title: 'Local', goal: 'Do the thing' })
      expect(await taskSyncService.liveSession(USER, task.id)).toBe(false)
    })
  })
})

describe('scheduled sync races', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
  }

  it('discards an older detail response after a full pull has applied newer data', async () => {
    const id = await bound()
    const adapter = holder.adapters[0]
    const snapshot = await adapter.fetch(USER, {
      adapter: 'cinna', id: remoteIdOf(id), key: null, url: null, state: {}
    })
    const gate = deferred<typeof snapshot>()
    const entered = deferred<void>()
    vi.spyOn(adapter, 'fetch').mockImplementationOnce(() => { entered.resolve(); return gate.promise })
    const read = taskSyncService.pullOne(USER, id)
    await entered.promise
    cinna.touch(remoteIdOf(id), { title: 'Newer full pull' })
    await taskSyncService.pull(USER)
    gate.resolve({ ...snapshot, title: 'Older detail' })
    await read
    expect(taskService.getById(USER, id).title).toBe('Newer full pull')
  })

  it('does not overwrite a successfully pushed edit with an earlier detail response', async () => {
    const id = await bound()
    const adapter = holder.adapters[0]
    const snapshot = await adapter.fetch(USER, {
      adapter: 'cinna', id: remoteIdOf(id), key: null, url: null, state: {}
    })
    const gate = deferred<typeof snapshot>()
    const entered = deferred<void>()
    vi.spyOn(adapter, 'fetch').mockImplementationOnce(() => { entered.resolve(); return gate.promise })
    const read = taskSyncService.pullOne(USER, id)
    await entered.promise
    taskService.update(USER, id, { title: 'Pushed edit' })
    await taskSyncService.push(USER, id)
    gate.resolve(snapshot)
    await read
    expect(dirtyOf(id)).not.toContain('title')
    expect(taskService.getById(USER, id).title).toBe('Pushed edit')
  })

  it('retries the full history window when a contended row was skipped', async () => {
    const id = await bound()
    const adapter = holder.adapters[0]
    const originalList = adapter.list.bind(adapter)
    const active = await originalList(USER, null)
    const detailGate = deferred<(typeof active)[number]>()
    const detailEntered = deferred<void>()
    vi.spyOn(adapter, 'fetch').mockImplementationOnce(() => {
      detailEntered.resolve(); return detailGate.promise
    })
    const detail = taskSyncService.pullOne(USER, id)
    await detailEntered.promise
    const gate = deferred<typeof active>()
    const entered = deferred<void>()
    const list = vi.spyOn(adapter, 'list').mockImplementationOnce(() => {
      entered.resolve(); return gate.promise
    })
    const pull = taskSyncService.pull(USER)
    await entered.promise
    cinna.touch(remoteIdOf(id), { title: 'Newer watched value' })
    detailGate.resolve({ ...active[0], title: 'Newer watched value' })
    await detail
    cinna.seed({ title: 'Another remote task' })
    gate.resolve(active)
    await pull
    list.mockClear()
    await taskSyncService.pull(USER)
    expect(list.mock.calls[0][1]).toBeNull()
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(taskService.getById(USER, id).title).toBe('Newer watched value')
  })

  it('lets an active full pass finish before a watched detail poll', async () => {
    const id = await bound()
    const adapter = holder.adapters[0]
    const active = await adapter.list(USER, null)
    const gate = deferred<typeof active>()
    const entered = deferred<void>()
    vi.spyOn(adapter, 'list').mockImplementationOnce(() => { entered.resolve(); return gate.promise })
    const fetch = vi.spyOn(adapter, 'fetch')
    const pull = taskSyncService.pull(USER)
    await entered.promise
    const first = taskSyncService.pullOne(USER, id)
    const second = taskSyncService.pullOne(USER, id)
    await Promise.resolve()
    const callsWhilePulling = fetch.mock.calls.length
    gate.resolve(active)
    await Promise.all([pull, first, second])
    expect(callsWhilePulling).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stops an old batch after its in-flight request and leaves dirty markers intact', async () => {
    const first = await bound()
    const second = await bound()
    taskService.update(USER, first, { title: 'First edit' })
    taskService.update(USER, second, { title: 'Second edit' })
    const adapter = holder.adapters[0]
    const original = adapter.pushFields.bind(adapter)
    const entered = deferred<void>()
    const release = deferred<void>()
    const push = vi.spyOn(adapter, 'pushFields').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return original(...args)
    })
    const batch = taskSyncService.pushAll(USER)
    await entered.promise
    taskSyncService.invalidatePending(USER)
    release.resolve()
    await batch
    expect(push).toHaveBeenCalledTimes(1)
    expect(dirtyOf(first)).toContain('title')
    expect(dirtyOf(second)).toContain('title')
  })

  it('ignores a late response from the account a profile used to be linked to', async () => {
    const id = await bound()
    const adapter = holder.adapters[0]
    const active = await adapter.list(USER, null)
    const gate = deferred<typeof active>()
    const entered = deferred<void>()
    vi.spyOn(adapter, 'list').mockImplementationOnce(() => { entered.resolve(); return gate.promise })
    const pending = taskSyncService.pull(USER)
    await entered.promise
    taskSyncService.forgetBindings(USER)
    gate.resolve(active)
    await pending
    expect(taskService.list(USER)).toHaveLength(1)
    expect(taskService.getById(USER, id).remote).toBeNull()
  })

  it('keeps a watched failure visible until a later read succeeds', async () => {
    const id = await bound()
    cinna.behave('transport')
    await taskSyncService.pullOne(USER, id)
    expect(taskSyncService.getWatched(USER, id).remote?.refreshError).toContain('Could not refresh')
    await taskSyncService.pullOne(USER, id)
    cinna.behave(null)
    await taskSyncService.pullOne(USER, id)
    expect(taskSyncService.getWatched(USER, id).remote?.refreshError).toBeUndefined()
    await taskSyncService.pullOne(USER, id)
  })
})

describe('watched subtasks', () => {
  it('imports completed children absent from active discovery under their original parent', async () => {
    const parent = cinna.seed({ title: 'Parent' })
    await taskSyncService.pull(USER)
    const localParent = taskRepo.getByRemote(USER, holder.adapters[0].id, parent.id)!
    const child = cinna.seed({ title: 'Finished child', parent_task_id: parent.id, status: 'completed' })
    expect(taskRepo.getByRemote(USER, holder.adapters[0].id, child.id)).toBeUndefined()
    const children = await taskSyncService.listChildren(USER, localParent.id)
    expect(children.map((task) => [task.title, task.status, task.parentTaskId])).toEqual([
      ['Finished child', 'completed', localParent.id]
    ])
    expect(taskService.list(USER, { rootOnly: true }).map((task) => task.id)).toEqual([localParent.id])
  })

  it('coalesces reads and refuses a response from an obsolete connection', async () => {
    const parent = cinna.seed({ title: 'Parent' })
    await taskSyncService.pull(USER)
    const local = taskRepo.getByRemote(USER, holder.adapters[0].id, parent.id)!
    cinna.seed({ title: 'Late child', parent_task_id: parent.id })
    const adapter = holder.adapters[0]
    const original = adapter.listSubtasks.bind(adapter)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const entry = new Promise<void>((resolve) => { entered = resolve })
    const read = vi.spyOn(adapter, 'listSubtasks').mockImplementation(async (...args) => {
      entered()
      await gate
      return original(...args)
    })
    const first = taskSyncService.listChildren(USER, local.id)
    const second = taskSyncService.listChildren(USER, local.id)
    await entry
    taskSyncService.resetCursors(USER)
    release()
    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(read).toHaveBeenCalledTimes(1)
    expect(taskService.list(USER, { parentTaskId: local.id })).toEqual([])
  })
})

describe('subtask refresh ordering and saved reads', () => {
  it('keeps saved children visible on a cold offline read and exposes refresh failure', async () => {
    const parent = cinna.seed({ title: 'Parent' })
    cinna.seed({ title: 'Saved child', parent_task_id: parent.id })
    await taskSyncService.pull(USER)
    const local = taskRepo.getByRemote(USER, holder.adapters[0].id, parent.id)!
    taskSyncService.resetCursors(USER)
    cinna.behave('transport')
    const snapshot = taskSyncService.getChildren(USER, local.id)
    expect(snapshot.tasks.map((task) => task.title)).toEqual(['Saved child'])
    await taskSyncService.listChildren(USER, local.id).catch(() => {})
    await Promise.resolve()
    const failed = taskSyncService.getChildren(USER, local.id)
    expect(failed.tasks.map((task) => task.title)).toEqual(['Saved child'])
    expect(failed.refreshError).toContain('could not be refreshed')
    await taskSyncService.listChildren(USER, local.id).catch(() => {})
  })

  it('accepts child data after a concurrent no-op parent detail refresh', async () => {
    const parent = cinna.seed({ title: 'Parent' })
    await taskSyncService.pull(USER)
    const local = taskRepo.getByRemote(USER, holder.adapters[0].id, parent.id)!
    cinna.seed({ title: 'Finished child', parent_task_id: parent.id, status: 'completed' })
    const adapter = holder.adapters[0]
    const original = adapter.listSubtasks.bind(adapter)
    let release!: () => void
    let entered!: () => void
    const entry = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(adapter, 'listSubtasks').mockImplementationOnce(async (...args) => {
      entered(); await gate; return original(...args)
    })
    const read = taskSyncService.listChildren(USER, local.id)
    await entry
    await taskSyncService.pullOne(USER, local.id)
    release()
    expect((await read).map((task) => task.title)).toEqual(['Finished child'])
  })

  it('waits for the profile discovery pass before reading children', async () => {
    const parent = cinna.seed({ title: 'Parent' })
    await taskSyncService.pull(USER)
    const local = taskRepo.getByRemote(USER, holder.adapters[0].id, parent.id)!
    const adapter = holder.adapters[0]
    const original = adapter.list.bind(adapter)
    let release!: () => void
    let entered!: () => void
    const entry = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(adapter, 'list').mockImplementationOnce(async (...args) => {
      entered(); await gate; return original(...args)
    })
    const childRead = vi.spyOn(adapter, 'listSubtasks')
    const full = taskSyncService.pull(USER)
    await entry
    const children = taskSyncService.listChildren(USER, local.id)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(childRead).not.toHaveBeenCalled()
    release()
    await full
    await children
    expect(childRead).toHaveBeenCalledTimes(1)
  })
})
