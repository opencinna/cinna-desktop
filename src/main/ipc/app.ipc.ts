import { appIconService, type AppTheme } from '../services/appIconService'
import { ipcHandle } from './_wrap'

export function registerAppHandlers(): void {
  ipcHandle('app:set-theme', (_event, theme: AppTheme) => {
    if (theme !== 'dark' && theme !== 'light') return { success: false as const }
    appIconService.apply(theme)
    return { success: true as const }
  })
}
