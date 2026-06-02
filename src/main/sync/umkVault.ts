import { getSodium } from './crypto/sodium'

/**
 * In-memory UMK store. The plaintext UMK lives ONLY here, in main-process
 * memory, keyed by profile user id. It is zeroed on lock / profile-switch /
 * logout and never persisted in plaintext or crossed over the contextBridge.
 * See plan §2, §4.
 */
interface VaultEntry {
  umk: Uint8Array
  version: number
}

const vault = new Map<string, VaultEntry>()

export function setUmk(userId: string, umk: Uint8Array, version: number): void {
  // Replace any prior entry, zeroing it first.
  lock(userId)
  vault.set(userId, { umk, version })
}

export function getUmk(userId: string): VaultEntry | null {
  return vault.get(userId) ?? null
}

export function isUnlocked(userId: string): boolean {
  return vault.has(userId)
}

export async function lock(userId: string): Promise<void> {
  const entry = vault.get(userId)
  if (!entry) return
  const sodium = await getSodium()
  sodium.memzero(entry.umk)
  vault.delete(userId)
}

export async function lockAll(): Promise<void> {
  const sodium = await getSodium()
  for (const entry of vault.values()) {
    sodium.memzero(entry.umk)
  }
  vault.clear()
}
