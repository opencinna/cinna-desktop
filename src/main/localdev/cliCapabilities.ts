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
 * `--help` is free, has none, and is the one output whose shape is a promise.
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

/** What a binary that answers nothing is assumed to support: the old surface. */
const LEGACY: CliCapabilities = { json: false, accountSetToken: false }

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
  env: NodeJS.ProcessEnv
): Promise<string> {
  const outcome = await runCinnaCli({
    bin,
    args: [...args, '--help'],
    logArgs: [...args, '--help'],
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
    // `--help` is plain text, so nothing here is the JSON protocol; the runner
    // simply files every line as unparseable noise, which is correct and why
    // the text has to come from somewhere else.
    captureStdout: true
  })
  return outcome.stdout
}

/**
 * Ask a cinna-cli what it supports. Cached per (binary, version).
 *
 * A probe that cannot run at all answers {@link LEGACY} rather than throwing:
 * assuming the smaller surface degrades a working install into a reduced one,
 * while assuming the larger surface turns a reduced install into a broken one.
 */
export async function probeCliCapabilities(
  bin: string,
  version: string,
  env: NodeJS.ProcessEnv
): Promise<CliCapabilities> {
  const key = `${bin}@${version}`
  const cached = cache.get(key)
  if (cached) return cached

  let capabilities = LEGACY
  try {
    const [setupHelp, accountHelp] = await Promise.all([
      helpText(bin, ['account', 'setup'], env),
      helpText(bin, ['account'], env)
    ])
    capabilities = {
      json: setupHelp.includes('--json'),
      // The subcommand listing, not a substring of prose: `cinna account
      // --help` prints one line per command.
      accountSetToken: /^\s*set-token\b/m.test(accountHelp)
    }
  } catch (err) {
    logger.warn('could not probe cinna-cli capabilities; assuming the older surface', {
      error: String(err)
    })
  }

  logger.info('cinna-cli capabilities', { version, ...capabilities })
  cache.set(key, capabilities)
  return capabilities
}

/** Drop the cache — Repair reinstalls, and may install a different version. */
export function clearCliCapabilityCache(): void {
  cache.clear()
}
