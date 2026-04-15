import { safeStorage } from 'electron'

export function encryptApiKey(plaintext: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext)
  }
  // Fallback: base64 encode (not secure, but functional)
  return Buffer.from(plaintext, 'utf-8')
}

export function decryptApiKey(encrypted: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(encrypted)
  }
  return encrypted.toString('utf-8')
}
