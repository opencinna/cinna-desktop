import { useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { SHARE_UI_TEXT } from '../../../../utils/shareText'
import { PRIMARY, SECONDARY } from './ShareDialogs'
import { useAgentShareStatus } from './useAgentShareStatus'
import type { ShareActions } from './useShareActions'

/**
 * The one banner the agent page has (ux_rules rule 2): the team changed this
 * agent and this machine has changes it has not shared, so the two should be
 * brought together before the agent runs on half of each.
 *
 * **Decided once, at mount, from the status the sidebar's list already holds**
 * (`initialOffered`), so it is there from the first frame or not at all and
 * nothing jumps once the user is typing (rule 1). A status that turns
 * `diverged` while the page is open waits for the next open, or for Share
 * changes, which offers the same step. It leaves on **Not now** — remembered
 * in main until the team moves again — and the moment the status stops being
 * `diverged`: Bring together makes it `adopting`, Update or a share from
 * elsewhere resolves it.
 *
 * Begin's refusals go to the page's one-line slot through the actions.
 */
export function BringTogetherBanner({
  agentId,
  initialOffered,
  actions
}: {
  agentId: string
  /** Whether the listed status was `diverged` and not declined for this team version, at mount. */
  initialOffered: boolean
  actions: Pick<ShareActions, 'bringTogether' | 'bringTogetherPending' | 'notNow'>
}): React.JSX.Element | null {
  const [offered, setOffered] = useState(initialOffered)
  const current = useAgentShareStatus(agentId)
  if (!offered || current?.state !== 'diverged') return null
  const pending = actions.bringTogetherPending
  return (
    // The composer's own band (`ChatInput`'s `w-full max-w-3xl mx-auto px-4`),
    // so the banner's edges line up with the message box under it.
    <div className="mx-auto w-full max-w-3xl px-4">
      <div
        data-testid="bring-together-banner"
        role="region"
        aria-label={SHARE_UI_TEXT.bringTogetherBannerLabel}
        className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-xs"
      >
      <AlertTriangle size={13} className="shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-[20rem] leading-snug text-[var(--color-text)]">
        {SHARE_UI_TEXT.bringTogetherBanner}
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setOffered(false)
            actions.notNow()
          }}
          disabled={pending}
          className={SECONDARY}
        >
          {SHARE_UI_TEXT.notNow}
        </button>
        <button
          type="button"
          onClick={actions.bringTogether}
          disabled={pending}
          aria-busy={pending}
          className={PRIMARY}
        >
          {pending ? (
            <>
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.bringingTogether}
            </>
          ) : (
            SHARE_UI_TEXT.bringTogether
          )}
        </button>
      </div>
      </div>
    </div>
  )
}
