/**
 * The agents home and the extra roots.
 *
 * A **root** is a workshop folder: it holds `Local/` (one directory per agent),
 * `Cloud/`, the root markdown files, and `.cinna-kit/` — the kit copy that
 * lets a coding assistant working in the folder read the same rules the desktop
 * reads, along with the kit's guides and `tools/kit.py`. Exactly one root is
 * the *home*: `~/Documents/CinnaAgents` unless the
 * `localAgentsHome` app setting says otherwise. Any number of extra roots can be
 * adopted, which is how an existing kit workshop joins the app unchanged.
 *
 * Everything here is idempotent and lazy. `ensureHome()` is safe to call on
 * every request: it creates what is missing, leaves alone what already exists
 * (every root file is `survives_update: true` in the contract's layout), and
 * touches the disk only for the pieces that are actually absent.
 *
 * One thing is neither idempotent nor lazy: the **first** creation of a home
 * inside a macOS-guarded folder. `ensureHome` refuses it until the user has
 * been told what the folder is, and {@link agentsHomeService.prepare} is the
 * only way through. See `homeAccessService` for why the app has to answer that
 * question itself.
 *
 * The configured home is **validated on every read** rather than trusted.
 * `localAgentsHome` reaches the store through the generic `settings:set`
 * channel, which type-checks but cannot know what a plausible agents folder is;
 * a value that fails {@link assertUsableRoot} falls back to the default instead
 * of becoming a directory this app writes into.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, join } from 'node:path'
import { agentRootRepo, type AgentRootRow } from '../../db/agentRoots'
import { agentRepo } from '../../db/agents'
import {
  clearContractCache,
  getBundledContractDir,
  getContractVersion,
  readVersionAt,
  resolveContract
} from '../../kit/contractStore'
import { swapInto } from '../../kit/treeSwap'
import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { compareVersionStrings } from '../../../shared/kit/contractVersion'
import {
  AGENTS_SUBDIR,
  type AgentRootDto,
  type AgentRootKind,
  type AgentsHomeAccess,
  type AgentsHomeState
} from '../../../shared/localAgents'
import { desktopStateService } from './desktopStateService'
import { discoverBareAgents } from './externalScan'
import { looksLikeGitRepo } from './gitService'
import { homeAccessService } from './homeAccessService'
import { configuredHomePath, defaultHomePath } from './homePath'
import { assertUsableRoot, isWithin } from './pathRules'
import { scannerService } from './scannerService'
import { scaffoldService } from './scaffoldService'

const logger = createLogger('local-agents-home')

/** Folder a workshop keeps its copy of the kit in, per `layout.json`. */
const WORKSHOP_KIT_DIR = '.cinna-kit'

/**
 * Prefix of the tree an install is built in, beside `.cinna-kit/` so the swap
 * is a rename on one filesystem. `swapInto` parks the old tree at
 * `<staging>.previous`, which carries the same prefix.
 */
const KIT_STAGING_PREFIX = `${WORKSHOP_KIT_DIR}.staging-`

/** The kit's content version (core's `_content_version`), not the contract's. */
const KIT_VERSION_FILE = 'VERSION'

/**
 * The stamp the root `AGENTS.md` freshness rule reads (`kit.py`'s
 * `LAST_REFRESH_CHECK`): missing or older than 7 days sends an assistant to
 * `kit.py refresh --check`, which a desktop workshop must not run — the app
 * owns `.cinna-kit/`.
 */
const REFRESH_CHECK_FILE = '.last_refresh_check'

/**
 * Written into every tree this app installs, holding the kit `VERSION` it
 * installed. A complete tree without it is a kit the user downloaded, and is
 * never touched; with it, the tree is ours to keep current.
 */
const DESKTOP_INSTALL_MARKER = '.desktop_install'

/**
 * Roots this process has installed the kit into. A tree of ours with another
 * kit hash is replaced at most once per root per process, so two
 * builds sharing one home (a dev build and the installed release) cannot swap
 * the tree back and forth on every `ensureHome`.
 */
const kitInstalledThisProcess = new Set<string>()

/**
 * Roots whose install failed in this process. Tried again only on the next
 * launch: a folder that refuses the copy would otherwise be copied into, and
 * warned about, on every `ensureHome`.
 */
const kitInstallFailedThisProcess = new Set<string>()

/** How stale the stamp may get before a sync pass touches it again. */
const REFRESH_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Label of the home root in the sidebar. */
const DEFAULT_HOME_LABEL = 'Agents'

/** A tree's `VERSION` (the kit hash), trimmed; null when missing or empty. */
function readKitVersion(kitDir: string): string | null {
  try {
    const version = readFileSync(join(kitDir, KIT_VERSION_FILE), 'utf8').trim()
    return version === '' ? null : version
  } catch {
    return null
  }
}

/** The bundled kit's `VERSION`, read once per process and bundle path. */
let bundledKitVersionMemo: { dir: string; version: string | null } | null = null

function bundledKitVersion(bundledDir: string): string | null {
  if (bundledKitVersionMemo?.dir !== bundledDir) {
    const version = readKitVersion(bundledDir)
    if (version === null) {
      logger.warn('the bundled kit has no readable VERSION; workshop copies update on contract version only', {
        bundledDir
      })
    }
    bundledKitVersionMemo = { dir: bundledDir, version }
  }
  return bundledKitVersionMemo.version
}

/**
 * `time.strftime("%Y-%m-%dT%H:%M:%S%z") + "\n"` — what `kit.py` writes into
 * `.last_refresh_check`: local time, offset without a colon (`+0200`).
 */
function refreshCheckStamp(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}\n`
  )
}

/**
 * Keep the root `AGENTS.md` freshness rule quiet: write the stamp when `force`
 * (just installed), or when it is missing or older than a day. One `stat` on
 * the hot path. A failure only means the rule may fire, so it is swallowed.
 */
function touchRefreshCheck(kitDir: string, force: boolean): void {
  const path = join(kitDir, REFRESH_CHECK_FILE)
  if (!force) {
    try {
      if (Date.now() - statSync(path).mtimeMs < REFRESH_CHECK_MAX_AGE_MS) return
    } catch {
      /* missing: write it */
    }
  }
  try {
    writeFileSync(path, refreshCheckStamp(new Date()))
  } catch (err) {
    logger.debug('could not write the kit refresh stamp', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Remove staging trees an interrupted install left in the root, including a
 * `.previous` tree `swapInto` parked there.
 */
function removeStaleStaging(rootPath: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(rootPath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(KIT_STAGING_PREFIX)) continue
    try {
      rmSync(join(rootPath, entry.name), { recursive: true, force: true })
    } catch (err) {
      // Left for the next install to retry; never a reason to skip this one.
      logger.debug('could not remove a stale kit staging tree', {
        name: entry.name,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** How many agent folders a root currently holds. Cheap: one directory read. */
function countAgents(rootPath: string): number {
  try {
    return readdirSync(join(rootPath, AGENTS_SUBDIR), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith('.')
    ).length
  } catch {
    return 0
  }
}

/**
 * How many bare agents an external root holds, and how many of those the user
 * removed from the list.
 *
 * This walks rather than counting directory entries, because an external root's
 * agents are not its immediate children — they are wherever an instructions
 * file (`AGENT.md`, `AGENTS.md`, `CLAUDE.md`) is,
 * up to {@link BARE_AGENT_MAX_DEPTH}. The hidden count is what lets Settings
 * offer them back: without it, "remove from list" is a one-way door with no
 * sign that it happened.
 */
function countBareAgents(row: AgentRootRow): {
  total: number
  hidden: number
  truncated: boolean
} {
  // Names are not needed for a count, and this runs for every registered root
  // on every `local-agent:list` — see the `withNames` note in `externalScan`.
  // `keep` is the scan's own, so this count agrees with what the scan indexes.
  // It is keyed on the row's owner because this has no other user to ask about.
  const { found, truncated } = discoverBareAgents(row.path, undefined, {
    withNames: false,
    keep: scannerService.knownBareAgentFilter(row.userId, row.id)
  })
  let hidden = 0
  for (const folder of found) {
    if (desktopStateService.read(folder.path, 'bare').hidden) hidden += 1
  }
  return { total: found.length - hidden, hidden, truncated }
}

function toDto(row: AgentRootRow): AgentRootDto {
  const kind: AgentRootKind = row.kind === 'external' ? 'external' : 'workshop'
  // **The scan is the single source for "how many agents".**
  //
  // `list()` serves agents from the scan cache precisely because re-walking
  // every folder on every call blocked the main thread, and the renderer
  // refetches on every watcher push. Counting here independently put the walk
  // straight back — plus one state read per agent — for the row two lines
  // below the agents it had just avoided re-reading. It also gave the settings
  // row its own answer to a question the scan had already answered, which is
  // how the two could come to disagree.
  //
  // The fallback is for a root that has never been scanned in this process; it
  // is the cold path, and it is the cheap version (`withNames: false`).
  const cached =
    kind === 'external' ? scannerService.cachedScan(row.id, row.path) : null
  const counts = cached
    ? { total: cached.agents.length, hidden: cached.hiddenCount, truncated: cached.truncated }
    : kind === 'external' && isDirectory(row.path)
      ? countBareAgents(row)
      : { total: countAgents(row.path), hidden: 0, truncated: false }
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    isDefault: row.isDefault,
    kind,
    exists: isDirectory(row.path),
    isGitRepo: looksLikeGitRepo(row.path),
    agentCount: counts.total,
    hiddenAgentCount: counts.hidden,
    truncated: counts.truncated,
    // Per root, not per app: a workshop that carries its own `.cinna-kit/`
    // runs on that copy, so Settings must report what this root resolves
    // rather than what the app bundles. An external root has no `.cinna-kit/`
    // and never gains one, so it reports the bundled version — which is the
    // honest answer to "what contract is in play here": none of it applies.
    contractVersion: getContractVersion(row.path),
    createdAt: row.createdAt.getTime()
  }
}

export const agentsHomeService = {
  /** The path a fresh install would use, for the settings screen's hint. */
  defaultHomePath,

  /** Where the home is, without creating anything. See `homePath.ts`. */
  homePath: configuredHomePath,

  /**
   * Resolve the home, create it if it is missing, register it, and make sure
   * its templates and `.cinna-kit/` copy are in place. Idempotent.
   *
   * **Refuses with `home_consent_required`** while the user has not been told
   * about a guarded home — see `homeAccessService`. The refusal is here, at the
   * one function every read and write path goes through, rather than at the
   * handful of call sites that happen to be user-facing today: a new caller
   * that forgets the rule gets an error, not a permission prompt in front of
   * someone who has no idea what it is for.
   */
  ensureHome(userId: string): AgentRootRow {
    if (homeAccessService.mustAsk(userId)) {
      throw new LocalAgentError(
        'home_consent_required',
        'The agents folder has not been set up yet.'
      )
    }
    const path = configuredHomePath()
    const existing = agentRootRepo.getDefault(userId)

    let row: AgentRootRow
    if (!existing) {
      // A root may already be registered at this path as a non-default one (the
      // user adopted it, then pointed the home setting at it). Reuse it rather
      // than tripping the unique index.
      const adopted = agentRootRepo.getByPath(userId, path)
      row =
        adopted ??
        agentRootRepo.create(userId, { path, label: DEFAULT_HOME_LABEL, isDefault: true })
      if (adopted) {
        logger.info('adopting an existing root as the agents home', { rootId: adopted.id })
      }
    } else if (existing.path !== path) {
      logger.info('agents home moved', { rootId: existing.id })
      row =
        agentRootRepo.updatePath(userId, existing.id, path, DEFAULT_HOME_LABEL) ?? existing
      // Deliberately *not* pruned. The agents at the old location are not gone
      // — the setting moved. Pruning here cascades `a2a_sessions` and
      // `job_agents` away, so pointing the home elsewhere and back would lose
      // every agent's engine session while the folders sat untouched on disk.
      // The scan of the new path re-indexes what is there, and the prune it
      // runs is scoped to the root's current path, so rows under the old one
      // are left for a later return rather than destroyed.
    } else {
      row = existing
    }

    this.installRoot(row.path)
    return row
  },

  /**
   * Create the home for the first time, with the user's answer in hand.
   *
   * The counterpart to {@link ensureHome}'s refusal, and the only way past it.
   * Two steps in a deliberate order: `homeAccessService.grant` makes the
   * directory **asynchronously**, so the macOS prompt waits on a threadpool
   * thread instead of freezing the window; then `ensureHome` does its
   * synchronous scaffolding, which by then writes into a folder this app is
   * already allowed into and so never waits on anything.
   *
   * Reports `denied` rather than throwing it. Being refused is an answer to a
   * question the app asked, and what follows is a different question — where
   * else the agents should live — not an error to display.
   */
  async prepare(userId: string): Promise<AgentsHomeState> {
    const state = await homeAccessService.grant()
    if (state.access !== 'ready') return state
    try {
      this.ensureHome(userId)
    } catch (err) {
      if (err instanceof LocalAgentError && err.code === 'home_access_denied') {
        return { ...state, access: 'denied' }
      }
      throw err
    }
    return state
  },

  /**
   * Create the folder if needed, install the root templates, and keep
   * `.cinna-kit/` in step with the bundled kit. Safe to re-run.
   */
  installRoot(rootPath: string): void {
    try {
      scaffoldService.installRootTemplates(rootPath)
    } catch (err) {
      logger.error('could not install the root templates', { error: err })
      const code = (err as NodeJS.ErrnoException).code
      // A refusal, not a failure. macOS answers a write into a guarded folder
      // it has been told to block with `EPERM` — no prompt, no delay — and the
      // only fixes are a different folder or a switch in System Settings, both
      // of which the app can offer once it knows which of the two happened.
      if (code === 'EPERM' || code === 'EACCES') {
        throw new LocalAgentError(
          'home_access_denied',
          'Cinna is not allowed to write to the agents folder.',
          err instanceof Error ? err.message : String(err)
        )
      }
      throw new LocalAgentError(
        'write_failed',
        'Could not set up the agents folder.',
        err instanceof Error ? err.message : String(err)
      )
    }
    this.syncWorkshopKit(rootPath)
  },

  /**
   * Put the kit into `<root>/.cinna-kit/` where it is missing or broken, and
   * keep the copies this app installed current. An assistant opening the
   * folder reads its rules, guides and `tools/kit.py` from there, so a workshop
   * without them — or with only the contract, as older builds installed — is a
   * workshop whose builder steps point at files that are not there.
   *
   * Decided in this order:
   *
   * 0. **A strictly newer contract → never touched**, marked or not, complete
   *    by today's layout or not: a newer core may lay its kit out differently,
   *    and `contractStore` prefers that copy. The version is read as
   *    `contractStore` and `kit.py` read it — `kit.json`, then
   *    `CONTRACT_VERSION`.
   * 1. **Missing or broken → install.** Broken is any of: no readable contract
   *    version, no `kit.json`, no `VERSION`, `README.md`, `tools/kit.py` or `guides/`. That
   *    is a fresh workshop, an old contract-only copy, or a damaged tree. A few
   *    `stat`s, on a hot path — `ensureHome` runs on `list`, `rescan`,
   *    `listRoots`, `create` and `requireRoot`.
   * 2. **Complete, without {@link DESKTOP_INSTALL_MARKER} → never touched.**
   *    The user downloaded it (`kit.py refresh`, the CLI), or it came with an
   *    adopted workshop, possibly from a self-hosted or newer core; replacing
   *    it with this build's public-cloud render would undo their kit. Whatever
   *    its contract version: the app reads its bundled contract regardless, and
   *    overlaying an older tree would only mix two kits. No stamp either.
   * 3. **Complete, with the marker → ours.** A `VERSION` other than the
   *    bundled one is reinstalled, at most once per root per process: two
   *    builds sharing one home (a dev build and the installed release) bundle
   *    different hashes, and without the limit each would reinstall on every
   *    call. Else it is up to date — no copy, no cache invalidation.
   *
   * An install is staged beside `.cinna-kit/` and swapped in whole, so a file
   * dropped upstream disappears too — `layout.json` declares `.cinna-kit`
   * replaced wholesale by a refresh and never edited by hand. The refresh stamp
   * is written on install and kept fresh on an up-to-date tree we own (see
   * {@link touchRefreshCheck}), never in a tree we do not. A failed install is
   * not fatal: the previous tree stays, and the app reads its bundled copy
   * regardless.
   */
  syncWorkshopKit(rootPath: string): void {
    const kitDir = join(rootPath, WORKSHOP_KIT_DIR)
    const installed = readVersionAt(kitDir)
    const installedKit = readKitVersion(kitDir)
    const complete =
      installed !== null &&
      installedKit !== null &&
      isRegularFile(join(kitDir, 'kit.json')) &&
      isRegularFile(join(kitDir, 'README.md')) &&
      isRegularFile(join(kitDir, 'tools', 'kit.py')) &&
      isDirectory(join(kitDir, 'guides'))
    const bundledVersion = resolveContract().version
    // A strictly newer contract is never ours to replace, complete by today's
    // layout or not: a newer core may lay its kit out differently, and
    // `contractStore` prefers that copy.
    if (installed !== null && compareVersionStrings(installed, bundledVersion) > 0) return
    const bundled = getBundledContractDir()
    const bundledKit = bundledKitVersion(bundled)
    if (complete) {
      // A kit the user downloaded, or brought with an adopted workshop.
      if (!existsSync(join(kitDir, DESKTOP_INSTALL_MARKER))) return
      const stale =
        bundledKit === null
          ? compareVersionStrings(installed, bundledVersion) < 0
          : installedKit !== bundledKit
      // Once per process: another build sharing the home may have put its own
      // kit back since, and swapping on every call helps neither.
      if (!stale || kitInstalledThisProcess.has(rootPath)) {
        touchRefreshCheck(kitDir, false)
        return
      }
    }

    if (kitInstallFailedThisProcess.has(rootPath)) return
    removeStaleStaging(rootPath)
    let staging: string | null = null
    try {
      staging = mkdtempSync(join(rootPath, KIT_STAGING_PREFIX))
      cpSync(bundled, staging, { recursive: true })
      // `mkdtempSync` creates 0700; the tree should be as readable as the bundle.
      chmodSync(staging, statSync(bundled).mode & 0o777)
      writeFileSync(join(staging, DESKTOP_INSTALL_MARKER), `${bundledKit ?? ''}\n`)
      swapInto(staging, kitDir)
      staging = null
    } catch (err) {
      // Not fatal: the app reads its own bundled copy either way. The workshop
      // copy is a courtesy to whatever assistant opens the folder.
      kitInstallFailedThisProcess.add(rootPath)
      logger.warn('could not install the workshop kit copy', {
        error: err instanceof Error ? err.message : String(err)
      })
      if (staging) {
        try {
          rmSync(staging, { recursive: true, force: true })
        } catch {
          /* removed by the stale-staging sweep of the next install */
        }
      }
      return
    }
    // The tree under this root just changed; drop the cached resolution so the
    // next read sees it. Only reached when an install actually happened.
    kitInstalledThisProcess.add(rootPath)
    clearContractCache()
    touchRefreshCheck(kitDir, true)
    logger.info('workshop kit copy installed', {
      fromContract: installed ?? 'none',
      toContract: bundledVersion,
      fromKit: installedKit ?? 'none',
      toKit: bundledKit ?? 'unknown'
    })
  },

  /** Test-only reset of the once-per-process install memo. */
  _resetKitSync(): void {
    kitInstalledThisProcess.clear()
    kitInstallFailedThisProcess.clear()
  },

  /**
   * Attempt the home, reporting what happened instead of throwing it.
   *
   * The gate is on the **home**, never on the list. An earlier version let
   * `home_consent_required` escape as far as `list`, which answered with no
   * roots at all — so a user who dismissed the folder question and then adopted
   * their own workshop watched it register successfully and never appear
   * (`addRoot` does not go through here), and repointing the home setting
   * emptied a sidebar that had two roots in it a moment before. What is missing
   * while the question stands is one row, not the list.
   */
  tryEnsureHome(userId: string): AgentsHomeAccess {
    const path = configuredHomePath()
    // A refusal this process has already had. Re-attempting would be a second
    // `EPERM` per call for an answer we have; `homeAccessService.grant` is the
    // retry, and it is reached from a button.
    if (homeAccessService.refused(path)) return 'denied'
    try {
      this.ensureHome(userId)
      homeAccessService.clearRefusal()
      return 'ready'
    } catch (err) {
      if (err instanceof LocalAgentError && err.code === 'home_consent_required') {
        return 'needs_consent'
      }
      if (err instanceof LocalAgentError && err.code === 'home_access_denied') {
        homeAccessService.noteRefusal(path)
        return 'denied'
      }
      throw err
    }
  },

  /** Every registered root, home first, as the sidebar groups them. */
  listRoots(userId: string): AgentRootDto[] {
    this.tryEnsureHome(userId)
    return this.rootDtos(userId)
  },

  /** The raw rows, for the scanner and the watcher. */
  listRootRows(userId: string): AgentRootRow[] {
    this.tryEnsureHome(userId)
    return agentRootRepo.list(userId)
  },

  /**
   * The rows as they stand, with no attempt to create the home. See
   * {@link rootDtos}.
   */
  rootRows(userId: string): AgentRootRow[] {
    return agentRootRepo.list(userId)
  },

  /**
   * The roots as they stand, with no attempt to create the home.
   *
   * For a caller that has already run {@link tryEnsureHome} and holds its
   * answer — `list` does, and re-running it per accessor meant two or three
   * attempts, of which only the first was reported.
   */
  rootDtos(userId: string): AgentRootDto[] {
    return agentRootRepo
      .list(userId)
      .sort((a, b) =>
        a.isDefault === b.isDefault
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : a.isDefault
            ? -1
            : 1
      )
      .map(toDto)
  },

  /**
   * Absolute paths of every registered root. This is what Phase 4's "open in…"
   * guard allows a folder to live under, so it must stay exactly the set of
   * folders this feature owns — never a user-supplied path that was not
   * registered.
   *
   * Deliberately does *not* call `ensureHome`: it is invoked from a launcher
   * path where creating directories as a side effect would be surprising, and
   * where a failure must simply mean "nothing is allowed".
   */
  rootPaths(userId: string): string[] {
    try {
      return agentRootRepo.list(userId).map((row) => row.path)
    } catch (err) {
      logger.error('could not list the agents roots', { error: err })
      return []
    }
  },

  /** The root a rootId names, or the home when none is given. */
  requireRoot(userId: string, rootId?: string): AgentRootRow {
    if (!rootId) return this.ensureHome(userId)
    const row = agentRootRepo.getOwned(userId, rootId)
    if (!row) {
      throw new LocalAgentError('root_not_found', 'That agents folder is not registered.')
    }
    return row
  },

  /**
   * The same lookup, for callers where "no id" is a **bug and not a default**.
   *
   * {@link requireRoot} treats a falsy id as "the agents home", and
   * `ensureHome` *creates* that directory rather than reporting it missing.
   * That is load-bearing for `create` and the other home-defaulting callers,
   * and is deliberately left alone.
   *
   * It is wrong for anything that acts on a *named* root. A malformed payload —
   * a renderer bug, a stale preload after a hot reload — would not fail; it
   * would silently retarget the home. For the git channels that means running
   * `fetch` and `merge --ff-only` in a working tree nobody named, and this
   * feature is precisely the reason a user might have put their agents home
   * under version control. Even the read path is not free: it can scaffold
   * `~/Documents/CinnaAgents` on a machine where the user deliberately had
   * none, as a side effect of rendering a settings screen.
   *
   * @throws LocalAgentError `root_not_found`
   */
  requireNamedRoot(userId: string, rootId: unknown): AgentRootRow {
    if (typeof rootId !== 'string' || rootId === '') {
      throw new LocalAgentError('root_not_found', 'No agents folder was named.')
    }
    return this.requireRoot(userId, rootId)
  },

  /**
   * True when a folder can be adopted without writing template files over
   * something the user already has there. A folder that is empty, or that
   * already looks like a workshop, needs no confirmation; anything else does.
   */
  needsAdoptionConfirmation(path: string): boolean {
    if (isDirectory(join(path, AGENTS_SUBDIR))) return false
    try {
      return readdirSync(path).some((name) => name !== '.DS_Store')
    } catch {
      // Does not exist yet, or cannot be listed — nothing to overwrite.
      return false
    }
  },

  /**
   * Reject a root that overlaps one already registered, in either direction.
   *
   * Nesting is not a tidiness problem. A root is handed to Phase 4's "open in…"
   * guard as an allowed area, so adopting `~/Documents` — the parent of the
   * default home — would make every folder beneath it openable by anything that
   * can reach that IPC. The guard is careful, but it is only ever as good as
   * the roots it is given, and nothing else validates those.
   *
   * Overlap also makes two roots claim the same agent folders, which sets the
   * per-root scoping in `pruneFolderRows` against itself: each scan would see
   * the other's agents as absent.
   *
   * **Known gap, pre-dating bare agents:** the comparison is textual, so a
   * symlink pointing at a registered root is adoptable and the same folders
   * then index twice under two roots with two id schemes. Fixing it means
   * `realpath`ing **both sides** — the stored roots as well as the candidate,
   * since resolving only the candidate leaves the mirror case open, where it is
   * the *stored* root that is the symlinked path. It touches the workshop path
   * as much as the external one, which is why it is its own change.
   *
   * @throws LocalAgentError `invalid_path`
   */
  assertNotOverlapping(userId: string, path: string): void {
    for (const root of agentRootRepo.list(userId)) {
      if (isWithin(root.path, path)) {
        throw new LocalAgentError(
          'invalid_path',
          `That folder is already inside your "${root.label}" agents folder.`
        )
      }
      if (isWithin(path, root.path)) {
        throw new LocalAgentError(
          'invalid_path',
          `That folder contains your "${root.label}" agents folder. Pick the folder itself, or one beside it.`
        )
      }
    }
  },

  /**
   * Adopt an existing folder as an extra root. The path is validated against
   * the path rules first — it arrives from outside, and is never trusted as a
   * filesystem location — and then against the roots already registered.
   */
  addRoot(userId: string, rawPath: string, label?: string): AgentRootDto {
    const path = assertUsableRoot(rawPath)
    const existing = agentRootRepo.getByPath(userId, path)
    if (existing) return toDto(existing)

    this.assertNotOverlapping(userId, path)
    this.installRoot(path)
    const row = agentRootRepo.create(userId, {
      path,
      label: label?.trim() || basename(path),
      isDefault: false
    })
    logger.info('agents root added', { rootId: row.id, agentCount: countAgents(path) })
    return toDto(row)
  },

  /**
   * Register a folder as an **external** root: walked for instruction files, never
   * written into.
   *
   * The three things `addRoot` does that this deliberately does not: install
   * the root templates, copy `.cinna-kit/`, and create `Local/`. That is the
   * whole promise of this shape — the user points at a folder they already own
   * and it is read, not converted. A repository shared with other people must
   * not gain five files because it was opened here.
   *
   * Everything else is identical, and identical on purpose: the same path
   * rules, and the same overlap refusal. Overlap matters *more* here, not less
   * — every registered root becomes an allowed area for the "open in…" path
   * guard, and an external root is by definition somewhere outside the agents
   * home, so it is the one the user is most likely to point at a parent of.
   *
   * An already-registered path is returned as-is rather than duplicated, which
   * makes adopting the same folder twice a no-op the user can repeat safely.
   */
  addExternalRoot(userId: string, rawPath: string, label?: string): AgentRootDto {
    const path = assertUsableRoot(rawPath)
    const existing = agentRootRepo.getByPath(userId, path)
    if (existing) return toDto(existing)

    this.assertNotOverlapping(userId, path)
    const row = agentRootRepo.create(userId, {
      path,
      label: label?.trim() || basename(path),
      isDefault: false,
      kind: 'external'
    })
    logger.info('external agents folder added', { rootId: row.id })
    return toDto(row)
  },

  /**
   * Forget an extra root. The folder on disk is never touched — only the index
   * rows for its agents are dropped, in one transaction. The home cannot be
   * removed: it is where the New Agent button writes.
   */
  removeRoot(userId: string, rootId: string): { pruned: number } {
    const row = agentRootRepo.getOwned(userId, rootId)
    if (!row) {
      throw new LocalAgentError('root_not_found', 'That agents folder is not registered.')
    }
    if (row.isDefault) {
      throw new LocalAgentError(
        'root_immutable',
        'This is your main agents folder. Change its location in Settings instead of removing it.'
      )
    }
    const pruned = agentRepo.pruneFolderIndexForRoot(userId, rootId)
    agentRootRepo.delete(userId, rootId)
    logger.info('agents root removed', { rootId, pruned })
    return { pruned }
  }
}
