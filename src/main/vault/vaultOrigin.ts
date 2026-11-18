/**
 * Which build of Cinna made a vault, read from its `vault.json` without the
 * helper: a display hint for a vault the running helper calls `tampered`.
 *
 * Dev and release helpers keep their keys in different keychain groups, so a
 * vault one made is one the other can neither verify nor open, and its helper
 * reports it as tampered. Saying "tampered" to the user is wrong there; this
 * module lets main say which build made it instead.
 *
 * The read is deliberately unauthenticated: `vault.json` is world-readable
 * and holds nothing secret, and the answer only changes the words shown. The
 * vault stays refused whatever it says, so a forged file can at most make a
 * tampered vault read as "made by another build".
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { HelperFlavor } from '../../shared/vault/protocol'
import { GUEST_IMAGES_DIR } from './guestImage'

/** The key a test-flavor helper records in place of a wrapped one (KeyCustody.swift). */
const TEST_WRAPPED_KEY = 'test-flavor-plaintext'
/** Larger than any real `vault.json`: anything bigger is not one. */
const MAX_VAULT_JSON_BYTES = 256 * 1024

/**
 * The build that made the vault in `vaultDir` (`<SecureAgents>/<vaultId>`):
 * `test` when its key is the test flavor's plain-text file, `release` when it
 * boots a guest a packaged build downloaded into `<SecureAgents>/.images/`,
 * else `dev` (an unpackaged build boots `build/vault-guest` or
 * `CINNA_VAULT_GUEST_DIR`). Null when the file can't be read or parsed.
 * Never throws.
 */
export function readVaultOrigin(vaultDir: string): Exclude<HelperFlavor, 'fake'> | null {
  try {
    if (existsSync(join(vaultDir, 'test.key'))) return 'test'
    const raw = readFileSync(join(vaultDir, 'vault.json'))
    if (raw.byteLength > MAX_VAULT_JSON_BYTES) return null
    const parsed = JSON.parse(raw.toString('utf8')) as unknown
    const body = record(record(parsed)['vault'])
    if (body['wrappedKey'] === TEST_WRAPPED_KEY) return 'test'
    const rootfsPath = body['rootfsPath']
    if (typeof rootfsPath !== 'string' || !rootfsPath) return null
    return basename(dirname(rootfsPath)) === GUEST_IMAGES_DIR ? 'release' : 'dev'
  } catch {
    return null
  }
}

/**
 * The build that made a tampered vault, when that is why it reads as
 * tampered: its origin is known and is not the running helper's flavor. Null
 * otherwise, and always for the fake backend (it signs nothing).
 */
export function otherBuildOf(origin: HelperFlavor | null, current: HelperFlavor | null): HelperFlavor | null {
  if (origin === null || current === null || current === 'fake') return null
  return origin === current ? null : origin
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
