import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { getDb } from './client'
import { chatArtifactCards, publishedArtifacts } from './schema'
import type { ArtifactKind, ArtifactVisibility } from '../../shared/artifacts'

export type PublishedArtifactRow = typeof publishedArtifacts.$inferSelect
export type ChatArtifactCardRow = typeof chatArtifactCards.$inferSelect

/** What a publish or a Share action knows about the artifact afterwards. */
export interface PublishedArtifactState {
  artifactId: string
  title: string
  kind: ArtifactKind
  revision: number
  visibility: ArtifactVisibility
  url: string
  liveLinkCount: number
}

/**
 * The local memory of published artifacts (A12) and the chat cards that show
 * them. Keyed by profile and server: the same path published from two
 * accounts is two artifacts.
 */
export const publishedArtifactRepo = {
  /** The latest artifact `sourcePath` was published as, for *Update*. */
  findBySource(profileUserId: string, serverUrl: string, sourcePath: string): PublishedArtifactRow | null {
    return (
      getDb()
        .select()
        .from(publishedArtifacts)
        .where(
          and(
            eq(publishedArtifacts.profileUserId, profileUserId),
            eq(publishedArtifacts.serverUrl, serverUrl),
            eq(publishedArtifacts.sourcePath, sourcePath)
          )
        )
        .orderBy(desc(publishedArtifacts.updatedAt))
        .get() ?? null
    )
  },

  get(profileUserId: string, serverUrl: string, artifactId: string): PublishedArtifactRow | null {
    return (
      getDb()
        .select()
        .from(publishedArtifacts)
        .where(
          and(
            eq(publishedArtifacts.profileUserId, profileUserId),
            eq(publishedArtifacts.serverUrl, serverUrl),
            eq(publishedArtifacts.artifactId, artifactId)
          )
        )
        .get() ?? null
    )
  },

  /** After a publish: insert, or move the row to the new revision and source. */
  recordPublish(
    profileUserId: string,
    serverUrl: string,
    source: { sourcePath: string; agentId: string },
    state: PublishedArtifactState
  ): void {
    const now = new Date()
    const existing = this.get(profileUserId, serverUrl, state.artifactId)
    if (existing) {
      getDb()
        .update(publishedArtifacts)
        .set({ ...source, ...state, updatedAt: now })
        .where(eq(publishedArtifacts.id, existing.id))
        .run()
      return
    }
    getDb()
      .insert(publishedArtifacts)
      .values({ id: randomUUID(), profileUserId, serverUrl, ...source, ...state, createdAt: now, updatedAt: now })
      .run()
  },

  /** After a Share action or a detail read: core's current values. No row, nothing to sync. */
  sync(profileUserId: string, serverUrl: string, state: PublishedArtifactState): void {
    const existing = this.get(profileUserId, serverUrl, state.artifactId)
    if (!existing) return
    getDb()
      .update(publishedArtifacts)
      .set({ ...state, updatedAt: existing.updatedAt })
      .where(eq(publishedArtifacts.id, existing.id))
      .run()
  },

  /**
   * The user approved `agentId` publishing this artifact (D2): its later
   * republish of the same path, while the artifact stays private, needs no card.
   */
  setApprovedAgent(profileUserId: string, serverUrl: string, artifactId: string, agentId: string): void {
    getDb()
      .update(publishedArtifacts)
      .set({ approvedAgentId: agentId })
      .where(
        and(
          eq(publishedArtifacts.profileUserId, profileUserId),
          eq(publishedArtifacts.serverUrl, serverUrl),
          eq(publishedArtifacts.artifactId, artifactId)
        )
      )
      .run()
  },

  /** The distinct page URLs core gave this profile's artifacts on this server: where its frontend lives. */
  urls(profileUserId: string, serverUrl: string): string[] {
    return getDb()
      .selectDistinct({ url: publishedArtifacts.url })
      .from(publishedArtifacts)
      .where(and(eq(publishedArtifacts.profileUserId, profileUserId), eq(publishedArtifacts.serverUrl, serverUrl)))
      .all()
      .map((row) => row.url)
      .filter((url) => url !== '')
  },

  /** An artifact deleted on core: forget it, so *Update* is no longer offered. */
  forget(profileUserId: string, serverUrl: string, artifactId: string): void {
    getDb()
      .delete(publishedArtifacts)
      .where(
        and(
          eq(publishedArtifacts.profileUserId, profileUserId),
          eq(publishedArtifacts.serverUrl, serverUrl),
          eq(publishedArtifacts.artifactId, artifactId)
        )
      )
      .run()
  },

  /** One card per (chat, message, artifact): publishing again from the same message adds none. */
  addCard(profileUserId: string, chatId: string, messageId: string, artifactId: string): void {
    const db = getDb()
    const existing = db
      .select({ id: chatArtifactCards.id })
      .from(chatArtifactCards)
      .where(
        and(
          eq(chatArtifactCards.chatId, chatId),
          eq(chatArtifactCards.messageId, messageId),
          eq(chatArtifactCards.artifactId, artifactId)
        )
      )
      .get()
    if (existing) return
    db.insert(chatArtifactCards)
      .values({ id: randomUUID(), profileUserId, chatId, messageId, artifactId, createdAt: new Date() })
      .run()
  },

  /** A chat's cards for this profile, oldest first, with the artifact each shows (cards without one are left out). */
  cards(profileUserId: string, serverUrl: string, chatId: string): Array<{ card: ChatArtifactCardRow; artifact: PublishedArtifactRow }> {
    const db = getDb()
    const cards = db
      .select()
      .from(chatArtifactCards)
      .where(and(eq(chatArtifactCards.profileUserId, profileUserId), eq(chatArtifactCards.chatId, chatId)))
      .orderBy(asc(chatArtifactCards.createdAt))
      .all()
    if (cards.length === 0) return []
    const ids = [...new Set(cards.map((card) => card.artifactId))]
    const rows = db
      .select()
      .from(publishedArtifacts)
      .where(
        and(
          eq(publishedArtifacts.profileUserId, profileUserId),
          eq(publishedArtifacts.serverUrl, serverUrl),
          inArray(publishedArtifacts.artifactId, ids)
        )
      )
      .all()
    const byId = new Map(rows.map((row) => [row.artifactId, row]))
    return cards.flatMap((card) => {
      const artifact = byId.get(card.artifactId)
      return artifact ? [{ card, artifact }] : []
    })
  }
}
