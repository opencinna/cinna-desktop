import { describe, it, expect } from 'vitest'
import { generateUmk, encryptPayload, decryptPayload, contentFingerprint, UMK_BYTES } from './umk'

/**
 * Exercises the real libsodium primitives end-to-end (HKDF over
 * `crypto_auth_hmacsha256`, XChaCha20-Poly1305 AEAD, the content fingerprint).
 * This is the regression guard for the "sumo build" fix — the curated
 * `libsodium-wrappers` build omits `crypto_auth_hmacsha256`, which broke
 * `sync:init` with "is not a function".
 */

const ctx = {
  userId: 'user-1',
  collection: 'job',
  clientEntityId: 'job-abc',
  umkVersion: 1
}

describe('umk crypto round trip', () => {
  it('generates a 32-byte UMK', async () => {
    const umk = await generateUmk()
    expect(umk).toBeInstanceOf(Uint8Array)
    expect(umk.length).toBe(UMK_BYTES)
  })

  it('encrypts then decrypts back to the original object', async () => {
    const umk = await generateUmk()
    const plaintext = { title: 'T', deps: [{ kind: 'mcp', transport: 'sse', url: 'https://h/p', name: 'n' }] }
    const envelope = await encryptPayload({ umk, plaintext, ...ctx })
    const decrypted = await decryptPayload({
      umk,
      envelopeB64: envelope,
      userId: ctx.userId,
      collection: ctx.collection,
      clientEntityId: ctx.clientEntityId
    })
    expect(decrypted).toEqual(plaintext)
  })

  it('fails to decrypt under a mismatched AAD (wrong collection)', async () => {
    const umk = await generateUmk()
    const envelope = await encryptPayload({ umk, plaintext: { a: 1 }, ...ctx })
    await expect(
      decryptPayload({
        umk,
        envelopeB64: envelope,
        userId: ctx.userId,
        collection: 'note', // AAD differs → authentication fails
        clientEntityId: ctx.clientEntityId
      })
    ).rejects.toThrow()
  })

  it('content fingerprint is deterministic and nonce-independent (drives server `unchanged`)', async () => {
    const umk = await generateUmk()
    const plaintext = { title: 'T', n: 42 }
    const fp1 = await contentFingerprint(umk, plaintext)
    const fp2 = await contentFingerprint(umk, plaintext)
    expect(fp1).toBe(fp2)
    // Two encryptions use fresh nonces but the fingerprint stays equal.
    await encryptPayload({ umk, plaintext, ...ctx })
    expect(await contentFingerprint(umk, plaintext)).toBe(fp1)
  })

  it('different content yields a different fingerprint', async () => {
    const umk = await generateUmk()
    const a = await contentFingerprint(umk, { v: 1 })
    const b = await contentFingerprint(umk, { v: 2 })
    expect(a).not.toBe(b)
  })

  it('different UMKs yield different fingerprints for identical content', async () => {
    const [u1, u2] = [await generateUmk(), await generateUmk()]
    const a = await contentFingerprint(u1, { v: 1 })
    const b = await contentFingerprint(u2, { v: 1 })
    expect(a).not.toBe(b)
  })
})
