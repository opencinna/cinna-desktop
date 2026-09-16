import { A2aHttpError, AgentCardFetchError } from './a2a-client'

/**
 * Socket and DNS codes that mean the connection went away or never opened —
 * not that the request was wrong. Read from the error or its `cause`.
 */
const DROP_CODES = new Set([
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN'
])

/** undici's own messages for a request that failed on the wire, when no code says more. */
const DROP_MESSAGES = new Set(['fetch failed', 'terminated'])

const codeOf = (value: unknown): string | undefined => {
  const code = value && typeof value === 'object' ? (value as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

/**
 * Whether a throw from an A2A request is the connection going away (or never
 * opening), which on the Cinna backend does not end a turn. Positive
 * classification, so anything else keeps its caller's error path:
 *
 * - **Drop**: an error, or its cause, carrying one of {@link DROP_CODES}; or,
 *   when neither carries any code, undici's `TypeError: fetch failed` /
 *   `TypeError: terminated`.
 * - **Not a drop**: any other code (`ERR_INVALID_URL` — a bad URL is not a
 *   network that will come back); an `A2aHttpError` (the server refused us);
 *   a JSON-RPC error frame (the SDK throws a plain `Error` whose cause carries
 *   `errorResponse`); the SDK's other plain `Error`s — an HTTP status when the
 *   stream opens, a bad frame, an id mismatch; any other `TypeError`; and an
 *   abort.
 *
 * Shared by the stream (`runAgentTurn`) and the `tasks/get` collector.
 */
export function isTransportDrop(err: unknown): boolean {
  if (err instanceof A2aHttpError) return false
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : undefined
  if (cause && 'errorResponse' in cause) return false
  const codes = [codeOf(err), codeOf(cause)].filter((code): code is string => !!code)
  if (codes.some((code) => DROP_CODES.has(code))) return true
  if (codes.length) return false
  return err instanceof TypeError && DROP_MESSAGES.has(err.message)
}

/** The SDK's message for a non-OK JSON-RPC response it could not read as an error frame. */
const SDK_HTTP_STATUS = /^HTTP error for [^!]*! Status: (\d{3})\b/

/**
 * Whether a throw is an HTTP status that says "not now" rather than "no":
 * 408, 429 or any 5xx — a gateway in front of a backend that restarts, a
 * server that is overloaded. Read from `AgentCardFetchError.status`,
 * `A2aHttpError.status`, and the plain `Error` the SDK throws for a non-OK
 * JSON-RPC response ("HTTP error for tasks/get! Status: 502 …").
 *
 * Read by relaunch recovery, where such a status leaves the turn for a later
 * pass instead of settling it, and by a Cinna agent's live turn, which rides
 * it out while collecting a dropped stream. Any other live turn keeps its
 * own ending.
 */
export function isTransientHttpStatus(err: unknown): boolean {
  let status: number | undefined
  if (err instanceof AgentCardFetchError || err instanceof A2aHttpError) status = err.status
  else if (err instanceof Error) {
    const match = SDK_HTTP_STATUS.exec(err.message)
    status = match ? Number(match[1]) : undefined
  }
  return status !== undefined && (status === 408 || status === 429 || (status >= 500 && status <= 599))
}
