import { getSodium } from './sodium'
import { generateDeviceKeypair, sealTo, sealOpen } from './deviceKey'

/**
 * Device pairing crypto. The *joining* device generates an ephemeral X25519
 * keypair and publishes its public key (as a code / QR). An already-unlocked
 * device seals the UMK to that public key and relays the blob through the
 * server; the joiner opens it with the ephemeral private key.
 *
 * The Short Authentication String (SAS) is a deterministic short digest of the
 * ephemeral public key. Both devices compute it independently — the joiner from
 * its own key, the sealer from the key it received — and the user compares them
 * out of band. A server that substitutes its own key to read the UMK would
 * produce a mismatching SAS. See plan §10.
 *
 * The relay transport (HTTP) lives in cinnaApiService/syncService; this module
 * is pure crypto.
 */

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

/**
 * 6-digit Short Authentication String derived from the ephemeral public key.
 * Stable across both devices for the same key.
 */
export async function computeSas(ephemeralPublicKey: Uint8Array): Promise<string> {
  const sodium = await getSodium()
  const digest = sodium.crypto_generichash(8, ephemeralPublicKey, null)
  // Fold the first 4 bytes into a 6-digit decimal code.
  const n =
    ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0
  const code = (n % 1_000_000).toString().padStart(6, '0')
  return `${code.slice(0, 3)} ${code.slice(3)}`
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
