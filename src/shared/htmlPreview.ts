/**
 * The HTML preview frame's IPC contract. The renderer asks main for a
 * `cinna-preview://<token>/<name>` URL for a file it is previewing; main checks
 * the file the way the text preview does and serves the page and (for an
 * agent file) the files beside it under that token until it is released.
 */

export type HtmlPreviewOpenInput =
  | { type: 'attachment'; fileId: string; source?: 'cinna' | 'local'; filename: string; mimeType?: string }
  | { type: 'agentFile'; agentId: string; path: string }

export type HtmlPreviewOpenResult =
  | { success: true; token: string; url: string }
  | { success: false; error: string; code?: string }

/** Open in browser for an attachment: the file is copied into the profile's folder and opened there. */
export interface FilesOpenInBrowserInput {
  fileId: string
  filename: string
  source?: 'cinna' | 'local'
}

export type FilesOpenInBrowserResult = { success: true } | { success: false; error: string; code?: string }

/**
 * The frame's sandbox: scripts, forms and dialogs, and a navigation of the
 * app's main frame only inside a user activation — Chromium enforces the
 * gesture, and main stops that navigation and sends an `http(s)` target to the
 * browser. No popups (a script could open them without a click), and never
 * `allow-same-origin` — the page gets an opaque origin, so it cannot reach the
 * app or keep storage.
 */
export const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-top-navigation-by-user-activation'
