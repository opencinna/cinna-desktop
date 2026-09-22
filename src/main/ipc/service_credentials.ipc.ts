import { credentialHelper } from '../services/serviceCredentials/helper'
import type { ManifestStamp } from '../kit/manifestIo'
import { userActivation } from '../auth/activation'
import { ipcHandle } from './_wrap'
import { serviceCredentialService as service } from '../services/serviceCredentials/service'
import type { ServiceCredentialInput, ServiceCredentialResult } from '../../shared/serviceCredentials'
async function outcome<T>(fn: () => T | Promise<T>): Promise<ServiceCredentialResult<T>> {
  try { userActivation.requireActivated(); return { ok: true, value: await fn() } }
  catch (error) {
    const code = (error as { code?: string }).code ?? 'credential_error'
    // Service errors contain deliberate fixed copy; transport errors never include payloads.
    return { ok: false, code, message: error instanceof Error ? error.message : 'Credential operation failed.' }
  }
}
export function registerServiceCredentialHandlers(): void {
  ipcHandle('service-credentials:helper', (_, id: string) => outcome(() => credentialHelper.status(id)))
  ipcHandle('service-credentials:update-helper', (_, id: string, stamp: ManifestStamp) => outcome(() => credentialHelper.update(id, stamp)))
  ipcHandle('service-credentials:list', (_, userId: string, serverUrl: string | null) => outcome(() => service.snapshot(userId, serverUrl)))
  ipcHandle('service-credentials:save', (_, input: ServiceCredentialInput) => outcome(() => service.save(input)))
  ipcHandle('service-credentials:remove', (_, id: string) => outcome(() => service.remove(id)))
  ipcHandle('service-credentials:sync', (_, userId: string, serverUrl: string) => outcome(() => {
    if (!userId || !serverUrl) throw new Error('Open this profile’s credentials again before syncing.')
    return service.sync(userId, serverUrl)
  }))
  ipcHandle('service-credentials:attachments', (_, id: string) => outcome(() => service.attachments(id)))
  ipcHandle('service-credentials:attach-options', (_, id: string) => outcome(() => service.attachOptions(id)))
  ipcHandle('service-credentials:set-attachments', (_, id: string, group: string, refs: string[]) => outcome(() => service.setAttachments(id, group, refs)))
}
