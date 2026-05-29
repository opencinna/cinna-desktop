import { useCallback } from 'react'

type OpenExternalResult = { success: true } | { success: false; error: string }

/**
 * Open a URL in the user's default browser via the main process (which guards
 * to `http:`/`https:` only). Wraps `window.api.system.openExternal` so
 * components don't reach into the contextBridge surface directly.
 */
export function useOpenExternal(): (url: string) => Promise<OpenExternalResult> {
  return useCallback((url: string) => window.api.system.openExternal(url), [])
}
