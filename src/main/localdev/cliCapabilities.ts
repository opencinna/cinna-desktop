/**
 * What the installed cinna-cli can actually do.
 *
 * The desktop does not choose which cinna-cli it runs: the version comes from
 * the server's `local_dev.cinna_cli_version`, and a server can legitimately pin
 * an older one than the desktop was written against. So "does this binary
 * support the machine-readable protocol" is a question about a *specific
 * install*, not about a version number the desktop could hard-code a floor for.
 *
 * This is not defensive padding. cinna-cli 0.3.0 — the version a real
 * cinna-core pins today — has neither `--json` nor `--no-input` nor
 * `cinna account set-token`, and invoking it with those flags fails with a
 * usage error before it does any work. Probing is what turns that from a broken
 * install into a reduced one.
 *
 * ## Why `--help` and not a trial run
 *
 * Exit codes cannot answer this. cinna-cli 0.3.0 answers `1` to an unknown
 * option, to a missing workspace and to a network failure alike, so a trial
 * invocation cannot distinguish "this flag does not exist" from "that would
 * have worked but the server is down" — and the trial would have side effects.
 * `--help` does not change the account workspace. The CLI still initializes its
 * log, so the probe gives it a disposable writable working directory.
 *
 * ## What "legacy" costs
 *
 * With no `--json` there are no progress lines (the install shows a single
 * step) and no `{"result":…}` line, so `cinna account status` cannot report
 * whether the account token is still valid — the desktop learns only that
 * cinna-cli could read the workspace. And with no `cinna account set-token`
 * there is no way to refresh an expired token in place; the user has to Repair,
 * which mints a fresh setup token and starts over. Both are surfaced rather
 * than hidden: {@link LocalDevState}'s `ready` carries the protocol it settled
 * on, and Settings says what the older cinna-cli cannot do.
 */

import { createLogger } from '../logger/logger'
import { runCinnaCli } from './cliRunner'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const logger = createLogger('cinna-cli-caps')

/** `--help` is local and immediate; a slower answer than this means trouble. */
const PROBE_TIMEOUT_MS = 30_000

export interface CliCapabilities {
  /**
   * `--json` (and with it `--no-input`) on the `account` commands: one JSON
   * object per line, then a final `{"result":…}`, and no prompt can appear.
   */
  json: boolean
  /**
   * `cinna account set-token` — refreshing the account token in place. The
   * top-level `cinna set-token` is a different command, for an *agent*
   * workspace, and is not a substitute.
   */
  accountSetToken: boolean
}

/**
 * Keyed by binary path **and** version, because the path is stable across
 * upgrades — `<localdev>/bin/cinna` is what `uv tool install` rewrites in
 * place — and a cached answer for the previous version would be wrong in
 * exactly the case that matters.
 */
const cache = new Map<string, CliCapabilities>()

async function helpText(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string> {
  const outcome = await runCinnaCli({
    bin,
    args: [...args, '--help'],
    logArgs: [...args, '--help'],
    env,
    cwd,
    timeoutMs: PROBE_TIMEOUT_MS,
    // `--help` is plain text, so nothing here is the JSON protocol; the runner
    // simply files every line as unparseable noise, which is correct and why
    // the text has to come from somewhere else.
    captureStdout: true
  })
  if (outcome.exitCode !== 0 || outcome.timedOut || !outcome.stdout.trim()) {
    throw new Error(`Could not check Cinna CLI support (${outcome.timedOut ? 'the check timed out' : outcome.exitCode === null ? 'the CLI could not start' : `exit code ${outcome.exitCode}`}). Try Check again or repair local development in Settings.`)
  }
  return outcome.stdout
}

/**
 * Ask a cinna-cli what it supports. Cached per (binary, version).
 *
 * A failed probe is an error, not evidence of an older CLI, and is never cached.
 */
export async function probeCliCapabilities(
  bin: string,
  version: string,
  env: NodeJS.ProcessEnv,
  options: { fresh?: boolean } = {}
): Promise<CliCapabilities> {
  const key = `${bin}@${version}`
  const cached = cache.get(key)
  if (cached && !options.fresh) return cached
  if (options.fresh) cache.delete(key)

  // Even subcommand --help initializes cinna.log in cwd. Finder-launched apps
  // may inherit /, which is not writable. Keep probes in a disposable directory.
  const cwd = await mkdtemp(join(tmpdir(), 'cinna-capabilities-'))
  try {
    const results = await Promise.allSettled([
      helpText(bin, ['account', 'setup'], env, cwd),
      helpText(bin, ['account'], env, cwd)
    ])
    // Both processes must finish before their working directory is removed.
    const [setup, account] = results
    if (setup.status === 'rejected') throw setup.reason
    if (account.status === 'rejected') throw account.reason
    const capabilities = {
      json: setup.value.includes('--json'),
      // The subcommand listing, not a substring of prose: `cinna account
      // --help` prints one line per command.
      accountSetToken: /^\s*set-token\b/m.test(account.value)
    }
    logger.info('cinna-cli capabilities', { version, ...capabilities })
    cache.set(key, capabilities)
    return capabilities
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Drop the cache — Repair reinstalls, and may install a different version. */
export function clearCliCapabilityCache(): void {
  cache.clear()
}
