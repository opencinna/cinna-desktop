import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import { agentRoots } from './schema'

export type AgentRootRow = typeof agentRoots.$inferSelect

export interface CreateAgentRootInput {
  /** Absolute path of the workshop root. Validated by the service, not here. */
  path: string
  label: string
  isDefault?: boolean
}

/**
 * Registered agents roots. Pure data access, `userId`-scoped on every read and
 * write — the folder-agent surface is machine-local, so in practice that userId
 * is always `getSettingsScopeUserId()`, but the filter is built in the same way
 * `messageRepo`'s is, so a future per-profile root needs no repo change.
 *
 * No business logic here: path validation, template installation and the
 * "there is always exactly one default" rule live in `agentsHomeService`.
 */
export const agentRootRepo = {
  list(userId: string): AgentRootRow[] {
    return getDb().select().from(agentRoots).where(eq(agentRoots.userId, userId)).all()
  },

  getOwned(userId: string, rootId: string): AgentRootRow | undefined {
    return getDb()
      .select()
      .from(agentRoots)
      .where(and(eq(agentRoots.id, rootId), eq(agentRoots.userId, userId)))
      .get()
  },

  /** The root registered at `path`, if any. Paths are unique per user. */
  getByPath(userId: string, path: string): AgentRootRow | undefined {
    return getDb()
      .select()
      .from(agentRoots)
      .where(and(eq(agentRoots.path, path), eq(agentRoots.userId, userId)))
      .get()
  },

  /** The agents home. Undefined until the service has resolved one. */
  getDefault(userId: string): AgentRootRow | undefined {
    return getDb()
      .select()
      .from(agentRoots)
      .where(and(eq(agentRoots.userId, userId), eq(agentRoots.isDefault, true)))
      .get()
  },

  create(userId: string, input: CreateAgentRootInput): AgentRootRow {
    const db = getDb()
    const id = nanoid()
    db.insert(agentRoots)
      .values({
        id,
        userId,
        path: input.path,
        label: input.label,
        isDefault: input.isDefault ?? false,
        createdAt: new Date()
      })
      .run()
    const row = this.getOwned(userId, id)
    if (!row) throw new Error('Failed to load agent root after insert')
    return row
  },

  /** Repoint the default root at a new path (the home setting changed). */
  updatePath(userId: string, rootId: string, path: string, label: string): AgentRootRow | undefined {
    getDb()
      .update(agentRoots)
      .set({ path, label })
      .where(and(eq(agentRoots.id, rootId), eq(agentRoots.userId, userId)))
      .run()
    return this.getOwned(userId, rootId)
  },

  delete(userId: string, rootId: string): boolean {
    const result = getDb()
      .delete(agentRoots)
      .where(and(eq(agentRoots.id, rootId), eq(agentRoots.userId, userId)))
      .run()
    return result.changes > 0
  }
}
