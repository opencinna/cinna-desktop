import { useCallback, useEffect, useId, useRef } from 'react'
import { CircleAlert, CircleCheck, CircleHelp, Loader2, Square, Trash2 } from 'lucide-react'
import { useChatStore } from '../../stores/chat.store'
import { useDeleteChat, useInterruptChat } from '../../hooks/useChat'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import type { ChatRunResult } from '../../../../shared/chatRunResult'
import type { ChatListSummary } from '../../../../shared/chatListSummary'
import { usePopover } from '../ui/usePopover'
import { HOVER_CLOSE_DELAY_MS } from '../ui/useHoverPopover'
import { ChatItemTooltip } from './ChatItemTooltip'
import { hasChatSummaryContent } from '../../utils/chatSummaryFormat'

const resultIndicators = {
  completed: { icon: CircleCheck, label: 'Completed — unread results', color: 'text-[var(--color-success)]' },
  needs_input: { icon: CircleHelp, label: 'Needs input — unread results', color: 'text-[var(--color-warning)]' },
  failed: { icon: CircleAlert, label: 'Failed — unread results', color: 'text-[var(--color-danger)]' }
}

/**
 * Closes whichever row's tooltip is open. One at a time: a closing delay on
 * each row would otherwise leave the last row's up beside the next one's during
 * a sweep down the list.
 */
let closeOpenTooltip: (() => void) | null = null

interface ChatItemProps {
  chat: {
    id: string
    title: string
    updatedAt: Date
    createdAt?: Date
    activeRunId?: string | null
    lastRunResult?: ChatRunResult | null
  }
  /** From `useChatSummaries`, not the polled list row. Not loaded yet: no tooltip. */
  summary?: ChatListSummary
  /** Place in the list. It moves when a background turn reorders the list. */
  index?: number
}

export function ChatItem({ chat, summary: loaded, index }: ChatItemProps): React.JSX.Element {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  // Only a start time says nothing the list's order has not: no tooltip then.
  const summary = loaded && hasChatSummaryContent(loaded) ? loaded : undefined
  const deleteChat = useDeleteChat()
  const isStreaming = useChatStore((s) => s.activeChatId === chat.id && s.isStreaming)
  const interrupt = useInterruptChat(chat.id)
  const isRunning = isStreaming || !!chat.activeRunId
  const isInterrupting = interrupt.isPending
  const unread = !isRunning && chat.lastRunResult?.unread && chat.lastRunResult.status !== 'canceled'
    ? resultIndicators[chat.lastRunResult.status] : null
  const ResultIcon = unread?.icon
  const actionLabel = isInterrupting ? 'Interrupting session…' : isRunning ? 'Interrupt session' : 'Delete session'
  const error = isRunning ? interrupt.error : deleteChat.error
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

  const showTooltip = tooltipOpen && !!summary && !!tooltip.style

  return (
    <div
      ref={tooltip.triggerRef}
      aria-describedby={showTooltip ? tooltipId : undefined}
      // The tooltip is portaled but still this row's React child: entering or
      // leaving it runs these too, which is the same answer either way.
      onMouseEnter={() => {
        if (summary) openTooltip()
        // A row with nothing to show still ends the last row's: it is no longer about this one.
        else if (closeOpenTooltip !== closeTooltip) closeOpenTooltip?.()
      }}
      onMouseLeave={closeTooltipSoon}
      onMouseDown={closeTooltip}
      className={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-md cursor-pointer text-xs transition-colors ${
        isActive
          ? 'app-nav-active text-[var(--color-text)]'
          // The portaled tooltip is not a DOM child, so `:hover` ends on the way
          // onto it; the row it describes stays lit for as long as it is open.
          : `text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] ${showTooltip ? 'bg-[var(--color-bg-hover)]' : ''}`
      }`}
      onClick={() => {
        // Picking a chat from the main Chats list leaves any jobs-context
        // anchor behind — the user is navigating via chats now.
        setActiveJobId(null)
        setActiveChatId(chat.id)
        setActiveView('chat')
      }}
    >
      <span className="flex-1 truncate">{chat.title}</span>
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
  )
}
