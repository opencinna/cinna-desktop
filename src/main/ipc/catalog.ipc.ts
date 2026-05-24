import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { catalogService } from '../services/catalogService'
import { ipcHandle } from './_wrap'

export function registerCatalogHandlers(): void {
  ipcHandle('catalog:list', async () => {
    userActivation.requireActivated()
    return catalogService.list(getProfileScopeUserId())
  })

  ipcHandle('catalog:quick-install', async (_event, bundleId: string) => {
    userActivation.requireActivated()
    return catalogService.quickInstall(getProfileScopeUserId(), bundleId)
  })

  ipcHandle('catalog:setup-status', async (_event, installId: string) => {
    userActivation.requireActivated()
    return catalogService.getSetupStatus(getProfileScopeUserId(), installId)
  })

  ipcHandle('catalog:setup-credentials', async (_event, installId: string) => {
    userActivation.requireActivated()
    return catalogService.getSetupCredentials(getProfileScopeUserId(), installId)
  })

  ipcHandle('catalog:server-url', async () => {
    userActivation.requireActivated()
    return catalogService.getServerUrl(getProfileScopeUserId())
  })
}
