import { shell } from 'electron'
import { appIconService, type AppTheme } from '../host/desktop/appIconService'
import { ipcHandle } from './_wrap'

export function registerAppHandlers(): void {
  ipcHandle('app:set-theme', (_event, theme: AppTheme) => {
    if (theme !== 'dark' && theme !== 'light') return { success: false as const }
    appIconService.apply(theme)
    return { success: true as const }
  })

  // Open an external URL via the OS. Restrict to http(s) so a malicious/
  // misconfigured caller can't shell out to custom protocols. Mirrors the
  // policy already enforced in the renderer's `setWindowOpenHandler`.
  //
  // Two different failures, answered with two codes: a string that is not a
  // link at all, and a link the OS refused to open (no default browser, a
  // handler that failed). One catch around both used to call the second
  // `invalid_url`, telling the user a valid https address was not a link.
  ipcHandle('app:open-external', async (_event, url: string) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { success: false as const, error: 'invalid_url' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false as const, error: 'unsupported_protocol' }
    }
    try {
      await shell.openExternal(url)
      return { success: true as const }
    } catch {
      return { success: false as const, error: 'open_failed' }
    }
  })
}
