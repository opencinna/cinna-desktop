import { connectIntentService } from '../services/connectIntentService'
import type { ConnectIntent } from '../../shared/connectIntent'
import { ipcHandle } from './_wrap'

/**
 * The buffered `cinna://connect` deep link.
 *
 * Deliberately not behind `userActivation.requireActivated()`. The whole point
 * of the intent is the *first* run, before any account exists — a gate here
 * would make the one case the feature is for the one case it cannot serve.
 * Nothing is disclosed either way: the renderer is asking for a host the user's
 * own click just supplied.
 */
export function registerConnectHandlers(): void {
  ipcHandle('connect:get-pending', async (): Promise<ConnectIntent | null> =>
    connectIntentService.getPending()
  )

  ipcHandle('connect:consume', async (): Promise<{ success: true }> => {
    connectIntentService.consume()
    return { success: true }
  })
}
