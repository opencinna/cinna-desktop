import { createPortal } from 'react-dom'
import { MessageSquare } from 'lucide-react'
import type { ChatListSummary } from '../../../../shared/chatListSummary'
import { getPreset } from '../../constants/chatModeColors'
import { AgentTypeIcon } from '../agents/AgentTypeIcon'
import { formatChatLasted, formatChatOthers, formatChatStarted } from '../../utils/chatSummaryFormat'

interface ChatItemTooltipProps {
  id: string
  summary: ChatListSummary
  /** What "Started" falls back to for a chat with no messages yet. */
  createdAt: Date
  popoverRef: React.RefObject<HTMLDivElement | null>
  /** The pointer on the tooltip keeps it open, as the pointer on the row does. */
  onMouseEnter: () => void
  onMouseLeave: (event: React.MouseEvent) => void
  style: React.CSSProperties
}

/** An agent's type icon, as the Agents list shows it; a chat otherwise, in its mode's colour. */
function WhoIcon({ who }: { who: ChatListSummary['with'] }): React.JSX.Element {
  if (who.kind === 'agent') {
    return <AgentTypeIcon agent={{ source: who.source ?? '', driver: who.driver, protocol: who.protocol, acpTransport: who.acpTransport }} size={12} className="mt-0.5 pointer-events-none" />
  }
  const color = who.kind === 'mode' && who.color ? getPreset(who.color).border : 'var(--color-text-muted)'
  return <MessageSquare size={12} aria-hidden="true" className="mt-0.5 shrink-0" style={{ color }} />
}

/**
 * Who a sidebar chat is with, and when. The pointer may move onto it and it
 * stays open (the row owns the timing); only one is ever open, so it never
 * lingers beside the next row. Every row it shows is fixed for a given chat —
 * nothing arrives after it opens.
 */
export function ChatItemTooltip({ id, summary, createdAt, popoverRef, onMouseEnter, onMouseLeave, style }: ChatItemTooltipProps): React.JSX.Element {
  const now = new Date()
  const hasName = summary.with.name !== ''
  const lasted = formatChatLasted(summary.firstMessageAt, summary.lastMessageAt, summary.messageCount)
  return createPortal(
    <div
      ref={popoverRef}
      id={id}
      // Becomes a non-modal dialog the day a control goes in — see `useHoverPopover`.
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // Portaled, but React still bubbles these to the row, where they navigate.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={style}
      className="z-50 w-[240px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 shadow-xl"
    >
      {hasName && (
        <div className="flex min-w-0 items-start gap-1.5 text-xs font-medium text-[var(--color-text)]">
          <WhoIcon who={summary.with} />
          <span className="min-w-0 line-clamp-2 break-words">{summary.with.name}</span>
          {summary.with.kind === 'mode' && (
            <span className="shrink-0 text-[9px] leading-4 font-normal text-[var(--color-text-muted)]">chat mode</span>
          )}
        </div>
      )}
      {summary.others.length > 0 && (
        <div className={`${hasName ? 'mt-0.5 ' : ''}line-clamp-2 break-words text-[10px] text-[var(--color-text-secondary)]`}>with {formatChatOthers(summary.others)}</div>
      )}
      <dl className={`${hasName || summary.others.length > 0 ? 'mt-1.5 ' : ''}grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px]`}>
        <dt className="text-[var(--color-text-muted)]">Started</dt>
        <dd className="truncate text-[var(--color-text-secondary)]">{formatChatStarted(summary.firstMessageAt ?? createdAt, now)}</dd>
        {lasted && (
          <>
            <dt className="text-[var(--color-text-muted)]">Lasted</dt>
            <dd className="truncate text-[var(--color-text-secondary)]">{lasted}</dd>
          </>
        )}
      </dl>
    </div>,
    document.body
  )
}
