import { nanoid } from 'nanoid'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { getDb } from './client'
import { notes, noteFolders } from './schema'
import { syncRepo } from './sync'

export type NoteRow = typeof notes.$inferSelect
export type NoteFolderRow = typeof noteFolders.$inferSelect

export interface NoteCreateInput {
  title?: string
  body?: string
}

export interface NotePatch {
  title?: string
  body?: string
}

export interface NoteFolderCreateInput {
  name: string
}

export interface NoteFolderPatch {
  name?: string
  collapsed?: boolean
}

/** Decoded row delivered by the sync engine (see `src/main/sync/collections.ts`). */
export interface NoteSyncValues {
  id: string
  title: string
  body: string
  folderId: string | null
  position: number
  /** Peer's client timestamp — applied verbatim so a replica never re-wins LWW. */
  updatedAt: Date
  deletedAt: Date | null
}

export interface NoteFolderSyncValues {
  id: string
  name: string
  collapsed: boolean
  position: number
  /** Peer's client timestamp — applied verbatim so a replica never re-wins LWW. */
  updatedAt: Date
}

export const notesRepo = {
  list(userId: string): NoteRow[] {
    return getDb()
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), isNull(notes.deletedAt)))
      .orderBy(asc(notes.position), desc(notes.updatedAt))
      .all()
  },

  getById(userId: string, noteId: string): NoteRow | undefined {
    return getDb()
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .get()
  },

  minPositionInFolder(userId: string, folderId: string | null): number | null {
    const cond =
      folderId === null
        ? and(eq(notes.userId, userId), isNull(notes.folderId), isNull(notes.deletedAt))
        : and(
            eq(notes.userId, userId),
            eq(notes.folderId, folderId),
            isNull(notes.deletedAt)
          )
    const row = getDb()
      .select({ minPos: sql<number | null>`min(${notes.position})` })
      .from(notes)
      .where(cond)
      .get()
    return row?.minPos ?? null
  },

  create(userId: string, input: NoteCreateInput): NoteRow {
    const now = new Date()
    // New notes go to the top of the root group, matching the jobs UX.
    const min = this.minPositionInFolder(userId, null)
    const position = min !== null ? min - 1 : 0
    const row = {
      id: nanoid(),
      userId,
      title: input.title ?? 'Untitled note',
      body: input.body ?? '',
      folderId: null,
      position,
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    }
    getDb().insert(notes).values(row).run()
    return row
  },

  update(userId: string, noteId: string, patch: NotePatch): boolean {
    const result = getDb()
      .update(notes)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .run()
    return result.changes > 0
  },

  softDelete(userId: string, noteId: string): boolean {
    const result = getDb()
      .update(notes)
      .set({ deletedAt: new Date() })
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .run()
    return result.changes > 0
  },

  listTrash(userId: string): NoteRow[] {
    return getDb()
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), isNotNull(notes.deletedAt)))
      .orderBy(desc(notes.deletedAt))
      .all()
  },

  restore(userId: string, noteId: string): boolean {
    const result = getDb()
      .update(notes)
      .set({ deletedAt: null })
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .run()
    return result.changes > 0
  },

  permanentDelete(userId: string, noteId: string): boolean {
    // Tombstone BEFORE the hard delete so the delete propagates to peers.
    syncRepo.addTombstone(userId, 'note', noteId, Date.now())
    const result = getDb()
      .delete(notes)
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .run()
    return result.changes > 0
  },

  emptyTrash(userId: string): number {
    const trashed = getDb()
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.userId, userId), isNotNull(notes.deletedAt)))
      .all()
    const now = Date.now()
    for (const { id } of trashed) syncRepo.addTombstone(userId, 'note', id, now)
    const result = getDb()
      .delete(notes)
      .where(and(eq(notes.userId, userId), isNotNull(notes.deletedAt)))
      .run()
    return result.changes
  },

  /**
   * Count how many of the given note ids belong to the user and are live
   * (not in trash). Used by the service layer as a single-query ownership
   * check before a reorder, replacing what would otherwise be an N+1 loop.
   */
  countOwned(userId: string, ids: string[]): number {
    if (ids.length === 0) return 0
    const row = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(notes)
      .where(
        and(
          eq(notes.userId, userId),
          isNull(notes.deletedAt),
          inArray(notes.id, ids)
        )
      )
      .get()
    return row?.n ?? 0
  },

  /**
   * Move + reorder notes inside a single target group (folder or root). The
   * caller passes the full ordered list of note ids for that group; every id
   * is rewritten with `folderId = targetFolderId` and a fresh `position` so
   * the destination group's ordering exactly matches the array.
   */
  reorderInGroup(
    userId: string,
    targetFolderId: string | null,
    orderedNoteIds: string[]
  ): void {
    const db = getDb()
    db.transaction((tx) => {
      orderedNoteIds.forEach((id, idx) => {
        tx.update(notes)
          .set({ folderId: targetFolderId, position: idx })
          .where(and(eq(notes.id, id), eq(notes.userId, userId)))
          .run()
      })
    })
  },

  // ---- Data-sync engine helpers ------------------------------------------
  // These back `src/main/sync/collections.ts`. Distinct from `list()` because
  // sync must include soft-deleted rows (they propagate as `deleted=true`) and
  // every write is scoped to the owning user (cross-profile defence in depth).

  /** Rows changed since `sinceMs` (exclusive), INCLUDING soft-deleted ones. */
  listChangedSince(userId: string, sinceMs: number): NoteRow[] {
    return getDb()
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), gt(notes.updatedAt, new Date(sinceMs))))
      .all()
  },

  /** Highest `updatedAt` (ms epoch) across the user's notes; 0 if none. */
  maxUpdatedAt(userId: string): number {
    const rows = getDb()
      .select({ u: notes.updatedAt })
      .from(notes)
      .where(eq(notes.userId, userId))
      .all()
    return rows.reduce((m, r) => Math.max(m, r.u ? r.u.getTime() : 0), 0)
  },

  /**
   * Upsert a row delivered by the sync engine. Scoped: if a row with this id
   * already exists under a DIFFERENT user, the write is refused (the engine
   * only ever runs for the active profile, so a colliding id means trouble).
   */
  upsertFromSync(userId: string, values: NoteSyncValues): void {
    const db = getDb()
    const existing = db
      .select({ uid: notes.userId })
      .from(notes)
      .where(eq(notes.id, values.id))
      .get()
    if (existing && existing.uid !== userId) return
    const row = {
      id: values.id,
      userId,
      title: values.title,
      body: values.body,
      folderId: values.folderId,
      position: values.position,
      deletedAt: values.deletedAt,
      updatedAt: values.updatedAt
    }
    db.insert(notes)
      .values(row)
      .onConflictDoUpdate({
        target: notes.id,
        set: {
          title: row.title,
          body: row.body,
          folderId: row.folderId,
          position: row.position,
          deletedAt: row.deletedAt,
          updatedAt: row.updatedAt
        }
      })
      .run()
  },

  /** Hard-delete a row, scoped to the owning user. */
  deleteOwned(userId: string, noteId: string): void {
    getDb().delete(notes).where(and(eq(notes.id, noteId), eq(notes.userId, userId))).run()
  }
}

export const noteFoldersRepo = {
  list(userId: string): NoteFolderRow[] {
    return getDb()
      .select()
      .from(noteFolders)
      .where(eq(noteFolders.userId, userId))
      .orderBy(asc(noteFolders.position), asc(noteFolders.createdAt))
      .all()
  },

  getById(userId: string, folderId: string): NoteFolderRow | undefined {
    return getDb()
      .select()
      .from(noteFolders)
      .where(and(eq(noteFolders.id, folderId), eq(noteFolders.userId, userId)))
      .get()
  },

  maxPosition(userId: string): number | null {
    const row = getDb()
      .select({ maxPos: sql<number | null>`max(${noteFolders.position})` })
      .from(noteFolders)
      .where(eq(noteFolders.userId, userId))
      .get()
    return row?.maxPos ?? null
  },

  create(userId: string, input: NoteFolderCreateInput): NoteFolderRow {
    const max = this.maxPosition(userId)
    const position = max !== null ? max + 1 : 0
    const now = new Date()
    const row = {
      id: nanoid(),
      userId,
      name: input.name,
      position,
      collapsed: false,
      createdAt: now,
      updatedAt: now
    }
    getDb().insert(noteFolders).values(row).run()
    return row
  },

  update(userId: string, folderId: string, patch: NoteFolderPatch): boolean {
    const result = getDb()
      .update(noteFolders)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(noteFolders.id, folderId), eq(noteFolders.userId, userId)))
      .run()
    return result.changes > 0
  },

  /**
   * Delete a folder. Notes inside are detached back to the root group in the
   * same transaction so a folder delete never loses notes.
   */
  delete(userId: string, folderId: string): boolean {
    const ok = getDb().transaction((tx) => {
      tx.update(notes)
        .set({ folderId: null })
        .where(and(eq(notes.userId, userId), eq(notes.folderId, folderId)))
        .run()
      const result = tx
        .delete(noteFolders)
        .where(and(eq(noteFolders.id, folderId), eq(noteFolders.userId, userId)))
        .run()
      return result.changes > 0
    })
    if (ok) syncRepo.addTombstone(userId, 'note_folder', folderId, Date.now())
    return ok
  },

  /**
   * Single-query ownership check for a batch of folder ids. Mirrors
   * `notesRepo.countOwned`.
   */
  countOwned(userId: string, ids: string[]): number {
    if (ids.length === 0) return 0
    const row = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(noteFolders)
      .where(
        and(eq(noteFolders.userId, userId), inArray(noteFolders.id, ids))
      )
      .get()
    return row?.n ?? 0
  },

  reorder(userId: string, orderedIds: string[]): void {
    const db = getDb()
    db.transaction((tx) => {
      orderedIds.forEach((id, idx) => {
        tx.update(noteFolders)
          .set({ position: idx, updatedAt: new Date() })
          .where(and(eq(noteFolders.id, id), eq(noteFolders.userId, userId)))
          .run()
      })
    })
  },

  // ---- Data-sync engine helpers ------------------------------------------

  listChangedSince(userId: string, sinceMs: number): NoteFolderRow[] {
    return getDb()
      .select()
      .from(noteFolders)
      .where(and(eq(noteFolders.userId, userId), gt(noteFolders.updatedAt, new Date(sinceMs))))
      .all()
  },

  maxUpdatedAt(userId: string): number {
    const rows = getDb()
      .select({ u: noteFolders.updatedAt })
      .from(noteFolders)
      .where(eq(noteFolders.userId, userId))
      .all()
    return rows.reduce((m, r) => Math.max(m, r.u ? r.u.getTime() : 0), 0)
  },

  upsertFromSync(userId: string, values: NoteFolderSyncValues): void {
    const db = getDb()
    const existing = db
      .select({ uid: noteFolders.userId })
      .from(noteFolders)
      .where(eq(noteFolders.id, values.id))
      .get()
    if (existing && existing.uid !== userId) return
    const row = {
      id: values.id,
      userId,
      name: values.name,
      collapsed: values.collapsed,
      position: values.position,
      updatedAt: values.updatedAt
    }
    db.insert(noteFolders)
      .values(row)
      .onConflictDoUpdate({
        target: noteFolders.id,
        set: {
          name: row.name,
          collapsed: row.collapsed,
          position: row.position,
          updatedAt: row.updatedAt
        }
      })
      .run()
  },

  /**
   * Hard-delete a folder delivered by sync: detach this user's child notes back
   * to root, then remove the folder. All clauses scoped to the owning user.
   */
  deleteOwnedWithDetach(userId: string, folderId: string): void {
    getDb().transaction((tx) => {
      tx.update(notes)
        .set({ folderId: null })
        .where(and(eq(notes.userId, userId), eq(notes.folderId, folderId)))
        .run()
      tx.delete(noteFolders)
        .where(and(eq(noteFolders.id, folderId), eq(noteFolders.userId, userId)))
        .run()
    })
  }
}
