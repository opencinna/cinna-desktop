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
  sasTranscript,
  randomNonce,
  pairingCommitment,
  sealUmkForJoiner,
  openSealedUmk,
  type PairingEphemeral
} from '../sync/crypto/pairing'
import { getProfileScopeUserId } from '../auth/scope'
import type {
  SyncState,
  SyncStatus,
  SyncEvent,
  SyncInitResult,
  SyncUnlockRequest,
  UnlockMethod,
  PairingOffer,
  PairingPollResult,
  IncomingPairing
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

// ---- pairing (commit-then-reveal) runtime state ----

/** Joiner side: per-code ephemeral + committed `nonce_J`, plus the SAS/reveal
 *  progress so each poll is idempotent (reveal once, then await the UMK). */
interface JoinerPairing {
  ephemeral: PairingEphemeral
  nonceJ: Uint8Array
  /** Filled once the sealer nonce arrives and the SAS is computed. */
  sas: string | null
  /** True once `nonce_J` has been revealed to the relay (do it exactly once). */
  revealed: boolean
}
const pairingEphemerals = new Map<string, JoinerPairing>() // code -> joiner state

// Sealer side: per-inbox-id handshake state awaiting the user's transcribed
// SAS. The UMK is sealed only after `confirmVerify` matches the SAS, so a
// substituted key (mismatching SAS) is caught before the secret leaves here.
interface SealerVerification {
  joinerPub: Uint8Array
  /** Expected SAS, computed over the full transcript once the joiner reveals. */
  sas: string
}
const pendingVerifications = new Map<string, SealerVerification>() // id -> state
// Verifications the user cancelled while `beginVerify` was still polling for the
// joiner's reveal — checked between polls so the handshake bails out promptly.
const cancelledVerifications = new Set<string>() // id
// Profiles the user explicitly **paused** this session. While paused, the
// per-launch silent auto-unlock is suppressed — otherwise the very next
// `getState()` would re-unlock a trusted device and the UI would flap between
// Paused/Active. Cleared on resume (any unlock) and on profile switch. Pause is
// intentionally session-scoped: a relaunch auto-unlocks as usual.
const pausedUserIds = new Set<string>()
// In-flight reconcile+auto-unlock per profile. `ensureActivated` is invoked
// concurrently from distinct IPC channels (`sync:get-state`, `sync:sync-now`)
// and from activation — without this, each would independently round-trip
// `/encryption` + `/state` and race `setUmk`. Concurrent callers share one
// attempt; sequential calls still re-check the server.
const activationInFlight = new Map<string, Promise<void>>()
let lastStatus: SyncStatus = 'idle'

// ---- auto-discovery (P4): focus-gated inbox poll ----
//
// A single global timer: it resolves the active profile fresh on each tick (so a
// profile switch is picked up automatically) and only emits while that profile
// is a foregrounded, sync-initialized, unlocked Cinna profile. Armed on window
// focus, cleared on blur. We never auto-start the handshake — discovery only
// surfaces a prompt; the user opts in via `beginVerify`.
const INBOX_POLL_MS = 5_000
let inboxPollTimer: NodeJS.Timeout | null = null
// Pairing ids already surfaced this session — so a still-pending row isn't
// re-prompted every 5s. Cleared on profile switch.
const announcedPairings = new Set<string>()

/** Strip the SAS down to its digits for a transcription-tolerant compare
 *  ("481 902" / "481902" / "481-902" all match). */
function normalizeSas(sas: string): string {
  return sas.replace(/\D/g, '')
}

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

  // Disconnected: this device opted out. Report a clean "off" state without
  // touching the server (we're not participating) — the UI shows "Connect".
  if (local?.disconnected) {
    return {
      initialized: false,
      locked: true,
      paused: false,
      disconnected: true,
      cursor: 0,
      status: 'idle',
      usage: null,
      quota: null,
      devices: [],
      unlockMethods: [],
      lastSyncAt: null,
      error: null
    }
  }

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
    // A pause is explicit + session-scoped; any other locked state means this
    // device couldn't auto-unlock and needs to restore (pair / recovery), not
    // "Resume". `getState` runs `ensureActivated` (auto-unlock) first, so a
    // trusted device is already unlocked by the time we build this.
    paused: locked && pausedUserIds.has(userId),
    disconnected: false,
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
  if (local?.disconnected) return // opted out of online sync — stay silent
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

// ---- auto-discovery (P4): inbox polling ----

/**
 * One inbox tick for the *currently active* profile. Gated on a foregrounded,
 * sync-initialized, unlocked Cinna profile — the sealer needs the UMK in memory
 * to honour any request, and we only ever surface a prompt (never auto-seal).
 * Newly-seen `pending` rows are broadcast as `pairing-incoming`.
 */
async function pollInboxOnce(): Promise<void> {
  const userId = getProfileScopeUserId()
  if (!isCinnaProfile(userId)) return
  if (pausedUserIds.has(userId)) return
  if (!vault.isUnlocked(userId)) return // sealer must hold the UMK
  const local = syncRepo.getState(userId)
  if (!local || local.activeUmkVersion === 0) return // must be initialized
  try {
    const items = await syncApi.pairingInbox(userId)
    for (const it of items) {
      if (it.status !== 'pending') continue
      if (announcedPairings.has(it.id)) continue
      announcedPairings.add(it.id)
      const pairing: IncomingPairing = {
        id: it.id,
        deviceLabel: it.device_label,
        expiresAt: Date.parse(it.expires_at) || null
      }
      logger.info('pairing: incoming request discovered', {
        id: it.id,
        deviceLabel: it.device_label
      })
      broadcast({ type: 'pairing-incoming', pairing })
    }
  } catch (err) {
    logger.debug('inbox poll failed (transient)', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function startInboxPolling(): void {
  if (inboxPollTimer) return
  void pollInboxOnce() // surface anything already pending without waiting a tick
  const timer = setInterval(() => void pollInboxOnce(), INBOX_POLL_MS)
  timer.unref?.()
  inboxPollTimer = timer
}

function stopInboxPolling(): void {
  if (!inboxPollTimer) return
  clearInterval(inboxPollTimer)
  inboxPollTimer = null
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
    // This device opted out of online sync — do nothing (no reconcile, no
    // auto-unlock, no periodic timer). Only an explicit `reconnect` re-engages it.
    if (syncRepo.getState(userId)?.disconnected) return
    if (!vault.isUnlocked(userId)) {
      // Single-flight the reconcile + auto-unlock so concurrent callers share ONE
      // attempt instead of each re-fetching /encryption + /state and racing setUmk.
      let inFlight = activationInFlight.get(userId)
      if (!inFlight) {
        inFlight = this.reconcileEnrollment(userId).finally(() =>
          activationInFlight.delete(userId)
        )
        activationInFlight.set(userId, inFlight)
      }
      await inFlight
    }
    if (!periodicTimers.has(userId)) {
      const timer = setInterval(() => void runCycleNow(userId), PERIODIC_MS)
      timer.unref?.()
      periodicTimers.set(userId, timer)
    }
  },

  /**
   * Reconcile this device's local enrollment against `/encryption` (the init-state
   * source of truth) in BOTH directions, then silently auto-unlock a trusted
   * device. Always run via the `activationInFlight` guard in `ensureActivated`.
   */
  async reconcileEnrollment(userId: string): Promise<void> {
    // This device explicitly disconnected — stay off. Don't adopt the server's
    // init state, auto-unlock, or nag; only an explicit "Connect" reverses it.
    if (syncRepo.getState(userId)?.disconnected) return
    const enc = await syncApi.getEncryptionState(userId).catch(() => null)
    if (enc && !enc.initialized) {
      // Account was reset (here or on a peer). Drop stale local enrollment so the
      // UI offers a fresh "Enable" instead of a dead "Resume", and clear any pause
      // flag that would otherwise keep it pinned. (Runs even while paused — a
      // reset must be able to un-stick the device.)
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
  },

  async tryAutoUnlock(
    userId: string,
    prefetchedEnc?: Awaited<ReturnType<typeof syncApi.getEncryptionState>> | null
  ): Promise<boolean> {
    try {
      // Reuse the encryption state the caller already fetched (ensureActivated)
      // instead of round-tripping again.
      const enc = prefetchedEnc ?? (await syncApi.getEncryptionState(userId))
      // NOTE: on failure just return false — do NOT emit `needs-setup`/`needs-unlock`
      // or `pushState` here. `tryAutoUnlock` runs inside `ensureActivated` →
      // `getState`, whose `buildStateDto` already carries the resulting
      // locked/needs-setup state back to the query; the renderer also pulls state
      // on mount and is pushed on real transitions (lock/unlock/pair). Emitting a
      // hint event here instead made `useSyncEvents` *invalidate* the query →
      // re-`getState` → re-emit (a tight refetch loop, and — paired with a
      // transient re-lock — visible locked↔unlocked flapping).
      if (!enc.initialized) return false
      const version = enc.active_umk_version
      const env = await findDeviceEnvelope(userId, version)
      if (!env) return false
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
      return false
    }
  },

  async initEncryption(userId: string): Promise<SyncInitResult> {
    if (!isCinnaProfile(userId)) {
      throw new CinnaApiError('not_cinna_user', 'Sync requires a Cinna-linked profile')
    }
    // The server is AUTHORITATIVE on init state — check it FIRST, before any
    // local-flag guard. The local `activeUmkVersion` can be stale in either
    // direction (a reset elsewhere left it >0, or this device never enrolled so
    // the UI offered **Enable** even though the account is already set up). The
    // old code threw a raw "already initialized" on the local flag *before* this
    // reconcile, so the card never switched to the pairing view.
    const serverEnc = await syncApi.getEncryptionState(userId).catch(() => null)
    if (serverEnc?.initialized) {
      // Already set up (here or on a peer). Initializing again would mint a
      // SECOND UMK generation and orphan the peer's data. Reconcile this device
      // to a locked state, push it so the card flips to **Locked + pair/restore**,
      // and surface a guiding message instead of a dead-end error.
      logger.info('init refused — account already initialized server-side, reconciled to locked', {
        userId,
        serverVersion: serverEnc.active_umk_version
      })
      syncRepo.patchState(userId, { activeUmkVersion: serverEnc.active_umk_version })
      broadcast({ type: 'needs-unlock' })
      await pushState(userId)
      throw new SyncError(
        'already_initialized',
        'Sync is already set up on your account. Pair this device with another, or restore with your recovery key.'
      )
    }

    const existing = syncRepo.getState(userId)
    if (existing && existing.activeUmkVersion > 0) {
      if (serverEnc) {
        // Server reachable and reports NOT initialized → the account was reset
        // elsewhere and our local enrollment is stale. Drop it and proceed to a
        // clean first-device init rather than dead-ending.
        logger.info('init: clearing stale local enrollment (server not initialized)', { userId })
        await forgetLocalEnrollment(userId)
      } else {
        // Server unreachable — we can't prove the account isn't already set up,
        // so refuse rather than risk a second UMK generation.
        throw new SyncError('already_initialized', 'Sync is already initialized for this profile')
      }
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

    let res: Awaited<ReturnType<typeof syncApi.initEncryption>>
    try {
      res = await syncApi.initEncryption(userId, {
        device: { public_key: myPub, device_label: deviceName() },
        envelopes
      })
    } catch (err) {
      // Fallback for the race the pre-check can miss: `getEncryptionState` was
      // momentarily unreachable (so we offered Enable) but the account is in fact
      // already set up → the server rejects init (409). Reconcile to a locked
      // state and route to pair/restore instead of surfacing a raw error.
      const recheck = await syncApi.getEncryptionState(userId).catch(() => null)
      if (recheck?.initialized) {
        logger.info('init rejected by server — account already initialized, reconciled to locked', {
          userId,
          serverVersion: recheck.active_umk_version
        })
        syncRepo.patchState(userId, { activeUmkVersion: recheck.active_umk_version })
        broadcast({ type: 'needs-unlock' })
        await pushState(userId)
        throw new SyncError(
          'already_initialized',
          'Sync is already set up on your account. Pair this device with another, or restore with your recovery key.'
        )
      }
      throw err
    }

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

  // ---- pairing (commit-then-reveal) ----
  //
  // Joiner (the new device, keyed by the secret code):
  //   1. startPairing → gen ephemeral + nonce_J, post pubkey + commitment.
  //   2. pollPairing  → on sealer_nonce: compute SAS, reveal nonce_J; then await
  //      the sealed UMK and open it.
  // Sealer (the trusted device, keyed by the inbox row id):
  //   1. beginVerify  → read pubkey/commitment, post nonce_S, await the reveal,
  //      verify the commitment, compute the expected SAS.
  //   2. confirmVerify → match the user-transcribed SAS, then seal + relay.

  async startPairing(userId: string): Promise<PairingOffer> {
    const ephemeral = await createPairingEphemeral()
    const newDevicePubkey = await encodePairingPublicKey(ephemeral.publicKey)
    const nonceJ = await randomNonce()
    const commitment = await pairingCommitment(ephemeral.publicKey, nonceJ)
    // Register the relay row server-side; the server mints the pairing code.
    const res = await syncApi.pairingStart(userId, {
      new_device_pubkey: newDevicePubkey,
      commitment,
      device_label: deviceName()
    })
    const code = res.pairing_code
    pairingEphemerals.set(code, { ephemeral, nonceJ, sas: null, revealed: false })
    const qrDataUrl = await QRCode.toDataURL(code, { margin: 1, width: 320 })
    return { code, qrDataUrl }
  },

  /**
   * Joiner polls the relay. Once the sealer posts its nonce, computes the SAS
   * (over `pubkey ‖ nonce_J ‖ nonce_S`) and reveals `nonce_J` (exactly once),
   * surfacing the SAS for the user to transcribe to the trusted device. Returns
   * `done: true` once the sealed UMK has arrived and this device is unlocked.
   */
  async pollPairing(userId: string, code: string): Promise<PairingPollResult> {
    const state = pairingEphemerals.get(code)
    if (!state) throw new SyncError('bad_request', 'No active pairing for this code')
    pausedUserIds.delete(userId) // pairing resumes sync
    const res = await syncApi.pairingGet(userId, code)
    if (!res) return { sas: state.sas, done: false }

    // Reveal step: the sealer has posted its nonce → compute the SAS and reveal
    // our committed nonce so the sealer can verify the commitment + match SAS.
    if (!state.revealed && res.sealer_nonce) {
      const sealerNonce = await deviceKeyCodec.from(res.sealer_nonce)
      state.sas = await computeSas(
        sasTranscript(state.ephemeral.publicKey, state.nonceJ, sealerNonce)
      )
      await syncApi.pairingReveal(userId, code, await deviceKeyCodec.to(state.nonceJ))
      state.revealed = true
    }

    if (res.status !== 'completed' || !res.sealed_umk) return { sas: state.sas, done: false }

    const sealed = await deviceKeyCodec.from(res.sealed_umk)
    const umk = await openSealedUmk(sealed, state.ephemeral)
    // The relay doesn't carry the UMK version; read it from the encryption state.
    const enc = await syncApi.getEncryptionState(userId)
    const version = enc.active_umk_version || 1
    vault.setUmk(userId, umk, version)
    syncRepo.patchState(userId, { activeUmkVersion: version })
    pairingEphemerals.delete(code)
    logger.info('pairing: received sealed UMK — this device is now trusted', { userId, version })
    await registerDeviceEnvelope(userId, umk, version).catch((err) =>
      logger.warn('register device envelope after pairing failed', { error: String(err) })
    )
    void runCycleNow(userId)
    await pushState(userId)
    return { sas: state.sas, done: true }
  },

  /**
   * Sealer step 1 (trusted device): drive the handshake for one inbox row.
   * Reads the joiner's pubkey + commitment, posts a fresh `nonce_S`, then polls
   * for the joiner's revealed `nonce_J`. Verifies `commitment == H(pubkey ‖
   * nonce_J)` (a clean auto-detected tamper signal — aborts before any SAS is
   * accepted) and computes the expected SAS, stashing it + the joiner key for
   * `confirmVerify`. The UMK is NOT sealed here.
   */
  async beginVerify(userId: string, id: string): Promise<void> {
    const entry = vault.getUmk(userId)
    if (!entry) throw new SyncError('locked', 'Unlock sync on this device first')
    cancelledVerifications.delete(id)

    const detail = await syncApi.pairingInboxGet(userId, id)
    if (!detail) throw new SyncError('bad_request', 'Pairing request not found or expired')
    const joinerPub = await decodePairingPublicKey(detail.new_device_pubkey)

    // Post our nonce while still `pending`; if the row is already past it (a
    // retried verify on the same row), reuse the nonce the relay still holds.
    let sealerNonce: Uint8Array
    if (detail.status === 'pending') {
      sealerNonce = await randomNonce()
      await syncApi.pairingSetSealerNonce(userId, id, await deviceKeyCodec.to(sealerNonce))
    } else if (detail.sealer_nonce) {
      sealerNonce = await deviceKeyCodec.from(detail.sealer_nonce)
    } else {
      throw new SyncError('bad_request', 'Pairing request is in an unexpected state')
    }

    // Poll for the joiner's reveal. The joiner reveals right after seeing our
    // nonce, so this resolves within a poll or two; bail out on cancel/expiry.
    const deadline = Date.now() + 60_000
    let joinerNonceB64: string | null = detail.joiner_nonce ?? null
    while (!joinerNonceB64) {
      if (cancelledVerifications.has(id)) {
        cancelledVerifications.delete(id)
        throw new SyncError('cancelled', 'Verification cancelled')
      }
      if (Date.now() > deadline) {
        throw new SyncError('timeout', 'Timed out waiting for the new device — try again')
      }
      await new Promise((r) => setTimeout(r, 1_500))
      const next = await syncApi.pairingInboxGet(userId, id)
      if (next?.joiner_nonce) joinerNonceB64 = next.joiner_nonce
      else if (next && next.status !== 'sealer_nonce_set' && next.status !== 'pending') {
        // Moved to a state that can't yield a reveal (expired/consumed/…).
        throw new SyncError('bad_request', 'Pairing request expired before it could complete')
      }
    }

    const joinerNonce = await deviceKeyCodec.from(joinerNonceB64)
    const expectedCommitment = await pairingCommitment(joinerPub, joinerNonce)
    if (expectedCommitment !== detail.commitment) {
      // Tamper: the pubkey/nonce don't match the joiner's earlier commitment.
      // Abort BEFORE any SAS is accepted — the user never has to adjudicate it.
      pendingVerifications.delete(id)
      logger.warn('pairing: commitment mismatch — aborting verify', { id })
      throw new SyncError('tampered', 'Verification failed — the request may have been tampered with')
    }
    const sas = await computeSas(sasTranscript(joinerPub, joinerNonce, sealerNonce))
    pendingVerifications.set(id, { joinerPub, sas })
  },

  /**
   * Sealer step 2 (trusted device): the user transcribed the SAS shown on the
   * new device. Compare it against the computed SAS — only on a match seal the
   * UMK to the joiner key and relay it. Mismatch → no seal (throws).
   */
  async confirmVerify(userId: string, id: string, enteredSas: string): Promise<void> {
    const entry = vault.getUmk(userId)
    if (!entry) throw new SyncError('locked', 'Unlock sync on this device first')
    const pending = pendingVerifications.get(id)
    if (!pending) {
      throw new SyncError('bad_request', 'No pairing awaiting confirmation — start verification again')
    }
    if (normalizeSas(enteredSas) !== normalizeSas(pending.sas)) {
      throw new SyncError('sas_mismatch', "The codes don't match — check the new device and re-enter")
    }
    const sealed = await sealUmkForJoiner(entry.umk, pending.joinerPub)
    await syncApi.pairingCompleteById(userId, id, await deviceKeyCodec.to(sealed))
    pendingVerifications.delete(id)
    announcedPairings.add(id) // don't re-prompt a request we just completed
    // Audit: the UMK was just sealed to a newly-authorized device — the single
    // most security-relevant operation in the sync flow.
    logger.info('pairing: sealed UMK to newly-authorized device', { id })
  },

  /**
   * Discard a verification begun but never confirmed (the user hit Cancel, or
   * closed the pane). Signals an in-flight `beginVerify` poll to bail and drops
   * the stashed joiner key. No-op if nothing is pending.
   */
  cancelVerify(_userId: string, id: string): void {
    cancelledVerifications.add(id)
    pendingVerifications.delete(id)
  },

  /** List the active profile's pending inbox requests (manual refresh; the
   *  focus-gated poll surfaces them live via `pairing-incoming` events). */
  async pairingInbox(userId: string): Promise<IncomingPairing[]> {
    if (!vault.isUnlocked(userId)) return []
    const items = await syncApi.pairingInbox(userId).catch(() => [])
    return items
      .filter((it) => it.status === 'pending')
      .map((it) => ({
        id: it.id,
        deviceLabel: it.device_label,
        expiresAt: Date.parse(it.expires_at) || null
      }))
  },

  /**
   * P4 hook: the renderer window gained or lost focus. Arms the inbox poll only
   * while focused so a trusted, foregrounded device auto-discovers incoming
   * pairing requests; stops it on blur.
   */
  setWindowFocused(focused: boolean): void {
    if (focused) startInboxPolling()
    else stopInboxPolling()
  },

  // ---- devices ----

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    await syncApi.revokeDevice(userId, deviceId)
    await pushState(userId)
  },

  // ---- disconnect / reconnect ----

  /**
   * "Disconnect online sync" (Settings) — opt **this device only** out of online
   * sync, like deleting a git remote: stop syncing here, keep every local note/
   * job, and leave the account + all OTHER devices fully intact.
   *
   *  1. Revoke THIS device server-side (`revokeDevice`): deletes only its device
   *     envelope + marks its row revoked, so it drops off the account's
   *     authorized-devices list. The account stays initialized; peers keep their
   *     envelopes and their sync cycle is untouched.
   *  2. Tear down local enrollment (zero UMK, drop the device keypair + tombstone
   *     queue) and set the persistent `disconnected` flag — so the device stays
   *     OFF across relaunches (no auto-reconcile / auto-unlock / restore prompt)
   *     and the card shows a calm "Connect" affordance instead of "Locked".
   *
   * It deliberately does **NOT** call `resetEncryption` (that un-initializes the
   * whole account and would drop every peer to "Enable") or the record-wipe
   * (`DELETE /`, which tombstones records and hard-deletes local data on peers).
   * No data — local or another device's — is touched.
   *
   * The server-side revoke is best-effort: if it fails (offline) the device still
   * disconnects locally (key dropped, flag set, so it can't sync), and its stale
   * server row can be revoked later from any other device.
   */
  async disconnect(userId: string): Promise<{ deviceRemoved: boolean }> {
    if (!isCinnaProfile(userId)) return { deviceRemoved: true }

    // Stop timers first so neither a pending debounce nor the periodic tick fires
    // a cycle against the UMK we're about to zero.
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

    // Remove THIS device from the account's authorized list. Only this device's
    // envelope/row is affected — peers are untouched. Best-effort: offline, the
    // device still disconnects locally; we report `deviceRemoved: false` so the
    // UI can tell the user the server-side removal didn't happen (there's no
    // sync cycle while disconnected to retry it — revoke it from another device).
    let deviceRemoved = true
    const deviceId = syncRepo.getState(userId)?.deviceId
    if (deviceId) {
      try {
        await syncApi.revokeDevice(userId, deviceId)
      } catch (err) {
        deviceRemoved = false
        logger.warn('disconnect: server device revoke failed (disconnected locally)', {
          userId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    // Local teardown — but KEEP the sync_state row so the `disconnected` flag
    // persists. Zero the UMK, drop the keypair + tombstone queue, and flag off.
    await vault.lock(userId)
    syncRepo.deleteDeviceKey(userId)
    syncRepo.deleteTombstones(userId)
    syncRepo.patchState(userId, {
      activeUmkVersion: 0,
      deviceId: null,
      cursor: 0,
      lastPushedAt: null,
      lastPulledAt: null,
      disconnected: true
    })
    subjectIds.delete(userId)
    pausedUserIds.delete(userId)
    logger.info('sync: disconnected this device from online sync', {
      userId,
      deviceId,
      deviceRemoved
    })

    await pushState(userId)
    return { deviceRemoved }
  },

  /**
   * "Connect" — undo a prior `disconnect` on this device. Clears the persistent
   * flag and re-runs activation: if the account is still initialized server-side
   * the device lands on **Locked → pair/restore** (it must re-enroll a fresh
   * device key); if the account is no longer initialized it lands on **Enable**.
   */
  async reconnect(userId: string): Promise<void> {
    if (!isCinnaProfile(userId)) return
    // Discard any hard-delete tombstones queued WHILE this device was
    // disconnected. A rejoin re-pulls the server's authoritative state, so those
    // local deletes must NOT replay onto peers (that would surprise-delete their
    // data); the server's copies re-materialize locally on the bootstrap pull.
    // Edits still reconcile via the normal dirty-row LWW push on re-enrollment.
    syncRepo.deleteTombstones(userId)
    syncRepo.patchState(userId, { disconnected: false })
    logger.info('sync: reconnecting this device to online sync', { userId })
    await this.ensureActivated(userId)
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
    pendingVerifications.clear()
    cancelledVerifications.clear()
    // Reset discovery state for the new profile's inbox; the focus-gated timer
    // (if armed) keeps running and re-resolves the active profile each tick.
    announcedPairings.clear()
    pausedUserIds.clear()
    subjectIds.clear()
  }
}
