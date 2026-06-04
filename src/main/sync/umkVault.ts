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
  // Swap the entry synchronously. Two deliberate choices:
  //  - Do NOT route through the async `lock()`: its deferred `vault.delete(userId)`
  //    continuation can land *after* we set the new entry and silently wipe it,
  //    flapping the unlock state under concurrent getState/syncNow/auto-unlock.
  //  - Do NOT memzero the replaced buffer here: a replacement carries the SAME
  //    secret value, and a concurrent in-flight cycle may still be reading the
  //    prior bytes — zeroing them mid-use would corrupt that cycle. Deliberate
  //    teardown (`lock`/`lockAll`) still memzeros the live key.
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
