import { useCallback } from 'react'

/** What `app:open-external` refuses with. A closed set, all from `app.ipc.ts`. */
export type OpenExternalCode = 'unsupported_protocol' | 'invalid_url' | 'open_failed'

export type OpenExternalResult =
  | { success: true }
  | {
      success: false
      /** A sentence, ready to render. See {@link describeOpenExternalFailure}. */
      error: string
      /** The same refusal for code to read, if a caller ever needs to branch. */
      code: OpenExternalCode | null
    }

/**
 * Why a link did not open, in words.
 *
 * **Main answers in codes, and every caller of this hook prints the answer.**
 * `app:open-external` returns `unsupported_protocol`, `invalid_url` or
 * `open_failed` (the OS refused a valid link) — which
 * is right for a main-process result and wrong for a surface, and both of the
 * places that render it were putting the bare identifier on screen
 * (`ux_rules.md` §6: the user must never read the wire). One sentence per code,
 * here, so the two surfaces cannot spell the same refusal two ways.
 *
 * Every sentence is deliberately short enough to fit one line at the app's
 * narrowest supported width — the task page reserves exactly one line for this
 * message, and a wrap there would move the page under the click that produced
 * it (`ux_rules.md` §1, §7).
 */
export function describeOpenExternalFailure(code: string | null | undefined): string {
  if (code === 'unsupported_protocol') return 'Only http and https links can be opened.'
  if (code === 'invalid_url') return 'That is not a link this can open.'
  if (code === 'open_failed') return 'Your system could not open that link.'
  return 'That link could not be opened.'
}

/**
 * Open a URL in the user's default browser via the main process (which guards
 * to `http:`/`https:` only). Wraps `window.api.system.openExternal` so
 * components don't reach into the contextBridge surface directly — and so the
 * refusal arrives as something a person can read rather than as its code.
 */
export function useOpenExternal(): (url: string) => Promise<OpenExternalResult> {
  return useCallback(async (url: string): Promise<OpenExternalResult> => {
    const result = await window.api.system.openExternal(url)
    if (result.success) return { success: true }
    const code = result.error
    return {
      success: false,
      error: describeOpenExternalFailure(code),
      code: code === 'unsupported_protocol' || code === 'invalid_url' || code === 'open_failed'
        ? code
        : null
    }
  }, [])
}
