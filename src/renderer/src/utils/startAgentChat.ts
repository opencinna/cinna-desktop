import { useAuthStore } from '../stores/auth.store'
import { NEW_CHAT_DRAFT_SURFACE, composerDraftKey, useComposerDraftStore } from '../stores/composerDraft.store'
import { useUIStore } from '../stores/ui.store'
import type { ShortcutAgent } from './appShortcuts'

/**
 * The same landing every "chat with this agent" action uses: the new-chat
 * screen, the agent preselected by `ChatWorkspace` (which also focuses the
 * composer), the Chats list beside it.
 *
 * `draft` is added to the new-chat composer first — on a line of its own
 * under whatever the user had already typed there — so it is in the input
 * when the screen mounts, with the caret after it.
 */
export function startAgentChat(agentId: string, options: { draft?: string } = {}): void {
  const { draft } = options
  if (draft) {
    const key = composerDraftKey(useAuthStore.getState().currentUser?.id, NEW_CHAT_DRAFT_SURFACE)
    useComposerDraftStore.getState().update(key, (current) => ({
      text: current.text.trim() ? `${current.text.replace(/\n+$/, '')}\n${draft}` : draft
    }))
  }
  const ui = useUIStore.getState()
  ui.setActiveJobId(null)
  ui.setPendingAgentId(agentId)
  ui.setActiveView('chat')
  ui.setSidebarTab('chats')
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
