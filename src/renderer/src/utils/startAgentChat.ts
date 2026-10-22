import { useAuthStore } from '../stores/auth.store'
import { useChatStore } from '../stores/chat.store'
import { NEW_CHAT_DRAFT_SURFACE, composerDraftKey, useComposerDraftStore } from '../stores/composerDraft.store'
import { useUIStore } from '../stores/ui.store'
import { mergePathRefs, type ComposerPathRef, type PathMentionAgentMatch } from '../../../shared/pathMentions'
import type { ShortcutAgent } from './appShortcuts'

/**
 * The same landing every "chat with this agent" action uses: the new-chat
 * screen, the agent preselected by `ChatWorkspace` (which also focuses the
 * composer), the Chats list beside it.
 *
 * `draft` is added to the new-chat composer first — on a line of its own
 * under whatever the user had already typed there — so it is in the input
 * when the screen mounts, with the caret after it. `pathRefs` are added as
 * reference chips, after the ones already there, skipping a path already
 * referenced.
 *
 * With `agentId` null the new-chat screen opens with whatever agent selection
 * its draft already holds. So it does for an `agentMatch` of `recent` (a
 * mention's fallback guess, not a folder match) when the draft already has
 * agents: the guess never replaces the user's own pick.
 */
export function startAgentChat(
  requestedAgentId: string | null,
  options: { draft?: string; pathRefs?: readonly ComposerPathRef[]; agentMatch?: PathMentionAgentMatch } = {}
): void {
  const agentId = agentToApply(requestedAgentId, options.agentMatch)
  addToNewChatDraft(options)
  const ui = useUIStore.getState()
  ui.setActiveJobId(null)
  if (agentId) ui.setPendingAgentId(agentId)
  // `ChatWorkspace` leaves the open chat for a pending agent; with none, this does.
  else useChatStore.getState().setActiveChatId(null)
  ui.setActiveView('chat')
  ui.setSidebarTab('chats')
}

function newChatDraftKey(): string {
  return composerDraftKey(useAuthStore.getState().currentUser?.id, NEW_CHAT_DRAFT_SURFACE)
}

/**
 * `agentId`, unless it is only the `recent` fallback and the new-chat draft
 * already has agents of the user's choosing — then null, leaving them be.
 */
function agentToApply(agentId: string | null, agentMatch: PathMentionAgentMatch | undefined): string | null {
  if (!agentId || agentMatch !== 'recent') return agentId
  const chosen = useComposerDraftStore.getState().drafts[newChatDraftKey()]?.pendingAgentIds
  return chosen?.length ? null : agentId
}

/** `draft` and `pathRefs` added to the new-chat composer, as {@link startAgentChat} describes. */
function addToNewChatDraft(
  options: { draft?: string; pathRefs?: readonly ComposerPathRef[]; agentId?: string | null }
): void {
  const { draft, pathRefs, agentId } = options
  if (!draft && !pathRefs?.length && !agentId) return
  useComposerDraftStore.getState().update(newChatDraftKey(), (current) => ({
    ...(draft ? { text: current.text.trim() ? `${current.text.replace(/\n+$/, '')}\n${draft}` : draft } : {}),
    ...(pathRefs?.length ? { pathRefs: mergePathRefs(current.pathRefs, pathRefs) } : {}),
    ...(agentId ? { pendingAgentIds: [agentId] } : {})
  }))
}

/**
 * {@link startAgentChat} without the navigation: the chips go into the
 * new-chat draft and `agentId`, when there is one, becomes its agent — what
 * `ChatWorkspace` does with a pending agent — while the screen the user is on
 * stays as it is. For an arrival that must not throw away a form or a dialog
 * in progress. A `recent` match is applied only to a draft with no agents yet,
 * as in {@link startAgentChat}.
 */
export function addToNewChat(
  agentId: string | null,
  pathRefs: readonly ComposerPathRef[],
  agentMatch?: PathMentionAgentMatch
): void {
  addToNewChatDraft({ pathRefs, agentId: agentToApply(agentId, agentMatch) })
}

/**
 * Why a chat cannot be started with `agentId`: disabled when it is still
 * listed as a switched-off agent, otherwise `missing`.
 */
export function unavailableAgentMessage(
  agents: readonly ShortcutAgent[],
  agentId: string,
  missing: string
): string {
  const listed = agents.find((a) => a.id === agentId)
  return listed && !listed.enabled && !listed.conductor ? `${listed.name} is disabled` : missing
}
