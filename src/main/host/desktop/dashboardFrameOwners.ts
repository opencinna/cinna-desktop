import type { WebContents } from 'electron'
import { createLogger } from '../../logger/logger'
import { cloudFrames } from '../../services/dashboards/remote/cloudFrames'
import { createFrameOwners } from '../../services/htmlPreview/frameOwners'
import { dashboardFrameServer } from './htmlPreview'

const logger = createLogger('dashboard-frame')

/**
 * A dashboard frame released the way `dashboards:release-frame` releases it:
 * a cloud tile's page state is withdrawn and its resend stops, and the token
 * no longer serves.
 */
function releaseFrame(token: string): void {
  cloudFrames.released(token)
  dashboardFrameServer.release(token)
}

export const dashboardFrameOwners = createFrameOwners(releaseFrame)

const watched = new WeakSet<WebContents>()

/**
 * Track the renderer that opened a frame token. The first time a renderer
 * opens one, its main-frame navigations (a reload), a crash and its end
 * release every frame it still holds: none of those run the frames' own
 * cleanup.
 */
export function ownDashboardFrame(sender: WebContents, token: string): void {
  const owner = sender.id
  dashboardFrameOwners.own(owner, token)
  if (watched.has(sender)) return
  watched.add(sender)
  const releaseAll = (why: string): void => {
    const n = dashboardFrameOwners.releaseOwner(owner)
    if (n > 0) logger.debug('released dashboard frames of a renderer', { why, frames: n })
  }
  sender.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) releaseAll('navigation')
  })
  sender.on('render-process-gone', () => releaseAll('render-process-gone'))
  sender.once('destroyed', () => releaseAll('destroyed'))
}
