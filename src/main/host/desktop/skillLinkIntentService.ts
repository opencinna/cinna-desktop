/**
 * The `cinna://skill/<package_id>[?server=<origin>]` deep link, from the OS to
 * the renderer: the public skill page's **Open in Cinna Desktop** button.
 *
 * It behaves as the connect link does (`connectIntentService`), in its own
 * slot: the URL is untrusted and reduced by `parseSkillLink` to an origin and
 * a package id; one intent is held until a window asks for it, the newest
 * replacing it; while an OAuth flow is in flight it is held but not pushed,
 * and `flush()` runs when the flow settles. Nothing installs here — the
 * composer's offer is the confirm step, and `skillLinkService.resolve` decides
 * what it says.
 *
 * Its own slot, not the connect one: a skill link arriving while the person
 * reads a connect confirm step must not evict that intent, and a later
 * `consume` must drop only what it names.
 */

import type { BrowserWindow } from 'electron'
import { createLogger } from '../../logger/logger'
import { focusMainWindow } from '../../window/focus'
import { isCinnaOAuthInProgress } from '../../auth/cinna-oauth'
import { parseSkillLink, SKILL_LINK_INTENT_CHANNEL, type SkillLinkIntent } from '../../../shared/skillLink'

const logger = createLogger('skill-link-intent')

/** Where a skill deep link came from; the OS paths and the E2E flag. */
export type SkillLinkIntentSource = 'open-url' | 'second-instance' | 'argv' | 'test-argv'

let pending: SkillLinkIntent | null = null
let getWindow: (() => BrowserWindow | null) | null = null

export const skillLinkIntentService = {
  /** Called once from `index.ts` (through `deepLinkService.install`), which owns the window. */
  install(resolver: () => BrowserWindow | null): void {
    getWindow = resolver
  },

  /** Buffer the link and push it when the moment is right. Null when the URL is not a skill link. */
  deliver(rawUrl: string, source: SkillLinkIntentSource): SkillLinkIntent | null {
    const link = parseSkillLink(rawUrl)
    if (!link) {
      // Never the URL itself: it is untrusted, and whatever it carried is not ours to log.
      logger.warn('ignored a skill deep link that does not parse', { source })
      return null
    }
    const intent: SkillLinkIntent = { link, receivedAt: Date.now() }
    // Both fields passed the grammar: an origin and `[A-Za-z0-9._-]`.
    logger.info('skill link intent received', { source, origin: link.origin, packageId: link.packageId })
    pending = intent
    if (isCinnaOAuthInProgress()) {
      logger.info('holding the skill link intent until the current authorization ends')
      return intent
    }
    this.flush()
    return intent
  },

  /**
   * Push the buffered intent to the renderer, if there is one and the moment
   * is right. Idempotent, and safe with no window: the renderer pulls the same
   * value from `skill-link:get-pending` when it mounts.
   */
  flush(): void {
    if (!pending || isCinnaOAuthInProgress()) return
    const win = getWindow?.() ?? null
    if (!win || win.isDestroyed()) return
    focusMainWindow()
    win.webContents.send(SKILL_LINK_INTENT_CHANNEL, pending)
  },

  /** What the renderer hydrates from on mount. */
  getPending(): SkillLinkIntent | null {
    return pending
  },

  /** The offer took it. With `receivedAt`, only that intent is dropped, so a newer click survives. */
  consume(receivedAt?: number): void {
    if (receivedAt !== undefined && pending?.receivedAt !== receivedAt) return
    if (pending) logger.debug('skill link intent consumed')
    pending = null
  },

  /** Test seam: forget the buffer between cases. */
  reset(): void {
    pending = null
    getWindow = null
  }
}
