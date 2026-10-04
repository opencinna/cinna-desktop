import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ChevronsUp, MoreHorizontal } from 'lucide-react'
import type { TaskDto } from '../../../../shared/tasks'
import {
  CATEGORY_DROP_STATUS,
  TASK_STATUS_CATEGORIES,
  TASK_STATUS_CATEGORY_LABEL,
  taskStatusCategory,
  type TaskStatus,
  type TaskStatusCategory
} from '../../../../shared/taskStatus'
import { normalizeStatusWord, type TaskBoardColumn } from '../../../../shared/folderTasks'
import { useAgents } from '../../hooks/useAgents'
import { useOpenTask, useSetTaskStatus } from '../../hooks/useTasks'
import { unwrapIpcError } from '../../utils/ipcError'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'
import { usePopover } from '../ui/usePopover'
import { TaskStatusIcon } from './TaskStatusIcon'
import { TaskAssigneeChip, taskAssigneeAgent } from './TaskAssigneeChip'
import {
  boardMoveTargets,
  folderColumnIndex,
  folderMoveTargets,
  taskStatusLabel,
  taskStatusText
} from './tasksViewModel'
import { useTaskRowsInPlace } from './useTaskRowsInPlace'

const DRAG_TYPE = 'application/x-cinna-task'
/** As in the list: Done shows ten, then more on request. */
const DONE_PAGE = 10
const ALL = Number.MAX_SAFE_INTEGER

type AgentList = NonNullable<ReturnType<typeof useAgents>['data']>

/**
 * The Tasks view as a board: five columns in lifecycle order.
 *
 * Backlog, Ready and Done are the user's columns — dropping a card there writes
 * the column's status through `task:set-status`, so the transition table and
 * the device claim decide, not the board. Which of them a card may reach is
 * `boardMoveTargets` (`manualTargets` underneath), the same answer the Edit
 * dialog gives: a column the dragged card cannot reach shows the not-allowed
 * cursor, and so do In progress and Waiting, which a run or a question fills.
 * A card with nowhere to go (Done, or work a run holds) is not draggable and
 * has no ⋯.
 *
 * A drop moves the card at once and moves it back if main refuses, with main's
 * sentence in the view's error line (`onError`). Every movable card also has a
 * ⋯ with the same moves, for the keyboard.
 *
 * ## A folder board
 *
 * Filtered to one bare agent whose tasks live in its folder, the board is that
 * folder's own words instead (`folderColumns`, in the order main gives). A
 * card stands in the column of its own word, else in the first column of its
 * status, then of its category (`folderColumnIndex`); only `droppable`
 * columns take a drop. A task kept in a file sends the column's status **and
 * its word**, so the file gets the word the user dropped on; any other task
 * of the agent (a handover, a native task) has no word to write, so it is
 * offered one column per status it may reach and sends the status alone
 * (`folderMoveTargets`). While a card is dragged the
 * columns are held as they were at the drag's start: a poll that brings a new
 * word must not slide a column under the pointer (§1).
 */
export function TasksBoard({ tasks, onError, folderColumns = null }: {
  tasks: readonly TaskDto[]
  /** The view's one-line error slot under its controls; null clears it. */
  onError: (message: string | null) => void
  /** A folder's own columns, left to right; null (or empty) for the five categories. */
  folderColumns?: readonly TaskBoardColumn[] | null
}): React.JSX.Element {
  const setStatus = useSetTaskStatus()
  const { data: agents } = useAgents()
  /** Statuses written by a move that the next read has not confirmed yet. */
  const [moved, setMoved] = useState<ReadonlyMap<string, Override>>(new Map())
  const sequence = useRef(0)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  // A read ends an override once it shows the written status, or any status
  // other than the one the move started from — something newer than the move
  // (a run, another device) has spoken, and the read is the truth again.
  useEffect(() => {
    setMoved((current) => {
      if (current.size === 0) return current
      const next = new Map(current)
      for (const task of tasks) {
        const override = next.get(task.id)
        if (override && (task.status === override.status || task.status !== override.from)) next.delete(task.id)
      }
      return next.size === current.size ? current : next
    })
  }, [tasks])

  /** Drop this move's override — and only this move's: a later move of the same card keeps its own. */
  const settle = (taskId: string, seq: number): void => {
    setMoved((current) => {
      if (current.get(taskId)?.seq !== seq) return current
      const next = new Map(current)
      next.delete(taskId)
      return next
    })
  }

  const statusOf = (task: TaskDto): TaskStatus => moved.get(task.id)?.status ?? task.status
  /** The word a file task stands by: a pending move's, else its own. Null for a task with no file. */
  const wordOf = (task: TaskDto): string | null => {
    if (!task.file) return null
    const override = moved.get(task.id)
    return override ? (override.label ?? null) : task.statusLabel
  }
  /** The word a card shows: the moved-to column's while a move is unconfirmed, else its own. */
  const statusTextOf = (task: TaskDto): string => {
    const override = moved.get(task.id)
    if (!override) return taskStatusText(task)
    return override.label ?? taskStatusLabel(override.status)
  }

  // Held while a card is dragged, so a poll cannot add or reorder a column under the pointer.
  const [heldColumns, setHeldColumns] = useState<readonly TaskBoardColumn[] | null>(null)
  const folder = heldColumns ?? (folderColumns && folderColumns.length > 0 ? folderColumns : null)
  const specs = useMemo(() => (folder ? folder.map(folderSpec) : CATEGORY_SPECS), [folder])

  /** The columns this card may move to, by key. */
  const targetsOf = (task: TaskDto): ColumnSpec[] => {
    const status = statusOf(task)
    if (folder) {
      const keys = new Set(folderMoveTargets(task, status, folder, wordOf(task)).map((column) => normalizeStatusWord(column.label)))
      return specs.filter((spec) => keys.has(spec.key))
    }
    const categories = boardMoveTargets(task, status)
    return specs.filter((spec) => spec.category !== null && categories.includes(spec.category))
  }

  const move = async (task: TaskDto, spec: ColumnSpec): Promise<void> => {
    const drop = spec.drop
    if (!drop || !targetsOf(task).some((target) => target.key === spec.key)) return
    const { status } = drop
    // Only a task kept in a file takes the column's word; main refuses a word for any other.
    const label = task.file ? drop.label : undefined
    onError(null)
    const seq = ++sequence.current
    setMoved((current) => new Map(current).set(task.id, { status, label, seq, from: task.status }))
    try {
      const saved = await setStatus.mutateAsync({ taskId: task.id, status, ...(label !== undefined ? { label } : {}) })
      // Main answered with another status: show what it wrote, not what was asked.
      if (saved.status !== status) settle(task.id, seq)
    } catch (error) {
      settle(task.id, seq)
      onError(unwrapIpcError(error, 'This task could not be moved.'))
    }
  }

  const draggedTask = dragging ? tasks.find((task) => task.id === dragging) : undefined
  const dropKeys = new Set(draggedTask ? targetsOf(draggedTask).map((spec) => spec.key) : [])

  const columns = new Map<string, TaskDto[]>(specs.map((spec) => [spec.key, []]))
  for (const task of tasks) {
    const key = folder ? folderKeyOf(folder, statusOf(task), wordOf(task), !!task.file) : taskStatusCategory(statusOf(task))
    if (key !== null && columns.has(key)) columns.get(key)!.push(task)
  }

  return (
    // Five columns share the main area; it scrolls sideways only when the
    // window cannot give each its 10rem (800 px beside the sidebar). 10, not
    // 11: at the app's 17 px root, 11rem left 1280 px with the sidebar 56 px short.
    // A folder board has as many columns as the folder has words, at the same minimum.
    <div className="overflow-x-auto pb-2">
      <div
        data-tasks-board={folder ? 'folder' : 'categories'}
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${specs.length}, minmax(10rem, 1fr))` }}
      >
        {specs.map((spec) => (
          <BoardColumn
            key={spec.key}
            spec={spec}
            tasks={columns.get(spec.key)!}
            agents={agents ?? []}
            statusOf={statusOf}
            statusTextOf={statusTextOf}
            targetsOf={targetsOf}
            dragging={dragging}
            accepts={dropKeys.has(spec.key)}
            over={over === spec.key}
            onDragState={(id) => {
              setDragging(id)
              setHeldColumns(id ? folder : null)
              if (!id) setOver(null)
            }}
            onOver={(target) => setOver(target)}
            onMove={(task, target) => void move(task, target)}
            findTask={(id) => tasks.find((task) => task.id === id)}
          />
        ))}
      </div>
    </div>
  )
}

/** A move not yet confirmed by a read: what it wrote, which move it was, and the status it left. */
interface Override {
  status: TaskStatus
  /** The folder column's word the move sent, when it was a folder board move. */
  label?: string
  seq: number
  from: TaskStatus
}

/**
 * One board column, either kind: a category (phase-1 board) or a folder's own
 * word. `key` is the category or the normalized word; `drop` is what a drop
 * writes, null for a column nobody drops on (In progress, Waiting, an
 * unmapped word).
 */
interface ColumnSpec {
  key: string
  title: string
  /** The folder's word: shown as written, without small capitals. */
  asWritten: boolean
  /** The phase-1 category, for a category column; null on a folder board. */
  category: TaskStatusCategory | null
  /** Pages by ten, as Done does. */
  paged: boolean
  drop: { status: TaskStatus; label?: string } | null
  folder: TaskBoardColumn | null
}

const CATEGORY_SPECS: readonly ColumnSpec[] = TASK_STATUS_CATEGORIES.map((category) => {
  const status = CATEGORY_DROP_STATUS[category]
  return {
    key: category,
    title: TASK_STATUS_CATEGORY_LABEL[category],
    asWritten: false,
    category,
    paged: category === 'closed',
    drop: status ? { status } : null,
    folder: null
  }
})

function folderSpec(column: TaskBoardColumn): ColumnSpec {
  return {
    key: normalizeStatusWord(column.label),
    title: column.label,
    asWritten: true,
    category: null,
    paged: taskStatusCategory(column.status) === 'closed',
    drop: column.droppable ? { status: column.status, label: column.label } : null,
    folder: column
  }
}

/** The folder column a card stands in (`folderColumnIndex`), by its key. */
function folderKeyOf(
  columns: readonly TaskBoardColumn[],
  status: TaskStatus,
  label: string | null,
  inFile: boolean
): string | null {
  const index = folderColumnIndex(columns, status, label, inFile)
  return index >= 0 ? normalizeStatusWord(columns[index].label) : null
}

function BoardColumn({ spec, tasks, agents, statusOf, statusTextOf, targetsOf, dragging, accepts, over, onDragState, onOver, onMove, findTask }: {
  spec: ColumnSpec
  tasks: TaskDto[]
  agents: AgentList
  statusOf: (task: TaskDto) => TaskStatus
  statusTextOf: (task: TaskDto) => string
  targetsOf: (task: TaskDto) => ColumnSpec[]
  dragging: string | null
  /** The card being dragged may move here. */
  accepts: boolean
  over: boolean
  onDragState: (taskId: string | null) => void
  onOver: (key: string | null) => void
  onMove: (task: TaskDto, spec: ColumnSpec) => void
  findTask: (taskId: string) => TaskDto | undefined
}): React.JSX.Element {
  const label = spec.title
  const page = spec.paged ? DONE_PAGE : ALL
  const { ordered, head, rest, more, expanded, showMore } = useTaskRowsInPlace(tasks, page)
  return (
    <section
      aria-label={label}
      {...(spec.folder
        ? { 'data-folder-column': spec.folder.label, 'data-droppable': spec.folder.droppable ? 'true' : 'false' }
        : { 'data-board-column': spec.category ?? undefined })}
      onDragOver={(event) => {
        // Only a card of this board's: the drag state is set by its dragstart.
        if (!dragging) return
        if (!accepts) {
          // Not a drop target for this card: no preventDefault, and say so to the cursor.
          event.dataTransfer.dropEffect = 'none'
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (!over) onOver(spec.key)
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        if (over) onOver(null)
      }}
      onDrop={(event) => {
        if (!accepts) return
        event.preventDefault()
        const id = event.dataTransfer.getData(DRAG_TYPE) || dragging
        onOver(null)
        onDragState(null)
        const task = id ? findTask(id) : undefined
        if (task) onMove(task, spec)
      }}
      // An outline, not a border: the highlight must not resize the column (§1).
      className={`flex min-h-40 min-w-0 flex-col gap-2 rounded-lg bg-[var(--color-bg-secondary)]/50 p-2 outline outline-1 transition-colors ${
        over ? 'outline-[var(--color-accent)]' : 'outline-transparent'
      }`}
    >
      <h2 className={`flex items-center gap-2 px-1 text-[11px] font-semibold text-[var(--color-text-muted)] ${
        spec.asWritten ? '' : 'uppercase tracking-wider'
      }`}>
        <span className="min-w-0 truncate" title={spec.asWritten ? label : undefined}>{label}</span>
        <span className="font-normal tabular-nums">{ordered.length}</span>
      </h2>
      {head.map((task) => (
        <BoardCard
          key={task.id}
          task={task}
          status={statusOf(task)}
          statusText={statusTextOf(task)}
          targets={targetsOf(task)}
          agents={agents}
          onDragState={onDragState}
          onMove={(next) => onMove(task, next)}
        />
      ))}
      {/* The slot keeps its line once pressed; the rest goes below it (`useTaskRowsInPlace`). */}
      {more ? (
        <button type="button" onClick={showMore}
          className="px-1 text-left text-[13px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors">
          Show more tasks
        </button>
      ) : expanded && (
        <p className="px-1 text-[13px] text-[var(--color-text-muted)]">All {ordered.length} shown</p>
      )}
      {rest.map((task) => (
        <BoardCard
          key={task.id}
          task={task}
          status={statusOf(task)}
          statusText={statusTextOf(task)}
          targets={targetsOf(task)}
          agents={agents}
          onDragState={onDragState}
          onMove={(next) => onMove(task, next)}
        />
      ))}
    </section>
  )
}

function BoardCard({ task, status, statusText, targets, agents, onDragState, onMove }: {
  task: TaskDto
  status: TaskStatus
  /** The status as the card's name says it: the folder's word, or the category word. */
  statusText: string
  /** The columns this card may move to. */
  targets: readonly ColumnSpec[]
  agents: AgentList
  onDragState: (taskId: string | null) => void
  onMove: (spec: ColumnSpec) => void
}): React.JSX.Element {
  const openTask = useOpenTask()
  const movable = targets.length > 0
  const assigneeName = taskAssigneeAgent(task, agents)?.name
  return (
    <div
      data-task-card={task.id}
      draggable={movable}
      onDragStart={(event) => {
        if (!movable) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(DRAG_TYPE, task.id)
        // As ChatItem: a transparent idle card rasterizes white corners into the preview.
        ;(event.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-bg)'
        onDragState(task.id)
      }}
      onDragEnd={(event) => {
        ;(event.currentTarget as HTMLElement).style.backgroundColor = ''
        onDragState(null)
      }}
      className={`group flex min-w-0 items-start gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] transition-colors hover:border-[var(--color-text-muted)] ${
        movable ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => openTask(task.id)}
        aria-label={`${task.title} — ${statusText}`}
        className="min-w-0 flex-1 px-2.5 py-2 text-left"
      >
        <span className="flex items-start gap-2">
          <span className="mt-[3px]"><TaskStatusIcon status={status} /></span>
          <span className="min-w-0 flex-1 text-[13px] leading-5 text-[var(--color-text)] line-clamp-2" title={task.title}>
            {task.title}
          </span>
        </span>
        {(assigneeName || task.priority === 'high' || task.priority === 'urgent') && (
          <span className="mt-1.5 flex items-center gap-1.5 pl-[22px] text-[11px] text-[var(--color-text-muted)]">
            <TaskAssigneeChip task={task} />
            {task.priority === 'urgent' ? (
              <span title="Urgent" className="ml-auto shrink-0 text-[var(--color-danger)]">
                <ChevronsUp size={12} aria-label="Urgent" />
              </span>
            ) : task.priority === 'high' ? (
              <span title="High priority" className="ml-auto shrink-0 text-[var(--color-warning)]">
                <ArrowUp size={12} aria-label="High priority" />
              </span>
            ) : null}
          </span>
        )}
      </button>
      {movable && <CardMenu title={task.title} targets={targets} onMove={onMove} />}
    </div>
  )
}

/** The keyboard path for a drag: Move to each column this card may reach. */
function CardMenu({ title, targets, onMove }: {
  title: string
  targets: readonly ColumnSpec[]
  onMove: (spec: ColumnSpec) => void
}): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const { open, setOpen } = menu
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open, setOpen])
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${title}`}
        title="Move to…"
        className="mt-1.5 mr-1 shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && menu.style && createPortal(
        <div ref={menu.popoverRef} role="menu" aria-label="Task actions" style={menu.style}
          className={MENU_SURFACE.replace('w-56', 'w-44')}>
          {targets.map((spec) => (
            <button key={spec.key} type="button" role="menuitem" className={MENU_ITEM}
              onClick={() => { setOpen(false); onMove(spec) }}>
              Move to {spec.title}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
