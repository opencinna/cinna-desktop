/**
 * **Move to vault…** and **Move out of vault…** (README "Moving an existing
 * agent"), the host copy left behind, and the gated file and dependency
 * actions on a vault agent.
 *
 * Move in, in order (`VAULT_MOVE_STEPS`): pre-check → create the vault →
 * unlock (helper prompt) → approve the move (helper prompt; a session token
 * for import, runtime install and the rebuild) → install the pinned runtime
 * (D28) → copy the folder in (no build outputs, no generated credential file,
 * git history included, D12) → rebuild inside (one `rebuild` exec: `uv python install`, then `uv sync`
 * when there is a `pyproject.toml`) → credentials (an API key with
 * `secrets.put`; `.env` travels as a file) → check (the agent's own check,
 * then the engine answers `initialize` and `session/new`, no prompt) → the
 * agent row becomes a vault agent's.
 *
 * Until that last step the host agent is untouched (this file only reads the
 * folder) and any failure or cancel destroys the half-built vault. The
 * helper verifies a destroy token itself and only for `destroy`, so the
 * rollback asks once more (its own prompt, "permanently delete the vault of
 * agent …"); declining it leaves the empty vault in `SecureAgents/` and says
 * so. After success the host folder is still there: {@link hostCopy} reports
 * it and {@link deleteHostCopy} deletes it for real (not to the Trash, which
 * would keep the secrets on this disk).
 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, type Dirent } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { agentRepo, type AgentRow } from '../db/agents'
import { agentMcpRepo } from '../db/agentMcp'
import { delegationRepo } from '../db/delegations'
import { handoverRepo } from '../db/handovers'
import { localScheduleRepo } from '../db/localSchedules'
import { taskRepo } from '../db/tasks'
import { publishEvent } from '../host/events'
import { createLogger } from '../logger/logger'
import { agentsHomeService } from '../services/localAgents/agentsHomeService'
import { localAgentService } from '../services/localAgents/localAgentService'
import { isWithin } from '../services/localAgents/pathRules'
import { markRootDirty } from '../services/localAgents/scannerService'
import { AGENTS_SUBDIR, LOCAL_AGENT_CHANGED_CHANNEL, externalFolderAgentId, folderAgentId, legacyFolderAgentId, slugifyAgentName, type LocalAgentChangedPayload, type LocalAgentDto } from '../../shared/localAgents'
import type { ClaudeApproval } from '../../shared/engine'
import { DEFAULT_AGENT_ENGINE, type AgentEngine } from '../../shared/engine'
import { launcherOfFolder } from '../agents/drivers/driverOf'
import {
  VAULT_DEFAULT_SIZE_BYTES,
  VAULT_ENGINE_HOSTS,
  VAULT_LAUNCH_MODEL,
  VAULT_LAUNCH_PROVIDERS,
  approvalDetail,
  vaultEngineKeyName,
  vaultEngineLoginSecret,
  vaultKvInstructionsFor,
  VAULT_ENGINE_LOGIN,
  VAULT_ENGINE_NAMES_MODEL,
  type ExecPreset,
  type RuntimeKind,
  type VaultEngine,
  type VaultLaunchProvider
} from '../../shared/vault/protocol'
import {
  VAULT_MOVE_PROGRESS_CHANNEL,
  type VaultEngineChoiceDto,
  type VaultHostCopyDto,
  type VaultMoveOptions,
  type VaultMoveProgressEvent,
  type VaultMoveStep,
  type VaultPrecheckDto,
  type VaultPrecheckItem,
  type VaultRotationItem
} from '../../shared/vault/types'
import { vaultBackend, VaultBackendError } from './backend'
import { refreshVaultAgents } from './isVaultAgent'
import { currentRuntimeRow, defaultRuntimeSource, ensureRuntimes, tarFiles, type RuntimePin, type RuntimeSource } from './runtimeInstall'
import { VAULT_KV_INSTRUCTIONS, vaultAgentState } from './vaultAgentState'
import { installedRuntime } from '../agents/drivers/acp/vaultLauncher'
import { turnLock } from '../services/localAgents/turnLock'
import { LocalAgentError } from '../errors'
import type { VaultdClient } from './vaultdClient'
import { vaultHost } from './vaultHost'
import { hostCopyPathOf } from './hostCopy'
import { VaultError, refuseBadLogin, vaultService } from './vaultService'

import { ensureGuestImage } from './guestImage'
import { vaultCredentials } from './vaultCredentials'
import { MANIFEST_FILE } from '../../shared/kit/manifest'

const logger = createLogger('vault-move')

const VAULT_ENGINE_NAME: Record<VaultEngine, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }
const KEY_OWNER: Record<string, string> = { ANTHROPIC_API_KEY: 'an Anthropic', OPENAI_API_KEY: 'an OpenAI', GEMINI_API_KEY: 'a Gemini' }

/** The agent list and page re-read the agent: it became, or stopped being, a vault agent. */
function agentChanged(rootId: string, agentId: string): void {
  publishEvent(LOCAL_AGENT_CHANGED_CHANNEL, { rootId, agentId, reason: 'vault' } satisfies LocalAgentChangedPayload)
}

type Client = Pick<VaultdClient, 'request' | 'attach' | 'onNotification'>

// ---------------------------------------------------------------------------
// Dependencies the composition root fills in

export interface MoveDeps {
  /** Where runtime bytes come from (default: the pinned download and this app's adapter). */
  runtimeSource(): RuntimeSource
  /** A kit agent's prompt as the host assembles it for `engine`, captured into the vault at move-in. Null: none. */
  instructions(userId: string, agentId: string, engine: VaultEngine): string | null
  /**
   * The model alias and approval mode the agent runs on now (kept on the vault
   * agent's row), and the type of the credential its model is on (`openai`,
   * `anthropic`, …; null when none): which key OpenCode signs in with inside.
   */
  launchFacts(userId: string, agentId: string): { model: string | null; approval: ClaudeApproval; provider?: string | null }
  /** True when this computer's Claude runs on a subscription login, which cannot be handed into a vault. */
  hostClaudeOnSubscription(): Promise<boolean>
  /** This computer's Default Runtime: what a folder that names no engine runs on. */
  defaultEngine(): AgentEngine
  /**
   * The agent has background work running (a subagent or a background task of
   * its engine's process): a follow-up turn would open on that process when it
   * ends, whatever engine the row names by then.
   */
  hasBackgroundWork(agentId: string): boolean
  /** Stop the agent's engine processes (now when idle, else when their last turn lets go). */
  stopAgentProcesses(agentId: string): void | Promise<void>
}

let deps: MoveDeps = {
  runtimeSource: defaultRuntimeSource,
  instructions: () => null,
  launchFacts: () => ({ model: null, approval: 'ask' }),
  hostClaudeOnSubscription: async () => true,
  defaultEngine: () => DEFAULT_AGENT_ENGINE,
  hasBackgroundWork: () => false,
  stopAgentProcesses: () => {}
}

export function installVaultMoveDeps(next: Partial<MoveDeps>): void {
  deps = { ...deps, ...next }
}

/** What this app installs of an engine in a vault (the runtime source's pins): the vault launcher runs nothing else. */
export function vaultRuntimePins(engine: VaultEngine): RuntimePin[] {
  return deps.runtimeSource().pins(engine)
}

// ---------------------------------------------------------------------------
// The name the helper prompts with

/** The longest agent name the helper accepts in `vault.create` (it names the agent in its own prompts). */
const PROMPT_NAME_MAX = 60
/** What the helper accepts in a name: Unicode letters, decimal digits, spaces and `. _ - ' ( )`. */
const PROMPT_NAME_DISALLOWED = /[^\p{L}\p{Nd} ._'()-]/gu

function cleanPromptName(raw: string): string {
  const cleaned = raw.normalize('NFC').replace(PROMPT_NAME_DISALLOWED, ' ').replace(/ +/g, ' ').trim()
  // Capped by code points, never through a surrogate pair; trimmed again after the cut.
  return [...cleaned].slice(0, PROMPT_NAME_MAX).join('').trim()
}

/**
 * The agent's name as the helper's prompts show it: every character outside
 * its set becomes a space, runs of spaces collapse, trimmed, at most 60
 * characters. A name with nothing left falls back to the folder's slug, then
 * to "Agent", so an unusual name never fails a move.
 */
export function vaultPromptName(name: string, slug?: string | null): string {
  return cleanPromptName(name) || cleanPromptName(slug ?? '') || 'Agent'
}

// ---------------------------------------------------------------------------
// The folder, as it would be copied

/** Directory names never copied, wherever they are (build outputs, rebuilt inside). */
const SKIP_DIRS = new Set(['.venv', 'node_modules', '__pycache__'])
/** Folder-relative paths never copied: runtime state and files Cinna generates on this computer. */
const SKIP_PATHS = new Set(['.cinna', 'app-data/desktop.json', 'credentials/credentials.json'])
const SKIP_FILES = new Set(['.DS_Store'])
/** A kit's generated side files `credentials/<id>/credentials.json`. */
const GENERATED_SIDE_FILE = /^credentials\/[a-zA-Z0-9_-]{1,128}\/credentials\.json$/
/** Above this the copy is refused (the default disk is 10 GB and needs room for the rebuild). */
const MAX_COPY_BYTES = 8 * 1024 ** 3
const SCRIPT_EXTENSIONS = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|command|applescript)$/i
const MAC_COMMAND = /(^|[\s;&|(`$"'])(osascript|pbcopy|pbpaste|security\s+(find|add|delete|unlock)-[a-z-]+|open\s+(-[a-zA-Z]\b|https?:\/\/|"?\/|\.))/m
const MAX_SCAN_BYTES = 512 * 1024

export interface FolderInventory {
  /** Folder-relative entries to copy (directories included, so empty ones survive), sorted. */
  entries: string[]
  files: number
  bytes: number
  /** Links that point outside the folder or name `..`: not copied. */
  outsideLinks: string[]
  macho: string[]
  macCommands: string[]
}

function machoMagic(path: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(8)
    const n = readSync(fd, head, 0, 8, 0)
    if (n < 4) return false
    const magic = head.readUInt32BE(0)
    if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) return true
    // Universal binaries share 0xCAFEBABE with Java classes; a fat header's arch count is small.
    return magic === 0xcafebabe && n >= 8 && head.readUInt32BE(4) > 0 && head.readUInt32BE(4) < 20
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function looksLikeScript(path: string, name: string, size: number): boolean {
  if (size > MAX_SCAN_BYTES) return false
  if (SCRIPT_EXTENSIONS.test(name)) return true
  if (name.includes('.')) return false
  try {
    const fd = openSync(path, 'r')
    try {
      const head = Buffer.alloc(2)
      return readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === '#!'
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/** Walk the agent folder as the copy would see it. Never follows a link. */
export function inventoryFolder(root: string): FolderInventory {
  const out: FolderInventory = { entries: [], files: 0, bytes: 0, outsideLinks: [], macho: [], macCommands: [] }
  const walk = (rel: string): void => {
    const entries: Dirent[] = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(root, child)
      if (SKIP_PATHS.has(child) || GENERATED_SIDE_FILE.test(child)) continue
      if (entry.isSymbolicLink()) {
        let target = ''
        try { target = readlinkSync(full) } catch { continue }
        if (isAbsolute(target) || target.split(/[\\/]/).includes('..')) out.outsideLinks.push(child)
        else out.entries.push(child)
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        out.entries.push(child)
        walk(child)
        continue
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue
      let size = 0
      try { size = statSync(full).size } catch { continue }
      out.entries.push(child)
      out.files++
      out.bytes += size
      if (child.startsWith('.git/')) continue
      if (machoMagic(full)) out.macho.push(child)
      else if (looksLikeScript(full, entry.name, size)) {
        try {
          if (MAC_COMMAND.test(readFileSync(full, 'utf8'))) out.macCommands.push(child)
        } catch {
          // unreadable: not scanned
        }
      }
    }
  }
  walk('')
  return out
}

/** The nearest `.git` above or at `dir`, and its first remote URL. */
function gitInfo(dir: string): { inGitRepo: boolean; remote: string | null } {
  for (let current = dir; ; current = dirname(current)) {
    const git = join(current, '.git')
    if (existsSync(git)) {
      let remote: string | null = null
      try {
        const config = readFileSync(lstatSync(git).isDirectory() ? join(git, 'config') : git, 'utf8')
        remote = /\[remote "[^"]+"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1] ?? null
      } catch {
        // a worktree's .git file, or unreadable
      }
      return { inGitRepo: true, remote }
    }
    if (dirname(current) === current) return { inGitRepo: false, remote: null }
  }
}

/** Variable names in a `.env` file (never values). */
function envNames(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n')
      .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((name): name is string => !!name)
  } catch {
    return []
  }
}

function envFiles(folder: string): string[] {
  return ['.env', 'credentials/.env'].filter((rel) => existsSync(join(folder, rel)))
}

const cap = (paths: string[]): string[] => paths.slice(0, 20)

// ---------------------------------------------------------------------------
// Pre-check

/**
 * The engines an agent can move into a vault on. Antigravity signs in with a
 * Gemini API key inside (its Google sign-in cannot be completed there).
 */
const VAULT_MOVE_ENGINES = ['claude', 'codex', 'opencode', 'antigravity'] as const satisfies readonly VaultEngine[]

function launchFactsOf(userId: string, agentId: string): { model: string | null; approval: ClaudeApproval; provider?: string | null } {
  try { return deps.launchFacts(userId, agentId) } catch { return { model: null, approval: 'ask' } }
}

/** The OpenCode provider a credential type maps to inside a vault, or null when a vault cannot reach it. */
function launchProvider(facts: { provider?: string | null }): VaultLaunchProvider | null {
  return facts.provider === 'openai' || facts.provider === 'anthropic' ? facts.provider : null
}

interface Located {
  row: AgentRow
  dto: LocalAgentDto
  engine: string
  rootIsDefault: boolean
}

function locate(userId: string, agentId: string): Located {
  const row = typeof agentId === 'string' ? agentRepo.getOwned(userId, agentId) : undefined
  if (!row) throw new VaultError('not_found', 'That agent is not on this computer.')
  if (row.source === 'vault') throw new VaultError('invalid', 'That agent is already in a vault.')
  if (row.source !== 'folder') throw new VaultError('invalid', 'Only a local agent can move into a vault.')
  let dto: LocalAgentDto
  try {
    dto = localAgentService.get(userId, agentId)
  } catch {
    throw new VaultError('not_found', 'That agent’s folder could not be read.')
  }
  // The engine a turn would run on: the folder's, else this computer's default (never the row's cached launcher).
  const engine: string = launcherOfFolder(dto.runtime as { engine?: unknown } | null, (() => {
    try { return deps.defaultEngine() } catch { return DEFAULT_AGENT_ENGINE }
  })())
  const rootIsDefault = agentsHomeService.rootRows(userId).find((root) => root.id === dto.rootId)?.isDefault === true
  return { row, dto, engine, rootIsDefault }
}

/**
 * A Python project's dependencies inside a vault: the rebuild installs exactly
 * what `uv.lock` pins, from wheels only (`uv sync --locked --no-build`, D37).
 * A project without a lock (a fresh kit agent) is locked inside on the first
 * install (`uv lock --no-build`, vaultd's `rebuild`), which is said; one with
 * a lock is told that a package with no wheel for Linux will not install.
 * Which package needs a source build cannot be known cheaply here, so that is
 * said, not checked.
 */
function pythonFindings(folder: string): VaultPrecheckItem[] {
  if (!existsSync(join(folder, 'pyproject.toml'))) return []
  if (!existsSync(join(folder, 'uv.lock'))) {
    return [{ kind: 'python-lock', severity: 'info', title: 'No uv.lock: the vault resolves and locks dependencies on first install', detail: 'From prebuilt Linux wheels only; a package that only builds from source will not install.', paths: ['pyproject.toml'] }]
  }
  return [{ kind: 'python-wheels', severity: 'info', title: 'Python packages install from wheels only', detail: 'A vault installs the versions in uv.lock as prebuilt Linux wheels; a package that only builds from source will not install.' }]
}

/** Cinna channels the agent is part of that stop working inside a vault (D6). Never throws. */
function channelFindings(userId: string, agentId: string, manifestId: string): VaultPrecheckItem[] {
  const items: VaultPrecheckItem[] = []
  const safe = <T>(fn: () => T, fallback: T): T => {
    try { return fn() } catch { return fallback }
  }
  const mcp = safe(() => agentMcpRepo.listProviderIds(userId, agentId), [] as string[])
  if (mcp.length > 0) {
    items.push({ kind: 'host-mcp', severity: 'warning', title: `${mcp.length} MCP server${mcp.length === 1 ? '' : 's'} on this computer will be disconnected`, detail: 'A vault reaches no server on this computer.' })
  }
  const schedules = safe(() => localScheduleRepo.list(userId).filter((s) => s.manifestId === manifestId), [])
  if (schedules.length > 0) {
    items.push({ kind: 'schedule', severity: 'warning', title: `${schedules.length} schedule${schedules.length === 1 ? '' : 's'} will stop`, detail: schedules.map((s) => s.name).slice(0, 5).join(', ') })
  }
  const OPEN_DELEGATION = new Set(['seen', 'gated', 'running', 'waiting_external', 'blocked', 'creating', 'uncertain', 'waiting_user'])
  const delegations = safe(() => delegationRepo.listByOriginAgent(userId, agentId).filter((d) => OPEN_DELEGATION.has(d.state)), [])
  if (delegations.length > 0) {
    items.push({ kind: 'delegation-grant', severity: 'warning', title: 'Delegation to and from other agents stops', detail: `${delegations.length} open delegation${delegations.length === 1 ? '' : 's'} will not get an answer from inside the vault.` })
  }
  const OPEN_TASK = new Set(['new', 'refining', 'open', 'in_progress', 'blocked'])
  const tasks = safe(() => taskRepo.list(userId).filter((t) => t.assigneeAgentId === agentId && OPEN_TASK.has(t.status)), [])
  if (tasks.length > 0) {
    items.push({ kind: 'pending-task', severity: 'warning', title: `${tasks.length} open task${tasks.length === 1 ? '' : 's'} assigned to it`, detail: 'Tasks are not delivered into a vault.' })
  }
  const OPEN_HANDOVER = new Set(['seen', 'gated', 'running', 'waiting_external', 'blocked'])
  const handovers = safe(() => handoverRepo.listForAgent(userId, agentId).filter((h) => OPEN_HANDOVER.has(h.state)), [])
  if (handovers.length > 0) {
    items.push({ kind: 'pending-handover', severity: 'warning', title: `${handovers.length} pending handover${handovers.length === 1 ? '' : 's'}`, detail: 'Handovers are not picked up inside a vault.' })
  }
  return items
}

export async function precheck(userId: string, agentId: string): Promise<VaultPrecheckDto> {
  const { row, dto, engine, rootIsDefault } = locate(userId, agentId)
  const folder = dto.path
  const items: VaultPrecheckItem[] = []
  const vaultEngine = (VAULT_MOVE_ENGINES as readonly string[]).includes(engine) ? engine as VaultEngine : null
  if (!vaultEngine) {
    items.push({ kind: 'unsupported-engine', severity: 'blocker', title: `Agents in a vault cannot run on ${engine}`, detail: 'Switch its runtime to Claude, Codex or OpenCode first.' })
  }
  const facts = launchFactsOf(userId, row.id)
  if (vaultEngine === 'opencode' && !launchProvider(facts)) {
    items.push({ kind: 'unsupported-engine', severity: 'blocker', title: 'OpenCode in a vault reaches OpenAI and Anthropic models only', detail: 'Choose a model on an OpenAI or Anthropic credential first.' })
  } else if (vaultEngine === 'opencode' && !facts.model) {
    items.push({ kind: 'unsupported-engine', severity: 'blocker', title: 'This agent names no model', detail: 'Choose its model first; OpenCode inside a vault runs on the one it names.' })
  }
  if (!rootIsDefault) {
    items.push({ kind: 'external-root', severity: 'blocker', title: 'Only agents in your main agents folder can move into a vault', detail: 'Vaults live in the default workshop; Cinna installs nothing in an added folder.' })
  }
  const inventory = inventoryFolder(folder)
  if (inventory.bytes > MAX_COPY_BYTES) {
    items.push({ kind: 'too-large', severity: 'blocker', title: `The folder is ${Math.round(inventory.bytes / 1024 ** 3)} GB without build outputs`, detail: 'A vault holds up to 10 GB, with room needed to rebuild inside.' })
  }
  items.push(...pythonFindings(folder))
  if (inventory.macCommands.length > 0) {
    items.push({ kind: 'mac-command', severity: 'warning', title: 'Scripts use Mac-only commands', detail: 'osascript, open, security and pbcopy do not exist inside a vault.', paths: cap(inventory.macCommands) })
  }
  if (inventory.macho.length > 0) {
    items.push({ kind: 'macho-binary', severity: 'warning', title: 'Mac programs or libraries are committed', detail: 'They cannot run inside a vault (it is Linux).', paths: cap(inventory.macho) })
  }
  if (inventory.outsideLinks.length > 0) {
    items.push({ kind: 'absolute-symlink', severity: 'warning', title: 'Links that point outside the folder are not copied', paths: cap(inventory.outsideLinks) })
  }
  items.push(...channelFindings(userId, agentId, dto.manifestId))
  const attached = dto.credentials.filter((c) => (c as { attached?: unknown }).attached !== false)
  if (attached.length > 0) {
    items.push({ kind: 'service-credential', severity: 'info', title: `${attached.length} service credential${attached.length === 1 ? '' : 's'} move${attached.length === 1 ? 's' : ''} in with it`, detail: 'They are delivered into the vault before each turn; rotate them after the move, since they were on this computer before.' })
  }
  const envs = envFiles(folder)
  if (envs.length > 0) {
    items.push({ kind: 'env-file', severity: 'info', title: 'The .env file moves in as a file', detail: 'Its values stay readable to the agent inside the vault; rotate them after the move.', paths: envs })
  }
  const git = gitInfo(folder)
  if (git.remote) {
    items.push({ kind: 'git-remote', severity: 'info', title: 'The folder is pushed to a git remote', detail: `${git.remote} keeps a copy of everything committed.` })
  }
  const tm = await vaultHost().timeMachineIncludes(folder).catch(() => null)
  if (tm === true) {
    items.push({ kind: 'time-machine', severity: 'info', title: 'Time Machine has backed this folder up', detail: 'Older copies stay in your backups after the host copy is deleted.' })
  }
  // The other engines' logins here (a ChatGPT or Google sign-in, Cinna's own provider keys) never go in: always a key.
  const needsApiKey = vaultEngine === 'claude' ? await deps.hostClaudeOnSubscription().catch(() => true) : vaultEngine !== null
  const apiKeyName = vaultEngine ? vaultEngineKeyName(vaultEngine, launchProvider(facts)) : null
  if (needsApiKey && vaultEngine) {
    const keyName = apiKeyName
    const owner = keyName ? KEY_OWNER[keyName] ?? 'an' : 'an'
    const name = VAULT_ENGINE_NAME[vaultEngine]
    items.push({ kind: 'engine-login', severity: 'info', title: `${name} needs an API key inside the vault`, detail: `Your ${name} login on this computer cannot be handed into a vault. Paste ${VAULT_ENGINE_LOGIN[vaultEngine]?.what ?? `${owner} API key`}, or add one later.` })
  }
  return {
    agentId: row.id,
    agentName: row.name,
    engine: vaultEngine,
    folderPath: folder,
    copyBytes: inventory.bytes,
    copyFiles: inventory.files,
    items,
    canMove: !items.some((item) => item.severity === 'blocker'),
    needsApiKey,
    apiKeyName
  }
}

// ---------------------------------------------------------------------------
// Streams to and from vaultd

/** Wait for one of vaultd's per-stream notifications (or its `stream.error`). Listening starts now. */
function awaitStream<T>(client: Client, method: 'files.imported' | 'runtime.installed' | 'exec.exit', streamOf: () => string | null): { done: Promise<T>; stop: () => void } {
  const early = new Map<string, T | Error>()
  let settle!: (value: T | Error) => void
  const done = new Promise<T | Error>((resolve) => { settle = resolve })
  const stop = client.onNotification((notification) => {
    const params = notification.params as { stream: string; message?: string }
    let value: T | Error | null = null
    if (notification.method === method) value = notification.params as unknown as T
    else if (notification.method === 'stream.error') value = new VaultError('internal', params.message ?? 'The vault refused the stream.')
    if (value === null) return
    const stream = streamOf()
    if (stream === null) early.set(params.stream, value)
    else if (params.stream === stream) settle(value)
  })
  return {
    done: (async () => {
      // Notifications that arrived before the stream id was known.
      const poll = setInterval(() => {
        const stream = streamOf()
        if (stream !== null && early.has(stream)) settle(early.get(stream)!)
      }, 20)
      try {
        const value = await done
        if (value instanceof Error) throw value
        return value
      } finally {
        clearInterval(poll)
        stop()
      }
    })(),
    stop
  }
}

async function pushInto(client: Client, stream: string, bytes: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
  const channel = await client.attach(stream)
  const writer = channel.writable.getWriter()
  try {
    for await (const chunk of bytes) {
      if (signal?.aborted) throw new VaultError('invalid', 'The move was cancelled.')
      await writer.write(chunk)
    }
    await writer.close()
  } catch (error) {
    channel.close('push failed')
    throw error
  } finally {
    writer.releaseLock()
  }
}

/** Run an exec preset, streaming its output to `onOutput`; resolves with the exit code. */
async function runExec(client: Client, preset: ExecPreset, token: string, onOutput: (text: string) => void, signal?: AbortSignal): Promise<number | null> {
  let stream: string | null = null
  const waiter = awaitStream<{ code: number | null }>(client, 'exec.exit', () => stream)
  try {
    stream = (await client.request('exec', { preset, token })).stream
    const channel = await client.attach(stream)
    const reader = channel.readable.getReader()
    const decoder = new TextDecoder()
    const onAbort = (): void => channel.close('cancelled')
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        if (text) onOutput(text)
      }
    } catch {
      // the stream broke: the exit (or the abort) says why
    } finally {
      signal?.removeEventListener('abort', onAbort)
      reader.releaseLock()
      channel.close('done')
    }
    if (signal?.aborted) throw new VaultError('invalid', 'The move was cancelled.')
    return (await waiter.done).code
  } catch (error) {
    waiter.stop()
    throw error
  }
}

/** A tar of the agent folder, as {@link inventoryFolder} lists it (no recursion: the list is complete). */
async function* folderTar(folder: string, entries: readonly string[]): AsyncIterable<Uint8Array> {
  yield* tarFiles(folder, entries, { noRecursion: true })
}

// ---------------------------------------------------------------------------
// Move in

interface MoveRun {
  moveId: string
  agentId: string
  controller: AbortController
  done: Promise<void>
}

const moves = new Map<string, MoveRun>()
const movingAgents = new Set<string>()

function emit(event: VaultMoveProgressEvent): void {
  publishEvent(VAULT_MOVE_PROGRESS_CHANNEL, event, 'all')
}

/** One `VaultMoveProgressEvent` emitter per move. */
function reporter(moveId: string, agentId: string) {
  return {
    step(step: VaultMoveStep, status: VaultMoveProgressEvent['status'], message?: string): void {
      emit({ moveId, agentId, step, status, ...(message ? { message } : {}) })
    },
    output(step: VaultMoveStep, output: string): void {
      emit({ moveId, agentId, step, status: 'running', output })
    },
    final(event: Omit<VaultMoveProgressEvent, 'moveId' | 'agentId'>): void {
      emit({ moveId, agentId, ...event })
    }
  }
}

/** The initialize a move's check sends: the same client the driver is, asking nothing else. */
const CHECK_INIT = {
  protocolVersion: 1,
  clientCapabilities: { elicitation: { form: {} } },
  clientInfo: { name: 'cinna-desktop', version: '1' }
} as const

/** ACP's `auth_required`: the engine answered, and wants the login the vault does not have yet. */
const ACP_AUTH_REQUIRED = -32000

/**
 * The engine answers initialize and session/new inside the vault; no prompt.
 * An engine with no login yet (Codex without a key, Antigravity always)
 * answers session/new with `auth_required`, which is an answer: the move goes
 * on and readiness asks for the login.
 */
async function checkEngine(client: Client, agentId: string, vaultId: string, engine: VaultEngine): Promise<void> {
  const { startVaultAcpConnection } = await import('../agents/drivers/acp/vaultAcpConnection')
  // `mode` is Claude's alone; vaultd ignores it for the others.
  const connection = await startVaultAcpConnection({ agentId, vaultId, engine, extraEnv: {}, mode: 'default' }, { ...CHECK_INIT } as never, { client: async () => client, startTimeoutMs: 60_000 })
  try {
    await connection.newSession({ cwd: vaultService.agentCwd(vaultId), mcpServers: [] }).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === ACP_AUTH_REQUIRED) return null
      throw error
    })
  } finally {
    await connection.dispose()
  }
}

export interface MoveInOptions extends VaultMoveOptions {}

/**
 * Start Move to vault…; progress on `vault:move-progress`. Refused at once
 * (nothing created) when the pre-check has a blocker or the agent is moving.
 */
export async function moveIn(userId: string, agentId: string, options: unknown): Promise<{ moveId: string }> {
  const opts = parseMoveOptions(options)
  const check = await precheck(userId, agentId)
  if (!check.canMove) {
    const blocker = check.items.find((item) => item.severity === 'blocker')
    throw new VaultError('invalid', blocker?.title ?? 'This agent cannot move into a vault.')
  }
  // A key that cannot sign in fails here, in the dialog, not at the first prompt after the move.
  // Before the busy check: it can wait on the provider for seconds, and the
  // check and the add below must stay one synchronous step.
  if (opts.apiKey) {
    const engine: VaultEngine = check.engine ?? 'claude'
    // Only OpenCode's key name depends on the provider; the others ignore it.
    await refuseBadLogin(vaultEngineLoginSecret(engine, launchProvider(launchFactsOf(userId, agentId)), opts.apiKey) ?? 'ANTHROPIC_API_KEY', opts.apiKey)
  }
  if (movingAgents.has(agentId)) throw new VaultError('busy', 'This agent is already moving.')
  const moveId = randomUUID()
  const controller = new AbortController()
  movingAgents.add(agentId)
  const run: MoveRun = {
    moveId, agentId, controller,
    done: runMoveIn(userId, agentId, moveId, check, opts, controller.signal).finally(() => {
      movingAgents.delete(agentId)
      moves.delete(moveId)
    })
  }
  moves.set(moveId, run)
  return { moveId }
}

export function cancelMove(moveId: unknown): void {
  const run = typeof moveId === 'string' ? moves.get(moveId) : undefined
  if (!run) throw new VaultError('not_found', 'That move is not running.')
  run.controller.abort()
}

function parseMoveOptions(raw: unknown): VaultMoveOptions {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: VaultMoveOptions = {}
  if (value['sizeBytes'] !== undefined) {
    const size = value['sizeBytes']
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1024 ** 3 || size > 2 * 1024 ** 4) throw new VaultError('invalid', 'Choose a size between 1 GB and 2 TB.')
    out.sizeBytes = size
  }
  if (value['apiKey'] !== undefined && value['apiKey'] !== '') {
    const key = value['apiKey']
    if (typeof key !== 'string' || key.trim().length < 10 || key.length > 512 || /\s/.test(key.trim())) throw new VaultError('invalid', 'That does not look like an API key.')
    out.apiKey = key.trim()
  }
  if (value['extraHosts'] !== undefined) {
    if (!Array.isArray(value['extraHosts']) || value['extraHosts'].length > 100) throw new VaultError('invalid', 'The extra hosts are not valid.')
    out.extraHosts = value['extraHosts'].map((host) => {
      const h = typeof host === 'string' ? host.trim().toLowerCase() : ''
      if (!/^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h)) throw new VaultError('invalid', `"${String(host).slice(0, 80)}" is not a host name.`)
      return h
    })
  }
  return out
}

async function runMoveIn(userId: string, agentId: string, moveId: string, check: VaultPrecheckDto, options: VaultMoveOptions, signal: AbortSignal): Promise<void> {
  const report = reporter(moveId, agentId)
  const backend = vaultBackend()
  const located = locate(userId, agentId)
  const folder = located.dto.path
  // The pre-check refuses a move with no engine a vault runs.
  const engine: VaultEngine = check.engine ?? 'claude'
  const vaultId = `v${randomUUID().replace(/-/g, '').slice(0, 20)}`
  let created = false
  let marked = false
  let current: VaultMoveStep = 'create'
  let release: (() => Promise<void>) | null = null
  const cancelled = (): void => {
    if (signal.aborted) throw new VaultError('invalid', 'The move was cancelled.')
  }
  const step = async <T>(name: VaultMoveStep, fn: () => Promise<T>): Promise<T> => {
    cancelled()
    current = name
    report.step(name, 'running')
    const result = await fn()
    report.step(name, 'done')
    return result
  }
  try {
    const summary = await step('create', async () => {
      const dir = vaultService.ensureSecureAgentsDir(userId)
      // The fake backend boots no image. A packaged build downloads the pinned
      // one into `SecureAgents/.images/` the first time (sha256-checked).
      let rootfsPath = ''
      if (backend.kind !== 'fake') {
        try {
          rootfsPath = await ensureGuestImage(dir, (percent) => {
            if (!signal.aborted) report.step('create', 'running', `Downloading the vault image… ${percent}%`)
          })
        } catch (error) {
          throw new VaultError('unavailable', error instanceof Error ? error.message : String(error))
        }
        cancelled()
      }
      const made = await backend.create({
        dir, vaultId, agentId, agentName: vaultPromptName(located.row.name, located.dto.slug), engine,
        sizeBytes: options.sizeBytes ?? VAULT_DEFAULT_SIZE_BYTES,
        egress: { hosts: [...new Set([...VAULT_ENGINE_HOSTS[engine], ...(options.extraHosts ?? [])])].sort() },
        rootfsPath
      })
      created = true
      vaultService.track(made)
      return made
    })
    void summary
    // Sealed (kit) or native (bare), the approval mode and the model it runs on now:
    // written into the vault at the copy step, a display copy on the row.
    const kind: 'kit' | 'bare' = located.dto.kind === 'bare' ? 'bare' : 'kit'
    const facts = launchFactsOf(userId, agentId)
    const provider = engine === 'opencode' ? launchProvider(facts) : null
    await step('unlock', async () => {
      const state = await backend.unlock(vaultId, `Move ${located.row.name} into its vault`)
      if (state !== 'unlocked') throw new VaultError('locked', 'The vault did not unlock.')
      vaultService.track({ ...(await backend.status(vaultId)), state: 'unlocked' })
      // The whole move keeps the window open (D13); released in finally.
      const holdId = randomUUID()
      await backend.hold(vaultId, holdId)
      release = () => backend.release(vaultId, holdId).catch(() => {})
    })
    const token = await step('approve', () => backend.approve(vaultId, 'move-in', `Move ${located.row.name} in`))
    const client = await vaultService.client(vaultId)
    await step('runtime', async () => {
      await client.request('layout.ensure', {})
      await ensureRuntimes(client, deps.runtimeSource(), engine, token, (message) => report.output('runtime', `${message}\n`))
    })
    await step('copy', async () => {
      const inventory = inventoryFolder(folder)
      let stream: string | null = null
      const imported = awaitStream<{ files: number; bytes: number }>(client, 'files.imported', () => stream)
      try {
        stream = (await client.request('files.import', { dest: 'agent', token })).stream
        await pushInto(client, stream, folderTar(folder, inventory.entries), signal)
        const result = await imported.done
        report.output('copy', `Copied ${result.files} files.\n`)
      } catch (error) {
        imported.stop()
        throw error
      }
      if (located.dto.kind === 'kit') {
        const instructionsFor = (each: VaultEngine): string | null => {
          try { return deps.instructions(userId, agentId, each) } catch { return null }
        }
        // Every engine's, while the host folder is here: a later switch of
        // engine copies the new one's into the active key.
        for (const each of VAULT_MOVE_ENGINES) {
          const text = instructionsFor(each)
          if (text) await client.request('kv.put', { key: vaultKvInstructionsFor(each), value: text })
        }
        const instructions = instructionsFor(engine)
        if (instructions) await client.request('kv.put', { key: VAULT_KV_INSTRUCTIONS, value: instructions })
      }
      // How it is launched lives inside the vault from now on (D34); the row keeps a display copy.
      await vaultAgentState.writeLaunch(client, { kind, model: facts.model, approval: facts.approval, provider })
    })
    if (existsSync(join(folder, 'pyproject.toml'))) {
      await step('rebuild', async () => {
        // One exec for both steps: the helper revokes the install proxy credential
        // when an exec ends (D37), so a second exec on the same token would lose PyPI.
        report.output('rebuild', '$ uv python install && uv sync\n')
        const code = await runExec(client, 'rebuild', token, (text) => report.output('rebuild', text), signal)
        if (code !== 0) throw new VaultError('internal', `The rebuild (uv python install, uv sync) failed (exit ${code}).`)
      })
    } else {
      cancelled()
      report.step('rebuild', 'skipped', 'No pyproject.toml: nothing to rebuild.')
    }
    // The API key, and the service credentials the agent has attached (rendered here, written only inside).
    const hasServiceCredentials = check.items.some((item) => item.kind === 'service-credential')
    if (options.apiKey || hasServiceCredentials) {
      await step('credentials', async () => {
        if (options.apiKey) await client.request('secrets.put', { name: vaultEngineLoginSecret(engine, provider, options.apiKey) ?? 'ANTHROPIC_API_KEY', value: options.apiKey })
        if (hasServiceCredentials) {
          const files = await vaultCredentials.moveIn(vaultId, client, agentId, vaultService.agentCwd(vaultId))
          if (files > 0) report.output('credentials', 'Service credentials delivered into the vault.\n')
        }
        if (!options.apiKey && check.needsApiKey) report.output('credentials', 'No API key given: add one on the Security tab before chatting.\n')
      })
    } else {
      cancelled()
      report.step('credentials', 'skipped', check.needsApiKey ? 'No API key given: add one on the Security tab before chatting.' : undefined)
    }
    await step('check', async () => {
      const code = await runExec(client, 'check', token, (text) => report.output('check', text), signal)
      if (code !== 0) report.output('check', `The agent's check exited with ${code}; the move goes on.\n`)
      cancelled()
      await checkEngine(client, agentId, vaultId, engine)
    })
    cancelled()
    // The point of no return: from here the agent is a vault agent.
    if (!agentRepo.markVault(userId, agentId, {
      vaultId, engine, kind, model: facts.model, approval: facts.approval,
      hostCopyPath: folder, hostRootId: located.dto.rootId
    })) {
      throw new VaultError('internal', 'The agent changed while it was moving.')
    }
    marked = true
    refreshVaultAgents()
    markRootDirty(located.dto.rootId)
    agentChanged(located.dto.rootId, agentId)
    await vaultService.adoptUnlocked(vaultId)
    report.final({ step: 'check', status: 'done', message: 'The agent is in its vault.', rotation: rotationList(located.dto, folder) })
    logger.info('an agent moved into a vault', { agentId, vaultId })
  } catch (error) {
    const raw = (signal.aborted ? 'The move was cancelled.' : error instanceof Error ? error.message : String(error)).trim()
    // A sentence of its own before the one that follows it.
    const message = /[.!?…]$/.test(raw) ? raw : `${raw}.`
    logger.warn('a move into a vault failed', { agentId, step: current, error: message })
    if (marked) {
      // Past the point of no return the agent is in its vault: what failed is
      // only the tidying after it, so this is a move with a warning.
      let rotation: VaultRotationItem[] = []
      try { rotation = rotationList(located.dto, folder) } catch { rotation = [] }
      report.final({
        step: 'check', status: 'done', rotation,
        message: 'The agent is in its vault.',
        warning: `${message} Reopen the agent if it does not show as in its vault.`
      })
      return
    }
    let rolledBack = !created
    if (created && !marked) rolledBack = await destroyHalfBuilt(vaultId)
    report.final({
      step: current, status: 'failed', rolledBack,
      message: rolledBack
        ? `${message} Nothing was changed on this computer.`
        : `${message} The half-built vault could not be removed; it stays in ${'SecureAgents'}/${vaultId}. Your agent on this computer is unchanged.`
    })
  } finally {
    await (release as (() => Promise<void>) | null)?.()
  }
}

/** Roll back a vault that was never marked: the helper verifies a destroy token itself, so this asks once more. */
async function destroyHalfBuilt(vaultId: string): Promise<boolean> {
  const backend = vaultBackend()
  try {
    vaultService.untrack(vaultId)
    const token = await backend.approve(vaultId, 'destroy', approvalDetail({ method: 'vault.destroy' }))
    await backend.destroy(vaultId, token)
    return true
  } catch (error) {
    logger.warn('a half-built vault was not destroyed', { vaultId, code: error instanceof VaultBackendError ? error.code : 'internal' })
    return false
  }
}

function rotationList(dto: LocalAgentDto, folder: string): VaultRotationItem[] {
  const items: VaultRotationItem[] = []
  for (const credential of dto.credentials) {
    const c = credential as { id?: unknown; name?: unknown; credentialId?: unknown }
    const name = typeof c.name === 'string' ? c.name : typeof c.id === 'string' ? c.id : 'Credential'
    const credentialId = typeof c.credentialId === 'string' ? c.credentialId : typeof c.id === 'string' ? c.id : undefined
    items.push({ kind: 'service-credential', name, ...(credentialId ? { credentialId } : {}) })
  }
  for (const rel of envFiles(folder)) {
    for (const name of envNames(join(folder, rel))) items.push({ kind: 'env-key', name, detail: rel })
  }
  if (existsSync(join(folder, '.git'))) {
    items.push({ kind: 'git-history', name: 'Git history', detail: 'Secrets ever committed are in the history that moved in, and in any remote it was pushed to.' })
  }
  return items
}

// ---------------------------------------------------------------------------
// The host copy

export async function hostCopy(userId: string, agentId: string): Promise<VaultHostCopyDto | null> {
  const { row } = vaultService.refFor(userId, agentId)
  const path = hostCopyPathOf(row)
  if (!path) return null
  if (!existsSync(path)) {
    agentRepo.patchVaultConfig(userId, agentId, { hostCopyPath: null, hostRootId: null })
    return null
  }
  const git = gitInfo(path)
  const tm = await vaultHost().timeMachineIncludes(path).catch(() => null)
  return { agentId, folderPath: path, inGitRepo: git.inGitRepo, gitRemote: git.remote, underTimeMachine: tm === true }
}

/**
 * The agent id the folder at `path` would get from a scan of `root`
 * (`scannerService`): `folder:<manifest id>` for a kit manifest with an id,
 * the positional legacy id for one without, the external id for a bare
 * folder (no manifest). Null when the manifest cannot be read.
 */
function folderIdentity(path: string, root: string, rootId: string): string | null {
  const manifest = join(path, MANIFEST_FILE)
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { id?: unknown }
      return typeof parsed.id === 'string' && parsed.id !== '' ? folderAgentId(parsed.id) : legacyFolderAgentId(rootId, basename(path))
    } catch {
      return null
    }
  }
  return externalFolderAgentId(rootId, relative(root, path))
}

/** Delete the host folder for real; `typedName` must be the agent's name. */
export async function deleteHostCopy(userId: string, agentId: string, typedName: unknown): Promise<void> {
  const { row } = vaultService.refFor(userId, agentId)
  if (typeof typedName !== 'string' || typedName.trim() !== row.name.trim()) {
    throw new VaultError('invalid', 'Type the agent’s name exactly to delete its folder.')
  }
  const path = hostCopyPathOf(row)
  if (!path) throw new VaultError('not_found', 'There is no host copy to delete.')
  const raw = (row.driverConfig?.['vault'] ?? {}) as Record<string, unknown>
  const root = agentsHomeService.rootRows(userId).find((candidate) => candidate.id === raw['hostRootId'])
  // The stored path is Cinna's data, not proof: it must still be this agent's
  // own folder, really inside one of the user's agent roots, never the root itself.
  if (!root || !isWithin(root.path, path) || relative(root.path, path) === '') {
    throw new VaultError('invalid', 'That folder is not inside your agents folder; delete it yourself.')
  }
  const refused = (): VaultError => new VaultError('invalid', 'That folder is no longer this agent’s; delete it yourself.')
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new VaultError('not_found', 'There is no host copy to delete.')
  }
  // A link at the path itself would delete (or empty) whatever it points to.
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused()
  let realRoot: string
  let realPath: string
  try {
    realRoot = realpathSync(root.path)
    realPath = realpathSync(path)
  } catch {
    throw refused()
  }
  if (!isWithin(realRoot, realPath) || relative(realRoot, realPath) === '') throw refused()
  if (folderIdentity(realPath, realRoot, root.id) !== agentId) throw refused()
  await rm(path, { recursive: true, force: true })
  agentRepo.patchVaultConfig(userId, agentId, { hostCopyPath: null, hostRootId: null })
  markRootDirty(root.id)
  agentChanged(root.id, agentId)
  logger.info('a vault agent’s host copy was deleted', { agentId })
}

// ---------------------------------------------------------------------------
// Move out, export, update dependencies

/** Extract a tar stream from the vault into `dest` (created fresh) with the system tar. */
async function extractFrom(client: Client, stream: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true })
  const channel = await client.attach(stream)
  const child = spawn('tar', ['-x', '-f', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C' } })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  child.stdin.on('error', () => {})
  const reader = channel.readable.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!child.stdin.write(value)) await new Promise((resolve) => child.stdin.once('drain', resolve))
    }
  } finally {
    reader.releaseLock()
    channel.close('done')
    child.stdin.end()
  }
  const code = await closed
  if (code !== 0) throw new VaultError('internal', `The files from the vault could not be unpacked: ${stderr.trim().split('\n').at(-1) ?? code}`)
}

/**
 * Move out: the whole folder comes back to `<default root>/Local/<slug>` as a
 * normal local agent and the vault is destroyed. Both approvals are asked
 * first (move-out, then destroy), so a declined prompt changes nothing.
 * Refused when that folder already exists (a host copy still there).
 */
export async function moveOut(userId: string, agentId: string): Promise<{ folderPath: string }> {
  const { row, ref } = vaultService.refFor(userId, agentId)
  if (movingAgents.has(agentId)) throw new VaultError('busy', 'This agent is already moving.')
  const root = agentsHomeService.rootRows(userId).find((candidate) => candidate.isDefault)
  if (!root) throw new VaultError('unavailable', 'There is no agents folder to move it to.')
  const hostCopyPath = hostCopyPathOf(row)
  const slug = (hostCopyPath ? basename(hostCopyPath) : '') || slugifyAgentName(row.name) || 'agent'
  const dest = join(root.path, AGENTS_SUBDIR, slug)
  if (existsSync(dest)) throw new VaultError('invalid', `${dest} already exists. Delete the host copy or rename that folder first.`)
  movingAgents.add(agentId)
  const backend = vaultBackend()
  let staging: string | null = null
  try {
    const exportToken = await backend.approve(ref.vaultId, 'move-out', approvalDetail({ method: 'move-out' }))
    const destroyToken = await backend.approve(ref.vaultId, 'destroy', approvalDetail({ method: 'vault.destroy' }))
    const client = await vaultService.client(ref.vaultId)
    const { stream } = await client.request('files.export', { path: '', token: exportToken })
    staging = join(root.path, AGENTS_SUBDIR, `.${slug}.vault-out-${process.pid}-${Date.now()}`)
    await extractFrom(client, stream, staging)
    // `tar -C agent .` puts everything under `./`.
    renameSync(staging, dest)
    staging = null
    await backend.destroy(ref.vaultId, destroyToken)
    vaultService.untrack(ref.vaultId)
    agentRepo.unmarkVault(userId, agentId, { localPath: dest, localRootId: root.id })
    refreshVaultAgents()
    markRootDirty(root.id)
    agentChanged(root.id, agentId)
    logger.info('an agent moved out of its vault', { agentId })
    return { folderPath: dest }
  } finally {
    movingAgents.delete(agentId)
    if (staging) rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Export one file or folder through a save dialog (gated: one prompt, a
 * single-use token for exactly this path). A folder is saved as a folder.
 * Resolves with where it went, or null when the dialog was cancelled (asked
 * before the prompt, so a cancel spends nothing).
 */
export async function exportFile(userId: string, agentId: string, path: unknown): Promise<{ savedTo: string } | null> {
  const { ref } = vaultService.refFor(userId, agentId)
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) throw new VaultError('invalid', 'Choose a file or folder inside the agent.')
  return vaultService.files().exportFile(ref.vaultId, path)
}

/**
 * The guest-protocol export behind {@link exportFile} and the vault file
 * seam (`fileAccess.ts`): the save dialog, then the backend's prompt for a
 * single-use token naming exactly `path`, then `files.export` unpacked to
 * where the dialog said. `path` is agent-relative and already checked.
 */
export async function exportVaultPath(vaultId: string, path: string): Promise<{ savedTo: string } | null> {
  const name = basename(path.replace(/\/+$/, ''))
  const target = await vaultHost().saveDialog(name)
  if (!target) return null
  const token = await vaultBackend().approve(vaultId, 'export', approvalDetail({ method: 'files.export', path }))
  const client = await vaultService.client(vaultId)
  const { stream } = await client.request('files.export', { path, token })
  const staging = await mkdtemp(join(dirname(target), `.${basename(target)}.export-`))
  try {
    await extractFrom(client, stream, staging)
    // The archive holds `path` as written (`tar -C agent <path>`). The save
    // dialog already confirmed replacing what is there.
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(join(staging, ...path.replace(/\/+$/, '').split('/')), target)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return { savedTo: target }
}

/**
 * Update dependencies (gated: the install prompt): the pinned runtimes when
 * they differ, then one `rebuild` exec (`uv python install`, `uv sync`: one
 * exec, because the install proxy credential ends with it, D37). Progress on
 * `vault:move-progress`, step `rebuild`.
 */
export async function updateDependencies(userId: string, agentId: string): Promise<{ moveId: string }> {
  const { ref } = vaultService.refFor(userId, agentId)
  if (movingAgents.has(agentId)) throw new VaultError('busy', 'This agent is busy moving.')
  const moveId = randomUUID()
  const controller = new AbortController()
  movingAgents.add(agentId)
  const report = reporter(moveId, agentId)
  const done = (async () => {
    const backend = vaultBackend()
    const holdId = randomUUID()
    let held = false
    try {
      report.step('rebuild', 'running')
      await backend.hold(ref.vaultId, holdId)
      held = true
      const token = await backend.approve(ref.vaultId, 'install', 'Update dependencies')
      const client = await vaultService.client(ref.vaultId)
      // Every engine set up in the vault, and the one it runs on even when its runtime went missing.
      const { runtimes } = await client.request('runtime.status', {})
      const source = deps.runtimeSource()
      const engines = VAULT_MOVE_ENGINES.filter((each) => each === ref.engine || installedRuntime(runtimes, each, source.pins(each)) !== 'missing')
      for (const each of engines) {
        await ensureRuntimes(client, source, each, token, (message) => report.output('rebuild', `${message}\n`))
      }
      const code = await runExec(client, 'rebuild', token, (text) => report.output('rebuild', text), controller.signal)
      if (code !== 0) throw new VaultError('internal', `The rebuild (uv python install, uv sync) failed (exit ${code}).`)
      report.final({ step: 'rebuild', status: 'done', message: 'Dependencies are up to date.' })
    } catch (error) {
      report.final({ step: 'rebuild', status: 'failed', message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (held) await backend.release(ref.vaultId, holdId).catch(() => {})
      movingAgents.delete(agentId)
      moves.delete(moveId)
    }
  })()
  moves.set(moveId, { moveId, agentId, controller, done })
  return { moveId }
}

// ---------------------------------------------------------------------------
// The engine of a vault agent

type RuntimeRow = { engine: VaultEngine; version: string; kind: RuntimeKind; sha256: string }

/**
 * Every vault engine, set up or not, from the vault's `runtime.status`: set
 * up when the runtime (and adapter) this app pins for it is installed, at
 * any version (an outdated one is still set up; Update dependencies moves it).
 */
export function vaultEngineChoices(runtimes: readonly RuntimeRow[]): VaultEngineChoiceDto[] {
  const source = deps.runtimeSource()
  return VAULT_MOVE_ENGINES.map((engine) => {
    const setUp = installedRuntime(runtimes, engine, source.pins(engine)) !== 'missing'
    return { engine, setUp, version: setUp ? currentRuntimeRow(runtimes, engine, false)?.version ?? null : null }
  })
}

interface SwitchOptions {
  engine: VaultEngine
  provider: VaultLaunchProvider | null
  model: string | null
  apiKey: string | null
}

function parseSwitchOptions(raw: unknown): SwitchOptions {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const engine = value['engine']
  if (typeof engine !== 'string' || !(VAULT_MOVE_ENGINES as readonly string[]).includes(engine)) {
    throw new VaultError('invalid', 'Choose Claude Agent, Codex, OpenCode or Antigravity.')
  }
  const provider = value['provider']
  const model = value['model']
  let out: SwitchOptions = { engine: engine as VaultEngine, provider: null, model: null, apiKey: null }
  if (VAULT_ENGINE_NAMES_MODEL[engine as VaultEngine]) {
    // vaultd configures OpenCode from these and refuses to start it without a model.
    if (typeof provider !== 'string' || !(VAULT_LAUNCH_PROVIDERS as readonly string[]).includes(provider)) {
      throw new VaultError('invalid', 'OpenCode in a vault reaches OpenAI or Anthropic models: choose one.')
    }
    if (typeof model !== 'string' || !VAULT_LAUNCH_MODEL.test(model.trim())) throw new VaultError('invalid', 'Enter the model OpenCode should run, like gpt-5.6-luna.')
    out = { ...out, provider: provider as VaultLaunchProvider, model: model.trim() }
  } else if ((provider !== undefined && provider !== null) || (model !== undefined && model !== null)) {
    // The other engines start on their CLI's default model.
    throw new VaultError('invalid', 'Only OpenCode takes a provider and a model.')
  }
  // The same rule as Move to vault…'s key.
  const key = parseMoveOptions({ apiKey: value['apiKey'] }).apiKey
  return { ...out, apiKey: key ?? null }
}

/** A sentence for a switch's failed step: a declined prompt is an answer, said as one. */
function switchFailure(error: unknown): string {
  if (error instanceof VaultBackendError && error.code === 'denied') return 'Cancelled at the prompt.'
  if (error instanceof VaultError && error.code === 'denied') return 'Cancelled at the prompt.'
  const raw = (error instanceof Error ? error.message : String(error)).trim()
  return /[.!?…]$/.test(raw) ? raw : `${raw}.`
}

/**
 * An engine as the switch names it: the runtime choice's own words, as a local
 * agent's Runs on select says them ("Claude Agent", not the CLI's name).
 */
const VAULT_ENGINE_CHOICE_NAME: Record<VaultEngine, string> = { claude: 'Claude Agent', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }

/** A Claude setup-token over an API key the vault holds: Claude would sign in with the key. */
const CLAUDE_TOKEN_UNDER_KEY = 'This vault already holds an Anthropic API key, which Claude would use over a token. Paste an API key, or leave the field empty to use the one it holds.'

/** Appended to a switch's failure when the vault's launch settings could not be put back. */
const LAUNCH_NOT_RESTORED = ' The vault’s launch settings could not be put back; switch the engine again.'

/**
 * Change the engine a vault agent runs on (a vault can hold every vault
 * engine; each is set up the first time it is chosen). Progress on
 * `vault:move-progress`, steps `VAULT_SWITCH_STEPS`: set up the pinned
 * runtime (an `install` prompt) when it is not in the vault, allow the
 * engine's hosts (an `egress` prompt) when the allowlist lacks one, store a
 * given key under the engine's name, then switch: the instructions captured
 * for that engine at move-in become the active ones, `cinna.launch` gets the
 * new model (null, the CLI's default; OpenCode's provider and model), and the
 * row names the engine. A failure leaves the row and `cinna.launch` as they
 * were; what was installed or allowed before it stays.
 *
 * A key is stored under its own name and no other login name is removed: an
 * engine's login names are shared (OpenCode on Anthropic reads Claude's
 * ANTHROPIC_API_KEY). A Claude token pasted while the vault holds an API key
 * is refused, since Claude would sign in with the key.
 *
 * Refused at once while the vault is locked, the agent moves or updates, its
 * background work (a subagent, a background task) runs, or a turn (anything
 * but a preemptible dashboard run, which it stops) holds its turn lock. A
 * switch that succeeds stops the agent's pooled engine process, so no
 * follow-up turn opens on the old engine. The switch holds the vault open and the agent's turn lock
 * (exclusive) for its whole length, so no turn starts on the old engine
 * mid-switch; both are let go before the final event, so a message sent the
 * moment it says done is not refused as busy.
 */
export async function switchEngine(userId: string, agentId: string, options: unknown): Promise<{ moveId: string }> {
  const opts = parseSwitchOptions(options)
  const { row, ref } = vaultService.refFor(userId, agentId)
  // The same engine again only to name another provider or model.
  if (opts.engine === ref.engine && !VAULT_ENGINE_NAMES_MODEL[opts.engine]) throw new VaultError('invalid', `This agent already runs on ${VAULT_ENGINE_CHOICE_NAME[opts.engine]}.`)
  if (vaultService.stateOf(ref.vaultId) !== 'unlocked') throw new VaultError('locked', 'Unlock the vault to change the engine.')
  // A key that cannot sign in fails here, in the dialog, before any prompt.
  const secret = opts.apiKey ? vaultEngineLoginSecret(opts.engine, opts.provider, opts.apiKey) ?? 'ANTHROPIC_API_KEY' : null
  if (opts.apiKey && secret) {
    await refuseBadLogin(secret, opts.apiKey)
    if (secret === 'CLAUDE_CODE_OAUTH_TOKEN') {
      const { names } = await (await vaultService.client(ref.vaultId)).request('secrets.list', {})
      if (names.includes('ANTHROPIC_API_KEY')) throw new VaultError('invalid', CLAUDE_TOKEN_UNDER_KEY)
    }
  }
  // From here to the lock, one synchronous step.
  if (vaultService.stateOf(ref.vaultId) !== 'unlocked') throw new VaultError('locked', 'Unlock the vault to change the engine.')
  if (movingAgents.has(agentId)) throw new VaultError('busy', 'This agent is busy moving or updating. Change the engine when that ends.')
  // Its end would open a follow-up turn on the old engine's process.
  if (deps.hasBackgroundWork(agentId)) throw new VaultError('busy', 'Background work is still running on this agent. Change the engine when it ends.')
  // Refused by any holder but a dashboard run, which the exclusive hold stops instead.
  let lock: ReturnType<typeof turnLock.acquire>
  try {
    lock = turnLock.acquire(agentId, 'vault-engine')
  } catch (error) {
    if (error instanceof LocalAgentError && error.code === 'turn_in_progress') {
      throw new VaultError('busy', 'A turn is running on this agent. Change the engine when it ends.')
    }
    throw error
  }
  movingAgents.add(agentId)
  const moveId = randomUUID()
  const controller = new AbortController()
  const report = reporter(moveId, agentId)
  const finish = (): void => {
    lock.release()
    movingAgents.delete(agentId)
  }
  const done = runSwitch(userId, row, ref.vaultId, moveId, opts)
    .catch((error: unknown): Omit<VaultMoveProgressEvent, 'moveId' | 'agentId'> => {
      logger.error('a vault agent’s change of engine ended unexpectedly', { agentId, error: error instanceof Error ? error.message : String(error) })
      return { step: 'engine', status: 'failed', message: switchFailure(error) }
    })
    .then((final) => {
      // Free before it says so: a send right after "done" must find the agent free.
      finish()
      report.final(final)
    })
    .finally(() => {
      finish()
      moves.delete(moveId)
    })
  moves.set(moveId, { moveId, agentId, controller, done })
  return { moveId }
}

/** Runs a switch and returns its final event (not yet sent); lets go of the vault's hold before returning. */
async function runSwitch(
  userId: string,
  row: AgentRow,
  vaultId: string,
  moveId: string,
  opts: SwitchOptions
): Promise<Omit<VaultMoveProgressEvent, 'moveId' | 'agentId'>> {
  const agentId = row.id
  const { engine } = opts
  const name = VAULT_ENGINE_CHOICE_NAME[engine]
  const report = reporter(moveId, agentId)
  const backend = vaultBackend()
  const holdId = randomUUID()
  let held = false
  let current: VaultMoveStep = 'runtime'
  let restoreFailed = false
  try {
    await backend.hold(vaultId, holdId)
    held = true
    const client = await vaultService.client(vaultId)
    const source = deps.runtimeSource()

    current = 'runtime'
    const { runtimes } = await client.request('runtime.status', {})
    if (installedRuntime(runtimes, engine, source.pins(engine)) === 'missing') {
      report.step('runtime', 'running')
      const token = await backend.approve(vaultId, 'install', `Set up ${name}`)
      await ensureRuntimes(client, source, engine, token, (message) => report.output('runtime', `${message}\n`))
      report.step('runtime', 'done')
    } else {
      report.step('runtime', 'skipped')
    }

    current = 'egress'
    const status = await backend.status(vaultId)
    const hosts = status.egress?.hosts ?? []
    if (VAULT_ENGINE_HOSTS[engine].some((host) => !hosts.includes(host))) {
      report.step('egress', 'running')
      await vaultService.applyEgress(vaultId, { hosts: [...new Set([...hosts, ...VAULT_ENGINE_HOSTS[engine]])].sort() })
      report.step('egress', 'done')
    } else {
      report.step('egress', 'skipped')
    }

    current = 'credentials'
    if (opts.apiKey) {
      report.step('credentials', 'running')
      // Under its own name only: another login name may be another engine's (see switchEngine).
      const secret = vaultEngineLoginSecret(engine, opts.provider, opts.apiKey) ?? 'ANTHROPIC_API_KEY'
      await client.request('secrets.put', { name: secret, value: opts.apiKey })
      report.step('credentials', 'done')
    } else {
      report.step('credentials', 'skipped')
    }

    current = 'engine'
    report.step('engine', 'running')
    const before = await readLaunch(client)
    try {
      await switchLaunch(client, engine, opts)
      if (!agentRepo.patchVaultConfig(userId, agentId, { engine, model: opts.model, provider: opts.provider })) {
        throw new VaultError('internal', 'The agent changed while its engine was switching.')
      }
    } catch (error) {
      // The row keeps the old engine: the vault's launch goes back to agree with it.
      restoreFailed = !(await restoreLaunch(client, before, agentId))
      throw error
    }
    refreshVaultAgents()
    const roots = agentsHomeService.rootRows(userId)
    agentChanged((roots.find((root) => root.id === row.localRootId) ?? roots.find((root) => root.isDefault))?.id ?? row.localRootId ?? '', agentId)
    vaultService.readinessChanged(vaultId)
    // The old engine's process must not serve another turn (a follow-up opens on a pooled connection).
    try {
      await deps.stopAgentProcesses(agentId)
    } catch (error) {
      logger.warn('the old engine’s process could not be stopped after a change of engine', { agentId, error: error instanceof Error ? error.message : String(error) })
    }
    logger.info('a vault agent changed its engine', { agentId, vaultId, engine })
    return { step: 'engine', status: 'done', message: `The agent runs on ${name} now.` }
  } catch (error) {
    const message = switchFailure(error) + (restoreFailed ? LAUNCH_NOT_RESTORED : '')
    logger.warn('a vault agent’s change of engine failed', { agentId, step: current, error: message })
    return { step: current, status: 'failed', message }
  } finally {
    if (held) await backend.release(vaultId, holdId).catch(() => {})
  }
}

/** What a switch changes in the vault, as it was before: put back by {@link restoreLaunch}. */
interface LaunchBefore {
  launch: Awaited<ReturnType<typeof vaultAgentState.launch>>
  instructions: unknown
}

async function readLaunch(client: Client): Promise<LaunchBefore> {
  return {
    launch: await vaultAgentState.launch(client),
    instructions: (await client.request('kv.get', { key: VAULT_KV_INSTRUCTIONS })).value
  }
}

/**
 * Put back the active instructions and `cinna.launch` a switch found. False
 * (and logged) when either could not be written: the vault may then disagree
 * with the row.
 */
async function restoreLaunch(client: Client, before: LaunchBefore, agentId: string): Promise<boolean> {
  let ok = true
  if (typeof before.instructions === 'string') {
    await client.request('kv.put', { key: VAULT_KV_INSTRUCTIONS, value: before.instructions }).catch((error: unknown) => {
      ok = false
      logger.error('a failed change of engine could not put back the vault’s instructions', { agentId, error: error instanceof Error ? error.message : String(error) })
    })
  }
  await vaultAgentState.writeLaunch(client, before.launch).catch((error: unknown) => {
    ok = false
    logger.error('a failed change of engine could not put back cinna.launch', { agentId, error: error instanceof Error ? error.message : String(error) })
  })
  return ok
}

/**
 * The vault side of a switch: the new engine's captured instructions become
 * the active ones (kept as they are when none was captured: a vault moved in
 * before they were), then `cinna.launch` with its model. The caller puts back
 * what was there when this or the row's update fails ({@link restoreLaunch}).
 */
async function switchLaunch(client: Client, engine: VaultEngine, opts: SwitchOptions): Promise<void> {
  const launch = await vaultAgentState.launch(client)
  const captured = (await client.request('kv.get', { key: vaultKvInstructionsFor(engine) })).value
  if (typeof captured === 'string' && captured.trim() !== '') await client.request('kv.put', { key: VAULT_KV_INSTRUCTIONS, value: captured })
  // Mode and sealed/native stay; the model resets to the CLI's default (OpenCode names its own).
  await vaultAgentState.writeLaunch(client, { kind: launch.kind, approval: launch.approval, model: opts.model, provider: opts.provider })
}

/** Test seam: wait for a move (or dependency update) to finish. */
export function waitForMove(moveId: string): Promise<void> {
  return moves.get(moveId)?.done ?? Promise.resolve()
}

export const moveService = {
  precheck,
  moveIn,
  cancelMove,
  hostCopy,
  deleteHostCopy,
  moveOut,
  exportFile,
  updateDependencies,
  switchEngine,
  waitForMove
}
