import { app, nativeImage, BrowserWindow } from 'electron'
import iconDarkPath from '../../../resources/cinna-desktop-icon-dark.png?asset'
import iconLightPath from '../../../resources/cinna-desktop-icon-light.png?asset'

export type AppTheme = 'dark' | 'light'

// Dark is the default theme, so the dark icon is also the default at startup.
let currentTheme: AppTheme = 'dark'

function iconImageForTheme(theme: AppTheme): Electron.NativeImage {
  return nativeImage.createFromPath(theme === 'light' ? iconLightPath : iconDarkPath)
}

export const appIconService = {
  getCurrentTheme(): AppTheme {
    return currentTheme
  },

  iconForCurrentTheme(): Electron.NativeImage {
    return iconImageForTheme(currentTheme)
  },

  /** Apply the theme's icon to the macOS dock and any open window. */
  apply(theme: AppTheme): void {
    currentTheme = theme
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(iconImageForTheme(theme))
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setIcon(iconImageForTheme(theme))
    }
  }
}
