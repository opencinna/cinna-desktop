import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { TeamChangedInboxItem } from '../../../../shared/inbox'
import { useUpdateShared } from '../../hooks/useSharing'
import { useOpenAgentPage } from '../../hooks/useOpenAgentPage'
import { formatRelativeFromDate } from '../../utils/cinnaTime'
import { unwrapIpcError } from '../../utils/ipcError'
import { SHARE_UI_TEXT, shareRefusalSentence } from '../../utils/shareText'

const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] aria-disabled:opacity-60'

/**
 * "The team changed *X*" — a shared agent whose team version moved past this
 * machine's copy, with **Update**. The agent's name opens its page.
 *
 * Built in the dispatcher cards' shell. Like them, a card the user acted on
 * stays with what it settled as (`InboxView` retains it), rather than leaving
 * from under the pointer when the next read no longer lists it. When the two
 * sides do not combine cleanly the choice is the agent page's, so Update takes
 * the user there; any other refusal stays on the card beside its button.
 */
export function TeamChangedCard({
  item,
  now,
  onActed
}: {
  item: TeamChangedInboxItem
  now: Date
  onActed: (item: TeamChangedInboxItem) => void
}): React.JSX.Element {
  const openAgentPage = useOpenAgentPage()
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  const update = useUpdateShared({
    onResult: (result) => {
      if (result.done) setSettled(true)
      else if (result.refusal === 'diverged_conflict') openAgentPage({ id: item.agentId })
      else setError(shareRefusalSentence(result.refusal ?? 'failed', result.detail))
    }
  })
  const pending = update.isPending
  const subject = SHARE_UI_TEXT.teamChanged(item.agentName)
  const meta = [
    item.changedBy ? SHARE_UI_TEXT.teamChangedBy(item.changedBy) : null,
    item.changedAt ? formatRelativeFromDate(item.changedAt, now) : null
  ]
    .filter(Boolean)
    .join(' · ')

  const run = (): void => {
    if (pending) return
    setError(null)
    // Before the await, as an answered ask is: the next read drops the card.
    onActed(item)
    update.mutate(item.agentId, { onError: (err) => setError(unwrapIpcError(err)) })
  }

  return (
    <article
      aria-label={subject}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-3 py-2.5"
    >
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-[var(--color-text)]" title={subject}>
          {SHARE_UI_TEXT.teamChangedLead}{' '}
          <button
            type="button"
            onClick={() => openAgentPage({ id: item.agentId })}
            title={`Open ${item.agentName}`}
            className="font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]"
          >
            {item.agentName}
          </button>
        </div>
        {meta && <div className="truncate text-[11px] text-[var(--color-text-muted)]">{meta}</div>}
      </div>
      {settled ? (
        <p role="status" className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
          {SHARE_UI_TEXT.updated}
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button type="button" className={PRIMARY} aria-disabled={pending} aria-busy={pending} onClick={run}>
            {pending && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
            {pending ? SHARE_UI_TEXT.updating : SHARE_UI_TEXT.update}
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-1.5 text-[11px] text-[var(--color-danger)]">{error}</p>}
    </article>
  )
}
