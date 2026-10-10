import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { catalogService } from '../services/catalogService'
import { libraryService } from '../services/libraryService'
import { ipcHandle } from './_wrap'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { DomainError } from '../errors'
import { createLogger } from '../logger/logger'
import { REAUTH_REQUIRED_CODE } from '../../shared/cinnaErrors'
import type { CatalogOutcome } from '../../shared/catalog'

const logger = createLogger('catalog-ipc')

/**
 * Run a catalog call whose failure code the renderer acts on, returning the
 * code as data (see {@link CatalogOutcome}). A coded failure — including an
 * expired Cinna session, raw or already normalised — is returned; anything
 * else still throws, so `_wrap` logs it as the unexpected error it is.
 */
async function outcome<T>(channel: string, run: () => Promise<T>): Promise<CatalogOutcome<T>> {
  try {
    return { success: true, value: await run() }
  } catch (err) {
    if (err instanceof CinnaReauthRequired) {
      logger.warn(`${channel} needs re-authentication`)
      return { success: false, code: REAUTH_REQUIRED_CODE, message: err.message }
    }
    if (err instanceof DomainError) {
      logger.warn(`${channel} failed`, { code: err.code, message: err.message })
      return { success: false, code: err.code, message: err.message }
    }
    throw err
  }
}

export function registerCatalogHandlers(): void {
  /**
   * The one-catalog dialog's list: every item of every kind, from the same
   * cached listing team sharing reads. `refresh` lists again first.
   */
  ipcHandle('catalog:items', async (_event, input?: { refresh?: unknown }) => {
    userActivation.requireActivated()
    return outcome('catalog:items', () =>
      libraryService.items(getProfileScopeUserId(), input?.refresh === true)
    )
  })

  /** One item with its versions, for the dialog's detail. */
  ipcHandle('catalog:item', async (_event, input?: { uuid?: unknown }) => {
    userActivation.requireActivated()
    const uuid = typeof input?.uuid === 'string' ? input.uuid : ''
    return outcome('catalog:item', () => libraryService.itemDetail(getProfileScopeUserId(), uuid))
  })

  ipcHandle('catalog:quick-install', async (_event, bundleId: string) => {
    userActivation.requireActivated()
    return outcome('catalog:quick-install', () =>
      catalogService.quickInstall(getProfileScopeUserId(), bundleId)
    )
  })

  ipcHandle('catalog:install-context', async (_event, bundleId: string) => {
    userActivation.requireActivated()
    return catalogService.getInstallContext(getProfileScopeUserId(), bundleId)
  })

  ipcHandle('catalog:uninstall', async (_event, installId: string) => {
    userActivation.requireActivated()
    await catalogService.uninstall(getProfileScopeUserId(), installId)
    return { success: true }
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
