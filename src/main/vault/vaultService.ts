/**
 * Agent Vault in the hub core: which agents are vault agents, the state of
 * each vault, unlock/lock and the gated changes, the reserved `SecureAgents/`
 * folder, the guest image, the vaultd connection and the transcript journal.
 *
 * Everything that decides goes through here; the IPC handlers only forward.
 * The backend (`backend.ts`) is installed by the composition root. Anything
 * Cinna asks the backend for is a request: presence prompts and tokens come
 * from the helper (D3).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentRepo, type AgentRow } from '../db/agents'
import { chatRepo } from '../db/chats'
import { publishEvent } from '../host/events'
import { createLogger } from '../logger/logger'
import { agentsHomeService } from '../services/localAgents/agentsHomeService'
import {
  VAULT_DEFAULT_LOCK_AFTER_MS,
  VAULT_ENGINES,
  VAULT_SECRET_NAME,
  vaultLockTimeoutShorter, vaultSecretStorable, VAULT_ENGINE_LOGIN, vaultEngineLoginSecret,
  approvalDetail,
  type EgressPolicy,
  type GatedAction,
  type TranscriptOp,
  type VaultEngine,
  type VaultState,
  type VaultSummary
} from '../../shared/vault/protocol'
import {
  SECURE_AGENTS_DIR,
  SECURE_AGENTS_MARKER,
  VAULT_CHAT_FILES_SWEPT_CHANNEL,
  VAULT_STATE_CHANNEL,
  type VaultAvailabilityDto,
  type VaultChatFilesSweptEvent,
  type VaultEngineAuthDto,
  type VaultFileEntryDto,
  type VaultRuntimeDto,
  type VaultSecretListDto,
  type VaultErrorCode,
  type VaultResult,
  type VaultStateEvent,
  type VaultStatusDto
} from '../../shared/vault/types'
import { GUEST_AGENT_PATH, onVaultBackendInstalled, vaultBackend, VaultBackendError, type VaultBackend, type VaultBackendEvent } from './backend'
import { refreshVaultAgents, isVaultAgent } from './isVaultAgent'
import { vaultTranscripts, type JournalOutcome } from './transcriptStore'
import { foreignSecureAgentsDir } from './secureAgentsDir'
import { VaultdClient, VaultdError } from './vaultdClient'
import { pinnedVaultVersions } from './runtimeInstall'
import { guestHashMismatch, guestRootfs } from './guestImage'
import { sweepVaultChatFiles } from './vaultChatFiles'
import { vaultLoginProblem } from './engineLoginCheck'

const logger = createLogger('vault')

/** A vault failure with a code the renderer branches on (returned as data over IPC). */
export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

/** Refuses a pasted login that cannot sign in (engineLoginCheck.ts) before it is stored. */
export async function refuseBadLogin(name: string, value: string): Promise<void> {
  const problem = await vaultLoginProblem(name, value)
  if (problem) throw new VaultError('invalid', problem)
}

/** `driverConfig.vault` of a vault agent's row. */
export interface VaultRef {
  vaultId: string
  engine: VaultEngine
}

export function vaultRefOf(row: Pick<AgentRow, 'source' | 'driverConfig'>): VaultRef | null {
  if (row.source !== 'vault') return null
  const raw = row.driverConfig?.['vault'] as { vaultId?: unknown; engine?: unknown } | undefined
  if (!raw || typeof raw.vaultId !== 'string' || !raw.vaultId) return null
  const engine = (VAULT_ENGINES as readonly string[]).includes(raw.engine as string) ? raw.engine as VaultEngine : 'claude'
  return { vaultId: raw.vaultId, engine }
}

const BACKEND_CODES: Record<string, VaultErrorCode> = {
  denied: 'denied', locked: 'locked', busy: 'busy', tampered: 'tampered', invalid: 'invalid',
  not_found: 'not_found', unavailable: 'unavailable', bad_token: 'denied'
}

function asVaultError(error: unknown): VaultError {
  if (error instanceof VaultError) return error
  if (error instanceof VaultBackendError || error instanceof VaultdError) {
    return new VaultError(BACKEND_CODES[error.code] ?? 'internal', error.message)
  }
  return new VaultError('internal', error instanceof Error ? error.message : String(error))
}

// ---------------------------------------------------------------------------
// State

/** Last summary per vault, from `list`/`status` and the backend's `vault.state` events. */
const summaries = new Map<string, VaultSummary & { error?: string | null }>()
/** One vaultd control connection per unlocked vault. */
const clients = new Map<string, Promise<VaultdClient>>()
/** Unlocks in flight per vault: a second click joins the first. */
const unlocking = new Map<string, Promise<VaultState>>()
/** Transcript journal writes per vault, queued in order until the vault takes them (see `journal`). */
const journals = new Map<string, JournalQueue>()
/** Vaults destroyed in this process: their queued journal writes can never land. */
const destroyedVaults = new Set<string>()
/**
 * Per vault, bumped every time it leaves `unlocked` (a lock, a destroy, any
 * state event that is not `unlocked`). An unlock captures it before it asks
 * and opens transcripts or records `unlocked` only if it is unchanged: a lock
 * that landed during the unlock's journal rebuild wins (D40).
 */
const lockGenerations = new Map<string, number>()
/** The drain-and-close a quit is running, while it has journal writes to deliver (see `shutdown`). */
let quitDrain: Promise<void> | null = null
let availabilityCache: Promise<VaultAvailabilityDto> | null = null
let detach: (() => void) | null = null
let initialized = false

function generationOf(vaultId: string): number {
  return lockGenerations.get(vaultId) ?? 0
}

function agentIdOfVault(vaultId: string): string | null {
  return summaries.get(vaultId)?.agentId ?? null
}

function publishState(vaultId: string): void {
  const summary = summaries.get(vaultId)
  const agentId = summary?.agentId ?? agentIdOfVault(vaultId)
  if (!summary || !agentId) return
  const event: VaultStateEvent = {
    agentId, vaultId, state: summary.state,
    until: summary.state === 'unlocked' ? summary.until ?? null : null,
    lockAfterMs: summary.lockAfterMs ?? VAULT_DEFAULT_LOCK_AFTER_MS,
    error: summary.error ?? null
  }
  publishEvent(VAULT_STATE_CHANNEL, event, 'all')
}

/** A vault left `unlocked`: its transcripts and its vaultd connection go. */
function onLeftUnlocked(vaultId: string, locked = true): void {
  // `booting` is the unlock's own progress, not a lock that should cancel it.
  if (locked) {
    lockGenerations.set(vaultId, generationOf(vaultId) + 1)
    // Attachment copies of its chats that no turn took (a draft never sent);
    // the composers holding them drop the chips and say why.
    void sweepVaultChatFiles(vaultId).then((chats) => {
      if (chats.length > 0) publishEvent(VAULT_CHAT_FILES_SWEPT_CHANNEL, { vaultId, chats } satisfies VaultChatFilesSweptEvent, 'all')
    })
  }
  vaultTranscripts.closeVault(vaultId)
  const client = clients.get(vaultId)
  clients.delete(vaultId)
  // Queued journal writes stay queued: they go in after the next unlock.
  void client?.then((c) => c.close('vault locked')).catch(() => {})
}

/** The last state each vault's own `vault.state` events reported (status polls do not write it). */
const eventStates = new Map<string, VaultState>()

function onBackendEvent(event: VaultBackendEvent): void {
  if (event.event === 'log') {
    logger[event.level === 'debug' ? 'debug' : event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info']('helper', { message: event.message })
    return
  }
  if (event.event !== 'vault.state') return
  const known = summaries.get(event.vaultId)
  if (known) {
    summaries.set(event.vaultId, {
      ...known, state: event.state, until: event.until ?? null, error: event.error ?? null,
      ...(event.lockAfterMs !== undefined ? { lockAfterMs: event.lockAfterMs } : {})
    })
  }
  // Only a change of state leaves "unlocked": a repeat of a state the last
  // event already said (or main already knew) must not bump the lock
  // generation, which would void an unlock in flight and sweep staged files.
  const previous = eventStates.get(event.vaultId) ?? known?.state
  eventStates.set(event.vaultId, event.state)
  if (event.state !== 'unlocked' && previous !== event.state) onLeftUnlocked(event.vaultId, event.state !== 'booting')
  publishState(event.vaultId)
  refreshReadiness(event.vaultId)
}

/** A vault's state is its agent's readiness (`vault_locked`): ask again so the composer follows. */
function refreshReadiness(vaultId: string): void {
  const agentId = agentIdOfVault(vaultId)
  if (!agentId) return
  let row: AgentRow | undefined
  try {
    row = agentRepo.findVault(agentId)
  } catch {
    return
  }
  if (!row) return
  const owned = row
  void import('../services/agentReadinessService')
    .then(({ agentReadinessService }) => agentReadinessService.refresh(owned.userId, owned))
    .catch(() => {})
}

function attach(backend: VaultBackend): void {
  detach?.()
  detach = backend.onEvent(onBackendEvent)
  availabilityCache = null
}

/** The vault ref of a vault agent of `userId`, or a `not_vault_agent` error. */
function refFor(userId: string, agentId: string): { row: AgentRow; ref: VaultRef } {
  const row = typeof agentId === 'string' ? agentRepo.getOwned(userId, agentId) : undefined
  const ref = row ? vaultRefOf(row) : null
  if (!row || !ref) throw new VaultError('not_vault_agent', 'That agent is not in a vault.')
  return { row, ref }
}

function toStatus(row: AgentRow, ref: VaultRef): VaultStatusDto {
  const summary = summaries.get(ref.vaultId)
  return {
    agentId: row.id,
    vaultId: ref.vaultId,
    agentName: summary?.agentName ?? row.name,
    engine: summary?.engine ?? ref.engine,
    state: summary?.state ?? 'locked',
    until: summary?.state === 'unlocked' ? summary.until ?? null : null,
    lockAfterMs: summary?.lockAfterMs ?? VAULT_DEFAULT_LOCK_AFTER_MS,
    sizeBytes: summary?.sizeBytes ?? 0,
    usedBytes: summary?.usedBytes ?? null,
    egress: summary?.egress ?? { hosts: [] },
    createdAt: summary?.createdAt ?? row.createdAt.getTime(),
    imageVersion: summary?.imageVersion ?? '',
    error: summary?.error ?? null
  }
}

// ---------------------------------------------------------------------------
// SecureAgents/ and the guest image

/** The default workshop root's path: the only root vaults live in. */
function defaultRootPath(userId: string): string {
  const root = agentsHomeService.rootRows(userId).find((row) => row.isDefault)
  if (!root) throw new VaultError('unavailable', 'There is no agents folder yet.')
  return root.path
}

export { guestRootfs } from './guestImage'

export const vaultService = {
  /** Subscribe to the installed backend (and any installed later). Once per process. */
  init(): void {
    if (initialized) return
    initialized = true
    attach(vaultBackend())
    onVaultBackendInstalled(attach)
    vaultTranscripts.installSink({
      append: (vaultId, chatId, ops) => journal(vaultId, chatId, ops),
      settled: (vaultId, chatId, timeoutMs) => journalSettled(vaultId, chatId, timeoutMs)
    })
    // Before any turn: copies a quit or a crash left behind (D23).
    void sweepVaultChatFiles()
    try {
      refreshVaultAgents()
    } catch (error) {
      logger.warn('could not read the vault agents', { error: error instanceof Error ? error.message : String(error) })
    }
  },

  /** Run `fn` and answer as data: a thrown code would not survive IPC. */
  async result<T>(fn: () => Promise<T> | T): Promise<VaultResult<T>> {
    try {
      return { ok: true, data: await fn() }
    } catch (error) {
      const failure = asVaultError(error)
      return { ok: false, code: failure.code, message: failure.message }
    }
  },

  /** Whether vaults can be used here, and why not. Cached until the backend changes or `refresh`. */
  availability(refresh = false): Promise<VaultAvailabilityDto> {
    if (refresh || !availabilityCache) {
      availabilityCache = (async (): Promise<VaultAvailabilityDto> => {
        const backend = vaultBackend()
        const capabilities = backend.capabilities()
        let availability = await backend.availability().catch((error: unknown) =>
          ({ ok: false as const, reason: 'helper-missing' as const, detail: error instanceof Error ? error.message : String(error) }))
        let flavor: VaultAvailabilityDto['flavor'] = null
        let helperRootHash: string | null = null
        if (availability.ok) {
          try {
            const hello = await backend.hello()
            flavor = hello.flavor
            helperRootHash = hello.guest.rootHash
          } catch (error) {
            availability = { ok: false, reason: 'helper-missing', detail: error instanceof Error ? error.message : String(error) }
          }
        }
        if (availability.ok && backend.kind !== 'fake') {
          const image = guestRootfs()
          if (!image.ok) availability = { ok: false, reason: 'image-missing', detail: image.detail }
          // The helper boots with the verity root hash compiled into it: one
          // built for another image could never boot the one this build has.
          const mismatch = availability.ok && helperRootHash !== null ? guestHashMismatch(helperRootHash) : null
          if (mismatch) availability = { ok: false, reason: 'image-missing', detail: mismatch }
        }
        return { availability, backend: backend.kind, flavor, capabilities }
      })()
      availabilityCache.catch(() => { availabilityCache = null })
    }
    return availabilityCache
  },

  /**
   * `<default root>/SecureAgents/`, created with its `.gitignore` (`*`) and the
   * marker that says Cinna made it. Refused when the folder is there without
   * the marker: it is not ours to fill.
   */
  ensureSecureAgentsDir(userId: string): string {
    const root = defaultRootPath(userId)
    if (foreignSecureAgentsDir(root)) {
      throw new VaultError('invalid', `Your agents folder already has a "${SECURE_AGENTS_DIR}" folder Cinna did not make. Rename it to use Agent Vault.`)
    }
    const dir = join(root, SECURE_AGENTS_DIR)
    mkdirSync(dir, { recursive: true })
    const gitignore = join(dir, '.gitignore')
    if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n')
    const marker = join(dir, SECURE_AGENTS_MARKER)
    if (!existsSync(marker)) writeFileSync(marker, 'Agent Vault disk images. Managed by Cinna; do not edit.\n')
    return dir
  },

  /** The vault agents of `userId` with their last known state (never asks the backend). */
  list(userId: string): VaultStatusDto[] {
    return agentRepo.listVault(userId).flatMap((row) => {
      const ref = vaultRefOf(row)
      return ref ? [toStatus(row, ref)] : []
    })
  },

  /** Last known state of a vault; `locked` when nothing is known yet. Synchronous, for the agent list. */
  stateOf(vaultId: string): VaultState {
    return summaries.get(vaultId)?.state ?? 'locked'
  },

  /** Ask the backend for every vault in `SecureAgents/`, refreshing the cached states. */
  async refresh(userId: string): Promise<VaultStatusDto[]> {
    const root = defaultRootPath(userId)
    const dir = join(root, SECURE_AGENTS_DIR)
    if (existsSync(dir)) {
      for (const summary of await vaultBackend().list(dir)) {
        summaries.set(summary.vaultId, { ...summaries.get(summary.vaultId), ...summary })
      }
    }
    return this.list(userId)
  },

  async status(userId: string, agentId: string): Promise<VaultStatusDto> {
    const { row, ref } = refFor(userId, agentId)
    if (!summaries.has(ref.vaultId)) await this.refresh(userId)
    try {
      const summary = await vaultBackend().status(ref.vaultId)
      summaries.set(ref.vaultId, { ...summaries.get(ref.vaultId), ...summary })
    } catch (error) {
      if (!(error instanceof VaultBackendError && error.code === 'not_found')) throw error
    }
    return toStatus(row, ref)
  },

  /**
   * Unlock: the helper prompts (its own text), boots or resumes, and the
   * vault's chats are rebuilt from their journals before this resolves.
   */
  async unlock(userId: string, agentId: string, purpose = 'Use this agent'): Promise<VaultStatusDto> {
    const { row, ref } = refFor(userId, agentId)
    if (!summaries.has(ref.vaultId)) await this.refresh(userId)
    let pending = unlocking.get(ref.vaultId)
    if (!pending) {
      pending = (async () => {
        const generation = generationOf(ref.vaultId)
        const state = await vaultBackend().unlock(ref.vaultId, purpose)
        // A lock that landed meanwhile wins: nothing is opened or recorded.
        if (generationOf(ref.vaultId) !== generation) return summaries.get(ref.vaultId)?.state ?? 'locked'
        const known = summaries.get(ref.vaultId)
        if (known && known.state !== state) {
          summaries.set(ref.vaultId, { ...known, state })
          publishState(ref.vaultId)
        }
        if (state === 'unlocked') await openTranscripts(ref.vaultId, generation)
        return state
      })().finally(() => unlocking.delete(ref.vaultId))
      unlocking.set(ref.vaultId, pending)
    }
    await pending
    return toStatus(row, ref)
  },

  async lock(userId: string, agentId: string): Promise<VaultStatusDto> {
    const { row, ref } = refFor(userId, agentId)
    await vaultBackend().lock(ref.vaultId)
    onLeftUnlocked(ref.vaultId)
    return toStatus(row, ref)
  },

  /** A running turn keeps the window open (D13). Returns the release. */
  async hold(userId: string, agentId: string): Promise<() => Promise<void>> {
    const { ref } = refFor(userId, agentId)
    const holdId = randomUUID()
    await vaultBackend().hold(ref.vaultId, holdId)
    let released = false
    return async () => {
      if (released) return
      released = true
      await vaultBackend().release(ref.vaultId, holdId).catch((error: unknown) =>
        logger.warn('could not release a vault hold', { vaultId: ref.vaultId, error: error instanceof Error ? error.message : String(error) }))
    }
  },

  /** A presence prompt for one gated action; the token for the call it authorizes. */
  async approve(userId: string, agentId: string, action: GatedAction, detail: string): Promise<string> {
    const { ref } = refFor(userId, agentId)
    return vaultBackend().approve(ref.vaultId, action, detail)
  },

  async setEgress(userId: string, agentId: string, hosts: unknown): Promise<VaultStatusDto> {
    const { row, ref } = refFor(userId, agentId)
    const policy = normalizeEgress(hosts)
    // The canonical detail: the helper binds the token to exactly this policy.
    const token = await vaultBackend().approve(ref.vaultId, 'egress', approvalDetail({ method: 'vault.setEgress', policy }))
    await vaultBackend().setEgress(ref.vaultId, policy, token)
    const known = summaries.get(ref.vaultId)
    if (known) summaries.set(ref.vaultId, { ...known, egress: policy })
    return toStatus(row, ref)
  },

  /**
   * How long the vault stays unlocked after its last use: 30 s, 5 min, or 0
   * (until Cinna quits). A shorter one is set without a prompt; a longer one
   * asks the helper for a `lock-timeout` approval first (its own prompt text).
   */
  async setLockTimeout(userId: string, agentId: string, lockAfterMs: unknown): Promise<VaultStatusDto> {
    const { row, ref } = refFor(userId, agentId)
    // The backend says which timeouts it can keep; nothing else is asked of it.
    const offered = vaultBackend().capabilities().lockTimeouts
    if (typeof lockAfterMs !== 'number' || !offered.includes(lockAfterMs)) {
      throw new VaultError('invalid', offered.length === 0 ? 'This vault’s lock timeout can’t be changed here.' : 'That lock timeout is not offered.')
    }
    if (!summaries.has(ref.vaultId)) await this.refresh(userId)
    const current = summaries.get(ref.vaultId)?.lockAfterMs ?? VAULT_DEFAULT_LOCK_AFTER_MS
    if (lockAfterMs === current) return toStatus(row, ref)
    const token = vaultLockTimeoutShorter(lockAfterMs, current)
      ? undefined
      : await vaultBackend().approve(ref.vaultId, 'lock-timeout', approvalDetail({ method: 'vault.setLockTimeout', lockAfterMs }))
    await vaultBackend().setLockTimeout(ref.vaultId, lockAfterMs, token)
    const known = summaries.get(ref.vaultId)
    if (known) summaries.set(ref.vaultId, { ...known, lockAfterMs })
    return toStatus(row, ref)
  },

  /**
   * The user is typing to the vault's agent: restart its idle window. Cheap
   * and fire-and-forget: only for a vault known to be unlocked, never throws.
   */
  touch(userId: string, agentId: string): void {
    if (!vaultBackend().capabilities().idleTouch) return
    let vaultId: string
    try {
      vaultId = refFor(userId, agentId).ref.vaultId
    } catch {
      return
    }
    if (this.stateOf(vaultId) !== 'unlocked') return
    void vaultBackend().touch(vaultId).catch(() => {})
  },

  /** The disk size limit; raising it grows the image at the next unlock (D15). Never below what is used. */
  async setSize(userId: string, agentId: string, sizeBytes: unknown): Promise<VaultStatusDto> {
    const { row, ref } = refFor(userId, agentId)
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1024 ** 3 || sizeBytes > 2 * 1024 ** 4) {
      throw new VaultError('invalid', 'Choose a size between 1 GB and 2 TB.')
    }
    const used = summaries.get(ref.vaultId)?.usedBytes
    if (typeof used === 'number' && sizeBytes < used) {
      throw new VaultError('invalid', `The vault already uses ${formatGb(used)}; choose at least that.`)
    }
    const token = await vaultBackend().approve(ref.vaultId, 'resize', approvalDetail({ method: 'vault.resize', sizeBytes }))
    await vaultBackend().resize(ref.vaultId, sizeBytes, token)
    const known = summaries.get(ref.vaultId)
    if (known) summaries.set(ref.vaultId, { ...known, sizeBytes })
    return toStatus(row, ref)
  },

  /**
   * Delete the vault and with it the agent (D16: there is no backup). Its
   * chats stay as stubs with nothing to show.
   */
  async destroy(userId: string, agentId: string): Promise<void> {
    const { ref } = refFor(userId, agentId)
    const token = await vaultBackend().approve(ref.vaultId, 'destroy', approvalDetail({ method: 'vault.destroy' }))
    await vaultBackend().destroy(ref.vaultId, token)
    destroyedVaults.add(ref.vaultId)
    onLeftUnlocked(ref.vaultId)
    summaries.delete(ref.vaultId)
    agentRepo.delete(userId, agentId)
    refreshVaultAgents()
    publishEvent(VAULT_STATE_CHANNEL, { agentId, vaultId: ref.vaultId, state: 'stopped', until: null, lockAfterMs: VAULT_DEFAULT_LOCK_AFTER_MS, error: null } satisfies VaultStateEvent, 'all')
  },

  /**
   * Make a fresh chat with a vault agent (a row of `settingsUserId`) a vault chat: stub title, transcript
   * in the vault from the first row. Refused for a chat that already has host
   * rows (they would stay behind) or another agent's vault.
   */
  bindChat(settingsUserId: string, chatOwnerId: string, chatId: string, agentId: string): void {
    const row = agentRepo.getOwned(settingsUserId, agentId) ?? null
    const ref = row ? vaultRefOf(row) : null
    if (!row || !ref) throw new VaultError('not_vault_agent', 'That agent is not in a vault.')
    if (!chatRepo.bindVault(chatOwnerId, chatId, ref.vaultId, stubTitle(row.name))) {
      throw new VaultError('invalid', 'Start a new chat to talk to an agent in a vault.')
    }
  },

  /**
   * The vaultd control connection of an unlocked vault (shared). Refused while
   * the vault is not known to be unlocked, so `transcript.read`, `kv.get` and
   * the rest (ungated in vaultd by design: unlock is the gate) are only ever
   * asked of an unlocked vault.
   */
  client(vaultId: string): Promise<VaultdClient> {
    if (this.stateOf(vaultId) !== 'unlocked') return Promise.reject(new VaultError('locked', 'The vault is locked.'))
    let client = clients.get(vaultId)
    if (!client) {
      client = (async () => {
        const backend = vaultBackend()
        const connected = await VaultdClient.connect(await backend.open(vaultId), { openChannel: () => backend.open(vaultId) })
        connected.onClose(() => { if (clients.get(vaultId) === client) clients.delete(vaultId) })
        return connected
      })()
      clients.set(vaultId, client)
      client.catch(() => { if (clients.get(vaultId) === client) clients.delete(vaultId) })
    }
    return client
  },

  isVaultAgent,

  /** Where the vault's agent folder is for the processes inside it: the cwd of its sessions. */
  agentCwd(vaultId: string): string {
    const backend = vaultBackend()
    try {
      return backend.guestAgentPath?.(vaultId) ?? GUEST_AGENT_PATH
    } catch {
      return GUEST_AGENT_PATH
    }
  },

  /** The vault ref of a vault agent of `userId`, or `not_vault_agent`. */
  refFor(userId: string, agentId: string): { row: AgentRow; ref: VaultRef } {
    return refFor(userId, agentId)
  },

  /** Secret names in the vault; values never leave it. */
  async secrets(userId: string, agentId: string): Promise<VaultSecretListDto> {
    const { ref } = refFor(userId, agentId)
    const { names } = await (await this.client(ref.vaultId)).request('secrets.list', {})
    return { names: [...names].sort() }
  },

  async setSecret(userId: string, agentId: string, name: unknown, value: unknown): Promise<void> {
    const { ref } = refFor(userId, agentId)
    if (typeof name !== 'string' || !VAULT_SECRET_NAME.test(name)) throw new VaultError('invalid', 'A secret name is capital letters, digits and _ (like ANTHROPIC_API_KEY).')
    if (!vaultSecretStorable(name)) throw new VaultError('invalid', `${name} would change how the engine runs, so it can’t be a secret. Give it a name of your own.`)
    if (typeof value !== 'string' || value.length === 0 || value.length > 64 * 1024 || value.includes('\0')) throw new VaultError('invalid', 'The secret value is empty or too long.')
    const client = await this.client(ref.vaultId)
    const logins = VAULT_ENGINE_LOGIN[ref.engine]?.names ?? []
    if (logins.includes(name)) {
      // An engine login of several names (Claude: an API key or a `claude
      // setup-token` token, told apart by prefix); the vault keeps one, since
      // an API key wins over a token.
      const login = vaultEngineLoginSecret(ref.engine, null, value) ?? name
      await refuseBadLogin(login, value)
      await client.request('secrets.put', { name: login, value })
      try {
        for (const other of logins) if (other !== login) await client.request('secrets.delete', { name: other })
      } catch {
        // An API key wins over a token, so a leftover one would hide what was just saved.
        refreshReadiness(ref.vaultId)
        throw new VaultError('internal', 'Saved, but the previous login could not be removed. Save it again.')
      }
    } else {
      await refuseBadLogin(name, value)
      await client.request('secrets.put', { name, value })
    }
    refreshReadiness(ref.vaultId)
  },

  async deleteSecret(userId: string, agentId: string, name: unknown): Promise<void> {
    const { ref } = refFor(userId, agentId)
    if (typeof name !== 'string' || !VAULT_SECRET_NAME.test(name)) throw new VaultError('invalid', 'That is not a secret name.')
    const client = await this.client(ref.vaultId)
    // Removing an engine login of several names removes whichever the vault holds.
    const logins = VAULT_ENGINE_LOGIN[ref.engine]?.names ?? []
    const names = logins.includes(name) ? logins : [name]
    for (const each of names) await client.request('secrets.delete', { name: each })
    refreshReadiness(ref.vaultId)
  },

  async engineAuth(userId: string, agentId: string): Promise<VaultEngineAuthDto> {
    const { ref } = refFor(userId, agentId)
    const auth = await (await this.client(ref.vaultId)).request('auth.status', { engine: ref.engine })
    return { loggedIn: auth.loggedIn, method: auth.method ?? null, keyName: auth.keyName ?? null }
  },

  /** The runtimes installed in the vault, each with the version this app would install. */
  async runtimes(userId: string, agentId: string): Promise<VaultRuntimeDto[]> {
    const { ref } = refFor(userId, agentId)
    const { runtimes } = await (await this.client(ref.vaultId)).request('runtime.status', {})
    const pinned = pinnedVaultVersions(ref.engine)
    return runtimes.map((r) => ({
      engine: r.engine, version: r.version, kind: r.kind,
      pinned: r.engine !== ref.engine || !pinned ? null : r.kind === 'adapter' ? pinned.adapter : pinned.executable
    }))
  },

  async listFiles(userId: string, agentId: string, path: unknown): Promise<VaultFileEntryDto[]> {
    const { ref } = refFor(userId, agentId)
    if (typeof path !== 'string') throw new VaultError('invalid', 'Invalid path.')
    return (await (await this.client(ref.vaultId)).request('files.list', { path })).entries
  },

  /** Remember a vault's summary (a vault the move service just created, before any agent row names it). */
  track(summary: VaultSummary): void {
    summaries.set(summary.vaultId, { ...summaries.get(summary.vaultId), ...summary })
  },

  /** Forget a vault (destroyed by the move service). */
  untrack(vaultId: string, destroyed = true): void {
    if (destroyed) destroyedVaults.add(vaultId)
    onLeftUnlocked(vaultId)
    summaries.delete(vaultId)
  },

  /**
   * A vault unlocked outside {@link unlock} (the move service drives the
   * backend itself) whose agent row now names it: open its transcripts, so
   * its chats can be written, and say so.
   */
  async adoptUnlocked(vaultId: string): Promise<void> {
    if (summaries.get(vaultId)?.state === 'unlocked') await openTranscripts(vaultId, generationOf(vaultId))
    publishState(vaultId)
    refreshReadiness(vaultId)
  },

  /**
   * Quit: each unlocked vault's queued journal writes (the turns
   * `saveInFlight` just saved) are delivered first, for at most
   * {@link SHUTDOWN_DRAIN_MS}, then every connection closes and the backend
   * stops. Only a drain that timed out is logged, with counts.
   */
  async shutdown(): Promise<void> {
    const pending = [...journals.entries()].filter(([vaultId, queue]) => queue.items.length > 0 && !queue.stopped && this.stateOf(vaultId) === 'unlocked')
    const run = (async () => {
      await Promise.all(pending.map(async ([vaultId, queue]) => {
        await journalDrained(vaultId, SHUTDOWN_DRAIN_MS)
        if (queue.items.length > 0) {
          logger.warn('vault transcript writes were still queued at quit', { vaultId, chats: new Set(queue.items.map((item) => item.chatId)).size, ops: queue.items.length })
        }
      }))
      for (const vaultId of [...clients.keys()]) onLeftUnlocked(vaultId)
      await vaultBackend().shutdown().catch(() => {})
    })()
    if (pending.length > 0) {
      quitDrain = run
      void run.finally(() => { if (quitDrain === run) quitDrain = null })
    }
    await run
  },

  /** The shutdown in progress while it still has journal writes to deliver; the quit handler waits for it. */
  pendingQuitDrain(): Promise<void> | null {
    return quitDrain
  },

  /** Test seam. */
  resetForTest(): void {
    summaries.clear()
    clients.clear()
    unlocking.clear()
    for (const queue of journals.values()) queue.stopped = true
    journals.clear()
    destroyedVaults.clear()
    lockGenerations.clear()
    eventStates.clear()
    quitDrain = null
    availabilityCache = null
    detach?.()
    detach = null
    initialized = false
  }
}

/** "<agent> · 13 Nov 2026": a vault chat's only title (D23). */
export function stubTitle(agentName: string, at = new Date()): string {
  const date = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${agentName} · ${date}`
}

function formatGb(bytes: number): string {
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`
}

function normalizeEgress(hosts: unknown): EgressPolicy {
  if (!Array.isArray(hosts) || hosts.length > 200) throw new VaultError('invalid', 'The network allowlist is not valid.')
  const out = new Set<string>()
  for (const raw of hosts) {
    const host = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!/^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
      throw new VaultError('invalid', `"${String(raw).slice(0, 80)}" is not a host name.`)
    }
    out.add(host)
  }
  return { hosts: [...out].sort() }
}

// ---------------------------------------------------------------------------
// The transcript journal

interface JournalQueue {
  items: { chatId: string; ops: TranscriptOp[] }[]
  running: boolean
  stopped: boolean
  /** Chats whose rows will never reach the vault (it was destroyed or refused them). */
  failed: Set<string>
  /** Woken whenever the queue moves (an item landed, or it failed). */
  waiters: Set<() => void>
}

/** Codes after which a journal write will never succeed; anything else is retried. */
const JOURNAL_PERMANENT = new Set(['not_found', 'tampered', 'invalid', 'bad_token', 'too_large'])
const JOURNAL_RETRY_MIN_MS = 250
const JOURNAL_RETRY_MAX_MS = 10_000
/** How long a quit waits for each unlocked vault's queued journal writes. */
const SHUTDOWN_DRAIN_MS = 3_000

function queueOf(vaultId: string): JournalQueue {
  let queue = journals.get(vaultId)
  if (!queue) journals.set(vaultId, (queue = { items: [], running: false, stopped: false, failed: new Set(), waiters: new Set() }))
  return queue
}

function wake(queue: JournalQueue): void {
  for (const waiter of [...queue.waiters]) waiter()
}

function journalGone(vaultId: string): boolean {
  const state = summaries.get(vaultId)?.state
  return destroyedVaults.has(vaultId) || state === 'tampered' || state === 'error'
}

/**
 * Journal ops for one chat through vaultd, in order per vault. Never throws
 * and never drops content: a write that fails is retried, in order, with a
 * growing pause, and while the vault is not unlocked it simply waits (a paused
 * VM stalls the channel; that is fine). Only a vault that is gone, broken or
 * refuses the write fails the chat's journal for good, which the turn then
 * reports ({@link journalSettled}). Logs no content.
 */
function journal(vaultId: string, chatId: string, ops: TranscriptOp[]): void {
  const queue = queueOf(vaultId)
  queue.items.push({ chatId, ops })
  if (!queue.running) void drainJournal(vaultId, queue)
}

async function drainJournal(vaultId: string, queue: JournalQueue): Promise<void> {
  queue.running = true
  let delay = JOURNAL_RETRY_MIN_MS
  try {
    while (queue.items.length > 0 && !queue.stopped) {
      const head = queue.items[0]
      if (journalGone(vaultId)) {
        failJournal(vaultId, queue, 'gone')
        break
      }
      if (vaultService.stateOf(vaultId) !== 'unlocked') {
        // Locked: nothing can be written until the next unlock.
        await new Promise((resolve) => setTimeout(resolve, 1_000).unref?.())
        continue
      }
      try {
        const client = await vaultService.client(vaultId)
        await client.request('transcript.append', { chatId: head.chatId, ops: head.ops })
        queue.items.shift()
        delay = JOURNAL_RETRY_MIN_MS
        wake(queue)
      } catch (error) {
        const code = error instanceof VaultdError || error instanceof VaultBackendError ? error.code : 'internal'
        if (JOURNAL_PERMANENT.has(code)) {
          failJournal(vaultId, queue, code)
          break
        }
        logger.warn('a vault transcript write failed; retrying', { vaultId, chatId: head.chatId, ops: head.ops.length, code })
        await new Promise((resolve) => setTimeout(resolve, delay).unref?.())
        delay = Math.min(delay * 2, JOURNAL_RETRY_MAX_MS)
      }
    }
  } finally {
    queue.running = false
    if (queue.items.length > 0 && !queue.stopped && !journalGone(vaultId)) void drainJournal(vaultId, queue)
  }
}

function failJournal(vaultId: string, queue: JournalQueue, code: string): void {
  const chats = new Set(queue.items.map((item) => item.chatId))
  for (const chatId of chats) queue.failed.add(chatId)
  logger.error('vault transcript writes were lost', { vaultId, chats: chats.size, ops: queue.items.length, code })
  queue.items = []
  wake(queue)
}

/** Whether a chat's journal caught up within `timeoutMs` (see `TranscriptSink.settled`). */
function journalSettled(vaultId: string, chatId: string, timeoutMs: number): Promise<JournalOutcome> {
  const queue = journals.get(vaultId)
  if (!queue) return Promise.resolve(destroyedVaults.has(vaultId) ? 'failed' : 'saved')
  return new Promise((resolve) => {
    const check = (): boolean => {
      if (queue.failed.has(chatId)) { done('failed'); return true }
      if (!queue.items.some((item) => item.chatId === chatId)) { done('saved'); return true }
      // Locked: it waits for the next unlock; a turn need not wait for that.
      if (vaultService.stateOf(vaultId) !== 'unlocked' && !journalGone(vaultId)) { done('pending'); return true }
      return false
    }
    const timer = setTimeout(() => done('pending'), timeoutMs)
    timer.unref?.()
    const done = (outcome: JournalOutcome): void => {
      clearTimeout(timer)
      queue.waiters.delete(waiter)
      resolve(outcome)
    }
    const waiter = (): void => { check() }
    queue.waiters.add(waiter)
    check()
  })
}

/** Wait (bounded) for a vault's queued journal writes to land, before its journals are read back. */
function journalDrained(vaultId: string, timeoutMs: number): Promise<void> {
  const queue = journals.get(vaultId)
  if (!queue || queue.items.length === 0) return Promise.resolve()
  if (!queue.running) void drainJournal(vaultId, queue)
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    function finish(): void {
      clearTimeout(timer)
      queue!.waiters.delete(check)
      resolve()
    }
    function check(): void {
      if (queue!.items.length === 0) finish()
    }
    queue.waiters.add(check)
  })
}

/**
 * Rebuild a vault's chats from the guest's journals. Throws (and opens
 * nothing) when they cannot be read; opens nothing when the vault left
 * `unlocked` since `generation` was read (a lock during the rebuild).
 */
async function openTranscripts(vaultId: string, generation: number): Promise<void> {
  if (vaultTranscripts.isOpen(vaultId)) return
  // Writes queued while it was locked go in first, so the rebuild includes them.
  await journalDrained(vaultId, 30_000)
  const chatIds = chatRepo.listVaultChatIds(vaultId)
  const client = await vaultService.client(vaultId)
  const journals: { chatId: string; ops: TranscriptOp[] }[] = []
  for (const chatId of chatIds) {
    journals.push({ chatId, ops: (await client.request('transcript.read', { chatId })).ops })
  }
  if (generationOf(vaultId) !== generation || vaultService.stateOf(vaultId) !== 'unlocked') return
  vaultTranscripts.openVault(vaultId, journals)
}
