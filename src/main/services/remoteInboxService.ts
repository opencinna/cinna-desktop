import { taskRepo, type TaskRow } from '../db/tasks'
import { adapterFor } from '../tasks/adapters'
import { RemoteTaskError, type RemoteBinding } from '../tasks/adapters/adapter'
import { ASK_NO_LONGER_WAITING, type InboxAnswerResult, type InboxEntry } from '../../shared/inbox'
import type { RequestResolution } from '../../shared/localAgentRequests'

const PREFIX = 'remote-ask:'
const reads = new Map<string, Promise<InboxEntry[]>>()
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

/** Bound the UI's wait. Keep the underlying read coalesced until it settles. */
function withDeadline<T>(pending: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The service did not answer in time.')), 10_000)
    pending.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

async function read(userId: string): Promise<InboxEntry[]> {
  const tasks = taskRepo.list(userId, { statuses: ['blocked'] })
    .filter((task) => bindingOf(task) && adapterFor(task.remoteAdapter!).capabilities().asks)
  const groups = await Promise.allSettled(tasks.map(async (task): Promise<InboxEntry[]> => {
    const adapter = adapterFor(task.remoteAdapter!)
    const availability = await adapter.availability(userId)
    if (!availability.ready) throw new Error(availability.reason ?? 'The service is unavailable.')
    const asks = await adapter.listOpenAsks(userId, bindingOf(task)!)
    if (!stillBound(userId, task)) return []
    return asks.map((ask) => ({
      requestId: address(task, ask.id), source: 'remote', taskId: task.id,
      taskTitle: task.title, chatId: null, agentId: task.assigneeAgentId,
      request: ask.request, resume: 'reply', createdAt: ask.createdAt
    }))
  }))
  const entries: InboxEntry[] = []
  for (const group of groups) {
    if (group.status === 'rejected') throw group.reason
    entries.push(...group.value)
  }
  return entries
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
  list(userId: string): Promise<InboxEntry[]> {
    let pending = reads.get(userId)
    if (!pending) {
      pending = read(userId).finally(() => reads.delete(userId))
      reads.set(userId, pending)
    }
    // A failed remote read rejects the list, preserving TanStack's last good
    // value and its error state. It must never be turned into an empty array.
    return withDeadline(pending)
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
