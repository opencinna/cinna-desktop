import { agentTaskDispatchRepo, taskDispatchGateRepo } from '../db/taskDispatch'
import { taskRepo } from '../db/tasks'
import type { TaskDispatchInboxItem } from '../../shared/inbox'

/**
 * The task dispatcher's half of the Inbox: approvals waiting on outside
 * content, and queues paused on a flagged task.
 *
 * Reads only, and only repositories, so `inboxService` can list them without
 * importing the dispatcher (which imports the execution stack that imports
 * the Inbox).
 *
 * A gate is listed only while it still describes what would run: its task is
 * live and Ready, the file still has the digest the card was opened for, and
 * that digest is not trusted yet. Anything else is a card nobody needs to
 * answer, and the next dispatch pass settles or replaces it.
 */
/**
 * The agents of this profile that can work a queue now (enabled local folder
 * agents), registered by the dispatcher's production wiring. A pause row or
 * a gate of any other agent — disabled, or its folder gone — is a card about
 * a queue nobody can work, and is not listed. The rows themselves stay: the
 * agent may come back (re-enabled, folder restored) with them intact.
 */
type DispatchableAgentsSource = (userId: string) => Promise<ReadonlySet<string>>
let dispatchableAgents: DispatchableAgentsSource | null = null

export function setDispatchableAgentsSource(source: DispatchableAgentsSource | null): void {
  dispatchableAgents = source
}

/**
 * Whether this agent can work a queue now. Unregistered or unreadable counts
 * as yes: an answer stored for a queue nobody works is cleared by the next
 * dispatch pass, with a sentence, so a wrong yes costs one more answer.
 */
export async function isDispatchableAgent(userId: string, agentId: string): Promise<boolean> {
  if (!dispatchableAgents) return true
  try { return (await dispatchableAgents(userId)).has(agentId) } catch { return true }
}

/**
 * Each dispatchable agent's folder name, by agent id — what an answer waiting
 * for its queue says it waits on. Registered by the dispatcher's wiring.
 */
type DispatchFolderNamesSource = (userId: string) => Promise<ReadonlyMap<string, string>>
let dispatchFolderNames: DispatchFolderNamesSource | null = null

export function setDispatchFolderNamesSource(source: DispatchFolderNamesSource | null): void {
  dispatchFolderNames = source
}

/** The folder names, or an empty map when unregistered or unreadable. */
export async function dispatchFolderNamesFor(userId: string): Promise<ReadonlyMap<string, string>> {
  try { return dispatchFolderNames ? await dispatchFolderNames(userId) : new Map() } catch { return new Map() }
}

export async function taskDispatchInboxItems(userId: string): Promise<TaskDispatchInboxItem[]> {
  // Unregistered, or unreadable: list every card rather than hide one the
  // user must answer.
  let agentIds: ReadonlySet<string> | null = null
  try { agentIds = dispatchableAgents ? await dispatchableAgents(userId) : null } catch { agentIds = null }
  const items: TaskDispatchInboxItem[] = []
  for (const gate of taskDispatchGateRepo.listOpen(userId)) {
    const task = taskRepo.getById(userId, gate.taskId)
    if (agentIds && !agentIds.has(gate.agentId)) continue
    if (!task || task.deletedAt || task.status !== 'open') continue
    if (task.localFile?.digest !== gate.digest || task.trustedDigest === gate.digest) continue
    items.push({
      kind: 'dispatch_gate',
      gateId: gate.id,
      taskId: gate.taskId,
      taskTitle: gate.title,
      agentId: gate.agentId,
      filePath: gate.filePath,
      body: gate.body,
      createdAt: gate.createdAt
    })
  }
  for (const row of agentTaskDispatchRepo.listForUser(userId)) {
    if (!row.pausedReason) continue
    if (agentIds && !agentIds.has(row.agentId)) continue
    const task = row.pausedTaskId ? taskRepo.getById(userId, row.pausedTaskId) : undefined
    const live = task && !task.deletedAt ? task : undefined
    items.push({
      kind: 'dispatch_paused',
      agentId: row.agentId,
      reason: row.pausedReason,
      taskId: live?.id ?? null,
      taskTitle: live?.title ?? null,
      note: live?.dispatchNote ?? null,
      pausedAt: row.pausedAt ?? row.updatedAt
    })
  }
  return items
}
