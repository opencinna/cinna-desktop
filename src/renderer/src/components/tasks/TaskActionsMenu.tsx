import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Cloud, Loader2, MessageSquare, MoreHorizontal, Trash2 } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'
import { HEADER_BUTTON } from './DetailParts'
import { useUIStore } from '../../stores/ui.store'
import { useChatDetail, useShowChatInList } from '../../hooks/useChat'
import { useJobRuns } from '../../hooks/useJobs'
import { useDeleteTask, useTaskDeletePreview } from '../../hooks/useTasks'
import { unwrapIpcError } from '../../utils/ipcError'
import type { TaskDeletePreview, TaskDto } from '../../../../shared/tasks'

interface TaskActionsMenuProps {
  task: TaskDto
  /** The page's own way back, taken once the task is gone. */
  onDeleted: () => void
  /** The page's one-line error slot under the header. */
  onError: (message: string | null) => void
}

/**
 * The task page's ⋯ menu: what a user does to a task *occasionally*.
 *
 * "Show in the Chats list" puts the task's chat where the user can find it
 * again — moving it out of hiding first when a job spawned it — and points at
 * its row without leaving this page. Delete is last, separated, and confirms.
 *
 * The delete mutation lives here rather than in the dialog: this component
 * lives exactly as long as the page, and a success handler that leaves the page
 * must not be dropped with a dialog that unmounted (`ux_rules.md` §5).
 */
export function TaskActionsMenu({ task, onDeleted, onError }: TaskActionsMenuProps): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  /** What the delete would remove, read from main before the dialog opens. */
  const [confirming, setConfirming] = useState<TaskDeletePreview | null>(null)
  const remove = useDeleteTask({
    onDeleted: () => {
      setConfirming(null)
      onDeleted()
    }
  })
  const preview = useTaskDeletePreview({
    onReady: (answer) => {
      menu.setOpen(false)
      setConfirming(answer)
    }
  })
  const deleteErrorId = useId()
  const previewError = preview.error
    ? unwrapIpcError(preview.error, 'What goes with this task could not be read, so nothing was deleted.')
    : null
  /*
    Read only while the menu is open, and the menu is not drawn until it has
    settled: whether the item is enabled — and the line saying why not — must be
    final when the menu appears, or the Delete item below it moves (§1).
  */
  const chat = useChatDetail(menu.open ? task.chatId : null)
  const chatSettled = !task.chatId || !chat.isPending
  /*
    The run behind the task, for "Open on the server" — read, and waited for,
    the same way: an item appearing after the menu opened would push the
    others down under the pointer. Only a run that names this task back counts,
    as for Delete.
  */
  const readsRun = !!task.jobRunId && !!task.jobId
  const runs = useJobRuns(menu.open && readsRun ? task.jobId : null)
  const runSettled = !readsRun || !runs.isPending
  const serverRun =
    runs.data?.find(
      // Only a Cinna run carries `cinnaTaskId`, so it decides without a job-type branch.
      (r) => r.id === task.jobRunId && r.taskId === task.id && !!r.cinnaTaskId
    ) ?? null
  const showChatInList = useShowChatInList()

  const showInChats = (chatId: string, hidden: boolean): void => {
    menu.setOpen(false)
    onError(null)
    const ui = useUIStore.getState()
    if (!ui.sidebarOpen) ui.toggleSidebar()
    ui.setSidebarTab('chats')
    // The row consumes this when it renders — at once for a chat already in
    // the list, after the list is read again for one just moved out of hiding.
    ui.setRevealChatId(chatId)
    if (!hidden) return
    // The hook withdraws the reveal on failure, at hook level so it happens
    // even if this page has gone; the message only matters while it is here.
    showChatInList.mutate(chatId, {
      onError: (err) => onError(unwrapIpcError(err, 'The chat could not be moved into the Chats list.'))
    })
  }

  return (
    <div className="flex">
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={() => {
          if (!menu.open) preview.reset()
          menu.setOpen(!menu.open)
        }}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label="More actions"
        title="More actions"
        className={`${HEADER_BUTTON} border-[var(--color-border)] px-2
          text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]`}
      >
        <MoreHorizontal size={14} />
      </button>
      {menu.open &&
        menu.style &&
        chatSettled &&
        runSettled &&
        createPortal(
          <div
            ref={menu.popoverRef}
            role="menu"
            aria-label="Task actions"
            style={menu.style}
            className={MENU_SURFACE}
          >
            {/* First: the conversation on the service, as the job page's run row once offered. */}
            {serverRun && (
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  menu.setOpen(false)
                  const ui = useUIStore.getState()
                  // The run view finds its run among the active job's runs.
                  ui.setActiveJobId(serverRun.jobId)
                  ui.setActiveCinnaRunId(serverRun.id)
                  ui.setActiveView('cinna-task-run')
                }}
              >
                <Cloud size={12} />
                Open on the server
              </button>
            )}
            {task.chatId && (
              <ShowInChatsItem chatId={task.chatId} chat={chat} onShow={showInChats} />
            )}
            {(task.chatId || serverRun) && <div className="my-1 border-t border-[var(--color-border)]" />}
            {/*
              Stays open while main says what the delete would take, the icon
              turning into a spinner in place (§1: async state is inline), so
              the dialog opens with its final copy.
            */}
            <button
              type="button"
              role="menuitem"
              className={`${MENU_ITEM} !text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
              disabled={preview.isPending}
              aria-busy={preview.isPending}
              aria-describedby={previewError ? deleteErrorId : undefined}
              onClick={() => {
                onError(null)
                remove.reset()
                preview.mutate(task.id)
              }}
            >
              {preview.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Delete task…
            </button>
            {/* Last in the menu, so it moves nothing above it; nothing was deleted. */}
            {previewError && (
              <div
                id={deleteErrorId}
                role="alert"
                className="px-2 pb-1.5 pt-0.5 text-[11px] leading-snug text-[var(--color-danger)]"
              >
                {previewError}
              </div>
            )}
          </div>,
          document.body
        )}
      {confirming && (
        <DeleteTaskDialog
          task={task}
          preview={confirming}
          remove={remove}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  )
}

/**
 * "Show in the Chats list", given the menu's read of the chat: it needs to know
 * whether the chat is hidden (move it out first), in the Trash, or gone.
 *
 * Unavailable, it stays focusable with `aria-disabled` and says why on a
 * second line inside the item — not in a `title`, which neither a keyboard nor
 * a first pass of the pointer ever finds (`ux_rules.md` §10, §11). The reason
 * is its description, not part of its name.
 */
function ShowInChatsItem({
  chatId,
  chat,
  onShow
}: {
  chatId: string
  chat: ReturnType<typeof useChatDetail>
  onShow: (chatId: string, hidden: boolean) => void
}): React.JSX.Element {
  const labelId = useId()
  const reasonId = useId()
  const reason = chat.isError
    ? 'The chat could not be read.'
    : !chat.data
      ? 'The chat was deleted.'
      : chat.data.deletedAt
        ? 'The chat is in the Trash.'
        : null
  const unavailable = reason !== null
  return (
    <button
      type="button"
      role="menuitem"
      aria-labelledby={labelId}
      aria-disabled={unavailable || undefined}
      aria-describedby={unavailable ? reasonId : undefined}
      className={`${MENU_ITEM} !items-start ${unavailable ? 'cursor-not-allowed hover:!bg-transparent' : ''}`}
      onClick={() => {
        if (!unavailable && chat.data) onShow(chatId, !!chat.data.hiddenFromList)
      }}
    >
      <MessageSquare size={12} className={`mt-0.5 shrink-0 ${unavailable ? 'opacity-40' : ''}`} />
      <span className="min-w-0">
        <span id={labelId} className={`block ${unavailable ? 'opacity-40' : ''}`}>
          Show in the Chats list
        </span>
        {reason && (
          <span id={reasonId} className="block text-[11px] leading-snug text-[var(--color-text-muted)]">
            {reason}
          </span>
        )}
      </span>
    </button>
  )
}

interface DeleteTaskDialogProps {
  task: TaskDto
  /** What main says the delete removes — the copy is chosen from this alone. */
  preview: TaskDeletePreview
  /** The mutation, owned by the menu — see {@link TaskActionsMenu}. */
  remove: ReturnType<typeof useDeleteTask>
  onCancel: () => void
}

/**
 * Confirm before the task goes, saying what goes with it.
 *
 * The sentence is decided in main (`task:delete-preview`), from the predicate
 * the delete itself uses, and read before the dialog opens — so it is final
 * when it appears and cannot promise a chat stays that the delete then removes
 * (`ux_rules.md` §1, §5). The job, when there is one, is named first: it is the
 * part that stays.
 *
 * Undismissable while pending, and a failure keeps the dialog open with the
 * reason in it (`ux_rules.md` §5, §6).
 */
function DeleteTaskDialog({ task, preview, remove, onCancel }: DeleteTaskDialogProps): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(remove.isPending)
  pendingRef.current = remove.isPending

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !pendingRef.current) onCancel()
    }
    const onClick = (e: MouseEvent): void => {
      if (pendingRef.current) return
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onCancel])

  const title = <strong className="text-[var(--color-text)]">{task.title}</strong>
  const permanently = <strong className="text-[var(--color-text)]">permanently deleted</strong>
  const jobStays = preview.jobStays ? 'The job stays. ' : ''
  const error = remove.error ? unwrapIpcError(remove.error, 'The task could not be deleted.') : null

  return createPortal(
    // Anchored at a fixed top, not centred: an error line appearing below the
    // buttons must lengthen the card downwards, never pull Delete up (§1).
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[20vh]">
      <div
        ref={modalRef}
        role="dialog"
        aria-label="Delete task"
        className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-danger)]">
          <AlertTriangle size={16} />
          Delete task
        </div>
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          Delete {title}? {jobStays}
          {preview.deletesRun && preview.chat === 'deleted_with_run' ? (
            <>
              {preview.jobStays ? 'This run of it' : 'The job run it came from'} and the chat it ran in
              are {permanently} with the task — this can&apos;t be undone.
            </>
          ) : preview.deletesRun ? (
            <>
              {preview.jobStays ? 'This run of it' : 'The job run it came from'} is {permanently} with
              the task — this can&apos;t be undone.
            </>
          ) : preview.chat === 'kept' ? (
            // Not "in the Chats list": a job-spawned chat can be hidden from it.
            <>The chat it ran in stays. The task can&apos;t be restored.</>
          ) : preview.chat === 'in_trash' ? (
            <>
              The chat it ran in is already in the Trash, and stays there. The task can&apos;t be
              restored.
            </>
          ) : (
            <>The task can&apos;t be restored.</>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={remove.isPending}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => remove.mutate(task.id)}
            disabled={remove.isPending}
            // A fixed width, so the longer "Deleting…" does not pull Cancel sideways.
            className="min-w-[6rem] rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
        {/* Last, and only when there is one: it moves nothing above it (§1). */}
        {error && (
          <div role="alert" className="text-[11px] leading-relaxed text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
