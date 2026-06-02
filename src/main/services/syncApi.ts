import { cinnaApiFetch } from './cinnaApiService'
import type { KeyEnvelopeWire } from '../sync/crypto/envelopes'
import type { SyncCollection } from '../../shared/sync'

/**
 * HTTP client for cinna-core's zero-knowledge app-sync API
 * (`/api/v1/app-sync`). Thin wrappers over {@link cinnaApiFetch} (shared Bearer
 * auth + reauth detection). Wire shapes mirror the backend Pydantic models
 * (`app_sync_schemas.py`, `app_sync_key_envelope.py`, `app_sync_device.py`,
 * `app_sync_pairing.py`) — this is the one module that knows the on-wire
 * field names, so the engine/service work against the mapped, stable interfaces
 * (`PullRecordWire`, `PushResultWire`, …) below.
 */

const BASE = '/api/v1/app-sync'

// ---- engine-facing (mapped) shapes ----

/** One change pushed to the server (mirrors `SyncRecordUpsert`). */
export interface PushRecordWire {
  collection: SyncCollection
  client_entity_id: string
  /** base64 payload envelope; null for a hard-delete tombstone. */
  payload_ciphertext: string | null
  enc_umk_version: number
  content_fingerprint: string | null
  deleted: boolean
  /** ISO 8601 — the backend field is a `datetime`, NOT a Unix epoch. */
  client_updated_at: string
}

/** A record pulled from the server, mapped for the engine. */
export interface PullRecordWire {
  collection: SyncCollection
  client_entity_id: string
  payload_ciphertext: string | null
  enc_umk_version: number
  deleted: boolean
  /** Server sequence (the pull cursor unit). */
  server_seq: number
  /**
   * ms epoch derived from the server's `server_updated_at`. The server does NOT
   * echo the peer's `client_updated_at`, so this is what an applied replica
   * carries as its local `updatedAt` (keeps it a passive replica; excluded from
   * the next push watermark).
   */
  updated_at_ms: number
}

export type PushStatus = 'applied' | 'unchanged' | 'conflict' | 'rejected'

export interface PushResultWire {
  collection: SyncCollection
  client_entity_id: string
  status: PushStatus
  /** Present when status === 'conflict' — the winning server record. */
  server_record?: PullRecordWire
}

// ---- encryption / devices ----

export interface DeviceWire {
  id: string
  device_label: string
  public_key: string
  external_client_id?: string | null
  is_revoked: boolean
  created_at?: string | null
  last_seen_at?: string | null
}

/** GET `/encryption` — what unlock methods exist + registered devices. */
export interface EncryptionStateWire {
  initialized: boolean
  active_umk_version: number
  has_recovery: boolean
  has_passphrase: boolean
  devices: DeviceWire[]
}

/** GET `/state` — cursor + storage usage (NO devices / version here). */
export interface SyncStateWire {
  cursor: number
  total_records: number
  total_bytes: number
  quota_bytes: number
  quota_records: number
  collection_counts: Record<string, number>
}

export interface DeviceInputWire {
  device_label: string
  public_key: string
  external_client_id?: string | null
}

// ---- raw backend response shapes (internal) ----

interface RawRecordPublic {
  collection: string
  client_entity_id: string
  payload_ciphertext: string | null
  enc_umk_version: number
  deleted: boolean
  seq: number
  server_updated_at: string
  last_writer_client_id?: string | null
}

interface RawPushResult {
  collection: string
  client_entity_id: string
  status: PushStatus
  seq: number
  server_record?: RawRecordPublic | null
}

interface RawSyncResponse {
  applied: RawPushResult[]
  changes: RawRecordPublic[]
  next_cursor: number
  has_more: boolean
  server_time: string
}

function mapRecord(r: RawRecordPublic): PullRecordWire {
  const ms = Date.parse(r.server_updated_at)
  return {
    collection: r.collection as SyncCollection,
    client_entity_id: r.client_entity_id,
    payload_ciphertext: r.payload_ciphertext ?? null,
    enc_umk_version: r.enc_umk_version,
    deleted: r.deleted,
    server_seq: r.seq,
    updated_at_ms: Number.isFinite(ms) ? ms : Date.now()
  }
}

function mapResult(r: RawPushResult): PushResultWire {
  return {
    collection: r.collection as SyncCollection,
    client_entity_id: r.client_entity_id,
    status: r.status,
    server_record: r.server_record ? mapRecord(r.server_record) : undefined
  }
}

export const syncApi = {
  // ---- encryption / key management ----

  initEncryption(
    userId: string,
    body: { device: DeviceInputWire; envelopes: KeyEnvelopeWire[] }
  ): Promise<EncryptionStateWire> {
    return cinnaApiFetch<EncryptionStateWire>(userId, `${BASE}/encryption/init`, {
      method: 'POST',
      body
    })
  },

  getEncryptionState(userId: string): Promise<EncryptionStateWire> {
    return cinnaApiFetch<EncryptionStateWire>(userId, `${BASE}/encryption`)
  },

  getSyncState(userId: string): Promise<SyncStateWire> {
    return cinnaApiFetch<SyncStateWire>(userId, `${BASE}/state`)
  },

  /** List wrapped envelopes (optionally pinned to a UMK generation). */
  listKeys(userId: string, umkVersion?: number): Promise<KeyEnvelopeWire[]> {
    const q = umkVersion != null ? `?umk_version=${umkVersion}` : ''
    return cinnaApiFetch<KeyEnvelopeWire[]>(userId, `${BASE}/keys${q}`)
  },

  /** Add or replace a single wrapped-UMK envelope. */
  addKey(userId: string, envelope: KeyEnvelopeWire): Promise<KeyEnvelopeWire> {
    return cinnaApiFetch<KeyEnvelopeWire>(userId, `${BASE}/keys`, {
      method: 'POST',
      body: envelope
    })
  },

  // ---- sync verbs ----

  async pull(
    userId: string,
    body: { cursor: number; limit: number }
  ): Promise<{ changes: PullRecordWire[]; next_cursor: number; has_more: boolean }> {
    const res = await cinnaApiFetch<RawSyncResponse>(userId, `${BASE}/pull`, {
      method: 'POST',
      body
    })
    return {
      changes: (res.changes ?? []).map(mapRecord),
      next_cursor: res.next_cursor,
      has_more: res.has_more
    }
  },

  /** Push-only upload. Returns per-record results (incl. conflicts). */
  async push(
    userId: string,
    body: { changes: PushRecordWire[] }
  ): Promise<{ results: PushResultWire[] }> {
    const res = await cinnaApiFetch<RawSyncResponse>(userId, `${BASE}/push`, {
      method: 'POST',
      body
    })
    return { results: (res.applied ?? []).map(mapResult) }
  },

  wipe(userId: string): Promise<void> {
    return cinnaApiFetch<void>(userId, `${BASE}/`, { method: 'DELETE' })
  },

  // ---- devices ----

  registerDevice(userId: string, body: DeviceInputWire): Promise<DeviceWire> {
    return cinnaApiFetch<DeviceWire>(userId, `${BASE}/devices`, { method: 'POST', body })
  },

  listDevices(userId: string): Promise<DeviceWire[]> {
    return cinnaApiFetch<DeviceWire[]>(userId, `${BASE}/devices`)
  },

  revokeDevice(userId: string, deviceId: string): Promise<void> {
    return cinnaApiFetch<void>(userId, `${BASE}/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE'
    })
  },

  // ---- pairing relay ----

  pairingStart(
    userId: string,
    body: { new_device_pubkey: string; device_label: string | null }
  ): Promise<{ pairing_code: string; expires_at: string }> {
    return cinnaApiFetch(userId, `${BASE}/pairing/start`, { method: 'POST', body })
  },

  pairingGet(
    userId: string,
    code: string
  ): Promise<{
    new_device_pubkey: string
    device_label: string | null
    status: string
    sealed_umk: string | null
    expires_at: string
  } | null> {
    return cinnaApiFetch<{
      new_device_pubkey: string
      device_label: string | null
      status: string
      sealed_umk: string | null
      expires_at: string
    }>(userId, `${BASE}/pairing/${encodeURIComponent(code)}`).catch(() => null)
  },

  pairingComplete(userId: string, code: string, sealedUmk: string): Promise<void> {
    return cinnaApiFetch<void>(
      userId,
      `${BASE}/pairing/${encodeURIComponent(code)}/complete`,
      { method: 'POST', body: { sealed_umk: sealedUmk } }
    )
  }
}
