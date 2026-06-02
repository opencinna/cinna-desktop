import _sodium from 'libsodium-wrappers-sumo'

/**
 * Single libsodium loader. We use the **sumo** build because the curated
 * `libsodium-wrappers` default build omits primitives this stack relies on —
 * `crypto_auth_hmacsha256` (HKDF + content fingerprint) and `crypto_pwhash`
 * (Argon2id passphrase KEK). The sumo build is a strict API superset, so every
 * other primitive (XChaCha20-Poly1305, sealed boxes, secretbox, generichash,
 * randombytes) behaves identically.
 *
 * `libsodium-wrappers-sumo` needs an async `ready` await before any primitive
 * is usable; every crypto module funnels through here so the WASM is
 * initialized exactly once.
 */
let readyPromise: Promise<typeof _sodium> | null = null

export async function getSodium(): Promise<typeof _sodium> {
  if (!readyPromise) {
    readyPromise = _sodium.ready.then(() => _sodium)
  }
  return readyPromise
}

export type Sodium = typeof _sodium
