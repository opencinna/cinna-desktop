/**
 * Where the agents home is — and nothing else.
 *
 * Split out of `agentsHomeService` because "which folder is the home?" and
 * "make the home exist" became two questions with different costs. Resolving
 * the path is pure string work; creating the folder can be a write into a
 * macOS-guarded folder (a home the user pointed at `~/Documents`, or the
 * pre-2026-10 default there) that raises a permission prompt. Every caller that only
 * wanted the path for a sentence — the onboarding copy, the local-dev consent
 * modal — used to go through `ensureHome` and create the folder to read its
 * name, which is how a Documents-access prompt came to appear on a sign-in
 * screen.
 *
 * **The default path is resolved with no filesystem work at all**, which is the
 * invariant the gate rests on: `homeAccessService` has to answer "may we write
 * there?" before the first write, and a read inside a guarded folder is the
 * thing that raises the prompt. A *configured* path is a different case — it
 * goes through {@link assertUsableRoot}, which `realpath`s it, and that is
 * accepted: a configured home only exists because the user picked it in the OS
 * directory panel, and a folder chosen that way is already granted.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { appSettingsRepo } from '../../db/appSettings'
import { createLogger } from '../../logger/logger'
import { assertUsableRoot, isWithin } from './pathRules'

const logger = createLogger('local-agents-home-path')

/**
 * Where a fresh install puts the agents home: `~/CinnaAgents`.
 *
 * Directly under the home directory rather than in `~/Documents`, which is
 * where it used to be. `~/Documents` is guarded on macOS, so creating the
 * default there raised the system's Documents prompt and needed the
 * explainer in front of it; `~` is not guarded, so the default is created
 * silently on every platform. Installs that already used the old default keep
 * it: the `pinLegacyAgentsHome` migration writes it into `localAgentsHome`.
 */
const DEFAULT_HOME_DIRS = ['CinnaAgents']

/**
 * The macOS locations behind a TCC "Files and Folders" prompt.
 *
 * `Documents` is the one that matters — it held the default home until it moved
 * to `~/CinnaAgents`, and older installs keep it there — but the home is a
 * setting, and a user who points it at their Desktop deserves the same
 * explanation. `Mobile Documents` is iCloud Drive, which is where
 * `~/Documents` actually lives on a Mac with Desktop & Documents syncing on.
 *
 * `/Volumes` is left out even though removable media has a TCC service of its
 * own: an external drive is a folder the user picked in a directory picker, and
 * a path chosen that way carries its own grant.
 */
const MAC_GUARDED_DIRS = [
  ['Documents'],
  ['Desktop'],
  ['Downloads'],
  ['Library', 'Mobile Documents']
]

/** The path a fresh install would use. */
export function defaultHomePath(): string {
  return join(homedir(), ...DEFAULT_HOME_DIRS)
}

/**
 * The default before it moved to `~/CinnaAgents`. The `pinLegacyAgentsHome`
 * migration writes it into `localAgentsHome` for installs that were using it.
 */
export function legacyDefaultHomePath(): string {
  return join(homedir(), 'Documents', 'CinnaAgents')
}

/**
 * The configured home, or the default. A configured path that no longer passes
 * the path rules is reported and ignored — the user keeps a working app rather
 * than an app that refuses to open its Agents tab.
 */
export function configuredHomePath(): string {
  const configured = appSettingsRepo.get('localAgentsHome')
  if (typeof configured !== 'string' || configured.trim() === '') return defaultHomePath()
  // The old default, pinned by the migration, is trusted exactly as it was
  // while it *was* the default: never validated. `assertUsableRoot` realpaths
  // it, and a `~/Documents` redirected outside the allowed bases (a Linux
  // `/data/Documents`, a Windows `D:\`) would then fail and fall back to
  // `~/CinnaAgents` — repointing the home root and emptying the sidebar.
  if (configured === legacyDefaultHomePath()) return configured
  try {
    return assertUsableRoot(configured)
  } catch {
    logger.warn('the configured agents home is not usable; falling back to the default', {
      configuredLength: configured.length
    })
    return defaultHomePath()
  }
}

/**
 * True when writing to `path` would raise a macOS Files-and-Folders prompt.
 *
 * A prefix test on the *unresolved* path, on purpose. `realpath` would follow a
 * synced `~/Documents` to its iCloud location, which is guarded too — but it
 * also reads the filesystem, and this answer is needed before the first read.
 * Both spellings are in the list instead.
 *
 * Compared without case: APFS ignores it by default, so `~/downloads/q3.csv`
 * is the Downloads folder and raises the same prompt. On a case-sensitive
 * volume that folds a path that is not guarded into one that is — the safe
 * direction for a question asked before any read.
 *
 * Always false off macOS: Linux and Windows have no equivalent, and a modal
 * explaining a prompt that will not arrive is worse than no modal.
 */
export function isGuardedLocation(path: string, platform: string = process.platform): boolean {
  if (platform !== 'darwin') return false
  const home = resolve(homedir())
  const target = resolve(path).toLowerCase()
  // `isWithin` is true for the guarded folder itself as well as for anything
  // under it. The home can never *be* `~/Documents` — `assertUsableRoot` puts
  // a configured one at least one level down — but a folder that is guarded is
  // guarded either way.
  return MAC_GUARDED_DIRS.some((dirs) => isWithin(join(home, ...dirs).toLowerCase(), target))
}
