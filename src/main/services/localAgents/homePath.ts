/**
 * Where the agents home is — and nothing else.
 *
 * Split out of `agentsHomeService` because "which folder is the home?" and
 * "make the home exist" became two questions with different costs. Resolving
 * the path is pure string work; creating the folder is a write into
 * `~/Documents` that raises a macOS permission prompt. Every caller that only
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

/** Where a fresh install puts the agents home. */
const DEFAULT_HOME_DIRS = ['Documents', 'CinnaAgents']

/**
 * The macOS locations behind a TCC "Files and Folders" prompt.
 *
 * `Documents` is the one that matters — it holds the default home — but the
 * home is a setting, and a user who points it at their Desktop deserves the
 * same explanation. `Mobile Documents` is iCloud Drive, which is where
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
 * The configured home, or the default. A configured path that no longer passes
 * the path rules is reported and ignored — the user keeps a working app rather
 * than an app that refuses to open its Agents tab.
 */
export function configuredHomePath(): string {
  const configured = appSettingsRepo.get('localAgentsHome')
  if (typeof configured !== 'string' || configured.trim() === '') return defaultHomePath()
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
 * Always false off macOS: Linux and Windows have no equivalent, and a modal
 * explaining a prompt that will not arrive is worse than no modal.
 */
export function isGuardedLocation(path: string, platform: string = process.platform): boolean {
  if (platform !== 'darwin') return false
  const home = resolve(homedir())
  const target = resolve(path)
  // `isWithin` is true for the guarded folder itself as well as for anything
  // under it. The home can never *be* `~/Documents` — the default and
  // `assertUsableRoot` both put it at least one level down — but a folder that
  // is guarded is guarded either way.
  return MAC_GUARDED_DIRS.some((dirs) => isWithin(join(home, ...dirs), target))
}
