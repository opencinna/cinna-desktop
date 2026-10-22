import { useEffect } from 'react'
import { addToNewChat, startAgentChat } from '../utils/startAgentChat'
import { useToastStore } from '../stores/toast.store'
import { useUIStore } from '../stores/ui.store'
import { createLogger } from '../stores/logger.store'
import { pathRefLabel, type ComposerPathRef } from '../../../shared/pathMentions'

const log = createLogger('path-mentions')

/** What the toast says when the chips were added without leaving the screen. */
export function addedToNewChatMessage(refs: readonly ComposerPathRef[]): string {
  return refs.length === 1
    ? `${pathRefLabel(refs[0].path)} added to a new chat`
    : `${refs.length} items added to a new chat`
}

/**
 * Whether the user is in the middle of something a navigation would throw
 * away: a dialog is open (the same check as the app shortcuts), or the screen
 * is not the chat view — Settings with a half-filled form, say.
 */
function busyElsewhere(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null || useUIStore.getState().activeView !== 'chat'
}

/**
 * Take what main holds and, when there is anything, land on the new-chat
 * screen with it — with the agent whose folder holds the first path, or, when
 * the new-chat draft has no agents yet, the most recently used folder agent. When that would throw away work in progress, the chips go
 * into the new-chat draft instead and a toast says so.
 */
export async function takePathMentions(): Promise<void> {
  const { refs, agentId, agentMatch } = await window.api.pathMention.take()
  if (refs.length === 0) return
  if (busyElsewhere()) {
    addToNewChat(agentId, refs, agentMatch)
    useToastStore.getState().show(addedToNewChatMessage(refs), { link: null })
    return
  }
  startAgentChat(agentId, { pathRefs: refs, agentMatch })
}

/**
 * Files and folders sent from Finder ("Mention in Cinna") become reference
 * chips in the new-chat composer, with the folder agent main picked.
 *
 * Mounted in the signed-in, onboarded shell only: before that main keeps the
 * paths, and this takes them on mount. Afterwards each push from main is a
 * reason to take again. A take is never dropped on unmount — main has already
 * cleared its buffer, so the result is applied regardless.
 */
export function usePathMentions(): void {
  useEffect(() => {
    const take = (): void => {
      takePathMentions().catch((err) => log.warn('could not take mentioned paths', { message: String(err) }))
    }
    const unsubscribe = window.api.pathMention.onPending(take)
    take()
    return unsubscribe
  }, [])
}
