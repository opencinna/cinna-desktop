/**
 * A Cinna server can answer on more than one origin: its web app (where people
 * sign in and copy install links) and its backend (what a `cinna://connect`
 * sign-in stores, and what the web page's Open in Cinna Desktop link names). A
 * profile stores one of them; the server's own discovery document names the
 * rest — its endpoints, and `web_origin` on cores that serve it.
 *
 * Only the **profile's own** stored server is ever asked. A link names an
 * origin, and a pasted or clicked link must never make the app contact a
 * server it names, so nothing here takes a link's origin.
 *
 * Every answer degrades to the stored origin alone: a discovery that fails,
 * times out, or comes from an older core without `web_origin` is never an
 * error. A failed or timed-out one is reported as such (`discovered: false`),
 * so a caller can tell "this server has no other origin" from "it could not
 * be asked".
 *
 * Core service: no Electron, no window.
 */

import { discoverCinnaEndpoints, type CinnaEndpoints } from '../auth/cinna-oauth'
import { normalizeServerOrigin } from '../../shared/serverOrigin'

/** How long a lookup waits for the discovery document before going on without it. */
export const DISCOVERY_WAIT_MS = 3000

function originOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const normalized = normalizeServerOrigin(raw)
  return normalized.ok ? normalized.origin : null
}

/**
 * The stored server's discovery document, or null when it failed or took
 * longer than `waitMs`. The request itself is aborted at `waitMs` (the signal
 * goes into the fetch); the race is there for a request that ignores it.
 */
async function discoveryOf(serverUrl: string, waitMs: number): Promise<CinnaEndpoints | null> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      discoverCinnaEndpoints(serverUrl, abort.signal),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          abort.abort(new Error(`discovery of ${serverUrl} took longer than ${waitMs} ms`))
          resolve(null)
        }, waitMs)
      })
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What is known of the origins the server stored as `serverUrl` answers on.
 * `discovered` false: its discovery failed or timed out, so `origins` (the
 * stored one alone) says nothing about which other origins it has — a caller
 * must not read a miss as "not this server".
 */
export interface KnownOrigins {
  origins: Set<string>
  discovered: boolean
}

/**
 * Every origin the server stored as `serverUrl` answers on: the stored one,
 * its `token_endpoint`'s and `userinfo_endpoint`'s, and `web_origin`, each
 * normalized as a link's origin is (one the grammar would refuse is dropped).
 * Not `authorization_endpoint`: it may sit on an identity provider other
 * servers share. Empty, and nothing asked, for a stored URL that is itself
 * refused — nothing is unknown about that one.
 */
export async function knownOriginsOf(serverUrl: string, waitMs = DISCOVERY_WAIT_MS): Promise<KnownOrigins> {
  const origins = new Set<string>()
  const stored = originOrNull(serverUrl)
  if (stored === null) return { origins, discovered: true }
  origins.add(stored)
  const doc = await discoveryOf(serverUrl, waitMs)
  if (!doc) return { origins, discovered: false }
  for (const raw of [doc.token_endpoint, doc.userinfo_endpoint, doc.web_origin]) {
    const origin = originOrNull(raw)
    if (origin !== null) origins.add(origin)
  }
  return { origins, discovered: true }
}

/**
 * The origin a browser opens the server's web app on, for an install link:
 * an acceptable `web_origin`, else the stored origin, else null when even the
 * stored URL is refused. `fromDiscovery`: the server's discovery answered, so
 * the origin is final; false is a fallback worth asking again later.
 */
export async function webOriginOf(
  serverUrl: string,
  waitMs = DISCOVERY_WAIT_MS
): Promise<{ origin: string | null; fromDiscovery: boolean }> {
  const stored = originOrNull(serverUrl)
  if (stored === null) return { origin: null, fromDiscovery: false }
  const doc = await discoveryOf(serverUrl, waitMs)
  return { origin: originOrNull(doc?.web_origin) ?? stored, fromDiscovery: doc !== null }
}
