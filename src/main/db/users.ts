import { eq } from 'drizzle-orm'
import { getDb } from './client'
import {
  users,
  chats,
  llmProviders,
  mcpProviders,
  chatModes,
  agents
} from './schema'

export type UserRow = typeof users.$inferSelect

export interface InsertUserInput {
  id: string
  type: 'local_user' | 'cinna_user'
  username: string
  displayName: string
  passwordHash?: string | null
  salt?: string | null
  cinnaServerUrl?: string | null
  cinnaHostingType?: 'cloud' | 'self_hosted' | null
}

export interface SetCinnaTokensInput {
  clientId: string
  accessTokenEnc: Buffer
  refreshTokenEnc: Buffer
  expiresAt: number
}

export interface CinnaTokenState {
  clientId: string | null
  accessTokenEnc: Buffer | null
  refreshTokenEnc: Buffer | null
  expiresAt: number | null
  serverUrl: string | null
}

export const userRepo = {
  list(): UserRow[] {
    return getDb().select().from(users).all()
  },

  get(id: string): UserRow | undefined {
    return getDb().select().from(users).where(eq(users.id, id)).get()
  },

  getByUsername(username: string): UserRow | undefined {
    return getDb().select().from(users).where(eq(users.username, username)).get()
  },

  /** Insert a new user row and return it. */
  insert(input: InsertUserInput): UserRow {
    const db = getDb()
    db.insert(users)
      .values({
        id: input.id,
        type: input.type,
        username: input.username,
        displayName: input.displayName,
        passwordHash: input.passwordHash ?? null,
        salt: input.salt ?? null,
        cinnaServerUrl: input.cinnaServerUrl ?? null,
        cinnaHostingType: input.cinnaHostingType ?? null,
        createdAt: new Date()
      })
      .run()
    const row = db.select().from(users).where(eq(users.id, input.id)).get()
    if (!row) throw new Error('Failed to load user after insert')
    return row
  },

  updateProfile(id: string, patch: { displayName?: string }): void {
    if (!patch.displayName) return
    getDb()
      .update(users)
      .set({ displayName: patch.displayName })
      .where(eq(users.id, id))
      .run()
  },

  setPassword(id: string, creds: { hash: string; salt: string }): void {
    getDb()
      .update(users)
      .set({ passwordHash: creds.hash, salt: creds.salt })
      .where(eq(users.id, id))
      .run()
  },

  clearPassword(id: string): void {
    getDb()
      .update(users)
      .set({ passwordHash: null, salt: null })
      .where(eq(users.id, id))
      .run()
  },

  setCinnaTokens(id: string, tokens: SetCinnaTokensInput): void {
    getDb()
      .update(users)
      .set({
        cinnaClientId: tokens.clientId,
        cinnaAccessTokenEnc: tokens.accessTokenEnc,
        cinnaRefreshTokenEnc: tokens.refreshTokenEnc,
        cinnaTokenExpiresAt: tokens.expiresAt
      })
      .where(eq(users.id, id))
      .run()
  },

  clearCinnaTokens(id: string): void {
    getDb()
      .update(users)
      .set({
        cinnaClientId: null,
        cinnaAccessTokenEnc: null,
        cinnaRefreshTokenEnc: null,
        cinnaTokenExpiresAt: null
      })
      .where(eq(users.id, id))
      .run()
  },

  getCinnaTokenState(id: string): CinnaTokenState | undefined {
    const row = getDb().select().from(users).where(eq(users.id, id)).get()
    if (!row) return undefined
    return {
      clientId: row.cinnaClientId,
      accessTokenEnc: row.cinnaAccessTokenEnc,
      refreshTokenEnc: row.cinnaRefreshTokenEnc,
      expiresAt: row.cinnaTokenExpiresAt,
      serverUrl: row.cinnaServerUrl
    }
  },

  /**
   * Delete the user and cascade-delete all rows scoped to them. The scoped
   * tables are deleted explicitly; a2a_sessions and messages cascade via the
   * chats FK. Wraps everything in a single transaction so a mid-delete failure
   * rolls back cleanly.
   */
  deleteWithCascade(id: string): void {
    const db = getDb()
    db.transaction((tx) => {
      tx.delete(chats).where(eq(chats.userId, id)).run()
      tx.delete(llmProviders).where(eq(llmProviders.userId, id)).run()
      tx.delete(mcpProviders).where(eq(mcpProviders.userId, id)).run()
      tx.delete(chatModes).where(eq(chatModes.userId, id)).run()
      tx.delete(agents).where(eq(agents.userId, id)).run()
      tx.delete(users).where(eq(users.id, id)).run()
    })
  },

  /** Set the display name of the default guest row (best-effort). */
  rotateGuestAlias(alias: string): void {
    getDb()
      .update(users)
      .set({ displayName: alias })
      .where(eq(users.id, '__default__'))
      .run()
  }
}
