import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { deriveSubkey } from './umk'

/**
 * BIP39 recovery key. A 24-word (256-bit) mnemonic is shown ONCE at setup and
 * is the user's last-resort way to recover the UMK on a brand-new device with
 * no trusted device available. Because the entropy is already high, we derive
 * the wrapping key with HKDF (no Argon2id) — see plan §4.
 */

export interface RecoveryKey {
  mnemonic: string
  /** 32-byte KEK derived from the mnemonic entropy. */
  kek: Uint8Array
}

export async function generateRecoveryKey(): Promise<RecoveryKey> {
  const mnemonic = generateMnemonic(wordlist, 256)
  const kek = await mnemonicToKek(mnemonic)
  return { mnemonic, kek }
}

export function isValidRecoveryMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalize(mnemonic), wordlist)
}

export async function mnemonicToKek(mnemonic: string): Promise<Uint8Array> {
  const normalized = normalize(mnemonic)
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error('Invalid recovery phrase')
  }
  const entropy = mnemonicToEntropy(normalized, wordlist)
  return deriveSubkey(entropy, 'recovery', 32)
}

function normalize(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, ' ').toLowerCase()
}
