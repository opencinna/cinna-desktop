/**
 * Approval tokens (spec §3). The helper signs them after a user-presence
 * prompt; vaultd checks them before every gated call.
 *
 * Session tokens (`move-in`, `install`) are multi-use until `exp`; their
 * detail is prompt text only. Single-use tokens (`export`, `terminal`,
 * `move-out`) must carry the sha256 of the call's canonical detail and are
 * spent on first use.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { GATED_ACTIONS, type ApprovalClaims, type GatedAction } from '../../../../../src/shared/vault/protocol'
import { VaultdError } from './util'

const SINGLE_USE: readonly GatedAction[] = ['export', 'terminal', 'move-out']

export interface TokenSource {
  approvalKey: Buffer | null
  approvalKeyFile: string | null
  vaultId: string | null
  vaultIdFile: string | null
  /** Where spent single-use nonces are kept across a vaultd restart; null keeps them in memory only. */
  spentNoncesFile?: string | null
}

export interface TokenRequirement {
  /** Actions that may authorize this call. */
  actions: readonly GatedAction[]
  /** Canonical detail (`approvalDetail(call)`) per action, checked for single-use actions. */
  detail?: (action: GatedAction) => string
}

const bad = (message: string): VaultdError => new VaultdError('bad_token', message)

function b64urlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  return Buffer.from(value, 'base64url')
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30
  if (b >= 0x61 && b <= 0x66) return b - 0x57
  if (b >= 0x41 && b <= 0x46) return b - 0x37
  return -1
}

/**
 * `/run/vault/approval.key` holds hex (what vault-init writes); anything else
 * is taken as raw bytes. Decoded byte by byte, so the key never becomes a JS
 * string (D39); `raw` is zeroed when it was hex.
 */
export function parseKeyFile(raw: Buffer): Buffer {
  let end = raw.length
  while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d || raw[end - 1] === 0x20)) end--
  if (end < 32 || end % 2 !== 0) return raw
  const out = Buffer.alloc(end / 2)
  for (let i = 0; i < end; i += 2) {
    const hi = hexValue(raw[i])
    const lo = hexValue(raw[i + 1])
    if (hi < 0 || lo < 0) {
      out.fill(0)
      return raw
    }
    out[i / 2] = (hi << 4) | lo
  }
  raw.fill(0)
  return out
}

const NONCE = /^[A-Za-z0-9_-]{8,256}$/

export class TokenVerifier {
  /** Spent single-use nonces, with their expiry so the set can be pruned. */
  private readonly spent = new Map<string, number>()
  private loaded = false

  constructor(private readonly source: TokenSource, private readonly now: () => number = Date.now) {}

  /** Lines `<nonce> <exp>` from the spent-nonce file (tmpfs in the guest). */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const file = this.source.spentNoncesFile
    if (!file) return
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return
    }
    for (const line of text.split('\n')) {
      const [nonce, exp] = line.split(' ')
      if (nonce && NONCE.test(nonce) && Number.isFinite(Number(exp))) this.spent.set(nonce, Number(exp))
    }
  }

  /** Records a spent nonce before the call it authorizes runs; refuses the call if it cannot. */
  private spend(nonce: string, exp: number): void {
    this.spent.set(nonce, exp)
    const file = this.source.spentNoncesFile
    if (!file) return
    try {
      appendFileSync(file, `${nonce} ${exp}\n`, { mode: 0o600 })
    } catch {
      throw new VaultdError('internal', 'The approval could not be recorded.')
    }
  }

  /** Rewrites the file without expired nonces (only when something was pruned). */
  private persistPruned(): void {
    const file = this.source.spentNoncesFile
    if (!file) return
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, [...this.spent].map(([n, e]) => `${n} ${e}\n`).join(''), { mode: 0o600 })
      renameSync(tmp, file)
    } catch {
      // Keeping expired nonces is harmless; the next prune tries again.
    }
  }

  private key(): Buffer | null {
    if (this.source.approvalKey) return this.source.approvalKey
    if (!this.source.approvalKeyFile) return null
    try {
      return parseKeyFile(readFileSync(this.source.approvalKeyFile))
    } catch {
      return null
    }
  }

  private vaultId(): string | null {
    if (this.source.vaultId) return this.source.vaultId
    if (!this.source.vaultIdFile) return null
    try {
      return readFileSync(this.source.vaultIdFile, 'utf8').trim() || null
    } catch {
      return null
    }
  }

  /** Throws `bad_token` unless `token` authorizes the call; spends single-use tokens. */
  verify(token: unknown, need: TokenRequirement): ApprovalClaims {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) throw bad('Approval required.')
    const key = this.key()
    const vaultId = this.vaultId()
    if (!key || key.length === 0 || !vaultId) throw bad('This vault cannot verify approvals.')
    const parts = token.split('.')
    if (parts.length !== 2) throw bad('Malformed approval.')
    const [body, mac] = parts
    const given = b64urlDecode(mac)
    if (!given || !b64urlDecode(body)) throw bad('Malformed approval.')
    const expected = createHmac('sha256', key).update(body, 'ascii').digest()
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad('Approval signature mismatch.')

    let claims: ApprovalClaims
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ApprovalClaims
    } catch {
      throw bad('Malformed approval.')
    }
    if (typeof claims !== 'object' || claims === null || claims.v !== 1) throw bad('Unknown approval version.')
    if (claims.vaultId !== vaultId) throw bad('Approval is for another vault.')
    if (!(GATED_ACTIONS as readonly string[]).includes(claims.action) || !need.actions.includes(claims.action)) {
      throw bad('Approval does not cover this action.')
    }
    if (typeof claims.exp !== 'number' || claims.exp <= this.now()) throw bad('Approval expired.')

    if (SINGLE_USE.includes(claims.action)) {
      if (typeof claims.nonce !== 'string' || !NONCE.test(claims.nonce)) {
        throw bad('Malformed approval.')
      }
      if (need.detail === undefined || typeof claims.detailSha256 !== 'string') throw bad('Approval does not match this call.')
      const want = Buffer.from(sha256Hex(need.detail(claims.action)), 'hex')
      const have = /^[0-9a-f]{64}$/.test(claims.detailSha256) ? Buffer.from(claims.detailSha256, 'hex') : null
      if (!have || !timingSafeEqual(want, have)) throw bad('Approval does not match this call.')
      this.load()
      this.prune()
      if (this.spent.has(claims.nonce)) throw bad('Approval already used.')
      this.spend(claims.nonce, claims.exp)
    }
    return claims
  }

  private prune(): void {
    const now = this.now()
    let pruned = false
    for (const [nonce, exp] of this.spent) {
      if (exp <= now) {
        this.spent.delete(nonce)
        pruned = true
      }
    }
    if (pruned) this.persistPruned()
  }
}
