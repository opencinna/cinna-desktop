/**
 * Path rules for the agents-home domain.
 *
 * Every path that reaches this feature from outside the main process — a root
 * the user picked, the `localAgentsHome` app setting, a file the agent page
 * asks to reveal — passes through here first. The renderer is treated as
 * hostile: `contextIsolation` + `sandbox` should stop a compromise reaching
 * these channels at all, but a directory the user never chose must not become
 * a place this app creates files in or opens a file manager on.
 *
 * Two different questions, two different functions:
 *
 * * {@link assertUsableRoot} — "may this become an agents root?" An allowlist:
 *   the user's home, a mounted volume, or the temp dir. Anything else is
 *   refused, so `/etc` or `/System` can never be scaffolded into.
 * * {@link resolveWithinRoot} — "is this file inside a root we already
 *   registered?" Containment, checked after `realpath` so a symlink inside an
 *   agent folder cannot point out of it.
 *
 * Pure except for `realpath`; no Electron, no database.
 */

import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'

const logger = createLogger('local-agents-path')

/**
 * Mount points where a user's own storage legitimately lives outside `$HOME` —
 * an external drive holding a workshop is a real case, and refusing it would
 * push people to symlink around the guard.
 */
const REMOVABLE_MEDIA_PREFIXES = ['/Volumes', '/media', '/mnt', '/run/media']

/** True when `child` is `parent` or sits underneath it. Both must be resolved. */
export function isWithin(parent: string, child: string): boolean {
  if (parent === '' || child === '') return false
  const base = parent.endsWith(sep) ? parent.slice(0, -1) : parent
  return child === base || child.startsWith(base + sep)
}

/** `realpath` where the path exists, the path itself where it does not yet. */
function resolveExisting(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The locations an agents root may live in. Resolved through `realpath` so a
 * home directory that is itself a symlink (a redirected `~/Documents`, a
 * roaming profile) still matches.
 *
 * `tmpdir()` is included deliberately: it is user-writable, holds nothing
 * secret, and is where the test suite builds real workshops — a guard that
 * cannot be exercised end-to-end is a guard nobody trusts.
 */
function allowedRootBases(): string[] {
  const bases = [homedir(), tmpdir(), ...REMOVABLE_MEDIA_PREFIXES]
  const out: string[] = []
  for (const base of bases) {
    if (!base) continue
    out.push(resolve(base))
    const real = resolveExisting(resolve(base))
    if (real !== resolve(base)) out.push(real)
  }
  return out
}

/** Basic shape: a real, absolute, traversal-free path string. */
export function isPlausiblePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length < 4096 &&
    !value.includes('\0') &&
    isAbsolute(value)
  )
}

/**
 * Validate a path the user (or a stored setting) proposes as an agents root and
 * return it normalized. The directory need not exist yet — the home is created
 * on first use — but where it does exist, its resolved location is checked too,
 * so a symlink at an allowed path pointing at `/etc` is refused.
 *
 * @throws LocalAgentError `invalid_path`
 */
export function assertUsableRoot(path: unknown): string {
  if (!isPlausiblePath(path)) {
    throw new LocalAgentError('invalid_path', 'That is not a usable folder path.')
  }
  const normalized = normalize(resolve(path))

  // `resolve` already collapses `..`; a leftover one means the path tried to
  // climb above its own root, which no legitimate folder path does.
  if (normalized.split(sep).includes('..')) {
    throw new LocalAgentError('invalid_path', 'That folder path is not valid.')
  }

  const home = resolve(homedir())
  if (normalized === home || normalized === resolve(sep)) {
    throw new LocalAgentError(
      'invalid_path',
      'Pick a folder inside your home directory, not the home directory itself.'
    )
  }

  const bases = allowedRootBases()
  const real = resolveExisting(normalized)
  const permitted =
    bases.some((base) => isWithin(base, normalized)) &&
    bases.some((base) => isWithin(base, real))

  if (!permitted) {
    // The path is not logged: a hostile renderer would otherwise learn the
    // filesystem layout by probing this error. Its length is enough to debug.
    logger.warn('refused an agents root outside the permitted locations', {
      pathLength: normalized.length
    })
    throw new LocalAgentError(
      'invalid_path',
      'Agents folders must live in your home directory or on a mounted volume.'
    )
  }

  return normalized
}

/**
 * Resolve an agent-relative path against its folder, refusing anything that
 * escapes. `relPath` is renderer-supplied, so it must be relative, must not
 * climb, and — once symlinks are resolved — must still be inside `agentDir`.
 *
 * @param agentDir absolute, already-validated agent folder
 * @param relPath POSIX path relative to it; empty means the folder itself
 * @throws LocalAgentError `invalid_path`
 */
export function resolveWithinRoot(agentDir: string, relPath: string | undefined): string {
  if (relPath === undefined || relPath === '') return agentDir
  if (typeof relPath !== 'string' || relPath.includes('\0') || isAbsolute(relPath)) {
    throw new LocalAgentError('invalid_path', 'That path is not inside the agent folder.')
  }
  const target = resolve(agentDir, normalize(relPath))
  if (!isWithin(agentDir, target)) {
    throw new LocalAgentError('invalid_path', 'That path is not inside the agent folder.')
  }
  // Re-check after symlink resolution: a link inside the folder could point out
  // of it, and the launcher would follow it.
  const realAgentDir = resolveExisting(agentDir)
  const realTarget = resolveExisting(target)
  if (!isWithin(realAgentDir, realTarget)) {
    logger.warn('refused an agent-relative path that resolves outside its folder', {
      relPathLength: relPath.length
    })
    throw new LocalAgentError('invalid_path', 'That path is not inside the agent folder.')
  }
  return target
}
