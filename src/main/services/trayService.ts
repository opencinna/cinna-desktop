import { Tray, BrowserWindow, nativeImage, screen, app, type NativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { appIconService } from './appIconService'
import { createLogger } from '../logger/logger'

const logger = createLogger('tray')

const POPUP_WIDTH = 340
const POPUP_HEIGHT = 460
// Window gains/loses focus around a tray click; if a click lands within this
// window of the popup auto-hiding on blur, treat it as a toggle-closed instead
// of immediately reopening.
const REOPEN_GUARD_MS = 250

const FADE_MS = 130
const FADE_TICK_MS = 16

interface TrayDeps {
  getMainWindow: () => BrowserWindow | null
}

let tray: Tray | null = null
let popup: BrowserWindow | null = null
let deps: TrayDeps | null = null
let lastHideAt = 0
let fadeTimer: ReturnType<typeof setInterval> | null = null

function placeholderImage(): NativeImage {
  return appIconService.iconForCurrentTheme().resize({ width: 16, height: 16 })
}

function buildPopup(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    transparent: true,
    // macOS draws a native shadow + rounded corners around the vibrant window;
    // other platforms get the CSS-rounded translucent panel without blur.
    hasShadow: isMac,
    ...(isMac ? { vibrancy: 'popover' as const, visualEffectState: 'active' as const } : {}),
    alwaysOnTop: true,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('blur', () => {
    if (!win.isDestroyed()) fadeOutPopup(win)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/trayPanel.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/trayPanel.html'))
  }

  return win
}

/** Center the popup horizontally under the tray icon, clamped to the display. */
function positionPopup(win: BrowserWindow): void {
  const bounds = tray?.getBounds()
  if (bounds && (bounds.width || bounds.height)) {
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    const work = display.workArea
    let x = Math.round(bounds.x + bounds.width / 2 - POPUP_WIDTH / 2)
    x = Math.max(work.x + 4, Math.min(x, work.x + work.width - POPUP_WIDTH - 4))
    // macOS tray sits in the menu bar at the top; drop the popup just below it.
    const y = Math.round(bounds.y + bounds.height + 4)
    win.setPosition(x, y, false)
    return
  }
  // Linux/empty-bounds fallback: anchor near the cursor.
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const work = display.workArea
  const x = Math.max(work.x + 4, Math.min(cursor.x - POPUP_WIDTH / 2, work.x + work.width - POPUP_WIDTH - 4))
  const y = Math.max(work.y + 4, Math.min(cursor.y + 8, work.y + work.height - POPUP_HEIGHT - 4))
  win.setPosition(Math.round(x), Math.round(y), false)
}

/** Bring the main window to the front; returns it (or null if there is none). */
function raiseMain(): BrowserWindow | null {
  const main = deps?.getMainWindow()
  if (!main || main.isDestroyed()) return null
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
  if (process.platform === 'darwin') app.dock?.show()
  return main
}

function stopFade(): void {
  if (fadeTimer) {
    clearInterval(fadeTimer)
    fadeTimer = null
  }
}

/** Tween the window opacity to `to`, invoking `onDone` when it lands. */
function animateOpacity(win: BrowserWindow, to: number, onDone?: () => void): void {
  stopFade()
  const from = win.getOpacity()
  const start = Date.now()
  fadeTimer = setInterval(() => {
    if (win.isDestroyed()) {
      stopFade()
      return
    }
    const t = Math.min(1, (Date.now() - start) / FADE_MS)
    win.setOpacity(from + (to - from) * t)
    if (t >= 1) {
      stopFade()
      onDone?.()
    }
  }, FADE_TICK_MS)
}

function showPopup(win: BrowserWindow): void {
  win.setOpacity(0)
  positionPopup(win)
  win.show()
  win.focus()
  animateOpacity(win, 1)
}

function fadeOutPopup(win: BrowserWindow): void {
  lastHideAt = Date.now()
  animateOpacity(win, 0, () => {
    if (win.isDestroyed()) return
    win.hide()
    win.setOpacity(1)
  })
}

function toggle(): void {
  if (!popup || popup.isDestroyed()) {
    popup = buildPopup()
  }
  if (popup.isVisible()) {
    fadeOutPopup(popup)
    return
  }
  // Just dismissed via blur (e.g. the click that lost focus) — stay closed.
  if (Date.now() - lastHideAt < REOPEN_GUARD_MS) return
  showPopup(popup)
}

export const trayService = {
  /** Create the tray + popup window. Idempotent — safe to call on every window open. */
  create(d: TrayDeps): void {
    deps = d
    if (tray && !tray.isDestroyed()) return

    tray = new Tray(placeholderImage())
    tray.setToolTip('Cinna — agent status')
    tray.on('click', () => toggle())
    tray.on('right-click', () => toggle())
    popup = buildPopup()
    logger.info('tray created')
  },

  /** Swap the menu-bar icon (and tooltip) using a PNG data URL rendered by the renderer. */
  setImage(dataUrl: string, tooltip: string): void {
    if (!tray || tray.isDestroyed()) return
    const comma = dataUrl.indexOf(',')
    if (comma === -1) return
    try {
      const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64')
      const img = nativeImage.createFromBuffer(buf, { scaleFactor: 2 })
      img.setTemplateImage(false)
      tray.setImage(img.isEmpty() ? placeholderImage() : img)
      tray.setToolTip(tooltip)
    } catch (err) {
      logger.warn('tray setImage failed', { error: String(err) })
    }
  },

  hidePopup(): void {
    if (popup && !popup.isDestroyed() && popup.isVisible()) fadeOutPopup(popup)
  },

  /** Hide the popup, raise the main window, and ask it to open a chat with `agentId`. */
  startChat(agentId: string): void {
    this.hidePopup()
    const main = raiseMain()
    main?.webContents.send('tray:focus-chat', { agentId })
  },

  /** Hide the popup, raise the main window, and open `agentId`'s status detail there. */
  openStatus(agentId: string): void {
    this.hidePopup()
    const main = raiseMain()
    main?.webContents.send('tray:focus-status', { agentId })
  },

  destroy(): void {
    stopFade()
    if (popup && !popup.isDestroyed()) popup.destroy()
    popup = null
    if (tray && !tray.isDestroyed()) tray.destroy()
    tray = null
    logger.info('tray destroyed')
  }
}
