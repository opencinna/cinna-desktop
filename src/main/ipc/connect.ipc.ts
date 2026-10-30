import { connectIntentService, MAX_URL_LENGTH } from '../host/desktop/connectIntentService'
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

  ipcHandle('connect:consume', async (_e, receivedAt?: unknown): Promise<{ success: true }> => {
    connectIntentService.consume(typeof receivedAt === 'number' ? receivedAt : undefined)
    return { success: true }
  })

  // The install handoff: the first-run onboarding asks once whether the
  // download page left a connect link on the clipboard. Not gated for the same
  // reason as the two above — first run is the only time it is asked — and the
  // service, not this handler, enforces once-per-process and never reveals
  // anything on the clipboard but an accepted origin.
  ipcHandle('connect:check-clipboard', async (): Promise<ConnectIntent | null> =>
    connectIntentService.checkClipboardOnce()
  )

  // A connect link pasted into the onboarding Server URL field. Ungated because
  // that field is on the first-run screen, before any account exists; what goes
  // in is text the user pasted themselves, and it goes through the same funnel
  // (and the same confirm step) as a clicked link. Parsing stays in main.
  ipcHandle('connect:deliver-pasted', async (_event, text: unknown): Promise<ConnectIntent | null> => {
    if (typeof text !== 'string' || text.length > MAX_URL_LENGTH) return null
    return connectIntentService.deliver(text.trim(), 'paste')
  })
}
