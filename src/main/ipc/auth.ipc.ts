import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { users, chats, llmProviders, mcpProviders, chatModes, agents } from '../db/schema'
import {
  getCurrentUserId,
  getLastUserId,
  hashPassword,
  verifyPassword
} from '../auth/session'
import { userActivation } from '../auth/activation'
import { CINNA_CLOUD_URL, startCinnaOAuthFlow, abortCinnaOAuthFlow } from '../auth/cinna-oauth'
import { storeCinnaTokens, clearCinnaTokens, hasCinnaTokens } from '../auth/cinna-tokens'

export interface UserInfo {
  id: string
  type: string
  username: string
  displayName: string
  hasPassword: boolean
  createdAt: Date
  cinnaHostingType?: 'cloud' | 'self_hosted'
  cinnaServerUrl?: string
  hasCinnaTokens?: boolean
}

type UserRow = typeof users.$inferSelect

function toUserInfo(u: UserRow): UserInfo {
  const info: UserInfo = {
    id: u.id,
    type: u.type,
    username: u.username,
    displayName: u.displayName,
    hasPassword: !!u.passwordHash,
    createdAt: u.createdAt
  }
  if (u.type === 'cinna_user') {
    info.cinnaHostingType = u.cinnaHostingType as 'cloud' | 'self_hosted' | undefined
    info.cinnaServerUrl = u.cinnaServerUrl ?? undefined
    info.hasCinnaTokens = !!(u.cinnaAccessTokenEnc && u.cinnaRefreshTokenEnc)
  }
  return info
}

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:list-users', async () => {
    const db = getDb()
    const all = db.select().from(users).all()
    return all.map(toUserInfo)
  })

  ipcMain.handle('auth:get-current', async () => {
    const db = getDb()
    const userId = getCurrentUserId()
    const user = db.select().from(users).where(eq(users.id, userId)).get()
    if (!user) return null
    return toUserInfo(user)
  })

  // Called once on app startup to determine initial auth state
  ipcMain.handle('auth:get-startup', async () => {
    const db = getDb()
    const lastUserId = getLastUserId()
    const lastUser = db.select().from(users).where(eq(users.id, lastUserId)).get()

    // User was deleted or doesn't exist — fall back to default
    if (!lastUser) {
      await userActivation.activate('__default__')
      const defaultUser = db.select().from(users).where(eq(users.id, '__default__')).get()
      return {
        needsLogin: false,
        user: defaultUser ? toUserInfo(defaultUser) : null
      }
    }

    // Default user or user without password — activate immediately
    if (!lastUser.passwordHash) {
      await userActivation.activate(lastUser.id)
      return { needsLogin: false, user: toUserInfo(lastUser) }
    }

    // Password-protected user — stay as __default__ until they authenticate
    return { needsLogin: true, pendingUser: toUserInfo(lastUser) }
  })

  ipcMain.handle(
    'auth:register',
    async (
      _event,
      data: {
        username?: string
        displayName?: string
        password?: string
        accountType: 'local' | 'cinna'
        cinnaHostingType?: 'cloud' | 'self_hosted'
        cinnaServerUrl?: string
      }
    ) => {
      const db = getDb()
      const id = nanoid()

      if (data.accountType === 'cinna') {
        const serverUrl =
          data.cinnaHostingType === 'cloud'
            ? CINNA_CLOUD_URL
            : data.cinnaServerUrl

        if (!serverUrl) {
          return { success: false, error: 'Server URL is required for self-hosted accounts' }
        }

        // Run OAuth first — get tokens + user profile from the server
        let tokens: Awaited<ReturnType<typeof startCinnaOAuthFlow>>
        try {
          tokens = await startCinnaOAuthFlow(serverUrl)
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'OAuth authentication failed'
          }
        }

        // Use OAuth email as username, check uniqueness
        const username = tokens.profile.email
        const existing = db
          .select()
          .from(users)
          .where(eq(users.username, username))
          .get()
        if (existing) {
          return { success: false, error: `Account already exists for ${username}` }
        }

        // Create user row with profile from OAuth
        db.insert(users)
          .values({
            id,
            type: 'cinna_user',
            username,
            displayName: tokens.profile.displayName,
            cinnaServerUrl: serverUrl,
            cinnaHostingType: data.cinnaHostingType ?? 'cloud',
            createdAt: new Date()
          })
          .run()

        storeCinnaTokens(id, tokens)
        await userActivation.activate(id)
        const created = db.select().from(users).where(eq(users.id, id)).get()
        return { success: true, user: created ? toUserInfo(created) : null }
      }

      // Local account — username required
      if (!data.username?.trim()) {
        return { success: false, error: 'Username is required' }
      }

      const existing = db
        .select()
        .from(users)
        .where(eq(users.username, data.username.trim()))
        .get()
      if (existing) {
        return { success: false, error: 'Username already taken' }
      }

      const passwordFields =
        data.password
          ? hashPassword(data.password)
          : { hash: undefined, salt: undefined }

      db.insert(users)
        .values({
          id,
          type: 'local_user',
          username: data.username.trim(),
          displayName: data.displayName?.trim() || data.username.trim(),
          passwordHash: passwordFields.hash,
          salt: passwordFields.salt,
          createdAt: new Date()
        })
        .run()

      await userActivation.activate(id)

      const created = db.select().from(users).where(eq(users.id, id)).get()
      return { success: true, user: created ? toUserInfo(created) : null }
    }
  )

  ipcMain.handle(
    'auth:login',
    async (_event, data: { userId: string; password?: string; skipPassword?: boolean }) => {
      const db = getDb()
      const user = db.select().from(users).where(eq(users.id, data.userId)).get()
      if (!user) {
        return { success: false, error: 'User not found' }
      }

      // Verify password unless already authenticated this session (skipPassword)
      if (user.passwordHash && user.salt && !data.skipPassword) {
        if (!data.password) {
          return { success: false, error: 'Password required' }
        }
        if (!verifyPassword(data.password, user.passwordHash, user.salt)) {
          return { success: false, error: 'Invalid password' }
        }
      }

      await userActivation.activate(user.id)

      return { success: true, user: toUserInfo(user) }
    }
  )

  ipcMain.handle('auth:logout', async () => {
    await userActivation.activate('__default__')
    return { success: true }
  })

  ipcMain.handle('auth:cinna-oauth-abort', async () => {
    abortCinnaOAuthFlow()
    return { success: true }
  })

  ipcMain.handle(
    'auth:update-user',
    async (
      _event,
      data: {
        userId: string
        displayName?: string
        password?: string
        removePassword?: boolean
      }
    ) => {
      const db = getDb()
      const user = db.select().from(users).where(eq(users.id, data.userId)).get()
      if (!user) {
        return { success: false, error: 'User not found' }
      }
      if (data.userId === '__default__') {
        return { success: false, error: 'Cannot modify default user' }
      }

      const updates: Record<string, unknown> = {}

      if (data.displayName !== undefined && data.displayName.trim()) {
        updates.displayName = data.displayName.trim()
      }

      if (data.removePassword) {
        updates.passwordHash = null
        updates.salt = null
      } else if (data.password) {
        const { hash, salt } = hashPassword(data.password)
        updates.passwordHash = hash
        updates.salt = salt
      }

      if (Object.keys(updates).length === 0) {
        return { success: true, user: toUserInfo(user) }
      }

      db.update(users).set(updates).where(eq(users.id, data.userId)).run()

      const updated = db.select().from(users).where(eq(users.id, data.userId)).get()
      return { success: true, user: updated ? toUserInfo(updated) : null }
    }
  )

  ipcMain.handle(
    'auth:delete-user',
    async (_event, data: { userId: string; password?: string }) => {
      // Support both old (string) and new (object) call signatures
      const userId = typeof data === 'string' ? data : data.userId
      const password = typeof data === 'string' ? undefined : data.password

      if (userId === '__default__') {
        return { success: false, error: 'Cannot delete default user' }
      }

      const db = getDb()
      const user = db.select().from(users).where(eq(users.id, userId)).get()
      if (!user) {
        return { success: false, error: 'User not found' }
      }

      // If user has a password, verify it before deletion
      if (user.passwordHash && user.salt) {
        if (!password) {
          return { success: false, error: 'Password required to delete this account' }
        }
        if (!verifyPassword(password, user.passwordHash, user.salt)) {
          return { success: false, error: 'Invalid password' }
        }
      }

      const wasCurrent = getCurrentUserId() === userId

      // If deleting current user, deactivate session first
      if (wasCurrent) {
        await userActivation.deactivate()
      }

      // Clear encrypted Cinna tokens before deleting
      clearCinnaTokens(userId)

      // Delete all user data from all tables, then the user
      db.delete(chats).where(eq(chats.userId, userId)).run()
      db.delete(llmProviders).where(eq(llmProviders.userId, userId)).run()
      db.delete(mcpProviders).where(eq(mcpProviders.userId, userId)).run()
      db.delete(chatModes).where(eq(chatModes.userId, userId)).run()
      db.delete(agents).where(eq(agents.userId, userId)).run()
      db.delete(users).where(eq(users.id, userId)).run()

      // If we deleted the active user, fall back to default
      if (wasCurrent) {
        await userActivation.activate('__default__')
      }

      return { success: true }
    }
  )
}
