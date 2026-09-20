import { runtimeHost } from '../host/runtimeHost'

export function encryptApiKey(plaintext: string): Buffer {
  if (runtimeHost.keystore.isEncryptionAvailable()) {
    return runtimeHost.keystore.encryptString(plaintext)
  }
  // Fallback: base64 encode (not secure, but functional)
  return Buffer.from(plaintext, 'utf-8')
}

export function decryptApiKey(encrypted: Buffer): string {
  if (runtimeHost.keystore.isEncryptionAvailable()) {
    return runtimeHost.keystore.decryptString(encrypted)
  }
  return encrypted.toString('utf-8')
}
