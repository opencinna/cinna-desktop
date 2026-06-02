# Data Sync Crypto — LLM Reference

Project-specific crypto conventions for the sync feature. Library = `libsodium-wrappers-sumo` (WASM, async `ready`) — the **sumo** build is mandatory because the curated default build omits `crypto_auth_hmacsha256` (HKDF + fingerprint) and `crypto_pwhash` (Argon2id passphrase KEK). Assumes general crypto knowledge; only project deviations documented.

## Key hierarchy
- **UMK**: 32 random bytes (`generateUmk`). One per profile, versioned (`active_umk_version`, starts at 1).
- **Payload subkey**: `HKDF-SHA256(UMK, info="payload:<collection>")`, 32 bytes, derived per encrypt/decrypt, zeroed after.
- **Fingerprint key**: `HKDF-SHA256(UMK, info="fp")`, separate branch.
- HKDF is hand-rolled on `crypto_auth_hmacsha256` in `crypto/umk.ts` (no native HKDF used).

## Payload encryption (`crypto/umk.ts`)
- Cipher: `crypto_aead_xchacha20poly1305_ietf`, 24-byte random nonce per write.
- Plaintext bytes = `canonicalBytes(obj)` (NOT `JSON.stringify`).
- AAD = UTF-8 of `` `${userId} ${collection} ${clientEntityId} ${umkVersion}` `` (space-separated).
- Wire envelope (then base64'd whole): `{ v:1, alg:"xchacha20poly1305", umk:<version>, n:<b64 nonce>, ct:<b64 ciphertext> }`.
- `decryptPayload` reads `umk` version from the envelope for the AAD (mixed versions can coexist mid-rotation).

## Canonical JSON (`crypto/canonicalJson.ts`)
- MUST be used by both encrypt and fingerprint — never `JSON.stringify` for synced payloads.
- Rules: object keys sorted (JS default UTF-16 order), arrays preserve order, `undefined` object values dropped, `undefined` array elements → `null`, non-finite numbers throw, no whitespace.

## Content fingerprint
- `HMAC-SHA256(fpKey, canonicalBytes(plaintext))`, base64. Nonce-independent → re-encrypt of unchanged content → server returns `unchanged`.

## Unlock envelopes (`crypto/envelopes.ts`) → `KeyEnvelopeWire`
| method | wrap | extra fields |
|--------|------|--------------|
| `device` | `crypto_box_seal(UMK, devicePub)` | `device_public_key`, `device_id` |
| `recovery` | `crypto_secretbox(UMK, KEK_rec)` | `nonce` |
| `passphrase` | `crypto_secretbox(UMK, KEK_pw)` | `nonce`, `salt`, `kdf:"argon2id"` |
- `KEK_rec` = `HKDF(mnemonicEntropy, info="recovery")` — no Argon2id (entropy already high).
- `KEK_pw` = `crypto_pwhash` Argon2id13, OPSLIMIT/MEMLIMIT_MODERATE, 16-byte salt.

## Recovery key (`crypto/recovery.ts`)
- BIP39, 256-bit → 24 words, `@scure/bip39` english wordlist (subpath needs `crypto/scure-bip39.d.ts` shim for tsc).
- Mnemonic normalized lowercase/trim/collapse-space before validate/derive. Shown once at init.

## Pairing (`crypto/pairing.ts`)
- Joiner makes ephemeral X25519 keypair; public key → base64url code (`URLSAFE_NO_PADDING`) + QR.
- SAS: `crypto_generichash(8, ephemeralPub, null)`, fold first 4 bytes → 6-digit decimal, formatted `"NNN NNN"`. Both sides compute independently from the same key.
- Sealer: `crypto_box_seal(UMK, joinerPub)` → relayed via `POST /pairing`; joiner opens with ephemeral keypair.

## Memory rules
- Plaintext UMK only in `sync/umkVault.ts` (Map keyed by userId). `memzero` on lock/switch/logout.
- Derived subkeys/PRK `memzero`'d immediately after use.
- Device private key persisted only via `safeStorage` (`security/keystore.ts`), never raw.

## Base64 variants (libsodium)
- Envelopes/keys: `base64_variants.ORIGINAL`.
- Pairing code: `base64_variants.URLSAFE_NO_PADDING`.
