/**
 * What this machine has been told by each Cinna instance about where its
 * team agents' git lives.
 *
 * ## Why a git origin has to be trusted, not just seen
 *
 * cinna-core builds `clone_url` from its backend address, and a profile is
 * often signed in through a different origin that proxies the API
 * (`localhost:5173` against `localhost:8000` in development, `app.` against
 * `api.` in a deployment). So the git origin cannot simply be required to be
 * the profile's server. But it must not be read from the folder either: an
 * agent running in that folder, a copied folder with its `.git`, or any local
 * process can rewrite `.git/config`, and a remote URL taken from there would
 * send the profile's token wherever it points. The only source of a git
 * origin other than the instance's own is **that instance's answer over that
 * profile's session** — a catalog listing or the reply to creating an entry.
 *
 * ## Why a file in main and not the settings store
 *
 * App settings are writable from the renderer through the generic
 * `settings:set`, and this is a trust list. It must survive a restart (a
 * shared agent has to take its instance's token before the first listing of
 * the session lands), so it is a small JSON file under `userData` that only
 * this module writes. Core module: no Electron import.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { createLogger } from '../logger/logger'

const logger = createLogger('library-trust')

interface TrustFile {
  /** Instance API origin → git origins it has named. */
  gitOrigins: Record<string, string[]>
}

let state: TrustFile | null = null
let pathOverride: string | null = null

/**
 * Where the trust file lives, or null when this host has no `userData` — then
 * the list is kept in memory for this run only. Never a shared fallback such
 * as the temp directory: any local user could write a trust list there and
 * point a profile's token at their own origin.
 */
function filePath(): string | null {
  if (pathOverride) return pathOverride
  try {
    return join(runtimeHost.getPath('userData'), 'team-library-trust.json')
  } catch {
    return null
  }
}

function load(): TrustFile {
  if (state) return state
  const empty: TrustFile = { gitOrigins: {} }
  const path = filePath()
  if (path === null) {
    state = empty
    return state
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrustFile>
    // A file an older build wrote may also carry `pending`; it is dropped on the next save.
    state = { gitOrigins: parsed.gitOrigins && typeof parsed.gitOrigins === 'object' ? parsed.gitOrigins : {} }
  } catch {
    state = empty
  }
  return state
}

function save(): void {
  const path = filePath()
  if (path === null) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`
    const fd = openSync(temp, 'w')
    try {
      writeSync(fd, `${JSON.stringify(load(), null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (err) {
    // In memory it still holds for this run; the next listing teaches it again.
    logger.warn('could not save the team library trust file', { error: String(err) })
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')
}

/**
 * The origin of a `clone_url` an instance answered with, when a token may be
 * sent there: http(s) only, and plain http only when the instance itself is
 * on http or the address is this machine. Null otherwise.
 */
export function acceptableGitOrigin(serverOrigin: string, cloneUrl: string): string | null {
  let url: URL
  try {
    url = new URL(cloneUrl)
  } catch {
    return null
  }
  if (url.protocol === 'https:') return url.origin
  if (url.protocol !== 'http:') return null
  if (serverOrigin.startsWith('http:') || isLoopback(url.hostname)) return url.origin
  return null
}

export const libraryTrust = {
  /**
   * Record that `serverOrigin` named `cloneUrl` in an answer to this
   * profile's session. Answers the git origin when it is acceptable (see
   * {@link acceptableGitOrigin}), else null and nothing is recorded.
   */
  learn(serverOrigin: string, cloneUrl: string): string | null {
    const origin = acceptableGitOrigin(serverOrigin, cloneUrl)
    if (origin === null || origin === serverOrigin) return origin
    const file = load()
    const known = file.gitOrigins[serverOrigin] ?? []
    if (!known.includes(origin)) {
      file.gitOrigins[serverOrigin] = [...known, origin]
      save()
    }
    return origin
  },

  /** Whether a token for `serverOrigin` may be sent to `gitOrigin`. */
  trusts(serverOrigin: string, gitOrigin: string): boolean {
    return gitOrigin === serverOrigin || (load().gitOrigins[serverOrigin] ?? []).includes(gitOrigin)
  },

  /** The instances that have named `gitOrigin` as theirs. */
  serversFor(gitOrigin: string): string[] {
    return Object.entries(load().gitOrigins)
      .filter(([, origins]) => origins.includes(gitOrigin))
      .map(([server]) => server)
  },

  /** Tests: start empty, optionally at a given file. */
  _reset(path: string | null = null): void {
    state = null
    pathOverride = path
  }
}
