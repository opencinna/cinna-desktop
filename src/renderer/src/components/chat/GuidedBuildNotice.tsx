import { Compass } from 'lucide-react'
import { useMarkGuidedBuildDone } from '../../hooks/useLocalAgents'
import { unwrapIpcError } from '../../utils/ipcError'
import { NoticeButton, StableLabel, type ComposerNotice } from './ComposerNoticePanel'

/** The New chat screen's heading while a blank agent's guided first build is offered. */
export const GUIDED_BUILD_HEADING = 'What kind of agent will this be?'

/** The composer row's sentence. */
export const GUIDED_BUILD_NOTICE_TEXT =
  'New agent — this chat starts with guidance, then builds it with you.'

/** The composer's placeholder while the guided first build is offered. */
export function guidedBuildPlaceholder(name: string): string {
  return `Describe what ${name} should do for you…`
}

/**
 * The composer's row for one blank kit agent whose next chat starts the
 * guided first build: an offer (accent), one line like every other row, with
 * Skip guidance on its right (ux_rules rule 19). The caller passes the agent
 * only while the screen offers the guidance; null, there is no row.
 *
 * Skip guidance is the only thing here that writes: it marks the agent's
 * guided build dismissed, the agent then reads as built everywhere, and the
 * caller stops passing it. A failure takes the sentence's place, beside the
 * button, as the skill-link row's does. The mutation's own state is read,
 * never `mutate` callbacks, and only while it is about this agent.
 */
export function useGuidedBuildNotice(agentId: string | null): ComposerNotice | null {
  const skip = useMarkGuidedBuildDone()
  if (!agentId) return null
  const mine = skip.variables?.agentId === agentId
  // Done counts as pending too: the row goes when the folder list refetches
  // and the agent reads as built, and until then Skip guidance must not re-arm.
  const pending = mine && (skip.isPending || skip.isSuccess)
  const error = mine && skip.isError ? unwrapIpcError(skip.error, 'Could not skip the guidance.') : null
  return {
    key: 'guided-build',
    tone: 'accent',
    icon: Compass,
    panelLabel: 'Guidance',
    singleLine: true,
    text: error ? <span role="alert" className="text-[var(--color-danger)]">{error}</span> : GUIDED_BUILD_NOTICE_TEXT,
    title: error ? `${error} ${GUIDED_BUILD_NOTICE_TEXT}` : GUIDED_BUILD_NOTICE_TEXT,
    action: (
      <NoticeButton aria-disabled={pending || undefined}
        onClick={() => { if (!pending) skip.mutate({ agentId }) }}>
        <StableLabel label="Skip guidance" pending={pending} pendingLabel="Skipping…" />
      </NoticeButton>
    )
  }
}
