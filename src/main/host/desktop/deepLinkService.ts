/**
 * The one funnel every `cinna://` delivery lands in: `open-url`,
 * `second-instance`, the startup argv scan and the E2E suite's
 * `--cinna-connect-intent=` flag. It reads the action and hands the URL to
 * that action's own service, each with its own one-intent buffer:
 *
 * * `skill` → `skillLinkIntentService` (`cinna://skill/<package_id>`).
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

import type { BrowserWindow } from 'electron'
import { connectIntentService, connectUrlFromArgv } from './connectIntentService'
import { skillLinkIntentService } from './skillLinkIntentService'
import { CONNECT_SCHEME } from '../../../shared/connectIntent'
import { MAX_URL_LENGTH } from '../../../shared/serverOrigin'

/** Where an OS or test delivery came from (paste and clipboard reach `connectIntentService` directly). */
export type DeepLinkSource = 'open-url' | 'second-instance' | 'argv' | 'test-argv'

const SKILL_ACTION = 'skill'

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
