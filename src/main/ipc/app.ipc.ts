import { shell } from 'electron'
import { appIconService, type AppTheme } from '../services/appIconService'
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
  ipcHandle('app:open-external', async (_event, url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false as const, error: 'unsupported_protocol' }
      }
      await shell.openExternal(url)
      return { success: true as const }
    } catch {
      return { success: false as const, error: 'invalid_url' }
    }
  })
}
