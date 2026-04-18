import { setCurrentUser, getCurrentUserId } from './session'
import { reloadUserProviders } from './reload'
import { clearAllAdapters } from '../llm/registry'
import { mcpManager } from '../mcp/manager'
import { syncRemoteAgents, startPeriodicSync, stopPeriodicSync } from '../agents/remote-sync'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { users } from '../db/schema'
import { getMainWindow } from '../index'

/**
 * Centralizes user session activation — LLM adapters and MCP connectors
 * only start when a user is explicitly authenticated through the auth flow.
 */
class UserActivation {
  private _activated = false

  isActivated(): boolean {
    return this._activated
  }

  /** Activate a user session: set current user, load their providers, open the gate. */
  async activate(userId: string): Promise<void> {
    setCurrentUser(userId)
    await reloadUserProviders()
    this._activated = true

    // Sync remote agents for Cinna users (non-blocking)
    this._startRemoteSync(userId)
  }

  /** Trigger remote agent sync for Cinna users */
  private _startRemoteSync(userId: string): void {
    const db = getDb()
    const user = db.select().from(users).where(eq(users.id, userId)).get()
    if (user?.type === 'cinna_user' && user.cinnaServerUrl) {
      syncRemoteAgents(userId)
        .then(() => {
          const win = getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('agents:remote-sync-complete')
          }
        })
        .catch((err) => {
          console.warn('[activation] Initial remote agent sync failed:', String(err))
        })
      startPeriodicSync(userId)
    }
  }

  /** Tear down the active session without loading any providers. */
  async deactivate(): Promise<void> {
    this._activated = false
    stopPeriodicSync()
    clearAllAdapters()
    await mcpManager.disconnectAll()
    setCurrentUser('__default__')
  }

  /** Guard for IPC handlers — throws if no user is activated. */
  requireActivated(): void {
    if (!this._activated) {
      throw new Error('Session not activated — user must authenticate first')
    }
  }
}

export const userActivation = new UserActivation()
