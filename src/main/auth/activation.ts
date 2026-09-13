import { setCurrentUser } from './session'
import { reloadUserProviders } from './reload'
import { clearAllAdapters } from '../llm/registry'
import { mcpManager } from '../mcp/manager'
import { runSyncOnce, startPeriodicSync, stopPeriodicSync } from '../agents/remote-sync'
import {
  runAccountConfigSyncOnce,
  startAccountConfigPeriodicSync,
  stopAccountConfigPeriodicSync
} from '../services/account-config-sync'
import { syncService } from '../services/syncService'
import { taskSyncScheduler } from '../services/taskSyncScheduler'
import { localScheduleScheduler } from '../services/localScheduleScheduler'
import { getSettingsScopeUserId } from './scope'
import { localDevService } from '../localdev/localDevService'
import { userRepo } from '../db/users'
import { DEFAULT_USER_ID } from '../../shared/userIds'

/**
 * Centralizes user session activation — LLM adapters and MCP connectors
 * only start when a user is explicitly authenticated through the auth flow.
 */
class UserActivation {
  private _activated = false
  private _epoch = 0
  private _operations: Promise<void> = Promise.resolve()
  private _unlockedUserIds = new Set<string>()
  /** In-flight `activate()` run, used to dedupe concurrent calls for one user. */
  private _pendingActivation?: { userId: string; promise: Promise<void> }

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

  /**
   * Activate a user session: set current user, load their providers, open the
   * gate.
   *
   * Concurrent activations of the same user collapse onto one run. `AuthGate`
   * calls `auth:get-startup` from a mount effect, which React StrictMode
   * double-invokes in dev — two overlapping activations each ran
   * `reloadUserProviders()`, and the second one's `disconnectAll()` killed the
   * first one's still-in-flight MCP connects (logged as `Connect failed …
   * Connection closed`, followed by a successful reconnect).
   */
  async activate(userId: string): Promise<void> {
    const pending = this._pendingActivation
    if (pending && pending.userId === userId) return pending.promise

    const promise = this._activate(userId)
    this._pendingActivation = { userId, promise }
    try {
      await promise
    } finally {
      if (this._pendingActivation?.promise === promise) {
        this._pendingActivation = undefined
      }
    }
  }

  private async _activate(userId: string): Promise<void> {
    const epoch = ++this._epoch
    this._activated = false
    // Login, profile switching and logout all enter through activate(), without
    // necessarily calling deactivate(). Retire the former profile before any
    // awaited reload, including when the destination has no Cinna account.
    localDevService.clear()
    taskSyncScheduler.stop()
    localScheduleScheduler.stop()
    const current = () => epoch === this._epoch
    // Provider teardown/reload must not overlap: a late disconnect for A
    // could otherwise remove B's newly registered connections.
    const operation = this._operations.catch(() => {}).then(async () => {
      if (!current()) return
      setCurrentUser(userId)
      await reloadUserProviders(current)
      if (!current()) return
      this._activated = true
      taskSyncScheduler.start(userId)
      localScheduleScheduler.start({ profileUserId: userId, settingsUserId: getSettingsScopeUserId() })
      this._startRemoteSync(userId)
    })
    this._operations = operation
    await operation
  }

  /** Trigger remote agent + account-config sync for Cinna users */
  private _startRemoteSync(userId: string): void {
    const user = userRepo.get(userId)
    if (user?.type === 'cinna_user' && user.cinnaServerUrl) {
      void runSyncOnce(userId)
      startPeriodicSync(userId)
      // Materialize account-provisioned LLM providers + default chat modes
      // ("ready on login"). Already-synced managed adapters were loaded by
      // reloadUserProviders; this refreshes them against the server.
      void runAccountConfigSyncOnce(userId)
      startAccountConfigPeriodicSync(userId)
      // Activate cloud data-sync (silent device-key unlock + periodic push/pull).
      void syncService.ensureActivated(userId)
      // Bring local development to its target state: the managed toolchain and
      // the cinna-cli account workspace. Idempotent and cheap when it is
      // already there, so it belongs on every activation rather than only on
      // the first — a pinned version the server bumped, a token that expired
      // overnight and a workspace the user deleted are all discovered here.
      void localDevService.reconcile(userId)
    }
  }

  /** Tear down the active session without loading any providers. */
  async deactivate(): Promise<void> {
    const epoch = ++this._epoch
    this._pendingActivation = undefined
    this._activated = false
    taskSyncScheduler.stop()
    localScheduleScheduler.stop()
    // The local-dev state names a host and a folder belonging to the profile
    // that is going away; leaving it up would show the next profile someone
    // else's workspace path.
    localDevService.clear()
    stopPeriodicSync()
    stopAccountConfigPeriodicSync()
    // Zero all UMKs + clear sync timers on profile switch / sign-out.
    void syncService.onProfileSwitch()
    clearAllAdapters()
    const operation = this._operations.catch(() => {}).then(async () => {
      await mcpManager.disconnectAll()
      if (epoch === this._epoch) setCurrentUser(DEFAULT_USER_ID)
    })
    this._operations = operation
    await operation
  }

  /** Guard for IPC handlers — throws if no user is activated. */
  requireActivated(): void {
    if (!this._activated) {
      throw new Error('Session not activated — user must authenticate first')
    }
  }
}

export const userActivation = new UserActivation()
