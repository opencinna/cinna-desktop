import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { syncService } from '../services/syncService'
import { ipcHandle } from './_wrap'
import type { SyncUnlockRequest } from '../../shared/sync'

/**
 * `window.api.sync.*` handlers. The active profile id is resolved in the main
 * process on every call — the renderer never passes (or sees) a user id, key,
 * or plaintext. Sync runs only for Cinna-linked profiles (enforced in the
 * service); calls on a non-Cinna profile resolve to inert/no-op state.
 */
export function registerSyncHandlers(): void {
  ipcHandle('sync:get-state', async () => {
    userActivation.requireActivated()
    return syncService.getState(getProfileScopeUserId())
  })

  ipcHandle('sync:init', async () => {
    userActivation.requireActivated()
    return syncService.initEncryption(getProfileScopeUserId())
  })

  ipcHandle('sync:unlock', async (_e, req: SyncUnlockRequest) => {
    userActivation.requireActivated()
    await syncService.unlock(getProfileScopeUserId(), req)
    return { success: true }
  })

  ipcHandle('sync:lock', async () => {
    userActivation.requireActivated()
    await syncService.lock(getProfileScopeUserId())
    return { success: true }
  })

  ipcHandle('sync:sync-now', async () => {
    userActivation.requireActivated()
    await syncService.syncNow(getProfileScopeUserId())
    return { success: true }
  })

  ipcHandle('sync:add-passphrase', async (_e, passphrase: string) => {
    userActivation.requireActivated()
    await syncService.addPassphrase(getProfileScopeUserId(), passphrase)
    return { success: true }
  })

  ipcHandle('sync:pairing-start', async () => {
    userActivation.requireActivated()
    return syncService.startPairing(getProfileScopeUserId())
  })

  ipcHandle('sync:pairing-poll', async (_e, code: string) => {
    userActivation.requireActivated()
    return syncService.pollPairing(getProfileScopeUserId(), code)
  })

  ipcHandle('sync:pairing-inbox', async () => {
    userActivation.requireActivated()
    return syncService.pairingInbox(getProfileScopeUserId())
  })

  ipcHandle('sync:pairing-begin-verify', async (_e, id: string) => {
    userActivation.requireActivated()
    await syncService.beginVerify(getProfileScopeUserId(), id)
    return { success: true }
  })

  ipcHandle('sync:pairing-confirm-verify', async (_e, id: string, sas: string) => {
    userActivation.requireActivated()
    await syncService.confirmVerify(getProfileScopeUserId(), id, sas)
    return { success: true }
  })

  ipcHandle('sync:pairing-cancel-verify', async (_e, id: string) => {
    userActivation.requireActivated()
    syncService.cancelVerify(getProfileScopeUserId(), id)
    return { success: true }
  })

  ipcHandle('sync:device-revoke', async (_e, deviceId: string) => {
    userActivation.requireActivated()
    await syncService.revokeDevice(getProfileScopeUserId(), deviceId)
    return { success: true }
  })

  ipcHandle('sync:disconnect', async () => {
    userActivation.requireActivated()
    return syncService.disconnect(getProfileScopeUserId())
  })

  ipcHandle('sync:reconnect', async () => {
    userActivation.requireActivated()
    await syncService.reconnect(getProfileScopeUserId())
    return { success: true }
  })
}
