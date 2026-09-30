import { protocol, session, shell, type BrowserWindow, type Session, type WebFrameMain } from 'electron'
import { join } from 'node:path'
import { getProfileScopeUserId } from '../../auth/scope'
import { FileError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { fileService, type FileScope } from '../../services/fileService'
import {
  HTML_PREVIEW_SCHEME,
  createHtmlPreviewServer
} from '../../services/htmlPreview/htmlPreviewServer'
import { runtimeHost } from '../runtimeHost'
import { agentFileService, openInBrowser } from './agentFiles'
import {
  createExternalOpenGate,
  isAppPermissionRequester,
  isPreviewDownloadUrl,
  mainFrameNavigation,
  previewFrameNavigation,
  safeHtmlFilename
} from './htmlPreviewGuards'
import { clearOpenInBrowserCopies, prepareOpenInBrowserDir } from './openInBrowserCopies'

const logger = createLogger('html-preview')

/**
 * The HTML preview's Electron side: the `cinna-preview:` scheme, the guards
 * that keep a previewed page inside its sandboxed frame, and Open in browser
 * for an attachment.
 *
 * Must run before `app` is ready: a scheme's privileges cannot be granted
 * later, and this is the app's only `registerSchemesAsPrivileged` call (a
 * second call would replace the first's list).
 */
export function registerHtmlPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: HTML_PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

/** The production token registry and request handler. */
export const htmlPreviewServer = createHtmlPreviewServer({
  currentUserId: getProfileScopeUserId,
  readAttachment: (input) => fileService.readBytes(input),
  readAgentDocument: (input, maxBytes) => agentFileService.readHtmlDocument(input, maxBytes),
  readAgentAsset: (input, segments, maxBytes) => agentFileService.readHtmlAsset(input, segments, maxBytes)
})

const installed = new WeakSet<Session>()

/**
 * On the main window's session (the default one): serve the scheme, refuse
 * every permission a frame asks for while the app's own main frame keeps
 * Electron's default, and cancel a download a preview starts. Once per
 * session; after `app` is ready.
 */
export function installHtmlPreviewSession(ses: Session = session.defaultSession): void {
  if (installed.has(ses)) return
  installed.add(ses)
  ses.protocol.handle(HTML_PREVIEW_SCHEME, (request) => htmlPreviewServer.handle(request))
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const granted = isAppPermissionRequester(details)
    if (!granted) logger.info('refused a permission to a frame', { permission })
    callback(granted)
  })
  ses.setPermissionCheckHandler((_webContents, _permission, requestingOrigin, details) =>
    isAppPermissionRequester(details, requestingOrigin)
  )
  ses.on('will-download', (event, item) => {
    if (!isPreviewDownloadUrl(item.getURL())) return
    event.preventDefault()
    logger.info('cancelled a download from a preview frame')
  })
}

/** A frame's URL and its ancestors' (nearest first, without the main frame); empty when it is gone. */
function frameChainUrls(frame: WebFrameMain | null | undefined): string[] {
  const urls: string[] = []
  try {
    let current = frame ?? null
    // The main frame (the one with no parent) is the app, not a frame that counts.
    while (current && current.parent) {
      urls.push(current.url)
      current = current.parent
    }
  } catch {
    // A frame that went away mid-navigation: judged as a frame outside any preview.
  }
  return urls
}

/**
 * On the main window: a subframe goes only where {@link previewFrameNavigation}
 * allows, and the main frame never leaves the app's own page
 * ({@link mainFrameNavigation}). A link clicked in a preview reaches the main
 * frame as a top navigation — the only way out the frame's sandbox leaves it,
 * and only inside a click — which is stopped and, for `http(s)`, sent to the
 * user's browser, once per click ({@link createExternalOpenGate}).
 */
export function guardPreviewFrames(win: BrowserWindow, appUrl: string): void {
  const gate = createExternalOpenGate()
  win.on('blur', gate.windowBlurred)
  win.on('focus', gate.windowFocused)
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    const [frameUrl = '', ...ancestorUrls] = frameChainUrls(event.frame)
    const verdict = previewFrameNavigation({ isMainFrame: false, url: event.url, frameUrl, ancestorUrls })
    if (verdict === 'allow') return
    event.preventDefault()
    logger.info('blocked a frame navigation', { verdict })
  })
  win.webContents.on('will-navigate', (event) => {
    const verdict = mainFrameNavigation({
      url: event.url,
      appUrls: [appUrl, win.webContents.getURL()],
      initiatorUrls: frameChainUrls(event.initiator)
    })
    if (verdict === 'allow') return
    event.preventDefault()
    if (verdict === 'open-external' && gate.mayOpen()) {
      void shell.openExternal(event.url).catch(() => {})
      logger.info('sent a preview link to the browser')
    } else {
      logger.info('blocked a main-frame navigation', { verdict })
    }
  })
}

/**
 * Open in browser for an HTML attachment: its bytes go to
 * `<userData>/html-open-in-browser/<id hash>/<name>` — a browser needs a file
 * ({@link prepareOpenInBrowserDir}) — and that file to the default browser.
 * The read is the download's own: ownership-scoped for local files, the
 * user's bearer for Cinna files.
 */
export async function openAttachmentInBrowser(input: {
  userId: string
  attachmentId: string
  source: FileScope
  filename: string
}): Promise<void> {
  const name = safeHtmlFilename(input.filename)
  if (!name) throw new FileError('not_previewable', 'Only HTML files open in the browser.')
  const dir = await prepareOpenInBrowserDir(runtimeHost.getPath('userData'), input.userId, input.attachmentId)
  const destPath = join(dir, name)
  await fileService.downloadToPath({
    userId: input.userId,
    attachmentId: input.attachmentId,
    source: input.source,
    destPath
  })
  try {
    await openInBrowser(destPath)
  } catch (err) {
    logger.warn('opening an attachment in the browser failed', {
      error: err instanceof Error ? err.name : 'unknown'
    })
    throw new FileError('launch_failed', 'No browser could open this file.')
  }
  logger.info('opened an attachment in the browser', { source: input.source })
}

/**
 * Remove the copies earlier Open in browser runs left, in the background: a
 * browser tab still showing one is the user's own, from a previous run.
 */
export function clearOpenInBrowserCopiesAtStart(): void {
  void clearOpenInBrowserCopies(runtimeHost.getPath('userData')).catch((err) => {
    logger.warn('could not clear the open-in-browser copies', { error: err instanceof Error ? err.name : 'unknown' })
  })
}
