import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { taskRepo, type TaskRow } from '../db/tasks'
import { delegationRepo, type DelegationRow } from '../db/delegations'
import { handoverRepo } from '../db/handovers'
import { taskCommentRepo, type TaskCommentRow } from '../db/taskComments'
import { taskRuntimeRepo } from '../db/taskRuntimes'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { scriptRuntimeRepo } from '../db/scriptRuntimes'
import { taskRunnersByChat } from './taskRunnerState'
import { delegationService, validateSession, type DelegationSession } from './delegationService'
import { localAgentService } from './localAgents/localAgentService'
import { noteAgentStatusReport } from '../tasks/agentStatusReports'
import { parseTaskReport } from '../tasks/taskReport'
import { decodeTaskTarget } from '../../shared/taskTargets'
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
  TASK_PROTOCOL_CATEGORIES,
  fromProtocolCategory,
  isTaskStatus,
  parseTaskStatus,
  taskStatusCategory,
  toProtocolCategory,
  type TaskProtocolCategory,
  type TaskStatus
} from '../../shared/taskStatus'
import { TASK_COMMENT_MAX, isTaskPriority, type TaskArtifact, type TaskCommentDto, type TaskCustomFields } from '../../shared/tasks'

/**
 * The Cinna Task Protocol's eight tools — `tasks_targets`, `tasks_list`,
 * `tasks_get`, `tasks_create`, `tasks_update`, `tasks_comment`,
 * `tasks_report`, `tasks_reply` — offered on the session loopback MCP
 * (`DelegationToolProvider`) to a folder agent's own chat or a human-routed
 * one, never a nested run.
 *
 * `tasks_create` with an `assignee` is a delegation and goes to
 * `delegationService.create` unchanged; without one (or naming the calling
 * agent) it puts a task in the agent's own queue — a file in a bare agent's
 * `.cinna/tasks/`, a native task for a kit agent. Every tool-created task
 * records the agent and its chain depth; a chat may create at most
 * {@link TASK_TOOL_CHAT_CAP} of them, own and delegated together.
 *
 * `tasks_report` is the only way an agent says how work went: through the
 * bus on a delegation executor's task, else written to the task with the mark
 * that keeps the turn's end from overwriting it.
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
 * One `tasks_create` at a time per chat. The cap is a count of rows, checked
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

const DELEGATED_REQUESTER = 'This task is work you delegated: answer or revise it with tasks_reply.'
const DELEGATED_EXECUTOR = 'This task is delegated work: report progress, questions and completion with tasks_report.'

/** Who the caller is on delegated work; null when the task has no delegation or file handover behind it. */
function delegatedRole(session: DelegationSession, row: TaskRow): 'requester' | 'executor' | null {
  const { profileUserId } = session.scope
  const delegation = delegationRepo.byTaskId(profileUserId, row.id)
  const handover = handoverRepo.byTaskId(profileUserId, row.id)
  if (!delegation && !handover) return null
  return (delegation?.originAgentId ?? handover?.originAgentId) === session.agentId ? 'requester' : 'executor'
}

/** Delegated work moves through its own tools, never `tasks_update`; null when the task is not delegated. */
function delegatedRefusal(session: DelegationSession, row: TaskRow): string | null {
  const role = delegatedRole(session, row)
  return role === null ? null : role === 'requester' ? DELEGATED_REQUESTER : DELEGATED_EXECUTOR
}

/** The task file relative to the agent folder, for a task kept in one. */
function fileOf(row: TaskRow): string | null {
  return row.localFile ? `${FOLDER_TASKS_DIR}/${basename(row.localFile.path)}` : null
}

function categoryOf(status: TaskStatus): TaskProtocolCategory | null {
  const category = taskStatusCategory(status)
  return category === null ? null : toProtocolCategory(category)
}

/** The delegation behind a task, as an agent reads it: where it stands and what came back. */
function delegationOf(delegation: DelegationRow | undefined) {
  if (!delegation) return null
  return {
    id: delegation.id,
    state: delegation.state,
    ...(delegation.resultStatus ? { resultStatus: delegation.resultStatus } : {}),
    ...(delegation.summary ? { summary: delegation.summary } : {}),
    ...(delegation.question ? { question: delegation.question } : {})
  }
}

function summary(row: TaskRow, relations: Relation[], delegation: DelegationRow | undefined) {
  const status = parseTaskStatus(row.status)
  return {
    ref: row.id,
    title: row.title,
    status,
    statusLabel: row.statusLabel ?? null,
    category: categoryOf(status),
    priority: row.priority,
    relations,
    assignee: { kind: row.assigneeKind, agentId: row.assigneeAgentId, name: row.assigneeName },
    parent: row.parentTaskId,
    file: fileOf(row),
    delegation: delegationOf(delegation)
  }
}

function requireTask(userId: string, ref: unknown): TaskRow {
  const taskId = text(ref, 'ref', 128)
  const row = taskRepo.getById(userId, taskId)
  if (!row || row.deletedAt) fail('No task with that ref.')
  return row
}

/** How a task concerns the calling agent; empty when it does not. */
function relationsOf(session: DelegationSession, row: TaskRow): Relation[] {
  const delegation = delegationRepo.byTaskId(session.scope.profileUserId, row.id)
  return [
    ...(row.assigneeAgentId === session.agentId ? ['assigned' as const] : []),
    ...(row.createdByAgentId === session.agentId ? ['created' as const] : []),
    ...(delegation?.originAgentId === session.agentId ? ['delegated' as const] : [])
  ]
}

/** The task `ref` names, or this chat's own task when it is left out. */
function taskOrCurrent(session: DelegationSession, current: TaskRow | undefined, ref: unknown): TaskRow {
  if (ref !== undefined) return requireTask(session.scope.profileUserId, ref)
  if (!current) fail('This conversation is not working on a task; pass ref.')
  return current
}

/** A file or link the agent named, relative to its own folder unless absolute or a URL. */
function artifactOf(folder: string, artifact: { kind?: 'file' | 'link'; name?: string; ref: string }): TaskArtifact {
  const link = /^https?:\/\//.test(artifact.ref)
  const ref = link || isAbsolute(artifact.ref) ? artifact.ref : join(folder, artifact.ref)
  return { kind: artifact.kind ?? (link ? 'link' : 'file'), name: artifact.name ?? basename(artifact.ref), ref }
}

/** The status a report sets: the protocol's words onto the task's column. */
function statusForReport(status: 'in_progress' | 'blocked' | 'done' | 'failed'): TaskStatus {
  return status === 'done' ? 'completed' : status === 'failed' ? 'error' : status
}

/**
 * The last report written to each task by the own-task path, so an identical
 * repeat returns what the first call answered and writes nothing. In memory:
 * a restart forgets it, and a repeat after one rewrites the same values.
 */
const lastReports = new Map<string, { digest: string; result: unknown }>()

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

/** `tasks_create`, run only through {@link serializedInChat}. */
async function createTask(session: DelegationSession, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const assignee = input.assignee === undefined
    ? undefined
    : decodeTaskTarget(input.assignee) ?? fail('Choose a target from tasks_targets and pass its target string verbatim as assignee.')
  // Naming yourself (a local target: no adapter) is your own queue.
  const self = !!assignee && assignee.kind !== 'cloud' && assignee.agentId === session.agentId
  if (assignee !== undefined && !self) {
    if (input.parent !== undefined) fail('parent applies to your own queue; leave it out when delegating.')
    // The delegation request: the brief is the description. A bare folder's
    // brief also carries the priority and custom fields.
    const request: Record<string, unknown> = {
      target: assignee,
      id: input.id,
      title: input.title,
      brief: input.description,
      ...(input.priority !== undefined ? { priority: priorityOf(input.priority) } : {}),
      ...(input.custom_fields !== undefined ? { customFields: customFieldsOf(input.custom_fields) } : {}),
      ...(input.execution !== undefined ? { execution: input.execution } : {}),
      ...(input.group !== undefined ? { group: input.group } : {}),
      ...(input.category !== undefined ? { status: input.category } : {})
    }
    const created = await delegationService.create(session, request, signal, { beforeNew: () => assertChatCap(session) })
    // The delegated task's ref, for tasks_get, tasks_comment and tasks_reply.
    const taskId = (created as { taskId?: unknown } | null)?.taskId
    return typeof taskId === 'string' ? { ref: taskId, ...(created as object) } : created
  }

  for (const key of ['id', 'execution', 'group'] as const) {
    if (input[key] !== undefined) fail(`${key} applies only when delegating to another agent (with an assignee).`)
  }
  const title = text(input.title, 'title', 300, true)
  const description = text(input.description, 'description', 100_000)
  const priority = priorityOf(input.priority)
  const customFields = customFieldsOf(input.custom_fields)
  if (input.category !== undefined && input.category !== 'backlog' && input.category !== 'ready') {
    fail('Choose category backlog or ready for your own queue; draft is for a delegation to a folder agent.')
  }
  const status: TaskStatus = input.category === 'ready' ? 'open' : 'new'

  const { task } = validateSession(session)
  const { profileUserId, settingsUserId } = session.scope
  // One deeper than the chat's task — and a chat with no task is the root, so
  // its first task is at depth 1, as a delegation from it is.
  const depth = (task ? depthOf(profileUserId, task) : 0) + 1
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
  return row ? summary(row, ['assigned', 'created'], undefined) : { ref: created.id, title: created.title, status: created.status }
}

/**
 * `tasks_comment.files`: paths inside the agent's folder, each an existing
 * file. Checked before anything is posted.
 */
function filesOf(folder: string, value: unknown): TaskArtifact[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20 || !value.every((item) => typeof item === 'string' && item.trim() && item.length <= 1024)) {
    fail('files must be a list of at most 20 paths relative to your folder.')
  }
  return (value as string[]).map((path) => {
    const absolute = resolve(folder, path)
    const inside = relative(folder, absolute)
    if (isAbsolute(path) || inside.startsWith('..') || isAbsolute(inside)) fail(`“${path}” is outside your folder; attach files from inside it.`)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`There is no file at “${path}”; nothing was posted.`)
    return { kind: 'file' as const, name: basename(absolute), ref: absolute }
  })
}

/** What a manual move may not be: a statement of how work went, which is `tasks_report`'s. */
const REPORT_WORDS = new Set(['completed', 'blocked', 'error', 'in_progress', 'failed'])
const REPORT_STATUSES = new Set<TaskStatus>(['in_progress', 'blocked', 'error'])

/** A move that closes a task: Done, Failed or Cancelled. */
const CLOSING_STATUSES = new Set<TaskStatus>(['completed', 'error', 'cancelled'])

/**
 * Whether a task has been worked, so only `tasks_report` may close it: the
 * dispatcher owns it, a conversation ran it, an ask on it is open, it is a
 * delegation's or a handover's target, or a run is in flight on it. A
 * never-run task keeps every move a person could make.
 */
async function worked(session: DelegationSession, row: TaskRow): Promise<boolean> {
  const { profileUserId } = session.scope
  if (row.dispatchAgentId || row.chatId) return true
  if (taskInputRequestRepo.listOpenForTask(row.id).length > 0) return true
  if (delegationRepo.byTaskId(profileUserId, row.id) || handoverRepo.byTaskId(profileUserId, row.id)) return true
  if ([...taskRunnersByChat.values()].some((runner) => runner.taskId === row.id || runner.controllerTaskId === row.id)) return true
  return !!(taskRuntimeRepo.get(profileUserId, row.id) || scriptRuntimeRepo.owner(profileUserId, row.id))
}

export const taskToolService = {
  /** `tasks_targets`: who the agent can delegate to, with the string to pass as `assignee`. */
  tasksTargets(session: DelegationSession, signal?: AbortSignal) {
    return delegationService.targets(session, signal)
  },

  tasksList(session: DelegationSession, input: Record<string, unknown>) {
    validateSession(session)
    const relation = input.relation ?? 'all'
    if (relation !== 'all' && !RELATIONS.includes(relation as Relation)) fail('Choose relation: assigned, created, delegated or all.')
    const wanted = input.category as TaskProtocolCategory | undefined
    if (wanted !== undefined && !TASK_PROTOCOL_CATEGORIES.includes(wanted)) {
      fail(`Choose a category: ${TASK_PROTOCOL_CATEGORIES.join(', ')}.`)
    }
    const category = wanted === undefined ? undefined : fromProtocolCategory(wanted)
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

  /** `tasks_get`: one task in full, if it concerns the caller (as `tasks_list` would show it) or is this chat's. */
  async tasksGet(session: DelegationSession, input: Record<string, unknown>) {
    const { task: current } = validateSession(session)
    const { profileUserId, settingsUserId } = session.scope
    const row = requireTask(profileUserId, input.ref)
    const relations = relationsOf(session, row)
    if (relations.length === 0 && current?.id !== row.id) fail('You can read only tasks assigned to you, created by you or delegated by you.')
    const { taskService } = await import('./taskService')
    const dto = taskService.getById(profileUserId, row.id)
    const status = dto.status
    const outbound = delegationRepo.listForOriginTask(profileUserId, row.id).filter((link) => link.taskId)
    return {
      ref: dto.id,
      title: dto.title,
      goal: dto.goal,
      description: dto.description,
      status,
      statusLabel: dto.statusLabel,
      category: categoryOf(status),
      priority: dto.priority,
      relations,
      assignee: { kind: dto.assignee.kind, agentId: dto.assignee.agentId, name: dto.assignee.name },
      parent: dto.parentTaskId,
      blocked_by: dto.blockedBy.map((blocker) => ({ id: blocker.id, ref: blocker.taskId, title: blocker.title, status: blocker.status })),
      custom_fields: dto.customFields ?? {},
      file: fileOf(row),
      comments: this.comments({ profileUserId, settingsUserId }, row.id).slice(-10).map((comment) => ({
        author: comment.authorName ?? (comment.authorKind === 'agent' ? 'Agent' : 'User'),
        at: comment.createdAt,
        body: comment.body
      })),
      report: dto.handoffNote || dto.artifacts.length > 0 || dto.errorMessage
        ? { note: dto.handoffNote, artifacts: dto.artifacts, ...(dto.errorMessage ? { error: dto.errorMessage } : {}) }
        : null,
      delegation: delegationOf(delegationRepo.byTaskId(profileUserId, row.id)),
      delegations: outbound.map((link) => ({ ref: link.taskId, title: link.title, ...delegationOf(link)! }))
    }
  },

  tasksCreate(session: DelegationSession, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return serializedInChat(session.chatId, () => createTask(session, input, signal))
  },

  async tasksUpdate(session: DelegationSession, input: Record<string, unknown>): Promise<unknown> {
    const { task: current } = validateSession(session)
    const { profileUserId, settingsUserId } = session.scope
    const row = requireTask(profileUserId, input.ref)
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
    const target = input.category !== undefined ? await resolveStatus(session, row, input.category) : null
    // A move a person makes, never a statement of how the work went.
    if (target && (REPORT_WORDS.has(normalizeStatusWord(String(input.category))) || REPORT_STATUSES.has(target.status) ||
      (isCurrent && target.status === 'completed'))) {
      fail('To say how your work on a task went (done, failed, blocked, in progress), use tasks_report; tasks_update only edits fields and makes a person’s moves.')
    }
    // Closing work that ran is a statement of how it went, whoever asks.
    if (target && CLOSING_STATUSES.has(target.status) && await worked(session, row)) {
      fail('This task has been worked on, so tasks_update cannot close it (done, failed or cancelled): say how the work went with tasks_report, or leave cancelling to the user. tasks_update may still move it between Backlog and Ready.')
    }
    const scope = { profileUserId, settingsUserId }
    const { taskAuthoringService } = await import('./taskAuthoringService')
    if (Object.keys(patch).length > 0) plain(() => taskAuthoringService.update(scope, row.id, patch))
    if (target) await plainAsync(() => taskAuthoringService.setStatus(scope, row.id, target.status, target.label))

    const after = taskRepo.getById(profileUserId, row.id) ?? row
    const relations: Relation[] = [...(after.assigneeAgentId === session.agentId ? ['assigned' as const] : []), ...(created ? ['created' as const] : [])]
    return summary(after, relations, delegationRepo.byTaskId(profileUserId, row.id))
  },

  /**
   * `tasks_report`: how the work on a task is going or how it ended. On a
   * delegation executor's own task it goes through the bus as a delegation
   * result. On any other task of this chat — hand-opened, dispatched, a job
   * run's — it is written to the task (handoff note, artifacts, status), and
   * the mark keeps this turn's end from settling over it: the dispatcher's
   * report rule, the job run's attempt and the turn end all read that.
   */
  async tasksReport(session: DelegationSession, input: Record<string, unknown>): Promise<unknown> {
    const { task: current, source } = validateSession(session)
    const { profileUserId } = session.scope
    const row = taskOrCurrent(session, current, input.ref)
    const isCurrent = current?.id === row.id

    const role = delegatedRole(session, row)
    if (role === 'requester') fail(DELEGATED_REQUESTER)
    if (role === 'executor') {
      if (!isCurrent) fail('Report on delegated work from the conversation working on it.')
      const handover = delegationRepo.byTaskId(profileUserId, row.id) ? undefined : handoverRepo.byTaskId(profileUserId, row.id)
      if (!handover) return plainAsync(() => delegationService.report(session, input))
      // A folder brief with no delegation behind it: the handover's own report
      // path, as a report.md would, without needing the file.
      const report = parseTaskReport(input, 'requester')
      const folder = handover.folderPath
      const links = report.artifacts.filter((artifact) => /^https?:\/\//.test(artifact.ref))
      const files = report.artifacts.filter((artifact) => !links.includes(artifact))
        .map((artifact) => relative(folder, isAbsolute(artifact.ref) ? artifact.ref : join(source.path, artifact.ref)))
      const body = [report.body, ...links.map((link) => `- ${link.name ?? link.ref}: ${link.ref}`)].filter(Boolean).join('\n\n')
      const { handoverService } = await import('./handoverService')
      plain(() => handoverService.applyReport(session.scope, handover, { status: report.status, summary: report.summary, question: report.question, artifacts: files, body }))
      return { handoverId: handover.id, ref: row.id, status: report.status }
    }

    if (!isCurrent) {
      if (row.assigneeAgentId !== session.agentId && !(row.createdByAgentId === session.agentId && !row.chatId)) {
        fail('You can report only on this conversation’s task, or on a task assigned to you.')
      }
      const refusal = await ownedElsewhere(session, row)
      if (refusal) fail(refusal)
    }
    // A runtime is finished by its runner, not by its agent.
    if ([...taskRunnersByChat.values()].some((runner) => runner.taskId === row.id || runner.controllerTaskId === row.id)) {
      fail('A runtime owns this task and reports its outcome itself; finish your turn instead.')
    }
    const report = parseTaskReport(input, 'user')
    if (report.audience === 'requester') fail('No agent asked for this task, so there is no requester; leave audience out or choose user.')

    const status = statusForReport(report.status)
    const digest = createHash('sha256').update(JSON.stringify([report.status, report.summary, report.question, report.body, report.artifacts])).digest('hex')
    // The mark keeps this turn's end from settling over the report — also for
    // an identical repeat in a later turn, which writes nothing else.
    const markReported = async (): Promise<void> => {
      if (!isCurrent) return
      const { activeChatRunId } = await import('./chatRemoval')
      const runId = activeChatRunId(session.chatId)
      if (runId) noteAgentStatusReport(row.id, session.chatId, runId)
    }
    const stored = lastReports.get(row.id)
    if (stored?.digest === digest && row.status === status) {
      await markReported()
      return stored.result
    }

    // Summary first, then the question and the full answer: the note the task page and the next agent read.
    const note = [report.summary, report.question ? `Question: ${report.question}` : '', report.body].filter(Boolean).join('\n\n')
    const { taskService } = await import('./taskService')
    plain(() => taskService.setHandoffNote(profileUserId, row.id, note))
    if (report.artifacts.length > 0) {
      plain(() => taskService.setArtifacts(profileUserId, row.id, report.artifacts.map((artifact) => artifactOf(source.path, artifact))))
    }
    if (row.status !== status) plain(() => taskService.setStatus(profileUserId, row.id, status))
    await markReported()
    const after = taskRepo.getById(profileUserId, row.id) ?? row
    const result = { ref: row.id, status: report.status, taskStatus: after.status, category: categoryOf(parseTaskStatus(after.status)) }
    lastReports.set(row.id, { digest, result })
    return result
  },

  /** `tasks_reply`: an answer or follow-up to work the agent delegated, by the delegated task's ref. */
  tasksReply(session: DelegationSession, input: Record<string, unknown>): Promise<unknown> {
    return plainAsync(() => delegationService.reply(session, input))
  },

  async tasksComment(session: DelegationSession, input: Record<string, unknown>): Promise<unknown> {
    const { task: current, source } = validateSession(session)
    const { profileUserId, settingsUserId } = session.scope
    const row = taskOrCurrent(session, current, input.ref)
    const body = text(input.body, 'body', TASK_COMMENT_MAX)
    const delegation = delegationRepo.byTaskId(profileUserId, row.id)
    const mine = row.assigneeAgentId === session.agentId || row.createdByAgentId === session.agentId ||
      delegation?.originAgentId === session.agentId
    if (!mine) fail('You can comment only on tasks assigned to you, created by you or delegated by you.')

    // Files are checked before anything is posted: a missing one, or a task
    // with nowhere to keep them, fails the call and posts nothing.
    const files = filesOf(source.path, input.files)
    const { taskSyncService } = await import('./taskSyncService')
    if (files.length > 0 && !taskSyncService.canAttachFiles(profileUserId, row.id)) fail('Attachments are not supported for this task.')

    const comment = taskCommentRepo.create({ userId: profileUserId, taskId: row.id, authorKind: 'agent', authorAgentId: session.agentId, body, remoteStatus: 'pending' })
    const author = agentName(settingsUserId, session.agentId) ?? 'Agent'
    let copied: 'sent' | 'failed' | null = null
    try {
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
    let attached = false
    if (files.length > 0) {
      try {
        await taskSyncService.attachFiles(profileUserId, row.id, files)
        attached = true
      } catch (error) {
        logger.warn('files could not be attached to a task', { taskId: row.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const warnings = [
      ...(copied === 'failed' ? ['Recorded in Cinna; the copy to the task’s file or service failed.'] : []),
      ...(files.length > 0 && !attached ? ['The files could not be attached to the task’s service.'] : [])
    ]
    return {
      commentId: comment.id,
      ref: row.id,
      ...(attached ? { attached: files.map((file) => file.name) } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {})
    }
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
