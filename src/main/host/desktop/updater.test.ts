import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  focusMainWindow: vi.fn(),
  ensureMainWindow: vi.fn(),
  sent: [] as unknown[]
}))

vi.mock('electron', () => ({
  app: { on: vi.fn(), getVersion: () => '0.5.2' },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_: string, s: unknown) => h.sent.push(s) } }]
  },
  dialog: { showMessageBox: h.showMessageBox }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../window/focus', () => ({
  focusMainWindow: h.focusMainWindow,
  ensureMainWindow: h.ensureMainWindow
}))

const autoUpdater = Object.assign(new EventEmitter(), {
  checkForUpdates: vi.fn(async () => null),
  quitAndInstall: vi.fn()
})
vi.mock('electron-updater', () => ({ default: { autoUpdater } }))

const { initAutoUpdater, getUpdaterState, promptInstallCurrent, checkForUpdatesManual } = await import('./updater')

function downloaded(): void {
  initAutoUpdater()
  autoUpdater.emit('update-downloaded', { version: '0.5.3' })
}

function fakeWindow(visible: boolean, minimized = false): Record<string, () => boolean> {
  return { isVisible: () => visible, isMinimized: () => minimized, isDestroyed: () => false }
}

beforeEach(() => {
  h.showMessageBox.mockReset().mockResolvedValue({ response: 1, checkboxChecked: false })
  h.focusMainWindow.mockReset()
  h.ensureMainWindow.mockReset()
  autoUpdater.quitAndInstall.mockReset()
  h.sent.length = 0
})

describe('updater', () => {
  it('records a finished download without opening a dialog', () => {
    downloaded()
    expect(getUpdaterState()).toEqual({ phase: 'downloaded', version: '0.5.3' })
    expect(h.sent).toContainEqual({ phase: 'downloaded', version: '0.5.3' })
    expect(h.showMessageBox).not.toHaveBeenCalled()
  })

  it('attaches the install prompt to a visible main window as a sheet', async () => {
    downloaded()
    const win = fakeWindow(true)
    h.ensureMainWindow.mockResolvedValue(win)
    h.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await promptInstallCurrent()
    expect(h.showMessageBox).toHaveBeenCalledWith(win, expect.objectContaining({ title: 'Update ready' }))
    expect(h.focusMainWindow).not.toHaveBeenCalled()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('brings a hidden or minimized window up before attaching to it', async () => {
    downloaded()
    for (const win of [fakeWindow(false), fakeWindow(true, true)]) {
      h.focusMainWindow.mockReset()
      h.ensureMainWindow.mockResolvedValue(win)
      await promptInstallCurrent()
      expect(h.focusMainWindow).toHaveBeenCalledTimes(1)
      expect(h.showMessageBox).toHaveBeenLastCalledWith(win, expect.any(Object))
    }
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('falls back to a parentless box only when no window can be opened', async () => {
    downloaded()
    h.ensureMainWindow.mockResolvedValue(null)
    await promptInstallCurrent()
    expect(h.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ title: 'Update ready' }))
  })

  it('attaches the manual check dialogs to the window too', async () => {
    downloaded()
    const win = fakeWindow(true)
    h.ensureMainWindow.mockResolvedValue(win)
    await checkForUpdatesManual()
    // Already downloaded, so the manual check offers the install.
    expect(h.showMessageBox).toHaveBeenCalledWith(win, expect.objectContaining({ title: 'Update ready' }))
  })
})
