import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { localDevService } from '../localdev/localDevService'
import type { LocalDevState } from '../../shared/localDevState'
import { ipcHandle } from './_wrap'

/**
 * Local development: one read, and six verbs that all end in a state.
 *
 * Every verb resolves the **active** profile itself rather than taking a
 * `userId` from the renderer. The reconciler mints account setup tokens with
 * that profile's OAuth bearer and writes into that profile's agents home, so a
 * renderer-supplied id would be a confused deputy — the same rule
 * `authService.reauthCinna` follows.
 *
 * Nothing here throws for an ordinary failure. A refused install, a rejected
 * token and a missing role all come back as {@link LocalDevState}, because a
 * thrown `DomainError`'s code does not survive the IPC boundary and every one
 * of these is something the UI renders rather than something it catches.
 */
export function registerLocalDevHandlers(): void {
  /**
   * The one channel here not behind `requireActivated()`, deliberately.
   *
   * It is read from a mount effect that runs during onboarding — before any
   * account exists — and what it returns then is `{ phase: 'idle' }`, a
   * process-global constant. Gating it would trade nothing for a first-run
   * screen that has to handle a rejection to learn there is nothing to show.
   * Every channel that *acts* is gated.
   */
  ipcHandle('localdev:get-state', async (): Promise<LocalDevState> => localDevService.getState())

  ipcHandle('localdev:consent', async (_event, host: string, accepted: boolean) => {
    userActivation.requireActivated()
    return localDevService.setConsent(getProfileScopeUserId(), String(host), accepted === true)
  })

  ipcHandle('localdev:reset-consent', async (_event, host: string) => {
    userActivation.requireActivated()
    return localDevService.resetConsent(getProfileScopeUserId(), String(host))
  })

  // Repair is `reconcile(force)`: the same single entry point, told to redo the
  // installs and to override a remembered decline. There is deliberately no
  // separate repair path that could drift from the normal one.
  ipcHandle('localdev:repair', async (): Promise<LocalDevState> => {
    userActivation.requireActivated()
    return localDevService.reconcile(getProfileScopeUserId(), true)
  })

  ipcHandle('localdev:get-consent', async (): Promise<Record<string, boolean>> => {
    userActivation.requireActivated()
    return localDevService.consent()
  })

  ipcHandle('localdev:open-workspace', async () => {
    userActivation.requireActivated()
    return localDevService.openWorkspace()
  })

  ipcHandle('localdev:add-to-path', async () => {
    userActivation.requireActivated()
    return localDevService.addToPath()
  })
}
