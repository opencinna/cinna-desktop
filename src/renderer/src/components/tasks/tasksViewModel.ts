import type { TaskCustomFieldValue, TaskDto } from '../../../../shared/tasks'
import {
  canMoveManually,
  isTaskStatus,
  manualTargets,
  taskStatusCategory,
  type TaskStatus,
  type TaskStatusCategory
} from '../../../../shared/taskStatus'
import {
  folderCategoryForStatus,
  normalizeStatusWord,
  type TaskBoardColumn
} from '../../../../shared/folderTasks'

/**
 * The pure half of the Tasks view: the agent filter, the search, and which
 * tasks the board lets a user move. Kept out of the components so the rules
 * are read in one place and tested without rendering.
 */

/** `all`, `none` (no agent), or `agent:<id>` for an agent assignee. */
export type TaskAgentFilter = string

export const ALL_AGENTS: TaskAgentFilter = 'all'
export const UNASSIGNED: TaskAgentFilter = 'none'

/** An agent (local or remote) by assignee; everything else is "No agent" (model, person, script). */
export function taskAgentKey(task: Pick<TaskDto, 'assignee'>): TaskAgentFilter {
  const { kind, agentId } = task.assignee
  return (kind === 'agent' || kind === 'remote_agent') && agentId ? `agent:${agentId}` : UNASSIGNED
}

/**
 * The agent filter's options: every agent that has a task, by the name the
 * agents list gives it now (else the name stored on the task), A→Z.
 */
export function agentFilterOptions(
  tasks: readonly Pick<TaskDto, 'assignee'>[],
  agentName: (agentId: string) => string | undefined
): { value: TaskAgentFilter; label: string }[] {
  const seen = new Map<string, string>()
  for (const task of tasks) {
    const key = taskAgentKey(task)
    if (key === UNASSIGNED || seen.has(key)) continue
    const id = task.assignee.agentId!
    seen.set(key, agentName(id) ?? task.assignee.name ?? 'Unnamed agent')
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function matchesTaskFilters(
  task: Pick<TaskDto, 'assignee' | 'title'>,
  agent: TaskAgentFilter,
  search: string
): boolean {
  if (agent !== ALL_AGENTS && taskAgentKey(task) !== agent) return false
  const query = search.trim().toLowerCase()
  return !query || task.title.toLowerCase().includes(query)
}

/** The list view's section order: what needs the user first, finished work last. */
export const LIST_SECTION_ORDER: readonly TaskStatusCategory[] = ['waiting', 'active', 'ready', 'backlog', 'closed']

/** The columns a user may drop into; Active and Waiting are put there by a run or a question. */
export function isUserColumn(category: TaskStatusCategory): boolean {
  return category === 'backlog' || category === 'ready' || category === 'closed'
}

/**
 * The columns the user may move this task to, from the status it shows now:
 * the user columns `manualTargets` reaches, other than the one it is in. Empty
 * — no drag, no ⋯ — for work this desktop does not hold (the claim), a task a
 * runtime drives, a task a run or a question holds (In progress, Waiting), and
 * one with nowhere to go (Done, Cancelled). Main is the authority —
 * `task:set-status` checks the table and the claim again.
 */
export function boardMoveTargets(
  task: Pick<TaskDto, 'executor' | 'runsHere' | 'runtime' | 'remote'> & Partial<Pick<TaskDto, 'file'>>,
  status: TaskStatus
): TaskStatusCategory[] {
  if (task.executor !== 'desktop' || !task.runsHere || task.runtime) return []
  const here = taskStatusCategory(status)
  const out: TaskStatusCategory[] = []
  for (const target of manualTargets(status, { bound: isTableBound(task) })) {
    const category = taskStatusCategory(target)
    if (category && category !== here && isUserColumn(category) && !out.includes(category)) out.push(category)
  }
  return out
}

/**
 * Whether a manual move is judged by a remote transition table. A task bound
 * to a service is; a task kept in a folder file is bound too (`remote` is the
 * `folder` adapter) but a file keeps no table, so it moves by the unbound
 * overlay — the answer main gives from the adapter's capabilities.
 */
export function isTableBound(task: Pick<TaskDto, 'remote'> & Partial<Pick<TaskDto, 'file'>>): boolean {
  return task.remote != null && !task.file
}

/**
 * The folder board columns this task may move to. The same preconditions as
 * {@link boardMoveTargets}: work this desktop holds and no runtime drives.
 *
 * A task kept in a file: droppable columns of another status than the one it
 * shows, a move a person may make from there (`canMoveManually`, unbound — a
 * file keeps no table). When its own word has no droppable column of its own
 * (an unmapped `parked`, or no word at all), the droppable columns of its own
 * status are open to it too, other than the one it stands in, so a stray word
 * can be turned into a proper one from Cinna.
 *
 * Any other task of the agent (a handover, a delegation, a native task) has
 * no word main would write: it reaches the statuses {@link boardMoveTargets}
 * gives it, each through the first column of that status, and its move sends
 * no word.
 */
export function folderMoveTargets(
  task: Pick<TaskDto, 'executor' | 'runsHere' | 'runtime' | 'remote'> & Partial<Pick<TaskDto, 'file' | 'statusLabel'>>,
  status: TaskStatus,
  columns: readonly TaskBoardColumn[],
  /** The word the card shows now, when a pending move has replaced the task's own. */
  label: string | null | undefined = task.statusLabel
): TaskBoardColumn[] {
  if (task.executor !== 'desktop' || !task.runsHere || task.runtime) return []
  if (!task.file) {
    const here = taskStatusCategory(status)
    const out: TaskBoardColumn[] = []
    for (const target of manualTargets(status, { bound: isTableBound(task) })) {
      const category = taskStatusCategory(target)
      if (!category || category === here || !isUserColumn(category)) continue
      const column = columns.find((candidate) => candidate.status === target)
      if (column && column.droppable && !out.includes(column)) out.push(column)
    }
    return out
  }
  const word = label ? normalizeStatusWord(label) : ''
  const own = word ? columns.find((column) => normalizeStatusWord(column.label) === word) : undefined
  const stray = !own || !own.droppable
  const standing = columns[folderColumnIndex(columns, status, label, true)]
  return columns.filter((column) => {
    if (!column.droppable) return false
    if (column.status === status) return stray && column !== standing
    return canMoveManually(status, column.status, { bound: false })
  })
}

/**
 * Which folder board column a task stands in. A task kept in a file: the
 * column of its own word (normalized); without one, or with a word no column
 * has, the first column of its status, then the first of its category. Any
 * other task of the agent has no word: the first column of its status, then
 * of its category. The first column is the last resort; -1 only for a board
 * with no columns.
 */
export function folderColumnIndex(
  columns: readonly TaskBoardColumn[],
  status: TaskStatus,
  label: string | null | undefined,
  inFile: boolean
): number {
  const word = inFile && label ? normalizeStatusWord(label) : ''
  if (word) {
    const exact = columns.findIndex((column) => normalizeStatusWord(column.label) === word)
    if (exact >= 0) return exact
  }
  const byStatus = columns.findIndex((column) => column.status === status)
  if (byStatus >= 0) return byStatus
  const category = folderCategoryForStatus(status)
  const byCategory = columns.findIndex((column) => column.category === category)
  if (byCategory >= 0) return byCategory
  return columns.length > 0 ? 0 : -1
}

/** A task file's name (`fix-login.md`); the full path goes in the title. */
export function taskFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}

/** A custom field's value as one line of text: scalars as written, lists comma-joined. */
export function customFieldText(value: TaskCustomFieldValue): string {
  if (value === null) return ''
  if (Array.isArray(value)) return value.map(String).join(', ')
  return String(value)
}

/**
 * A status in the words the user reads — the Tasks view's category words, so
 * the task page, the dialog, a row's spoken name and the board say one thing
 * (`ux_rules.md` §13). The closed category splits back into its three
 * outcomes, because Done, Failed and Cancelled are different answers.
 */
const STATUS_LABEL: Record<TaskStatus, string> = {
  new: 'Backlog',
  refining: 'Backlog',
  open: 'Ready',
  in_progress: 'In progress',
  blocked: 'Waiting',
  completed: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
  archived: 'Archived'
}

/**
 * `status` is a string, not a {@link TaskStatus}: the cinna run screen's pill
 * can carry a value this build predates (`succeeded`), which prints itself in
 * words rather than being guessed at.
 */
export function taskStatusLabel(status: string): string {
  if (isTaskStatus(status)) return STATUS_LABEL[status]
  const words = status.toLowerCase().replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A task's status as the user reads it: its home's own word when it has one
 * (a folder's `doing`, `Up Next`), as written; else {@link taskStatusLabel}.
 * Colour and grouping still come from `status`.
 */
export function taskStatusText(task: { status: string; statusLabel?: string | null }): string {
  const label = task.statusLabel?.trim()
  return label ? label : taskStatusLabel(task.status)
}

/**
 * A `model` assignee with no conversation has nobody on it yet: main stores
 * "no agent" as the default chat model, and until a chat runs it the task is
 * simply Unassigned — the word the filter and the dialogs use.
 */
export function isUnassigned(task: Pick<TaskDto, 'assignee' | 'chatId'>): boolean {
  return task.assignee.kind === 'model' && !task.chatId
}
