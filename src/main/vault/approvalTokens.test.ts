import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { APPROVAL_TTL_MS, approvalDetail } from '../../shared/vault/protocol'
import { readApprovalToken, sha256Hex, signApprovalToken } from './approvalTokens'

const KEY = Buffer.alloc(32, 7)
const NOW = 1_800_000_000_000

describe('approval tokens (spec §3)', () => {
  it('is base64url(claims) "." base64url(HMAC-SHA256(key, first part))', () => {
    const token = signApprovalToken(KEY, { vaultId: 'v1', action: 'export', detail: 'export:notes.md', now: NOW, nonce: 'n0nce-123' })
    const [body, mac] = token.split('.')
    expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toEqual({
      v: 1, vaultId: 'v1', action: 'export', detailSha256: sha256Hex('export:notes.md'), nonce: 'n0nce-123', exp: NOW + APPROVAL_TTL_MS.export
    })
    expect(mac).toBe(createHmac('sha256', KEY).update(body, 'ascii').digest('base64url'))
  })

  it('reads back only with the same key, unexpired', () => {
    const token = signApprovalToken(KEY, { vaultId: 'v1', action: 'destroy', detail: 'Agent', now: NOW })
    expect(readApprovalToken(KEY, token, NOW)?.action).toBe('destroy')
    expect(readApprovalToken(Buffer.alloc(32, 8), token, NOW)).toBeNull()
    expect(readApprovalToken(KEY, token, NOW + APPROVAL_TTL_MS.destroy)).toBeNull()
    expect(readApprovalToken(KEY, flipSignatureChar(token), NOW)).toBeNull()
  })

  // The guest's verifier, written separately from the same spec: a token this
  // module signs must pass it byte for byte.
  const verifierPath = join(__dirname, '../../../native/vault/guest/vaultd/src/tokens.ts')
  it.skipIf(!existsSync(verifierPath))('passes cinna-vaultd\'s own verifier, and a single-use one only once', async () => {
    const { TokenVerifier } = await import(/* @vite-ignore */ verifierPath)
    const verifier = new TokenVerifier({ approvalKey: KEY, approvalKeyFile: null, vaultId: 'v1', vaultIdFile: null }, () => NOW)
    const detail = approvalDetail({ method: 'files.export', path: 'notes.md' })
    const token = signApprovalToken(KEY, { vaultId: 'v1', action: 'export', detail, now: NOW })
    const need = { actions: ['export'] as const, detail: () => detail }
    expect(verifier.verify(token, need).action).toBe('export')
    expect(() => verifier.verify(token, need)).toThrow()
    const session = signApprovalToken(KEY, { vaultId: 'v1', action: 'install', detail: 'Update dependencies', now: NOW })
    expect(verifier.verify(session, { actions: ['install', 'move-in'] }).action).toBe('install')
    expect(verifier.verify(session, { actions: ['install', 'move-in'] }).action).toBe('install')
    const other = signApprovalToken(KEY, { vaultId: 'v2', action: 'install', detail: '', now: NOW })
    expect(() => verifier.verify(other, { actions: ['install'] })).toThrow()
  })
})

/** Flips a character in the middle of the signature: the last base64url char can differ only in padding bits. */
function flipSignatureChar(token: string): string {
  const dot = token.lastIndexOf('.')
  const i = dot + Math.floor((token.length - dot) / 2)
  return token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1)
}
