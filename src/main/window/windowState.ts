/**
 * Remembering where the main window was, across launches and Dock reopens.
 *
 * The state is a small JSON file in `userData`, not a row in `appSettings`:
 * that schema is shared with the renderer through the settings IPC, and the
 * renderer has no business with window bounds. `userData` is already pointed at
 * a throwaway folder for the E2E suite before anything runs, so tests never
 * read or write the developer's real window position.
 *
 * What is stored is always the window's *normal* bounds, so a window that was
 * maximized comes back maximized and still un-maximizes to a real size. Those
 * bounds are tracked here, from the window's frame while it is in its normal
 * state, rather than read from `getNormalBounds()`: once a maximized window has
 * been minimized, Electron on macOS reports the maximized frame as the normal
 * bounds until the next `unmaximize()`, and saving that would leave the user a
 * window that can never be made smaller than the screen.
 *
 * Fullscreen is deliberately not restored — launching straight into a macOS
 * fullscreen Space is disorienting — but a fullscreen window's normal bounds are
 * still saved.
 *
 * Every read and write is best-effort. A failure is logged and the window opens
 * at the defaults; nothing here may throw into the window lifecycle.
 */

import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger/logger'

const logger = createLogger('window-state')

const STATE_FILE_NAME = 'window-state.json'

export const DEFAULT_WINDOW_WIDTH = 1200
export const DEFAULT_WINDOW_HEIGHT = 800
export const MIN_WINDOW_WIDTH = 800
export const MIN_WINDOW_HEIGHT = 600

/** The top strip of the window that holds the traffic lights and is dragged to move it. */
const TITLE_BAR_STRIP_HEIGHT = 40
/** How much of that strip must be on a display for the user to grab it and drag the window back. */
const MIN_VISIBLE_TITLE_BAR_WIDTH = 100
const MIN_VISIBLE_TITLE_BAR_HEIGHT = 20

/** A drag or resize fires these events continuously; one write once it settles is enough. */
const SAVE_DEBOUNCE_MS = 500

export interface SavedWindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

export interface ResolvedWindowState {
  width: number
  height: number
  /** Absent when the saved position is unusable — Electron then centers the window. */
  x?: number
  y?: number
  isMaximized: boolean
}

const DEFAULT_STATE: ResolvedWindowState = {
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
  isMaximized: false
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSavedWindowState(value: unknown): value is SavedWindowState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    isFiniteNumber(v.x) &&
    isFiniteNumber(v.y) &&
    isFiniteNumber(v.width) &&
    isFiniteNumber(v.height) &&
    typeof v.isMaximized === 'boolean'
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function overlap(start: number, length: number, otherStart: number, otherLength: number): number {
  return Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart)
}

/**
 * The area of the window's title-bar strip on `workArea`, or 0 when too little
 * of it is there to grab.
 */
function titleBarArea(x: number, y: number, width: number, workArea: Rectangle): number {
  const across = overlap(x, width, workArea.x, workArea.width)
  const down = overlap(y, TITLE_BAR_STRIP_HEIGHT, workArea.y, workArea.height)
  if (across < MIN_VISIBLE_TITLE_BAR_WIDTH || down < MIN_VISIBLE_TITLE_BAR_HEIGHT) return 0
  return across * down
}

/**
 * Turn whatever was on disk into bounds that are safe to open a window with.
 *
 * Pure and Electron-free so it can be unit-tested: the caller passes the
 * displays in. Anything that is not a complete, well-typed record opens at the
 * defaults.
 *
 * The window belongs to the display most of its title bar lands on, and its
 * size is clamped to that display's work area — so a large window on a large
 * external monitor keeps its size. If no display holds enough of the title bar
 * to drag the window by (an unplugged monitor, a changed arrangement), or
 * shrinking the window to fit pulls its title bar off that display, the position
 * is dropped, Electron centers the window, and the size is clamped to the
 * primary display instead.
 */
export function resolveWindowBounds(
  saved: unknown,
  displays: ReadonlyArray<{ workArea: Rectangle }>,
  primaryWorkArea: Rectangle
): ResolvedWindowState {
  if (!isSavedWindowState(saved)) return { ...DEFAULT_STATE }

  const x = Math.round(saved.x)
  const y = Math.round(saved.y)
  const isMaximized = saved.isMaximized
  const clampTo = (workArea: Rectangle): { width: number; height: number } => ({
    width: Math.round(clamp(saved.width, MIN_WINDOW_WIDTH, workArea.width)),
    height: Math.round(clamp(saved.height, MIN_WINDOW_HEIGHT, workArea.height))
  })

  const unclampedWidth = Math.round(Math.max(saved.width, MIN_WINDOW_WIDTH))
  let home: Rectangle | null = null
  let homeArea = 0
  for (const { workArea } of displays) {
    const area = titleBarArea(x, y, unclampedWidth, workArea)
    if (area > homeArea) {
      home = workArea
      homeArea = area
    }
  }

  if (home) {
    const size = clampTo(home)
    if (titleBarArea(x, y, size.width, home) > 0) return { ...size, x, y, isMaximized }
  }
  return { ...clampTo(primaryWorkArea), isMaximized }
}

function statePath(): string {
  return join(app.getPath('userData'), STATE_FILE_NAME)
}

/**
 * Read the saved state and resolve it against the displays attached now.
 *
 * Needs `screen`, so only call it after the app is ready.
 */
export function loadWindowState(): ResolvedWindowState {
  let saved: unknown
  try {
    saved = JSON.parse(readFileSync(statePath(), 'utf-8'))
  } catch (err) {
    // No file is the first launch, not a problem.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('window state unreadable, using defaults', err)
    }
    return { ...DEFAULT_STATE }
  }
  try {
    return resolveWindowBounds(saved, screen.getAllDisplays(), screen.getPrimaryDisplay().workArea)
  } catch (err) {
    logger.warn('window state not applied, using defaults', err)
    return { ...DEFAULT_STATE }
  }
}

/** Temp file in the same directory, then rename: a crash mid-write never leaves half a file. */
function writeWindowState(state: SavedWindowState): void {
  const path = statePath()
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(state))
    renameSync(temp, path)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      /* the temp file may never have been created */
    }
    logger.warn('window state not saved', err)
  }
}

/**
 * Save the window's normal bounds whenever they change, and once more on close.
 *
 * Attach it before the window is maximized, so the first bounds it records are
 * the normal ones. Changes are debounced; `close` saves synchronously because by
 * `closed` the window has no bounds left to read.
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  // The last frame seen while the window was neither maximized, minimized nor
  // fullscreen — what it returns to when un-maximized.
  let normalBounds: Rectangle | null = null
  // Neither minimized nor fullscreen says anything about whether the window the
  // user comes back to is maximized, so the flag is only read outside both.
  let maximized = false

  // Bounds are only taken once the window has settled — from the debounced save
  // or `close`. The macOS zoom animation fires dozens of `resize` events whose
  // frames grow towards the maximized one while `isMaximized()` is still false,
  // and recording those would save a near-maximized frame as the normal size.
  const observe = (settled: boolean): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    maximized = win.isMaximized()
    if (settled && !maximized) normalBounds = win.getBounds()
  }

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const save = (): void => {
    clearTimer()
    try {
      if (win.isDestroyed()) return
      observe(true)
      if (!normalBounds) return
      const { x, y, width, height } = normalBounds
      writeWindowState({ x, y, width, height, isMaximized: maximized })
    } catch (err) {
      logger.warn('window state not saved', err)
    }
  }

  const scheduleSave = (): void => {
    try {
      observe(false)
    } catch {
      /* read again when the save runs */
    }
    clearTimer()
    timer = setTimeout(save, SAVE_DEBOUNCE_MS)
  }

  try {
    normalBounds = win.getBounds()
    observe(false)
  } catch {
    /* the first resize or move records them */
  }

  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)
  win.on('close', save)
  win.on('closed', clearTimer)
}
