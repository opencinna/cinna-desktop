/**
 * Which `did-fail-load` events mean the app's renderer failed. Only the main
 * frame's: a subframe — a Details page, an HTML preview, a dashboard tile —
 * failing or being refused (a CSP block, a dropped navigation) is that frame's
 * business, never a reason to show the restart dialog or exit the app. A page
 * the app shows must not be able to end it. `-3` (ERR_ABORTED) is a normal
 * cancelled navigation, also on the main frame.
 */
export function isRendererLoadFailure(failure: { errorCode: number; isMainFrame: boolean }): boolean {
  if (!failure.isMainFrame) return false
  return failure.errorCode !== -3
}

/** The scheme of a failed URL, for a log line that does not carry the URL itself. */
export function failedUrlScheme(url: string): string {
  const colon = url.indexOf(':')
  return colon > 0 ? url.slice(0, colon).toLowerCase() : ''
}
