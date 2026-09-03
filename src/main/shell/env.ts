/**
 * The login-shell environment resolver.
 *
 * A GUI-launched app on macOS is started by `launchd`, not by a terminal, so it
 * inherits a bare `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) and none of the
 * user's shell profile. Everything a developer installs through Homebrew, mise,
 * nvm, pyenv, cargo or `~/.local/bin` is therefore invisible to the app even
 * though it is plainly installed. The fix is to ask the user's login shell for
 * its environment once and merge it over `process.env`.
 *
 * Resolution runs at most once per app lifetime, is de-duplicated across
 * concurrent callers, and never throws — a failure logs a warning and hands
 * back `process.env` unchanged.
 */

import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createLogger } from '../logger/logger'
import { droppedChildEnvNames, mergeEnv, shellEnvForChild } from './envMerge'
import {
  currentWalkPlatform,
  findExecutable,
  isBareBinaryName,
  splitPathEntries
} from './pathWalk'

const logger = createLogger('shell-env')

/** Re-exported so callers need only one import from the shell layer. */
export { droppedChildEnvNames, mergeEnv, shellEnvForChild }

/** Marks where the shell's own chatter ends and the environment dump begins. */
const SENTINEL = '__CINNA_SHELL_ENV_5f1a527__'

/** Hard ceiling on the shell probe. A wedged profile must not stall a spawn. */
const RESOLVE_TIMEOUT_MS = 5_000

/** Guard against a pathological profile dumping megabytes into stdout. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/**
 * `env -0` is NUL-separated, so a value containing newlines (a multi-line
 * `LS_COLORS`, a pasted key) cannot be mistaken for the start of the next
 * variable. Both BSD (macOS) and GNU (Linux) `env` support it.
 */
const PROBE_COMMAND = `echo ${SENTINEL}; env -0`

let resolved: NodeJS.ProcessEnv | null = null
/**
 * Whether {@link resolved} came from a shell that actually answered, or is the
 * `process.env` fallback. A fallback is still cached — re-probing a broken
 * shell on every `which()` would cost seconds each time — but it is cleared by
 * `clearToolCache()`, so the Refresh affordance recovers a user who has just
 * fixed their profile without making them restart the app.
 */
let resolvedFromShell = false
let inFlight: Promise<NodeJS.ProcessEnv> | null = null

/** Resolved executable paths, keyed by binary name. `null` = looked up, absent. */
const toolCache = new Map<string, string | null>()
/** In-flight `which` lookups, so a burst of callers walks PATH once per binary. */
const toolInFlight = new Map<string, Promise<string | null>>()

/**
 * The user's login shell, with a sane fallback chain. `process.env.SHELL` is
 * set by `launchd` from the user record on macOS and by the session manager on
 * Linux, so it is usually present even for a GUI launch.
 */
function loginShell(): string {
  const fromEnv = process.env.SHELL
  if (fromEnv && fromEnv.startsWith('/')) return fromEnv
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/**
 * Parse the NUL-separated `env -0` dump that follows the sentinel. Anything the
 * profile printed before the sentinel (motd banners, version-manager noise,
 * `nvm` warnings) is discarded, so shell chatter can never be read as an
 * environment variable.
 */
function parseEnvDump(stdout: string): NodeJS.ProcessEnv | null {
  const marker = stdout.indexOf(SENTINEL)
  if (marker === -1) return null
  const newline = stdout.indexOf('\n', marker)
  if (newline === -1) return null

  const out: NodeJS.ProcessEnv = {}
  for (const record of stdout.slice(newline + 1).split('\0')) {
    if (!record) continue
    const eq = record.indexOf('=')
    if (eq <= 0) continue
    out[record.slice(0, eq)] = record.slice(eq + 1)
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Run the probe in `shell` with `args` and return the parsed environment, or
 * `null` if the shell failed, timed out or produced nothing parseable.
 */
function probeShell(shell: string, args: readonly string[]): Promise<NodeJS.ProcessEnv | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, [...args, PROBE_COMMAND], {
        // No stdin: an interactive shell that blocks on a read would otherwise
        // hang until the timeout.
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          // Keep profile frameworks from doing network work on our probe.
          DISABLE_AUTO_UPDATE: 'true',
          ZSH_DISABLE_COMPFIX: 'true'
        }
      })
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let settled = false
    const finish = (value: NodeJS.ProcessEnv | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => {
      logger.warn('login shell probe timed out', { shell, timeoutMs: RESOLVE_TIMEOUT_MS })
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish(null)
    }, RESOLVE_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length > MAX_OUTPUT_BYTES) return
      stdout += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', () => finish(parseEnvDump(stdout)))
  })
}

/**
 * Ask the login shell for its environment. Tries an interactive login shell
 * first (`-ilc`) because a good deal of real-world `PATH` setup lives in
 * `.zshrc` / `.bashrc` rather than the login files, then falls back to a
 * non-interactive login shell (`-lc`) for shells or setups where `-i` misbehaves
 * without a tty.
 */
async function resolveShellEnv(): Promise<{ env: NodeJS.ProcessEnv; fromShell: boolean }> {
  if (process.platform === 'win32') {
    // Windows processes inherit the full user environment from Explorer, so
    // there is nothing to recover and nothing to retry.
    return { env: process.env, fromShell: true }
  }

  const shell = loginShell()
  // Known cost: a shell that hangs makes this two 5s timeouts back to back, so
  // the first stdio MCP connect of a session can block for up to 10s before
  // falling back. Once per app lifetime, and only when the shell misbehaves —
  // recorded here so it isn't rediscovered as a mystery hang.
  for (const args of [['-ilc'], ['-lc']]) {
    const parsed = await probeShell(shell, args)
    if (!parsed) continue
    const merged = { ...process.env, ...parsed }
    logger.info('resolved login shell environment', {
      shell,
      mode: args[0],
      // Never log the environment itself — it carries API keys and tokens.
      pathEntries: splitPathEntries(merged.PATH).length
    })
    return { env: merged, fromShell: true }
  }

  logger.warn('login shell environment unavailable, using process env', {
    shell,
    pathEntries: splitPathEntries(process.env.PATH).length
  })
  return { env: process.env, fromShell: false }
}

/**
 * The user's login-shell environment, merged over `process.env` so Electron's
 * own variables survive. Resolved once per app lifetime; concurrent callers
 * share the in-flight resolution.
 */
export async function getShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (resolved) return resolved
  if (inFlight) return inFlight

  // Deferred to a microtask for the same reason `getCinnaAccessToken` does it:
  // a synchronous throw inside the body would otherwise run the `finally`
  // before `inFlight` was ever assigned.
  const run = Promise.resolve()
    .then(resolveShellEnv)
    .catch((err) => {
      logger.warn('shell env resolution failed', err)
      return { env: process.env, fromShell: false }
    })
    .then(({ env, fromShell }) => {
      resolved = env
      resolvedFromShell = fromShell
      return env
    })
    .finally(() => {
      if (inFlight === run) inFlight = null
    })

  inFlight = run
  return run
}

/** Convenience for callers that only need the resolved `PATH`. */
export async function getResolvedPath(): Promise<string> {
  const env = await getShellEnv()
  return env.PATH ?? ''
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate)
    if (!info.isFile()) return false
    // The executable bit is meaningless on Windows — existence is the test.
    if (process.platform === 'win32') return true
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve an executable name against the login-shell `PATH`.
 *
 * Walks the PATH entries and probes each candidate directly rather than
 * shelling out to `which`/`where` per lookup — one spawn per tool per detection
 * pass is a visible cost on a cold app start, and a spawn also means quoting a
 * name into a command line for no gain.
 *
 * Results are cached (including misses) until {@link clearToolCache}.
 */
export async function which(bin: string): Promise<string | null> {
  if (!isBareBinaryName(bin)) return null

  const cached = toolCache.get(bin)
  if (cached !== undefined) return cached
  const pending = toolInFlight.get(bin)
  if (pending) return pending

  const lookup = Promise.resolve()
    .then(async () => {
      const env = await getShellEnv()
      const found = await findExecutable(bin, splitPathEntries(env.PATH), isExecutableFile, {
        platform: currentWalkPlatform(),
        pathExt: env.PATHEXT
      })
      toolCache.set(bin, found)
      return found
    })
    .catch((err) => {
      logger.warn('executable lookup failed', { bin, error: String(err) })
      return null
    })
    .finally(() => {
      toolInFlight.delete(bin)
    })

  toolInFlight.set(bin, lookup)
  return lookup
}

/**
 * Drop every cached executable lookup. Backs the Refresh affordance — a user
 * who has just installed `claude` expects the app to see it without a restart.
 *
 * A *successful* resolution is kept: it is a once-per-lifetime value by design,
 * and an install into a directory already on `PATH` (the normal Homebrew / npm
 * / cargo case) is picked up by re-walking alone. Editing the shell profile to
 * add a *new* PATH entry still needs an app restart.
 *
 * A *failed* one is discarded, so Refresh is a real recovery for a user whose
 * shell was broken at launch — otherwise they would be stuck with launchd's
 * bare PATH until they restarted the app.
 */
export function clearToolCache(): void {
  toolCache.clear()
  // A resolution that fell back to `process.env` is a failure the user can fix
  // — a typo in `.zshrc`, a shell that was mid-reinstall. Drop it so the next
  // caller re-probes; a successful resolution stays cached for the lifetime.
  if (resolved && !resolvedFromShell) {
    resolved = null
    logger.info('discarded fallback shell env, will re-probe on next use')
  }
}
