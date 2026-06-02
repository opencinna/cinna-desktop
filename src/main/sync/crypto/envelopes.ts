import { getSodium } from './sodium'
import { sealTo, sealOpen } from './deviceKey'
import type { UnlockMethod } from '../../../shared/sync'

/**
 * UMK wrap/unwrap envelopes. Each method produces an opaque blob uploaded to
 * the server (`POST /keys`); the server is zero-knowledge and never sees the
 * plaintext UMK. See plan §4.
 *
 *  - device     → sealed box to the device's X25519 public key.
 *  - recovery   → secretbox under HKDF(recovery mnemonic entropy).
 *  - passphrase → secretbox under Argon2id(passphrase, salt).
 */

/**
 * Server-bound representation of one wrapped-UMK envelope. Matches cinna-core's
 * `KeyEnvelopeInput` (POST) / `AppSyncKeyEnvelopePublic` (GET) exactly: a single
 * opaque `wrapped_key` plus a freeform `kdf_params` JSON object for the
 * per-method extras (nonce / salt / device public key) the server stores
 * verbatim and the client needs back to unwrap.
 */
export interface KeyEnvelopeWire {
  /** Server-assigned envelope id (present on GET). */
  id?: string
  wrap_method: UnlockMethod
  umk_version: number
  /** base64 wrapped UMK (sealed box for device; secretbox ciphertext otherwise). */
  wrapped_key: string
  /** KDF tag: 'hkdf' (recovery) / 'argon2id' (passphrase) / null (device). */
  kdf?: string | null
  /** Per-method extras the server round-trips verbatim. */
  kdf_params?: KdfParams | null
  /** FK to the registered device (device wraps); null for recovery/passphrase. */
  device_id?: string | null
  created_at?: string
}

/** Freeform per-method unwrap material carried in `kdf_params`. */
export interface KdfParams {
  /** secretbox methods: base64 nonce. */
  nonce?: string
  /** passphrase: base64 Argon2id salt. */
  salt?: string
  /** device: base64 X25519 public key the UMK was sealed to (fallback match). */
  device_public_key?: string
}

function kp(env: KeyEnvelopeWire, key: keyof KdfParams): string | undefined {
  const v = env.kdf_params?.[key]
  return typeof v === 'string' ? v : undefined
}

async function b64(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium()
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
}
async function unb64(s: string): Promise<Uint8Array> {
  const sodium = await getSodium()
  return sodium.from_base64(s, sodium.base64_variants.ORIGINAL)
}

// ---- secretbox (recovery / passphrase) ----

async function wrapWithKek(umk: Uint8Array, kek: Uint8Array): Promise<{ wrapped: string; nonce: string }> {
  const sodium = await getSodium()
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const ct = sodium.crypto_secretbox_easy(umk, nonce, kek)
  return { wrapped: await b64(ct), nonce: await b64(nonce) }
}

async function unwrapWithKek(wrapped: string, nonce: string, kek: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium()
  return sodium.crypto_secretbox_open_easy(await unb64(wrapped), await unb64(nonce), kek)
}

// ---- device (sealed box) ----

export async function buildDeviceEnvelope(
  umk: Uint8Array,
  devicePublicKey: Uint8Array,
  umkVersion: number,
  deviceId: string | null
): Promise<KeyEnvelopeWire> {
  const sealed = await sealTo(umk, devicePublicKey)
  return {
    wrap_method: 'device',
    umk_version: umkVersion,
    wrapped_key: await b64(sealed),
    kdf: null,
    kdf_params: { device_public_key: await b64(devicePublicKey) },
    // null at init (server binds it to the device registered in the same call);
    // the server device UUID otherwise.
    device_id: deviceId
  }
}

export async function openDeviceEnvelope(
  env: KeyEnvelopeWire,
  publicKey: Uint8Array,
  privateKey: Uint8Array
): Promise<Uint8Array> {
  const sealed = await unb64(env.wrapped_key)
  return sealOpen(sealed, publicKey, privateKey)
}

// ---- recovery ----

export async function buildRecoveryEnvelope(
  umk: Uint8Array,
  kek: Uint8Array,
  umkVersion: number
): Promise<KeyEnvelopeWire> {
  const { wrapped, nonce } = await wrapWithKek(umk, kek)
  return {
    wrap_method: 'recovery',
    umk_version: umkVersion,
    wrapped_key: wrapped,
    kdf: 'hkdf',
    kdf_params: { nonce }
  }
}

export async function openRecoveryEnvelope(env: KeyEnvelopeWire, kek: Uint8Array): Promise<Uint8Array> {
  const nonce = kp(env, 'nonce')
  if (!nonce) throw new Error('recovery envelope missing nonce')
  return unwrapWithKek(env.wrapped_key, nonce, kek)
}

// ---- passphrase (Argon2id) ----

export async function deriveKekFromPassphrase(
  passphrase: string,
  saltB64?: string
): Promise<{ kek: Uint8Array; salt: string }> {
  const sodium = await getSodium()
  const salt = saltB64 ? await unb64(saltB64) : sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
  const kek = sodium.crypto_pwhash(
    32,
    passphrase,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )
  return { kek, salt: await b64(salt) }
}

export async function buildPassphraseEnvelope(
  umk: Uint8Array,
  kek: Uint8Array,
  salt: string,
  umkVersion: number
): Promise<KeyEnvelopeWire> {
  const { wrapped, nonce } = await wrapWithKek(umk, kek)
  return {
    wrap_method: 'passphrase',
    umk_version: umkVersion,
    wrapped_key: wrapped,
    kdf: 'argon2id',
    kdf_params: { nonce, salt }
  }
}

export async function openPassphraseEnvelope(env: KeyEnvelopeWire, passphrase: string): Promise<Uint8Array> {
  const salt = kp(env, 'salt')
  const nonce = kp(env, 'nonce')
  if (!salt || !nonce) throw new Error('passphrase envelope missing salt/nonce')
  const { kek } = await deriveKekFromPassphrase(passphrase, salt)
  return unwrapWithKek(env.wrapped_key, nonce, kek)
}
