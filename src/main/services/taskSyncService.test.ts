import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { RemoteTaskAdapter } from '../tasks/adapters/adapter'
import type { TaskDto } from '../../shared/tasks'
import { CinnaApiError } from '../errors'

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
