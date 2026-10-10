import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { UpdateAvailableInboxItem } from '../../../../shared/inbox'
import { useUpdateShared } from '../../hooks/useSharing'
import { useApplyBundleUpdate } from '../../hooks/useAgents'
import { catalogSkillOutcomeMessage, useUpdateCatalogSkill } from '../../hooks/useCatalogSkills'
import { useOpenAgentPage } from '../../hooks/useOpenAgentPage'
import { unwrapIpcError } from '../../utils/ipcError'
import { SHARE_REFUSAL_TEXT, SHARE_UI_TEXT, shareRefusalSentence } from '../../utils/shareText'
import { CATALOG_SKILL_TEXT, CATALOG_TEXT, catalogDateLabel, catalogVersionLabel } from '../../utils/catalogItems'
import { CatalogKindBadge } from '../agents/CatalogKindBadge'

const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] aria-disabled:opacity-60'

/**
 * "Update available for *X*" — one card for every kind of agent with a newer
 * catalog version: a shared desktop agent the team moved past this
 * computer's copy (Update = `sharing:update`), a cloud agent whose install
 * is behind (Update = apply the latest version to the install), or a catalog
 * skill one of the user's kit agents pins at an older version — "Update
 * available for *skill* in *agent*" (Update = `catalog-skills:update`). The kind
 * badge, the version label and the date are the catalog's own; the agent's
 * name opens its page.
 *
 * Built in the dispatcher cards' shell. Like them, a card the user acted on
 * stays with what it settled as (`InboxView` retains it), rather than leaving
 * from under the pointer when the next read no longer lists it. When a
 * desktop agent's two sides do not combine cleanly the choice is the agent
 * page's, so Update takes the user there; any other refusal stays on the
 * card beside its button.
 */
export function UpdateAvailableCard({
  item,
  onActed
}: {
  item: UpdateAvailableInboxItem
  onActed: (item: UpdateAvailableInboxItem) => void
}): React.JSX.Element {
  const openAgentPage = useOpenAgentPage()
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  const updateShared = useUpdateShared({
    onResult: (result) => {
      if (result.done) setSettled(true)
      else if (result.refusal === 'diverged_conflict') openAgentPage({ id: item.agentId })
      else setError(shareRefusalSentence(result.refusal ?? 'failed', result.detail))
    }
  })
  const applyUpdate = useApplyBundleUpdate()
  const updateSkill = useUpdateCatalogSkill()
  const pending = updateShared.isPending || applyUpdate.isPending || updateSkill.isPending
  const subject =
    item.target === 'skill'
      ? CATALOG_SKILL_TEXT.updateAvailableIn(item.skillTitle, item.agentName)
      : SHARE_UI_TEXT.updateAvailableFor(item.agentName)
  const meta = [
    item.version !== null ? catalogVersionLabel(item.version, item.versionLabel) : null,
    item.changedBy ? CATALOG_TEXT.by(item.changedBy) : null
  ]
    .filter(Boolean)
    .join(' · ')
  const date = catalogDateLabel(item.changedAt)

  const run = (): void => {
    if (pending) return
    setError(null)
    // Before the await, as an answered ask is: the next read drops the card.
    onActed(item)
    if (item.target === 'desktop_agent') {
      updateShared.mutate(item.agentId, { onError: (err) => setError(unwrapIpcError(err)) })
      return
    }
    if (item.target === 'skill') {
      updateSkill.mutate(
        { agentId: item.agentId, name: item.skillName },
        {
          onSuccess: (outcome) => {
            if (outcome.ok) setSettled(true)
            else setError(catalogSkillOutcomeMessage(outcome, CATALOG_SKILL_TEXT.updateFailed))
          },
          onError: (err) => setError(unwrapIpcError(err, CATALOG_SKILL_TEXT.updateFailed))
        }
      )
      return
    }
    applyUpdate.mutate(item.installId, {
      onSuccess: () => setSettled(true),
      onError: (err: Error & { code?: string }) =>
        setError(err.code === 'reauth_required' ? SHARE_REFUSAL_TEXT.reauth_required : unwrapIpcError(err, 'Update failed.'))
    })
  }

  return (
    <article
      aria-label={subject}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[var(--color-text)]" title={subject}>
            {SHARE_UI_TEXT.updateAvailableLead}{' '}
            {item.target === 'skill' && (
              <>
                <span className="font-medium">{item.skillTitle}</span> {CATALOG_SKILL_TEXT.inAgent}{' '}
              </>
            )}
            <button
              type="button"
              onClick={() => openAgentPage({ id: item.agentId })}
              title={`Open ${item.agentName}`}
              className="font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]"
            >
              {item.agentName}
            </button>
          </div>
          {(meta || date) && (
            <div className="flex min-w-0 items-baseline gap-2 text-[11px] text-[var(--color-text-muted)]">
              {meta && <span className="min-w-0 truncate">{meta}</span>}
              {date && <span className="shrink-0">{date}</span>}
            </div>
          )}
        </div>
        <CatalogKindBadge kind={item.target} />
      </div>
      {settled ? (
        <p role="status" className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
          {item.target === 'skill' ? CATALOG_SKILL_TEXT.updatedIn(item.skillTitle) : SHARE_UI_TEXT.updated}
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
