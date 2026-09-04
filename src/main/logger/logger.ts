/**
 * The log buffer and the log formatting, and nothing else.
 *
 * This module has **no imports**, by rule. It used to import `BrowserWindow`
 * from electron and `getMainWindow` from `../index` so that `push` could
 * broadcast to the renderer itself, which meant every module that logged —
 * which is most of them — dragged the whole main-process entry point and
 * Electron into its graph. Tests of pure functions three layers away had to
 * stub the logger just to *load*, and a file that failed to load showed up as
 * a smaller test count rather than as a failure.
 *
 * The broadcast is now a sink that `logger/broadcast.ts` installs from
 * `index.ts` at startup. Keep this file importless: an import here is paid for
 * by every caller.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  timestamp: number
  level: LogLevel
  scope: string
  source: 'main' | 'renderer'
  message: string
  data?: unknown
}

export interface ScopedLogger {
  debug: (message: string, data?: unknown) => void
  info: (message: string, data?: unknown) => void
  warn: (message: string, data?: unknown) => void
  error: (message: string, data?: unknown) => void
}

/** Somewhere to send each entry as it is logged, beyond the buffer and the console. */
export type LogSink = (entry: LogEntry) => void

const MAX_ENTRIES = 2000

let nextId = 1
const buffer: LogEntry[] = []
let sink: LogSink | null = null

/**
 * Install (or, with `null`, remove) the destination for live entries.
 *
 * `index.ts` installs the renderer broadcast at startup via
 * `logger/broadcast.ts`. Tests pass `null` to put it back.
 */
export function setLogSink(next: LogSink | null): void {
  sink = next
}

const SENSITIVE_KEY_RE = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|bearer|secret|token|cookie)/i
const REDACTED = '[REDACTED]'

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t !== 'object') return value
  if (seen.has(value as object)) return '[Circular]'
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen))
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k) && v !== null && v !== undefined && v !== '') {
      out[k] = REDACTED
    } else {
      out[k] = redact(v, seen)
    }
  }
  return out
}

function serializeData(data: unknown): unknown {
  if (data === undefined || data === null) return data
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack }
  }
  try {
    const scrubbed = redact(data, new WeakSet())
    return JSON.parse(JSON.stringify(scrubbed))
  } catch {
    return String(data)
  }
}

function push(entry: LogEntry): void {
  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) buffer.shift()

  // No sink yet is the normal state, not an error: modules log from their own
  // module top level, so the first entries are written while `index.ts` is
  // still evaluating and long before it installs the broadcast. They are
  // buffered and console-written like any other, and the renderer collects
  // them with `logger:get-all` when it mounts. Nothing is lost, nothing throws.
  //
  // (This replaces a `try { getMainWindow() } catch` that guarded a different
  // hazard — the circular import meant that binding could still be in its
  // temporal dead zone when an early log fired. That failure mode is gone with
  // the import. The catch below is for a live sink that throws, e.g.
  // `webContents.send` racing window teardown: a module that merely logged
  // must never be taken down by the logger's delivery.)
  if (!sink) return
  try {
    sink(entry)
  } catch {
    // Delivery is best-effort; the entry is already buffered.
  }
}

export function logEntry(
  level: LogLevel,
  scope: string,
  source: 'main' | 'renderer',
  message: string,
  data?: unknown
): void {
  const entry: LogEntry = {
    id: nextId++,
    timestamp: Date.now(),
    level,
    scope,
    source,
    message,
    data: serializeData(data)
  }
  push(entry)

  const prefix = `[${scope}]`
  const fn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'debug'
          ? console.debug
          : console.log
  if (data !== undefined) fn(prefix, message, data)
  else fn(prefix, message)
}

export function createLogger(scope: string): ScopedLogger {
  return {
    debug: (message, data) => logEntry('debug', scope, 'main', message, data),
    info: (message, data) => logEntry('info', scope, 'main', message, data),
    warn: (message, data) => logEntry('warn', scope, 'main', message, data),
    error: (message, data) => logEntry('error', scope, 'main', message, data)
  }
}

export function getLogEntries(): LogEntry[] {
  return buffer.slice()
}

export function clearLogEntries(): void {
  buffer.length = 0
}
