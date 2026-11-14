/**
 * How codex and opencode are configured inside a vault (D34): vaultd reads
 * the vault's own `cinna.launch` and `cinna.instructions` (kv) at every
 * `engine.spawn` and builds each engine's config from them. Main names only
 * the engine; nothing from Cinna's database decides the mode, the model or
 * the prompt.
 *
 * Files under the agent's home are written **as the agent user** (a child
 * run with its identity), never by root, for the reason `setClaudeDefaultMode`
 * gives: `/vault/home` is the agent's, and a planted link would point a
 * root write anywhere.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  VAULT_KV_INSTRUCTIONS,
  VAULT_KV_LAUNCH,
  VAULT_LAUNCH_MODEL,
  VAULT_LAUNCH_PROVIDERS,
  type VaultLaunchProvider
} from '../../../../../src/shared/vault/protocol'
import type { Ctx } from './context'
import { nodeSelfEnv, runCollect } from './procs'
import { invalid, VaultdError } from './util'

/** `cinna.launch` as vaultd reads it: anything malformed falls back to the most closed value, field by field. */
export interface VaultdLaunch {
  kind: 'kit' | 'bare'
  model: string | null
  approval: 'auto' | 'ask'
  provider: VaultLaunchProvider | null
}

function readKvFile(ctx: Ctx): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(ctx.layout.kv, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The vault's launch settings; no entry ⇒ sealed, asking, the CLI's default model (`VAULT_LAUNCH_FALLBACK` in main). */
export function readLaunch(ctx: Ctx): VaultdLaunch {
  const value = readKvFile(ctx)[VAULT_KV_LAUNCH]
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const model = raw['model']
  const provider = raw['provider']
  return {
    kind: raw['kind'] === 'bare' ? 'bare' : 'kit',
    model: typeof model === 'string' && VAULT_LAUNCH_MODEL.test(model) ? model : null,
    approval: raw['approval'] === 'auto' ? 'auto' : 'ask',
    provider: (VAULT_LAUNCH_PROVIDERS as readonly unknown[]).includes(provider) ? (provider as VaultLaunchProvider) : null
  }
}

/** A kit agent's captured prompt (`cinna.instructions`); null for a bare agent or when none was captured. */
export function readInstructions(ctx: Ctx, launch: VaultdLaunch): string | null {
  if (launch.kind !== 'kit') return null
  const value = readKvFile(ctx)[VAULT_KV_INSTRUCTIONS]
  return typeof value === 'string' && value.trim() ? value : null
}

// ---------------------------------------------------------------------------
// Codex

/** The codex-acp agent mode a new session opens in: the host launcher's mapping (codexLauncher.ts). */
export function codexMode(launch: VaultdLaunch): 'agent' | 'workspace-write' {
  return launch.approval === 'auto' ? 'agent' : 'workspace-write'
}

/** `CODEX_CONFIG` for the adapter: the session's developer instructions and model, as on the host. */
export function codexConfig(launch: VaultdLaunch, instructions: string | null): Record<string, unknown> {
  return {
    ...(instructions ? { developer_instructions: instructions } : {}),
    ...(launch.model ? { model: launch.model } : {})
  }
}

// ---------------------------------------------------------------------------
// OpenCode

/** The one agent entry the vault's OpenCode config defines; the session selects it (`mode` config option). */
export const OPENCODE_VAULT_AGENT = 'cinna'
/** Turns off OpenCode's Claude/agents-folder compatibility plugin (acpLaunchers.ts `OPENCODE_NO_COMPATIBILITY_PLUGIN`). */
const OPENCODE_NO_COMPATIBILITY_PLUGIN = '-opencode.config.compatibility'

/**
 * The permission profile. Asking: the host's conversation profile in short
 * (files and search free, the shell free but for the destructive spellings,
 * everything else asks). Auto: everything allowed — the vault is the boundary.
 */
function opencodePermission(approval: 'auto' | 'ask'): Record<string, unknown> {
  if (approval === 'auto') return { '*': 'allow' }
  return {
    '*': 'ask',
    read: 'allow',
    edit: 'allow',
    write: 'allow',
    grep: 'allow',
    glob: 'allow',
    bash: { '*': 'allow', 'sudo *': 'ask', 'rm -r *': 'ask', 'rm -rf *': 'ask', 'rm -fr *': 'ask' },
    webfetch: 'ask',
    external_directory: 'ask'
  }
}

/** The vault's OpenCode config: one primary agent on the vault's model, the provider's own key from the environment. */
export function opencodeConfig(launch: VaultdLaunch, instructions: string | null): Record<string, unknown> {
  if (!launch.provider || !launch.model) {
    throw new VaultdError('invalid', 'This vault names no model for OpenCode.')
  }
  const model = `${launch.provider}/${launch.model}`
  const permission = opencodePermission(launch.approval)
  return {
    $schema: 'https://opencode.ai/config.json',
    model,
    plugins: [OPENCODE_NO_COMPATIBILITY_PLUGIN],
    agent: {
      [OPENCODE_VAULT_AGENT]: {
        description: 'The agent in this vault.',
        mode: 'primary',
        model,
        ...(instructions ? { prompt: instructions } : {}),
        permission
      }
    },
    // Subagents get the same profile.
    permission
  }
}

/** Where OpenCode keeps its config and database in a vault: all under the agent's home. */
export function opencodePaths(home: string): { configDir: string; config: string; db: string } {
  const configDir = join(home, '.config', 'cinna-opencode')
  return { configDir, config: join(configDir, 'opencode.json'), db: join(home, '.local', 'share', 'cinna-opencode', 'opencode.db') }
}

/** The XDG directories of the agent's home, stated so nothing an engine writes lands outside it. */
export function xdgEnv(home: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache')
  }
}

// ---------------------------------------------------------------------------
// Writing into the agent's home, as the agent

/**
 * Run as a child with the agent's identity. stdin is JSON (a prompt can be
 * longer than one argv string may be on Linux)
 * `{ dirs: string[], files: { path, content }[] }`, every path relative to
 * `$HOME`. Directories are made 0700; each file is written to a temp file
 * and renamed (0600), and a file whose content is unchanged is left alone.
 */
const WRITE_HOME_SCRIPT = `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const home = process.env.HOME
const spec = JSON.parse(fs.readFileSync(0, 'utf8'))
for (const dir of spec.dirs) fs.mkdirSync(path.join(home, dir), { recursive: true, mode: 0o700 })
for (const file of spec.files) {
  const target = path.join(home, file.path)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  try { if (fs.readFileSync(target, 'utf8') === file.content) continue } catch {}
  const tmp = path.join(path.dirname(target), '.' + crypto.randomBytes(6).toString('hex') + '.tmp')
  const fd = fs.openSync(tmp, 'w', 0o600)
  fs.writeSync(fd, file.content)
  fs.fsyncSync(fd); fs.closeSync(fd)
  fs.renameSync(tmp, target)
}
`

function homeRelative(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some((part) => part === '..' || part === '')) {
    throw invalid('Invalid path in the agent home.')
  }
  return path
}

/** Make `dirs` and write `files` (paths relative to `home`) as `identity`; unchanged files are not rewritten. */
export async function writeAgentHome(
  home: string,
  spec: { dirs: string[]; files: { path: string; content: string }[] },
  identity: { asUser?: { uid: number; gid: number } } = {},
  node: string = process.execPath
): Promise<void> {
  const checked = {
    dirs: spec.dirs.map(homeRelative),
    files: spec.files.map((file) => ({ path: homeRelative(file.path), content: file.content }))
  }
  const r = await runCollect(node, ['-e', WRITE_HOME_SCRIPT], {
    input: Buffer.from(JSON.stringify(checked)),
    env: { HOME: home, PATH: '/usr/bin:/bin', ...nodeSelfEnv() },
    cwd: home,
    timeoutMs: 15_000,
    maxBytes: 4096,
    ...identity
  })
  if (r.code !== 0) throw new VaultdError('internal', 'The engine settings could not be written.')
}
