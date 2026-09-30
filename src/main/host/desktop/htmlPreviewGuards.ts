import { HTML_PREVIEW_SCHEME } from '../../services/htmlPreview/htmlPreviewServer'
import { previewKindFor } from '../../../shared/filePreview'

/**
 * The main-process rules that keep a previewed HTML page inside its frame.
 * Pure, so each can be tested without Electron; `htmlPreview.ts` wires them to
 * the main window's webContents and session.
 */

const PREVIEW_PREFIX = `${HTML_PREVIEW_SCHEME}:`

function schemeOf(url: string): string {
  const colon = url.indexOf(':')
  return colon > 0 ? url.slice(0, colon + 1).toLowerCase() : ''
}

function isPreviewUrl(url: string | undefined): boolean {
  return typeof url === 'string' && schemeOf(url) === PREVIEW_PREFIX
}

function isWebUrl(url: string): boolean {
  const scheme = schemeOf(url)
  return scheme === 'http:' || scheme === 'https:'
}

export type FrameNavigationVerdict = 'allow' | 'block' | 'open-external'

export interface MainFrameNavigation {
  /** Where the app window's main frame is going. */
  url: string
  /**
   * The app's own URLs: the one it loads (the dev server's, or the packaged
   * `file://` index) and the one it is on now.
   */
  appUrls: readonly string[]
  /** The initiating frame's URL and its ancestors', nearest first; empty when unknown. */
  initiatorUrls: readonly string[]
}

function isAppUrl(url: string, appUrl: string): boolean {
  let target: URL
  let app: URL
  try {
    target = new URL(url)
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') return target.protocol === 'file:' && target.pathname === app.pathname
  return target.origin === app.origin
}

/**
 * What a navigation of the app window's main frame may do. The app never
 * navigates its main frame away from its own page, so:
 *
 * - its own URL is allowed (a `location.reload()` arrives here too; in
 *   development any page of the dev server's origin, for its reloads);
 * - an `http(s)` URL a preview frame — or a frame inside one — asked for goes
 *   to the user's browser. The preview's sandbox lets it navigate the top
 *   frame only inside a user activation, so this is a click, never a script
 *   on its own;
 * - anything else is blocked.
 */
export function mainFrameNavigation(nav: MainFrameNavigation): FrameNavigationVerdict {
  // A preview never navigates the app, not even to its own page: in
  // development that page is http(s), and a click could reload the app or
  // load another dev-server page into the window.
  if (nav.initiatorUrls.some(isPreviewUrl)) return isWebUrl(nav.url) ? 'open-external' : 'block'
  if (nav.appUrls.some((appUrl) => isAppUrl(nav.url, appUrl))) return 'allow'
  return 'block'
}

export interface FrameNavigation {
  isMainFrame: boolean
  /** Where the frame is going. */
  url: string
  /** Where the frame is now; empty or `about:blank` before its first load. */
  frameUrl: string
  /** The frame's ancestors' URLs, nearest first, without the main frame. */
  ancestorUrls: readonly string[]
}

/**
 * What a navigation of a frame inside the app window may do.
 *
 * - The main frame is not this rule's business.
 * - A subframe may load `cinna-preview:` and `about:blank` / `about:srcdoc`.
 * - The preview document leaving for an `http(s)` page on its own (a form, a
 *   script, a link the helper did not retarget) is blocked — the frame never
 *   becomes a web browser inside the app. Chromium reports no user gesture
 *   here, so nothing from it goes to the browser: a link opens there only
 *   through a gestured top navigation ({@link mainFrameNavigation}).
 * - A frame the page itself embeds (anything under a preview document) may
 *   load `http(s)`, `data:` and `blob:`: remote content is allowed, and the
 *   sandbox the preview frame carries is inherited by everything inside it.
 * - Anything else — `file:`, the app's own origin, another custom scheme, a
 *   subframe outside a preview — is blocked.
 */
export function previewFrameNavigation(nav: FrameNavigation): FrameNavigationVerdict {
  if (nav.isMainFrame) return 'allow'
  const url = nav.url
  if (isPreviewUrl(url)) return 'allow'
  if (url === 'about:blank' || url === 'about:srcdoc') return 'allow'
  const isPreviewDocument = isPreviewUrl(nav.frameUrl)
  const insidePreview = isPreviewDocument || nav.ancestorUrls.some(isPreviewUrl)
  if (!insidePreview) return 'block'
  if (isWebUrl(url)) return isPreviewDocument ? 'block' : 'allow'
  const scheme = schemeOf(url)
  if (scheme === 'data:' || scheme === 'blob:') return 'allow'
  return 'block'
}

export interface PermissionRequester {
  isMainFrame: boolean
  requestingUrl?: string
}

/**
 * Whether a permission request or check comes from the app itself — the
 * window's main frame — rather than a preview frame or anything inside it.
 * The app keeps Electron's default (granted); every subframe is refused: the
 * app has no frames of its own, and a preview never gets the camera, the
 * microphone, notifications, geolocation or the clipboard.
 */
export function isAppPermissionRequester(details: PermissionRequester, requestingOrigin?: string): boolean {
  if (!details.isMainFrame) return false
  if (isPreviewUrl(details.requestingUrl)) return false
  if (requestingOrigin !== undefined && (requestingOrigin === 'null' || isPreviewUrl(requestingOrigin))) return false
  return true
}

/**
 * A download a preview could have started: from its scheme, a blob of its
 * opaque origin (`blob:null/…`) or a `data:` URL. The app's own downloads are
 * blobs of its own origin and are left alone.
 */
export function isPreviewDownloadUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return (
    isPreviewUrl(lower) ||
    lower.startsWith('blob:null/') ||
    lower.startsWith(`blob:${PREVIEW_PREFIX}`) ||
    lower.startsWith('data:')
  )
}

/**
 * An attachment's file name as Open in browser writes it to disk: its last
 * segment, anything but letters, digits, space, `.`, `-`, `_`, `(`, `)`
 * replaced, no leading dot, at most 120 characters with the extension kept.
 * Null when the result is not an HTML name.
 */
export function safeHtmlFilename(filename: string): string | null {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? ''
  let name = base.replace(/[^\p{L}\p{N} ._\-()]/gu, '_').replace(/^[.\s]+/, '').trim()
  if (name.length > 120) {
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 ? name.slice(dot) : ''
    name = name.slice(0, 120 - extension.length) + extension
  }
  if (!name || previewKindFor(name) !== 'html') return null
  return name
}

/** How long Chromium keeps a frame's user activation after a click or key press. */
export const ACTIVATION_WINDOW_MS = 5000

/**
 * One preview-initiated `openExternal` per click. Chromium lets the preview
 * navigate the top frame only inside a user activation, but it does not use
 * the activation up: for about five seconds after one click, a page can keep
 * asking. So after an open, the next waits out that window — or until the
 * user has left the app and come back, which is what following a link does,
 * so a second link clicked on return is never refused.
 */
export function createExternalOpenGate(cooldownMs = ACTIVATION_WINDOW_MS, now: () => number = Date.now) {
  let last = -Infinity
  let leftSinceOpen = false
  let returnedSinceOpen = false
  return {
    mayOpen(): boolean {
      const at = now()
      if (at - last < cooldownMs && !returnedSinceOpen) return false
      last = at
      leftSinceOpen = false
      returnedSinceOpen = false
      return true
    },
    windowBlurred(): void {
      leftSinceOpen = true
    },
    windowFocused(): void {
      if (leftSinceOpen) returnedSinceOpen = true
    }
  }
}
