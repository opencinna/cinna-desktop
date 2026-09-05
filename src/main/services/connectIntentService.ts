/**
 * The `cinna://connect?server=<origin>` deep link, from the OS to the renderer.
 *
 * ## What arrives here, and how much of it is believed
 *
 * Anything on the machine can ask the OS to open a `cinna://` URL — a web page
 * through a browser prompt, another app, a shortcut a user was mailed. So the
 * URL is parsed as **untrusted input** and reduced to the one field the flow
 * needs: the instance's origin. Path, query, fragment and embedded credentials
 * are dropped rather than sanitized, `https` is required (with a loopback
 * exception so a developer can point the app at their own dev server), and
 * everything else is refused with a logged reason.
 *
 * The reduction to an origin is the load-bearing part. `discoverCinnaEndpoints`
 * appends `/.well-known/cinna-desktop` to whatever it is given and then follows
 * the endpoints in the response, so a URL carrying a path or a query would
 * widen what a link can aim the app at for no benefit — the landing page only
 * ever needs to say *which host*.
 *
 * And validation is not the safety property. **The confirm step is.** This
 * service never starts an OAuth flow and never opens a browser; it buffers one
 * intent and shows it to the user, who reads the host and decides. A link that
 * silently connected an app to a server would be a phishing primitive no amount
 * of parsing would fix.
 *
 * ## One intent, buffered
 *
 * The OS can deliver a URL before there is a window to show it in — on macOS
 * `open-url` fires for a cold launch before `ready` — so an intent is held
 * until someone asks. A second link replaces the first: the user's most recent
 * click is what they meant, and a queue of stale hosts is not something anyone
 * wants to confirm one by one.
 *
 * While an OAuth flow is in flight the intent is still buffered but not pushed:
 * raising the confirm step over a browser round trip the user is in the middle
 * of would either lose the flow or connect the wrong server. `flush()` is
 * called when the flow settles.
 */

import { resolve as resolvePath } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { createLogger } from '../logger/logger'
import { focusMainWindow } from '../window/focus'
import { isCinnaOAuthInProgress } from '../auth/cinna-oauth'
import {
  CONNECT_INTENT_ARGV_FLAG,
  CONNECT_INTENT_CHANNEL,
  CONNECT_SCHEME,
  type ConnectIntent
} from '../../shared/connectIntent'

const logger = createLogger('connect-intent')

/**
 * Refuse a URL longer than this before parsing it. Nothing legitimate is close
 * — an origin is tens of characters — and a megabyte argv entry is not worth
 * handing to `new URL`.
 */
const MAX_URL_LENGTH = 2048

/** Hosts allowed to speak plain `http`, for local development only. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** The one action the scheme currently carries. */
const CONNECT_ACTION = 'connect'

export type ConnectIntentSource = 'open-url' | 'second-instance' | 'argv' | 'test-argv'

/**
 * Reduce a candidate server URL to its origin, or explain why it is refused.
 *
 * Returns the normalized origin. The refusal reason is a *log* string, not
 * something the user is shown: a rejected deep link has no UI, because a link
 * the app refuses should look to the user exactly like a link nobody sent.
 */
export function normalizeServerOrigin(
  raw: string
): { ok: true; origin: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'empty server parameter' }
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'server parameter too long' }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'server parameter is not a URL' }
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'server URL carries credentials' }
  }
  if (!url.hostname) return { ok: false, reason: 'server URL has no host' }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol === 'http:') {
    if (!isLoopback) return { ok: false, reason: 'plain http is only allowed for loopback' }
  } else if (url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported scheme ${url.protocol}` }
  }

  // `origin` is exactly scheme + host + non-default port, which is the whole
  // point: it is the parse, not a substring of the input, so nothing that was
  // in the path or the query can survive into it.
  return { ok: true, origin: url.origin }
}

/**
 * Parse a `cinna://connect?server=…` URL into an intent, or null.
 *
 * The action is read from the authority (`cinna://connect?…`) and from the
 * first path segment (`cinna:///connect?…`), because which of the two the OS
 * hands over has historically depended on the platform and on how the link was
 * written. Both spellings mean the same thing and neither is worth failing on.
 */
export function parseConnectUrl(raw: string): ConnectIntent | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) {
    logger.warn('ignored an oversized deep link')
    return null
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    logger.warn('ignored a deep link that is not a URL')
    return null
  }

  if (url.protocol !== `${CONNECT_SCHEME}:`) {
    logger.warn('ignored a deep link with a foreign scheme', { scheme: url.protocol })
    return null
  }

  const action = (url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase()
  if (action !== CONNECT_ACTION) {
    logger.warn('ignored a deep link with an unknown action', { action })
    return null
  }

  const server = url.searchParams.get('server') ?? ''
  const normalized = normalizeServerOrigin(server)
  if (!normalized.ok) {
    logger.warn('ignored a deep link with an unusable server', { reason: normalized.reason })
    return null
  }

  return { serverUrl: normalized.origin, receivedAt: Date.now() }
}

/**
 * The deep link hidden in a process argv, or null.
 *
 * Two forms, one funnel. A bare `cinna://…` argument is how Linux (and, later,
 * Windows) deliver the URL — the OS re-launches the app with it appended, and
 * an already-running instance receives it through `second-instance`. The
 * `--cinna-connect-intent=` form is the E2E suite's, since `open-url` cannot be
 * raised from a test.
 *
 * Scanning rather than reading a fixed position matters: the app is already
 * launched with other arguments (`--use-mock-keychain`, the app path in dev),
 * and Chromium adds its own.
 */
export function connectUrlFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue
    if (arg.startsWith(CONNECT_INTENT_ARGV_FLAG)) {
      return arg.slice(CONNECT_INTENT_ARGV_FLAG.length)
    }
    if (arg.startsWith(`${CONNECT_SCHEME}://`)) return arg
  }
  return null
}

let pending: ConnectIntent | null = null
let getWindow: (() => BrowserWindow | null) | null = null

export const connectIntentService = {
  /** Called once from `index.ts`, which owns the window. */
  install(resolver: () => BrowserWindow | null): void {
    getWindow = resolver
  },

  /**
   * The single funnel every delivery path lands in: `open-url`,
   * `second-instance`, the startup argv scan, and the test flag.
   *
   * Returns the accepted intent so callers can log, but the reaction — focus
   * and push — happens here, so no caller can accidentally skip it.
   */
  deliver(rawUrl: string, source: ConnectIntentSource): ConnectIntent | null {
    const intent = parseConnectUrl(rawUrl)
    if (!intent) return null

    // Logged at info because a user asking "why did nothing happen when I
    // clicked the button on the landing page" is a real support question, and
    // this line is the answer. The host is not a secret; the intent carries
    // nothing else.
    logger.info('connect intent received', { source, serverUrl: intent.serverUrl })
    pending = intent

    if (isCinnaOAuthInProgress()) {
      logger.info('holding the connect intent until the current authorization ends')
      return intent
    }
    this.flush()
    return intent
  },

  /**
   * Push the buffered intent to the renderer, if there is one and the moment
   * is right. Idempotent, and safe with no window: the renderer pulls the same
   * value from `connect:get-pending` when it mounts.
   */
  flush(): void {
    if (!pending || isCinnaOAuthInProgress()) return
    const win = getWindow?.() ?? null
    if (!win || win.isDestroyed()) return
    focusMainWindow()
    win.webContents.send(CONNECT_INTENT_CHANNEL, pending)
  },

  /** What the renderer hydrates from on mount. */
  getPending(): ConnectIntent | null {
    return pending
  },

  /** The renderer has dealt with it — connected, switched, or declined. */
  consume(): void {
    if (pending) logger.debug('connect intent consumed')
    pending = null
  },

  /** Test seam: forget the buffer between cases. */
  reset(): void {
    pending = null
    getWindow = null
  }
}

/**
 * Claim `cinna://` with the OS.
 *
 * In a packaged app this is one call. Under `npm run dev` the running binary is
 * Electron itself and the app is a script argument, so both have to be passed
 * or the OS would register plain Electron as the handler for every project on
 * the machine. Registration is best-effort: a Linux AppImage without
 * AppImageLauncher simply cannot claim a scheme, and the landing page's
 * paste-the-URL fallback exists for exactly that case.
 */
export function registerConnectScheme(): void {
  try {
    const ok =
      process.defaultApp && process.argv.length >= 2
        ? app.setAsDefaultProtocolClient(CONNECT_SCHEME, process.execPath, [
            resolvePath(process.argv[1])
          ])
        : app.setAsDefaultProtocolClient(CONNECT_SCHEME)
    if (!ok) logger.warn('could not register the cinna:// scheme with the OS')
  } catch (err) {
    logger.warn('registering the cinna:// scheme failed', { error: String(err) })
  }
}
