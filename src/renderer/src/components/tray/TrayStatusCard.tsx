import { MessageCircle, Bot } from 'lucide-react'
import type { AgentStatusSnapshot } from '../../hooks/useAgentStatus'
import { formatRelative, SeverityIcon } from '../agents/statusViews'
import {
  SEVERITY_CARD_BORDER,
  SEVERITY_LABEL,
  SEVERITY_TEXT,
  type Severity
} from '../../constants/agentSeverity'

interface Props {
  snapshot: AgentStatusSnapshot
  now: Date
  onViewDetails: () => void
  onStartChat: () => void
}

/**
 * Compact agent status card for the menu-bar popup. Mirrors the layout of the
 * in-app `StatusCard` (title row + summary + footer with timestamp & action)
 * but with tray-tight spacing and type sizes. Drops the per-card refresh on
 * purpose — at this density the panel header's refresh-all is enough, and an
 * extra button would crowd the footer.
 */
export function TrayStatusCard({
  snapshot,
  now,
  onViewDetails,
  onStartChat
}: Props): React.JSX.Element {
  const severity: Severity = snapshot.severity ?? 'unknown'
  const reported = snapshot.reportedAt ? new Date(snapshot.reportedAt) : null
  const summary =
    snapshot.summary ??
    snapshot.body?.split('\n').find((l) => l.trim() && !l.startsWith('#')) ??
    '(no summary)'

  return (
    <div
      className={`flex flex-col rounded-lg border ${SEVERITY_CARD_BORDER[severity]} bg-[color-mix(in_srgb,var(--color-bg-tertiary)_45%,transparent)] hover:bg-[var(--color-bg-hover)] transition-colors`}
    >
      <button
        type="button"
        onClick={onViewDetails}
        className="text-left px-2.5 pt-2 pb-1 cursor-pointer"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Bot size={13} className="shrink-0 text-[var(--color-text-secondary)]" />
          <span className="flex-1 min-w-0 text-[12px] font-medium text-[var(--color-text)] truncate leading-tight">
            {snapshot.name}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            <SeverityIcon severity={severity} />
            <span
              className={`text-[9px] font-semibold uppercase tracking-wider ${SEVERITY_TEXT[severity]}`}
            >
              {SEVERITY_LABEL[severity]}
            </span>
          </span>
        </div>
        <p className="mt-1 text-[11px] text-[var(--color-text-secondary)] leading-snug line-clamp-2 break-words">
          {summary}
        </p>
      </button>
      <div className="flex items-center justify-between px-2.5 pb-1.5">
        <span
          className="text-[9px] text-[var(--color-text-muted)] whitespace-nowrap"
          title={reported ? reported.toLocaleString() : undefined}
        >
          {reported ? formatRelative(reported, now) : ''}
        </span>
        <button
          type="button"
          onClick={onStartChat}
          className="w-6 h-6 rounded-md flex items-center justify-center border border-transparent text-[var(--color-accent)] hover:bg-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] transition-colors"
          title="Start a chat with this agent"
        >
          <MessageCircle size={12} />
        </button>
      </div>
    </div>
  )
}
