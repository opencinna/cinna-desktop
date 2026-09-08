/**
 * The folder-agent surface the IPC layer talks to.
 *
 * The pieces around it each do one thing — `agentsHomeService` owns roots,
 * `scaffoldService` creates folders, `scannerService` turns folders into rows,
 * `watcherService` notices outside edits — and this is where they are composed
 * into the operations the Agents tab actually performs.
 *
 * Two rules concentrate here because they are cross-cutting:
 *
 * * **Invariant 3, both halves.** A write takes the per-agent turn lock, so the
 *   desktop never edits a folder mid-stream, and it goes through a
 *   modified-underneath stamp, so it never overwrites what an assistant changed
 *   while the editor was open. The stamp is supplied by the caller — the value
 *   the page last read — because a stamp taken here, microseconds before the
 *   write, would guard nothing.
 * * **Files are the truth.** Every mutation ends by rescanning the folder it
 *   touched and returning what the folder now says, rather than echoing back
 *   what the caller sent.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, sep } from 'node:path'
import { shell } from 'electron'
import { a2aSessionRepo, agentRepo, type FolderIndexEntry } from '../../db/agents'
import { jobAgentRepo, jobsRepo } from '../../db/jobs'
import { rebuildJobManifest } from '../../sync/manifest'
import { synthesizeFolderAgentMetadata } from './folderAgentMetadata'
import type { AgentRootRow } from '../../db/agentRoots'
import { getLayoutView, getTemplateRoot, resolveContract } from '../../kit/contractStore'
import {
  manifestPath,
  readStamp,
  readWithStamp,
  stampsMatch,
  writeIfUnchanged
} from '../../kit/manifestIo'
import { sha256Hex } from '../../kit/hash'
import { isIgnoredPath, validateAgentFolder } from '../../kit/validator'
import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { MANIFEST_FILE } from '../../../shared/kit/manifest'
import { AGENT_INIT_ENTRY_FILES, buildAgentInitPrompt } from '../../../shared/agentInitPrompt'
import {
  describedAs,
  BARE_AGENT_PROMPT_FILE,
  BARE_AGENT_README_FILE,
  FOLDER_AGENT_ID_PREFIX,
  FOLDER_AGENT_SOURCE,
  externalFolderAgentId,
  folderAgentId,
  isFolderAgentId,
  LOCAL_AGENT_DOC_PATHS,
  LOCAL_AGENT_PROMPT_PATHS,
  type AddAgentFolderInput,
  type AddAgentFolderResult,
  type AgentRootDto,
  type CreateLocalAgentInput,
  type DeleteLocalAgentInput,
  type DeleteLocalAgentResult,
  type DiscoveredBareAgent,
  type PickAgentFolderResult,
  type FileStamp,
  type LocalAgentDocDto,
  type LocalAgentDocKind,
  type LocalAgentDto,
  type LocalAgentKind,
  type LocalAgentValidation,
  type OpenLocalAgentCredentialsResult,
  type OpenLocalAgentPathInput,
  type RescanResult,
  type UpdateLocalAgentFieldInput
} from '../../../shared/localAgents'
import type { LocalAgentRuntimeInput } from '../../../shared/engine'
import { desktopStatePath, desktopStateService } from './desktopStateService'
import { discoverBareAgents } from './externalScan'
import { isWithin } from './pathRules'
import { setAllowedRootsProvider } from './openInService'
import { agentsHomeService } from './agentsHomeService'
import { scaffoldService } from './scaffoldService'
import { ENV_FILE, scannerService } from './scannerService'
import { turnLock } from './turnLock'
import { watcherService } from './watcherService'
import { resolveWithinRoot } from './pathRules'
import { runtimeService } from './runtimeService'
import { permissionGrantService, type StoredPermissionGrant } from './permissionGrantService'

const logger = createLogger('local-agents')

/** Longest a prompt document may be. Generous; a guard, not a design limit. */
const MAX_PROMPT_BYTES = 512 * 1024

/**
 * Agent-relative paths of the three document-backed prompts. The same table the
 * scanner stamps and the page's editors look their stamp up in — one copy, in
 * `src/shared/localAgents.ts`, because a disagreement between them would send
 * the manifest's stamp to guard a prompt document.
 */
const PROMPT_PATHS = LOCAL_AGENT_PROMPT_PATHS

export interface LocalAgentListResult {
  roots: AgentRootDto[]
  agents: LocalAgentDto[]
}

/**
 * Atomic write of a text file, refusing when the file no longer matches the
 * stamp the caller read. The prompt-document counterpart of
 * `manifestIo.writeIfUnchanged`, which only speaks JSON.
 *
 * The comparison is `manifestIo.stampsMatch` itself, not a local re-implementation.
 * Metadata is only a pre-check — a second writer that replaces a file at equal
 * size with preserved timestamps (`cp -p`, `rsync -t`, `git checkout`, a backup
 * restore, an editor that restores mtime) passes it — so the SHA-256 of the bytes
 * is what decides. These are the files an assistant is *most* likely to be editing
 * while the user has the page open: concurrent editing of the prompt documents is
 * the designed workflow, not an edge case.
 */
function writeTextIfUnchanged(path: string, contents: string, expected: FileStamp): void {
  const current = readStamp(path)
  if (!stampsMatch(current, expected)) {
    logger.warn('refusing to overwrite a file that changed underneath', {
      file: basename(path)
    })
    // A distinct code, not `invalid_input`: the page has to tell "you typed
    // something unusable" apart from "an assistant edited this while you had
    // it open" to know whether to show a reload prompt. The manifest's
    // counterpart is `KitError('manifest_modified')`; both are listed in
    // `STALE_WRITE_ERROR_CODES`.
    throw new LocalAgentError(
      'file_modified',
      'This file changed on disk since you opened it. Reload before saving.',
      path
    )
  }
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(temp, 'w')
    writeSync(fd, contents)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, path)
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* the write already failed; the close error adds nothing */
      }
    }
    try {
      unlinkSync(temp)
    } catch {
      /* the temp file may never have been created */
    }
    logger.error('failed to write an agent file', { file: basename(path), error: err })
    throw new LocalAgentError(
      'write_failed',
      'Could not save that file.',
      err instanceof Error ? err.message : String(err)
    )
  }
}

function requireString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') {
    throw new LocalAgentError('invalid_input', `${label} must be text.`)
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new LocalAgentError('invalid_input', `${label} cannot be empty.`)
  }
  if (trimmed.length > max) {
    throw new LocalAgentError('invalid_input', `${label} is too long (max ${max} characters).`)
  }
  return trimmed
}

function optionalString(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new LocalAgentError('invalid_input', `${label} must be text.`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > max) {
    throw new LocalAgentError('invalid_input', `${label} is too long (max ${max} characters).`)
  }
  return trimmed
}

let started = false

/**
 * Rebuild the synced dependency manifest of every job attached to a folder
 * agent that has just been re-keyed.
 *
 * A job carries its dependencies as portable descriptors in `jobs.sync_deps`,
 * and a folder agent's descriptor is keyed on its **manifest id**. "Stamp
 * identity" changes that id — `folder:legacy:<rootId>:<name>` becomes
 * `folder:<uuid>` — and `rekeyFolderRow` moves the `job_agents` join rows with
 * it, but nothing rebuilt the manifests. The stored descriptor then named an id
 * no row has, so the origin device reported "needs setup" about an agent
 * sitting right there and working, with no action available that would clear
 * it; and the next edit to the job re-emitted **both** descriptors, since the
 * old and new ids produce different `agentIdentityKey`s and `remember()`'s
 * dedupe compares keys. The ghost has no join row and never will, so every
 * later rebuild carried it forward and every peer received it.
 *
 * The deeper cause is worth stating because it will recur: the carry-forward in
 * `buildJobManifest` was written for remote agents, whose `remoteTargetId` is a
 * backend UUID that never changes — so a carried-forward remote descriptor can
 * be stale about *reachability* but never about *identity*. A folder agent's
 * manifest id is **mutable by design**; the app ships a button for changing it.
 * The carry-forward silently inherited "ids are stable" from the remote case.
 *
 * The owner id comes from each job rather than from this caller: a folder agent
 * is a settings-scope, machine-wide row while jobs are profile-scoped, so the
 * `userId` in hand here is the wrong one — passing it would make
 * `rebuildJobManifest` find no job and return silently, which is a fix that
 * looks applied and does nothing. It also means a second profile's jobs are
 * repaired too, rather than only the active one's.
 */
function rebuildManifestsForRekeyedAgent(oldAgentId: string, newAgentId: string): void {
  const staleManifestId = oldAgentId.slice(FOLDER_AGENT_ID_PREFIX.length)
  // Queried by the *new* id: `rekeyFolderRow` repoints the join rows before
  // returning, so by now these are the jobs that just moved.
  const refs = jobAgentRepo.listJobRefsForAgent(newAgentId)
  for (const ref of refs) {
    // Rebuilding alone is not enough, and the test for this says so: the
    // carry-forward in `buildJobManifest` re-adds any folder descriptor the
    // prior manifest held that has no join row — which after a rekey is
    // precisely the stale one. The rebuild would emit the new descriptor and
    // carry the old one back beside it, leaving a ghost that no later rebuild
    // can shed. So the stale descriptor is dropped from the stored manifest
    // first, and the rebuild then re-derives the dependency from the join row.
    //
    // This is a targeted repair, not a change to the carry-forward's policy:
    // the only descriptor removed is the previous identity of the one agent
    // that just moved, which is knowable *here* and nowhere else. Remote
    // descriptors, and folder descriptors for any other agent, are untouched.
    const job = jobsRepo.getById(ref.userId, ref.jobId)
    const prior = job?.syncDeps
    if (prior) {
      const kept = prior.deps.filter(
        (d) =>
          !(d.kind === 'agent' && d.source === 'folder' && d.manifestId === staleManifestId)
      )
      if (kept.length !== prior.deps.length) {
        jobsRepo.setSyncDeps(ref.userId, ref.jobId, { ...prior, deps: kept })
      }
    }
    rebuildJobManifest(ref.userId, ref.jobId)
  }
  if (refs.length > 0) {
    logger.info('rebuilt job manifests after a folder agent was stamped', {
      newAgentId,
      jobs: refs.length
    })
  }
}

/**
 * The `credentials/.env` a click has to be able to open when the file is not
 * there yet.
 *
 * The declared variable names are written **commented out**. An uncommented
 * `KEY=` is what the scanner counts as defined (`readEnvKeys` matches the name
 * and never the value), so seeding bare assignments would report every
 * credential as satisfied the moment the user opened the file — the opposite of
 * what the readiness strip is for.
 */
function credentialsSeed(agent: LocalAgentDto): string {
  const keys = agent.credentials.flatMap((slot) => slot.expectedKeys)
  // The name is manifest text and may legally hold a newline. Left in, a name
  // ending `\nVENDOR_PORTAL_TOKEN=` would define a variable in this file, and
  // `readEnvKeys` would report the slot satisfied over an empty value — the
  // exact failure the commented placeholders below are written to avoid.
  const name = agent.name.replace(/[\r\n]+/g, ' ')
  const lines = [
    `# Credentials for ${name}.`,
    '#',
    '# This file stays on this machine. Cinna reads which variable names are set',
    '# here and never their values.',
    '#',
    '# Fill a value in and remove the leading "#" from its line.',
    ''
  ]
  if (keys.length === 0) {
    lines.push('# This agent declares no credentials yet.')
  } else {
    for (const key of keys) lines.push(`# ${key}=`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Create `credentials/.env`, or explain why it must not be created.
 *
 * Order matters and each step is load-bearing: the folder is made first so
 * `resolveWithinRoot` has something to `realpath` (a path that does not exist
 * has no real path, and the check would refuse the agent's own folder wherever
 * that folder is reached through a symlink), the containment check then refuses
 * a `credentials` symlinked out of the agent, and `wx` refuses to follow a
 * dangling `.env` symlink to whatever it points at.
 *
 * The ignore guard is the reason this is not three lines. `checkSecrets` raises
 * `secrets.not_ignored` as a validator **error** for a `credentials/.env` no
 * `.gitignore` rule covers, an error makes `readiness()` `invalid`, and an
 * invalid agent is dropped from the engine config and refuses a turn. Creating
 * the file blindly would therefore let the click that exists to *fix* a missing
 * credential be the click that stops the agent running. A kit-scaffolded folder
 * ships the rule; where it is missing, the contract's own `credentials/.gitignore`
 * is installed rather than a fifth copy of the rule invented here, and a folder
 * whose ignore file deliberately un-ignores `.env` gets a refusal instead of a
 * committable secrets file.
 *
 * @returns whether this call created the file
 * @throws LocalAgentError `invalid_path`, `write_failed`
 */
function seedCredentialsFile(agentDir: string, rootPath: string, agent: LocalAgentDto): boolean {
  try {
    mkdirSync(join(agentDir, dirname(ENV_FILE)), { recursive: true })
  } catch (err) {
    throw new LocalAgentError(
      'write_failed',
      'The credentials folder could not be created.',
      err instanceof Error ? err.message : String(err)
    )
  }
  const target = join(resolveWithinRoot(agentDir, dirname(ENV_FILE)), basename(ENV_FILE))

  if (!isIgnoredPath(agentDir, ENV_FILE)) {
    const ignore = join(dirname(target), '.gitignore')
    if (!existsSync(ignore)) {
      try {
        copyFileSync(join(getTemplateRoot('agent', rootPath), 'credentials', '.gitignore'), ignore)
      } catch (err) {
        logger.warn('could not install the credentials .gitignore', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    if (!isIgnoredPath(agentDir, ENV_FILE)) {
      throw new LocalAgentError(
        'write_failed',
        'No .gitignore rule covers credentials/.env, so creating it would leave a secrets file committable. Add “.env” to credentials/.gitignore first.'
      )
    }
  }

  try {
    // `wx` so a file that appeared between the check and the write — the user's
    // own editor, the agent's scripts — is never overwritten, and so a dangling
    // symlink is refused rather than followed.
    writeFileSync(target, credentialsSeed(agent), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return true
  } catch (err) {
    if (existsSync(target)) return false
    throw new LocalAgentError(
      'write_failed',
      'credentials/.env could not be created.',
      err instanceof Error ? err.message : String(err)
    )
  }
}

/** `open -t <file>` — macOS's "open this in the default text editor". */
function openInTextEditor(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-t', target], { timeout: 15_000 }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/**
 * The folder the user last chose in the native picker, and when.
 *
 * Adopting a folder is two IPC calls — pick-and-preview, then confirm — so the
 * path has to travel out to the renderer and back. This is what keeps that from
 * being a way to name any folder on disk: `addAgentFolder` accepts only a path
 * equal to the one the picker last returned. Cleared on a successful adopt and
 * on a pick that was refused, so a stale record cannot authorise a later call.
 */
let pendingPick: { userId: string; path: string; at: number } | null = null

/**
 * Which kind of agent a root's folders are.
 *
 * The one place this feature turns a root into the value `desktopStateService`
 * and `permissionGrantService` need. It is derived from the **root row**, never
 * from a file in the folder: a probe for `cinna-agent.json` would move an
 * agent's sessions, token and standing grants the moment another writer added
 * or removed that file — one `git pull` away, with the update check beside this.
 */
function kindOf(root: AgentRootRow): LocalAgentKind {
  return root.kind === 'external' ? 'bare' : 'kit'
}

/**
 * Put a restored bare agent's engine sessions back into `a2a_sessions`.
 *
 * Removing an agent from the list drops its `agents` row — that *is* the
 * mechanism, since the row is what the counterparty pickers and `@`-mentions
 * read — and the FK cascade takes `a2a_sessions` with it. Putting the agent
 * back re-creates the row under the same positional id, so its chats re-bind
 * and look intact, and without this they would silently start a fresh engine
 * session: the conversation the model remembers is gone, with nothing on screen
 * connecting that to a removal the user has just undone.
 *
 * The loss is only in the index. `saveSession` writes the session id to **both**
 * `a2a_sessions` and the agent's own desktop state, and for a bare agent that
 * state lives under `userData` — so hiding never touched it and it is still the
 * durable copy Invariant 1 says the row is a cache of. This restores the cache
 * from it.
 *
 * A chat that has since been deleted is skipped rather than failing the
 * restore: `a2a_sessions.chat_id` cascades from `chats`, so an insert for a
 * missing chat throws, and one dead chat must not take the other agents with
 * it. `job_agents` has no such durable copy, which is why a job binding
 * genuinely cannot be restored and why the delete dialog says so.
 */
/**
 * What to call a bare agent folder: the user's own name for it, else what the
 * file or the folder says.
 *
 * The scanner's rule, in the one other place that has to answer the same
 * question — the folder picker, which lists agents the user may already have
 * renamed. Kept here rather than exported from the scanner because it is two
 * lines and the alternative was the picker quietly using a different order.
 */
function bareName(agentDir: string, fallback: string): string {
  const stored = desktopStateService.read(agentDir, 'bare').displayName
  return stored && stored.trim() !== '' ? stored.trim() : fallback
}

function reseedEngineSessions(userId: string, root: AgentRootRow, agentDir: string): void {
  const sessions = desktopStateService.read(agentDir, 'bare').sessions
  const entries = Object.entries(sessions)
  if (entries.length === 0) return
  const agentId = scannerService.scanBareAgentFolder(
    agentDir,
    root,
    relative(root.path, agentDir).split(sep).join('/') || '.'
  ).id
  if (!agentRepo.getOwned(userId, agentId)) return
  let seeded = 0
  for (const [chatId, session] of entries) {
    if (typeof session?.sessionId !== 'string' || session.sessionId === '') continue
    try {
      a2aSessionRepo.upsert({
        chatId,
        agentId,
        contextId: session.sessionId,
        taskId: null,
        taskState: null
      })
      seeded += 1
    } catch {
      /* the chat is gone; its session has nothing to attach to */
    }
  }
  if (seeded > 0) logger.info('restored engine sessions for a bare agent', { agentId, seeded })
}

export const localAgentService = {
  /**
   * Wire the feature up: hand Phase 4's "open in…" guard the real roots, give
   * the watcher its scanner callbacks. Called once, from the IPC registrar —
   * the composition root for this slice — and safe to call again.
   *
   * Until this runs, `openInService` refuses every request by design, so the
   * order matters: nothing may open a folder before the roots are known.
   */
  configure(getUserId: () => string): void {
    if (started) return
    started = true

    setAllowedRootsProvider(() => agentsHomeService.rootPaths(getUserId()))

    watcherService.configure({
      rescanRoot: (root) => {
        scannerService.markRootDirty(root.id)
        scannerService.scanRoot(getUserId(), root)
      },
      rescanAgent: (root, agentDir) => {
        // The folder changed, so whatever the cache holds for this root is out
        // of date — even though only one agent is re-read here.
        scannerService.markRootDirty(root.id)
        localAgentService.reindexAgent(getUserId(), root, agentDir)
      },
      agentIdForPath: (agentDir) => {
        const row = agentRepo
          .listFolder(getUserId())
          .find((candidate) => candidate.localPath === agentDir)
        return row?.id ?? null
      },
      agentIdsForRoot: (root) =>
        agentRepo
          .listFolder(getUserId())
          .filter((row) => row.localRootId === root.id)
          .map((row) => row.id)
    })
    logger.info('local agents configured')
  },

  /** Every root and every folder agent in them. */
  list(userId: string): LocalAgentListResult {
    const roots = agentsHomeService.listRootRows(userId)
    const agents: LocalAgentDto[] = []
    for (const root of roots) {
      // Cached: the watcher is what notices a change, and it marks the root
      // dirty. Re-walking every folder on every call blocked the main thread
      // for as long as the user's largest workshop took to validate — and the
      // renderer refetches on every change push, so the bursts compounded.
      const result = scannerService.scanRootCached(userId, root)
      agents.push(...result.agents)
      watcherService.watchRoot(root)
    }
    return {
      roots: agentsHomeService.listRoots(userId),
      agents: this.overlayEnabled(userId, agents)
    }
  },

  /**
   * The scanner reads files, and `enabled` is not one — it is the user's toggle,
   * held in the index row. Fold it back in so the list shows what the user set.
   */
  overlayEnabled(userId: string, agents: LocalAgentDto[]): LocalAgentDto[] {
    const rows = new Map(agentRepo.listFolder(userId).map((row) => [row.id, row.enabled]))
    return agents.map((agent) => ({ ...agent, enabled: rows.get(agent.id) ?? agent.enabled }))
  },

  /**
   * Re-read one folder, through whichever scan its root uses.
   *
   * Every caller that reads a *single* folder goes through here rather than
   * calling `scanAgentFolder` directly. A bare folder handed to the kit scanner
   * comes back as `unreadableAgent` — no manifest, so "the manifest could not
   * be read" — which is a plausible-looking wrong answer rather than a crash,
   * and it would reach the page, the watcher's re-index and the engine's prompt
   * assembly all three.
   */
  scanFolder(root: AgentRootRow, agentDir: string): LocalAgentDto {
    if (root.kind !== 'external') return scannerService.scanAgentFolder(agentDir, root)
    const rel = relative(root.path, agentDir).split(sep).join('/')
    return scannerService.scanBareAgentFolder(agentDir, root, rel === '' ? '.' : rel)
  },

  /** One agent, re-read from its folder. */
  get(userId: string, agentId: string): LocalAgentDto {
    const { root, agentDir } = this.locate(userId, agentId)
    // Always fresh: the agent page is the surface a user watches while editing.
    const dto = this.scanFolder(root, agentDir)
    return this.overlayEnabled(userId, [dto])[0]
  },

  /**
   * The root and folder behind an agent id. The row is the index; if it is gone
   * or its folder moved, the caller gets `not_found` rather than a path built
   * from a renderer-supplied string.
   */
  locate(userId: string, agentId: string): { root: AgentRootRow; agentDir: string } {
    if (typeof agentId !== 'string' || !isFolderAgentId(agentId)) {
      throw new LocalAgentError('not_found', 'That is not a local agent.')
    }
    const row = agentRepo.getOwned(userId, agentId)
    if (!row || row.source !== FOLDER_AGENT_SOURCE || !row.localPath || !row.localRootId) {
      throw new LocalAgentError('not_found', 'That agent is no longer in your agents folder.')
    }
    const root = agentsHomeService.requireRoot(userId, row.localRootId)
    return { root, agentDir: row.localPath }
  },

  /** Re-read one folder and update just its index row. Used by the watcher. */
  reindexAgent(userId: string, root: AgentRootRow, agentDir: string): LocalAgentDto | null {
    const dto = this.scanFolder(root, agentDir)
    const existing = agentRepo.getOwned(userId, dto.id)
    const entry: FolderIndexEntry = {
      id: dto.id,
      name: dto.name,
      description: describedAs(dto) || null,
      localPath: dto.path,
      remoteMetadata: synthesizeFolderAgentMetadata(dto.manifest)
    }
    if (existing) {
      // `localPath` and `localRootId` are refreshed too, not just the display
      // fields: a folder renamed in place keeps its manifest id, so this is the
      // same row at a new path, and leaving the old one behind would strand
      // `locate()` — and with it the page and every write — until something
      // triggered a full root scan.
      agentRepo.updateFolderIndex(userId, entry, root.id)
      return dto
    }
    // A folder that appeared between scans: a full root scan is the only thing
    // that can add a row without risking a stale prune.
    scannerService.scanRoot(userId, root)
    return dto
  },

  /** Scan one root, or every root when `rootId` is omitted. */
  rescan(userId: string, rootId?: string): RescanResult[] {
    const roots = rootId
      ? [agentsHomeService.requireRoot(userId, rootId)]
      : agentsHomeService.listRootRows(userId)
    return roots.map((root) => {
      // An explicit rescan is exactly the request to ignore the cache.
      scannerService.markRootDirty(root.id)
      const result = scannerService.scanRoot(userId, root)
      watcherService.watchRoot(root)
      watcherService.refreshRoot(root.id)
      return {
        rootId: root.id,
        scanned: result.agents.length,
        indexed: result.indexed,
        pruned: result.pruned
      }
    })
  },

  /**
   * Scaffold a new agent folder and index it. The sentence the user typed
   * becomes the manifest `description`; the AI drafting of prompts is Phase 3's
   * job and happens afterwards, through {@link updateField}.
   */
  create(userId: string, input: CreateLocalAgentInput): LocalAgentDto {
    const name = requireString(input?.name, 'The name', 255)
    // The kit schema requires a non-empty `description`, and a folder that
    // fails validation from its first second is a worse start than a
    // redundant sentence. The name stands in until the user, or the
    // assistant they build the agent with, writes the real one.
    const description = optionalString(input?.description, 'The description', 2000) ?? name
    const slug = (input?.slug?.trim() || scaffoldService.slugify(name))
    if (slug === '') {
      throw new LocalAgentError(
        'invalid_input',
        'That name has no letters or digits to build a folder name from.'
      )
    }

    const root = agentsHomeService.requireRoot(userId, input?.rootId)
    const { agentDir } = scaffoldService.scaffoldAgent({
      rootPath: root.path,
      slug,
      name,
      description
    })

    // A full root scan, not a single-folder reindex: the new row has to be
    // inserted, and `replaceFolderIndex` is the only path that inserts.
    scannerService.markRootDirty(root.id)
    scannerService.scanRoot(userId, root)
    watcherService.watchRoot(root)
    watcherService.refreshRoot(root.id)

    const dto = scannerService.scanAgentFolder(agentDir, root)
    logger.info('local agent created', { rootId: root.id, slug })
    return dto
  },

  /**
   * Write one field back to the folder. The write is taken under the turn lock
   * and guarded by the stamp the editor last read, so neither a streaming turn
   * nor a coding assistant editing the same file can be clobbered.
   */
  updateField(userId: string, input: UpdateLocalAgentFieldInput): LocalAgentDto {
    const update = input?.update
    const expected = input?.expectedStamp
    if (!update || typeof update !== 'object') {
      throw new LocalAgentError('invalid_input', 'Nothing to save.')
    }
    if (
      !expected ||
      typeof expected.mtimeMs !== 'number' ||
      typeof expected.size !== 'number' ||
      typeof expected.hash !== 'string'
    ) {
      throw new LocalAgentError(
        'invalid_input',
        'This editor is out of date. Reload the agent and try again.'
      )
    }

    const { root, agentDir } = this.locate(userId, input.agentId)
    // Set by `stamp_identity` to the row id the folder will have afterwards.
    let stampedId: string | null = null
    const handle = turnLock.acquire(input.agentId, 'editor')
    try {
      if (update.field === 'prompt') {
        const relPath = PROMPT_PATHS[update.prompt]
        if (!relPath) {
          throw new LocalAgentError('invalid_input', 'Unknown prompt document.')
        }
        if (typeof update.value !== 'string' || update.value.length > MAX_PROMPT_BYTES) {
          throw new LocalAgentError('invalid_input', 'That prompt document is too large to save.')
        }
        writeTextIfUnchanged(join(agentDir, relPath), update.value, expected)
      } else if (update.field === 'bare_prompt') {
        // Refused for a kit agent rather than silently creating a second prompt
        // file beside `docs/WORKFLOW_PROMPT.md`: two files claiming to be the
        // system prompt, only one of which the engine reads, is the worst
        // outcome available here.
        if (root.kind !== 'external') {
          throw new LocalAgentError('invalid_input', 'This agent has no AGENT.md to edit.')
        }
        if (typeof update.value !== 'string' || update.value.length > MAX_PROMPT_BYTES) {
          throw new LocalAgentError('invalid_input', 'That prompt document is too large to save.')
        }
        writeTextIfUnchanged(join(agentDir, BARE_AGENT_PROMPT_FILE), update.value, expected)
      } else {
        const path = manifestPath(agentDir)
        const { manifest } = readWithStamp(path)
        switch (update.field) {
          case 'name':
            manifest.name = requireString(update.value, 'The name', 255)
            break
          case 'description':
            manifest.description = requireString(update.value, 'The description', 2000)
            break
          case 'example_prompts': {
            if (!Array.isArray(update.value)) {
              throw new LocalAgentError('invalid_input', 'Example prompts must be a list.')
            }
            if (update.value.length > 20) {
              throw new LocalAgentError('invalid_input', 'That is more than 20 example prompts.')
            }
            manifest.example_prompts = update.value.map((prompt, index) =>
              requireString(prompt, `Example prompt ${index + 1}`, 2000)
            )
            break
          }
          case 'router_trigger_prompt':
            manifest.router_trigger_prompt = optionalString(
              update.value,
              'The router trigger prompt',
              2000
            )
            break
          case 'runtime':
            // The Runtime card is not a special case: it goes through the same
            // stamped write as every other manifest edit, under the same turn
            // lock. `runtimeService` owns the shape and the "never a key" check.
            runtimeService.applyToManifest(manifest, update.value)
            break
          case 'status_refresh_command':
            manifest.status_refresh_command = optionalString(
              update.value,
              'The status command',
              1024
            )
            break
          case 'stamp_identity': {
            // Deliberate, never automatic. The desktop writing an id into a
            // manifest the user did not ask it to touch is exactly what
            // Invariant 3 forbids, and an assistant may be editing that file —
            // which is why this arrives through the same stamped write as
            // every other edit rather than from the scanner.
            if (typeof manifest.id === 'string' && manifest.id !== '') {
              throw new LocalAgentError(
                'invalid_input',
                'This agent already has an id. Stamping it again would give it a new identity.'
              )
            }
            manifest.id = randomUUID()
            stampedId = folderAgentId(manifest.id)
            // `contract_version` too when it is absent: the validator reads
            // "`schema_version`, no `contract_version`, no `id`" as legacy and
            // warns, so writing `id` alone would leave the manifest missing a
            // required field and turn a warning into an error. The contract's
            // own migration note asks for both.
            if (
              typeof manifest.contract_version !== 'string' ||
              manifest.contract_version === ''
            ) {
              manifest.contract_version = resolveContract(root.path).version
            }
            break
          }
          default: {
            const unknown = update as { field?: unknown }
            throw new LocalAgentError('invalid_input', `Unknown field: ${String(unknown.field)}`)
          }
        }
        // Throws `KitError('manifest_modified')` when the file no longer
        // matches the stamp the editor read.
        writeIfUnchanged(path, manifest, expected)
      }
    } finally {
      handle.release()
    }

    if (stampedId !== null && stampedId !== input.agentId) {
      // Move the row *before* anything rescans. A rescan would see an id the
      // index has never heard of, insert a second row and prune the first —
      // taking its sessions, its on-demand attachments and its job links with
      // it, and leaving `chats.agent_id` pointing at nothing. Stamping is
      // offered as the cure for exactly that kind of loss, so it cannot be the
      // cause of it.
      const rekey = agentRepo.rekeyFolderRow(userId, input.agentId, stampedId)
      logger.info('stamped a folder agent with a durable identity', {
        agentId: input.agentId,
        newAgentId: stampedId,
        // `false` is survivable — the rescan below still produces a correct
        // index — but it means history was dropped, so it must be visible.
        rekeyed: rekey.moved,
        repointed: rekey.repointed
      })
      if (rekey.moved) rebuildManifestsForRekeyedAgent(input.agentId, stampedId)
    }

    scannerService.markRootDirty(root.id)
    const dto = this.reindexAgent(userId, root, agentDir) ??
      scannerService.scanAgentFolder(agentDir, root)
    logger.info('local agent field saved', {
      agentId: input.agentId,
      field: update.field === 'prompt' ? `prompt:${update.prompt}` : update.field
    })
    return this.overlayEnabled(userId, [dto])[0]
  },

  /**
   * Read one prompt document, with the stamp of the very bytes returned.
   *
   * The page needs both halves from one read: the text it renders and the
   * fingerprint its save hands back. Taking them separately — text now, stamp
   * at save time — is the mistake this whole guard exists to prevent, so the
   * pairing lives here rather than being reassembled in the renderer.
   *
   * A document that is not there comes back with `stamp: null`, which the
   * editor reads as "cannot save this" instead of creating a file the kit did
   * not scaffold.
   */
  readDoc(userId: string, agentId: string, prompt: LocalAgentDocKind): LocalAgentDocDto {
    const relPath = LOCAL_AGENT_DOC_PATHS[prompt]
    if (!relPath) {
      throw new LocalAgentError('invalid_input', 'Unknown prompt document.')
    }
    const { agentDir } = this.locate(userId, agentId)
    const path = join(agentDir, relPath)
    try {
      const bytes = readFileSync(path)
      const stat = statSync(path)
      return {
        relPath,
        text: bytes.toString('utf8'),
        // `size` comes from the bytes, not the stat, so the three fields always
        // describe the same content even if the file is rewritten mid-read.
        stamp: { mtimeMs: stat.mtimeMs, size: bytes.length, hash: sha256Hex(bytes) }
      }
    } catch {
      return { relPath, text: '', stamp: null }
    }
  },

  /**
   * The briefing a user pastes into a coding assistant Cinna cannot launch.
   *
   * Built in main, not in the renderer, for the same reason every other path
   * here is: the folder comes from the index row via {@link locate}, never from
   * a string the renderer sent. Main is also the only side that can see *which*
   * entry document the folder has — pointing an assistant at an `AGENTS.md`
   * that a hand-made folder never had would send it looking for the wrong file.
   * Nothing is written and nothing is launched; this only reads directory
   * entries.
   *
   * The name comes from the **index row**, not from `get()`. `get()` would
   * re-walk and re-validate the whole folder — the cost `list()` grew
   * `scanRootCached` to avoid — for one string the row already holds, and the
   * row's copy is the better one: a folder whose manifest has gone briefly
   * unparseable scans as `unreadableAgent`, whose `name` is the directory
   * basename, while the row still carries the last good display name.
   */
  initPrompt(userId: string, agentId: string): string {
    const { root, agentDir } = this.locate(userId, agentId)
    // `locate` proves the row exists, not the directory. Every launching
    // sibling re-validates the path before acting; this one would instead
    // manufacture a confident briefing for a folder that is not there — an
    // unmounted volume reads exactly like a hand-made folder with no entry
    // document, and the user would paste a dead path into an assistant.
    if (!existsSync(agentDir)) {
      throw new LocalAgentError('not_found', 'That agent folder is no longer there.')
    }
    const row = agentRepo.getOwned(userId, agentId)
    // A **bare** folder is briefed from its `README.md`, and only then from its
    // `AGENT.md`. That order is the point of the distinction: `README.md` is
    // written for whoever develops the agent — what it is, how to run it, what
    // it needs — which is exactly what an assistant opening the folder should
    // read first, while `AGENT.md` is the agent's own instructions and reads to
    // a builder as a job description rather than a briefing.
    const entryFiles =
      root.kind === 'external'
        ? [BARE_AGENT_README_FILE, BARE_AGENT_PROMPT_FILE]
        : AGENT_INIT_ENTRY_FILES
    const entryFile = entryFiles.find((file) => existsSync(join(agentDir, file))) ?? null
    return buildAgentInitPrompt({
      folder: agentDir,
      name: row?.name ?? basename(agentDir),
      entryFile
    })
  },

  /**
   * The permissions this agent may take without asking again.
   *
   * Read through here rather than from the renderer's own idea of where the
   * folder is: `locate` is what proves the agent belongs to this user before a
   * path is derived, and it is the same guard every other folder read uses.
   */
  listPermissionGrants(userId: string, agentId: string): StoredPermissionGrant[] {
    const { root, agentDir } = this.locate(userId, agentId)
    return permissionGrantService.list(agentDir, kindOf(root))
  },

  /**
   * Revoke one grant, and answer with what is left.
   *
   * The remaining list is returned rather than left to a refetch: revoking is
   * the one action on that card, and a list that re-reads itself a moment
   * later would show the row the user just removed until it did.
   */
  forgetPermissionGrant(userId: string, agentId: string, key: string): StoredPermissionGrant[] {
    const { root, agentDir } = this.locate(userId, agentId)
    permissionGrantService.forget(agentDir, kindOf(root), key)
    return permissionGrantService.list(agentDir, kindOf(root))
  },

  /** Revoke every grant this agent holds. Returns the empty list it leaves. */
  forgetAllPermissionGrants(userId: string, agentId: string): StoredPermissionGrant[] {
    const { root, agentDir } = this.locate(userId, agentId)
    permissionGrantService.forgetAll(agentDir, kindOf(root))
    return permissionGrantService.list(agentDir, kindOf(root))
  },

  /** Validate a folder on demand — the agent page's "check this agent" action. */
  validate(userId: string, agentId: string): LocalAgentValidation {
    const { root, agentDir } = this.locate(userId, agentId)
    // A bare folder has nothing the kit validator can say anything true about:
    // run on one it reports a missing manifest, missing prompt documents and a
    // missing layout — a wall of errors describing a contract the folder was
    // never asked to keep, contradicting the findings the list is already
    // showing for the same agent. Its own findings come from the same scan the
    // list and the page read, so the two cannot disagree.
    if (root.kind === 'external') return this.scanFolder(root, agentDir).validation
    const contract = resolveContract(root.path)
    const report = validateAgentFolder(agentDir, {
      layout: getLayoutView(root.path),
      contractVersion: contract.version,
      folderName: basename(agentDir)
    })
    return {
      errors: report.errors.map((f) => ({ code: f.code, message: f.message, path: f.path })),
      warnings: report.warnings.map((f) => ({ code: f.code, message: f.message, path: f.path })),
      infos: report.infos.map((f) => ({ code: f.code, message: f.message, path: f.path }))
    }
  },

  /**
   * Reveal a file inside an agent folder in the OS file manager.
   *
   * `relPath` is renderer-supplied and therefore hostile until proven
   * otherwise: {@link resolveWithinRoot} refuses anything absolute, anything
   * that climbs, and anything that resolves — through symlinks — outside the
   * agent folder. The folder itself came from the index row, never from the
   * renderer.
   */
  openPath(userId: string, input: OpenLocalAgentPathInput): void {
    const { agentDir } = this.locate(userId, input?.agentId)
    const target = resolveWithinRoot(agentDir, input?.relPath)
    shell.showItemInFolder(target)
    logger.info('revealed an agent path', {
      agentId: input.agentId,
      relPath: input?.relPath ?? MANIFEST_FILE
    })
  },

  /**
   * Open `credentials/.env` itself, creating it first when it is missing.
   *
   * The affordance says "Add them in credentials/.env", so the click has to end
   * with that file open in an editor. Revealing the folder was the previous
   * behaviour and it stopped one step short — and two things stop a plain
   * `shell.openPath` from covering the gap:
   *
   * * **The file need not exist.** The scaffold writes `credentials/.env.example`
   *   and deliberately not the real file, so on a fresh agent — exactly the
   *   agent whose credentials are missing — there is nothing to open. It is
   *   seeded here, 0600, with the declared names commented out.
   * * **`.env` has no default application.** Where nothing is registered for the
   *   extension, `openPath` resolves to an error string rather than throwing.
   *   macOS then gets `open -t` (its default *text* editor), and anything still
   *   unhandled falls back to revealing the file, so a click never dead-ends.
   *
   * Values are never read: the seed is written, never parsed back. Creating the
   * file takes the per-agent turn lock; opening an existing one does not.
   *
   * @throws LocalAgentError `not_found`, `invalid_path`, `write_failed`,
   *   `turn_in_progress`
   */
  async openCredentials(userId: string, agentId: string): Promise<OpenLocalAgentCredentialsResult> {
    const agent = this.get(userId, agentId)
    const { root, agentDir } = this.locate(userId, agentId)

    let created = false
    if (!existsSync(join(agentDir, ENV_FILE))) {
      // Invariant 3: this is a write into the folder, so it takes the same lock
      // every other write here takes and refuses mid-turn rather than seeding a
      // file under a running agent. Only the *creation* is held — opening a file
      // that is already there reads nothing and blocks nobody.
      const handle = turnLock.acquire(agentId, 'credentials')
      try {
        created = seedCredentialsFile(agentDir, root.path, agent)
      } finally {
        handle.release()
      }
    }
    // Now that the file exists, containment is checked on the file itself: a
    // `.env` symlinked out of the agent folder is refused rather than handed to
    // the OS.
    const target = resolveWithinRoot(agentDir, ENV_FILE)

    let revealed = false
    const failure = await shell.openPath(target)
    if (failure) {
      if (process.platform === 'darwin') {
        try {
          await openInTextEditor(target)
        } catch {
          shell.showItemInFolder(target)
          revealed = true
        }
      } else {
        shell.showItemInFolder(target)
        revealed = true
      }
    }
    logger.info('opened agent credentials', { agentId, created, revealed })
    return { created, revealed }
  },

  /**
   * Move an agent folder to the OS trash and drop its row.
   *
   * Trash, never `rm -rf`: the folder is the agent, it may hold work the user
   * has not committed anywhere, and a mis-click has to be recoverable. The
   * row is not deleted directly — the root is rescanned, and the scan prunes
   * what is no longer on disk through the same path every other removal takes
   * (`replaceFolderIndex`), so the cascade to `a2a_sessions` and `job_agents`
   * is the one already reasoned about there. A job bound to this agent is left
   * with a dependency the manifest can no longer resolve, which is exactly the
   * visible, blocking state `local_only.md` describes.
   *
   * Taken under the per-agent lock, so a turn in flight refuses this with
   * `turn_in_progress` rather than having its folder vanish mid-stream. The
   * lock is held across the async trash call and released before the rescan:
   * the watcher's own rescan defers on that lock, and the explicit one here is
   * what makes the row disappear now rather than on the next debounce.
   *
   * @throws LocalAgentError `not_found`, `turn_in_progress`, `write_failed`
   */
  async delete(userId: string, input: DeleteLocalAgentInput): Promise<DeleteLocalAgentResult> {
    const agentId = input?.agentId ?? ''
    const { root, agentDir } = this.locate(userId, agentId)
    const bare = root.kind === 'external'
    const trashFolder = input?.trashFolder !== false
    // Resolved **before** anything moves the folder. A bare agent's state file
    // is keyed on the folder's `realpath`, and once the folder is in the Trash
    // that resolution silently changes — see `desktopStateService.forgetAt`.
    const stateFile = bare ? desktopStatePath(agentDir, 'bare') : null

    if (!trashFolder && !bare) {
      // A kit agent's row is a derived index over its folder: dropping the row
      // and leaving the folder means the very next scan puts it straight back.
      // Refusing is honest; the dialog only ever offers the choice for a bare
      // agent, so this is a guard against a caller, not a message a user reads.
      throw new LocalAgentError(
        'invalid_input',
        'An agent in your agents folder is its folder, so it cannot be removed from the list on its own.'
      )
    }

    // Both branches take the lock, and for the same reason: forgetting an agent
    // mid-turn would leave a stream writing into a chat whose agent has gone,
    // and the hidden flag is a write into that agent's own state file.
    const handle = turnLock.acquire(agentId, 'delete')
    try {
      if (trashFolder) {
        await shell.trashItem(agentDir)
        // The folder is gone, so its state file — which for a bare agent lives
        // under `userData`, not in the folder — would otherwise outlive it and
        // be adopted by whatever is next created at that path. A kit agent's
        // state was inside the folder and went to the Trash with it.
        if (stateFile) desktopStateService.forgetAt(stateFile)
      } else {
        desktopStateService.patch(agentDir, 'bare', { hidden: true })
      }
    } catch (err) {
      if (err instanceof LocalAgentError) throw err
      throw new LocalAgentError(
        'write_failed',
        trashFolder
          ? 'The folder could not be moved to the Trash.'
          : 'This agent could not be removed from the list.',
        err instanceof Error ? err.message : String(err)
      )
    } finally {
      handle.release()
    }
    scannerService.markRootDirty(root.id)
    scannerService.scanRoot(userId, root)
    watcherService.refreshRoot(root.id)
    logger.info('local agent deleted', { agentId, rootId: root.id, trashed: trashFolder })
    return { agentId, trashed: trashFolder }
  },

  /** Roots, for the settings screen. */
  listRoots(userId: string): AgentRootDto[] {
    return agentsHomeService.listRoots(userId)
  },

  /** True when adopting `path` would write template files alongside the user's
   *  own content, so the caller should confirm first. */
  needsAdoptionConfirmation(path: string): boolean {
    return agentsHomeService.needsAdoptionConfirmation(path)
  },

  /** Adopt a folder as an extra root, then index whatever is already in it. */
  addRoot(userId: string, path: string, label?: string): AgentRootDto {
    const dto = agentsHomeService.addRoot(userId, path, label)
    const root = agentsHomeService.requireRoot(userId, dto.id)
    scannerService.markRootDirty(root.id)
    scannerService.scanRoot(userId, root)
    watcherService.watchRoot(root)
    return dto
  },

  /**
   * Look at a folder the user just chose in the OS picker, and report what is
   * in it. **Reads only.**
   *
   * The path is remembered in {@link pendingPick} so the adopt call that
   * follows can be checked against it. This is the two-step version of the rule
   * `local-agent:root-add` keeps in one step: the renderer may not name a
   * folder the user did not just select. Splitting the pick from the adopt is
   * what makes a preview possible — the user sees the fifteen agents that were
   * found before anything is registered — and the record is what keeps the
   * split from becoming a hole.
   */
  pickedAgentFolder(userId: string, path: string): PickAgentFolderResult {
    const roots = agentsHomeService.listRootRows(userId)
    const { found, truncated } = discoverBareAgents(path)

    // Which of these are already agents somewhere, and **whose**. Reported per
    // folder rather than refused wholesale: re-picking a repository after new
    // agents landed in it is the ordinary way to adopt those, and the root a
    // row belongs to is what decides whether this pick may speak for it — see
    // `addedElsewhere`.
    const known = new Map<string, string | null>()
    for (const row of agentRepo.listFolder(userId)) {
      if (row.localPath !== null) known.set(row.localPath, row.localRootId ?? null)
    }

    // **Overlap is checked first**, before anything about what was found.
    //
    // Two reasons, and the second is the one that made this an ordering bug
    // rather than a style choice. It is the security rule — a registered root
    // becomes an allowed area for the "open in…" path guard, so adopting a
    // parent of one widens that guard over the whole subtree — and it is the
    // most specific true thing about the folder. Checked last, pointing at the
    // *parent* of the agents home answered "nothing in this folder has an
    // AGENT.md", which sends the user looking for the wrong problem; and
    // re-picking a folder already registered answered "everything here has
    // already been added", which is true but not why it is refused.
    let refusal: string | null = null
    /**
     * Picking the *same* external root again is a **re-selection**, not a
     * clash.
     *
     * It used to be the first refusal on the list, and it closed the only door
     * there was: a user who ticked one agent out of fifteen had no way to add a
     * sixteenth later. The ⋯ menu removes one at a time and Settings' "Add
     * them" restores all of them at once; this dialog is the only surface that
     * lists a repository's agents individually, so it is where the set is
     * chosen — the first time and every time after.
     *
     * Only an `external` root. A workshop root holds kit folders, which this
     * walk does not look for at all, so re-picking one still falls through to
     * "nothing in this folder has an AGENT.md" — the true thing about it.
     */
    let reselecting: { rootId: string; label: string } | null = null
    for (const root of roots) {
      if (isWithin(root.path, path) || isWithin(path, root.path)) {
        if (root.path === path && root.kind === 'external') {
          reselecting = { rootId: root.id, label: root.label }
          break
        }
        refusal =
          root.path === path
            ? `This folder is already registered as "${root.label}".`
            : `This overlaps your "${root.label}" agents folder. Pick a folder that is not inside it, and does not contain it.`
        break
      }
    }
    const discovered: DiscoveredBareAgent[] = found.map((folder) => ({
      relPath: folder.relPath,
      path: folder.path,
      // The name the user sees in the app, not the one the file states: an agent
      // they renamed, listed under its `AGENT.md` heading, is a row they cannot
      // recognise in a dialog whose whole question is "which of these do you
      // want". Falls back to the heading and then the folder name, which is the
      // scanner's own order.
      name: bareName(folder.path, folder.name),
      hasReadme: folder.hasReadme,
      alreadyAdded: known.has(folder.path),
      // An agent of *another* root. This pick cannot add or remove it — the
      // folder it belongs to is not the folder being picked — so the dialog
      // keeps it ticked and disabled even while re-selecting. Reachable only
      // through a symlink, since registered roots may not overlap, which is
      // why it is computed rather than assumed away.
      addedElsewhere:
        known.has(folder.path) && known.get(folder.path) !== (reselecting?.rootId ?? null)
    }))

    if (refusal === null && discovered.length === 0) {
      refusal = `Nothing in this folder has an ${BARE_AGENT_PROMPT_FILE}. Choose the agent's own folder, or a folder that holds several of them.`
    } else if (
      refusal === null &&
      reselecting === null &&
      discovered.every((entry) => entry.alreadyAdded)
    ) {
      // Not a refusal when re-selecting: "every agent here is already added" is
      // the *normal* state of a folder the user came back to in order to take
      // one out of the list again.
      refusal = 'Every agent in this folder has already been added.'
    }

    pendingPick = refusal === null ? { userId, path, at: Date.now() } : null
    if (truncated) {
      logger.warn('stopped listing agents in a picked folder at the cap', { found: found.length })
    }
    // `truncated` travels rather than only being logged: the log is invisible
    // to the person the sentence is about, and a list that is silently partial
    // reads as the scanner having missed the folders they came for.
    return {
      cancelled: false,
      path,
      folderName: basename(path),
      found: discovered,
      truncated,
      reselecting: refusal === null ? reselecting : null,
      refusal
    }
  },

  /**
   * Adopt the folders the user ticked in the preview.
   *
   * The whole picked folder becomes one external root, whatever the user
   * ticked, because the root is *where to look* and not *what was found* — and
   * because the git update check, which is the reason a repository of agents is
   * worth adopting as a set, works on the repository, not on one folder inside
   * it. Unticked folders are recorded as hidden rather than left out: the scan
   * walks the whole root, so "not chosen" and "removed from the list" have to
   * be the same state or the next rescan would silently add them.
   *
   * A folder past `discoverBareAgents`' cap is written **neither** hidden nor
   * added — the walk never returned it — so it carries no state saying which.
   * If the tree later shrinks below the cap it arrives as a new agent. That is
   * the honest consequence of the cap rather than a bug, and it is no longer
   * silent: `truncated` reaches both the adopt dialog and the settings row.
   *
   * @throws LocalAgentError `invalid_input`, `invalid_path`
   */
  addAgentFolder(userId: string, input: AddAgentFolderInput): AddAgentFolderResult {
    const path = typeof input?.path === 'string' ? input.path : ''
    // The userId is compared as well as the path. Folder agents are
    // machine-local so both calls resolve the same settings scope today, and
    // this is the cheap half of not having to remember that when they do not.
    if (pendingPick === null || pendingPick.path !== path || pendingPick.userId !== userId) {
      throw new LocalAgentError(
        'invalid_path',
        'Choose the folder again — this one was not the last one picked.'
      )
    }
    const chosen = new Set(Array.isArray(input?.relPaths) ? input.relPaths : [])
    // Whether this call *registers* the folder or re-selects one already
    // registered. `addExternalRoot` returns the existing row for a path it
    // already knows, so the two are the same call — but only one of them may
    // undo itself below.
    const preexisting = agentsHomeService
      .listRootRows(userId)
      .some((row) => row.path === path && row.kind === 'external')
    // An empty selection is nothing to adopt on a first pick, and a real answer
    // on a re-selection: "take all of these out of the list". The folder stays
    // registered and Settings' "Add them" puts them back, which is what makes
    // that recoverable rather than a way to lose a repository.
    if (chosen.size === 0 && !preexisting) {
      throw new LocalAgentError('invalid_input', 'Pick at least one agent to add.')
    }
    const dto = agentsHomeService.addExternalRoot(userId, path)
    const root = agentsHomeService.requireRoot(userId, dto.id)
    const { found } = discoverBareAgents(root.path)

    /**
     * Every agent this call would take *out* of the list, checked for a turn in
     * flight **before anything is written**.
     *
     * The locks used to be taken one at a time inside the loop, and
     * `turnLock.acquire` throws: an agent earlier in the walk was already hidden
     * on disk when a later one refused, so the dialog said the agent was busy —
     * a refusal whose whole point is that nothing was removed (ux_rules rule 5)
     * — over a folder where one had been. The index was never reconciled
     * either, so that agent vanished from the sidebar at the next unrelated
     * rescan, with no action of the user's to attribute it to.
     */
    const removals = found.filter(
      (folder) =>
        !chosen.has(folder.relPath) &&
        !desktopStateService.read(folder.path, 'bare').hidden &&
        agentRepo.getOwned(userId, externalFolderAgentId(root.id, folder.relPath)) !== undefined
    )
    const busy = removals.find((folder) =>
      turnLock.isLocked(externalFolderAgentId(root.id, folder.relPath))
    )
    if (busy) {
      throw new LocalAgentError(
        'turn_in_progress',
        `“${bareName(busy.path, busy.name)}” is busy right now. Nothing was changed — try again when its run finishes.`
      )
    }

    /** Ticked and not in the list a moment ago — what this call actually added. */
    const added: { relPath: string; path: string }[] = []
    for (const folder of found) {
      const wanted = chosen.has(folder.relPath)
      const was = desktopStateService.read(folder.path, 'bare')
      const indexed =
        !was.hidden &&
        agentRepo.getOwned(userId, externalFolderAgentId(root.id, folder.relPath)) !== undefined
      if (wanted && !indexed) added.push({ relPath: folder.relPath, path: folder.path })
      // Written for *every* folder whose state would change, not only the
      // unwanted ones: re-adopting a repository whose agents were previously
      // removed from the list has to clear the flag, or the second add would
      // appear to do nothing — and on a re-selection, unticking one is how it
      // leaves the list again.
      const patch: { hidden: boolean; displayName?: string | null } = { hidden: !wanted }
      // One agent, one name field, and **only for one being added**. The field
      // is prefilled from the folder, so writing it back over an agent already
      // in the list renamed it — silently, from a dialog whose copy promises the
      // folder is untouched and says nothing at all about names.
      if (
        wanted &&
        !indexed &&
        chosen.size === 1 &&
        typeof input.name === 'string' &&
        input.name.trim() !== ''
      ) {
        patch.displayName = input.name.trim().slice(0, 255)
      }
      // Nothing to write for a folder whose state already reads this way. The
      // patch is a read-modify-write of the whole file, so doing it for fifteen
      // untouched agents is fifteen chances to land on a stale snapshot — the
      // engine session a running turn wrote a millisecond ago among them.
      if (was.hidden === !wanted && patch.displayName === undefined) continue
      if (!wanted && indexed) {
        // Taking one *out* of the list is the same act as ⋯ → Remove from the
        // list, so it takes the same lock: hiding an agent mid-turn would leave
        // a stream writing into a chat whose agent has gone. The pre-check above
        // means this can only be a turn that started in the last few lines.
        const handle = turnLock.acquire(externalFolderAgentId(root.id, folder.relPath), 'delete')
        try {
          desktopStateService.patch(folder.path, 'bare', patch)
        } finally {
          handle.release()
        }
      } else {
        desktopStateService.patch(folder.path, 'bare', patch)
      }
    }

    scannerService.markRootDirty(root.id)
    const scan = scannerService.scanRoot(userId, root)

    // **An adopt that indexes nothing is a failure, not a success.**
    //
    // Everything above can succeed against a folder that is no longer there:
    // the preview is a separate call, and between it and this one the user can
    // eject the volume, move the folder, or delete it. The scan then finds
    // nothing, and without this the dialog would close on a folder that never
    // appeared, leaving a registered root with no agents and nothing anywhere
    // saying why. The root is dropped again rather than left behind, so the
    // next attempt is not refused for overlapping a root the user cannot see
    // the point of.
    if (scan.agents.length === 0 && chosen.size === 0 && preexisting) {
      // A re-selection that emptied the list on purpose. Not the failure below:
      // the folder is still registered, the agents are still on disk, and
      // Settings → "Add them" is the way back — the same state as taking them
      // out one at a time from the ⋯ menu.
      pendingPick = null
      watcherService.refreshRoot(root.id)
      logger.info('agents folder cleared', { rootId: root.id, found: found.length })
      return {
        root: agentsHomeService.listRoots(userId).find((entry) => entry.id === root.id) ?? dto,
        agentIds: []
      }
    }

    if (scan.agents.length === 0) {
      // Only a root this call created is taken away again. A folder that was
      // already registered keeps its registration — with it goes the watcher,
      // the git update check and every agent the user did *not* just touch, and
      // none of that should fall over because the one folder they ticked has
      // gone missing since the preview.
      if (!preexisting) {
        agentsHomeService.removeRoot(userId, root.id)
        scannerService.markRootDirty(root.id)
        watcherService.unwatchRoot(root.id)
      }
      pendingPick = null
      logger.warn('an adopted folder indexed no agents', {
        rootId: root.id,
        found: found.length,
        rootDropped: !preexisting
      })
      throw new LocalAgentError(
        'not_found',
        scan.rootMissing
          ? 'That folder is no longer there. Choose it again.'
          : 'None of those agents could be read. Choose the folder again.'
      )
    }

    pendingPick = null
    watcherService.watchRoot(root)
    // `watchRoot` returns early for a root already watched at this path, so a
    // re-selection would leave the agents it just added without a per-directory
    // watcher on the non-recursive fallback. `delete` calls this for the same
    // reason.
    watcherService.refreshRoot(root.id)
    // An agent put back through this dialog finds its engine sessions again,
    // exactly as one restored from Settings does: `a2a_sessions` cascaded away
    // with its row, so without this the chats re-bind and the model has
    // forgotten the conversation the transcript still shows.
    for (const folder of added) reseedEngineSessions(userId, root, folder.path)
    logger.info('agents folder adopted', {
      rootId: root.id,
      found: found.length,
      kept: scan.agents.length,
      added: added.length,
      reselected: preexisting
    })
    /**
     * What the dialog lands on: the agents the user ticked, the ones this call
     * added first.
     *
     * On a first adopt that is every indexed agent, in walk order, which is
     * what this always returned. On a re-selection it is the difference between
     * landing on the sixteenth agent — the one they came back for — and landing
     * on whichever of the fifteen they already had sorts first.
     */
    const addedIds = new Set(added.map((f) => externalFolderAgentId(root.id, f.relPath)))
    const chosenIds = new Set([...chosen].map((rel) => externalFolderAgentId(root.id, rel)))
    const kept = scan.agents.filter((agent) => chosenIds.has(agent.id))
    const agentIds = [
      ...kept.filter((agent) => addedIds.has(agent.id)),
      ...kept.filter((agent) => !addedIds.has(agent.id))
    ].map((agent) => agent.id)
    /**
     * A selection that produced nothing is the same failure as an adopt that
     * indexed nothing, and it is only reachable on a re-selection: on a first
     * adopt the unticked folders are hidden, so `scan.agents` *is* `kept`.
     *
     * This used to fall back to every indexed agent, which was worse than it
     * looks — the dialog closed reporting success and landed the user on one of
     * the agents they had *not* ticked, while the ones they had were missing
     * with nothing anywhere saying why.
     */
    if (agentIds.length === 0) {
      throw new LocalAgentError('not_found', 'None of those agents could be read. Choose the folder again.')
    }
    return {
      root: agentsHomeService.listRoots(userId).find((entry) => entry.id === root.id) ?? dto,
      agentIds
    }
  },

  /**
   * Rename a bare agent.
   *
   * There is no file to write it to. A kit agent's name is in its manifest and
   * the folder is the truth; a bare folder is somebody's repository, and
   * inventing a file inside it to hold a display name is exactly the imposition
   * this whole shape exists to avoid. So the name goes where the rest of that
   * agent's machine-local state goes, and the index row is updated in the same
   * call so the sidebar does not wait for a rescan.
   *
   * Not routed through `updateField`: that channel's contract is a stamped
   * write to a file in the folder, and a stamp for a file this write does not
   * touch would be a guard that guards nothing.
   *
   * @throws LocalAgentError `not_found`, `invalid_input`, `turn_in_progress`
   */
  renameAgent(userId: string, agentId: string, name: string | null): LocalAgentDto {
    const { root, agentDir } = this.locate(userId, agentId)
    if (root.kind !== 'external') {
      throw new LocalAgentError(
        'invalid_input',
        'Rename this agent by editing the name in its manifest.'
      )
    }
    // `null` clears it, and that is the only way back to a name that **follows
    // the file**. `scanBareAgentFolder` prefers a stored `displayName` over the
    // `AGENT.md` heading, so re-typing the heading by hand is a different state
    // from never having renamed: the name is then pinned to a string that
    // happens to match, and stops following the moment the heading changes
    // again. The Name card offers "clear it to fall back to the heading", and
    // this is what makes that sentence true.
    const trimmed = name === null ? null : requireString(name, 'The name', 255)
    const handle = turnLock.acquire(agentId, 'editor')
    try {
      desktopStateService.patch(agentDir, 'bare', { displayName: trimmed })
    } finally {
      handle.release()
    }
    scannerService.markRootDirty(root.id)
    const dto = this.scanFolder(root, agentDir)
    agentRepo.updateFolderIndex(
      userId,
      {
        id: dto.id,
        name: dto.name,
        description: describedAs(dto) || null,
        localPath: dto.path,
        remoteMetadata: synthesizeFolderAgentMetadata({})
      },
      root.id
    )
    return this.overlayEnabled(userId, [dto])[0]
  },

  /**
   * Set which credential and model a **bare** agent runs on.
   *
   * The kit path for this is `updateField({ field: 'runtime' })`: a stamped
   * write into `cinna-agent.json`, guarded by the fingerprint the panel read so
   * an assistant editing the manifest at the same moment cannot be clobbered.
   * A bare folder has no such file and must not gain one, so the same three
   * values go where the rest of that agent's machine-local state goes — and,
   * like {@link renameAgent}, this cannot travel down the `update-field`
   * channel, whose whole contract is a stamp for a file in the folder. A stamp
   * for a file this write does not touch would be a guard that guards nothing.
   *
   * What is *not* different is the validation: `runtimeService.validate` is the
   * same one the manifest writer runs, so a key-shaped credential and a
   * model-and-tier pair are refused here too. A bare agent's choice never
   * leaves this machine, but a pasted API key does not become safe by landing
   * in `userData` rather than in a file the user commits.
   *
   * The turn lock is taken for the same reason the rename takes it: the runner
   * reads this state to find the agent's session, and a mid-turn write to the
   * file it is reading is the one race this lock exists for.
   *
   * @throws LocalAgentError `not_found`, `invalid_input`, `turn_in_progress`
   */
  setBareRuntime(userId: string, agentId: string, runtime: LocalAgentRuntimeInput): LocalAgentDto {
    const { root, agentDir } = this.locate(userId, agentId)
    if (root.kind !== 'external') {
      throw new LocalAgentError(
        'invalid_input',
        'This agent states its runtime in its manifest. Save it there instead.'
      )
    }
    const next = runtimeService.toRuntimeRef(runtime)
    const handle = turnLock.acquire(agentId, 'editor')
    try {
      desktopStateService.patch(agentDir, 'bare', { runtime: next })
    } finally {
      handle.release()
    }
    // The state file is not in the folder, so nothing the watcher sees changed.
    // The row has to be re-read here or the page would keep rendering the
    // runtime it had before the click.
    scannerService.markRootDirty(root.id)
    const dto = this.scanFolder(root, agentDir)
    return this.overlayEnabled(userId, [dto])[0]
  },

  /**
   * Put back every bare agent that was removed from one external root's list.
   *
   * The counterpart of the "remove from the list" half of the delete dialog:
   * without it that choice is a one-way door, and the folders are still sitting
   * on disk with nothing on screen saying so.
   */
  restoreHiddenAgents(userId: string, rootId: string): { restored: number } {
    // Named, not defaulted: this acts on one root, and a missing id resolving
    // to the agents home would create that directory as a side effect of a
    // button the user pressed about a different folder.
    const root = agentsHomeService.requireNamedRoot(userId, rootId)
    if (root.kind !== 'external') return { restored: 0 }
    const restoredFolders: string[] = []
    for (const folder of discoverBareAgents(root.path).found) {
      if (!desktopStateService.read(folder.path, 'bare').hidden) continue
      desktopStateService.patch(folder.path, 'bare', { hidden: false })
      restoredFolders.push(folder.path)
    }
    if (restoredFolders.length > 0) {
      scannerService.markRootDirty(root.id)
      scannerService.scanRoot(userId, root)
      for (const folder of restoredFolders) reseedEngineSessions(userId, root, folder)
      watcherService.refreshRoot(root.id)
    }
    logger.info('restored hidden agents', { rootId, restored: restoredFolders.length })
    return { restored: restoredFolders.length }
  },

  /** Forget an extra root and stop watching it. The folder is left on disk. */
  removeRoot(userId: string, rootId: string): { pruned: number } {
    const result = agentsHomeService.removeRoot(userId, rootId)
    scannerService.markRootDirty(rootId)
    watcherService.unwatchRoot(rootId)
    return result
  }
}
