import type { ChatModeRuntime } from '../../shared/chatModeRuntime'
import type { AgentEngine } from '../../shared/engine'
import { nanoid } from 'nanoid'
import { and, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { getDb } from './client'
import { chatModes, mcpProviders } from './schema'
import type * as schema from './schema'

export type ChatModeRow = Omit<typeof chatModes.$inferSelect, keyof ChatModeRuntime> & ChatModeRuntime

export interface ChatModeUpsertInput extends ChatModeRuntime {
  id?: string
  name: string
  providerId?: string | null
  modelId?: string | null
  mcpProviderIds?: string[]
  colorPreset?: string
  isDefault?: boolean
  managed?: boolean
  adminManaged?: boolean
}

type DrizzleDb = BetterSQLite3Database<typeof schema>
type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0]
/** A Drizzle handle that may be either the global db or a transaction proxy. */
export type DbOrTx = DrizzleDb | DrizzleTx

export const chatModeRepo = {
  list(userId: string, db: DbOrTx = getDb()): ChatModeRow[] {
    return db.select().from(chatModes).where(eq(chatModes.userId, userId)).all()
  },

  /** List modes across a set of scopes (Default + active profile). */
  listByUserIds(userIds: string[], db: DbOrTx = getDb()): ChatModeRow[] {
    if (userIds.length === 0) return []
    return db.select().from(chatModes).where(inArray(chatModes.userId, userIds)).all()
  },

  /** Managed (account-provisioned) rows for a profile — used by sync prune. */
  listManaged(userId: string, db: DbOrTx = getDb()): ChatModeRow[] {
    return db
      .select()
      .from(chatModes)
      .where(and(eq(chatModes.userId, userId), eq(chatModes.managed, true)))
      .all()
  },

  getOwned(userId: string, id: string, db: DbOrTx = getDb()): ChatModeRow | undefined {
    return db
      .select()
      .from(chatModes)
      .where(and(eq(chatModes.id, id), eq(chatModes.userId, userId)))
      .get()
  },

  /** Clears the `isDefault` flag on every chat mode owned by the user. */
  clearDefaults(userId: string, db: DbOrTx = getDb()): void {
    db.update(chatModes).set({ isDefault: false }).where(eq(chatModes.userId, userId)).run()
  },

  insert(
    userId: string,
    input: ChatModeUpsertInput,
    db: DbOrTx = getDb()
  ): { id: string; created: true } {
    // Honor a caller-provided id (account-config sync seeds deterministic
    // `managed-mode:{credentialId}` ids); otherwise generate one.
    const id = input.id ?? nanoid()
    db.insert(chatModes)
      .values({
        id,
        userId,
        name: input.name,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        engine: input.engine ?? (input.providerId ? 'opencode' : null),
        systemPrompt: input.systemPrompt ?? '',
        toolPolicy: input.toolPolicy ?? 'connectors',
        complexity: input.complexity ?? null,
        builtinEngine: input.builtinEngine ?? null,
        mcpProviderIds: input.mcpProviderIds ?? [],
        colorPreset: input.colorPreset ?? 'slate',
        isDefault: input.isDefault ?? false,
        managed: input.managed ?? false,
        adminManaged: input.adminManaged ?? false,
        createdAt: new Date()
      })
      .run()
    return { id, created: true }
  },

  update(
    userId: string,
    id: string,
    input: ChatModeUpsertInput,
    db: DbOrTx = getDb()
  ): ChatModeRow | undefined {
    const existing = chatModeRepo.getOwned(userId, id, db)
    if (!existing) return undefined

    db.update(chatModes)
      .set({
        name: input.name,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        engine: input.engine !== undefined ? input.engine : (existing.engine ?? (input.providerId ? 'opencode' : null)),
        systemPrompt: input.systemPrompt ?? existing.systemPrompt ?? '',
        toolPolicy: input.toolPolicy ?? existing.toolPolicy ?? 'connectors',
        // Absent keeps the stored tier (callers that predate Effort); null clears it.
        complexity: input.complexity !== undefined ? input.complexity : (existing.complexity ?? null),
        // What makes a row a runtime mode is fixed at creation.
        builtinEngine: existing.builtinEngine ?? null,
        mcpProviderIds: input.mcpProviderIds ?? [],
        colorPreset: input.colorPreset ?? 'slate',
        isDefault: input.isDefault ?? existing.isDefault,
        managed: input.managed ?? existing.managed,
        adminManaged: input.adminManaged ?? existing.adminManaged
      })
      .where(and(eq(chatModes.id, id), eq(chatModes.userId, userId)))
      .run()
    return existing
  },

  /** The user's runtime mode for `engine`, if it exists. */
  getRuntimeMode(userId: string, engine: AgentEngine, db: DbOrTx = getDb()): ChatModeRow | undefined {
    return db
      .select()
      .from(chatModes)
      .where(and(eq(chatModes.userId, userId), eq(chatModes.builtinEngine, engine)))
      .get()
  },

  /** Rename a row; used only to keep a runtime mode on its engine's current name. */
  setName(userId: string, id: string, name: string, db: DbOrTx = getDb()): void {
    db.update(chatModes).set({ name }).where(and(eq(chatModes.id, id), eq(chatModes.userId, userId))).run()
  },

  /** Set a row's colour alone: the one write that may touch a managed mode's. */
  setColorPreset(ownerUserId: string, id: string, colorPreset: string, db: DbOrTx = getDb()): boolean {
    const result = db.update(chatModes)
      .set({ colorPreset })
      .where(and(eq(chatModes.id, id), eq(chatModes.userId, ownerUserId)))
      .run()
    return result.changes > 0
  },

  /**
   * Insert a runtime mode unless the user already has one for its engine. The
   * partial unique index on `(user_id, builtin_engine)` is what makes two
   * concurrent calls create one row: the loser's insert is ignored.
   */
  insertRuntimeModeIfMissing(
    userId: string,
    input: ChatModeUpsertInput & { builtinEngine: AgentEngine },
    db: DbOrTx = getDb()
  ): boolean {
    const result = db.insert(chatModes)
      .values({
        id: nanoid(),
        userId,
        name: input.name,
        providerId: null,
        modelId: null,
        engine: input.builtinEngine,
        systemPrompt: input.systemPrompt ?? '',
        toolPolicy: input.toolPolicy ?? 'connectors',
        complexity: input.complexity ?? null,
        builtinEngine: input.builtinEngine,
        mcpProviderIds: [],
        colorPreset: input.colorPreset ?? 'slate',
        isDefault: false,
        managed: false,
        adminManaged: false,
        createdAt: new Date()
      })
      .onConflictDoNothing()
      .run()
    return result.changes > 0
  },

  delete(userId: string, id: string, db: DbOrTx = getDb()): boolean {
    const result = db
      .delete(chatModes)
      .where(and(eq(chatModes.id, id), eq(chatModes.userId, userId)))
      .run()
    return result.changes > 0
  },

  /**
   * Strip a now-deleted MCP provider id from every chat mode's
   * `mcpProviderIds` JSON array. The array is plain JSON (no FK), so a
   * deleted MCP provider would otherwise leave stale references that break
   * `chat:set-mcp-providers` with `SQLITE_CONSTRAINT_FOREIGNKEY` the next
   * time a chat is created from the affected mode. Returns the number of
   * chat-mode rows that were updated.
   */
  stripMcpProviderId(
    userId: string,
    mcpProviderId: string,
    db: DbOrTx = getDb()
  ): number {
    // SELECT + N UPDATEs need atomicity so a crash mid-loop leaves the table
    // either fully cleaned or untouched. When the caller already supplies a
    // tx, drizzle nests this as a savepoint.
    return db.transaction((tx) => {
      const rows = tx
        .select({ id: chatModes.id, ids: chatModes.mcpProviderIds })
        .from(chatModes)
        .where(eq(chatModes.userId, userId))
        .all()

      let touched = 0
      for (const row of rows) {
        const current = row.ids ?? []
        if (!current.includes(mcpProviderId)) continue
        const next = current.filter((x) => x !== mcpProviderId)
        tx.update(chatModes)
          .set({ mcpProviderIds: next })
          .where(and(eq(chatModes.id, row.id), eq(chatModes.userId, userId)))
          .run()
        touched += 1
      }
      return touched
    })
  },

  /**
   * Boot-time consistency pass: scans every chat mode and removes any
   * `mcpProviderIds` entry that doesn't point at a row in `mcp_providers`.
   * Heals modes that were corrupted before {@link stripMcpProviderId} was
   * wired into the MCP delete path. Idempotent — does nothing on clean DBs.
   * Returns the number of chat-mode rows updated.
   */
  pruneDanglingMcpProviderIds(db: DbOrTx = getDb()): number {
    return db.transaction((tx) => {
      const validIds = new Set(
        tx.select({ id: mcpProviders.id }).from(mcpProviders).all().map((r) => r.id)
      )
      const rows = tx
        .select({ id: chatModes.id, ids: chatModes.mcpProviderIds })
        .from(chatModes)
        .all()

      let touched = 0
      for (const row of rows) {
        const current = row.ids ?? []
        if (current.length === 0) continue
        const next = current.filter((x) => validIds.has(x))
        if (next.length === current.length) continue
        tx.update(chatModes)
          .set({ mcpProviderIds: next })
          .where(eq(chatModes.id, row.id))
          .run()
        touched += 1
      }
      return touched
    })
  }
}
