/**
 * Approval tokens (spec §3), signed the way the helper signs them:
 *
 *   token = base64url(JSON(claims)) + "." + base64url(HMAC-SHA256(approvalKey, firstPart))
 *
 * The HMAC is over the ASCII of the base64url first part. `detailSha256` is
 * the hex SHA-256 of the UTF-8 detail. cinna-vaultd verifies them.
 *
 * In production only the helper holds the approval key; main never signs. The
 * fake backend uses this to stand in for the helper (tests, E2E), so the guest
 * side is exercised with real tokens.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { APPROVAL_TTL_MS, type ApprovalClaims, type GatedAction } from '../../shared/vault/protocol'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function signApprovalToken(
  key: Uint8Array,
  input: { vaultId: string; action: GatedAction; detail: string; now?: number; nonce?: string }
): string {
  const claims: ApprovalClaims = {
    v: 1,
    vaultId: input.vaultId,
    action: input.action,
    detailSha256: sha256Hex(input.detail),
    nonce: input.nonce ?? randomBytes(16).toString('hex'),
    exp: (input.now ?? Date.now()) + APPROVAL_TTL_MS[input.action]
  }
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const mac = createHmac('sha256', key).update(body, 'ascii').digest('base64url')
  return `${body}.${mac}`
}

/**
 * Signature and claims of a token, or null. For the fake helper's own
 * `setEgress`/`resize`/`destroy` (the real helper verifies those itself).
 */
export function readApprovalToken(key: Uint8Array, token: string, now = Date.now()): ApprovalClaims | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null
  const expected = createHmac('sha256', key).update(parts[0], 'ascii').digest()
  const given = Buffer.from(parts[1], 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let claims: ApprovalClaims
  try {
    claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as ApprovalClaims
  } catch {
    return null
  }
  if (!claims || claims.v !== 1 || typeof claims.exp !== 'number' || claims.exp <= now) return null
  return claims
}
