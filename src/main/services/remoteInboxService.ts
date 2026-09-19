import { taskRepo, type TaskRow } from '../db/tasks'
import { adapterFor } from '../tasks/adapters'
import { RemoteTaskError, type RemoteBinding } from '../tasks/adapters/adapter'
import { ASK_NO_LONGER_WAITING, type InboxAnswerResult, type InboxEntry, type InboxSnapshot, type InboxUnreadableSource } from '../../shared/inbox'
import type { RequestResolution } from '../../shared/localAgentRequests'

const PREFIX = 'remote-ask:'
/** One read per profile, with the services it is waiting on beside it. */
const reads = new Map<string, { adapters: string[]; snapshot: Promise<InboxSnapshot> }>()
const answers = new Map<string, { resolution: string; pending: Promise<InboxAnswerResult> }>()

function bindingOf(task: TaskRow): RemoteBinding | null {
  if (!task.remoteAdapter || !task.remoteId || task.deletedAt) return null
  return {
    adapter: task.remoteAdapter, id: task.remoteId, key: task.remoteKey,
    url: task.remoteUrl, state: task.remoteState ?? {}
  }
}

// Include the binding as well as the task: a stale card must never answer an
// identically named ask on a different service after the task was re-linked.
function address(task: TaskRow, askId: string): string {
  return PREFIX + JSON.stringify([task.id, task.remoteAdapter, task.remoteId, askId])
}

function decode(id: string): string[] | null {
  try {
    const value: unknown = JSON.parse(id.slice(PREFIX.length))
    return Array.isArray(value) && value.length === 4 &&
      value.every((part) => typeof part === 'string' && part.length > 0) ? value : null
  } catch { return null }
}

function stillBound(userId: string, task: TaskRow): boolean {
  const current = taskRepo.getById(userId, task.id)
  return !!current && !current.deletedAt && current.remoteAdapter === task.remoteAdapter &&
    current.remoteId === task.remoteId
}

const TOO_SLOW = 'The service did not answer in time.'

/** Bound the UI's wait. Keep the underlying read coalesced until it settles. */
function withDeadline<T>(pending: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TOO_SLOW)), 10_000)
    pending.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/**
 * The same bound on the UI's wait, answered as a snapshot rather than a
 * rejection.
 *
 * A read that has not come back in ten seconds is every service it was waiting
 * on being unreadable — nothing has been collected yet, since the fan-out
 * settles in one go — and never a failure of the list itself: the local rows the
 * caller already has must survive one slow system. The underlying read keeps
 * running and keeps the lock, which is the whole reason this deadline is here
 * rather than an abort: a retry joins the same operation instead of duplicating
 * its network work.
 */
function withReadDeadline(pending: Promise<InboxSnapshot>, adapters: string[]): Promise<InboxSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolve({ entries: [], unreadable: adapters.map((adapter) => ({ adapter, reason: TOO_SLOW })) }),
      10_000
    )
    pending.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Which locally known tasks a read would enumerate. Synchronous, so the
 * deadline above can name the services it is waiting on. */
function askCapable(userId: string): TaskRow[] {
  return taskRepo.list(userId, { statuses: ['blocked'] })
    .filter((task) => bindingOf(task) && adapterFor(task.remoteAdapter!).capabilities().asks)
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function read(userId: string, tasks: TaskRow[]): Promise<InboxSnapshot> {
  const groups = await Promise.allSettled(tasks.map(async (task): Promise<InboxEntry[]> => {
    const adapter = adapterFor(task.remoteAdapter!)
    const availability = await adapter.availability(userId)
    if (!availability.ready) throw new Error(availability.reason ?? 'The service is unavailable.')
    const asks = await adapter.listOpenAsks(userId, bindingOf(task)!)
    if (!stillBound(userId, task)) return []
    return asks.filter((ask) => ask.audience !== 'requester').map((ask) => ({
      requestId: address(task, ask.id), source: 'remote', taskId: task.id,
      taskTitle: task.title, chatId: null, agentId: task.assigneeAgentId,
      request: ask.request, resume: 'reply', createdAt: ask.createdAt
    }))
  }))
  const entries: InboxEntry[] = []
  const unreadable: InboxUnreadableSource[] = []
  groups.forEach((group, index) => {
    if (group.status !== 'rejected') {
      entries.push(...group.value)
      return
    }
    // **One entry per service, not per task.** Three blocked tasks on one
    // unreachable system are one thing the user cannot read, and the first
    // failure is the one that describes it — the later ones are the same
    // outage answering again. The adapter *id* is what is carried: a
    // `RemoteTaskAdapter` has no display name, and no copy above this names a
    // service anyway.
    const adapter = tasks[index].remoteAdapter!
    if (!unreadable.some((source) => source.adapter === adapter)) {
      unreadable.push({ adapter, reason: reasonOf(group.reason) })
    }
  })
  return { entries, unreadable }
}

const gone = (): InboxAnswerResult => ({
  ok: false, code: 'no_longer_waiting', reason: ASK_NO_LONGER_WAITING
})

async function answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> {
  const parts = decode(requestId)
  if (!parts) return { ok: false, code: 'malformed', reason: 'Malformed request address.' }
  const [taskId, adapterId, remoteId, askId] = parts
  const task = taskRepo.getById(userId, taskId)
  if (!task || task.deletedAt || task.remoteAdapter !== adapterId || task.remoteId !== remoteId) return gone()
  const binding = bindingOf(task)!
  const adapter = adapterFor(binding.adapter)
  try {
    if (!adapter.capabilities().asks) {
      return { ok: false, code: 'not_here', reason: 'This service cannot answer requests here.' }
    }
    const availability = await adapter.availability(userId)
    if (!availability.ready) {
      return { ok: false, code: 'unavailable', reason: availability.reason ?? 'The service is unavailable.' }
    }
    if (!stillBound(userId, task)) return gone()
    const outcome = await adapter.answerAsk(userId, binding, askId, resolution)
    // The service owns its status. Answering one ask cannot claim the task is
    // running again: another session may still be blocked.
    return outcome.delivered ? { ok: true } : gone()
  } catch (error) {
    if (error instanceof RemoteTaskError) {
      if (error.code === 'not_ours') return gone()
      return { ok: false, code: error.code === 'invalid_request' ? 'malformed' : 'unavailable', reason: error.message }
    }
    return { ok: false, code: 'unavailable', reason: 'That answer could not be delivered. Try again.' }
  }
}

export const remoteInboxService = {
  isRemoteAddress: (id: string): boolean => id.startsWith(PREFIX),
  list(userId: string): Promise<InboxSnapshot> {
    let pending = reads.get(userId)
    if (!pending) {
      const tasks = askCapable(userId)
      pending = {
        adapters: [...new Set(tasks.map((task) => task.remoteAdapter!))],
        snapshot: read(userId, tasks).finally(() => reads.delete(userId))
      }
      reads.set(userId, pending)
    }
    // **A failed service is a hole in the list, not the loss of it.** This used
    // to reject, which took the local asks down with the remote ones for as
    // long as one bound system was unreachable. What a caller gets now is
    // everything that *could* be read plus who could not be; an empty
    // `unreadable` is the promise that the list is complete.
    return withReadDeadline(pending.snapshot, pending.adapters)
  },
  answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> {
    const key = JSON.stringify([userId, requestId])
    const existing = answers.get(key)
    const serialized = JSON.stringify(resolution)
    if (existing && existing.resolution !== serialized) return Promise.resolve({
      ok: false, code: 'unavailable', reason: 'A different answer is still being sent. Wait for it to finish before trying again.'
    })
    if (existing) return withDeadline(existing.pending).catch(() => ({
      ok: false, code: 'unavailable', reason: 'The service has not confirmed this answer yet. Try again to check.'
    }))
    const pending = answer(userId, requestId, resolution).finally(() => answers.delete(key))
    answers.set(key, { resolution: serialized, pending })
    return withDeadline(pending).catch(() => ({
      ok: false, code: 'unavailable', reason: 'The service has not confirmed this answer yet. Try again to check.'
    }))
  }
}
