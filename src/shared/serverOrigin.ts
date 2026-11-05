/**
 * A Cinna server's origin, from a URL that arrived from outside (a deep link,
 * a pasted skill link). Pure, shared by main (`connectIntentService`, the
 * skill-link resolver) and the renderer (the skill-link parser).
 *
 * The URL is reduced to scheme + host + non-default port: path, query and
 * fragment are dropped rather than sanitized, `https` is required with a
 * loopback `http` exception for development, and embedded credentials are
 * refused.
 */

/**
 * Refuse a URL longer than this before parsing it. Nothing legitimate is close
 * — an origin is tens of characters — and a megabyte argv entry is not worth
 * handing to `new URL`.
 */
export const MAX_URL_LENGTH = 2048

/** Hosts allowed to speak plain `http`, for local development only. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Reduce a candidate server URL to its origin, or explain why it is refused.
 *
 * Returns the normalized origin. The refusal reason is a *log* string, not
 * something the user is shown: a rejected deep link has no UI, because a link
 * the app refuses should look to the user exactly like a link nobody sent.
 */
export function normalizeServerOrigin(
  raw: string
): { ok: true; origin: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'empty server parameter' }
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'server parameter too long' }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'server parameter is not a URL' }
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'server URL carries credentials' }
  }
  if (!url.hostname) return { ok: false, reason: 'server URL has no host' }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol === 'http:') {
    if (!isLoopback) return { ok: false, reason: 'plain http is only allowed for loopback' }
  } else if (url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported scheme ${url.protocol}` }
  }

  // `origin` is exactly scheme + host + non-default port, which is the whole
  // point: it is the parse, not a substring of the input, so nothing that was
  // in the path or the query can survive into it.
  return { ok: true, origin: url.origin }
}
