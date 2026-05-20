import { createLogger } from '../logger/logger'

const logger = createLogger('path-guard')

/**
 * Default TTL on a recorded path. Long enough to cover normal usage
 * (drop a file, type your message, send) but bounded so paths recorded
 * by past sessions don't accumulate indefinitely.
 */
const PATH_TTL_MS = 60 * 60 * 1000

/**
 * Allowlist of OS paths the renderer is permitted to reference via the
 * `files:ingest-paths` / `files:resolve-paths` IPCs. Populated by:
 *
 *  - The native file picker (`dialog.showOpenDialog`) — paths chosen by
 *    the user in a system dialog are inherently trustworthy.
 *  - The `webUtils.getPathForFile` preload wrapper — records the path
 *    when the renderer resolves a dropped File object. The renderer
 *    can't fabricate a File pointing at an arbitrary path, so this
 *    captures legitimate drop interactions.
 *
 * Without the allowlist, a renderer compromised via XSS could call
 * `window.api.files.ingestPaths({ paths: ['/Users/x/.ssh/id_rsa'] })`
 * and exfiltrate the bytes through whichever LLM channel is active.
 * Defense in depth — contextIsolation + sandbox should prevent that
 * compromise in the first place, but the layered check is cheap.
 */
const allowed = new Map<string, number>()

function isLive(expiresAt: number): boolean {
  return expiresAt > Date.now()
}

export const pathGuard = {
  /** Record a path as legitimately surfaced by the user. Idempotent —
   *  re-recording bumps the expiry. */
  record(path: string, ttlMs: number = PATH_TTL_MS): void {
    if (!path) return
    allowed.set(path, Date.now() + ttlMs)
  },

  /** Record many paths at once (picker result, batch drop). */
  recordMany(paths: readonly string[], ttlMs: number = PATH_TTL_MS): void {
    for (const p of paths) this.record(p, ttlMs)
  },

  /**
   * Returns whether `path` is in the allowlist and not expired. Lazy
   * cleanup — expired entries are removed on lookup so we don't need a
   * separate sweeper.
   */
  isAllowed(path: string): boolean {
    const exp = allowed.get(path)
    if (!exp) return false
    if (!isLive(exp)) {
      allowed.delete(path)
      return false
    }
    return true
  },

  /**
   * Partition a path list into the allowed subset and the rejected
   * subset. The IPC layer uses this to drop hostile paths silently
   * while keeping legitimate ones — and to log the rejected ones for
   * forensics.
   */
  filterAllowed(paths: readonly string[]): { allowed: string[]; rejected: string[] } {
    const out: { allowed: string[]; rejected: string[] } = { allowed: [], rejected: [] }
    for (const p of paths) {
      if (this.isAllowed(p)) out.allowed.push(p)
      else out.rejected.push(p)
    }
    if (out.rejected.length > 0) {
      logger.warn('rejected unallowlisted paths', {
        rejectedCount: out.rejected.length,
        // Don't log the full path — could be an attacker probing for
        // filesystem layout. Length + extension is enough to debug.
        sample: out.rejected.slice(0, 3).map((p) => ({
          length: p.length,
          ext: p.slice(p.lastIndexOf('.'))
        }))
      })
    }
    return out
  },

  /** Test-only / explicit reset. */
  _reset(): void {
    allowed.clear()
  }
}
