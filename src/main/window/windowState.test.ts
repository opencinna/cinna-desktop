import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, Rectangle } from 'electron'

/**
 * The resolver is pure and gets most of the cases. Loading, saving and tracking
 * run over a real temp `userData` with a fake window — the file on disk is the
 * thing that has to survive a relaunch, so that is what the assertions read.
 */

const holder = vi.hoisted(() => ({
  userData: '',
  displays: [] as Array<{ workArea: Rectangle }>
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected path request: ${name}`)
      return holder.userData
    }
  },
  screen: {
    getAllDisplays: () => holder.displays,
    getPrimaryDisplay: () => holder.displays[0]
  }
}))

const warnings = vi.hoisted(() => ({ entries: [] as string[] }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (message: string) => warnings.entries.push(message),
    error: () => {}
  })
}))

const { resolveWindowBounds, loadWindowState, trackWindowState } = await import('./windowState')

const PRIMARY: Rectangle = { x: 0, y: 25, width: 1920, height: 1055 }
const SECONDARY: Rectangle = { x: 1920, y: 0, width: 2560, height: 1440 }
// A laptop with a larger external monitor to its right, and one to its left.
const LAPTOP: Rectangle = { x: 0, y: 25, width: 1666, height: 1054 }
const EXTERNAL_RIGHT: Rectangle = { x: 1666, y: 0, width: 2560, height: 1415 }
const EXTERNAL_LEFT: Rectangle = { x: -2560, y: 0, width: 2560, height: 1415 }
const DEFAULTS = { width: 1200, height: 800, isMaximized: false }

function saved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { x: 100, y: 100, width: 1000, height: 700, isMaximized: false, ...overrides }
}

describe('resolveWindowBounds', () => {
  const single = [{ workArea: PRIMARY }]

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'window'],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['a wrong-typed width', saved({ width: '1000' })],
    ['a missing x', saved({ x: undefined })],
    ['a non-finite height', saved({ height: Number.POSITIVE_INFINITY })],
    ['a NaN y', saved({ y: Number.NaN })],
    ['a non-boolean isMaximized', saved({ isMaximized: 'yes' })]
  ])('opens at the defaults, centered, when the saved state is %s', (_label, value) => {
    const resolved = resolveWindowBounds(value, single, PRIMARY)
    expect(resolved).toEqual(DEFAULTS)
    expect(resolved).not.toHaveProperty('x')
    expect(resolved).not.toHaveProperty('y')
  })

  it('keeps a saved size and position that are on screen', () => {
    expect(resolveWindowBounds(saved(), single, PRIMARY)).toEqual({
      x: 100,
      y: 100,
      width: 1000,
      height: 700,
      isMaximized: false
    })
  })

  it('raises a size below the minimum to 800 × 600', () => {
    const resolved = resolveWindowBounds(saved({ width: 300, height: 200 }), single, PRIMARY)
    expect(resolved).toMatchObject({ width: 800, height: 600 })
  })

  it('caps a size larger than the primary work area to that work area', () => {
    const resolved = resolveWindowBounds(
      saved({ x: 0, y: 25, width: 5000, height: 3000 }),
      single,
      PRIMARY
    )
    expect(resolved).toMatchObject({ width: 1920, height: 1055, x: 0, y: 25 })
  })

  it('drops a position on a display that is no longer attached', () => {
    const resolved = resolveWindowBounds(saved({ x: 2200, y: 200 }), single, PRIMARY)
    expect(resolved).toEqual({ width: 1000, height: 700, isMaximized: false })
  })

  it('drops a position whose title bar is above or below every display', () => {
    expect(resolveWindowBounds(saved({ y: -500 }), single, PRIMARY)).not.toHaveProperty('x')
    expect(resolveWindowBounds(saved({ y: 1070 }), single, PRIMARY)).not.toHaveProperty('y')
  })

  it('drops a position where too little of the title bar is on screen to drag it back', () => {
    // 50px of a 1000px-wide window left on the right edge of the display.
    expect(resolveWindowBounds(saved({ x: 1870 }), single, PRIMARY)).not.toHaveProperty('x')
    // 150px left: enough to grab.
    expect(resolveWindowBounds(saved({ x: 1770 }), single, PRIMARY)).toMatchObject({ x: 1770 })
  })

  it('keeps a position on a secondary display', () => {
    const resolved = resolveWindowBounds(
      saved({ x: 2400, y: 300 }),
      [{ workArea: PRIMARY }, { workArea: SECONDARY }],
      PRIMARY
    )
    expect(resolved).toEqual({ x: 2400, y: 300, width: 1000, height: 700, isMaximized: false })
  })

  describe('with a larger secondary display', () => {
    const laptopAndExternal = [{ workArea: LAPTOP }, { workArea: EXTERNAL_RIGHT }]

    it('keeps the size of a large window on the larger display', () => {
      const resolved = resolveWindowBounds(
        saved({ x: 1800, y: 50, width: 2200, height: 1300 }),
        laptopAndExternal,
        LAPTOP
      )
      expect(resolved).toEqual({ x: 1800, y: 50, width: 2200, height: 1300, isMaximized: false })
    })

    it('sizes a window straddling both displays by the one holding most of its title bar', () => {
      // 466px of the title bar on the laptop, 1734px on the external monitor.
      const resolved = resolveWindowBounds(
        saved({ x: 1200, y: 50, width: 2200, height: 1300 }),
        laptopAndExternal,
        LAPTOP
      )
      expect(resolved).toEqual({ x: 1200, y: 50, width: 2200, height: 1300, isMaximized: false })
    })

    it('caps a window larger than the external display to that display', () => {
      const resolved = resolveWindowBounds(
        saved({ x: 1700, y: 0, width: 3000, height: 2000 }),
        laptopAndExternal,
        LAPTOP
      )
      expect(resolved).toEqual({ x: 1700, y: 0, width: 2560, height: 1415, isMaximized: false })
    })

    it('still caps an oversized window that is mostly on the primary display to the primary', () => {
      const resolved = resolveWindowBounds(
        saved({ x: 0, y: 25, width: 2200, height: 1300 }),
        laptopAndExternal,
        LAPTOP
      )
      expect(resolved).toEqual({ x: 0, y: 25, width: 1666, height: 1054, isMaximized: false })
    })

    it('centers on the primary when shrinking the window pulls its title bar off its display', () => {
      // Only the right-most 200px of a 2800px window is on the left-hand
      // monitor; cut down to that monitor's 2560px, none of it would be.
      const resolved = resolveWindowBounds(
        saved({ x: -5160, y: 100, width: 2800, height: 1300 }),
        [{ workArea: LAPTOP }, { workArea: EXTERNAL_LEFT }],
        LAPTOP
      )
      expect(resolved).toEqual({ width: 1666, height: 1054, isMaximized: false })
    })
  })

  it('passes isMaximized through, with or without a usable position', () => {
    expect(resolveWindowBounds(saved({ isMaximized: true }), single, PRIMARY).isMaximized).toBe(true)
    expect(
      resolveWindowBounds(saved({ x: 9000, isMaximized: true }), single, PRIMARY).isMaximized
    ).toBe(true)
  })
})

/**
 * Enough of a `BrowserWindow` for the tracker. `bounds` is the frame as it is
 * right now; `getNormalBounds` reproduces what Electron on macOS does once a
 * maximized window has been minimized — it answers with the current frame —
 * so a tracker that trusted it would save the maximized frame.
 */
class FakeWindow extends EventEmitter {
  bounds = { x: 10, y: 40, width: 1100, height: 750 }
  maximized = false
  minimized = false
  fullScreen = false
  destroyed = false
  getBounds(): Rectangle {
    return { ...this.bounds }
  }
  getNormalBounds(): Rectangle {
    return { ...this.bounds }
  }
  isMaximized(): boolean {
    return this.maximized
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isFullScreen(): boolean {
    return this.fullScreen
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

describe('loading and saving', () => {
  let stateRoot = ''
  let stateFile = ''

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'cinna-window-state-'))
    holder.userData = stateRoot
    holder.displays = [{ workArea: PRIMARY }]
    stateFile = join(stateRoot, 'window-state.json')
    warnings.entries = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(stateRoot, { recursive: true, force: true })
  })

  function track(): FakeWindow {
    const win = new FakeWindow()
    trackWindowState(win as unknown as BrowserWindow)
    return win
  }

  function savedState(): unknown {
    return JSON.parse(readFileSync(stateFile, 'utf-8'))
  }

  function maximize(win: FakeWindow): void {
    win.maximized = true
    win.bounds = { ...PRIMARY }
    win.emit('maximize')
    win.emit('resize')
  }

  it('opens at the defaults on first launch without a warning', () => {
    expect(loadWindowState()).toEqual(DEFAULTS)
    expect(warnings.entries).toEqual([])
  })

  it('opens at the defaults and warns when the file is corrupt', () => {
    writeFileSync(stateFile, '{ not json')
    expect(loadWindowState()).toEqual(DEFAULTS)
    expect(warnings.entries).toHaveLength(1)
  })

  it('saves once a burst of resizes settles, and the next launch reads it back', () => {
    const win = track()
    win.emit('resize')
    win.bounds = { x: 200, y: 150, width: 1300, height: 900 }
    win.emit('move')
    vi.advanceTimersByTime(499)
    expect(existsSync(stateFile)).toBe(false)

    vi.advanceTimersByTime(1)
    expect(savedState()).toEqual({ x: 200, y: 150, width: 1300, height: 900, isMaximized: false })
    // Written through a temp file that is gone once renamed into place.
    expect(readdirSync(stateRoot)).toEqual(['window-state.json'])
    expect(loadWindowState()).toEqual({ x: 200, y: 150, width: 1300, height: 900, isMaximized: false })
  })

  it('saves synchronously on close, and a pending save does not fire after closed', () => {
    const win = track()
    win.bounds = { x: 300, y: 300, width: 900, height: 650 }
    win.emit('resize')
    win.emit('close')
    expect(savedState()).toMatchObject({ x: 300, width: 900 })

    win.bounds = { x: 0, y: 0, width: 800, height: 600 }
    win.emit('move')
    win.emit('closed')
    vi.advanceTimersByTime(1000)
    expect(savedState()).toMatchObject({ x: 300, width: 900 })
  })

  it('stores the pre-maximize bounds and the maximized flag of a maximized window', () => {
    const win = track()
    maximize(win)
    win.emit('close')
    expect(savedState()).toEqual({ x: 10, y: 40, width: 1100, height: 750, isMaximized: true })
  })

  it('does not take a frame from the maximize animation as the normal bounds', () => {
    const win = track()
    // The macOS zoom animation: frames grow towards the maximized one while
    // `isMaximized()` still answers false, and only the last events say true.
    for (const step of [1, 2, 3, 4]) {
      win.bounds = { x: 10 - step, y: 40 - step, width: 1100 + step * 100, height: 750 + step * 50 }
      win.emit('resize')
    }
    maximize(win)
    win.emit('close')
    expect(savedState()).toEqual({ x: 10, y: 40, width: 1100, height: 750, isMaximized: true })
  })

  it('stores the pre-maximize bounds of a maximized window closed while minimized', () => {
    const win = track()
    maximize(win)
    win.minimized = true
    win.maximized = false
    win.emit('minimize')
    win.emit('resize')
    win.emit('close')
    expect(savedState()).toEqual({ x: 10, y: 40, width: 1100, height: 750, isMaximized: true })
  })

  it('stores the pre-maximize bounds of a maximized window minimized and restored', () => {
    const win = track()
    maximize(win)
    win.minimized = true
    win.maximized = false
    win.emit('minimize')
    win.emit('resize')
    win.minimized = false
    win.maximized = true
    win.emit('restore')
    win.emit('resize')
    win.emit('close')
    expect(savedState()).toEqual({ x: 10, y: 40, width: 1100, height: 750, isMaximized: true })
  })

  it('keeps the pre-fullscreen maximized flag while the window is fullscreen', () => {
    const win = track()
    win.maximized = false
    win.emit('resize')
    // Entering fullscreen may report the window as maximized; that is not what
    // the user comes back to.
    win.fullScreen = true
    win.maximized = true
    win.bounds = { ...PRIMARY }
    win.emit('resize')
    win.emit('close')
    expect(savedState()).toEqual({ x: 10, y: 40, width: 1100, height: 750, isMaximized: false })
  })

  it('ignores a destroyed window', () => {
    const win = track()
    win.destroyed = true
    win.emit('close')
    expect(existsSync(stateFile)).toBe(false)
    expect(warnings.entries).toEqual([])
  })

  it('logs instead of throwing when the file cannot be written', () => {
    const win = track()
    holder.userData = join(stateRoot, 'does-not-exist')
    expect(() => win.emit('close')).not.toThrow()
    expect(warnings.entries).toEqual(['window state not saved'])
  })
})
