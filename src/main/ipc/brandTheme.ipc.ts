import { brandThemeService } from '../services/brandTheme/brandThemeService'
import { createLogger } from '../logger/logger'
import { ipcHandle } from './_wrap'
import { BRAND_THEME_GET_CHANNEL, type ResolvedBrandTheme } from '../../shared/brandTheme/roles'

const logger = createLogger('brand-theme')

/**
 * The brand theme a window applies. Not gated on activation: a window asks
 * before first paint, while the app is still starting into a profile (or
 * showing its password lock), and a theme is public anyway (README B7).
 * Never throws: anything that goes wrong is stock Cinna (null).
 */
export function registerBrandThemeHandlers(): void {
  ipcHandle(BRAND_THEME_GET_CHANNEL, (): ResolvedBrandTheme | null => {
    try {
      return brandThemeService.get()
    } catch (err) {
      logger.warn('brand theme could not be read; showing stock', { error: err instanceof Error ? err.message : 'error' })
      return null
    }
  })
}
