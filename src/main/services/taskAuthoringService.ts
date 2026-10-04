import { agentOverrideRepo } from '../db/agents'
import { taskRepo } from '../db/tasks'
import { agentService } from './agentService'
import { taskService } from './taskService'
import { TaskError } from '../errors'
import type {
  TaskAssignee,
  TaskAssigneeInput,
  TaskCreateInput,
  TaskDto,
  TaskUpdateInput
} from '../../shared/tasks'
import type { TaskStatus } from '../../shared/taskStatus'
import { EMPTY_FOLDER_BOARD, folderLabelMapsTo, normalizeStatusWord } from '../../shared/folderTasks'

/**
 * Tasks a **person** writes down and edits by hand — the Tasks view's New task
 * and the task page's Edit task.
 *
 * A thin layer over {@link taskService}, separate for one reason: choosing an
 * agent as the assignee needs `agentService` to find it across the settings
 * and profile scopes, and `taskService` is imported by the app-sync apply path
 * (`sync/collections.ts`), which must not pull the whole agent stack in behind
 * it. Every rule about the task itself — the goal default aside — stays in
 * `taskService`: validation of custom fields, and when an assignee may change.
 */
export interface TaskAuthoringScope {
  profileUserId: string
  settingsUserId: string
}

/**
 * The stored assignee for a choice the user made. An agent must exist for
 * this profile and be enabled (the profile's override wins, as in Continue);
 * its name is stored as the display hint. "Default chat model" and "nobody
 * yet" are both `kind: 'model'` — the existing convention (`TaskAssignee`).
 */
function resolveAssignee(scope: TaskAuthoringScope, input: TaskAssigneeInput): TaskAssignee {
  if (input === null || input.kind === 'model') return { kind: 'model', agentId: null, name: null }
  const located = agentService.findAgent(scope.settingsUserId, scope.profileUserId, input.agentId)
  const enabled = located ? (agentOverrideRepo.get(scope.profileUserId, input.agentId)?.enabled ?? located.row.enabled) : false
  if (!located || !enabled) throw new TaskError('invalid_input', 'That agent is unavailable. Choose another agent.')
  return { kind: 'agent', agentId: located.row.id, name: located.row.name }
}

export const taskAuthoringService = {
  /**
   * A new task from the title alone, everything else defaulted here
   * (`ux_rules.md` §3): the goal is the title when none was written, it
   * starts in Backlog, local, run by this desktop on this device, routed
   * directly.
   */
  create(scope: TaskAuthoringScope, input: TaskCreateInput): TaskDto {
    return taskService.create(scope.profileUserId, this.prepare(scope, input).create)
  },

  /**
   * `task:create`: the same task, written **where it lives**. A task for an
   * enabled bare folder agent is written into that agent's `.cinna/tasks/`
   * and bound to the file (device-local, trusted); every other task — a kit
   * agent's, the model's, nobody's — is native, exactly as {@link create}.
   *
   * Async because asking which agents keep a folder queue reads the local
   * agent index, and writing the file is the adapter's. The sync stack is
   * imported on use: this module is also loaded where it must not pull it in.
   */
  async createRouted(
    scope: TaskAuthoringScope,
    input: TaskCreateInput,
    /**
     * What an agent's `task_create` adds: the parent in its own queue, and
     * the provenance (agent, chat, chain depth). Absent for a person's task.
     */
    extra: Pick<Parameters<typeof taskService.create>[1], 'parentTaskId' | 'createdByAgentId' | 'createdByChatId' | 'chainDepth'> = {}
  ): Promise<TaskDto> {
    const prepared = this.prepare(scope, input)
    const { assignee } = prepared
    const parentTaskId = input.parentTaskId === undefined ? undefined : this.checkParent(scope, input.parentTaskId, assignee)
    const create = { ...prepared.create, ...(parentTaskId ? { parentTaskId } : {}), ...extra }
    if (assignee.kind === 'agent' && assignee.agentId) {
      const { localHomeFor } = await import('../tasks/adapters')
      const home = await localHomeFor(assignee.agentId)
      if (home) {
        const { taskSyncService } = await import('./taskSyncService')
        return taskSyncService.createInHome(scope.profileUserId, home, create)
      }
    }
    return taskService.create(scope.profileUserId, create)
  },

  /**
   * The parent a person named for a new task (Add subtask): one in this
   * profile, not deleted or archived, with the same assignee as the new task
   * — a subtask is the same agent's work, and a folder subtask must live in
   * its parent's folder. Its id, or a refusal in words. One level only is
   * `taskService.create`'s rule.
   */
  checkParent(scope: TaskAuthoringScope, parentTaskId: string, assignee: TaskAssignee): string {
    const parent = taskRepo.getById(scope.profileUserId, parentTaskId)
    if (!parent || parent.deletedAt) throw new TaskError('not_found', 'The parent task no longer exists.')
    if (parent.status === 'archived') throw new TaskError('invalid_input', 'The parent task is archived; reopen it to add a subtask.')
    if (parent.assigneeKind !== assignee.kind || (parent.assigneeAgentId ?? null) !== (assignee.agentId ?? null)) {
      throw new TaskError('invalid_input', 'A subtask is assigned to its parent’s assignee.')
    }
    return parent.id
  },

  /** Validate and default a create once, for both entry points. */
  prepare(scope: TaskAuthoringScope, input: TaskCreateInput): { create: Parameters<typeof taskService.create>[1]; assignee: TaskAssignee } {
    const title = input.title.trim()
    if (!title) throw new TaskError('invalid_input', 'Title is required')
    const goal = input.goal?.trim() || title
    const description = input.description?.trim() || null
    const assignee = resolveAssignee(scope, input.assignee ?? null)
    return { assignee, create: {
      title,
      goal,
      description,
      status: input.status ?? 'new',
      priority: input.priority,
      router: 'direct',
      origin: 'local',
      executor: 'desktop',
      assigneeKind: assignee.kind,
      assigneeAgentId: assignee.agentId,
      assigneeName: assignee.name,
      customFields: input.customFields
    } }
  },

  /**
   * `task:set-status`: a person's move, optionally in the words of the task's
   * folder (`label`, from a folder board's column). The label must mean that
   * status in that folder; it is then what the file gets.
   *
   * A task whose home keeps no transition table (a file) is judged by the
   * manual overlay as an unbound task is — asked of its adapter's
   * capabilities here, since `taskService` cannot import the adapters.
   */
  async setStatus(scope: TaskAuthoringScope, taskId: string, status: TaskStatus, label?: string | null): Promise<TaskDto> {
    const row = taskService.getRow(scope.profileUserId, taskId)
    let bound: boolean | undefined
    if (row.remoteAdapter) {
      const { adapterFor } = await import('../tasks/adapters')
      bound = adapterFor(row.remoteAdapter).capabilities().transitionTable
    }
    let word: string | undefined
    if (label !== undefined && label !== null) {
      word = label.trim()
      if (!row.deviceLocal || !row.assigneeAgentId || !word) {
        throw new TaskError('invalid_input', 'Only a task kept in its agent’s folder takes a status word.')
      }
      const { taskSyncService } = await import('./taskSyncService')
      const columns = (await taskSyncService.folderBoard(scope.profileUserId, row.assigneeAgentId)) ?? []
      const normalized = normalizeStatusWord(word)
      const column = columns.find((candidate) => normalizeStatusWord(candidate.label) === normalized)
      const fits = column
        ? column.category !== null && column.status === status
        : folderLabelMapsTo(word, status, EMPTY_FOLDER_BOARD)
      if (!fits) throw new TaskError('invalid_input', `“${word.slice(0, 64)}” is not a ${status.replace(/_/g, ' ')} word in this folder.`)
    }
    return taskService.setStatus(scope.profileUserId, taskId, status, {
      manual: true,
      ...(bound !== undefined ? { bound } : {}),
      ...(word !== undefined ? { label: word } : {})
    })
  },

  /** An edit; only an assignee needs resolving before `taskService.update` decides. */
  update(scope: TaskAuthoringScope, taskId: string, input: TaskUpdateInput): TaskDto {
    const { assignee, ...rest } = input
    return taskService.update(scope.profileUserId, taskId, {
      ...rest,
      ...(assignee !== undefined ? { assignee: resolveAssignee(scope, assignee) } : {})
    })
  }
}
