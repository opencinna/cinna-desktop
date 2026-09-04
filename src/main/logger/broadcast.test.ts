import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { installLogBroadcast } from './broadcast'
import { clearLogEntries, createLogger, setLogSink } from './logger'

/**
 * The renderer half of logging, which used to live inside `push()` in
 * `logger.ts` and was therefore untestable without standing up Electron and the
 * main-process entry point. Nothing pinned it: the `logger:entry` channel name,
 * the destroyed-window guard and the null-window guard were all load-bearing
 * and all unasserted.
 *
 * Note there is no `vi.mock('electron')` here either. `broadcast.ts` imports
 * `BrowserWindow` as a *type only*, so it is erased at compile time and this
 * file needs nothing but a duck-typed stand-in.
 */

function fakeWindow(): { win: BrowserWindow; sent: Array<[string, unknown]>; destroy: () => void } {
  const sent: Array<[string, unknown]> = []
  let destroyed = false
  const win = {
    isDestroyed: () => destroyed,
    webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) }
  } as unknown as BrowserWindow
  return { win, sent, destroy: () => { destroyed = true } }
}

beforeEach(() => {
  clearLogEntries()
  setLogSink(null)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  setLogSink(null)
  clearLogEntries()
  vi.restoreAllMocks()
})

describe('installLogBroadcast', () => {
  it('sends each entry to the live window on the logger:entry channel', () => {
    const { win, sent } = fakeWindow()
    installLogBroadcast(() => win)

    createLogger('mcp').info('connected', { server: 'files' })

    expect(sent).toHaveLength(1)
    const [channel, payload] = sent[0]
    expect(channel).toBe('logger:entry')
    expect(payload).toMatchObject({ scope: 'mcp', level: 'info', message: 'connected' })
  })

  it('asks for the window on every entry rather than capturing one', () => {
    // Installed at startup, before `createWindow` has run and again after every
    // reopen, so a captured window would broadcast to the first window only —
    // and, on macOS, to a closed one forever after.
    let current: BrowserWindow | null = null
    installLogBroadcast(() => current)

    createLogger('boot').info('no window yet')
    const { win, sent } = fakeWindow()
    current = win
    createLogger('boot').info('window now')

    expect(sent.map(([, p]) => (p as { message: string }).message)).toEqual(['window now'])
  })

  it('does not send to a destroyed window', () => {
    const { win, sent, destroy } = fakeWindow()
    installLogBroadcast(() => win)

    createLogger('boot').info('alive')
    destroy()
    createLogger('boot').info('after teardown')

    expect(sent.map(([, p]) => (p as { message: string }).message)).toEqual(['alive'])
  })
})
