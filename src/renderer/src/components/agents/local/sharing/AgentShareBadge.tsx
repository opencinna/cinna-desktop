import { Loader2, Users } from 'lucide-react'
import {
  SHARE_UI_TEXT,
  shareBadgeText,
  shareStatusSentence,
  shareStatusWarns
} from '../../../../utils/shareText'
import { SUMMARY_BADGE } from '../fieldClasses'
import { useAgentShareStatus } from './useAgentShareStatus'
import { canShareChanges, canUpdate, isAdopting, type ShareActions } from './useShareActions'

export { useAgentShareStatus } from './useAgentShareStatus'

const ACTION =
  `${SUMMARY_BADGE} inline-flex shrink-0 items-center gap-1 font-medium !text-[var(--color-text)] transition-colors ` +
  'hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50'

/**
 * A shared agent's state with the team, as one badge in the chat header's
 * summary row, then the Update / Share changes… buttons the state allows —
 * Finish… / Discard while a session is bringing the team's changes together —
 * at the badges' height.
 *
 * **Present from the first paint or not at all.** Whether the agent is shared
 * comes from the statuses list the sidebar has already loaded, not from this
 * agent's own status, so the unit is there (or absent) from the first frame
 * and the per-agent read only changes its words (ux_rules rules 1 and 2).
 *
 * **One non-wrapping unit**: badge and buttons never split across lines, and
 * the badge's words truncate instead, so a state change on a poll never adds
 * or removes a wrapped line.
 *
 * The actions and their dialogs are the page's (`actions`), so a result that
 * lands after a click took the user to Settings still reaches them. The badge
 * is a short form; the full sentence is its tooltip, and a click opens the
 * Sharing tab. A refusal goes to the page's one-line slot.
 */
export function AgentShareBadge({
  agentId,
  actions,
  onOpenSharing
}: {
  agentId: string
  /** The page's Update / Share changes / Finish / Discard, owned there. */
  actions: Pick<
    ShareActions,
    'update' | 'updatePending' | 'openShareChanges' | 'finish' | 'finishPending' | 'discard' | 'discardPending'
  >
  /** Settings → Sharing for this agent. */
  onOpenSharing: () => void
}): React.JSX.Element | null {
  const status = useAgentShareStatus(agentId)

  // Not shared, or not known yet: no badge. The list is loaded before any
  // agent page can open (the sidebar reads it), so "not known yet" is the
  // instant of a cold start, not a state that later grows a badge.
  if (!status) return null

  const warn = shareStatusWarns(status)
  const sessionBusy = actions.finishPending || actions.discardPending
  return (
    <span data-share-unit className="inline-flex min-w-0 max-w-full flex-nowrap items-center gap-1.5">
      <button
        type="button"
        data-share-badge
        onClick={onOpenSharing}
        title={`${shareStatusSentence(status)} — ${SHARE_UI_TEXT.openSharing.toLowerCase()}`}
        className={`${SUMMARY_BADGE} inline-flex min-w-0 cursor-pointer items-center gap-1 transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] ${
          warn ? '!text-[var(--color-warning)]' : ''
        }`}
      >
        <Users size={10} className="shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
        <span className="min-w-0 truncate">{shareBadgeText(status)}</span>
      </button>
      {isAdopting(status) && (
        <>
          <button
            type="button"
            className={ACTION}
            disabled={sessionBusy}
            aria-busy={actions.finishPending}
            onClick={actions.finish}
          >
            {actions.finishPending && <Loader2 size={10} className="animate-spin" aria-hidden="true" />}
            {actions.finishPending ? SHARE_UI_TEXT.finishing : SHARE_UI_TEXT.finish}
          </button>
          <button type="button" className={ACTION} disabled={sessionBusy} onClick={actions.discard}>
            {SHARE_UI_TEXT.discard}
          </button>
        </>
      )}
      {canUpdate(status) && (
        <button
          type="button"
          className={ACTION}
          disabled={actions.updatePending}
          aria-busy={actions.updatePending}
          onClick={actions.update}
        >
          {actions.updatePending && <Loader2 size={10} className="animate-spin" aria-hidden="true" />}
          {actions.updatePending ? SHARE_UI_TEXT.updating : SHARE_UI_TEXT.update}
        </button>
      )}
      {canShareChanges(status) && (
        <button
          type="button"
          className={ACTION}
          disabled={actions.updatePending}
          onClick={actions.openShareChanges}
        >
          {SHARE_UI_TEXT.shareChanges}
        </button>
      )}
    </span>
  )
}
