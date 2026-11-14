/**
 * The vault backend seam (README "Layer 1"). Hub core: no Electron, no
 * desktop imports. The composition root installs a concrete backend with
 * {@link installVaultBackend} the way `host/runtimeHost.ts` installs the host;
 * until it does, {@link vaultBackend} reports `helper-missing`.
 *
 * A backend provides isolation, a byte stream to cinna-vaultd, key custody
 * and the presence gates. Everything inside the vault (engines, files,
 * secrets, transcripts) is the guest protocol's (`vaultdClient.ts`).
 */
import type {
  EgressPolicy,
  GatedAction,
  HelperEvent,
  HelperFlavor,
  VaultAvailability,
  VaultEngine,
  VaultState,
  VaultSummary,
  VaultUnavailableReason
} from '../../shared/vault/protocol'
import type { VaultCapabilities } from '../../shared/vault/types'
import type { VaultFileAccess } from './fileAccess'

export type VaultBackendKind = 'apple-vz' | 'fake' | 'unavailable'

/** A byte stream to cinna-vaultd: one connection (a helper channel or a unix socket). */
export interface VaultChannel {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  /** Tears the connection down both ways; idempotent. */
  close(reason?: string): void
}

export interface VaultHello {
  flavor: HelperFlavor
  helperVersion: string
  guest: { version: string; rootHash: string }
}

export interface VaultCreateSpec {
  /** The `SecureAgents/` folder the vault lives in. */
  dir: string
  vaultId: string
  agentId: string
  agentName: string
  engine: VaultEngine
  sizeBytes: number
  egress: EgressPolicy
  rootfsPath: string
}

/** Events a backend pushes: the helper's `vault.state`, `egress` and `log`. */
export type VaultBackendEvent = HelperEvent

export interface VaultBackend {
  readonly kind: VaultBackendKind
  capabilities(): VaultCapabilities
  /** The helper's hello (flavor, versions). Rejects when it cannot be reached. */
  hello(): Promise<VaultHello>
  availability(): Promise<VaultAvailability>
  list(dir: string): Promise<VaultSummary[]>
  create(spec: VaultCreateSpec): Promise<VaultSummary>
  status(vaultId: string): Promise<VaultSummary>
  /** User presence inside the backend's trust base; resolves with the state reached. */
  unlock(vaultId: string, purpose: string): Promise<VaultState>
  lock(vaultId: string): Promise<VaultState>
  hold(vaultId: string, holdId: string): Promise<void>
  release(vaultId: string, holdId: string): Promise<void>
  /** A fresh presence prompt for one gated action; the token the guest or helper verifies. */
  approve(vaultId: string, action: GatedAction, detail: string): Promise<string>
  setEgress(vaultId: string, policy: EgressPolicy, token: string): Promise<void>
  /**
   * The vault's lock timeout (`VAULT_LOCK_TIMEOUTS`). A strictly shorter one
   * needs no token; anything else a `lock-timeout` token for exactly this value.
   */
  setLockTimeout(vaultId: string, lockAfterMs: number, token?: string): Promise<void>
  /** Restarts an unlocked, unheld vault's idle window; a no-op otherwise. No prompt. */
  touch(vaultId: string): Promise<void>
  resize(vaultId: string, sizeBytes: number, token: string): Promise<void>
  destroy(vaultId: string, token: string): Promise<void>
  /** A new connection to cinna-vaultd; the vault must be unlocked. */
  open(vaultId: string): Promise<VaultChannel>
  /**
   * The agent folder's path as processes inside the vault see it: the cwd an
   * engine's sessions name. `/vault/agent` in a guest; the fake backend's own
   * directory on this computer. Absent: {@link GUEST_AGENT_PATH}.
   */
  guestAgentPath?(vaultId: string): string
  /**
   * How the agent's files are stat-ed, read and exported, for a backend that
   * does not run cinna-vaultd inside. Absent: the guest protocol
   * (`createGuestFileAccess`); `vaultService.files()` picks.
   */
  files?(): VaultFileAccess
  /** Subscribe to backend events; returns the unsubscribe. */
  onEvent(listener: (event: VaultBackendEvent) => void): () => void
  /** Stops the helper (and with it every VM). */
  shutdown(): Promise<void>
}

/** The agent folder inside every Linux guest (`/vault/agent`). */
export const GUEST_AGENT_PATH = '/vault/agent'

/** A backend failure with the helper's error code (`denied`, `locked`, …). */
export class VaultBackendError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'VaultBackendError'
  }
}

const NO_CAPABILITIES: VaultCapabilities = { separateKernel: false, hardwareKey: false, perActionPresence: false, lockTimeouts: [], idleTouch: false }

/** A backend that answers every call with the reason it cannot serve vaults. */
export function unavailableBackend(reason: VaultUnavailableReason, detail?: string): VaultBackend {
  const refuse = async (): Promise<never> => {
    throw new VaultBackendError('unavailable', detail ?? `Agent Vault is unavailable (${reason}).`)
  }
  return {
    kind: 'unavailable',
    capabilities: () => NO_CAPABILITIES,
    hello: refuse,
    availability: async () => ({ ok: false, reason, ...(detail ? { detail } : {}) }),
    // Nothing can be listed, but nothing is wrong with asking.
    list: async () => [],
    create: refuse,
    status: refuse,
    unlock: refuse,
    lock: refuse,
    hold: refuse,
    release: refuse,
    approve: refuse,
    setEgress: refuse,
    setLockTimeout: refuse,
    touch: refuse,
    resize: refuse,
    destroy: refuse,
    open: refuse,
    onEvent: () => () => {},
    shutdown: async () => {}
  }
}

let installed: VaultBackend = unavailableBackend('helper-missing')
const installListeners = new Set<(backend: VaultBackend) => void>()

/** Installed by the composition root before vault calls; core never picks a backend itself. */
export function installVaultBackend(backend: VaultBackend): void {
  installed = backend
  for (const listener of installListeners) listener(backend)
}

/** Called with each newly installed backend (the vault service re-subscribes to its events). */
export function onVaultBackendInstalled(listener: (backend: VaultBackend) => void): () => void {
  installListeners.add(listener)
  return () => installListeners.delete(listener)
}

export function vaultBackend(): VaultBackend {
  return installed
}
