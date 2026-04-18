import { BrowserWindow } from 'electron'
import { getMainWindow } from '../index'

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

const MAX_ENTRIES = 2000
const BROADCAST_CHANNEL = 'logger:entry'

let nextId = 1
const buffer: LogEntry[] = []

function getWindow(): BrowserWindow | null {
  try {
    return getMainWindow()
  } catch {
    return null
  }
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
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(BROADCAST_CHANNEL, entry)
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
