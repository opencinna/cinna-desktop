import os from 'os'
import { BrowserWindow } from 'electron'
import { nanoid } from 'nanoid'
import QRCode from 'qrcode'
import { createLogger } from '../logger/logger'
import { CinnaApiError, SyncError } from '../errors'
import { userRepo } from '../db/users'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import { syncRepo } from '../db/sync'
import { syncApi } from './syncApi'
import { runSyncCycle } from '../sync/syncEngine'
import { getCinnaAccessToken, decodeAccessTokenSubject } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import * as vault from '../sync/umkVault'
import { generateUmk } from '../sync/crypto/umk'
import { generateDeviceKeypair, deviceKeyCodec } from '../sync/crypto/deviceKey'
import {
  buildDeviceEnvelope,
  openDeviceEnvelope,
  buildRecoveryEnvelope,
  openRecoveryEnvelope,
  buildPassphraseEnvelope,
  openPassphraseEnvelope,
  deriveKekFromPassphrase,
  type KeyEnvelopeWire
} from '../sync/crypto/envelopes'
import { generateRecoveryKey, mnemonicToKek } from '../sync/crypto/recovery'
import {
  createPairingEphemeral,
  encodePairingPublicKey,
  decodePairingPublicKey,
  computeSas,
  sealUmkForJoiner,
  openSealedUmk,
  type PairingEphemeral
} from '../sync/crypto/pairing'
import type {
  SyncState,
  SyncStatus,
  SyncEvent,
  SyncInitResult,
  SyncUnlockRequest,
  UnlockMethod,
  PairingOffer
} from '../../shared/sync'

const logger = createLogger('sync')
const SYNC_EVENT_CHANNEL = 'sync:event'
const PERIODIC_MS = 60_000
const DEBOUNCE_MS = 1_500

// ---- per-profile runtime state (timers, debounce, pairing) ----

interface DeviceMaterial {
  publicKey: Uint8Array
  privateKey: Uint8Array
  deviceId: string
}

const debounceTimers = new Map<string, NodeJS.Timeout>()
const periodicTimers = new Map<string, NodeJS.Timeout>()
const pairingEphemerals = new Map<string, PairingEphemeral>() // code -> ephemeral
// Sealer side: joiner public keys awaiting the user's out-of-band SAS
// confirmation. The UMK is sealed only after `confirmScan`, so a substituted
// key is caught (mismatching SAS) before the secret ever leaves this device.
const pendingSeals = new Map<string, Uint8Array>() // code -> joiner public key
// Profiles the user explicitly **paused** this session. While paused, the
// per-launch silent auto-unlock is suppressed — otherwise the very next
// `getState()` would re-unlock a trusted device and the UI would flap between
// Paused/Active. Cleared on resume (any unlock) and on profile switch. Pause is
// intentionally session-scoped: a relaunch auto-unlocks as usual.
const pausedUserIds = new Set<string>()
let lastStatus: SyncStatus = 'idle'

function broadcast(event: SyncEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(SYNC_EVENT_CHANNEL, event)
  }
}

function emitStatus(status: SyncStatus): void {
  lastStatus = status
  broadcast({ type: 'status', status })
}

function isCinnaProfile(userId: string): boolean {
  const user = userRepo.get(userId)
  return !!user && user.type === 'cinna_user'
}

// ---- crypto identity (JWT `sub`) ----
//
// The AEAD AAD is keyed by the *backend* user id (the access token's `sub`
// claim), NOT the device-local profile id. That id is identical on every
// device/app linked to one account, so peers can decrypt each other's payloads
// (desktop↔desktop, desktop↔mobile). The local profile id keeps scoping the DB,
// token storage, and `sync_state` — only the crypto identity switches. Mobile
// derives the same value the same way (`syncService.resolveSubject`).

const subjectIds = new Map<string, string>() // profile userId -> JWT sub

/** Resolve the backend user id (JWT `sub`) for a profile, cached per session. */
async function resolveSubject(userId: string): Promise<string> {
  const cached = subjectIds.get(userId)
  if (cached) return cached
  const token = await getCinnaAccessToken(userId)
  const sub = decodeAccessTokenSubject(token)
  subjectIds.set(userId, sub)
  return sub
}

/**
 * Drop this device's local sync enrollment: zero the in-memory UMK, delete the
 * device keypair + `sync_state`, and clear the cached subject + pause flag.
 *
 * Used by the full reset (`wipe`) and — crucially — whenever the server reports
 * the account is no longer E2E-initialized (a reset performed here or on a
 * peer). Without this, stale local `sync_state` (`activeUmkVersion > 0`) keeps
 * the UI stuck on "Paused/Resume" (a device unlock that can only fail with "not
 * trusted") and trips `initEncryption`'s already-initialized guard, leaving the
 * user unable to re-enable sync.
 */
async function forgetLocalEnrollment(userId: string): Promise<void> {
  await vault.lock(userId)
  syncRepo.deleteDeviceKey(userId)
  syncRepo.deleteState(userId)
  // Drop the delete-propagation queue too — a reset/re-enable must not replay
  // stale hard-deletes (tied to the old key generation) onto the fresh account.
  syncRepo.deleteTombstones(userId)
  subjectIds.delete(userId)
  pausedUserIds.delete(userId)
}

// ---- device key material ----

async function ensureDeviceKey(userId: string): Promise<DeviceMaterial> {
  const existing = syncRepo.getDeviceKey(userId)
  if (existing) {
    const publicKey = await deviceKeyCodec.from(existing.publicKey)
    const privB64 = decryptApiKey(existing.privateKeyEnc)
    const privateKey = await deviceKeyCodec.from(privB64)
    let deviceId = existing.deviceId
    if (!deviceId) {
      deviceId = nanoid()
      syncRepo.setDeviceId(userId, deviceId)
    }
    return { publicKey, privateKey, deviceId }
  }
  const kp = await generateDeviceKeypair()
  const pubB64 = await deviceKeyCodec.to(kp.publicKey)
  const privB64 = await deviceKeyCodec.to(kp.privateKey)
  const deviceId = nanoid()
  syncRepo.saveDeviceKey({
    userId,
    deviceId,
    publicKey: pubB64,
    privateKeyEnc: encryptApiKey(privB64)
  })
  return { publicKey: kp.publicKey, privateKey: kp.privateKey, deviceId }
}

function deviceName(): string {
  return `${os.hostname()} (desktop)`
}

// ---- key registration ----

/**
 * Ensure this install is registered as a server-side device and return its
 * server UUID (stored in `sync_state.device_id`). Device key envelopes FK to
 * this id, and auto-unlock matches the device envelope by it.
 */
async function ensureServerDeviceId(userId: string, publicKey: Uint8Array): Promise<string> {
  const local = syncRepo.getState(userId)
  if (local?.deviceId) return local.deviceId
  const dev = await syncApi.registerDevice(userId, {
    device_label: deviceName(),
    public_key: await deviceKeyCodec.to(publicKey)
  })
  syncRepo.patchState(userId, { deviceId: dev.id })
  return dev.id
}

/** Append this device's `device` envelope so subsequent launches unlock silently. */
async function registerDeviceEnvelope(
  userId: string,
  umk: Uint8Array,
  version: number
): Promise<void> {
  const device = await ensureDeviceKey(userId)
  const serverDeviceId = await ensureServerDeviceId(userId, device.publicKey)
  const env = await buildDeviceEnvelope(umk, device.publicKey, version, serverDeviceId)
  await syncApi.addKey(userId, env)
}

// ---- state DTO ----

/** This device's `device` envelope (matched by server device id, then pubkey). */
async function findDeviceEnvelope(
  userId: string,
  version: number
): Promise<KeyEnvelopeWire | undefined> {
  const keys = await syncApi.listKeys(userId, version)
  const device = await ensureDeviceKey(userId)
  const myPub = await deviceKeyCodec.to(device.publicKey)
  const serverDeviceId = syncRepo.getState(userId)?.deviceId ?? null
  const match = keys.find(
    (e) =>
      e.wrap_method === 'device' &&
      ((serverDeviceId != null && e.device_id === serverDeviceId) ||
        e.kdf_params?.device_public_key === myPub)
  )
  if (!match) {
    // Surface WHY trust didn't resolve — the usual cause is the account's E2E
    // was set up with a different device key (other client / cleared local
    // data), so this device is genuinely untrusted and needs recovery/pairing.
    const deviceEnvs = keys.filter((e) => e.wrap_method === 'device')
    logger.warn('no matching device envelope for this device', {
      version,
      serverDeviceId,
      myPubPrefix: myPub.slice(0, 10),
      deviceEnvelopeCount: deviceEnvs.length,
      deviceEnvelopes: deviceEnvs.map((e) => ({
        device_id: e.device_id,
        hasStoredPub: !!e.kdf_params?.device_public_key,
        pubMatches: e.kdf_params?.device_public_key === myPub
      }))
    })
  }
  return match
}

async function buildStateDto(userId: string): Promise<SyncState> {
  const local = syncRepo.getState(userId)
  const initialized = (local?.activeUmkVersion ?? 0) > 0
  const locked = !vault.isUnlocked(userId)

  let usage: number | null = null
  let quota: number | null = null
  let devices: SyncState['devices'] = []
  let unlockMethods: UnlockMethod[] = []
  let status: SyncStatus = lastStatus

  // `/encryption` is the source of truth for init state, unlock methods and
  // registered devices; `/state` carries storage usage + the server cursor.
  const [enc, serverState] = await Promise.all([
    syncApi.getEncryptionState(userId).catch((err) => {
      logger.debug('getEncryptionState unavailable (offline?)', {
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }),
    syncApi.getSyncState(userId).catch(() => null)
  ])

  if (serverState) {
    usage = serverState.total_bytes ?? null
    quota = serverState.quota_bytes ?? null
  }

  if (enc) {
    const myDeviceId = local?.deviceId ?? null
    devices = enc.devices
      .filter((d) => !d.is_revoked)
      .map((d) => ({
        id: d.id,
        name: d.device_label || 'Device',
        current: d.id === myDeviceId,
        createdAt: d.created_at ? Date.parse(d.created_at) || null : null,
        lastSeenAt: d.last_seen_at ? Date.parse(d.last_seen_at) || null : null
      }))
    if (enc.initialized) {
      // init requires a device + recovery envelope; passphrase is optional.
      unlockMethods = ['device', 'recovery']
      if (enc.has_passphrase) unlockMethods.push('passphrase')
    }
  } else if (initialized) {
    status = 'offline'
  }

  return {
    // `/encryption` is authoritative for init state when reachable; only fall
    // back to the local flag when offline (`enc == null`). Using an OR would
    // keep a device that the server has reset stuck on a stale "initialized".
    initialized: enc ? enc.initialized : initialized,
    locked,
    cursor: local?.cursor ?? 0,
    status,
    usage,
    quota,
    devices,
    unlockMethods,
    lastSyncAt: local?.lastPulledAt ?? local?.lastPushedAt ?? null,
    error: null
  }
}

async function pushState(userId: string): Promise<SyncState> {
  const state = await buildStateDto(userId)
  broadcast({ type: 'state', state })
  return state
}

// ---- core sync ----

async function runCycleNow(userId: string): Promise<void> {
  if (!isCinnaProfile(userId)) return
  if (pausedUserIds.has(userId)) return // paused — stay quiet (no needs-unlock churn)
  const local = syncRepo.getState(userId)
  if (!local || local.activeUmkVersion === 0) {
    broadcast({ type: 'needs-setup' })
    return
  }
  const entry = vault.getUmk(userId)
  if (!entry) {
    broadcast({ type: 'needs-unlock' })
    return
  }
  emitStatus('syncing')
  try {
    const subjectId = await resolveSubject(userId)
    const result = await runSyncCycle(userId, subjectId, entry.umk, entry.version)
    if (result.quotaFull) broadcast({ type: 'quota-full' })
    for (const c of result.conflictKeys) {
      broadcast({ type: 'conflict-applied', collection: c.collection, clientEntityId: c.clientEntityId })
    }
    // Tell the renderer which collections moved so it can invalidate just those
    // caches (synced-in jobs/notes/folders + derived dependency status) instead
    // of waiting for a manual refetch.
    if (result.changedCollections.length > 0) {
      broadcast({ type: 'data-changed', collections: result.changedCollections })
    }
    emitStatus('idle')
    await pushState(userId)
    logger.info('sync cycle complete', { userId, ...result })
  } catch (err) {
    // Reauth can surface either normalized (CinnaApiError from the api layer) or
    // raw (CinnaReauthRequired straight from `getCinnaAccessToken`, e.g. via
    // `resolveSubject` before any api call). Treat both as the quiet reauth path
    // — the global reauth modal drives re-auth; don't show a sync error toast.
    if (
      (err instanceof CinnaApiError && err.code === 'reauth_required') ||
      err instanceof CinnaReauthRequired
    ) {
      emitStatus('error')
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error('sync cycle failed', { userId, error: message })
    emitStatus('error')
    broadcast({ type: 'error', message })
  }
}

// ---- public service ----

export const syncService = {
  async getState(userId: string): Promise<SyncState> {
    await this.ensureActivated(userId)
    return buildStateDto(userId)
  },

  /**
   * Idempotent per-launch activation: silently unlock via the device envelope
   * if possible, and arm the periodic sync timer. Safe to call repeatedly.
   */
  async ensureActivated(userId: string): Promise<void> {
    if (!isCinnaProfile(userId)) return
    if (!vault.isUnlocked(userId)) {
      // `/encryption` is the source of truth for init state — reconcile local
      // enrollment against it in BOTH directions, and even while paused (a reset
      // must be able to un-stick the device).
      const enc = await syncApi.getEncryptionState(userId).catch(() => null)
      if (enc && !enc.initialized) {
        // Account was reset (here or on a peer). Drop stale local enrollment so
        // the UI offers a fresh "Enable" instead of a dead "Resume", and clear
        // any pause flag that would otherwise keep it pinned.
        const hadLocal = (syncRepo.getState(userId)?.activeUmkVersion ?? 0) > 0
        await forgetLocalEnrollment(userId)
        if (hadLocal) {
          logger.info('sync: account reset server-side, cleared local enrollment', { userId })
          broadcast({ type: 'needs-setup' })
        }
      } else if (!pausedUserIds.has(userId)) {
        // Respect an explicit pause — don't silently re-unlock until resume.
        let initialized = (syncRepo.getState(userId)?.activeUmkVersion ?? 0) > 0
        if (!initialized && enc?.initialized) {
          // Local state behind the server (e.g. init persisted server-side but a
          // desktop crash lost the local flag) — adopt the server's version so a
          // trusted device still auto-unlocks instead of being stuck "locked".
          initialized = true
          syncRepo.patchState(userId, { activeUmkVersion: enc.active_umk_version })
        }
        if (initialized) await this.tryAutoUnlock(userId, enc)
      }
    }
    if (!periodicTimers.has(userId)) {
      const timer = setInterval(() => void runCycleNow(userId), PERIODIC_MS)
      timer.unref?.()
      periodicTimers.set(userId, timer)
    }
  },

  async tryAutoUnlock(
    userId: string,
    prefetchedEnc?: Awaited<ReturnType<typeof syncApi.getEncryptionState>> | null
  ): Promise<boolean> {
    try {
      // Reuse the encryption state the caller already fetched (ensureActivated)
      // instead of round-tripping again.
      const enc = prefetchedEnc ?? (await syncApi.getEncryptionState(userId))
      if (!enc.initialized) {
        broadcast({ type: 'needs-setup' })
        return false
      }
      const version = enc.active_umk_version
      const env = await findDeviceEnvelope(userId, version)
      if (!env) {
        broadcast({ type: 'needs-unlock' })
        return false
      }
      const device = await ensureDeviceKey(userId)
      const umk = await openDeviceEnvelope(env, device.publicKey, device.privateKey)
      vault.setUmk(userId, umk, version)
      syncRepo.patchState(userId, { activeUmkVersion: version })
      void runCycleNow(userId)
      return true
    } catch (err) {
      logger.warn('auto-unlock failed', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      })
      broadcast({ type: 'needs-unlock' })
      return false
    }
  },

  async initEncryption(userId: string): Promise<SyncInitResult> {
    if (!isCinnaProfile(userId)) {
      throw new CinnaApiError('not_cinna_user', 'Sync requires a Cinna-linked profile')
    }
    const existing = syncRepo.getState(userId)
    if (existing && existing.activeUmkVersion > 0) {
      throw new SyncError('already_initialized', 'Sync is already initialized for this profile')
    }
    const umk = await generateUmk()
    const version = 1
    const device = await ensureDeviceKey(userId)
    const recovery = await generateRecoveryKey()
    const myPub = await deviceKeyCodec.to(device.publicKey)

    // The device envelope's device_id is null at init — the server binds it to
    // the device it registers from `device` in the same request.
    const envelopes: KeyEnvelopeWire[] = [
      await buildDeviceEnvelope(umk, device.publicKey, version, null),
      await buildRecoveryEnvelope(umk, recovery.kek, version)
    ]

    const res = await syncApi.initEncryption(userId, {
      device: { public_key: myPub, device_label: deviceName() },
      envelopes
    })

    // CRITICAL: the server is now initialized and holds the only copies of the
    // wrapped UMK. Secure the in-memory UMK + mark initialized BEFORE any
    // fallible post-step, so a later hiccup can never strand the account in an
    // "initialized but this device never kept the key / never showed recovery"
    // state (which would be unrecoverable).
    vault.setUmk(userId, umk, version)
    syncRepo.patchState(userId, {
      activeUmkVersion: res.active_umk_version || version,
      e2eInitializedAt: Date.now()
    })

    // Best-effort: record the server-assigned device UUID (matches our public
    // key) so future device-envelope lookups + the trusted-devices UI resolve
    // "this device". Never fatal — a device envelope also carries our pubkey.
    try {
      const myDevice =
        res.devices?.find((d) => d.public_key === myPub) ?? res.devices?.[0]
      if (myDevice?.id) syncRepo.patchState(userId, { deviceId: myDevice.id })
    } catch (err) {
      logger.warn('init: capturing device id failed (non-fatal)', { error: String(err) })
    }

    const recoveryQrDataUrl = await QRCode.toDataURL(recovery.mnemonic, { margin: 1, width: 320 })

    // First device: push whatever already exists locally.
    void runCycleNow(userId)
    void pushState(userId)

    return { recoveryMnemonic: recovery.mnemonic, recoveryQrDataUrl }
  },

  async unlock(userId: string, req: SyncUnlockRequest): Promise<void> {
    if (!isCinnaProfile(userId)) {
      throw new CinnaApiError('not_cinna_user', 'Sync requires a Cinna-linked profile')
    }
    pausedUserIds.delete(userId) // resume
    const enc = await syncApi.getEncryptionState(userId)
    const version = enc.active_umk_version
    const keys = await syncApi.listKeys(userId, version)
    let umk: Uint8Array

    if (req.method === 'device') {
      const env = await findDeviceEnvelope(userId, version)
      if (!env) throw new SyncError('no_device_key', 'This device is not trusted yet')
      const device = await ensureDeviceKey(userId)
      umk = await openDeviceEnvelope(env, device.publicKey, device.privateKey)
    } else if (req.method === 'recovery') {
      if (!req.recoveryMnemonic) throw new SyncError('bad_request', 'Recovery phrase required')
      const env = keys.find((e) => e.wrap_method === 'recovery')
      if (!env) throw new SyncError('no_recovery_key', 'No recovery key registered')
      const kek = await mnemonicToKek(req.recoveryMnemonic)
      umk = await openRecoveryEnvelope(env, kek)
    } else {
      if (!req.passphrase) throw new SyncError('bad_request', 'Passphrase required')
      const env = keys.find((e) => e.wrap_method === 'passphrase')
      if (!env) throw new SyncError('no_passphrase', 'No passphrase registered')
      umk = await openPassphraseEnvelope(env, req.passphrase)
    }

    vault.setUmk(userId, umk, version)
    syncRepo.patchState(userId, { activeUmkVersion: version })
    logger.info('sync.resumed', { userId, method: req.method })

    // A non-device unlock on a new device → register a device envelope so the
    // next launch unlocks silently.
    if (req.method !== 'device') {
      await registerDeviceEnvelope(userId, umk, version).catch((err) =>
        logger.warn('register device envelope failed', { error: String(err) })
      )
    }
    void runCycleNow(userId)
    await pushState(userId)
  },

  /** Add a passphrase unlock method to an already-unlocked profile. */
  async addPassphrase(userId: string, passphrase: string): Promise<void> {
    const entry = vault.getUmk(userId)
    if (!entry) throw new SyncError('locked', 'Unlock sync first')
    const { kek, salt } = await deriveKekFromPassphrase(passphrase)
    const env = await buildPassphraseEnvelope(entry.umk, kek, salt, entry.version)
    await syncApi.addKey(userId, env)
    await pushState(userId)
  },

  /** Pause sync: zero the in-memory UMK and flag the profile so auto-unlock
   *  doesn't immediately resume it. Resumed by any `unlock` (incl. device). */
  async lock(userId: string): Promise<void> {
    pausedUserIds.add(userId)
    await vault.lock(userId)
    logger.info('sync.paused', { userId })
    broadcast({ type: 'needs-unlock' })
    await pushState(userId)
  },

  async syncNow(userId: string): Promise<void> {
    await this.ensureActivated(userId)
    await runCycleNow(userId)
  },

  /** Debounced kick after local mutations. */
  markDirty(userId: string): void {
    if (!isCinnaProfile(userId)) return
    if (!vault.isUnlocked(userId)) return
    const existing = debounceTimers.get(userId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      debounceTimers.delete(userId)
      void runCycleNow(userId)
    }, DEBOUNCE_MS)
    timer.unref?.()
    debounceTimers.set(userId, timer)
  },

  // ---- pairing ----

  async startPairing(userId: string): Promise<PairingOffer> {
    const ephemeral = await createPairingEphemeral()
    const newDevicePubkey = await encodePairingPublicKey(ephemeral.publicKey)
    const sas = await computeSas(ephemeral.publicKey)
    // Register the relay row server-side; the server mints the pairing code.
    const res = await syncApi.pairingStart(userId, {
      new_device_pubkey: newDevicePubkey,
      device_label: deviceName()
    })
    const code = res.pairing_code
    pairingEphemerals.set(code, ephemeral)
    const qrDataUrl = await QRCode.toDataURL(code, { margin: 1, width: 320 })
    return { code, qrDataUrl, sas }
  },

  /** Joiner polls the relay; returns true once the UMK has been received. */
  async pollPairing(userId: string, code: string): Promise<boolean> {
    const ephemeral = pairingEphemerals.get(code)
    if (!ephemeral) throw new SyncError('bad_request', 'No active pairing for this code')
    pausedUserIds.delete(userId) // pairing resumes sync
    const res = await syncApi.pairingGet(userId, code)
    if (!res || res.status !== 'completed' || !res.sealed_umk) return false
    const sealed = await deviceKeyCodec.from(res.sealed_umk)
    const umk = await openSealedUmk(sealed, ephemeral)
    // The relay doesn't carry the UMK version; read it from the encryption state.
    const enc = await syncApi.getEncryptionState(userId)
    const version = enc.active_umk_version || 1
    vault.setUmk(userId, umk, version)
    syncRepo.patchState(userId, { activeUmkVersion: version })
    pairingEphemerals.delete(code)
    await registerDeviceEnvelope(userId, umk, version).catch((err) =>
      logger.warn('register device envelope after pairing failed', { error: String(err) })
    )
    void runCycleNow(userId)
    await pushState(userId)
    return true
  },

  /**
   * Pairing step 1 (sealer): fetch the joiner's public key from the relay and
   * compute the SAS to show the user. The UMK is NOT sealed here — the joiner
   * key is stashed until `confirmScan`. This is what makes the SAS binding: the
   * user compares the verification numbers on both devices FIRST, so a
   * server-substituted key (which yields a mismatching SAS) is caught before
   * the secret leaves this device.
   */
  async prepareScan(userId: string, code: string): Promise<{ sas: string }> {
    const entry = vault.getUmk(userId)
    if (!entry) throw new SyncError('locked', 'Unlock sync on this device first')
    // Fetch the joiner's public key from the relay (the code identifies it).
    const relay = await syncApi.pairingGet(userId, code)
    if (!relay) throw new SyncError('bad_request', 'Pairing request not found or expired')
    const joinerPub = await decodePairingPublicKey(relay.new_device_pubkey)
    const sas = await computeSas(joinerPub)
    pendingSeals.set(code, joinerPub)
    return { sas }
  },

  /**
   * Pairing step 2 (sealer): the user confirmed the SAS matches on both
   * devices, so seal the UMK to the stashed joiner key and relay it. Only now
   * does the secret leave this device.
   */
  async confirmScan(userId: string, code: string): Promise<void> {
    const entry = vault.getUmk(userId)
    if (!entry) throw new SyncError('locked', 'Unlock sync on this device first')
    const joinerPub = pendingSeals.get(code)
    if (!joinerPub) {
      throw new SyncError('bad_request', 'No pairing awaiting confirmation — re-enter the code')
    }
    const sealed = await sealUmkForJoiner(entry.umk, joinerPub)
    await syncApi.pairingComplete(userId, code, await deviceKeyCodec.to(sealed))
    pendingSeals.delete(code)
  },

  /**
   * Discard a scan prepared but never confirmed (the user hit Cancel, or closed
   * the pane). Drops the stashed joiner key so it doesn't linger in main-process
   * memory until the next profile switch. No-op if nothing was pending.
   */
  cancelScan(_userId: string, code: string): void {
    pendingSeals.delete(code)
  },

  // ---- devices ----

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    await syncApi.revokeDevice(userId, deviceId)
    await pushState(userId)
  },

  // ---- destructive ----

  /**
   * "Delete synced data" (Settings → Danger zone): delete this account's data
   * from the server AND fully turn sync OFF on this device.
   *
   * The old behaviour only tombstoned the server records, leaving this device
   * enrolled and unlocked — so the very next cycle re-pushed every local row and
   * the deletion silently undid itself. A full reset returns the whole account
   * to the un-initialized "first device" state:
   *  1. Tombstone server records (peers observe the deletion on their next pull).
   *  2. Reset E2E server-side (`resetEncryption`): delete all key envelopes +
   *     devices and set `active_umk_version` back to 0, so `get_encryption_state`
   *     reports `initialized = false` again and `init` is allowed.
   *  3. Lock the in-memory UMK and drop the local device key + sync_state, so
   *     `runCycleNow` early-returns (no UMK → no push) and the UI shows **Enable**
   *     (a fresh first-device setup, new UMK + recovery key).
   *
   * Local app data (chats/notes/jobs) is intentionally kept.
   *
   * The E2E reset is the REQUIRED step and is done first: it's what returns the
   * account to the un-initialized "Enable" state. If it fails (offline / backend
   * error) we throw so the UI surfaces it, and we DON'T tear down locally —
   * otherwise the device would drop into a half-reset state that just re-locks
   * on the next server reconcile (the exact "stuck on Resume" trap). Tombstoning
   * records is best-effort (they're orphaned under the dead key generation
   * anyway).
   */
  async wipe(userId: string): Promise<void> {
    if (!isCinnaProfile(userId)) return

    // Un-initialize E2E for the account FIRST: delete every device + envelope and
    // set active_umk_version=0. Log + re-throw on failure so it's traceable in
    // the logger UI AND surfaced to the renderer — a failed reset must not
    // masquerade as success and loop back to "Paused".
    try {
      await syncApi.resetEncryption(userId)
    } catch (err) {
      logger.error('delete-synced-data: E2E reset failed', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }

    // Records are now under a dead key generation — tombstone them (best-effort;
    // peers observe the deletion on their next pull).
    await syncApi.wipe(userId).catch((err) =>
      logger.warn('delete-synced-data: server record wipe failed (continuing)', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      })
    )

    // Stop this profile's timers so neither a pending debounce nor the periodic
    // tick fires a cycle against the UMK we're about to zero. Then drop local
    // enrollment so the device is a clean first-device → UI shows **Enable**.
    const debounce = debounceTimers.get(userId)
    if (debounce) {
      clearTimeout(debounce)
      debounceTimers.delete(userId)
    }
    const periodic = periodicTimers.get(userId)
    if (periodic) {
      clearInterval(periodic)
      periodicTimers.delete(userId)
    }

    await forgetLocalEnrollment(userId)

    await pushState(userId)
  },

  /**
   * Sign-out hook (called by `authService.deleteAccount` for Cinna profiles
   * BEFORE the session is deactivated, while the UMK is still in memory).
   *
   * - Flushes one final sync cycle so edits made just before sign-out (still
   *   inside the debounce window) reach the server before we wipe them locally.
   * - Resets the local cursor + clears tombstones so (a) the upcoming local data
   *   wipe is a *raw* delete that never propagates as a tombstone (which would
   *   delete the user's data server-side), and (b) the next login re-pulls every
   *   collection from scratch.
   * - When `removeDevice` (the default), revokes this device server-side and
   *   drops the local device keypair + state so the next login can no longer
   *   silently auto-unlock — it must restore via recovery key or pairing.
   */
  async signOutCleanup(userId: string, opts: { removeDevice: boolean }): Promise<void> {
    if (!isCinnaProfile(userId)) return
    if (vault.isUnlocked(userId)) {
      try {
        await runCycleNow(userId)
      } catch (err) {
        logger.warn('sign-out: final sync flush failed (continuing)', {
          userId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    // Reset cursor + clear tombstones regardless of the device choice.
    syncRepo.wipe(userId)
    // Drop the cached crypto identity — a later rebind of this profile id to a
    // different account would otherwise reuse the old `sub`.
    subjectIds.delete(userId)
    if (opts.removeDevice) {
      const deviceId = syncRepo.getState(userId)?.deviceId
      if (deviceId) {
        await syncApi.revokeDevice(userId, deviceId).catch((err) =>
          logger.warn('sign-out: server device revoke failed (continuing)', {
            userId,
            error: err instanceof Error ? err.message : String(err)
          })
        )
      }
      syncRepo.deleteDeviceKey(userId)
      syncRepo.deleteState(userId)
    }
  },

  // ---- lifecycle ----

  /** Called on profile switch / logout: zero all UMKs and clear timers. */
  async onProfileSwitch(): Promise<void> {
    await vault.lockAll()
    for (const t of debounceTimers.values()) clearTimeout(t)
    for (const t of periodicTimers.values()) clearInterval(t)
    debounceTimers.clear()
    periodicTimers.clear()
    pairingEphemerals.clear()
    pendingSeals.clear()
    pausedUserIds.clear()
    subjectIds.clear()
  }
}
