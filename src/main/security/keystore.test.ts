import { describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ available: false }))
vi.mock('../host/runtimeHost', () => ({
  runtimeHost: {
    keystore: {
      isEncryptionAvailable: () => host.available,
      encryptString: async (s: string) => Buffer.from(`v10${s}`, 'latin1'),
      decryptString: async (b: Buffer) => b.subarray(3).toString('latin1')
    }
  }
}))

import { decryptApiKey, encryptApiKey } from './keystore'

describe('keystore fallback', () => {
  it('round-trips through the host keystore when it is available', async () => {
    host.available = true
    expect(await decryptApiKey(await encryptApiKey('sk-1'))).toBe('sk-1')
  })

  it('stores and reads plain bytes when no keystore is available', async () => {
    host.available = false
    const stored = await encryptApiKey('sk-plain')
    expect(stored.toString('utf-8')).toBe('sk-plain')
    expect(await decryptApiKey(stored)).toBe('sk-plain')
  })

  it('refuses keychain-sealed bytes instead of returning the ciphertext as the key', async () => {
    host.available = false
    await expect(decryptApiKey(Buffer.from('v10\u0001\u0002sealed', 'latin1'))).rejects.toThrow(/keystore is unavailable/)
    await expect(decryptApiKey(Buffer.from('v11\u0001\u0002sealed', 'latin1'))).rejects.toThrow(/keystore is unavailable/)
  })
})
