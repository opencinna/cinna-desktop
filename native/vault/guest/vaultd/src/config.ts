/**
 * Where everything lives, in production (the guest) and in fake mode (a
 * plain directory on the host, used by tests and the fake backend).
 */
import { join } from 'node:path'

export interface VaultdConfig {
  fake: boolean
  /** `/vault` in the guest; `--root` in fake mode. */
  root: string
  /** Main traffic (vsock 5000 is bridged here by the rootfs init). */
  listen: string
  /** Helper control (vsock 5001); null = not served. */
  helperListen: string | null
  /** Hex or raw approval key; read on every verification when null and `approvalKeyFile` is set. */
  approvalKey: Buffer | null
  approvalKeyFile: string | null
  /** This vault's id; tokens for another vault are refused. Null ⇒ every token is refused. */
  vaultId: string | null
  vaultIdFile: string | null
  /** `/etc/cinna/image.json` in the guest. */
  imageFile: string | null
  /** The `node` that runs adapters: this very process's executable. */
  node: string
  /** PATH for every child. */
  path: string
  /** Proxy env for every child (rootfs defaults in the guest; inherited only in fake mode). */
  proxyEnv: Record<string, string>
  /**
   * The unprivileged guest users children run as (D36); null in fake mode,
   * where vaultd is a plain host process and cannot switch uid.
   */
  users: GuestUsers | null
  /** Spent single-use approval nonces, kept across a vaultd restart (tmpfs, dies with the VM). */
  spentNoncesFile: string | null
  /** The log, rotated at 1 MiB (`/run/vault/vaultd.log`, tmpfs); null = stderr (fake mode, unless `--log`). */
  logFile: string | null
}

export interface GuestUser {
  uid: number
  gid: number
}

/**
 * `agent` runs engines, the terminal and auth; `build` runs the install and
 * check presets. Both have primary group `vault` (libuv drops supplementary
 * groups when it switches uid). Group `build` (1001) owns the uv cache and the
 * Python installs, so agent can read but not change what build runs.
 */
export interface GuestUsers {
  agent: GuestUser
  build: GuestUser
  /** Group of the uv cache, the Python installs and build's home (only build is in it). */
  buildGroup: number
}

export const GUEST_USERS: GuestUsers = {
  agent: { uid: 1000, gid: 1000 },
  build: { uid: 1001, gid: 1000 },
  buildGroup: 1001
}

export const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const GUEST_PROXY = 'http://127.0.0.1:3128'
const PROXY_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const

export function proxyEnvFrom(env: NodeJS.ProcessEnv, fake: boolean): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of PROXY_NAMES) {
    const value = env[name]
    if (value) out[name] = value
  }
  if (fake) return out
  // The rootfs defaults, in case the init did not export them.
  return {
    HTTPS_PROXY: GUEST_PROXY,
    HTTP_PROXY: GUEST_PROXY,
    https_proxy: GUEST_PROXY,
    http_proxy: GUEST_PROXY,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    ...out
  }
}

export interface Layout {
  agent: string
  home: string
  runtime: string
  adapter: string
  secrets: string
  transcripts: string
  state: string
  kv: string
  runtimeIndex: string
  uvCache: string
  python: string
  /** vaultd's own staging (root only). */
  tmp: string
  /** TMPDIR for children: group vault, sticky. */
  userTmp: string
  /** HOME of the build user (uv config, git config of install scripts); never the agent's home. */
  buildHome: string
}

export function layoutOf(root: string): Layout {
  return {
    agent: join(root, 'agent'),
    home: join(root, 'home'),
    runtime: join(root, 'runtime'),
    adapter: join(root, 'adapter'),
    secrets: join(root, 'secrets'),
    transcripts: join(root, 'transcripts'),
    state: join(root, 'state'),
    kv: join(root, 'state', 'kv.json'),
    runtimeIndex: join(root, 'runtime', 'index.json'),
    uvCache: join(root, 'cache', 'uv'),
    python: join(root, 'python'),
    tmp: join(root, 'tmp'),
    userTmp: join(root, 'cache', 'tmp'),
    buildHome: join(root, 'cache', 'build-home')
  }
}

/** Who owns a layout directory: root, or one of the guest users (uid, gid). */
export type DirOwner = 'root' | 'agent' | 'build' | 'vault-group'

/**
 * Directories `layout.ensure` creates, with their modes and owners (D36).
 * `/vault/agent` is setgid `vault` and group-writable so agent and build can
 * both write it; the uv cache and Python installs belong to build (agent
 * reads them); secrets, transcripts, state and vaultd's staging stay root's.
 */
export function layoutDirs(layout: Layout): [string, number, DirOwner][] {
  return [
    [layout.agent, 0o2775, 'agent'],
    [layout.home, 0o700, 'agent'],
    [layout.runtime, 0o755, 'root'],
    [layout.adapter, 0o755, 'root'],
    [layout.secrets, 0o700, 'root'],
    [layout.transcripts, 0o700, 'root'],
    [layout.state, 0o700, 'root'],
    [join(layout.uvCache, '..'), 0o755, 'root'],
    [layout.uvCache, 0o2755, 'build'],
    [layout.python, 0o2755, 'build'],
    [layout.buildHome, 0o2700, 'build'],
    [layout.userTmp, 0o1770, 'vault-group'],
    [layout.tmp, 0o700, 'root']
  ]
}

/** uid/gid for a layout owner; null when vaultd cannot change owners (fake mode). */
export function ownerIds(users: GuestUsers | null, owner: DirOwner): GuestUser | null {
  if (!users) return null
  switch (owner) {
    case 'root': return { uid: 0, gid: 0 }
    case 'agent': return users.agent
    case 'build': return { uid: users.build.uid, gid: users.buildGroup }
    case 'vault-group': return { uid: 0, gid: users.agent.gid }
  }
}

export class UsageError extends Error {}

/**
 * `vaultd [--fake] [--root DIR] [--listen SOCK] [--helper-listen SOCK]
 * [--approval-key HEX] [--vault-id ID] [--spent-nonces FILE] [--log FILE]`. Production needs no flags.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): VaultdConfig {
  const flags = new Map<string, string>()
  let fake = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--fake') { fake = true; continue }
    if (!['--root', '--listen', '--helper-listen', '--approval-key', '--vault-id', '--spent-nonces', '--log'].includes(arg)) {
      throw new UsageError(`Unknown argument ${arg}`)
    }
    const value = argv[++i]
    if (value === undefined) throw new UsageError(`${arg} needs a value`)
    flags.set(arg, value)
  }
  const keyHex = flags.get('--approval-key')
  if (keyHex !== undefined && !/^(?:[0-9a-fA-F]{2}){16,}$/.test(keyHex)) {
    throw new UsageError('--approval-key must be hex, at least 16 bytes')
  }
  if (fake && !flags.has('--root')) throw new UsageError('--fake needs --root')
  if (fake && !flags.has('--listen')) throw new UsageError('--fake needs --listen')
  return {
    fake,
    root: flags.get('--root') ?? '/vault',
    listen: flags.get('--listen') ?? '/run/vaultd.sock',
    helperListen: flags.get('--helper-listen') ?? (fake ? null : '/run/vaultd-helper.sock'),
    approvalKey: keyHex ? Buffer.from(keyHex, 'hex') : null,
    approvalKeyFile: keyHex || fake ? null : '/run/vault/approval.key',
    vaultId: flags.get('--vault-id') ?? null,
    vaultIdFile: flags.has('--vault-id') || fake ? null : '/run/vault/vault-id',
    imageFile: fake ? null : '/etc/cinna/image.json',
    node: process.execPath,
    path: fake ? (env.PATH ?? GUEST_PATH) : GUEST_PATH,
    proxyEnv: proxyEnvFrom(env, fake),
    users: fake ? null : GUEST_USERS,
    spentNoncesFile: flags.get('--spent-nonces') ?? (fake ? null : '/run/vault/spent-nonces'),
    logFile: flags.get('--log') ?? (fake ? null : '/run/vault/vaultd.log')
  }
}
