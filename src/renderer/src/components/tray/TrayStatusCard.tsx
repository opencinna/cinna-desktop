import { MessageSquarePlus, Bot } from 'lucide-react'
import type { AgentStatusSnapshot } from '../../hooks/useAgentStatus'
import { formatRelative } from '../agents/statusViews'
import { SEVERITY_DOT, SEVERITY_CARD_BORDER, type Severity } from '../../constants/agentSeverity'

interface Props {
  snapshot: AgentStatusSnapshot
  now: Date
  onViewDetails: () => void
  onStartChat: () => void
}

/**
 * Compact, two-line agent status row for the menu-bar popup. Severity is carried
 * by the dot + border tint only (no label) to fit the narrow window. Distinct
 * from the roomier `StatusCard` used in the in-app overlay grid.
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
      className={`flex items-stretch rounded-lg border ${SEVERITY_CARD_BORDER[severity]} bg-[color-mix(in_srgb,var(--color-bg-tertiary)_45%,transparent)] hover:bg-[var(--color-bg-hover)] transition-colors`}
    >
      <button
        type="button"
        onClick={onViewDetails}
        className="flex-1 min-w-0 text-left pl-2.5 pr-1 py-2 flex items-start gap-2 cursor-pointer"
      >
        <span className={`mt-1 w-2 h-2 shrink-0 rounded-full ${SEVERITY_DOT[severity]}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 min-w-0">
            <Bot size={13} className="shrink-0 text-[var(--color-text-secondary)]" />
            <span className="text-[12px] font-medium text-[var(--color-text)] truncate leading-tight">
              {snapshot.name}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-secondary)] leading-snug line-clamp-1 break-words">
            {summary}
          </p>
        </div>
      </button>
      <div className="flex flex-col items-end justify-between py-1.5 pr-1.5 shrink-0 gap-1">
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
          <MessageSquarePlus size={12} />
        </button>
      </div>
    </div>
  )
}
