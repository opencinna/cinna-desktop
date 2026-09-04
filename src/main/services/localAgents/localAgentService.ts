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
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { shell } from 'electron'
import { agentRepo, type FolderIndexEntry } from '../../db/agents'
import { synthesizeFolderAgentMetadata } from './folderAgentMetadata'
import type { AgentRootRow } from '../../db/agentRoots'
import { getLayoutView, resolveContract } from '../../kit/contractStore'
import {
  manifestPath,
  readStamp,
  readWithStamp,
  stampsMatch,
  writeIfUnchanged
} from '../../kit/manifestIo'
import { sha256Hex } from '../../kit/hash'
import { validateAgentFolder } from '../../kit/validator'
import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { MANIFEST_FILE } from '../../../shared/kit/manifest'
import {
  FOLDER_AGENT_SOURCE,
  folderAgentId,
  isFolderAgentId,
  LOCAL_AGENT_PROMPT_PATHS,
  type AgentRootDto,
  type CreateLocalAgentInput,
  type FileStamp,
  type LocalAgentDocDto,
  type LocalAgentDto,
  type LocalAgentPromptKind,
  type LocalAgentValidation,
  type OpenLocalAgentPathInput,
  type RescanResult,
  type UpdateLocalAgentFieldInput
} from '../../../shared/localAgents'
import { setAllowedRootsProvider } from './openInService'
import { agentsHomeService } from './agentsHomeService'
import { scaffoldService } from './scaffoldService'
import { scannerService } from './scannerService'
import { turnLock } from './turnLock'
import { watcherService } from './watcherService'
import { resolveWithinRoot } from './pathRules'
import { runtimeService } from './runtimeService'

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

  /** One agent, re-read from its folder. */
  get(userId: string, agentId: string): LocalAgentDto {
    const { root, agentDir } = this.locate(userId, agentId)
    // Always fresh: the agent page is the surface a user watches while editing.
    const dto = scannerService.scanAgentFolder(agentDir, root)
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
    const dto = scannerService.scanAgentFolder(agentDir, root)
    const existing = agentRepo.getOwned(userId, dto.id)
    const entry: FolderIndexEntry = {
      id: dto.id,
      name: dto.name,
      description: dto.description === '' ? null : dto.description,
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
    const description = requireString(input?.description, 'The description', 2000)
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
  readDoc(userId: string, agentId: string, prompt: LocalAgentPromptKind): LocalAgentDocDto {
    const relPath = PROMPT_PATHS[prompt]
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

  /** Validate a folder on demand — the agent page's "check this agent" action. */
  validate(userId: string, agentId: string): LocalAgentValidation {
    const { root, agentDir } = this.locate(userId, agentId)
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

  /** Forget an extra root and stop watching it. The folder is left on disk. */
  removeRoot(userId: string, rootId: string): { pruned: number } {
    const result = agentsHomeService.removeRoot(userId, rootId)
    scannerService.markRootDirty(rootId)
    watcherService.unwatchRoot(rootId)
    return result
  }
}
