import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import {
  clearLogEntries,
  createLogger,
  getLogEntries,
  logEntry,
  setLogSink,
  type LogEntry
} from './logger'

/**
 * **The static import above is half the point of this file, and the first test
 * is the other half. They catch different things — measured, not assumed.**
 *
 * `logger.ts` used to open with `import { BrowserWindow } from 'electron'` and
 * `import { getMainWindow } from '../index'`, so importing it pulled in the
 * whole main-process entry point, which calls `app.on(...)` at its own module
 * top level. Under vitest `electron` resolves to a path string, `app` is
 * undefined, and that throws. Re-adding the `../index` import *and a use of it*
 * was tried: this file and `broadcast.test.ts` both stop loading, and the run
 * reports `Tests  no tests`. So the plain static import above is a real guard —
 * but a bad one to learn from, because a file that fails to *load* shows up as
 * a missing test count rather than as a red test, and this project has already
 * lost time to exactly that tell.
 *
 * Worse, the static import does not catch the case at all when the offending
 * import is unused or harmless: esbuild elides an import whose bindings are
 * never referenced, so `import { getMainWindow } from '../index'` on its own
 * disappears and everything here still passes. That is what the first test
 * below is for, and it is not redundant with the import — it is the only thing
 * that fails when someone adds an import that happens to load.
 *
 * No `vi.mock('electron')` and no `vi.mock('../index')` appear anywhere in this
 * file, deliberately. Do not add one to "fix" a failure here: the failure would
 * be the finding.
 */

const LOGGER_SOURCE = readFileSync(new URL('./logger.ts', import.meta.url), 'utf-8')

beforeEach(() => {
  clearLogEntries()
  setLogSink(null)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'debug').mockImplementation(() => undefined)
})

afterEach(() => {
  setLogSink(null)
  clearLogEntries()
  vi.restoreAllMocks()
})

describe('logger isolation', () => {
  it('has no imports at all, so logging costs a module nothing', () => {
    const offenders = LOGGER_SOURCE.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /^import\b/.test(line) || /\brequire\(/.test(line) || /\bimport\(/.test(line))
      .map(({ line, n }) => `logger.ts:${n}: ${line}`)

    expect(offenders).toEqual([])
  })
})

describe('log sink', () => {
  it('delivers entries logged after the sink is installed', () => {
    const seen: LogEntry[] = []
    setLogSink((entry) => seen.push(entry))

    createLogger('sync').warn('folder dependency dropped', { jobId: 'job-1' })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      level: 'warn',
      scope: 'sync',
      source: 'main',
      message: 'folder dependency dropped',
      data: { jobId: 'job-1' }
    })
  })

  it('buffers entries logged before any sink exists, and throws for none of them', () => {
    // The property the old `try { getMainWindow() } catch` was protecting:
    // modules log from their own module top level, long before `index.ts` gets
    // as far as installing the broadcast. Those entries must survive to reach
    // the renderer through `logger:get-all`.
    expect(() => createLogger('boot').info('before the window exists')).not.toThrow()

    const seen: LogEntry[] = []
    setLogSink((entry) => seen.push(entry))
    createLogger('boot').info('after')

    expect(seen.map((e) => e.message)).toEqual(['after'])
    expect(getLogEntries().map((e) => e.message)).toEqual([
      'before the window exists',
      'after'
    ])
  })

  it('stops delivering once the sink is removed', () => {
    const seen: LogEntry[] = []
    setLogSink((entry) => seen.push(entry))
    createLogger('a').info('delivered')

    setLogSink(null)
    createLogger('a').info('not delivered')

    expect(seen.map((e) => e.message)).toEqual(['delivered'])
    expect(getLogEntries()).toHaveLength(2)
  })

  it('does not let a throwing sink reach the caller that was only logging', () => {
    // `webContents.send` can race window teardown. A module that logged must
    // not die of it, and the entry is already buffered by then either way.
    setLogSink(() => {
      throw new Error('webContents destroyed')
    })

    expect(() => createLogger('mcp').error('connect failed')).not.toThrow()
    expect(getLogEntries()).toHaveLength(1)
  })
})

describe('buffer and formatting', () => {
  it('keeps the newest 2000 entries and drops the oldest', () => {
    for (let i = 0; i < 2001; i++) logEntry('info', 'bulk', 'main', `entry-${i}`)

    const entries = getLogEntries()
    expect(entries).toHaveLength(2000)
    expect(entries[0].message).toBe('entry-1')
    expect(entries[1999].message).toBe('entry-2000')
  })

  it('redacts credential-shaped keys at any depth before the entry is stored', () => {
    logEntry('info', 'auth', 'main', 'token refreshed', {
      provider: 'anthropic',
      creds: { apiKey: 'sk-ant-real', refresh_token: 'rt-real', expiresIn: 3600 }
    })

    expect(getLogEntries()[0].data).toEqual({
      provider: 'anthropic',
      creds: { apiKey: '[REDACTED]', refresh_token: '[REDACTED]', expiresIn: 3600 }
    })
  })

  it('writes to the console channel matching the level', () => {
    logEntry('warn', 'sync', 'main', 'drifted')

    expect(console.warn).toHaveBeenCalledWith('[sync]', 'drifted')
    expect(console.log).not.toHaveBeenCalled()
  })
})
