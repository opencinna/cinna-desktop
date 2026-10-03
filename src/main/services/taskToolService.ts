import { basename } from 'node:path'
import { taskRepo, type TaskRow } from '../db/tasks'
import { delegationRepo, type DelegationRow } from '../db/delegations'
import { handoverRepo } from '../db/handovers'
import { taskCommentRepo, type TaskCommentRow } from '../db/taskComments'
import { taskRuntimeRepo } from '../db/taskRuntimes'
import { scriptRuntimeRepo } from '../db/scriptRuntimes'
import { taskRunnersByChat } from './taskRunnerState'
import { delegationService, validateSession, type DelegationSession } from './delegationService'
import { localAgentService } from './localAgents/localAgentService'
import { noteAgentStatusReport } from '../tasks/agentStatusReports'
import { createLogger } from '../logger/logger'
import {
  EMPTY_FOLDER_BOARD,
  FOLDER_CATEGORY_STATUS,
  FOLDER_TASKS_DIR,
  folderCategoryOf,
  formatFolderLogEntry,
  normalizeStatusWord
} from '../../shared/folderTasks'
import {
  TASK_STATUS_CATEGORIES,
  isTaskStatus,
  parseTaskStatus,
  taskStatusCategory,
  type TaskStatus,
  type TaskStatusCategory
} from '../../shared/taskStatus'
import { TASK_COMMENT_MAX, isTaskPriority, type TaskCommentDto, type TaskCustomFields } from '../../shared/tasks'

/**
 * The agent task tools — `tasks_list`, `task_create`, `task_update`,
 * `task_comment` — offered on the session loopback MCP beside `handover_*`
 * (`DelegationToolProvider`), to the same sessions: a folder agent's own chat
 * or a human-routed one, never a nested run.
 *
 * `task_create` with an `assignee` is a delegation and goes to
 * `delegationService.create` unchanged; without one (or naming the calling
 * agent) it puts a task in the agent's own queue — a file in a bare agent's
 * `.cinna/tasks/`, a native task for a kit agent. Every tool-created task
 * records the agent and its chain depth; a chat may create at most
 * {@link TASK_TOOL_CHAT_CAP} of them, own and delegated together.
 */

const logger = createLogger('task-tools')

/** Tool-created tasks (own queue and delegations) one chat may make. */
export const TASK_TOOL_CHAT_CAP = 20
/** Deepest own-queue chain: a task created from a task created from a task. */
export const MAX_TASK_CHAIN_DEPTH = 2
/** `tasks_list` answers at most this many, newest first. */
export const TASKS_LIST_MAX = 50

type Relation = 'assigned' | 'created' | 'delegated'
const RELATIONS: readonly Relation[] = ['assigned', 'created', 'delegated']

function fail(message: string): never {
  throw new Error(message)
}

function text(value: unknown, name: string, max: number, oneLine = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`Provide a nonempty ${name} (at most ${max} characters).`)
  if (oneLine && /[\r\n]/.test(value)) fail(`The ${name} must be one line.`)
  return value.trim()
}

function priorityOf(value: unknown) {
  if (value === undefined) return undefined
  if (!isTaskPriority(value)) fail('Choose a priority: low, normal, high or urgent.')
  return value
}

function customFieldsOf(value: unknown): TaskCustomFields | null | undefined {
  if (value === undefined) return undefined
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) fail('custom_fields must be an object of field names to values.')
  return value as TaskCustomFields | null
}

/** A tool error in the words of the service that refused, never a stack. */
function plain<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

async function plainAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

/**
 * The depth of the task a chat is working on: the deeper of its delegation's
 * and its own chain depth, so own-queue tasks and delegations count against
 * one chain (`delegationService.create` reads it the same way).
 */
function depthOf(userId: string, task: TaskRow): number {
  return Math.max(delegationRepo.byTaskId(userId, task.id)?.depth ?? 0, task.chainDepth ?? 0)
}

function assertChatCap(session: DelegationSession): void {
  const { profileUserId } = session.scope
  const made = taskRepo.countCreatedInChat(profileUserId, session.chatId) + delegationRepo.countForOriginChat(profileUserId, session.chatId)
  if (made >= TASK_TOOL_CHAT_CAP) {
    fail(`This conversation already created ${TASK_TOOL_CHAT_CAP} tasks, the most one conversation may. Ask the user before creating more.`)
  }
}

/**
 * One `task_create` at a time per chat. The cap is a count of rows, checked
 * before the create writes its own: two parallel calls at 19 would both pass
 * the check unless the second waits for the first to finish writing.
 */
const creatingInChat = new Map<string, Promise<unknown>>()

function serializedInChat<T>(chatId: string, work: () => Promise<T>): Promise<T> {
  const prior = creatingInChat.get(chatId) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(work)
  creatingInChat.set(chatId, next)
  void next.catch(() => {}).finally(() => {
    if (creatingInChat.get(chatId) === next) creatingInChat.delete(chatId)
  })
  return next
}

/** Delegated work moves through its own tools, never `task_update`; null when the task is not delegated. */
function delegatedRefusal(session: DelegationSession, row: TaskRow): string | null {
  const { profileUserId } = session.scope
  const delegation = delegationRepo.byTaskId(profileUserId, row.id)
  const handover = handoverRepo.byTaskId(profileUserId, row.id)
  if (!delegation && !handover) return null
  const requester = (delegation?.originAgentId ?? handover?.originAgentId) === session.agentId
  return requester
    ? 'This task is work you delegated: answer or revise it with handover_reply.'
    : 'This task is delegated work: report progress, questions and completion with handover_report.'
}

/** The task file relative to the agent folder, for a task kept in one. */
function fileOf(row: TaskRow): string | null {
  return row.localFile ? `${FOLDER_TASKS_DIR}/${basename(row.localFile.path)}` : null
}

function summary(row: TaskRow, relations: Relation[], delegation: DelegationRow | undefined) {
  const status = parseTaskStatus(row.status)
  return {
    id: row.id,
    title: row.title,
    status,
    statusLabel: row.statusLabel ?? null,
    category: taskStatusCategory(status),
    priority: row.priority,
    relations,
    assignee: { kind: row.assigneeKind, agentId: row.assigneeAgentId, name: row.assigneeName },
    parentId: row.parentTaskId,
    file: fileOf(row),
    delegation: delegation ? { id: delegation.id, state: delegation.state } : null
  }
}

function requireTask(userId: string, id: unknown): TaskRow {
  const taskId = text(id, 'task id', 100)
  const row = taskRepo.getById(userId, taskId)
  if (!row || row.deletedAt) fail('No task with that id.')
  return row
}

/**
 * The status a word names on this task: a status, or a status word —
 * the folder's own (`doing`, a `_board.yaml` word) for a task kept in a
 * folder, which is then written as the label, or a default word (`done`,
 * `ready`, `backlog`) for any task.
 */
async function resolveStatus(session: DelegationSession, row: TaskRow, raw: unknown): Promise<{ status: TaskStatus; label?: string }> {
  const word = text(raw, 'status', 64, true)
  if (isTaskStatus(word)) return { status: word }
  if (row.deviceLocal && row.assigneeAgentId) {
    const { taskSyncService } = await import('./taskSyncService')
    const columns = (await taskSyncService.folderBoard(session.scope.profileUserId, row.assigneeAgentId)) ?? []
    const column = columns.find((candidate) => candidate.category !== null && normalizeStatusWord(candidate.label) === normalizeStatusWord(word))
    if (column) return { status: column.status, label: column.label }
    const category = folderCategoryOf(word, EMPTY_FOLDER_BOARD)
    if (category) return { status: FOLDER_CATEGORY_STATUS[category], label: word }
  } else {
    const category = folderCategoryOf(word, EMPTY_FOLDER_BOARD)
    if (category) return { status: FOLDER_CATEGORY_STATUS[category] }
  }
  return fail(`“${word.slice(0, 64)}” is not a status this task understands.`)
}

/** What owns a task's turns other than this session, as a refusal; null when nothing does. */
async function ownedElsewhere(session: DelegationSession, row: TaskRow): Promise<string | null> {
  const { activeChatRunId } = await import('./chatRemoval')
  if (taskRuntimeRepo.get(session.scope.profileUserId, row.id) || scriptRuntimeRepo.owner(session.scope.profileUserId, row.id)) {
    return 'A runtime owns this task; it cannot be changed from here.'
  }
  if (row.chatId && row.chatId !== session.chatId && activeChatRunId(row.chatId)) {
    return 'This task has a turn running in another conversation; try again once it ends.'
  }
  return null
}

function agentName(settingsUserId: string, agentId: string | null): string | null {
  if (!agentId) return null
  try {
    return localAgentService.get(settingsUserId, agentId).name
  } catch {
    return null
  }
}

/** `task_create`, run only through {@link serializedInChat}. */
async function createTask(session: DelegationSession, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const assignee = input.assignee as { kind?: unknown; agentId?: unknown } | undefined
  // Naming yourself (a local target: no adapter) is your own queue.
  const self = !!assignee && typeof assignee === 'object' && assignee.agentId === session.agentId &&
    Object.keys(assignee).every((key) => key === 'kind' || key === 'agentId')
  if (assignee !== undefined && !self) {
    for (const key of ['priority', 'custom_fields', 'parent'] as const) {
      if (input[key] !== undefined) fail(`${key} applies to your own queue; leave it out when delegating.`)
    }
    // The old `handover_create`, verbatim: the brief is the description.
    const request: Record<string, unknown> = {
      target: assignee,
      id: input.id,
      title: input.title,
      brief: input.description,
      ...(input.execution !== undefined ? { execution: input.execution } : {}),
      ...(input.group !== undefined ? { group: input.group } : {}),
      ...(input.status !== undefined ? { status: input.status } : {})
    }
    return delegationService.create(session, request, signal, { beforeNew: () => assertChatCap(session) })
  }

  for (const key of ['id', 'execution', 'group'] as const) {
    if (input[key] !== undefined) fail(`${key} applies only when delegating to another agent (with an assignee).`)
  }
  const title = text(input.title, 'title', 300, true)
  const description = text(input.description, 'description', 100_000)
  const priority = priorityOf(input.priority)
  const customFields = customFieldsOf(input.custom_fields)
  if (input.status !== undefined && input.status !== 'backlog' && input.status !== 'ready') fail('Choose backlog or ready status.')
  const status: TaskStatus = input.status === 'ready' ? 'open' : 'new'

  const { task } = validateSession(session)
  const { profileUserId, settingsUserId } = session.scope
  const depth = task ? depthOf(profileUserId, task) + 1 : 0
  if (depth > MAX_TASK_CHAIN_DEPTH) {
    fail(`Tasks created by agents are limited to a chain of depth ${MAX_TASK_CHAIN_DEPTH}; this conversation's task is already at ${depth - 1}.`)
  }
  let parentTaskId: string | undefined
  if (input.parent !== undefined) {
    const parent = requireTask(profileUserId, input.parent)
    if (parent.assigneeAgentId !== session.agentId) fail('A parent must be a task in your own queue.')
    parentTaskId = parent.id
  }
  assertChatCap(session)
  signal?.throwIfAborted()

  const { taskAuthoringService } = await import('./taskAuthoringService')
  const created = await plainAsync(() => taskAuthoringService.createRouted(
    { profileUserId, settingsUserId },
    {
      title,
      goal: description,
      description,
      status,
      ...(priority ? { priority } : {}),
      ...(customFields ? { customFields } : {}),
      assignee: { kind: 'agent', agentId: session.agentId }
    },
    { parentTaskId, createdByAgentId: session.agentId, createdByChatId: session.chatId, chainDepth: depth }
  ))
  const row = taskRepo.getById(profileUserId, created.id)
  return row ? summary(row, ['assigned', 'created'], undefined) : { id: created.id, title: created.title, status: created.status }
}

export const taskToolService = {
  tasksList(session: DelegationSession, input: Record<string, unknown>) {
    validateSession(session)
    const relation = input.relation ?? 'all'
    if (relation !== 'all' && !RELATIONS.includes(relation as Relation)) fail('Choose relation: assigned, created, delegated or all.')
    const category = input.category as TaskStatusCategory | undefined
    if (category !== undefined && !TASK_STATUS_CATEGORIES.includes(category)) {
      fail(`Choose a category: ${TASK_STATUS_CATEGORIES.join(', ')}.`)
    }
    if (input.include_closed !== undefined && typeof input.include_closed !== 'boolean') fail('include_closed must be true or false.')
    const includeClosed = input.include_closed === true || category === 'closed'
    const { profileUserId } = session.scope

    const delegated = new Map<string, DelegationRow>()
    for (const row of delegationRepo.listByOriginAgent(profileUserId, session.agentId)) {
      if (row.taskId) delegated.set(row.taskId, row)
    }
    const items: { row: TaskRow; relations: Relation[] }[] = []
    for (const row of taskRepo.list(profileUserId)) {
      const relations: Relation[] = []
      if (row.assigneeAgentId === session.agentId) relations.push('assigned')
      if (row.createdByAgentId === session.agentId) relations.push('created')
      if (delegated.has(row.id)) relations.push('delegated')
      if (relations.length === 0) continue
      if (relation !== 'all' && !relations.includes(relation as Relation)) continue
      const rowCategory = taskStatusCategory(parseTaskStatus(row.status))
      if (rowCategory === null) continue
      if (category !== undefined && rowCategory !== category) continue
      if (!includeClosed && rowCategory === 'closed') continue
      items.push({ row, relations })
    }
    items.sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime() || (a.row.id < b.row.id ? 1 : -1))
    const shown = items.slice(0, TASKS_LIST_MAX)
    return {
      tasks: shown.map(({ row, relations }) =>
        summary(row, relations, delegated.get(row.id) ?? delegationRepo.byTaskId(profileUserId, row.id))),
      ...(items.length > shown.length ? { truncated: true, total: items.length } : {})
    }
  },

  taskCreate(session: DelegationSession, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return serializedInChat(session.chatId, () => createTask(session, input, signal))
  },

  async taskUpdate(session: DelegationSession, input: Record<string, unknown>): Promise<unknown> {
    const { task: current } = validateSession(session)
    const { profileUserId, settingsUserId } = session.scope
    const row = requireTask(profileUserId, input.id)
    const isCurrent = current?.id === row.id
    const assigned = row.assigneeAgentId === session.agentId
    const created = row.createdByAgentId === session.agentId
    if (!isCurrent && !assigned && !(created && !row.chatId)) {
      fail(created
        ? 'A task you created can be changed only until a conversation starts working on it.'
        : 'You can change only tasks assigned to you, or tasks you created that nobody has started.')
    }
    const delegated = delegatedRefusal(session, row)
    if (delegated) fail(delegated)
    const refusal = await ownedElsewhere(session, row)
    if (refusal) fail(refusal)

    const patch = {
      ...(input.title !== undefined ? { title: text(input.title, 'title', 300, true) } : {}),
      ...(input.description !== undefined ? { description: text(input.description, 'description', 100_000) } : {}),
      ...(input.priority !== undefined ? { priority: priorityOf(input.priority) } : {}),
      ...(input.custom_fields !== undefined ? { customFields: customFieldsOf(input.custom_fields) } : {})
    }
    const target = input.status !== undefined ? await resolveStatus(session, row, input.status) : null
    const scope = { profileUserId, settingsUserId }
    const [{ taskAuthoringService }, { taskService }] = await Promise.all([import('./taskAuthoringService'), import('./taskService')])
    if (Object.keys(patch).length > 0) plain(() => taskAuthoringService.update(scope, row.id, patch))

    if (target) {
      const reporting = isCurrent && (target.status === 'completed' || target.status === 'blocked' || target.status === 'error')
      if (reporting) {
        // The agent's word for how the work ended wins over how the turn
        // ended — for a hand-opened chat's task, a dispatched one and a job
        // run's alike: `jobService.reportRunCompletion` maps the run's attempt
        // from this report instead of overwriting it. A runtime is finished by
        // its runner, delegated work by its report.
        if ([...taskRunnersByChat.values()].some((runner) => runner.taskId === row.id || runner.controllerTaskId === row.id)) {
          fail('A runtime owns this task and reports its outcome itself; finish your turn instead.')
        }
        plain(() => taskService.setStatus(profileUserId, row.id, target.status, target.label !== undefined ? { label: target.label } : {}))
        const { activeChatRunId } = await import('./chatRemoval')
        const runId = activeChatRunId(session.chatId)
        if (runId) noteAgentStatusReport(row.id, session.chatId, runId)
      } else {
        await plainAsync(() => taskAuthoringService.setStatus(scope, row.id, target.status, target.label))
      }
    }
    const after = taskRepo.getById(profileUserId, row.id) ?? row
    const relations: Relation[] = [...(after.assigneeAgentId === session.agentId ? ['assigned' as const] : []), ...(created ? ['created' as const] : [])]
    return summary(after, relations, delegationRepo.byTaskId(profileUserId, row.id))
  },

  async taskComment(session: DelegationSession, input: Record<string, unknown>): Promise<unknown> {
    validateSession(session)
    const { profileUserId, settingsUserId } = session.scope
    const row = requireTask(profileUserId, input.id)
    const body = text(input.body, 'body', TASK_COMMENT_MAX)
    const delegation = delegationRepo.byTaskId(profileUserId, row.id)
    const mine = row.assigneeAgentId === session.agentId || row.createdByAgentId === session.agentId ||
      delegation?.originAgentId === session.agentId
    if (!mine) fail('You can comment only on tasks assigned to you, created by you or delegated by you.')

    const comment = taskCommentRepo.create({ userId: profileUserId, taskId: row.id, authorKind: 'agent', authorAgentId: session.agentId, body, remoteStatus: 'pending' })
    const author = agentName(settingsUserId, session.agentId) ?? 'Agent'
    let copied: 'sent' | 'failed' | null = null
    try {
      const { taskSyncService } = await import('./taskSyncService')
      const sent = await taskSyncService.copyComment(profileUserId, row.id, {
        logEntry: formatFolderLogEntry({ author, at: comment.createdAt, body: comment.body }),
        remoteBody: `**${author}:** ${comment.body}`
      })
      copied = sent ? 'sent' : null
    } catch (error) {
      // Best effort: the comment is recorded here whatever its home said.
      copied = 'failed'
      logger.warn('a task comment could not be copied to its home', { taskId: row.id, commentId: comment.id, error: error instanceof Error ? error.message : String(error) })
    }
    // Null: the task has no home to copy comments to (a native task).
    taskCommentRepo.setRemoteStatus(profileUserId, comment.id, copied)
    return { commentId: comment.id, taskId: row.id, ...(copied === 'failed' ? { warning: 'Recorded in Cinna; the copy to the task’s file or service failed.' } : {}) }
  },

  /** `task:comments`: the task page's Comments list, oldest first. */
  comments(scope: { profileUserId: string; settingsUserId: string }, taskId: string): TaskCommentDto[] {
    const task = taskRepo.getById(scope.profileUserId, taskId)
    if (!task || task.deletedAt) return []
    const names = new Map<string, string | null>()
    return taskCommentRepo.listForTask(scope.profileUserId, taskId).map((row: TaskCommentRow) => {
      let authorName: string | null = null
      if (row.authorKind === 'agent' && row.authorAgentId) {
        if (!names.has(row.authorAgentId)) names.set(row.authorAgentId, agentName(scope.settingsUserId, row.authorAgentId))
        authorName = names.get(row.authorAgentId) ?? null
      }
      return { id: row.id, authorKind: row.authorKind, authorAgentId: row.authorAgentId, authorName, body: row.body, createdAt: row.createdAt, remoteStatus: row.remoteStatus ?? null }
    })
  }
}
