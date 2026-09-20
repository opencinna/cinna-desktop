vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { RemoteTaskAdapter } from '../tasks/adapters/adapter'

/**
 * The reconcile, on its own, because what it gets wrong it gets wrong
 * irreversibly.
 *
 * §5.7: a delete is **invisible to an `updated_since` cursor**. The row stops
 * being returned and no later pull ever mentions it again, so a periodic full
 * pass is the only thing that can notice. The obvious implementation of that
 * pass — "drop every replica the list did not mention" — is wrong in a way that
 * deletes the user's data, because `list(userId, null)` is the adapter's
 * *active* set and on cinna that excludes everything completed, cancelled and
 * archived. Every finished task would go on the first reconcile.
 *
 * So absence is a question, and `fetch` answers it. These tests are the
 * difference between the two.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
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
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))
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

const USER = '__default__'

let cinna: ReturnType<typeof createFakeCinnaServer>

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.userData = mkdtempSync(join(tmpdir(), 'cinna-task-reconcile-'))
  cinna = createFakeCinnaServer()
  holder.adapters = [createCinnaTaskAdapter(cinna.world)]
  taskSyncService.resetCursors()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
  if (holder.userData) rmSync(holder.userData, { recursive: true, force: true })
})

/** A replica of a remote task, brought in the way a pull brings one in. */
async function replicaOf(patch: Parameters<typeof cinna.seed>[0]): Promise<string> {
  const remote = cinna.seed(patch)
  await taskSyncService.pull(USER)
  const local = taskRepo.getByRemote(USER, 'cinna', remote.id)
  if (!local) throw new Error('the pull did not bring the task in')
  return local.id
}

/** Take a task off the far side, as a delete on the web would. */
function deleteThere(taskId: string): void {
  const remoteId = taskRepo.getById(USER, taskId)?.remoteId as string
  cinna.forget(remoteId)
}

describe('reconciling with what the service still has', () => {
  it('drops a replica the service really does not have any more', async () => {
    const taskId = await replicaOf({ title: 'Raised on the web' })
    deleteThere(taskId)

    await taskSyncService.reconcile(USER)

    // A delete travels no other way: the cursor will never mention it again.
    expect(taskService.list(USER)).toEqual([])
    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeInstanceOf(Date)
  })

  /**
   * The one that matters, and the reason the absence is confirmed rather than
   * believed. `status=active` on cinna is `new, refining, open, in_progress,
   * blocked, error` — a completed task is simply not in it.
   */
  it('keeps a finished replica that the active list does not mention', async () => {
    // The realistic sequence: the desktop mirrored it while it was running,
    // and it finished there. The *incremental* pull sees the completion
    // (a cursor has no status filter); the active list never mentions it again.
    const taskId = await replicaOf({ title: 'Running on the web', status: 'in_progress' })
    cinna.touch(taskRepo.getById(USER, taskId)?.remoteId as string, { status: 'completed' })
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, taskId).status).toBe('completed')

    await taskSyncService.reconcile(USER)

    const [task] = taskService.list(USER, { includeArchived: true })
    expect(task?.id).toBe(taskId)
    expect(task?.status).toBe('completed')
  })

  it('does not pay to confirm a replica that has already finished', async () => {
    const taskId = await replicaOf({ title: 'Running on the web', status: 'in_progress' })
    cinna.touch(taskRepo.getById(USER, taskId)?.remoteId as string, { status: 'completed' })
    await taskSyncService.pull(USER)

    const before = cinna.requests()
    await taskSyncService.reconcile(USER)
    // One list, and nothing else. Every finished replica is absent from the
    // active set *by construction*, and `fetch` is two requests — so confirming
    // them all is a permanent per-poll cost for tasks nobody is waiting on.
    expect(cinna.requests() - before).toBe(1)
  })

  it('uses the confirming fetch to catch up a delta it missed', async () => {
    const taskId = await replicaOf({ title: 'Running on the web', status: 'in_progress' })
    // It finished there, and the delta never arrived — a change in the same
    // instant as the cursor, a pull that failed, an app that was shut.
    cinna.touch(taskRepo.getById(USER, taskId)?.remoteId as string, {
      status: 'completed',
      title: 'Finished on the web'
    })
    taskSyncService.resetCursors()
    await taskSyncService.reconcile(USER)

    // The request spent proving the task still exists buys two answers.
    const task = taskService.getById(USER, taskId)
    expect(task.status).toBe('completed')
    expect(task.title).toBe('Finished on the web')
  })

  it('keeps a replica the service could not be asked about', async () => {
    const taskId = await replicaOf({ title: 'Raised on the web' })
    deleteThere(taskId)
    cinna.behave('transport')

    await taskSyncService.reconcile(USER)
    // "The network is down" is not "the task is gone". Only a refusal an
    // adapter is *sure* about removes anything.
    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeNull()
  })

  it('never deletes a task that was created here and merely mirrored there', async () => {
    const local = taskService.create(USER, { title: 'Mine', goal: 'Do my thing' })
    const binding = await holder.adapters[0].create(USER, local, null)
    taskService.bindRemote(USER, local.id, binding)
    cinna.forget(binding.id)

    await taskSyncService.reconcile(USER)

    // The remote copy going missing means the binding is stale, which the push
    // and the pull both answer by unbinding. Deleting the user's own task
    // because a mirror vanished is the one outcome with no way back.
    const row = taskRepo.getById(USER, local.id)
    expect(row?.deletedAt).toBeNull()
    expect(row?.title).toBe('Mine')
  })

  it('leaves alone a task bound to a service this build does not have', async () => {
    const orphan = taskService.create(USER, {
      title: 'On something else',
      goal: 'Do the other thing',
      origin: 'remote',
      executor: 'remote',
      remoteAdapter: 'a-service-from-a-newer-build',
      remoteId: 'x-1'
    })

    await taskSyncService.reconcile(USER)
    // `allAdapters()` never names it, so nothing iterates over it — and the
    // null adapter is not asked to confirm a delete it could only refuse.
    expect(taskRepo.getById(USER, orphan.id)?.deletedAt).toBeNull()
  })
})

describe('when the reconcile happens', () => {
  it('runs on the first pull of a session, which is §5.7’s “on app start”', async () => {
    const taskId = await replicaOf({ title: 'Raised on the web' })
    deleteThere(taskId)
    // A fresh process has no cursor and is already asking for the whole active
    // set, so the confirming pass costs one extra request and no extra list.
    taskSyncService.resetCursors()

    await taskSyncService.pull(USER)
    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeInstanceOf(Date)
  })

  it('does not ask for the active set twice on that first pass', async () => {
    cinna.seed({ title: 'Raised on the web' })
    await taskSyncService.pull(USER)
    const lists = cinna.calls().filter((c) => c.path.startsWith('/api/v1/tasks/?'))
    // The confirming pass reuses the list the pull already has. The first pass
    // does make a *second* list request — the finished-history window — but it
    // is a cursored one, and the point of this test is that the expensive
    // uncursored set is fetched once.
    expect(lists.filter((c) => c.path.includes('status=active'))).toHaveLength(1)
    expect(lists.filter((c) => c.path.includes('updated_since='))).toHaveLength(1)
  })

  it('does not run on every pull', async () => {
    const taskId = await replicaOf({ title: 'Raised on the web' })
    deleteThere(taskId)

    // The first pass already happened inside `replicaOf`. The second must not
    // pay for a full list, or the "periodic" in §5.7 means "every time".
    const before = cinna.calls().length
    await taskSyncService.pull(USER)
    const lists = cinna
      .calls()
      .slice(before)
      .filter((c) => c.path.includes('status=active'))
    expect(lists).toEqual([])
    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeNull()
  })
})
