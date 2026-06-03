import { createLogger } from '../logger/logger'
import { syncRepo } from '../db/sync'
import { syncApi, type PushRecordWire, type PullRecordWire } from '../services/syncApi'
import {
  COLLECTION_MAPPERS,
  MAPPERS_BY_COLLECTION,
  newResolveCache,
  type ResolveCache
} from './collections'
import { encryptPayload, decryptPayload, contentFingerprint } from './crypto/umk'
import type { SyncCollection } from '../../shared/sync'

const logger = createLogger('sync-engine')

const MAX_RECORDS_PER_PUSH = 500
const MAX_PAYLOAD_BYTES = 1024 * 1024 // 1 MiB
const PULL_PAGE = 200

export interface CycleResult {
  pushed: number
  pulled: number
  conflicts: number
  skipped: number
  /**
   * Records the server returned that we could NOT decrypt (AAD/UMK mismatch).
   * Expected to be small/zero in steady state — a non-zero value usually means
   * legacy data written before the crypto-identity switch. A cycle that pulls a
   * page but decrypts *none* of it points at a systemic identity bug, so the
   * caller escalates the log level when this is set. See `applyServerRecord`.
   */
  decryptSkipped: number
  quotaFull: boolean
  conflictKeys: Array<{ collection: PullRecordWire['collection']; clientEntityId: string }>
  /** Collections whose local tables were actually mutated by an apply. */
  changedCollections: SyncCollection[]
}

/** Outcome of applying one server record locally. */
type ApplyOutcome = 'applied' | 'skipped' | 'undecryptable'

/**
 * Apply one decrypted/decoded record from the server into local tables. Records
 * the touched collection in `changed` so the caller can scope renderer cache
 * invalidation to exactly what moved.
 *
 * `userId` is the local profile id (DB/repo scoping); `subjectId` is the backend
 * user id (JWT `sub`) used ONLY as the AEAD AAD identity so peers on the same
 * account decrypt each other's payloads. See `crypto/umk.ts:buildAad`.
 */
async function applyServerRecord(
  userId: string,
  subjectId: string,
  umk: Uint8Array,
  rec: PullRecordWire,
  cache: ResolveCache,
  changed: Set<SyncCollection>
): Promise<ApplyOutcome> {
  const mapper = MAPPERS_BY_COLLECTION[rec.collection]
  if (!mapper) {
    logger.warn('unknown collection in pull, skipping', { collection: rec.collection })
    return 'skipped'
  }
  // Carry the server timestamp onto the row (no `new Date()` bump) so an applied
  // copy stays a passive replica and never re-wins the next LWW round. (The
  // server doesn't echo the peer's client_updated_at; server_updated_at is
  // monotonic and ≥ the original, which is what the watermark needs.)
  const ctx = { clientUpdatedAt: rec.updated_at_ms ?? Date.now(), cache }
  if (!rec.payload_ciphertext) {
    // Hard-delete tombstone.
    mapper.apply(userId, rec.client_entity_id, null, true, ctx)
    changed.add(rec.collection)
    return 'applied'
  }
  let plaintext: Record<string, unknown>
  try {
    plaintext = (await decryptPayload({
      umk,
      userId: subjectId,
      collection: rec.collection,
      clientEntityId: rec.client_entity_id,
      envelopeB64: rec.payload_ciphertext
    })) as Record<string, unknown>
  } catch (err) {
    // Undecryptable record — the AAD identity or UMK generation doesn't match
    // ours. Almost always legacy data written before the crypto-identity switch
    // (old device-local id in the AAD; see `crypto/umk.ts:buildAad`). Skip it
    // instead of stalling the whole pull cycle: the cursor still advances, the
    // owning device can re-encrypt it via any edit, and the account can re-init
    // E2E to fully migrate. Never let one bad row block every other peer delta.
    // The caller tallies these and escalates if a whole page fails (see
    // `pullLoop`) so a systemic identity bug can't hide as routine legacy skips.
    logger.warn('skipping undecryptable record (AAD/UMK mismatch)', {
      collection: rec.collection,
      clientEntityId: rec.client_entity_id,
      umkVersion: rec.enc_umk_version,
      error: err instanceof Error ? err.message : String(err)
    })
    return 'undecryptable'
  }
  mapper.apply(userId, rec.client_entity_id, plaintext, rec.deleted, ctx)
  changed.add(rec.collection)
  return 'applied'
}

/** Build the encrypted push batch from dirty rows + tombstones. */
async function buildPushBatch(
  userId: string,
  subjectId: string,
  umk: Uint8Array,
  umkVersion: number,
  sinceMs: number
): Promise<{ records: PushRecordWire[]; skipped: number }> {
  const records: PushRecordWire[] = []
  let skipped = 0

  // Dirty upserts (folders first per COLLECTION_MAPPERS order).
  for (const mapper of COLLECTION_MAPPERS) {
    for (const dirty of mapper.listDirty(userId, sinceMs)) {
      // Guard: client_entity_id must never be a bare integer (plan §1).
      if (/^\d+$/.test(dirty.clientEntityId)) {
        logger.error('refusing to sync bare-integer client_entity_id', {
          collection: dirty.collection,
          clientEntityId: dirty.clientEntityId
        })
        skipped++
        continue
      }
      const ciphertext = await encryptPayload({
        umk,
        umkVersion,
        userId: subjectId,
        collection: dirty.collection,
        clientEntityId: dirty.clientEntityId,
        plaintext: dirty.plaintext
      })
      if (ciphertext.length > MAX_PAYLOAD_BYTES) {
        logger.warn('payload exceeds 1 MiB, skipping', {
          collection: dirty.collection,
          clientEntityId: dirty.clientEntityId,
          bytes: ciphertext.length
        })
        skipped++
        continue
      }
      const fingerprint = await contentFingerprint(umk, dirty.plaintext)
      records.push({
        collection: dirty.collection,
        client_entity_id: dirty.clientEntityId,
        payload_ciphertext: ciphertext,
        enc_umk_version: umkVersion,
        content_fingerprint: fingerprint,
        deleted: dirty.deleted,
        // Backend `client_updated_at` is a datetime — send ISO 8601, not ms.
        client_updated_at: new Date(dirty.clientUpdatedAt).toISOString()
      })
    }
  }

  // Hard-delete tombstones.
  for (const t of syncRepo.listUnpushedTombstones(userId)) {
    records.push({
      collection: t.collection,
      client_entity_id: t.clientEntityId,
      payload_ciphertext: null,
      enc_umk_version: umkVersion,
      content_fingerprint: null,
      deleted: true,
      client_updated_at: new Date(t.deletedAt).toISOString()
    })
  }

  return { records, skipped }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Drain pull pages from the current cursor until the server has no more. */
async function pullLoop(
  userId: string,
  subjectId: string,
  umk: Uint8Array,
  cache: ResolveCache,
  changed: Set<SyncCollection>
): Promise<{ pulled: number; decryptSkipped: number }> {
  let pulled = 0
  let decryptSkipped = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const state = syncRepo.ensureState(userId)
    const res = await syncApi.pull(userId, { cursor: state.cursor, limit: PULL_PAGE })
    let pageApplied = 0
    let pageUndecryptable = 0
    for (const rec of res.changes) {
      const outcome = await applyServerRecord(userId, subjectId, umk, rec, cache, changed)
      if (outcome === 'applied') pageApplied++
      else if (outcome === 'undecryptable') pageUndecryptable++
    }
    pulled += pageApplied
    decryptSkipped += pageUndecryptable
    // A page where every payload failed to decrypt (and none applied) is the
    // signature of a systemic identity/UMK mismatch rather than a few stray
    // legacy rows — escalate so it surfaces in the logger UI instead of hiding
    // among routine `warn`s. We still advance the cursor: blocking here would
    // permanently stall a device whose backlog legitimately is all-legacy.
    if (pageUndecryptable > 0 && pageApplied === 0) {
      logger.error('pull page fully undecryptable — possible identity/UMK mismatch', {
        userId,
        cursor: state.cursor,
        records: res.changes.length,
        undecryptable: pageUndecryptable
      })
    }
    syncRepo.patchState(userId, { cursor: res.next_cursor, lastPulledAt: Date.now() })
    if (!res.has_more) break
    if (res.changes.length === 0) break // safety: avoid infinite loop on a stuck cursor
  }
  return { pulled, decryptSkipped }
}

/**
 * One full sync cycle: push dirty rows + tombstones (chunked), apply the
 * server's returned changes + conflicts, then drain any remaining pull pages.
 */
export async function runSyncCycle(
  userId: string,
  subjectId: string,
  umk: Uint8Array,
  umkVersion: number
): Promise<CycleResult> {
  const result: CycleResult = {
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    skipped: 0,
    decryptSkipped: 0,
    quotaFull: false,
    conflictKeys: [],
    changedCollections: []
  }

  const state = syncRepo.ensureState(userId)
  const sinceMs = state.lastPushedAt ?? 0
  // One resolve cache for the whole cycle so a dependency missing across many
  // applied jobs is auto-created exactly once.
  const cache = newResolveCache()
  // Collections mutated by an apply this cycle — drives scoped renderer cache
  // invalidation in syncService.
  const changed = new Set<SyncCollection>()
  const { records, skipped } = await buildPushBatch(userId, subjectId, umk, umkVersion, sinceMs)
  result.skipped = skipped

  // Push-only upload (POST /push). The returned cursor is NOT a safe pull
  // cursor (it'd skip concurrent peer writes), so we never adopt it — the pull
  // loop below advances the real cursor.
  for (const batch of chunk(records, MAX_RECORDS_PER_PUSH)) {
    const res = await syncApi.push(userId, { changes: batch })

    for (const r of res.results) {
      switch (r.status) {
        case 'applied':
        case 'unchanged':
          result.pushed += r.status === 'applied' ? 1 : 0
          // Clear tombstone if this was a hard-delete.
          syncRepo.markTombstonePushed(userId, r.collection, r.client_entity_id)
          break
        case 'conflict':
          result.conflicts++
          result.conflictKeys.push({ collection: r.collection, clientEntityId: r.client_entity_id })
          if (r.server_record) {
            // LWW loser reconciles by overwriting local with the winner.
            const outcome = await applyServerRecord(
              userId,
              subjectId,
              umk,
              r.server_record,
              cache,
              changed
            )
            if (outcome === 'undecryptable') result.decryptSkipped++
          }
          break
        case 'rejected':
          result.skipped++
          logger.warn('server rejected record', { ...r })
          break
      }
    }
  }

  // Drain server changes (covers steady-state peer deltas + bootstrap).
  const drained = await pullLoop(userId, subjectId, umk, cache, changed)
  result.pulled += drained.pulled
  result.decryptSkipped += drained.decryptSkipped

  // Advance the dirty watermark from the max *post-apply* updatedAt. Apply no
  // longer bumps updatedAt, so freshly-pulled replicas carry the peer's
  // (older) timestamp and are correctly excluded from the next push — no
  // re-push churn. Any false re-send still resolves to `unchanged` via
  // fingerprint.
  let newWatermark = sinceMs
  for (const mapper of COLLECTION_MAPPERS) {
    newWatermark = Math.max(newWatermark, mapper.maxUpdatedAt(userId))
  }
  syncRepo.patchState(userId, { lastPushedAt: newWatermark })

  result.changedCollections = [...changed]
  return result
}

/**
 * Fresh-login bootstrap: drain everything from cursor 0 before the first push,
 * so a brand-new device hydrates rather than racing its own empty state up.
 */
export async function bootstrap(
  userId: string,
  subjectId: string,
  umk: Uint8Array
): Promise<number> {
  syncRepo.patchState(userId, { cursor: 0 })
  // Deliberately leave `lastPushedAt` untouched so the first cycle still pushes
  // any local rows that predate this device's sync (recovery case).
  const { pulled } = await pullLoop(userId, subjectId, umk, newResolveCache(), new Set())
  return pulled
}
