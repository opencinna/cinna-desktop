/**
 * Small shared pieces: the error type every handler throws, stderr logging,
 * and the strict name patterns that keep caller strings out of paths.
 */
import { appendFileSync, renameSync, statSync } from 'node:fs'

/** Error codes vaultd returns in a JSON-RPC error's `data.code`. */
export type VaultdErrorCode = 'invalid' | 'bad_token' | 'not_found' | 'busy' | 'unavailable' | 'internal'

export class VaultdError extends Error {
  constructor(readonly code: VaultdErrorCode, message: string) {
    super(message)
  }
}

export const invalid = (message: string): VaultdError => new VaultdError('invalid', message)

type Level = 'debug' | 'info' | 'warn' | 'error'
let quiet = false

/** The guest's log file is a tmpfs file in RAM: it is rotated at this size, one older file kept. */
export const LOG_MAX_BYTES = 1024 * 1024

let logFile: { path: string; maxBytes: number; size: number } | null = null

/**
 * Write the log to `path` (the guest's `/run/vault/vaultd.log`) instead of
 * stderr: when the next line would take it past `maxBytes`, it becomes
 * `<path>.1` (replacing the one before) and a new file starts. Checked at
 * once too, so a vaultd that restarts in a loop does not grow it either.
 */
export function setLogFile(path: string | null, maxBytes = LOG_MAX_BYTES): void {
  if (path === null) {
    logFile = null
    return
  }
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    size = 0
  }
  logFile = { path, maxBytes, size }
  if (size >= maxBytes) rotate(logFile)
}

function rotate(file: { path: string; size: number }): void {
  try {
    renameSync(file.path, `${file.path}.1`)
  } catch {
    // Nothing to rotate, or it cannot be: the next append starts the file again.
  }
  file.size = 0
}

function writeLine(line: string): void {
  if (!logFile) {
    process.stderr.write(line)
    return
  }
  const bytes = Buffer.byteLength(line)
  if (logFile.size > 0 && logFile.size + bytes > logFile.maxBytes) rotate(logFile)
  try {
    appendFileSync(logFile.path, line, { mode: 0o600 })
    logFile.size += bytes
  } catch {
    process.stderr.write(line)
  }
}

/** Tests silence the log; production always writes to stderr. */
export function setQuiet(value: boolean): void {
  quiet = value
}

/**
 * One line per event, to stderr. Callers pass method names, stream ids,
 * codes and counts only — never chat content, prompts, secret values or
 * file contents.
 */
export function log(level: Level, message: string, fields?: Record<string, string | number | boolean | null>): void {
  if (quiet) return
  const tail = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ') : ''
  writeLine(`[vaultd] ${level} ${message}${tail}\n`)
}

// ---------------------------------------------------------------------------
// Validation

/** One path segment of a runtime version, file name or similar: no separators, no dot-only names. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/

export function segment(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SEGMENT.test(value) || value.includes('..')) {
    throw invalid(`Invalid ${what}.`)
  }
  return value
}

/** A relative path of SEGMENT parts joined by `/` (an executable inside an archive). */
export function relativeName(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > 512) throw invalid(`Invalid ${what}.`)
  const parts = value.split('/')
  for (const part of parts) segment(part, what)
  return value
}

/**
 * A path inside the agent folder as the caller wrote it. `''` and `'.'` are
 * the folder itself. Refuses absolute paths, `..`, empty segments other than
 * a trailing slash, NUL and backslashes. Returns the normalized relative path
 * (`''` for the root).
 */
export function agentPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || value.includes('\\')) {
    throw invalid('Invalid path.')
  }
  if (value.startsWith('/')) throw invalid('Invalid path.')
  const parts = value.split('/').filter((part, i, all) => !(part === '' && i === all.length - 1) && part !== '.')
  for (const part of parts) {
    if (part === '' || part === '..') throw invalid('Invalid path.')
  }
  return parts.join('/')
}

export const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/
export const KV_KEY = /^[A-Za-z0-9._:-]{1,256}$/

export function str(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string') throw invalid(`Missing ${key}.`)
  return value
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw invalid(`Invalid ${what}.`)
  return value as T
}
