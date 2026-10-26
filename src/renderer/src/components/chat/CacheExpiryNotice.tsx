import { TimerOff, X } from 'lucide-react'
import { NoticeButton } from './ComposerNoticePanel'
import { formatTokens, formatUsd } from '../../utils/telemetryFormat'
import type { CacheExpiryNotice as CacheExpiryNoticeData } from '../../../../shared/sessionTelemetryDerived'
import type { CacheInvalidationReason } from '../../../../shared/sessionTelemetry'

/** What reset the cache, as the end of "Prompt cache reset: ___". */
const RESET_PHRASE: Record<CacheInvalidationReason, string> = {
  model_change: 'the model changed',
  session_params_change: 'settings changed',
  compaction: 'context compacted',
  new_session: 'a new session started'
}

/** How long the chat sat idle: `25 min`, `3 h`, `4 d`. */
export function formatIdle(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** Dollars to the cent where a cent is visible: `$0.68`, `$0.05`, `$0.004`. */
function aboutUsd(n: number): string {
  return formatUsd(n >= 0.01 ? Math.round(n * 100) / 100 : n)
}

/**
 * The notice's title and body, by level, reason and pricing basis: what the
 * next message costs, then what a new chat gives up. Within three lines at the
 * 800px minimum window; the strip does not resize while it shows.
 */
export function cacheNoticeCopy(notice: CacheExpiryNoticeData): { title: string; body: string } {
  const title = notice.reason === 'idle'
    ? `Prompt cache ${notice.level === 'probably_expired' ? 'probably ' : ''}expired (idle ${formatIdle(notice.idleMs)})`
    : `Prompt cache reset: ${RESET_PHRASE[notice.reason]}`
  // Rounded to the thousand: the figure is an approximation, not a reading.
  const tokens = `~${formatTokens(Math.round(notice.contextTokens / 1000) * 1000)} tokens`
  const { estimate } = notice
  const cost = estimate.basis === 'subscription'
    ? `Next message re-reads ${tokens} uncached.`
    : estimate.basis === 'api' && estimate.coldUsd !== undefined && estimate.warmUsd !== undefined
      ? `Next message ~${aboutUsd(estimate.coldUsd)}, not ${aboutUsd(estimate.warmUsd)}.`
      : `Next message re-reads ${tokens} without the cache.`
  return { title, body: `${cost} A new chat starts without history.` }
}

/** The New chat button's tooltip: what it opens. */
export const NEW_CHAT_HINT = 'A new chat set up like this one'

interface CacheExpiryNoticeProps {
  notice: CacheExpiryNoticeData
  /** Opens the new-chat screen set up like this chat; no button without it. */
  onNewChat?: () => void
  onDismiss: () => void
}

/**
 * The composer's prompt-cache strip: this chat's cache has (probably) gone
 * cold, so the next message re-reads the whole context at full price. Drawn in
 * the readiness strip's shell and scale, in its slot — the composer shows one
 * or the other, readiness first, since that one is about whether the turn can
 * run at all. Informs and offers; never blocks Send.
 */
export function CacheExpiryNotice({ notice, onNewChat, onDismiss }: CacheExpiryNoticeProps): React.JSX.Element {
  const { title, body } = cacheNoticeCopy(notice)
  return (
    <div role="region" aria-label="Prompt cache notice" data-tone="warning" className="composer-notice-panel relative mx-3 -mb-3 rounded-t-xl pb-3">
      <span aria-hidden="true" className="composer-notice-border" />
      <div className="relative flex items-center gap-2 px-3 py-2">
        <TimerOff size={13} aria-hidden="true" className="shrink-0 text-[var(--color-warning)]" />
        <p className="min-w-0 flex-1 text-xs leading-snug text-[var(--color-text)] break-words">
          <span className="font-semibold">{title}.</span>{' '}
          <span className="text-[var(--color-text-secondary)]">{body}</span>
        </p>
        {onNewChat && <div className="shrink-0"><NoticeButton title={NEW_CHAT_HINT} onClick={onNewChat}>New chat</NoticeButton></div>}
        <button type="button" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}
          className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] transition-colors">
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
