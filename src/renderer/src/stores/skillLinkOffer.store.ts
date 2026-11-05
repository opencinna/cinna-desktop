import { create } from 'zustand'
import type { SkillLink } from '../../../shared/skillLink'

/**
 * The one skill-link offer on screen: a link the person pasted into a
 * composer, clicked in a transcript, or that the OS delivered as
 * `cinna://skill/…`. At most one at a time — a newer link replaces it.
 *
 * Held per composer by `chatKey` (the chat's id, or {@link NEW_CHAT_KEY} for
 * the start screen / an agent page's new chat): only the composer with that
 * key shows it. A store rather than composer state so it survives what the
 * composer does not — the profile switch `other_profile` asks for remounts
 * the chat, and the new-agent flow lands on another page.
 */
export const NEW_CHAT_KEY = 'new'

export function skillLinkChatKey(chatId: string | null): string {
  return chatId ?? NEW_CHAT_KEY
}

/** Whether the composer keyed `chatKey` shows `offer`: its own key, or the one a pending move is leaving. */
export function offerShowsOn(offer: SkillLinkOffer | null, chatKey: string): boolean {
  return offer !== null && (offer.chatKey === chatKey || (!!offer.pendingFrom && offer.pendingFrom === chatKey))
}

export interface SkillLinkOffer {
  /** Increments per raise, so a re-raised identical link resolves fresh. */
  id: number
  link: SkillLink
  chatKey: string
  /**
   * Add's own refusal, carried over when the offer moved (New agent with this
   * skill created the agent, then the add failed): the row shows it on arrival.
   */
  addError?: string | null
  /**
   * The composer it is leaving while a move is in flight (Switch to *profile*
   * runs its login): the row shows on both keys meanwhile, so it neither
   * vanishes at the click nor comes back on a failure (ux_rules rule 1), and
   * a screen change does not put it away. Cleared when the move settles.
   */
  pendingFrom?: string | null
}

interface SkillLinkOfferStore {
  offer: SkillLinkOffer | null
  raise: (link: SkillLink, chatKey: string, options?: { addError?: string | null }) => void
  /**
   * Move the offer to another composer without resolving it as a new link.
   * With `from`, the move is pending: the offer shows on `from` too until a
   * later `moveTo` without it.
   */
  moveTo: (chatKey: string, options?: { from?: string }) => void
  /** With `id`, only that offer: a late answer must not put away a newer link. */
  dismiss: (id?: number) => void
}

let nextId = 1

export const useSkillLinkOfferStore = create<SkillLinkOfferStore>((set, get) => ({
  offer: null,
  raise: (link, chatKey, options) =>
    set({ offer: { id: nextId++, link, chatKey, addError: options?.addError ?? null } }),
  moveTo: (chatKey, options) => {
    const offer = get().offer
    if (offer) set({ offer: { ...offer, chatKey, pendingFrom: options?.from ?? null } })
  },
  dismiss: (id) => {
    const offer = get().offer
    if (!offer || (id !== undefined && offer.id !== id)) return
    set({ offer: null })
  }
}))
