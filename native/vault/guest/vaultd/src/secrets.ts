/**
 * `secrets.put` / `secrets.list` / `secrets.delete`. One file per secret in
 * `/vault/secrets` (0700), each 0600. There is deliberately no `get`: values
 * only ever become engine environment (`engine.spawn`, `auth.status`).
 */
import { readdirSync, readFileSync, rmSync, mkdirSync, chmodSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { VAULT_SECRET_NAME, vaultSecretStorable } from '../../../../../src/shared/vault/protocol'
import type { Ctx, Handler } from './context'
import { writeJsonAtomic } from './jsonFile'
import { invalid } from './util'

/**
 * Names a secret may not take: they would let an ungated `secrets.put`
 * change what `engine.spawn` runs (D29) or where it looks.
 */
const RESERVED = new Set([
  'PATH', 'HOME', 'SHELL', 'ENV', 'BASH_ENV', 'IFS', 'CDPATH', 'PWD', 'TMPDIR',
  'CLAUDE_CODE_EXECUTABLE', 'CODEX_PATH', 'CODEX_HOME', 'GEMINI_HOME', 'ELECTRON_RUN_AS_NODE',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Set by vaultd itself from `secrets.putFile` (secretFiles.ts); the token server is never reachable from a vault.
  'CINNA_CREDENTIALS_PATH', 'CINNA_CREDENTIALS_TOKEN_URL', 'CINNA_CREDENTIALS_TOKEN'
])
const RESERVED_PREFIXES = ['LD_', 'NODE_', 'UV_', 'PYTHON', 'GIT_', 'DYLD_', 'NPM_']

export const MAX_SECRET_BYTES = 64 * 1024

export function secretName(value: unknown): string {
  if (typeof value !== 'string' || !VAULT_SECRET_NAME.test(value)) throw invalid('Invalid secret name.')
  if (RESERVED.has(value) || RESERVED_PREFIXES.some((p) => value.startsWith(p))) throw invalid('Reserved secret name.')
  // A name that would steer an engine (D29), unless it is an engine's sign-in key.
  if (!vaultSecretStorable(value)) throw invalid('That name would change how the engine runs; it cannot be a secret.')
  return value
}

function ensureDir(ctx: Ctx): void {
  mkdirSync(ctx.layout.secrets, { recursive: true, mode: 0o700 })
  chmodSync(ctx.layout.secrets, 0o700)
}

/** Every stored secret as env, for vaultd's own children. Never sent to main. */
export function secretEnv(ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {}
  let entries: Dirent[]
  try {
    entries = readdirSync(ctx.layout.secrets, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile() || !VAULT_SECRET_NAME.test(entry.name)) continue
    try {
      out[entry.name] = JSON.parse(readFileSync(join(ctx.layout.secrets, entry.name), 'utf8')) as string
    } catch {
      // A torn or foreign file is skipped, never surfaced.
    }
  }
  return out
}

export function hasSecret(ctx: Ctx, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(secretEnv(ctx), name)
}

export const secretsPut: Handler = async (ctx, params) => {
  const name = secretName(params.name)
  const value = params.value
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
    throw invalid('Invalid secret value.')
  }
  ensureDir(ctx)
  // JSON-encoded so any string round-trips exactly (newlines included).
  await ctx.serial(`secret:${name}`, () => writeJsonAtomic(join(ctx.layout.secrets, name), value, 0o600))
  return {}
}

export const secretsList: Handler = async (ctx) => {
  let entries: Dirent[]
  try {
    entries = readdirSync(ctx.layout.secrets, { withFileTypes: true })
  } catch {
    return { names: [] }
  }
  return { names: entries.filter((e) => e.isFile() && VAULT_SECRET_NAME.test(e.name)).map((e) => e.name).sort() }
}

export const secretsDelete: Handler = async (ctx, params) => {
  if (typeof params.name !== 'string' || !VAULT_SECRET_NAME.test(params.name)) throw invalid('Invalid secret name.')
  rmSync(join(ctx.layout.secrets, params.name), { force: true })
  return {}
}
