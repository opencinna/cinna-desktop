/**
 * The one funnel every `cinna://` delivery lands in: `open-url`,
 * `second-instance`, the startup argv scan and the E2E suite's
 * `--cinna-connect-intent=` flag. It reads the action and hands the URL to
 * that action's own service, each with its own one-intent buffer:
 *
 * * `skill` → `skillLinkIntentService` (`cinna://skill/<package_id>`).
 * * `oauth-done` → Core's Google sign-in end page handing the user back
 *   (`cinna://oauth-done?credential_id=<uuid>` or `?status=error`): the window
 *   comes forward and the waiting Google connects poll Core now. Nothing is
 *   buffered and nothing in the link is believed beyond "poll now"; what the
 *   poll reads from Core decides, as on any tick.
 * * anything else → `connectIntentService`, exactly as before this funnel
 *   existed: `connect` is accepted there, and an unknown action is refused
 *   and logged there.
 *
 * Separate slots on purpose: one shared slot would let a skill link evict a
 * connect intent the person is reading in its confirm step, and that step's
 * later `consume` would drop the wrong one.
 *
 * The action is read as `connectIntentService` reads it — the authority
 * (`cinna://skill/…`) or the first path segment (`cinna:///skill/…`).
 */

import { app, type BrowserWindow } from 'electron'
import { connectIntentService, connectUrlFromArgv } from './connectIntentService'
import { skillLinkIntentService } from './skillLinkIntentService'
import { ensureMainWindow, focusMainWindow } from '../../window/focus'
import { createLogger } from '../../logger/logger'
import { serviceCredentialService } from '../../services/serviceCredentials/service'
import { CONNECT_SCHEME } from '../../../shared/connectIntent'
import { MAX_URL_LENGTH } from '../../../shared/serverOrigin'

/** Where an OS or test delivery came from (paste and clipboard reach `connectIntentService` directly). */
export type DeepLinkSource = 'open-url' | 'second-instance' | 'argv' | 'test-argv'

const SKILL_ACTION = 'skill'
const OAUTH_DONE_ACTION = 'oauth-done'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const logger = createLogger('deep-link')

/**
 * What a `cinna://oauth-done` link may say: which record finished (`credential_id`, a UUID; anything else
 * is ignored) and whether it failed (`status=error`). Every other parameter is ignored. Null when the URL
 * is not an `oauth-done` link.
 */
export function parseOAuthDoneLink(raw: string): { credentialId: string | null; failed: boolean } | null {
  if (deepLinkActionOf(raw) !== OAUTH_DONE_ACTION) return null
  const params = new URL(raw).searchParams
  const id = params.get('credential_id')
  return { credentialId: id && UUID.test(id) ? id.toLowerCase() : null, failed: params.get('status') === 'error' }
}

/** The deep link's action, lowercased, or null when the URL is not a `cinna://` one that parses. */
export function deepLinkActionOf(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${CONNECT_SCHEME}:`) return null
  return (url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase()
}

/** The deep link in a process argv (a bare `cinna://…`, or the test flag's), or null. */
export const deepLinkUrlFromArgv = connectUrlFromArgv

export const deepLinkService = {
  /** Called once from `index.ts`, which owns the window. */
  install(resolver: () => BrowserWindow | null): void {
    connectIntentService.install(resolver)
    skillLinkIntentService.install(resolver)
  },

  /** Route one delivered URL to its action's service. The reaction (focus, push) happens there. */
  deliver(rawUrl: string, source: DeepLinkSource): void {
    const done = parseOAuthDoneLink(rawUrl)
    if (done) {
      // The user just finished a sign-in they started here: bring the window back, then poll at once.
      logger.info('Google sign-in handed back', { source, credentialId: done.credentialId !== null, failed: done.failed })
      // A window the user closed (macOS keeps the app in the Dock) is opened again. Before `ready` (a cold
      // launch from the link) there is none to make yet: startup shows the first one.
      if (app.isReady()) void ensureMainWindow().then(() => focusMainWindow(), () => focusMainWindow())
      else focusMainWindow()
      // A failure names no record: every waiting connect polls and finds its own state on Core.
      serviceCredentialService.nudgeOAuthFlows(done.failed ? null : done.credentialId)
      return
    }
    if (deepLinkActionOf(rawUrl) === SKILL_ACTION) {
      skillLinkIntentService.deliver(rawUrl, source)
      return
    }
    connectIntentService.deliver(rawUrl, source)
  },

  /** An OAuth flow settled: push whatever each slot was holding. */
  flush(): void {
    connectIntentService.flush()
    skillLinkIntentService.flush()
  }
}
