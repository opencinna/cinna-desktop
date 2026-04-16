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

export interface UserInfo {
  id: string
  type: string
  username: string
  displayName: string
  hasPassword: boolean
  createdAt: Date
}

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:list-users', async () => {
    const db = getDb()
    const all = db.select().from(users).all()
    return all.map(
      (u): UserInfo => ({
        id: u.id,
        type: u.type,
        username: u.username,
        displayName: u.displayName,
        hasPassword: !!u.passwordHash,
        createdAt: u.createdAt
      })
    )
  })

  ipcMain.handle('auth:get-current', async () => {
    const db = getDb()
    const userId = getCurrentUserId()
    const user = db.select().from(users).where(eq(users.id, userId)).get()
    if (!user) return null
    return {
      id: user.id,
      type: user.type,
      username: user.username,
      displayName: user.displayName,
      hasPassword: !!user.passwordHash,
      createdAt: user.createdAt
    } as UserInfo
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
        user: defaultUser
          ? {
              id: defaultUser.id,
              type: defaultUser.type,
              username: defaultUser.username,
              displayName: defaultUser.displayName,
              hasPassword: false,
              createdAt: defaultUser.createdAt
            }
          : null
      }
    }

    // Default user or user without password — activate immediately
    if (!lastUser.passwordHash) {
      await userActivation.activate(lastUser.id)
      return {
        needsLogin: false,
        user: {
          id: lastUser.id,
          type: lastUser.type,
          username: lastUser.username,
          displayName: lastUser.displayName,
          hasPassword: false,
          createdAt: lastUser.createdAt
        } as UserInfo
      }
    }

    // Password-protected user — stay as __default__ until they authenticate
    return {
      needsLogin: true,
      pendingUser: {
        id: lastUser.id,
        type: lastUser.type,
        username: lastUser.username,
        displayName: lastUser.displayName,
        hasPassword: true,
        createdAt: lastUser.createdAt
      } as UserInfo
    }
  })

  ipcMain.handle(
    'auth:register',
    async (
      _event,
      data: { username: string; displayName: string; password: string }
    ) => {
      const db = getDb()

      // Check uniqueness
      const existing = db
        .select()
        .from(users)
        .where(eq(users.username, data.username))
        .get()
      if (existing) {
        return { success: false, error: 'Username already taken' }
      }

      const { hash, salt } = hashPassword(data.password)
      const id = nanoid()

      db.insert(users)
        .values({
          id,
          username: data.username,
          displayName: data.displayName,
          passwordHash: hash,
          salt,
          createdAt: new Date()
        })
        .run()

      // Auto-switch to new user
      await userActivation.activate(id)

      return {
        success: true,
        user: {
          id,
          type: 'local_user',
          username: data.username,
          displayName: data.displayName,
          hasPassword: true,
          createdAt: new Date()
        } as UserInfo
      }
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

      return {
        success: true,
        user: {
          id: user.id,
          type: user.type,
          username: user.username,
          displayName: user.displayName,
          hasPassword: !!user.passwordHash,
          createdAt: user.createdAt
        } as UserInfo
      }
    }
  )

  ipcMain.handle('auth:logout', async () => {
    await userActivation.activate('__default__')
    return { success: true }
  })

  ipcMain.handle('auth:delete-user', async (_event, userId: string) => {
    if (userId === '__default__') {
      return { success: false, error: 'Cannot delete default user' }
    }

    const db = getDb()

    // If deleting current user, deactivate session first
    if (getCurrentUserId() === userId) {
      await userActivation.deactivate()
    }

    // Delete all user data from all tables, then the user
    db.delete(chats).where(eq(chats.userId, userId)).run()
    db.delete(llmProviders).where(eq(llmProviders.userId, userId)).run()
    db.delete(mcpProviders).where(eq(mcpProviders.userId, userId)).run()
    db.delete(chatModes).where(eq(chatModes.userId, userId)).run()
    db.delete(agents).where(eq(agents.userId, userId)).run()
    db.delete(users).where(eq(users.id, userId)).run()

    return { success: true }
  })
}
