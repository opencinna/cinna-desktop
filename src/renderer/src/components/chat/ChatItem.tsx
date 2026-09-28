import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Loader2, Square, Trash2 } from 'lucide-react'
import { useChatStore } from '../../stores/chat.store'
import { useDeleteChat, useInterruptChat, useRenameChat, useSetChatPinned } from '../../hooks/useChat'
import { useOpenAgentPath } from '../../hooks/useLocalAgents'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import type { ChatRunResult } from '../../../../shared/chatRunResult'
import type { ChatListSummary } from '../../../../shared/chatListSummary'
import { usePopover } from '../ui/usePopover'
import { HOVER_CLOSE_DELAY_MS } from '../ui/useHoverPopover'
import { ChatItemTooltip } from './ChatItemTooltip'
import { hasChatSummaryContent } from '../../utils/chatSummaryFormat'
import { ChatRowMenu } from './ChatRowMenu'
import { useChatsDrag } from './chatDragContext'
import { unreadResultIndicator } from '../ui/runResultIndicators'

/**
 * Closes whichever row's tooltip is open. One at a time: a closing delay on
 * each row would otherwise leave the last row's up beside the next one's during
 * a sweep down the list.
 */
let closeOpenTooltip: (() => void) | null = null

/** How long a row asked to show itself stays lit — long enough to be found. */
const REVEAL_MS = 1_800

interface ChatItemProps {
  chat: {
    id: string
    title: string
    updatedAt: Date
    createdAt?: Date
    activeRunId?: string | null
    lastRunResult?: ChatRunResult | null
    pinnedRank?: number | null
  }
  /** From `useChatSummaries`, not the polled list row. Not loaded yet: no tooltip. */
  summary?: ChatListSummary
  /** Place in the list. It moves when a background turn reorders the list. */
  index?: number
  /** The chat's primary agent when it is a folder agent: the menu offers Open Folder. */
  folderAgentId?: string
  /**
   * The innermost group the row is drawn in. Set, the row can be dragged, and
   * takes a drop only from a row of the same group.
   */
  dragGroup?: string
  /** A row of the same group dropped above (`before`) or below (`after`) this one. */
  onDropChat?: (draggedId: string, targetId: string, place: 'before' | 'after') => void
}

export function ChatItem({ chat, summary: loaded, index, folderAgentId, dragGroup, onDropChat }: ChatItemProps): React.JSX.Element {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  // Only a start time says nothing the list's order has not: no tooltip then.
  const summary = loaded && hasChatSummaryContent(loaded) ? loaded : undefined
  const deleteChat = useDeleteChat()
  const renameChat = useRenameChat()
  const setPinned = useSetChatPinned()
  const openAgentPath = useOpenAgentPath()
  const isStreaming = useChatStore((s) => s.activeChatId === chat.id && s.isStreaming)
  const interrupt = useInterruptChat(chat.id)
  const isRunning = isStreaming || !!chat.activeRunId
  const isInterrupting = interrupt.isPending
  const unread = unreadResultIndicator(chat.lastRunResult, isRunning)
  const ResultIcon = unread?.icon
  const actionLabel = isInterrupting ? 'Interrupting session…' : isRunning ? 'Interrupt session' : 'Delete session'
  // A rename is allowed mid-turn, so its failure shows whether or not the chat runs.
  const error = (isRunning ? interrupt.error : deleteChat.error) ?? renameChat.error
  const isActive = activeChatId === chat.id
  // Not `useHoverPopover`: its click pins the popover open, and a click here
  // navigates. Opens at once; closes `HOVER_CLOSE_DELAY_MS` after the pointer
  // has left both the row and the tooltip, so it can cross the gap onto it.
  const tooltip = usePopover<HTMLDivElement, HTMLDivElement>('right')
  const tooltipId = useId()
  const { open: tooltipOpen, setOpen: setTooltipOpen, triggerRef } = tooltip
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const holdTooltip = useCallback((): void => {
    clearTimeout(closeTimer.current)
    closeTimer.current = undefined
  }, [])
  const closeTooltip = useCallback((): void => {
    holdTooltip()
    setTooltipOpen(false)
    if (closeOpenTooltip === closeTooltip) closeOpenTooltip = null
  }, [holdTooltip, setTooltipOpen])
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const { drag, setDrag, menuOpen, setMenuOpen } = useChatsDrag()
  // Tell the other rows, so none of them opens a tooltip over this menu.
  useEffect(() => {
    if (!menu) return
    setMenuOpen(true)
    return () => setMenuOpen(false)
  }, [menu, setMenuOpen])
  const openTooltip = useCallback((): void => {
    holdTooltip()
    if (closeOpenTooltip && closeOpenTooltip !== closeTooltip) closeOpenTooltip()
    closeOpenTooltip = closeTooltip
    setTooltipOpen(true)
  }, [holdTooltip, closeTooltip, setTooltipOpen])
  const closeTooltipSoon = useCallback((): void => {
    holdTooltip()
    closeTimer.current = setTimeout(closeTooltip, HOVER_CLOSE_DELAY_MS)
  }, [holdTooltip, closeTooltip])
  useEffect(() => () => {
    clearTimeout(closeTimer.current)
    if (closeOpenTooltip === closeTooltip) closeOpenTooltip = null
  }, [closeTooltip])

  // The position is fixed at the moment of opening, so a scroll that moves the
  // row leaves it beside the wrong one. Scroll does not bubble; capture sees
  // the list's. Only a scroller that contains the row can move it: the
  // transcript scrolls continuously while a turn streams, and must not close it.
  useEffect(() => {
    if (!tooltipOpen) return
    const close = (e: Event): void => {
      if (e.target instanceof Node && !e.target.contains(triggerRef.current)) return
      closeTooltip()
    }
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [tooltipOpen, closeTooltip, triggerRef])

  // Positioned once, on opening: a row the list moved would leave it beside another.
  useEffect(() => closeTooltip, [index, closeTooltip])

  const showTooltip = tooltipOpen && !!summary && !!tooltip.style && !menu && !menuOpen && !drag

  // Rename in place: the title becomes an input of the same height, so the
  // row neither grows nor moves while the user types. Enter or leaving the
  // field commits; Escape cancels. Empty or unchanged is no rename at all.
  const [renaming, setRenaming] = useState(false)
  const renameSettled = useRef(false)
  const startRename = (): void => {
    renameSettled.current = false
    setRenaming(true)
  }
  const finishRename = (value: string | null): void => {
    if (renameSettled.current) return
    renameSettled.current = true
    setRenaming(false)
    const title = value?.trim()
    if (title && title !== chat.title) renameChat.mutate({ chatId: chat.id, title })
  }

  // A drop line above or below the row, by the pointer's half of it. Drawn
  // absolutely positioned, so nothing moves while dragging.
  const [dropPlace, setDropPlace] = useState<'before' | 'after' | null>(null)
  const draggable = !!dragGroup && !!onDropChat && !renaming
  const acceptsDrop = draggable && !!drag && drag.group === dragGroup && drag.id !== chat.id
  const isDraggingSelf = drag?.id === chat.id
  // A drag that ended anywhere (a drop elsewhere, Escape) leaves no line behind.
  useEffect(() => {
    if (!drag) setDropPlace(null)
  }, [drag])

  // "Show in the Chats list" on a task page: bring this row into view and
  // flash it once, without opening the chat — the user stays on the task. The
  // request is one-shot, so a row remounting later does not scroll; and it
  // waits for the row, which for a chat just moved out of hiding only exists
  // once the list has been read again.
  const revealChatId = useUIStore((s) => s.revealChatId)
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (revealChatId !== chat.id) return
    triggerRef.current?.scrollIntoView?.({ block: 'nearest' })
    useUIStore.getState().setRevealChatId(null)
    setRevealed(true)
  }, [revealChatId, chat.id, triggerRef])
  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(() => setRevealed(false), REVEAL_MS)
    return () => clearTimeout(timer)
  }, [revealed])

  return (
    <>
    <div
      ref={tooltip.triggerRef}
      aria-describedby={showTooltip ? tooltipId : undefined}
      // The tooltip is portaled but still this row's React child: entering or
      // leaving it runs these too, which is the same answer either way.
      onMouseEnter={() => {
        if (drag || menu || menuOpen) return
        if (summary) openTooltip()
        // A row with nothing to show still ends the last row's: it is no longer about this one.
        else if (closeOpenTooltip !== closeTooltip) closeOpenTooltip?.()
      }}
      onMouseLeave={closeTooltipSoon}
      onMouseDown={closeTooltip}
      onContextMenu={(event) => {
        if (renaming) return
        event.preventDefault()
        closeTooltip()
        setMenu({ x: event.clientX, y: event.clientY, anchor: event.currentTarget })
      }}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable || !dragGroup) return
        closeTooltip()
        setMenu(null)
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-cinna-chat', chat.id)
        // As JobItem: the transparent idle row would rasterize white corners
        // into the drag preview in the light theme.
        ;(event.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-bg-secondary)'
        setDrag({ id: chat.id, group: dragGroup })
      }}
      onDragEnd={(event) => {
        setDrag(null)
        setDropPlace(null)
        ;(event.currentTarget as HTMLElement).style.backgroundColor = ''
      }}
      onDragOver={(event) => {
        // A row of another group is no target: no line, no preventDefault.
        if (!acceptsDrop) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        const place = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
        if (place !== dropPlace) setDropPlace(place)
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setDropPlace(null)
      }}
      onDrop={(event) => {
        if (!acceptsDrop || !drag || !onDropChat) return
        event.preventDefault()
        // From the pointer, not the line's state: a dragleave onto a child
        // with no relatedTarget may have cleared that.
        const rect = event.currentTarget.getBoundingClientRect()
        const place = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
        setDropPlace(null)
        setDrag(null)
        onDropChat(drag.id, chat.id, place)
      }}
      data-chat-row={chat.id}
      className={`group relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-md cursor-pointer text-xs transition-colors ${
        isActive
          ? 'app-nav-active text-[var(--color-text)]'
          // The portaled tooltip is not a DOM child, so `:hover` ends on the way
          // onto it; the row it describes stays lit for as long as it is open.
          : `text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] ${showTooltip ? 'bg-[var(--color-bg-hover)]' : ''}`
      } ${revealed ? 'ring-1 ring-inset ring-[var(--color-accent)] bg-[var(--color-accent)]/10' : ''} ${
        isDraggingSelf ? 'opacity-40' : ''} ${menu ? 'bg-[var(--color-bg-hover)]' : ''}`}
      data-revealed={revealed || undefined}
      onClick={() => {
        if (renaming) return
        // Picking a chat from the main Chats list leaves any jobs-context
        // anchor behind — the user is navigating via chats now.
        setActiveJobId(null)
        setActiveChatId(chat.id)
        setActiveView('chat')
      }}
    >
      {acceptsDrop && dropPlace && (
        <span
          aria-hidden="true"
          data-drop-indicator={dropPlace}
          className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-[var(--color-accent)] ${dropPlace === 'before' ? '-top-px' : '-bottom-px'}`}
        />
      )}
      {renaming ? (
        <input
          aria-label="Chat title"
          defaultValue={chat.title}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              finishRename(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              finishRename(null)
            }
          }}
          onBlur={(event) => finishRename(event.currentTarget.value)}
          className="flex-1 min-w-0 h-4 -mx-0.5 px-0.5 py-0 border-0 bg-transparent text-xs leading-4 text-[var(--color-text)] outline-none rounded-sm ring-1 ring-[var(--color-accent)] ring-offset-0"
        />
      ) : (
        // While the rename is on its way, the new title: the old one must not
        // flash back for the frame before the list has it.
        <span className="flex-1 truncate">
          {renameChat.isPending && renameChat.variables ? renameChat.variables.title.trim() : chat.title}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (isRunning) interrupt.mutate()
          else deleteChat.mutate(chat.id)
        }}
        aria-label={actionLabel}
        // The button lies on the pointer's way from the title to the tooltip, so
        // the tooltip stays; two tooltips at once say two things, so the native
        // one waits. The accessible name does not depend on it.
        title={showTooltip ? undefined : unread ? `${unread.label} · ${actionLabel}` : actionLabel}
        disabled={isInterrupting || deleteChat.isPending}
        className={`${isRunning || isInterrupting || unread ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} relative p-0.5 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors shrink-0 disabled:cursor-wait`}
      >
        {isRunning || isInterrupting ? (
          <>
            <Loader2 size={12} aria-hidden="true" className={`animate-spin ${isInterrupting ? '' : 'group-hover:opacity-0 group-focus-within:opacity-0'}`} />
            {!isInterrupting && <Square size={12} aria-hidden="true" className="absolute inset-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />}
          </>
        ) : unread && ResultIcon ? (
          <>
            <ResultIcon size={12} role="img" aria-label={unread.label} className={`${unread.color} group-hover:opacity-0 group-focus-within:opacity-0`} />
            <Trash2 size={12} aria-hidden="true" className="absolute inset-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
          </>
        ) : <Trash2 size={12} aria-hidden="true" />}
      </button>
      {error && <span role="alert" className="text-[var(--color-danger)]" title={unwrapIpcError(error, 'The session action failed.')}>
        {unwrapIpcError(error, 'The session action failed.')}
      </span>}
      {showTooltip && summary && tooltip.style && (
        <ChatItemTooltip
          id={tooltipId}
          summary={summary}
          createdAt={chat.createdAt ?? chat.updatedAt}
          popoverRef={tooltip.popoverRef}
          onMouseEnter={holdTooltip}
          // Straight back onto the row: React sees the row as the common parent
          // and fires neither its leave nor its enter, so nothing would cancel
          // the timer and the tooltip would close under a pointer still on the row.
          onMouseLeave={(e) => {
            if (e.relatedTarget instanceof Node && triggerRef.current?.contains(e.relatedTarget)) return
            closeTooltipSoon()
          }}
          style={tooltip.style}
        />
      )}
    </div>
    {menu && (
      <ChatRowMenu
        x={menu.x}
        y={menu.y}
        anchor={menu.anchor}
        pinned={chat.pinnedRank !== null && chat.pinnedRank !== undefined}
        canOpenFolder={!!folderAgentId}
        deleteDisabled={isRunning || isInterrupting || deleteChat.isPending}
        onPin={() => setPinned.mutateAsync({ chatId: chat.id, pinned: chat.pinnedRank === null || chat.pinnedRank === undefined })}
        onRename={startRename}
        onOpenFolder={() => (folderAgentId ? openAgentPath.mutateAsync({ agentId: folderAgentId }) : Promise.resolve())}
        onDelete={() => deleteChat.mutate(chat.id)}
        onClose={closeMenu}
      />
    )}
    </>
  )
}
