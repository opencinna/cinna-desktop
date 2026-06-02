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
    initialized: initialized || !!enc?.initialized,
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
    const result = await runSyncCycle(userId, entry.umk, entry.version)
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
    if (err instanceof CinnaApiError && err.code === 'reauth_required') {
      // Global reauth modal handles re-auth; pause quietly.
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
      let initialized = (syncRepo.getState(userId)?.activeUmkVersion ?? 0) > 0
      if (!initialized) {
        // Local state may be behind the server (e.g. init persisted server-side
        // but a desktop crash lost the local flag). Ask the server so a trusted
        // device still auto-unlocks instead of being stuck "locked".
        const enc = await syncApi.getEncryptionState(userId).catch(() => null)
        if (enc?.initialized) {
          initialized = true
          syncRepo.patchState(userId, { activeUmkVersion: enc.active_umk_version })
        }
      }
      if (initialized) await this.tryAutoUnlock(userId)
    }
    if (!periodicTimers.has(userId)) {
      const timer = setInterval(() => void runCycleNow(userId), PERIODIC_MS)
      timer.unref?.()
      periodicTimers.set(userId, timer)
    }
  },

  async tryAutoUnlock(userId: string): Promise<boolean> {
    try {
      const enc = await syncApi.getEncryptionState(userId)
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

  async lock(userId: string): Promise<void> {
    await vault.lock(userId)
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

  /** Unlocked device: seal the UMK to the joiner's code. Returns the SAS to compare. */
  async scanPairing(userId: string, code: string): Promise<{ sas: string }> {
    const entry = vault.getUmk(userId)
    if (!entry) throw new SyncError('locked', 'Unlock sync on this device first')
    // Fetch the joiner's public key from the relay (the code identifies it).
    const relay = await syncApi.pairingGet(userId, code)
    if (!relay) throw new SyncError('bad_request', 'Pairing request not found or expired')
    const joinerPub = await decodePairingPublicKey(relay.new_device_pubkey)
    const sas = await computeSas(joinerPub)
    const sealed = await sealUmkForJoiner(entry.umk, joinerPub)
    await syncApi.pairingComplete(userId, code, await deviceKeyCodec.to(sealed))
    return { sas }
  },

  // ---- devices ----

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    await syncApi.revokeDevice(userId, deviceId)
    await pushState(userId)
  },

  // ---- destructive ----

  async wipe(userId: string): Promise<void> {
    await syncApi.wipe(userId)
    syncRepo.wipe(userId)
    await pushState(userId)
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
  }
}
