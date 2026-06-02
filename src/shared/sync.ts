/**
 * Shared types for the Native Client Data Sync feature.
 *
 * These cross the contextBridge — the renderer only ever sees this surface.
 * Crucially, **no key material, UMK, or plaintext payloads appear here**: the
 * renderer learns *whether* sync is initialized/locked and high-level status,
 * never the secrets themselves (consistent with the "keys never leave main"
 * rule). See `plans/native-client-data-sync.md` §9.
 */

/** Collections synced in Phase 1. Phases 2/3 extend this union. */
export type SyncCollection =
  | 'note'
  | 'note_folder'
  | 'job'
  | 'job_folder'

/** High-level engine status surfaced to the UI. */
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline'

/** Methods that can unwrap the UMK on this device. */
export type UnlockMethod = 'device' | 'recovery' | 'passphrase'

export interface SyncDeviceInfo {
  id: string
  name: string
  /** True for the device making the request. */
  current: boolean
  createdAt: number | null
  lastSeenAt: number | null
}

export interface SyncState {
  /** Whether E2E has been initialized for this profile (server `active_umk_version > 0`). */
  initialized: boolean
  /** Whether the UMK is currently held in main-process memory. */
  locked: boolean
  /** Local pull cursor. */
  cursor: number
  status: SyncStatus
  /** Bytes stored server-side, if known. */
  usage: number | null
  /** Quota in bytes, if known. */
  quota: number | null
  devices: SyncDeviceInfo[]
  /** Unlock methods registered for this profile. */
  unlockMethods: UnlockMethod[]
  lastSyncAt: number | null
  error: string | null
}

/** Result of first-device initialization — the recovery mnemonic is shown ONCE. */
export interface SyncInitResult {
  recoveryMnemonic: string
  /** Data-URL PNG QR encoding the recovery mnemonic, for the backup screen. */
  recoveryQrDataUrl: string
}

export interface SyncUnlockRequest {
  method: UnlockMethod
  recoveryMnemonic?: string
  passphrase?: string
}

/** Payload shown by the device that initiates pairing (the joiner). */
export interface PairingOffer {
  /** Short human-typeable code (also encoded in the QR). */
  code: string
  /** Data-URL PNG QR encoding the full offer for camera-based joins. */
  qrDataUrl: string
  /** Short Authentication String to compare out-of-band (defeats key substitution). */
  sas: string
}

// ---- Portable job dependency descriptors (plan: data-sync-portable-deps) ----

/** MCP transport flavours (mirrors `mcp_providers.transport_type`). */
export type McpTransport = 'stdio' | 'sse' | 'streamable-http'

/**
 * A self-describing, *portable* reference to one of a job's dependencies. A job
 * no longer syncs device-local `nanoid`s for its agents/MCPs — it carries these
 * descriptors, keyed by each dependency's natural cross-device identity, so a
 * peer can resolve (or re-create) the same logical dependency regardless of the
 * row id it happens to have locally. Raw fields are carried so the peer can
 * re-derive the identity key and, on a miss, auto-create a setup shell. The
 * identity key itself is computed (`src/main/sync/identity.ts`), never wired.
 */
export type JobDepDescriptor =
  | {
      kind: 'agent'
      source: 'remote'
      /** Backend target kind: 'agent' | 'app_mcp_route' | 'identity'. */
      remoteTargetType: string
      /** Server-stable backend UUID — same on every device on that server. */
      remoteTargetId: string
      /** Cinna server the agent belongs to; guards against foreign-server bind. */
      serverUrl?: string | null
      /** Display name (setup hint only; not part of identity). */
      name?: string
    }
  | {
      kind: 'agent'
      source: 'local'
      /** A2A well-known card URL — the local agent's portable identity. */
      cardUrl: string
      name?: string
    }
  | {
      kind: 'mcp'
      transport: McpTransport
      /** http/sse connection URL. */
      url?: string | null
      /** stdio executable. */
      command?: string | null
      /** stdio arguments. */
      args?: string[] | null
      /** Display name (setup hint). */
      name: string
      /** Env variable *names* only — never values. Secrets never sync. */
      envKeys?: string[]
    }

/**
 * The synced dependency manifest stored in `jobs.sync_deps` and emitted on the
 * wire. This is the authoritative representation; the `jobAgents` /
 * `jobMcpProviders` join rows + `jobs.modeId` are the materialized resolvable
 * subset. Encode emits this verbatim (byte-stable round trip); apply stores it
 * verbatim then materializes.
 */
export interface JobSyncManifest {
  /** Bound chat mode by portable name (case-insensitive match on the peer). */
  modeName: string | null
  /** Portable descriptors for the job's agents + MCP providers. */
  deps: JobDepDescriptor[]
}

/** Per-dependency resolution state surfaced to the job UI (plan §8). */
export type JobDepState = 'resolved' | 'needs-setup' | 'unavailable'

/**
 * One row in a job's dependency-status list, derived from `sync_deps` + the
 * device's current local resolution. `resolved` → normal chip; `needs-setup`
 * → amber (auto-created/disabled, finish setup); `unavailable` → grey (can't
 * resolve here, e.g. a remote agent from a server you're not on).
 */
export interface JobDependencyStatus {
  /** Stable per-job key for React lists. */
  key: string
  kind: 'agent' | 'mcp' | 'mode'
  /** Human label (provider/agent/mode name). */
  label: string
  state: JobDepState
  /** Resolved local id when one exists (for deep-linking to setup). */
  localId: string | null
  /** MCP transport, present when kind === 'mcp' (drives the settings link). */
  transport?: McpTransport
}

/** Events the engine pushes to the renderer over the sync broadcast channel. */
export type SyncEvent =
  | { type: 'status'; status: SyncStatus }
  | { type: 'state'; state: SyncState }
  | { type: 'needs-unlock' }
  | { type: 'needs-setup' }
  | { type: 'quota-full'; detail?: string }
  | { type: 'conflict-applied'; collection: SyncCollection; clientEntityId: string }
  /**
   * A sync cycle applied peer changes to local tables. Carries the set of
   * collections that actually changed so the renderer can invalidate just those
   * React Query caches (synced-in jobs/notes/folders + derived dependency
   * status) instead of waiting for a manual refetch.
   */
  | { type: 'data-changed'; collections: SyncCollection[] }
  | { type: 'error'; message: string }
