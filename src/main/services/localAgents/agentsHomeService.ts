/**
 * The agents home and the extra roots.
 *
 * A **root** is a workshop folder: it holds `Local/` (one directory per agent),
 * `Cloud/`, the root markdown files, and `.cinna-kit/` — the contract copy that
 * lets a coding assistant working in the folder read the same rules the desktop
 * reads. Exactly one root is the *home*: `~/Documents/CinnaAgents` unless the
 * `localAgentsHome` app setting says otherwise. Any number of extra roots can be
 * adopted, which is how an existing kit workshop joins the app unchanged.
 *
 * Everything here is idempotent and lazy. `ensureHome()` is safe to call on
 * every request: it creates what is missing, leaves alone what already exists
 * (every root file is `survives_update: true` in the contract's layout), and
 * touches the disk only for the pieces that are actually absent.
 *
 * The configured home is **validated on every read** rather than trusted.
 * `localAgentsHome` reaches the store through the generic `settings:set`
 * channel, which type-checks but cannot know what a plausible agents folder is;
 * a value that fails {@link assertUsableRoot} falls back to the default instead
 * of becoming a directory this app writes into.
 */

import { cpSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { agentRootRepo, type AgentRootRow } from '../../db/agentRoots'
import { agentRepo } from '../../db/agents'
import { appSettingsRepo } from '../../db/appSettings'
import {
  clearContractCache,
  getBundledContractDir,
  getContractVersion,
  resolveContract
} from '../../kit/contractStore'
import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { compareVersionStrings } from '../../../shared/kit/contractVersion'
import { AGENTS_SUBDIR, type AgentRootDto } from '../../../shared/localAgents'
import { assertUsableRoot, isWithin } from './pathRules'
import { scaffoldService } from './scaffoldService'

const logger = createLogger('local-agents-home')

/** Where a fresh install puts the agents home. */
const DEFAULT_HOME_DIRS = ['Documents', 'CinnaAgents']

/** Folder a workshop keeps its copy of the contract in, per `layout.json`. */
const WORKSHOP_KIT_DIR = '.cinna-kit'

/** Label of the home root in the sidebar. */
const DEFAULT_HOME_LABEL = 'Agents'

function defaultHomePath(): string {
  return join(homedir(), ...DEFAULT_HOME_DIRS)
}

/**
 * The configured home, or the default. A configured path that no longer passes
 * the path rules is reported and ignored — the user keeps a working app rather
 * than an app that refuses to open its Agents tab.
 */
function configuredHomePath(): string {
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
 * The `contract_version` of the copy installed in a workshop, or null when
 * there is none. Reads `kit.json` directly rather than going through
 * `resolveContract`, whose answer is "which copy wins", not "what is installed".
 */
function readInstalledContractVersion(kitDir: string): string | null {
  try {
    const kit = JSON.parse(readFileSync(join(kitDir, 'kit.json'), 'utf8')) as Record<
      string,
      unknown
    >
    return typeof kit.contract_version === 'string' ? kit.contract_version : null
  } catch {
    return null
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

function toDto(row: AgentRootRow): AgentRootDto {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    isDefault: row.isDefault,
    exists: isDirectory(row.path),
    agentCount: countAgents(row.path),
    // Per root, not per app: a workshop that carries its own `.cinna-kit/`
    // runs on that copy, so Settings must report what this root resolves
    // rather than what the app bundles.
    contractVersion: getContractVersion(row.path),
    createdAt: row.createdAt.getTime()
  }
}

export const agentsHomeService = {
  /** The path a fresh install would use, for the settings screen's hint. */
  defaultHomePath,

  /**
   * Resolve the home, create it if it is missing, register it, and make sure
   * its templates and `.cinna-kit/` copy are in place. Idempotent.
   */
  ensureHome(userId: string): AgentRootRow {
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
   * Create the folder if needed, install the root templates, and keep
   * `.cinna-kit/` populated from the bundled contract. Safe to re-run.
   */
  installRoot(rootPath: string): void {
    try {
      scaffoldService.installRootTemplates(rootPath)
    } catch (err) {
      logger.error('could not install the root templates', { error: err })
      throw new LocalAgentError(
        'write_failed',
        'Could not set up the agents folder.',
        err instanceof Error ? err.message : String(err)
      )
    }
    this.syncWorkshopContract(rootPath)
  },

  /**
   * Copy the bundled contract into `<root>/.cinna-kit/` when the workshop has
   * none, or has an older one. An assistant opening the folder reads its rules
   * from there, so a workshop without it is a workshop whose conventions are
   * invisible.
   *
   * A workshop copy at the same version or newer is left alone — `contractStore`
   * prefers a newer one deliberately, and overwriting either would undo a
   * contract refresh, or an edit someone made in the folder.
   */
  syncWorkshopContract(rootPath: string): void {
    const kitDir = join(rootPath, WORKSHOP_KIT_DIR)
    // `resolveContract` picks the workshop copy over the bundled one only when
    // it is *strictly newer* at the same major, so "is the workshop copy in
    // use?" is the wrong question — for the normal case, equal versions, the
    // answer is no and the copy would run on every call.
    //
    // That mattered for two reasons. `ensureHome` is on the path of `list`,
    // `rescan`, `listRoots`, `create` and `requireRoot`, so a recursive copy
    // plus a `clearContractCache()` ran on nearly every request, defeating the
    // contract cache entirely. And `cpSync(force)` silently reverted any local
    // edit inside `<root>/.cinna-kit/` — which an assistant working in the
    // workshop is entitled to make.
    const installed = readInstalledContractVersion(kitDir)
    const bundledVersion = resolveContract().version
    if (installed !== null && compareVersionStrings(installed, bundledVersion) >= 0) {
      // Same version, or a newer one a refresh pulled down. Nothing to do, and
      // nothing to invalidate.
      return
    }

    const bundled = getBundledContractDir()
    try {
      cpSync(bundled, kitDir, { recursive: true, force: true })
    } catch (err) {
      // Not fatal: the app reads its own bundled copy either way. The workshop
      // copy is a courtesy to whatever assistant opens the folder.
      logger.warn('could not install the workshop contract copy', {
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }
    // The tree under this root just changed; drop the cached resolution so the
    // next read sees it. Only reached when a copy actually happened.
    clearContractCache()
    logger.info('workshop contract copy installed', {
      from: installed ?? 'none',
      to: bundledVersion
    })
  },

  /** Every registered root, home first, as the sidebar groups them. */
  listRoots(userId: string): AgentRootDto[] {
    this.ensureHome(userId)
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

  /** The raw rows, for the scanner and the watcher. */
  listRootRows(userId: string): AgentRootRow[] {
    this.ensureHome(userId)
    return agentRootRepo.list(userId)
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
