import { setCurrentUser } from './session'
import { reloadUserProviders } from './reload'
import { clearAllAdapters } from '../llm/registry'
import { mcpManager } from '../mcp/manager'
import { runSyncOnce, startPeriodicSync, stopPeriodicSync } from '../agents/remote-sync'
import { userRepo } from '../db/users'

/**
 * Centralizes user session activation — LLM adapters and MCP connectors
 * only start when a user is explicitly authenticated through the auth flow.
 */
class UserActivation {
  private _activated = false
  private _unlockedUserIds = new Set<string>()

  isActivated(): boolean {
    return this._activated
  }

  /** Mark a user as unlocked for the remainder of this app session. */
  markUnlocked(userId: string): void {
    this._unlockedUserIds.add(userId)
  }

  /** Whether the user has already supplied their password in this app session. */
  isUnlocked(userId: string): boolean {
    return this._unlockedUserIds.has(userId)
  }

  /** Drop all unlock memory (e.g. on sign-out). */
  clearUnlocks(): void {
    this._unlockedUserIds.clear()
  }

  /** Remove a single user from the unlock set (e.g. on account deletion). */
  forgetUnlock(userId: string): void {
    this._unlockedUserIds.delete(userId)
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
    const user = userRepo.get(userId)
    if (user?.type === 'cinna_user' && user.cinnaServerUrl) {
      void runSyncOnce(userId)
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
