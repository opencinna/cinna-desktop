import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { SkillDisconnectedInboxItem } from '../../../../shared/inbox'
import { useDismissDisconnected } from '../../hooks/useInbox'
import { catalogSkillOutcomeMessage, useRemoveCatalogSkill } from '../../hooks/useCatalogSkills'
import { useOpenAgentPage } from '../../hooks/useOpenAgentPage'
import { unwrapIpcError } from '../../utils/ipcError'
import { CatalogKindBadge } from '../agents/CatalogKindBadge'

/** Words of the "Disconnected" card. */
export const SKILL_DISCONNECTED_TEXT = {
  /**
   * The card's subject and accessible name: "Disconnected: erp-lookup in
   * Invoices". The state leads, so a truncated title still says it.
   */
  subject: (skill: string, agent: string) => `Disconnected: ${skill} in ${agent}`,
  state: 'Disconnected:',
  inAgent: 'in',
  /** The pinned revision is on this computer (`cached`). */
  bodyCached:
    'It is no longer in the catalog for you. The copy on this computer keeps working as a local version, but it no longer syncs or gets updates.',
  /** No copy here, and its download was refused as not available. */
  bodyNotCached: 'It is no longer in the catalog for you, so this agent can’t download it. Ask a maintainer for access, or remove it.',
  remove: 'Remove',
  removeLabel: (skill: string, agent: string) => `Remove ${skill} from ${agent}`,
  removeConfirm: (skill: string) =>
    `Remove ${skill} from this agent? It is no longer in the catalog for you, so you may not be able to add it again. ${skill} stops being available to this agent in new chats.`,
  removeButton: 'Remove skill',
  removing: 'Removing…',
  cancel: 'Cancel',
  removeFailed: 'The skill could not be removed.',
  removed: (skill: string, agent: string) => `Removed. ${skill} is no longer in ${agent}.`,
  dismiss: 'Dismiss',
  dismissed: 'Dismissed. It shows again only if this skill is disconnected again.',
  dismissFailed: 'The card could not be dismissed.'
} as const

const SECONDARY =
  'inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] aria-disabled:opacity-60'
const DANGER =
  'inline-flex items-center gap-1.5 rounded-md border border-[var(--color-danger)] px-2.5 py-1 text-[11px] font-medium ' +
  'text-[var(--color-danger)] transition-colors hover:bg-[var(--color-bg-hover)] aria-disabled:opacity-60'

/**
 * "Disconnected: *skill* in *agent*" — a catalog skill one of the user's
 * agents pins that the catalog no longer gives them. With a copy on this
 * computer (`cached`) it keeps working as a local version; without one, the
 * agent cannot download it, and the body says so. **Remove** takes the pin out of
 * the agent after the same inline confirm the agent's Skills row asks
 * (worded for a skill that may not come back), and is offered only where the
 * user may change the agent; **Dismiss** hides the card until the pin is
 * connected again.
 *
 * In the update cards' shell. Like them, a card the user acted on stays with
 * what it settled as (`InboxView` retains it) rather than leaving from under
 * the pointer; a refusal stays on the card under its buttons.
 */
export function SkillDisconnectedCard({
  item,
  onActed
}: {
  item: SkillDisconnectedInboxItem
  onActed: (item: SkillDisconnectedInboxItem) => void
}): React.JSX.Element {
  const openAgentPage = useOpenAgentPage()
  const removeSkill = useRemoveCatalogSkill()
  const dismiss = useDismissDisconnected()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState<'removed' | 'dismissed' | null>(null)
  const pending = removeSkill.isPending || dismiss.isPending
  const subject = SKILL_DISCONNECTED_TEXT.subject(item.skillTitle, item.agentName)

  const remove = (): void => {
    if (pending) return
    setError(null)
    // Before the await, as an answered ask is: the next read drops the card.
    onActed(item)
    removeSkill.mutate(
      { agentId: item.agentId, name: item.skillName },
      {
        onSuccess: (outcome) => {
          if (outcome.ok) setSettled('removed')
          else setError(catalogSkillOutcomeMessage(outcome, SKILL_DISCONNECTED_TEXT.removeFailed))
        },
        onError: (err) => setError(unwrapIpcError(err, SKILL_DISCONNECTED_TEXT.removeFailed))
      }
    )
  }

  const runDismiss = (): void => {
    if (pending) return
    setError(null)
    onActed(item)
    dismiss.mutate(
      { agentId: item.agentId, packageUuid: item.packageUuid, revision: item.revision },
      {
        onSuccess: () => setSettled('dismissed'),
        onError: (err) => setError(unwrapIpcError(err, SKILL_DISCONNECTED_TEXT.dismissFailed))
      }
    )
  }

  return (
    <article
      aria-label={subject}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[var(--color-text)]" title={subject}>
            {SKILL_DISCONNECTED_TEXT.state} <span className="font-medium">{item.skillTitle}</span> {SKILL_DISCONNECTED_TEXT.inAgent}{' '}
            <button
              type="button"
              onClick={() => openAgentPage({ id: item.agentId })}
              title={`Open ${item.agentName}`}
              className="font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]"
            >
              {item.agentName}
            </button>
          </div>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">
            {item.cached ? SKILL_DISCONNECTED_TEXT.bodyCached : SKILL_DISCONNECTED_TEXT.bodyNotCached}
          </p>
        </div>
        <CatalogKindBadge kind="skill" />
      </div>
      {settled ? (
        <p role="status" className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
          {settled === 'removed' ? SKILL_DISCONNECTED_TEXT.removed(item.skillTitle, item.agentName) : SKILL_DISCONNECTED_TEXT.dismissed}
        </p>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            {item.removable && (
              <button
                type="button"
                className={DANGER}
                aria-disabled={pending || confirming}
                onClick={() => {
                  if (pending || confirming) return
                  setError(null)
                  setConfirming(true)
                }}
              >
                {SKILL_DISCONNECTED_TEXT.remove}
              </button>
            )}
            <button type="button" className={SECONDARY} aria-disabled={pending} aria-busy={dismiss.isPending} onClick={runDismiss}>
              {dismiss.isPending && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
              {SKILL_DISCONNECTED_TEXT.dismiss}
            </button>
          </div>
          {confirming && (
            <div
              role="group"
              aria-label={SKILL_DISCONNECTED_TEXT.removeLabel(item.skillTitle, item.agentName)}
              className="mt-2 border-t border-[var(--color-border)] pt-2"
            >
              <p className="mb-2 text-[11px] text-[var(--color-text)]">{SKILL_DISCONNECTED_TEXT.removeConfirm(item.skillTitle)}</p>
              <div className="flex items-center gap-2">
                <button type="button" className={DANGER} aria-disabled={pending} aria-busy={removeSkill.isPending} onClick={remove}>
                  {removeSkill.isPending && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
                  {removeSkill.isPending ? SKILL_DISCONNECTED_TEXT.removing : SKILL_DISCONNECTED_TEXT.removeButton}
                </button>
                <button
                  type="button"
                  className={SECONDARY}
                  aria-disabled={pending}
                  onClick={() => {
                    if (!pending) setConfirming(false)
                  }}
                >
                  {SKILL_DISCONNECTED_TEXT.cancel}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className="mt-1.5 text-[11px] text-[var(--color-danger)]">{error}</p>}
    </article>
  )
}
