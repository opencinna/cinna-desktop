/**
 * Provider errors from Antigravity's own transcript: the pure half, shared by
 * the host driver (`src/main/agents/drivers/acp/antigravityServerLog.ts`, which
 * reads a host agent's transcript) and cinna-vaultd (`engine.providerErrors`,
 * which reads a vault agent's inside the guest). No Node imports: vaultd's
 * esbuild bundle takes this file as it is.
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
 * user's prompts (USER_INPUT): nothing but an error's string (cleaned and
 * redacted, {@link redactProviderErrorMessage}) and code ever leaves the parser.
 */

import { VAULT_PROVIDER_ERRORS_MAX, type VaultProviderErrorEntry } from './vault/protocol'

export type { VaultProviderErrorEntry }

/** How much of the transcript's end is read: a provider error is a recent step. */
export const ANTIGRAVITY_SERVER_LOG_TAIL_BYTES = 256 * 1024
/** The longest error string kept from a step (enough to classify a doubled transport chain). */
export const ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS = 1000
/** The longest error message a note shows. */
export const ANTIGRAVITY_PROVIDER_ERROR_SHOWN_CHARS = 200
/** The most errors one `engine.providerErrors` answer carries (the newest kept). */
export const ANTIGRAVITY_PROVIDER_ERRORS_MAX = VAULT_PROVIDER_ERRORS_MAX
/** `created_at` has second precision: an error up to this long before `since` still counts. */
const SINCE_SLACK_MS = 2_000
/** How much of a raw error string is looked at before redaction and the cap. */
const RAW_SCAN_CHARS = 8 * ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS

export interface AntigravityProviderError {
  /** The step's `step_index`: one error is one step. */
  stepIndex: number
  /** The error string, control characters stripped, redacted and capped. */
  message: string
  /** The provider's status (`error_code`), when it gave one. */
  code?: number
  /** `created_at`, epoch ms (NaN when the step carries no date). */
  at: number
}

/**
 * A plain ACP session id: the brain folder's name, nothing that could leave it.
 * Letters, digits, `.`, `_`, `-`, at most 128, never `.` or `..` (nor any `..`).
 */
export function plainAntigravitySessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(sessionId) && !sessionId.includes('..') && sessionId !== '.'
}

/** The transcript's path below the Antigravity home, as segments. */
export function antigravityTranscriptSegments(sessionId: string): string[] {
  return ['antigravity-acp', 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl']
}

/** Control characters out, whitespace collapsed, capped. */
export function cleanProviderErrorMessage(text: string, max = ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

// ---------------------------------------------------------------------------
// Redaction

const REDACTED = '[redacted]'
/** Between a secret's name and its value: an optional closing quote (JSON), `:` or `=`, an optional opening quote. */
const SEP = `(["']?\\s*[:=]\\s*["']?)`
/** A value: up to a space, a separator or a quote (never `[`, so `[redacted]` is not taken again). */
const VALUE = `[^\\s,;&"'}[\\]]+`
/** `Authorization: <scheme> <value>` (`:` or `=`, quoted or not), the value whatever it is. */
const AUTH_HEADER = new RegExp(`\\b(authorization|proxy-authorization)${SEP}(?:(?:bearer|basic|token|digest|negotiate)\\s+)?${VALUE}`, 'gi')
/** A cookie header's whole value, to the end of the line or the quote. */
const COOKIE = new RegExp(`\\b(set-cookie|cookie)${SEP}[^"'}[\\]\\r\\n]+`, 'gi')
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi
/** Named secrets: `x-goog-api-key`, `key`, `api_key`/`api-key`/`apikey`, tokens, passwords, secrets — as `name=v`, `name: v`, `"name":"v"`. */
const SECRET_PARAM = new RegExp(
  `\\b(x-goog-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|token|password|passwd|secret|key)${SEP}${VALUE}`,
  'gi'
)
const GOOGLE_API_KEY = /AIza[0-9A-Za-z_-]{30,}/g
const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g
/** A URL of any scheme (`https`, `wss`, `ftp`…); the scheme is bounded so a long dotted run never rescans. */
const URL = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>`]+/gi
/** A long opaque run, outside a URL: 32+ characters of a token's alphabet with no space. */
const OPAQUE = /[A-Za-z0-9_\-+/=.]{32,}/g
/** The same inside one URL path segment (a `/` ends a segment there). */
const OPAQUE_SEGMENT = /[A-Za-z0-9_\-+=.]{32,}/g
/** A bare lowercase hostname (`generativelanguage.googleapis.com`), which an opaque run may be but a token never is. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/

/** An opaque run kept only when it is a hostname (at most 253 characters, lowercase labels, a letters-only last label). */
function redactOpaque(text: string): string {
  return text.replace(OPAQUE, (run) => (run.length <= 253 && HOSTNAME.test(run) ? run : REDACTED))
}

/** A URL kept as scheme, host and path: no userinfo, no query, no fragment; a long path segment redacted. */
function redactUrl(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)/i.exec(url)
  if (!match) return REDACTED
  const host = match[2].includes('@') ? match[2].slice(match[2].lastIndexOf('@') + 1) : match[2]
  const path = match[3].split('/').map((segment) => segment.replace(OPAQUE_SEGMENT, REDACTED)).join('/')
  return `${match[1]}${host}${path}`
}

/**
 * Anything secret-shaped out of an error string, before it leaves the guest or
 * reaches a note or a log: an `Authorization` header's value, a cookie header's,
 * a `Bearer` token, named secrets (`x-goog-api-key`, `key`, `api_key`,
 * `access_token`, `refresh_token`, `token`, `password`, `secret`… after `=` or
 * `:`, quoted as in JSON or not), Google (`AIza…`) and `sk-…` keys, a URL's
 * (any scheme) query, fragment and userinfo and long path segments, and any
 * other long opaque run (32+ of `[A-Za-z0-9_\-+/=.]`) that is not a bare
 * lowercase hostname. Each becomes `[redacted]`. A transport chain keeps what
 * classifies it (`dial tcp`, `i/o timeout`, the host). Every pattern is linear:
 * no nested quantifier can rescan its input.
 */
export function redactProviderErrorMessage(text: string): string {
  const keyed = text
    .replace(AUTH_HEADER, (_all, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(COOKIE, (_all, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(BEARER, (_all, name: string) => `${name} ${REDACTED}`)
    .replace(SECRET_PARAM, (_all, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(GOOGLE_API_KEY, REDACTED)
    .replace(SK_KEY, REDACTED)
  const parts: string[] = []
  let last = 0
  for (const match of keyed.matchAll(URL)) {
    const at = match.index ?? 0
    parts.push(redactOpaque(keyed.slice(last, at)), redactUrl(match[0]))
    last = at + match[0].length
  }
  parts.push(redactOpaque(keyed.slice(last)))
  return parts.join('')
}

/** What leaves the parser: control characters out, redacted, capped. */
export function providerErrorMessageOf(raw: string): string {
  const scanned = cleanProviderErrorMessage(raw.slice(0, RAW_SCAN_CHARS), RAW_SCAN_CHARS)
  return cleanProviderErrorMessage(redactProviderErrorMessage(scanned))
}

// ---------------------------------------------------------------------------
// Parsing

/**
 * The provider errors in transcript `text` that belong to the turn prompted at
 * `since`. The transcript's own order decides first: only errors after the last
 * USER_INPUT step (of a USER_INPUT nothing but its index and date is read). With
 * none in the tail, or when the last one is dated before `since` (this turn's
 * input is not written yet, so it is an earlier turn's), `created_at` ≥
 * `since` − slack decides as well.
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
    const message = providerErrorMessageOf(s.error)
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

// ---------------------------------------------------------------------------
// The note

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

// ---------------------------------------------------------------------------
// The vault wire (`engine.providerErrors`)

/** The newest {@link ANTIGRAVITY_PROVIDER_ERRORS_MAX} errors, as vaultd answers them. */
export function vaultProviderErrorEntries(errors: readonly AntigravityProviderError[]): VaultProviderErrorEntry[] {
  return errors.slice(-ANTIGRAVITY_PROVIDER_ERRORS_MAX).map((error) => ({
    key: providerErrorKey(error),
    stepIndex: error.stepIndex,
    ...(error.code !== undefined ? { code: error.code } : {}),
    message: error.message,
    at: Number.isFinite(error.at) ? error.at : 0
  }))
}

/**
 * An `engine.providerErrors` answer, checked on the host: malformed entries
 * dropped, every message cleaned, redacted and capped again (the guest's word
 * is not taken for it), at most {@link ANTIGRAVITY_PROVIDER_ERRORS_MAX}.
 */
export function checkedVaultProviderErrors(answer: unknown): AntigravityProviderError[] {
  const raw = answer && typeof answer === 'object' ? (answer as { errors?: unknown }).errors : undefined
  if (!Array.isArray(raw)) return []
  const out: AntigravityProviderError[] = []
  for (const entry of raw.slice(0, ANTIGRAVITY_PROVIDER_ERRORS_MAX)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.key !== 'string') continue
    if (typeof e.stepIndex !== 'number' || !Number.isFinite(e.stepIndex)) continue
    if (typeof e.message !== 'string' || typeof e.at !== 'number' || !Number.isFinite(e.at)) continue
    if (e.code !== undefined && (typeof e.code !== 'number' || !Number.isInteger(e.code))) continue
    const message = providerErrorMessageOf(e.message)
    if (!message) continue
    out.push({ stepIndex: e.stepIndex, message, ...(typeof e.code === 'number' ? { code: e.code } : {}), at: e.at })
  }
  return out
}
