import { useEffect, useRef, useState } from 'react'
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
import { useAgents } from '../../hooks/useAgents'
import { useOpenTask, useSetTaskStatus } from '../../hooks/useTasks'
import { unwrapIpcError } from '../../utils/ipcError'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'
import { usePopover } from '../ui/usePopover'
import { TaskStatusIcon } from './TaskStatusIcon'
import { TaskAssigneeChip, taskAssigneeAgent } from './TaskAssigneeChip'
import { boardMoveTargets, taskStatusLabel } from './tasksViewModel'
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
 */
export function TasksBoard({ tasks, onError }: {
  tasks: readonly TaskDto[]
  /** The view's one-line error slot under its controls; null clears it. */
  onError: (message: string | null) => void
}): React.JSX.Element {
  const setStatus = useSetTaskStatus()
  const { data: agents } = useAgents()
  /** Statuses written by a move that the next read has not confirmed yet. */
  const [moved, setMoved] = useState<ReadonlyMap<string, Override>>(new Map())
  const sequence = useRef(0)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<TaskStatusCategory | null>(null)

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

  const move = async (task: TaskDto, category: TaskStatusCategory): Promise<void> => {
    const status = CATEGORY_DROP_STATUS[category]
    if (!status || !boardMoveTargets(task, statusOf(task)).includes(category)) return
    onError(null)
    const seq = ++sequence.current
    setMoved((current) => new Map(current).set(task.id, { status, seq, from: task.status }))
    try {
      const saved = await setStatus.mutateAsync({ taskId: task.id, status })
      // Main answered with another status: show what it wrote, not what was asked.
      if (saved.status !== status) settle(task.id, seq)
    } catch (error) {
      settle(task.id, seq)
      onError(unwrapIpcError(error, 'This task could not be moved.'))
    }
  }

  const draggedTask = dragging ? tasks.find((task) => task.id === dragging) : undefined
  const dropTargets = draggedTask ? boardMoveTargets(draggedTask, statusOf(draggedTask)) : []

  const columns = new Map<TaskStatusCategory, TaskDto[]>(TASK_STATUS_CATEGORIES.map((category) => [category, []]))
  for (const task of tasks) {
    const category = taskStatusCategory(statusOf(task))
    if (category) columns.get(category)!.push(task)
  }

  return (
    // Five columns share the main area; it scrolls sideways only when the
    // window cannot give each its 10rem (800 px beside the sidebar). 10, not
    // 11: at the app's 17 px root, 11rem left 1280 px with the sidebar 56 px short.
    <div className="overflow-x-auto pb-2">
      <div className="grid grid-cols-[repeat(5,minmax(10rem,1fr))] gap-3">
        {TASK_STATUS_CATEGORIES.map((category) => (
          <BoardColumn
            key={category}
            category={category}
            tasks={columns.get(category)!}
            agents={agents ?? []}
            statusOf={statusOf}
            dragging={dragging}
            accepts={dropTargets.includes(category)}
            over={over === category}
            onDragState={(id) => { setDragging(id); if (!id) setOver(null) }}
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
  seq: number
  from: TaskStatus
}

function BoardColumn({ category, tasks, agents, statusOf, dragging, accepts, over, onDragState, onOver, onMove, findTask }: {
  category: TaskStatusCategory
  tasks: TaskDto[]
  agents: AgentList
  statusOf: (task: TaskDto) => TaskStatus
  dragging: string | null
  /** The card being dragged may move here. */
  accepts: boolean
  over: boolean
  onDragState: (taskId: string | null) => void
  onOver: (category: TaskStatusCategory | null) => void
  onMove: (task: TaskDto, category: TaskStatusCategory) => void
  findTask: (taskId: string) => TaskDto | undefined
}): React.JSX.Element {
  const label = TASK_STATUS_CATEGORY_LABEL[category]
  const page = category === 'closed' ? DONE_PAGE : ALL
  const { ordered, visible, expanded, showMore, sectionRef } = useTaskRowsInPlace(tasks, page, '[data-tasks-scroll]')
  return (
    <section
      ref={sectionRef}
      aria-label={label}
      data-board-column={category}
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
        if (!over) onOver(category)
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
        if (task) onMove(task, category)
      }}
      // An outline, not a border: the highlight must not resize the column (§1).
      className={`flex min-h-40 min-w-0 flex-col gap-2 rounded-lg bg-[var(--color-bg-secondary)]/50 p-2 outline outline-1 transition-colors ${
        over ? 'outline-[var(--color-accent)]' : 'outline-transparent'
      }`}
    >
      <h2 className="flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
        <span className="font-normal tabular-nums">{ordered.length}</span>
      </h2>
      {ordered.slice(0, visible).map((task) => (
        <BoardCard
          key={task.id}
          task={task}
          status={statusOf(task)}
          agents={agents}
          onDragState={onDragState}
          onMove={(next) => onMove(task, next)}
        />
      ))}
      {ordered.length > visible ? (
        <button type="button" onClick={showMore}
          className="px-1 text-left text-[13px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors">
          Show more tasks
        </button>
      ) : expanded && (
        <p className="px-1 text-[13px] text-[var(--color-text-muted)]">All {ordered.length} shown</p>
      )}
    </section>
  )
}

function BoardCard({ task, status, agents, onDragState, onMove }: {
  task: TaskDto
  status: TaskStatus
  agents: AgentList
  onDragState: (taskId: string | null) => void
  onMove: (category: TaskStatusCategory) => void
}): React.JSX.Element {
  const openTask = useOpenTask()
  const targets = boardMoveTargets(task, status)
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
        aria-label={`${task.title} — ${taskStatusLabel(status)}`}
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
  targets: readonly TaskStatusCategory[]
  onMove: (category: TaskStatusCategory) => void
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
          {targets.map((category) => (
            <button key={category} type="button" role="menuitem" className={MENU_ITEM}
              onClick={() => { setOpen(false); onMove(category) }}>
              Move to {TASK_STATUS_CATEGORY_LABEL[category]}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
