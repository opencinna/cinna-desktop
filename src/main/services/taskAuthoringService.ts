import { agentOverrideRepo } from '../db/agents'
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
    const title = input.title.trim()
    if (!title) throw new TaskError('invalid_input', 'Title is required')
    const goal = input.goal?.trim() || title
    const description = input.description?.trim() || null
    const assignee = resolveAssignee(scope, input.assignee ?? null)
    return taskService.create(scope.profileUserId, {
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
