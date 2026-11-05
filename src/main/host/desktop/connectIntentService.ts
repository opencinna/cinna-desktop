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
import { createLogger } from '../../logger/logger'
import { focusMainWindow } from '../../window/focus'
import { isCinnaOAuthInProgress } from '../../auth/cinna-oauth'
import {
  CONNECT_INTENT_ARGV_FLAG,
  CONNECT_INTENT_CHANNEL,
  CONNECT_SCHEME,
  type ConnectIntent
} from '../../../shared/connectIntent'
import { MAX_URL_LENGTH, normalizeServerOrigin } from '../../../shared/serverOrigin'

// The origin rules are shared with the skill-link parser; both stay importable
// from here, where the connect flow and its tests have always found them.
export { MAX_URL_LENGTH, normalizeServerOrigin }

const logger = createLogger('connect-intent')

/** This service's action; `deepLinkService` routes the others (`skill`) elsewhere. */
const CONNECT_ACTION = 'connect'

export type ConnectIntentSource =
  | 'open-url'
  | 'second-instance'
  | 'argv'
  | 'test-argv'
  | 'clipboard'
  | 'paste'

/** Options for {@link connectIntentService.deliver}. */
export interface DeliverOptions {
  /**
   * Push the accepted intent to the renderer (the default). The clipboard check
   * passes `false`: the renderer asked for the answer and decides itself whether
   * it is still in time to show it, and a push would bypass that decision.
   */
  push?: boolean
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

/**
 * Where the first-run clipboard check reads from. `index.ts` installs it: the
 * real pasteboard in a normal run, the `CINNA_E2E_CLIPBOARD_TEXT` seam (or
 * nothing at all) under the E2E sandbox. Null never reads.
 */
let clipboardSource: (() => string | undefined) | null = null
/** Clipboard text worth parsing: a `cinna://connect` link in either spelling. */
const CLIPBOARD_LINK = new RegExp(`^${CONNECT_SCHEME}:///?${CONNECT_ACTION}(?:[/?#]|$)`, 'i')

/** Set by the first {@link connectIntentService.checkClipboardOnce} of the process. */
let clipboardChecked = false

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
  deliver(
    rawUrl: string,
    source: ConnectIntentSource,
    options: DeliverOptions = {}
  ): ConnectIntent | null {
    const intent = parseConnectUrl(rawUrl)
    if (!intent) return null

    // Logged at info because a user asking "why did nothing happen when I
    // clicked the button on the landing page" is a real support question, and
    // this line is the answer. The host is not a secret; the intent carries
    // nothing else.
    logger.info('connect intent received', { source, serverUrl: intent.serverUrl })
    pending = intent

    if (options.push === false) return intent
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

  /**
   * The renderer has dealt with it — connected, switched, or declined. With
   * `receivedAt`, only that intent is dropped: the first-run gate discarding a
   * late clipboard answer must not take a link clicked a moment later with it.
   */
  consume(receivedAt?: number): void {
    if (receivedAt !== undefined && pending?.receivedAt !== receivedAt) return
    if (pending) logger.debug('connect intent consumed')
    pending = null
  },

  /** Called once from `index.ts`, which decides whether the sandbox may read it. */
  installClipboardSource(source: (() => string | undefined) | null): void {
    clipboardSource = source
  },

  /**
   * The install handoff: the download page copied a `cinna://connect` link, and
   * the first run of the freshly installed app picks it up from the clipboard.
   *
   * At most one read per process — the renderer asks once on first-run
   * onboarding, and nothing else may turn this into a clipboard watcher. No
   * read at all when an intent is already pending (a clicked link is newer and
   * more deliberate than a copied one). The clipboard is the user's private
   * data, so nothing that is not a candidate link is ever logged, and the
   * clipboard is never written or cleared.
   *
   * The accepted intent is buffered **without a push**: the renderer drops an
   * answer that arrives after the welcome step has painted (nothing may move
   * under the user), and a push would land regardless. Returns only an intent
   * this read delivered: one that was already pending reaches the renderer
   * through `connect:get-pending`, and the renderer consumes a late answer, so
   * returning a clicked link here would let that consume drop it.
   */
  checkClipboardOnce(): ConnectIntent | null {
    if (clipboardChecked) return null
    clipboardChecked = true
    if (pending || !clipboardSource) return null

    let raw: unknown
    try {
      raw = clipboardSource()
    } catch (err) {
      logger.warn('could not read the clipboard', {
        // The class and message of the failure only; a failed read has no
        // contents to leak, and this is the one place that could be tempted.
        error: err instanceof Error ? `${err.name}: ${err.message}` : typeof err
      })
      return null
    }
    if (typeof raw !== 'string') return null

    const text = raw.trim()
    // Narrower than the scheme: `parseConnectUrl` logs the action of a
    // `cinna://` URL it refuses, and for clipboard text that would be a piece
    // of whatever the user copied.
    if (!CLIPBOARD_LINK.test(text) || text.length > MAX_URL_LENGTH) {
      logger.debug('the clipboard holds no connect link')
      return null
    }
    return this.deliver(text, 'clipboard', { push: false })
  },

  /** Test seam: forget the buffer between cases. */
  reset(): void {
    pending = null
    getWindow = null
    clipboardSource = null
    clipboardChecked = false
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
