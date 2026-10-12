/**
 * A sentence for a raw network failure, with the original text kept for
 * "Show details".
 *
 * Main passes `err.message` through as-is, so a server that is down reaches the
 * user as `net::ERR_CONNECTION_REFUSED` (Chromium's `net.fetch`) or
 * `connect ECONNREFUSED 127.0.0.1:8000` (Node). Both name the same condition;
 * the user should read the condition, and only open the code if they want it.
 * Anything that is not recognisably a network error returns `null` and is shown
 * as it was written.
 */
export interface NetworkErrorText {
  summary: string
  technical: string
}

const CAUSES: Array<[RegExp, string]> = [
  [/ERR_CONNECTION_REFUSED|ECONNREFUSED/, 'Connection refused.'],
  [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN/, 'The server address could not be found.'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, 'This computer appears to be offline.'],
  [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/, 'The connection timed out.'],
  [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ECONNRESET|ECONNABORTED|UND_ERR_SOCKET|socket hang up/, 'The connection was closed by the server.'],
  [/ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_UNREACHABLE|EHOSTUNREACH|ENETUNREACH/, 'The server is unreachable.'],
  [/ERR_CERT_|ERR_SSL_|certificate has expired|self[- ]signed certificate|unable to verify the first certificate/, 'The server’s certificate could not be verified.'],
  [/ERR_PROXY_|ERR_TUNNEL_CONNECTION_FAILED/, 'The proxy connection failed.']
]

/**
 * Only codes and Node's fixed phrases are matched, never our prose, so a
 * sentence we wrote is never rewritten. Chromium codes that are about the URL
 * or the request itself (invalid URL, aborted, file, redirect) are not network
 * failures and would send the user to check a connection that is fine.
 */
const NETWORK = /net::ERR_(?!INVALID_URL|ABORTED|FILE_|UNSAFE_REDIRECT|DISALLOWED_URL_SCHEME)[A-Z_]+|\bE(?:CONNREFUSED|NOTFOUND|AI_AGAIN|TIMEDOUT|CONNRESET|CONNABORTED|HOSTUNREACH|NETUNREACH)\b|\bUND_ERR_(?:CONNECT_TIMEOUT|SOCKET)\b|\bfetch failed\b|\bsocket hang up\b|certificate has expired|self[- ]signed certificate|unable to verify the first certificate/

/**
 * What failed, when main put it in front: "Could not install Mutagen: net::…"
 * keeps "Could not install Mutagen". Only a short sentence-like lead with no
 * code of its own — Node's "request to … failed, reason: …" is not one.
 */
function leadOf(text: string): string | null {
  const colon = text.indexOf(': ')
  if (colon <= 0) return null
  const lead = text.slice(0, colon).trim()
  if (!/^[A-Z][^:]{0,79}$/.test(lead) || NETWORK.test(lead) || /\breason\b/i.test(lead)) return null
  return lead.replace(/[.!]$/, '')
}

export function describeNetworkError(text: string | null | undefined): NetworkErrorText | null {
  const technical = text?.trim()
  if (!technical || !NETWORK.test(technical)) return null
  const cause = CAUSES.find(([pattern]) => pattern.test(technical))?.[1]
  const network = cause ? `Network error occurred. ${cause}` : 'Network error occurred.'
  const lead = leadOf(technical)
  return { summary: lead ? `${lead}. ${network}` : network, technical }
}
