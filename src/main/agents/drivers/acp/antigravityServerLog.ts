/**
 * Antigravity's own transcript, read for the provider errors it never sends.
 *
 * The pinned ACP server (1.4.5), when the Gemini API answers an error (a 503
 * "The model is currently unreachable.", a quota), sends nothing on the ACP
 * wire and keeps retrying. It does write the error into the session's
 * transcript, `<home>/antigravity-acp/brain/<ACP sessionId>/.system_generated/
 * logs/transcript_full.jsonl`, one JSON step per line:
 *
 *   {"step_index":2,"source":"SYSTEM","type":"ERROR_MESSAGE","status":"DONE",
 *    "error":"The model is currently unreachable.","error_code":503,
 *    "created_at":"2026-11-19T09:42:13Z"}
 *
 * Only `source: SYSTEM` + `type: ERROR_MESSAGE` is a provider error: a tool
 * denial is an ERROR_MESSAGE too, with `source: MODEL`. The file also holds the
 * user's prompts (USER_INPUT): nothing but an error's string and code ever
 * leaves this module.
 *
 * Read for a host Antigravity turn only (`acpDriver.ts`); a vault agent's
 * transcript lives inside the guest.
 */

import { open } from 'node:fs/promises'
import { join } from 'node:path'

/** How much of the transcript's end is read: a provider error is a recent step. */
export const ANTIGRAVITY_SERVER_LOG_TAIL_BYTES = 256 * 1024
/** The longest error string kept from a step (enough to classify a doubled transport chain). */
export const ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS = 1000
/** The longest error message a note shows. */
export const ANTIGRAVITY_PROVIDER_ERROR_SHOWN_CHARS = 200
/** `created_at` has second precision: an error up to this long before `since` still counts. */
const SINCE_SLACK_MS = 2_000

export interface AntigravityProviderError {
  /** The step's `step_index`: one error is one step. */
  stepIndex: number
  /** The error string, control characters stripped and capped. */
  message: string
  /** The provider's status (`error_code`), when it gave one. */
  code?: number
  /** `created_at`, epoch ms. */
  at: number
}

/**
 * Reads the provider errors of the session's current turn: those after the
 * transcript's last USER_INPUT step, or (no USER_INPUT in the tail) those
 * logged from `since` (epoch ms) on. Never throws.
 */
export type AntigravityServerLogReader = (home: string, sessionId: string, since: number) => Promise<AntigravityProviderError[]>

/** A plain ACP session id: the brain folder's name, nothing that could leave it. */
function plainSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId) && !sessionId.includes('..') && sessionId !== '.'
}

/** The transcript of `sessionId` under the Antigravity `home`, or null for an id that is not a plain id. */
export function antigravityTranscriptPath(home: string, sessionId: string): string | null {
  if (!plainSessionId(sessionId)) return null
  return join(home, 'antigravity-acp', 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl')
}

/** Control characters out, whitespace collapsed, capped. */
export function cleanProviderErrorMessage(text: string, max = ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

/** The last `maxBytes` of a file as text, a cut first line dropped; null when it cannot be read. */
async function readTail(path: string, maxBytes: number): Promise<string | null> {
  let handle: import('node:fs/promises').FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const start = size - length
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    const text = buffer.subarray(0, read).toString('utf8')
    if (start === 0) return text
    const firstBreak = text.indexOf('\n')
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * The provider errors in transcript `text` that belong to the turn prompted at
 * `since`. The transcript's own order decides first: only errors after the last
 * USER_INPUT step (of a USER_INPUT nothing but its index is read). With none in
 * the tail, or when the last one is dated before `since` (this turn's input is
 * not written yet, so it is an earlier turn's), `created_at` ≥ `since` − slack
 * decides as well.
 */
export function parseProviderErrors(text: string, since: number): AntigravityProviderError[] {
  const errors: AntigravityProviderError[] = []
  let lastInput: { index: number; at: number } | null = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let step: unknown
    try {
      step = JSON.parse(line)
    } catch {
      continue
    }
    if (!step || typeof step !== 'object') continue
    const s = step as Record<string, unknown>
    if (typeof s.step_index !== 'number' || !Number.isFinite(s.step_index)) continue
    const at = typeof s.created_at === 'string' ? Date.parse(s.created_at) : NaN
    if (s.type === 'USER_INPUT') {
      if (!lastInput || s.step_index > lastInput.index) lastInput = { index: s.step_index, at }
      continue
    }
    if (s.source !== 'SYSTEM' || s.type !== 'ERROR_MESSAGE') continue
    if (typeof s.error !== 'string') continue
    const message = cleanProviderErrorMessage(s.error)
    if (!message) continue
    const code = typeof s.error_code === 'number' && Number.isInteger(s.error_code) ? s.error_code : undefined
    errors.push({ stepIndex: s.step_index, message, ...(code !== undefined ? { code } : {}), at })
  }
  const fresh = (at: number): boolean => Number.isFinite(at) && at >= since - SINCE_SLACK_MS
  const ordered = lastInput !== null
  // An undated input is taken as this turn's: the order is all there is to go on.
  const inputIsThisTurns = lastInput !== null && (!Number.isFinite(lastInput.at) || fresh(lastInput.at))
  return errors.filter((error) => {
    if (ordered && error.stepIndex <= lastInput!.index) return false
    return inputIsThisTurns || fresh(error.at)
  })
}

/** The real reader: the transcript's tail, parsed. A missing file, a bad id or a partial line is no error. */
export const readAntigravityProviderErrors: AntigravityServerLogReader = async (home, sessionId, since) => {
  const path = antigravityTranscriptPath(home, sessionId)
  if (!path) return []
  const text = await readTail(path, ANTIGRAVITY_SERVER_LOG_TAIL_BYTES)
  return text ? parseProviderErrors(text, since) : []
}

/** What a provider error is, for the note: an HTTP status, a connection that failed, or anything else. */
export type ProviderErrorKind =
  | { kind: 'http'; code: number; message: string }
  | { kind: 'transport'; phrase: string }
  | { kind: 'other'; message: string }

const TRANSPORT = /dial tcp|i\/o timeout|no such host|connection refused|connection reset|tls handshake|doRequest: error sending request/i
const TRANSPORT_PHRASES: readonly [RegExp, string][] = [
  [/i\/o timeout|timed out|deadline exceeded/i, 'connection timed out'],
  [/no such host/i, 'host not found'],
  [/connection refused/i, 'connection refused'],
  [/connection reset/i, 'connection reset'],
  [/tls handshake/i, 'TLS handshake failed']
]

/** `X: X` (the server doubles its error chains) said once. */
function undoubled(message: string): string {
  if (message.length % 2 !== 0) return message
  const half = (message.length - 2) / 2
  return message.slice(half, half + 2) === ': ' && message.slice(0, half) === message.slice(half + 2) ? message.slice(0, half) : message
}

/** A message for the note: undoubled, capped, ending a sentence. */
function shown(message: string): string {
  const one = cleanProviderErrorMessage(undoubled(message), ANTIGRAVITY_PROVIDER_ERROR_SHOWN_CHARS)
  return /[.!?…]$/.test(one) ? one : `${one}.`
}

/** Sorts a provider error. Only a 400–599 code is an HTTP status; any other (the server's own `2`) is never shown. */
export function classifyProviderError(error: Pick<AntigravityProviderError, 'message' | 'code'>): ProviderErrorKind {
  if (error.code !== undefined && error.code >= 400 && error.code <= 599) return { kind: 'http', code: error.code, message: error.message }
  if (TRANSPORT.test(error.message)) {
    const phrase = TRANSPORT_PHRASES.find(([pattern]) => pattern.test(error.message))?.[1] ?? 'network error'
    return { kind: 'transport', phrase }
  }
  return { kind: 'other', message: error.message }
}

/**
 * The transcript note for one provider error. A transport failure never shows
 * its raw chain (the URL, the address): only a phrase.
 */
export function providerErrorNotice(error: Pick<AntigravityProviderError, 'message' | 'code'>): string {
  const kind = classifyProviderError(error)
  switch (kind.kind) {
    case 'http':
      return `Gemini answered an error (${kind.code}): ${shown(kind.message)}`
    case 'transport':
      return `Antigravity could not reach Gemini (${kind.phrase}).`
    case 'other':
      return `Antigravity reported an error from Gemini: ${shown(kind.message)}`
  }
}

/** Two steps saying the same error (each server retry is a new step): one note per turn. */
export function providerErrorKey(error: Pick<AntigravityProviderError, 'message' | 'code'>): string {
  return `${error.code ?? ''}|${undoubled(error.message).toLowerCase().replace(/\s+/g, ' ').trim()}`
}

/** How often a silent host Antigravity turn's transcript is read. */
export const ANTIGRAVITY_SERVER_LOG_POLL_MS = 5_000

export interface ProviderErrorWatch {
  /** The turn's first prompt is on the wire: polling starts. Only the first call counts. */
  start(): void
  /** Anything arrived for the session: the watch is over. */
  heard(): void
  /** The turn is over, or is being stopped; nothing is reported after this. */
  stop(): void
}

export interface ProviderErrorWatchOptions {
  pollMs: number
  read: AntigravityServerLogReader
  home: string
  /** The session prompted, read at each poll. */
  sessionId(): string | null
  /** A new provider error (once per distinct code and message), while the watch is on. */
  onError(error: AntigravityProviderError): void
  /** A later step repeating an error already reported (a server retry). */
  onRepeat?(error: AntigravityProviderError): void
  now?: () => number
}

/**
 * Polls the transcript from the first prompt until anything is heard or the
 * turn ends. A failed read is a quiet poll; one poll at a time; timers never
 * keep the process alive.
 */
export function createProviderErrorWatch(options: ProviderErrorWatchOptions): ProviderErrorWatch {
  let state: 'idle' | 'watching' | 'done' = 'idle'
  let timer: NodeJS.Timeout | undefined
  let polling = false
  let since = 0
  const seenSteps = new Set<number>()
  const seenErrors = new Set<string>()
  const finish = (): void => {
    state = 'done'
    if (timer) clearInterval(timer)
    timer = undefined
  }
  const poll = async (): Promise<void> => {
    if (state !== 'watching' || polling) return
    const sessionId = options.sessionId()
    if (!sessionId) return
    polling = true
    try {
      const errors = await options.read(options.home, sessionId, since)
      for (const error of errors) {
        if (state !== 'watching') return
        if (seenSteps.has(error.stepIndex)) continue
        seenSteps.add(error.stepIndex)
        const key = providerErrorKey(error)
        if (seenErrors.has(key)) {
          options.onRepeat?.(error)
          continue
        }
        seenErrors.add(key)
        options.onError(error)
      }
    } catch {
      // A read that failed is a poll that found nothing.
    } finally {
      polling = false
    }
  }
  return {
    start() {
      if (state !== 'idle') return
      state = 'watching'
      since = (options.now ?? Date.now)()
      timer = setInterval(() => void poll(), options.pollMs)
      timer.unref?.()
    },
    heard() {
      if (state === 'watching') finish()
    },
    stop: finish
  }
}
