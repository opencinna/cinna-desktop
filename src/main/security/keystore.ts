import { runtimeHost } from '../host/runtimeHost'

export async function encryptApiKey(plaintext: string): Promise<Buffer> {
  if (runtimeHost.keystore.isEncryptionAvailable()) {
    return runtimeHost.keystore.encryptString(plaintext)
  }
  // Fallback: base64 encode (not secure, but functional)
  return Buffer.from(plaintext, 'utf-8')
}

export async function decryptApiKey(encrypted: Buffer): Promise<string> {
  if (runtimeHost.keystore.isEncryptionAvailable()) {
    return runtimeHost.keystore.decryptString(encrypted)
  }
  // Keychain-sealed bytes (Chromium's `v10`/`v11` prefix) with no keystore to open them: refuse,
  // rather than hand the ciphertext to a caller as if it were the key.
  const prefix = encrypted.subarray(0, 3).toString('latin1')
  if (prefix === 'v10' || prefix === 'v11') throw new Error('Stored secret is encrypted but the system keystore is unavailable.')
  return encrypted.toString('utf-8')
}
