import { getSodium } from './sodium'
import { generateDeviceKeypair, sealTo, sealOpen } from './deviceKey'

/**
 * Device pairing crypto (commit-then-reveal hardened). The *joining* device
 * generates an ephemeral X25519 keypair and publishes its public key (as a code
 * / QR). An already-unlocked device seals the UMK to that public key and relays
 * the blob through the server; the joiner opens it with the ephemeral private
 * key.
 *
 * The Short Authentication String (SAS) is a deterministic short digest of the
 * full handshake transcript `pubkey_J ‖ nonce_J ‖ nonce_S` — NOT just the
 * pubkey. Both devices compute it independently and the user transcribes it
 * from the joiner to the sealer. Binding both parties' nonces, with the joiner
 * committing `nonce_J` first (`commitment = H(pubkey_J ‖ nonce_J)`) and the
 * sealer revealing `nonce_S` before `nonce_J` is opened, leaves a malicious
 * relay no grindable handle: SAS-substitution collapses to a blind 1-in-10⁶
 * guess. See `plans/pairing-hardening.md`.
 *
 * Crypto must stay BYTE-IDENTICAL to the mobile client (`@noble` blake2b) for a
 * shared test vector — same concatenation order, same hash, same fold.
 *
 * The relay transport (HTTP) lives in cinnaApiService/syncService; this module
 * is pure crypto.
 */

/** Concatenate raw byte arrays in order (the SAS/commitment transcript). */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export interface PairingEphemeral {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export async function createPairingEphemeral(): Promise<PairingEphemeral> {
  return generateDeviceKeypair()
}

/** base64url of the ephemeral public key — the value placed in the code/QR. */
export async function encodePairingPublicKey(publicKey: Uint8Array): Promise<string> {
  const sodium = await getSodium()
  return sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING)
}

export async function decodePairingPublicKey(code: string): Promise<Uint8Array> {
  const sodium = await getSodium()
  return sodium.from_base64(code, sodium.base64_variants.URLSAFE_NO_PADDING)
}

/** 16-byte CSPRNG nonce (joiner `nonce_J` / sealer `nonce_S`). */
export async function randomNonce(): Promise<Uint8Array> {
  const sodium = await getSodium()
  return sodium.randombytes_buf(16)
}

/**
 * Joiner's key commitment `H(pubkey_J ‖ nonce_J)` as standard padded base64.
 * Sent at `start`; the sealer verifies it (the relay only forwards it opaquely)
 * once the joiner reveals `nonce_J`, binding the joiner's pubkey+nonce.
 */
export async function pairingCommitment(
  publicKey: Uint8Array,
  nonce: Uint8Array
): Promise<string> {
  const sodium = await getSodium()
  const digest = sodium.crypto_generichash(32, concatBytes(publicKey, nonce), null)
  return sodium.to_base64(digest, sodium.base64_variants.ORIGINAL)
}

/**
 * 6-digit Short Authentication String over the full transcript — the caller
 * passes `concat(pubkey_J, nonce_J, nonce_S)`. The fold (blake2b dkLen=8 → first
 * 4 bytes big-endian → mod 1e6 → `### ###`) is unchanged from the pre-hardening
 * version; only the input grew, so the digits stay byte-identical to mobile.
 */
export async function computeSas(transcript: Uint8Array): Promise<string> {
  const sodium = await getSodium()
  const digest = sodium.crypto_generichash(8, transcript, null)
  // Fold the first 4 bytes into a 6-digit decimal code.
  const n =
    ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0
  const code = (n % 1_000_000).toString().padStart(6, '0')
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

/** Build the SAS transcript `pubkey_J ‖ nonce_J ‖ nonce_S` (raw-byte order). */
export function sasTranscript(
  publicKey: Uint8Array,
  joinerNonce: Uint8Array,
  sealerNonce: Uint8Array
): Uint8Array {
  return concatBytes(publicKey, joinerNonce, sealerNonce)
}

/** Sealer side: seal the UMK to the joiner's ephemeral public key. */
export async function sealUmkForJoiner(umk: Uint8Array, joinerPublicKey: Uint8Array): Promise<Uint8Array> {
  return sealTo(umk, joinerPublicKey)
}

/** Joiner side: open the sealed UMK with the ephemeral keypair. */
export async function openSealedUmk(
  sealed: Uint8Array,
  ephemeral: PairingEphemeral
): Promise<Uint8Array> {
  return sealOpen(sealed, ephemeral.publicKey, ephemeral.privateKey)
}
