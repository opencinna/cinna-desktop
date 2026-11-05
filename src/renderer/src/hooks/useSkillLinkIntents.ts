import { useEffect } from 'react'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'
import { NEW_CHAT_KEY, offerShowsOn, skillLinkChatKey, useSkillLinkOfferStore, type SkillLinkOffer } from '../stores/skillLinkOffer.store'
import { startAgentChat } from '../utils/startAgentChat'
import { createLogger } from '../stores/logger.store'
import type { SkillLinkIntent } from '../../../shared/skillLink'

const log = createLogger('skill-link')

/**
 * The composer on screen, as its offer key, or null when the view has none:
 * the chat view (the open chat, or the new-chat screen), a folder or remote
 * agent's page in chat mode (its new-chat composer), or a dashboard's open
 * chat panel once it shows its chat — the panel makes its chat the chat
 * store's selection while it does (`DashboardChatPanel`), and stashes the
 * Chats view's own selection, so the stash says the selection is the panel's.
 */
export function composerKeyOnScreen(): string | null {
  const { activeView, agentPageMode, dashboardPanelOpen, dashboardChatsStash } = useUIStore.getState()
  const activeChatId = useChatStore.getState().activeChatId
  if (activeView === 'chat') return skillLinkChatKey(activeChatId)
  if ((activeView === 'local-agent' || activeView === 'external-agent') && agentPageMode === 'chat') return NEW_CHAT_KEY
  if (activeView === 'dashboard' && dashboardPanelOpen && dashboardChatsStash !== null && activeChatId !== null) return activeChatId
  return null
}

/**
 * Which composer is on screen, finer than its key: agent pages all key their
 * new-chat composer {@link NEW_CHAT_KEY}, so the page's agent tells one from
 * the next, and the view tells an agent page's from the start screen's.
 */
function screenOf(): { scope: string; key: string | null } {
  const { activeView, activeLocalAgentId, activeExternalAgentId } = useUIStore.getState()
  const scope = activeView === 'local-agent' ? `local-agent:${activeLocalAgentId ?? ''}`
    : activeView === 'external-agent' ? `external-agent:${activeExternalAgentId ?? ''}`
    : activeView
  return { scope, key: composerKeyOnScreen() }
}

/**
 * The App-level rules for where the offer may be, in one place rather than in
 * each composer (the start screen's and a chat's are separate `ChatInput`s,
 * so neither sees the other's key change):
 *
 * - **A switch puts it away.** When the composer on screen changes — another
 *   chat, New chat, the first send on the start screen opening its chat,
 *   another agent's page, a view with no composer — an offer not raised on the
 *   new composer is dismissed. One mid-move (`pendingFrom`, Switch to
 *   *profile*) is left alone: the move settles it.
 * - **Minimal view gives way.** An offer raised (or moved) onto the composer
 *   on screen while minimal view is on leaves minimal view: the cloud has no
 *   notice panel, so nobody would see it — as a send error or an ask ends it.
 *
 * Returns the unsubscribe.
 */
export function watchSkillLinkScreen(): () => void {
  let screen = screenOf()
  const onScreenChange = (): void => {
    const next = screenOf()
    if (next.scope === screen.scope && next.key === screen.key) return
    const sameScope = next.scope === screen.scope
    screen = next
    const offer = useSkillLinkOfferStore.getState().offer
    if (!offer || offer.pendingFrom) return
    if (sameScope && next.key !== null && offer.chatKey === next.key) return
    useSkillLinkOfferStore.getState().dismiss(offer.id)
  }
  const onOffer = (offer: SkillLinkOffer | null, previous: SkillLinkOffer | null): void => {
    if (!offer || (previous && previous.id === offer.id && previous.chatKey === offer.chatKey)) return
    const ui = useUIStore.getState()
    if (!ui.minimalView) return
    const key = composerKeyOnScreen()
    if (key !== null && offerShowsOn(offer, key)) ui.setMinimalView(false)
  }
  const stops = [
    useUIStore.subscribe(onScreenChange),
    useChatStore.subscribe(onScreenChange),
    useSkillLinkOfferStore.subscribe((state, prev) => onOffer(state.offer, prev.offer))
  ]
  return () => stops.forEach((stop) => stop())
}

let lastRaisedAt: number | null = null

/** Test seam. */
export function _resetSkillLinkIntents(): void {
  lastRaisedAt = null
}

/**
 * A `cinna://skill/…` link the OS delivered: raise the offer on the composer
 * on screen, or, where the view has none, on a new chat's (the start screen).
 * Main has already focused the window. The intent is consumed by its
 * `receivedAt`, so a newer link that arrived meanwhile stays buffered.
 */
export function raiseSkillLinkIntent(intent: SkillLinkIntent): void {
  // The push and the mount's pull can both carry one intent (and StrictMode pulls twice): raised once.
  if (intent.receivedAt === lastRaisedAt) return
  lastRaisedAt = intent.receivedAt
  const key = composerKeyOnScreen()
  if (key === null) startAgentChat(null)
  useSkillLinkOfferStore.getState().raise(intent.link, key ?? NEW_CHAT_KEY)
  void window.api.skillLinks.consume(intent.receivedAt).catch((err: unknown) =>
    log.warn('could not consume the skill link intent', { message: String(err) })
  )
}

/**
 * Skill deep links, in the activated shell only: what main buffered before
 * there was a window (or before sign-in and onboarding ended) on mount, and
 * each push after. Also the offer's screen rules ({@link watchSkillLinkScreen}).
 */
export function useSkillLinkIntents(): void {
  useEffect(() => watchSkillLinkScreen(), [])
  useEffect(() => {
    let live = true
    const unsubscribe = window.api.skillLinks.onIntent((intent) => raiseSkillLinkIntent(intent))
    window.api.skillLinks
      .getPending()
      .then((intent) => {
        if (live && intent) raiseSkillLinkIntent(intent)
      })
      .catch((err: unknown) => log.warn('could not read the pending skill link', { message: String(err) }))
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
}
