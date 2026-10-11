import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from './client'
import { inboxDismissals } from './schema'

/** The Inbox card kinds a user can dismiss. */
export type InboxDismissalKind = 'skill_disconnected'

/**
 * Inbox cards the user dismissed, per profile (`user_id`). A dismissal hides
 * one card while the state it was dismissed in lasts; the card's own
 * computation calls {@link inboxDismissalRepo.clear} once that state is over,
 * so the next occurrence shows a new card.
 */
export const inboxDismissalRepo = {
  /** The dismissed keys of one kind. */
  keys(userId: string, kind: InboxDismissalKind): Set<string> {
    const rows = getDb()
      .select({ itemKey: inboxDismissals.itemKey })
      .from(inboxDismissals)
      .where(and(eq(inboxDismissals.userId, userId), eq(inboxDismissals.kind, kind)))
      .all()
    return new Set(rows.map((row) => row.itemKey))
  },

  /** Dismiss one card. Idempotent. */
  put(userId: string, kind: InboxDismissalKind, itemKey: string): void {
    getDb()
      .insert(inboxDismissals)
      .values({ userId, kind, itemKey, createdAt: new Date() })
      .onConflictDoNothing()
      .run()
  },

  /** Forget dismissals, so the next occurrence of those cards shows again. */
  clear(userId: string, kind: InboxDismissalKind, itemKeys: readonly string[]): void {
    if (itemKeys.length === 0) return
    getDb()
      .delete(inboxDismissals)
      .where(and(eq(inboxDismissals.userId, userId), eq(inboxDismissals.kind, kind), inArray(inboxDismissals.itemKey, [...itemKeys])))
      .run()
  }
}
