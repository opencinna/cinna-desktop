/**
 * The scanner — the one place a folder on disk becomes an `agents` row.
 *
 * It walks `<root>/Local/*​/`, reads each folder through Phase 1's manifest
 * reader and validator, derives readiness, folds in `app-data/storage/STATUS.md`
 * and `app-data/desktop.json`, and rebuilds the index for that root in one
 * transaction. The row is a cache (Invariant 1): dropping the whole table and
 * rescanning must produce exactly what was there before.
 *
 * **It never throws for a bad folder.** A half-written manifest, a folder with
 * no manifest at all, a `STATUS.md` full of nonsense — each is a *state* the
 * agents list can render (`invalid`, with findings that name the file), because
 * the alternative is one broken folder taking the whole tab with it. The only
 * thing that stops a scan is the root itself being unreadable, which is
 * reported rather than written: see {@link ScanRootResult.rootMissing}.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import { agentRepo, type FolderIndexEntry } from '../../db/agents'
import { synthesizeFolderAgentMetadata } from './folderAgentMetadata'
import type { AgentRootRow } from '../../db/agentRoots'
import { getLayoutView, resolveContract } from '../../kit/contractStore'
import type { LayoutView } from '../../kit/layout'
import { manifestPath, readStamp, readWithStamp } from '../../kit/manifestIo'
import { parseFrontmatter } from '../../kit/miniYaml'
import {
  isValid,
  readCommandCatalog,
  validateAgentFolder,
  type Finding,
  type ValidationReport
} from '../../kit/validator'
import { KitError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { checkContractCompatibility } from '../../../shared/kit/contractVersion'
import {
  MANIFEST_FILE,
  type CinnaAgentManifest,
  type CredentialSlot
} from '../../../shared/kit/manifest'
import {
  describedAs,
  AGENTS_SUBDIR,
  BARE_AGENT_PROMPT_FILE,
  BARE_AGENT_README_FILE,
  duplicateFolderAgentId,
  externalFolderAgentId,
  folderAgentId,
  legacyFolderAgentId,
  type FileStamp,
  type LocalAgentIdentity,
  type LocalAgentCommand,
  type LocalAgentCredentialState,
  type LocalAgentDto,
  type LocalAgentFinding,
  type LocalAgentReadiness,
  type LocalAgentStatusSummary,
  type LocalAgentValidation
} from '../../../shared/localAgents'
import { desktopStateService } from './desktopStateService'
import { discoverBareAgents, readBareAgentName } from './externalScan'

const logger = createLogger('local-agent-scan')

/** Local `.env` holding the credential values. Names are read; values never. */
export const ENV_FILE = 'credentials/.env'

/** The three document-backed prompts, in the order the page shows them. */
const PROMPT_PATHS: Record<'workflow' | 'entrypoint' | 'refiner', string> = {
  workflow: 'docs/WORKFLOW_PROMPT.md',
  entrypoint: 'docs/ENTRYPOINT_PROMPT.md',
  refiner: 'docs/REFINER_PROMPT.md'
}

/**
 * The last scan of each root, keyed by root id.
 *
 * `local-agent:list` used to walk, parse, validate and re-index every agent in
 * every root on **every call**, synchronously on the main thread — and the
 * renderer refetches on every `local-agent:changed` push, so a burst of watcher
 * events meant a burst of full scans, each one blocking. The cost grows with
 * the number of agents a user has, which is the wrong direction.
 *
 * This is a cache with *exact* invalidation rather than a staleness window:
 * every path that can change a folder marks its root dirty
 * ({@link markRootDirty}), and nothing else serves stale data. The watcher is
 * what notices outside edits, so a hit here means "nothing has happened since
 * the last scan", not "we looked recently".
 */
const lastScan = new Map<string, ScanRootResult>()

/**
 * Drop a root's cached scan. Called by the watcher when a folder changes and by
 * every mutation this feature performs; a rescan is what refills it.
 */
export function markRootDirty(rootId: string): void {
  lastScan.delete(rootId)
}

/** Drop every cached scan — a root was added or removed, or a test is starting. */
export function markAllRootsDirty(): void {
  lastScan.clear()
}

export interface ScanRootResult {
  rootId: string
  /** The root path this scan walked — a moved home invalidates the cache. */
  rootPath: string
  agents: LocalAgentDto[]
  /**
   * True when the root's `Local/` could not be listed — an unmounted volume, a
   * folder the user moved. The index is left untouched in that case: writing an
   * empty index would prune every row and cascade away their chat sessions.
   */
  rootMissing: boolean
  indexed: number
  pruned: number
  /**
   * External roots only: bare agents the user removed from the list, and
   * whether the walk stopped at its cap.
   *
   * Carried on the scan because the scan is the thing that walked the tree.
   * The settings row needs both, and computing them again meant a second walk
   * plus one state read per agent on every `local-agent:list` — the cost this
   * cache exists to avoid — and two independent answers to "how many agents
   * does this root have", which is also how they could come to disagree.
   */
  hiddenCount: number
  truncated: boolean
}

function toFindings(findings: Finding[]): LocalAgentFinding[] {
  return findings.map((f) => ({ code: f.code, message: f.message, path: f.path }))
}

function toValidation(report: ValidationReport): LocalAgentValidation {
  return {
    errors: toFindings(report.errors),
    warnings: toFindings(report.warnings),
    infos: toFindings(report.infos)
  }
}

/**
 * The variable **names** defined in `credentials/.env`. Values are never read,
 * never returned and never logged (Invariant 4) — only whether a slot is
 * filled reaches the renderer.
 */
export function readEnvKeys(agentDir: string): Set<string> {
  const keys = new Set<string>()
  let text: string
  try {
    text = readFileSync(join(agentDir, ENV_FILE), 'utf8')
  } catch {
    return keys
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (match) keys.add(match[1])
  }
  return keys
}

/** The `.env` names a slot expects: `<env_prefix><FIELD>`, upper-cased. */
function expectedKeysFor(slot: CredentialSlot): string[] {
  const prefix = typeof slot.env_prefix === 'string' ? slot.env_prefix : ''
  const fields = Array.isArray(slot.fields)
    ? slot.fields.filter((f): f is string => typeof f === 'string')
    : []
  if (prefix === '') return []
  if (fields.length === 0) return [prefix.replace(/_$/, '')]
  return fields.map((field) => `${prefix}${field.toUpperCase()}`)
}

function credentialStates(
  manifest: CinnaAgentManifest,
  envKeys: ReadonlySet<string>
): LocalAgentCredentialState[] {
  const slots = Array.isArray(manifest.credentials) ? manifest.credentials : []
  return slots
    .filter((slot): slot is CredentialSlot => slot !== null && typeof slot === 'object')
    .map((slot) => {
      const expectedKeys = expectedKeysFor(slot)
      const presentKeys = expectedKeys.filter((key) => envKeys.has(key))
      const optional = slot.optional === true
      return {
        name: typeof slot.name === 'string' ? slot.name : '(unnamed)',
        type: typeof slot.type === 'string' ? slot.type : 'unknown',
        optional,
        envPrefix: typeof slot.env_prefix === 'string' ? slot.env_prefix : null,
        expectedKeys,
        presentKeys,
        // A slot that declares no keys cannot be checked; treat it as satisfied
        // rather than blocking the agent on something we cannot verify.
        satisfied:
          optional || expectedKeys.length === 0 || presentKeys.length === expectedKeys.length
      }
    })
}

/** Frontmatter of `app-data/storage/STATUS.md`, or null when there is none. */
export function readStatus(agentDir: string, statusFile: string): LocalAgentStatusSummary | null {
  let text: string
  try {
    text = readFileSync(join(agentDir, statusFile), 'utf8')
  } catch {
    return null
  }
  const parsed = parseFrontmatter(text)
  if (!parsed) {
    // No frontmatter is fine: the file is still the Status card's body.
    return { summary: null, state: null, updatedAt: null, body: text }
  }
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = parsed.data[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
      if (typeof value === 'number') return String(value)
    }
    return null
  }
  return {
    summary: pick('summary', 'status_summary', 'headline'),
    state: pick('state', 'status', 'health'),
    // `timestamp` is first because it is what the contract's own
    // `scripts/update_status.py` writes (`render_status`, template
    // `scripts/update_status.py:59`) — every STATUS.md a scaffolded agent
    // produces uses that key, and without it the status the desktop shows has
    // no time on it at all. The rest are the synonyms a hand-written file uses.
    updatedAt: pick('timestamp', 'updated', 'updated_at', 'last_updated', 'generated_at'),
    body: parsed.body
  }
}

/**
 * The command catalog, localised. Never throws — `readCommandCatalog` returns an
 * empty catalog for a missing or unparseable file, and the validator is what
 * reports that as a finding.
 */
function commandsFor(
  agentDir: string,
  layout: LayoutView
): { commands: LocalAgentCommand[]; unreadable: number } {
  const context = { hasPyproject: existsSync(join(agentDir, 'pyproject.toml')) }
  const catalog = readCommandCatalog(agentDir, layout.layout.agent.command_catalog)
  return {
    commands: catalog.commands.map((command) => ({
      name: command.name,
      description: command.description,
      command: command.command,
      localCommand: layout.localizeCommand(command.command, context)
    })),
    // A command whose YAML entry did not parse is *dropped* from `commands`, so
    // a short list is indistinguishable from a correct one unless the count is
    // carried out. An agent with an unreadable command is not runnable, and the
    // validator reports it as an error — this is what makes that visible in the
    // readiness line rather than only in the findings list.
    unreadable: catalog.unreadable.length
  }
}

function stampsFor(agentDir: string): Record<string, FileStamp | null> {
  const stamps: Record<string, FileStamp | null> = {
    [MANIFEST_FILE]: readStamp(manifestPath(agentDir))
  }
  for (const relPath of Object.values(PROMPT_PATHS)) {
    stamps[relPath] = readStamp(join(agentDir, relPath))
  }
  return stamps
}

/**
 * Decide how ready a folder is, in the order the user cares about: a contract
 * this build cannot operate outranks a validation failure, which outranks a
 * missing credential.
 */
function readiness(
  contractStatus: ReturnType<typeof checkContractCompatibility>,
  report: ValidationReport,
  credentials: LocalAgentCredentialState[],
  unreadableCommands: number
): { readiness: LocalAgentReadiness; reason: string | null } {
  if (contractStatus.status === 'app_too_old') {
    return { readiness: 'contract_too_new', reason: contractStatus.reason }
  }
  if (!isValid(report)) {
    return { readiness: 'invalid', reason: report.errors[0]?.message ?? 'This agent does not validate.' }
  }
  if (unreadableCommands > 0) {
    // Belt and braces: the validator reports `commands.unparseable` as an error,
    // so this is normally unreachable. It stays because a dropped command is
    // silent by construction, and "the list looks fine, it just lost one" is
    // the worst way for that to surface.
    return {
      readiness: 'invalid',
      reason:
        unreadableCommands === 1
          ? 'One command in docs/CLI_COMMANDS.yaml could not be read.'
          : `${unreadableCommands} commands in docs/CLI_COMMANDS.yaml could not be read.`
    }
  }
  const missing = credentials.filter((c) => !c.satisfied)
  if (missing.length > 0) {
    const names = missing.map((c) => c.name).join(', ')
    return {
      readiness: 'credentials_needed',
      reason: `Add the credentials for ${names} in credentials/.env.`
    }
  }
  return { readiness: 'ok', reason: null }
}

/**
 * A folder that has no readable manifest still gets a *list entry* — with the
 * folder name standing in for the missing identity, and the finding that
 * explains it.
 *
 * Its identity is `unresolved`, which is the signal that this id is a
 * placeholder: `scanRoot` never writes such an entry to the index, and holds
 * back the row that is already there. Indexing it would insert a substitute row
 * and prune the real one, and `a2a_sessions` / `job_agents` cascade from
 * `agents.id` — so a manifest that is unparseable for the second an assistant
 * saves it would take the engine session with it, permanently.
 *
 * This is *not* the legacy case. A legacy manifest parsed; it simply says no
 * `id`, and a folder whose contents are readable is an agent the user can open
 * and run. See {@link LocalAgentIdentity}.
 */
function unreadableAgent(
  agentDir: string,
  root: AgentRootRow,
  finding: LocalAgentFinding
): LocalAgentDto {
  const slug = basename(agentDir)
  return {
    id: folderAgentId(`unreadable:${slug}`),
    manifestId: '',
    identity: 'unresolved',
    kind: 'kit',
    rootId: root.id,
    rootPath: root.path,
    path: agentDir,
    slug,
    name: slug,
    description: '',
    enabled: false,
    readiness: 'invalid',
    readinessReason: finding.message,
    contractStatus: 'unknown',
    manifest: {},
    publications: [],
    runtime: null,
    credentials: [],
    commands: [],
    status: null,
    validation: { errors: [finding], warnings: [], infos: [] },
    desktop: desktopStateService.summarize(desktopStateService.read(agentDir, 'kit')),
    stamps: stampsFor(agentDir),
    scannedAt: Date.now()
  }
}

/**
 * A bare agent's own findings — everything the desktop can say about a folder
 * that never promised to be kit-shaped.
 *
 * There is deliberately no *error* case for "it has no manifest": that is what
 * a bare agent **is**. The one error is a missing or unreadable `AGENT.md`,
 * because that is the whole contract, and a folder that has lost it is not an
 * agent any more. An empty one is a warning and not an error, matching the kit
 * path exactly — `promptAssembly` produces a stand-in section saying the file is
 * empty rather than a promptless agent, and erroring would instead drop the
 * folder out of the engine config with nothing on screen to explain it.
 */
function bareValidation(agentDir: string, promptText: string | null): LocalAgentValidation {
  const errors: LocalAgentFinding[] = []
  const warnings: LocalAgentFinding[] = []
  const infos: LocalAgentFinding[] = []

  if (promptText === null) {
    errors.push({
      code: 'bare.prompt.missing',
      message: `${BARE_AGENT_PROMPT_FILE} is missing or could not be read, so this folder has no instructions.`,
      path: BARE_AGENT_PROMPT_FILE
    })
  } else if (promptText.trim() === '') {
    warnings.push({
      code: 'bare.prompt.empty',
      message: `${BARE_AGENT_PROMPT_FILE} is empty, so this agent has no instructions yet.`,
      path: BARE_AGENT_PROMPT_FILE
    })
  }
  if (!existsSync(join(agentDir, BARE_AGENT_README_FILE))) {
    infos.push({
      code: 'bare.readme.missing',
      message: `No ${BARE_AGENT_README_FILE}, so an assistant opening this folder is briefed from ${BARE_AGENT_PROMPT_FILE} instead.`,
      path: BARE_AGENT_README_FILE
    })
  }
  infos.push({
    code: 'bare.no_manifest',
    message:
      'This folder has no cinna-agent.json, so it runs without commands, credential slots or a runtime it names itself.',
    path: MANIFEST_FILE
  })
  return { errors, warnings, infos }
}

export const scannerService = {
  markRootDirty,
  markAllRootsDirty,

  /**
   * Read one agent folder into a DTO. Never throws: a folder that cannot be
   * read comes back as an `invalid` row explaining why.
   */
  scanAgentFolder(agentDir: string, root: AgentRootRow): LocalAgentDto {
    const scannedAt = Date.now()
    let manifest: CinnaAgentManifest
    try {
      manifest = readWithStamp(manifestPath(agentDir)).manifest
    } catch (err) {
      const finding: LocalAgentFinding =
        err instanceof KitError
          ? { code: `manifest.${err.code}`, message: err.message, path: MANIFEST_FILE }
          : {
              code: 'manifest.unreadable',
              message: `${MANIFEST_FILE} could not be read.`,
              path: MANIFEST_FILE
            }
      if (!(err instanceof KitError)) {
        logger.error('unexpected failure reading a manifest', { agentDir, error: err })
      }
      return unreadableAgent(agentDir, root, finding)
    }

    const contract = resolveContract(root.path)
    const layout = getLayoutView(root.path)
    const folderName = basename(agentDir)

    const report = validateAgentFolder(agentDir, {
      layout,
      contractVersion: contract.version,
      folderName
    })
    const compatibility = checkContractCompatibility(manifest.contract_version, contract.version)
    const credentials = credentialStates(manifest, readEnvKeys(agentDir))
    const catalog = commandsFor(agentDir, layout)
    const { readiness: state, reason } = readiness(
      compatibility,
      report,
      credentials,
      catalog.unreadable
    )
    const desktop = desktopStateService.read(agentDir, 'kit')

    // A manifest with no `id` is legacy (contract 1.0.0 "Breaking"): the
    // contract tolerates it deliberately, so the folder is a *supported* agent
    // and is indexed like any other. What it cannot have is a durable identity,
    // so one is derived from where it sits — root id and folder name, because
    // two roots can each hold a folder of the same name. Renaming or moving it
    // therefore produces a different agent; "Stamp identity" is the fix, and
    // the readiness strip is where the user is told so.
    const manifestId = typeof manifest.id === 'string' && manifest.id !== '' ? manifest.id : ''
    const identity: LocalAgentIdentity = manifestId === '' ? 'legacy' : 'manifest'

    return {
      id:
        identity === 'legacy'
          ? legacyFolderAgentId(root.id, folderName)
          : folderAgentId(manifestId),
      manifestId,
      identity,
      kind: 'kit',
      rootId: root.id,
      rootPath: root.path,
      path: agentDir,
      slug: typeof manifest.slug === 'string' ? manifest.slug : folderName,
      name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : folderName,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      // Files-only default, matching what the insert writes. `enabled` is the
      // user's toggle, held in the index row, and
      // `localAgentService.overlayEnabled` folds the real value back in — the
      // scanner cannot know it, because no file states it.
      enabled: true,
      readiness: state,
      readinessReason: reason,
      contractStatus: compatibility.status,
      manifest,
      publications: Array.isArray(manifest.publications) ? manifest.publications : [],
      runtime: manifest.runtime ?? null,
      credentials,
      commands: catalog.commands,
      status: readStatus(agentDir, layout.layout.agent.status_file),
      validation: toValidation(report),
      desktop: desktopStateService.summarize(desktop),
      stamps: stampsFor(agentDir),
      scannedAt
    }
  },

  /**
   * Read one **bare** agent folder — a folder adopted for its `AGENT.md`.
   *
   * Nothing kit-shaped is consulted: no manifest, no contract, no layout, no
   * command catalog, no credential slots. What comes back is the same DTO
   * every other surface already renders, with the manifest-derived halves
   * empty, so the agents list, the page header, the readiness dot and the
   * counterparty pickers need no bare-agent branch of their own.
   *
   * Like {@link scanAgentFolder} it never throws: an unreadable `AGENT.md` is a
   * folder that is `invalid` with a finding naming the file, never an exception
   * that takes the root's whole scan with it.
   */
  scanBareAgentFolder(agentDir: string, root: AgentRootRow, relPath: string): LocalAgentDto {
    const scannedAt = Date.now()
    const promptStamp = readStamp(join(agentDir, BARE_AGENT_PROMPT_FILE))
    let promptText: string | null = null
    try {
      promptText = readFileSync(join(agentDir, BARE_AGENT_PROMPT_FILE), 'utf8')
    } catch {
      promptText = null
    }

    const validation = bareValidation(agentDir, promptText)
    const desktop = desktopStateService.read(agentDir, 'bare')
    // The user's own name wins over the file's, and the file's over the folder
    // name — the order the user would expect, and the only one where a rename
    // survives an edit to `AGENT.md`'s heading.
    const name =
      desktop.displayName && desktop.displayName.trim() !== ''
        ? desktop.displayName.trim()
        : readBareAgentName(agentDir)

    const readinessState: LocalAgentReadiness = validation.errors.length > 0 ? 'invalid' : 'ok'

    return {
      id: externalFolderAgentId(root.id, relPath),
      manifestId: '',
      identity: 'external',
      kind: 'bare',
      rootId: root.id,
      rootPath: root.path,
      path: agentDir,
      slug: basename(agentDir),
      name,
      // A bare folder states no description anywhere the desktop can trust.
      // The header says "No description yet" rather than repeating the name.
      description: '',
      enabled: true,
      readiness: readinessState,
      readinessReason: validation.errors[0]?.message ?? null,
      // Not `unknown`: that value means "a manifest states a version we could
      // not parse", and the page offers a re-stamp for it. A bare folder makes
      // no claim about the contract at all and has no manifest to stamp, so
      // `ok` is what keeps the readiness ladder and the engine's own gate from
      // treating it as a folder to hold back.
      contractStatus: 'ok',
      manifest: {},
      publications: [],
      runtime: null,
      credentials: [],
      commands: [],
      status: null,
      validation,
      desktop: desktopStateService.summarize(desktop),
      stamps: {
        [BARE_AGENT_PROMPT_FILE]: promptStamp,
        [BARE_AGENT_README_FILE]: readStamp(join(agentDir, BARE_AGENT_README_FILE))
      },
      scannedAt
    }
  },

  /**
   * List the agent folders of a root. Dot-directories are skipped: that is
   * where the scaffolder stages a folder before renaming it into place, and
   * where editors leave their own bookkeeping.
   */
  listAgentDirs(rootPath: string): string[] | null {
    const agentsDir = join(rootPath, AGENTS_SUBDIR)
    let entries: Dirent[]
    try {
      entries = readdirSync(agentsDir, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        logger.warn('could not list an agents root', { rootPath, code })
      }
      return null
    }
    const dirs: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(agentsDir, entry.name)
      // `withFileTypes` reports a symlink as a symlink; stat it so a workshop
      // assembled out of linked folders still scans.
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      dirs.push(full)
    }
    return dirs.sort()
  },

  /**
   * Scan a root and rebuild its slice of the index.
   *
   * Two ids can collide: a folder copied with its manifest keeps the original
   * `id`. The first folder (alphabetically) wins the row; later ones stay in
   * the returned list marked `invalid`, so the page can tell the user which two
   * folders claim the same identity instead of silently showing one.
   *
   * A folder whose identity could not be read at all is listed but **not
   * indexed**, and its path is passed to the prune as protected. An unreadable
   * folder changes readiness, never identity.
   *
   * A **legacy** folder (parsed manifest, no `id`) is indexed like any other,
   * under the positional id `folder:legacy:<rootId>:<folderName>`. It is
   * deliberately *not* added to the protected paths: its id is a pure function
   * of where it sits, so as long as the folder is there the scan produces the
   * same id and the row is kept on the ordinary ground. Protecting the path as
   * well would defeat re-keying — after "Stamp identity" the new
   * `folder:<uuid>` row and the old positional one both point at that folder,
   * and the stale one would survive forever. The transient case protection
   * exists for — a manifest unparseable for the second an assistant saves it —
   * is already covered, because such a folder scans as `unresolved`.
   */
  /**
   * The root's agents, scanning only if something has changed since last time.
   * The read path (`list`, `get`) uses this; anything that must observe the
   * disk as it is right now calls {@link scanRoot} directly.
   */
  scanRootCached(userId: string, root: AgentRootRow): ScanRootResult {
    const cached = lastScan.get(root.id)
    if (cached && cached.rootPath === root.path) return cached
    return this.scanRoot(userId, root)
  },

  scanRoot(userId: string, root: AgentRootRow): ScanRootResult {
    if (root.kind === 'external') return this.scanExternalRoot(userId, root)
    const started = Date.now()
    const dirs = this.listAgentDirs(root.path)
    if (dirs === null) {
      logger.warn('agents root is unavailable; leaving its index untouched', {
        rootId: root.id
      })
      // Not cached: an unavailable root should be retried, not remembered.
      return {
        rootId: root.id,
        rootPath: root.path,
        agents: [],
        rootMissing: true,
        indexed: 0,
        pruned: 0,
        hiddenCount: 0,
        truncated: false
      }
    }

    const agents: LocalAgentDto[] = []
    const entries: FolderIndexEntry[] = []
    // Folders that are on disk but whose identity could not be read. Their rows
    // must survive the prune — see `agentRepo.replaceFolderIndex`.
    const unresolvedPaths: string[] = []
    const claimed = new Map<string, string>()
    const rowsByPath = new Map(
      agentRepo
        .listFolder(userId)
        .filter((row) => row.localRootId === root.id && row.localPath !== null)
        .map((row) => [row.localPath as string, row.id])
    )

    for (const dir of dirs) {
      const scanned = this.scanAgentFolder(dir, root)
      // An unreadable folder keeps the id its row already has, so the page and
      // the list stay pointed at the same agent while it is being fixed.
      const dto =
        scanned.identity === 'unresolved' && rowsByPath.has(dir)
          ? { ...scanned, id: rowsByPath.get(dir) as string }
          : scanned
      if (scanned.identity === 'unresolved') {
        unresolvedPaths.push(dir)
        agents.push(dto)
        continue
      }
      const owner = claimed.get(dto.id)
      if (owner !== undefined) {
        const duplicate: LocalAgentFinding = {
          code: 'manifest.id.duplicate',
          message: `This agent has the same id as "${basename(owner)}". Give one of them a new id.`,
          path: MANIFEST_FILE
        }
        agents.push({
          ...dto,
          // A *different* id from the winner's, not the one they are fighting
          // over. The list keys and selects by this value, so leaving both rows
          // on `folder:<id>` gives React a duplicate key and makes a click on
          // this row open the winner's page — the user then edits files that
          // belong to the other folder, with nothing on screen saying so. It is
          // never indexed, so `locate()` refuses and the page says it cannot be
          // read rather than showing someone else's agent.
          id: duplicateFolderAgentId(root.id, basename(dir)),
          // `manifestId` stays the colliding value: it is what the two folders
          // actually claim, and the finding below names it.
          readiness: 'invalid',
          readinessReason: duplicate.message,
          validation: { ...dto.validation, errors: [duplicate, ...dto.validation.errors] }
        })
        logger.warn('two agent folders claim the same manifest id', { rootId: root.id })
        continue
      }
      claimed.set(dto.id, dir)
      agents.push(dto)
      entries.push({
        id: dto.id,
        name: dto.name,
        description: describedAs(dto) || null,
        localPath: dto.path,
        // Free here: the manifest is already parsed on the DTO, so the row's
        // copy is built at the one moment the files have just been read.
        remoteMetadata: synthesizeFolderAgentMetadata(dto.manifest)
      })
    }

    const { indexed, pruned } = agentRepo.replaceFolderIndex(
      userId,
      root.id,
      entries,
      unresolvedPaths,
      root.path
    )
    logger.info('agents root scanned', {
      rootId: root.id,
      found: agents.length,
      indexed,
      unresolved: unresolvedPaths.length,
      pruned,
      durationMs: Date.now() - started
    })
    const result: ScanRootResult = {
      rootId: root.id,
      rootPath: root.path,
      agents,
      rootMissing: false,
      indexed,
      pruned,
      hiddenCount: 0,
      truncated: false
    }
    lastScan.set(root.id, result)
    return result
  },

  /**
   * The cached scan of a root, or null when there is none for its current path.
   *
   * Read-only, for callers that need a *derived count* rather than the agents
   * themselves — the settings row's "N agents". Never triggers a scan: a caller
   * that gets null falls back to its own cheaper answer, so this can be asked
   * on any path without turning a render into a walk.
   */
  cachedScan(rootId: string, rootPath: string): ScanRootResult | null {
    const cached = lastScan.get(rootId)
    return cached && cached.rootPath === rootPath ? cached : null
  },

  /**
   * Scan an **external** root: a folder the user pointed at, walked for
   * `AGENT.md`.
   *
   * The differences from a workshop scan are all consequences of one thing —
   * nothing here has a manifest:
   *
   * - Identity is positional, from the root-relative path, so there is no id
   *   collision to arbitrate and no `unresolved` case to protect. A folder that
   *   has lost its `AGENT.md` is still *found* (the walk found it before, and it
   *   is only unreadable now, which is a readiness question) — no: the walk is
   *   what defines membership here, so a folder without `AGENT.md` is simply not
   *   an agent any more and its row is pruned like any other absent folder.
   * - There are no unresolved paths to protect from the prune, because the id
   *   is a pure function of where the folder sits: as long as it is there, the
   *   scan reproduces the same id and the row survives on the ordinary ground.
   * - Hidden agents are dropped *before* the index is built, which is what makes
   *   "remove from the list" outlive a rescan.
   *
   * A root whose folder has gone leaves the index untouched, exactly as a
   * workshop does, and for the same reason: an empty index would prune every
   * row and cascade their sessions away for an unmounted volume.
   */
  scanExternalRoot(userId: string, root: AgentRootRow): ScanRootResult {
    const started = Date.now()
    let rootReadable = false
    try {
      rootReadable = statSync(root.path).isDirectory()
    } catch {
      rootReadable = false
    }
    if (!rootReadable) {
      logger.warn('external agents folder is unavailable; leaving its index untouched', {
        rootId: root.id
      })
      // Not cached: an unavailable root should be retried, not remembered.
      return {
        rootId: root.id,
        rootPath: root.path,
        agents: [],
        rootMissing: true,
        indexed: 0,
        pruned: 0,
        hiddenCount: 0,
        truncated: false
      }
    }

    const { found, truncated } = discoverBareAgents(root.path)
    const agents: LocalAgentDto[] = []
    const entries: FolderIndexEntry[] = []
    // Counted here rather than walked again by the settings row: this loop has
    // already paid for the state read, and a second count is a second answer to
    // the same question.
    let hiddenCount = 0

    for (const folder of found) {
      // Read before scanning: a hidden folder must cost one small JSON read,
      // not a full DTO build, and must never reach the index.
      if (desktopStateService.read(folder.path, 'bare').hidden) {
        hiddenCount += 1
        continue
      }
      const dto = this.scanBareAgentFolder(folder.path, root, folder.relPath)
      agents.push(dto)
      entries.push({
        id: dto.id,
        name: dto.name,
        description: describedAs(dto) || null,
        localPath: dto.path,
        // Nothing to synthesize from: a bare folder declares no example
        // prompts, so the `#` list and the agents-as-MCP tool description fall
        // back to their own framing rather than to an invented one.
        remoteMetadata: synthesizeFolderAgentMetadata({})
      })
    }

    const { indexed, pruned } = agentRepo.replaceFolderIndex(userId, root.id, entries, [], root.path)
    logger.info('external agents folder scanned', {
      rootId: root.id,
      found: found.length,
      listed: agents.length,
      indexed,
      pruned,
      truncated,
      durationMs: Date.now() - started
    })
    const result: ScanRootResult = {
      rootId: root.id,
      rootPath: root.path,
      agents,
      rootMissing: false,
      indexed,
      pruned,
      hiddenCount,
      truncated
    }
    lastScan.set(root.id, result)
    return result
  }
}
