import type { QueryClient } from '@tanstack/react-query'
import type { SkillLinkSkill } from '../../../../shared/skillLink'
import { refreshAfterSkillChange } from '../../hooks/useCatalogSkills'
import { NEW_CHAT_KEY, useSkillLinkOfferStore, type SkillLinkOffer } from '../../stores/skillLinkOffer.store'
import { useUIStore, type NewAgentSkill } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'

/**
 * New agent with this skill: open the existing new-agent flow (the Add an
 * agent dialog the Agents sidebar renders, at its name step, as the empty
 * agent pane opens it) with the skill title as the suggested name and the
 * package queued in `ui.store`. The offer is put away once the dialog is open;
 * closing the dialog without creating clears the queue
 * (`ui.store.setAddAgentDialog(null)`).
 */
export function openNewAgentWithSkill(skill: SkillLinkSkill, offer: SkillLinkOffer): void {
  const ui = useUIStore.getState()
  const previousSidebarTab = ui.sidebarTab !== 'agents' ? ui.sidebarTab : null
  ui.setNewAgentSkill({
    packageUuid: skill.packageUuid,
    title: skill.title,
    link: offer.link,
    chatKey: offer.pendingFrom ?? offer.chatKey,
    previousSidebarTab
  })
  // The dialog is rendered by the sidebar's agents list, so the sidebar shows Agents.
  if (previousSidebarTab !== null) ui.setSidebarTab('agents')
  ui.setAddAgentDialog('name')
  useSkillLinkOfferStore.getState().dismiss(offer.id)
}

/**
 * Close the Add an agent dialog. When it was opened by New agent with this
 * skill and nothing was created (the create clears the queue at its click),
 * the offer comes back on the composer it came from — a cancel loses nothing
 * — and, with `restoreTab` (a cancel rather than the list going away), the
 * sidebar tab the dialog switched from.
 */
export function closeAddAgentDialog(options: { restoreTab?: boolean } = {}): void {
  const ui = useUIStore.getState()
  const queued = ui.newAgentSkill
  ui.setAddAgentDialog(null)
  if (!queued) return
  if (queued.chatKey) useSkillLinkOfferStore.getState().raise(queued.link, queued.chatKey)
  if (options.restoreTab && queued.previousSidebarTab) ui.setSidebarTab(queued.previousSidebarTab)
}

/**
 * The add after the agent was created, from the dialog's create. Module-level
 * and awaited by nobody: the dialog closes as the agent lands, and a callback
 * on its mutation would be dropped with it. The agent stays whatever happens
 * (no rollback); a refusal raises the offer again on the new agent's composer
 * — its page opens on its new-chat screen — with Add's own sentence.
 * `queryClient` is the dialog's, which outlives it: the app's one client.
 */
export async function addSkillToCreatedAgent(agentId: string, queued: NewAgentSkill, queryClient: QueryClient): Promise<void> {
  let message: string | null = null
  try {
    const result = await window.api.catalogSkills.add(agentId, queued.packageUuid)
    // The re-reads every other Add runs, so the new agent's Addons tab shows the skill.
    if (result.ok) refreshAfterSkillChange(queryClient, agentId)
    else message = result.message
  } catch (err) {
    message = unwrapIpcError(err, 'The skill could not be added.')
  }
  if (message !== null) useSkillLinkOfferStore.getState().raise(queued.link, NEW_CHAT_KEY, { addError: message })
}
