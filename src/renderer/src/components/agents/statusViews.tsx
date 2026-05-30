import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from '../../utils/markdownComponents'
import {
  RefreshCw,
  ArrowLeft,
  MessageSquarePlus,
  MessageCircle,
  AlertTriangle,
  CheckCircle2,
  Info as InfoIcon,
  HelpCircle,
  Bot
} from 'lucide-react'
import type { AgentStatusSnapshot } from '../../hooks/useAgentStatus'
import {
  SEVERITY_RANK,
  SEVERITY_LABEL,
  SEVERITY_TEXT,
  SEVERITY_CARD_BORDER,
  type Severity
} from '../../constants/agentSeverity'

export function SeverityIcon({ severity }: { severity: Severity }): React.JSX.Element {
  const cls = SEVERITY_TEXT[severity]
  if (severity === 'error') return <AlertTriangle size={14} className={cls} />
  if (severity === 'warning') return <AlertTriangle size={14} className={cls} />
  if (severity === 'info') return <InfoIcon size={14} className={cls} />
  if (severity === 'ok') return <CheckCircle2 size={14} className={cls} />
  return <HelpCircle size={14} className={cls} />
}

export function formatRelative(from: Date, now: Date): string {
  const diffMs = now.getTime() - from.getTime()
  // Future timestamps (clock skew) — don't reject per spec; show "just now".
  if (diffMs < 0) return 'just now'
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return from.toLocaleDateString()
}

export function sortByUrgency(a: AgentStatusSnapshot, b: AgentStatusSnapshot): number {
  const ra = a.severity ? SEVERITY_RANK[a.severity] : -1
  const rb = b.severity ? SEVERITY_RANK[b.severity] : -1
  if (ra !== rb) return rb - ra
  // Then freshest first
  const ta = a.reportedAt ? Date.parse(a.reportedAt) : 0
  const tb = b.reportedAt ? Date.parse(b.reportedAt) : 0
  return tb - ta
}

interface StatusCardProps {
  snapshot: AgentStatusSnapshot
  now: Date
  refreshing: boolean
  onRefresh: () => void
  onViewDetails: () => void
  onStartChat: () => void
}

export function StatusCard({
  snapshot,
  now,
  refreshing,
  onRefresh,
  onViewDetails,
  onStartChat
}: StatusCardProps): React.JSX.Element {
  const severity = snapshot.severity ?? 'unknown'
  const reported = snapshot.reportedAt ? new Date(snapshot.reportedAt) : null
  const summary =
    snapshot.summary ??
    snapshot.body?.split('\n').find((l) => l.trim() && !l.startsWith('#')) ??
    '(no summary)'

  return (
    <div
      className={`flex flex-col rounded-lg border ${SEVERITY_CARD_BORDER[severity]} bg-[color-mix(in_srgb,var(--color-bg-secondary)_65%,transparent)] overflow-hidden hover:bg-[color-mix(in_srgb,var(--color-bg-hover)_75%,transparent)] transition-colors`}
    >
      <button
        type="button"
        onClick={onViewDetails}
        className="flex-1 text-left p-3 cursor-pointer"
      >
        <div className="flex items-center gap-2 mb-2 min-w-0">
          <Bot size={16} className="shrink-0 text-[var(--color-text-secondary)]" />
          <span className="flex-1 min-w-0 text-sm font-semibold text-[var(--color-text)] truncate">
            {snapshot.name}
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <SeverityIcon severity={severity} />
            <span
              className={`text-[10px] font-semibold uppercase tracking-wider ${SEVERITY_TEXT[severity]}`}
            >
              {SEVERITY_LABEL[severity]}
            </span>
          </span>
        </div>
        <p className="text-xs text-[var(--color-text-secondary)] leading-snug line-clamp-3 break-words">
          {summary}
        </p>
      </button>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0 text-[10px] text-[var(--color-text-muted)]">
          {reported ? (
            <span className="truncate" title={reported.toLocaleString()}>
              {formatRelative(reported, now)}
            </span>
          ) : (
            <span>no timestamp</span>
          )}
          {snapshot.reportedAtSource === 'file_mtime' && (
            <span
              className="truncate"
              title="Timestamp inferred from STATUS.md file mtime"
            >
              · from file mtime
            </span>
          )}
          {snapshot.environmentId === null && (
            <span className="truncate text-[var(--color-severity-warning-text)]/80">
              · env not running
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRefresh()
            }}
            disabled={refreshing}
            className="w-7 h-7 rounded-md flex items-center justify-center border border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors disabled:opacity-50"
            title="Force refresh from running environment (rate-limited to 1/30s)"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onStartChat()
            }}
            className="w-7 h-7 rounded-md flex items-center justify-center border border-transparent text-[var(--color-accent)] hover:bg-[var(--color-bg-tertiary)] hover:border-[var(--color-accent)] transition-colors"
            title="Start a chat with this agent"
          >
            <MessageCircle size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

interface DetailViewProps {
  snapshot: AgentStatusSnapshot
  now: Date
  refreshing: boolean
  onRefresh: () => void
  onBack: () => void
  onStartChat: () => void
}

export function DetailView({
  snapshot,
  now,
  refreshing,
  onRefresh,
  onBack,
  onStartChat
}: DetailViewProps): React.JSX.Element {
  // The parent re-reads the snapshot from the live React Query cache; the
  // mutation's onSuccess patches that cache, so refreshes propagate down
  // through props — no local override needed.
  const severity = snapshot.severity ?? 'unknown'
  const reported = snapshot.reportedAt ? new Date(snapshot.reportedAt) : null
  const fetched = snapshot.fetchedAt ? new Date(snapshot.fetchedAt) : null
  const changedAt = snapshot.severityChangedAt ? new Date(snapshot.severityChangedAt) : null
  const changedRecently = changedAt ? now.getTime() - changedAt.getTime() < 60 * 60 * 1000 : false

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 pr-12 border-b border-[var(--color-border)] bg-[var(--color-overlay-panel)]">
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title="Back to grid"
        >
          <ArrowLeft size={14} />
        </button>
        <div className="w-8 h-8 shrink-0 rounded-md bg-[var(--color-bg-tertiary)] flex items-center justify-center text-[var(--color-text-secondary)]">
          <Bot size={16} />
        </div>
        <span className="text-base font-semibold text-[var(--color-text)] truncate">
          {snapshot.name}
        </span>
        <div className="flex-1" />
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
          title="Force refresh from running environment (rate-limited to 1/30s)"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          onClick={onStartChat}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-[var(--color-accent)]/15 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 transition-colors"
          title="Start chat with this agent"
        >
          <MessageSquarePlus size={12} />
          Start Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-1.5">
            <SeverityIcon severity={severity} />
            <span
              className={`text-[11px] font-semibold uppercase tracking-wider ${SEVERITY_TEXT[severity]}`}
            >
              {SEVERITY_LABEL[severity]}
            </span>
          </div>

          {snapshot.summary && (
            <p className="text-sm text-[var(--color-text)] leading-relaxed">{snapshot.summary}</p>
          )}

          <div className="text-[11px] text-[var(--color-text-muted)] space-y-0.5">
            {reported && (
              <div>
                Reported {formatRelative(reported, now)}{' '}
                <span className="text-[var(--color-text-muted)]/70">
                  ({reported.toLocaleString()})
                </span>
                {snapshot.reportedAtSource === 'file_mtime' && (
                  <span className="italic"> · from file modification time</span>
                )}
              </div>
            )}
            {fetched && (
              <div>
                Last polled by platform {formatRelative(fetched, now)}{' '}
                <span className="text-[var(--color-text-muted)]/70">
                  ({fetched.toLocaleString()})
                </span>
              </div>
            )}
            {changedRecently && snapshot.prevSeverity && (
              <div>
                Changed from <span className="font-semibold">{snapshot.prevSeverity}</span>{' '}
                {changedAt && formatRelative(changedAt, now)}
              </div>
            )}
            {snapshot.environmentId === null && (
              <div className="text-[var(--color-severity-warning-text)]/90 italic">
                Environment is not running — showing last cached status
              </div>
            )}
          </div>

          {snapshot.body ? (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm markdown-body">
              <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{snapshot.body}</Markdown>
            </div>
          ) : (
            <p className="text-xs italic text-[var(--color-text-muted)]">
              No body content in STATUS.md
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
