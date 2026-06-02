import { getSodium } from './sodium'

/**
 * Per-install X25519 device keypair used for the silent steady-state unlock:
 * the UMK is sealed to this device's public key (`crypto_box_seal`) and the
 * envelope is stored server-side. Only this device — holding the private key in
 * `safeStorage` — can open it. See plan §4.
 *
 * This module is pure crypto over byte arrays; persistence (private key via
 * safeStorage, public key in `sync_device_key`) lives in the db repo.
 */

export interface DeviceKeypair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export async function generateDeviceKeypair(): Promise<DeviceKeypair> {
  const sodium = await getSodium()
  const kp = sodium.crypto_box_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

/** Seal a message to a recipient's X25519 public key (anonymous sender). */
export async function sealTo(message: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium()
  return sodium.crypto_box_seal(message, recipientPublicKey)
}

/** Open a sealed message using this device's keypair. */
export async function sealOpen(
  ciphertext: Uint8Array,
  publicKey: Uint8Array,
  privateKey: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium()
  return sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey)
}

const b64 = {
  async to(bytes: Uint8Array): Promise<string> {
    const sodium = await getSodium()
    return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
  },
  async from(s: string): Promise<Uint8Array> {
    const sodium = await getSodium()
    return sodium.from_base64(s, sodium.base64_variants.ORIGINAL)
  }
}

export const deviceKeyCodec = b64
