/**
 * Agent Vault wire protocols. Types and literals only: imported by main, the
 * renderer, and the guest's cinna-vaultd bundle, so it must stay import-free.
 *
 * Two protocols live here:
 * - **Helper frames** (main ⇄ VaultHelper over the helper's stdio): binary
 *   frames carrying JSON control on channel 0 and raw byte channels to the
 *   guest. See `HELPER_FRAME_*`.
 * - **vaultd** (main ⇄ cinna-vaultd, over a channel the helper opened, or a
 *   unix socket in fake mode): one hello line per connection, then JSON-RPC 2.0
 *   ndjson on a control connection or raw bytes on an attached stream.
 *
 * Described in docs/agents/vault/ (helper_tech.md has the wire details).
 */

// ---------------------------------------------------------------------------
// Shared vocabulary

export const VAULT_ENGINES = ['claude', 'codex', 'opencode', 'antigravity'] as const
export type VaultEngine = (typeof VAULT_ENGINES)[number]

/** Every action the helper gates with a fresh user-presence prompt (D4). */
export const GATED_ACTIONS = [
  'move-in',
  'install',
  'export',
  'move-out',
  'egress',
  'terminal',
  'resize',
  'destroy',
  'lock-timeout'
] as const
export type GatedAction = (typeof GATED_ACTIONS)[number]

export type VaultState =
  | 'locked'
  | 'booting'
  | 'unlocked'
  | 'locking'
  | 'stopped'
  | 'error'
  | 'tampered'

export type VaultUnavailableReason =
  | 'unsupported-os'
  | 'unsupported-hardware'
  | 'nested'
  | 'no-virtualization'
  | 'helper-missing'
  | 'helper-untrusted'
  | 'image-missing'

export type VaultAvailability = { ok: true } | { ok: false; reason: VaultUnavailableReason; detail?: string }

export type HelperFlavor = 'release' | 'dev' | 'test' | 'fake'

/** Host names the guest may reach through the helper proxy. `*.example.com` matches subdomains only. */
export interface EgressPolicy {
  hosts: string[]
}

/** Opened in the proxy only while an `install` / `move-in` approval is live. */
export const VAULT_INSTALL_HOSTS = [
  'releases.astral.sh',
  'github.com',
  '*.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org'
] as const

/** Default allowlist per engine (D18): the API and the login hosts it needs. */
export const VAULT_ENGINE_HOSTS: Record<VaultEngine, readonly string[]> = {
  claude: ['api.anthropic.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com', 'statsig.anthropic.com'],
  codex: ['api.openai.com', 'auth.openai.com', 'chatgpt.com'],
  opencode: ['api.openai.com', 'api.anthropic.com', 'opencode.ai', 'models.dev'],
  antigravity: ['generativelanguage.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'cloudcode-pa.googleapis.com']
}

export const VAULT_DEFAULT_SIZE_BYTES = 10 * 1024 ** 3
/**
 * D13: how long a vault stays unlocked after its last turn, gated action or
 * keystroke in its chat, per vault (`lockAfterMs` in the helper's signed
 * `vault.json`). `0` = no idle timer: it locks when Cinna quits, and on screen
 * lock, sleep and logout as always (D21).
 */
export const VAULT_LOCK_TIMEOUTS = [30_000, 300_000, 0] as const
export type VaultLockTimeout = (typeof VAULT_LOCK_TIMEOUTS)[number]
/** New vaults, and a `vault.json` written before the setting existed. */
export const VAULT_DEFAULT_LOCK_AFTER_MS: VaultLockTimeout = 300_000

export function isVaultLockTimeout(value: unknown): value is VaultLockTimeout {
  return typeof value === 'number' && (VAULT_LOCK_TIMEOUTS as readonly number[]).includes(value)
}

/**
 * True when `next` closes the vault strictly sooner than `current` (0, no
 * timer, is the longest): such a change needs no approval.
 */
export function vaultLockTimeoutShorter(next: number, current: number): boolean {
  const rank = (ms: number): number => (ms === 0 ? Number.POSITIVE_INFINITY : ms)
  return rank(next) < rank(current)
}
/** D33: a locked (paused) VM is stopped cold after this long. */
export const VAULT_PAUSED_STOP_MS = 30 * 60_000

export interface VaultSummary {
  vaultId: string
  agentId: string
  agentName: string
  state: VaultState
  /** Epoch ms the unlock window ends; null while a hold keeps it open, or with no timer (`lockAfterMs` 0). Only for `unlocked`. */
  until?: number | null
  /** The vault's lock timeout ({@link VAULT_LOCK_TIMEOUTS}); absent from an older helper ⇒ the default. */
  lockAfterMs?: number
  sizeBytes: number
  usedBytes?: number
  egress: EgressPolicy
  engine: VaultEngine
  createdAt: number
  imageVersion: string
}

// ---------------------------------------------------------------------------
// Helper frames (main ⇄ VaultHelper stdio)

/** `u32 BE length` (of type + channel + payload) · `u8 type` · `u32 BE channel` · payload. */
export const HELPER_FRAME_HEADER_BYTES = 9
export const HELPER_FRAME_MAX_PAYLOAD = 256 * 1024
export const HelperFrameType = { ctl: 0, data: 1, eof: 2, rst: 3 } as const
export type HelperFrameType = (typeof HelperFrameType)[keyof typeof HelperFrameType]

export const HELPER_PROTOCOL = 1

export interface HelperRequestMap {
  hello: { params: { protocol: number }; result: { protocol: number; flavor: HelperFlavor; helperVersion: string; guest: { version: string; rootHash: string } } }
  availability: { params: Record<string, never>; result: VaultAvailability }
  'vault.list': { params: { dir: string }; result: { vaults: VaultSummary[] } }
  'vault.create': {
    params: {
      dir: string
      vaultId: string
      agentId: string
      agentName: string
      engine: VaultEngine
      sizeBytes: number
      egress: EgressPolicy
      rootfsPath: string
    }
    result: { vault: VaultSummary }
  }
  'vault.unlock': { params: { vaultId: string; purpose: string }; result: { state: VaultState } }
  'vault.lock': { params: { vaultId: string }; result: { state: VaultState } }
  'vault.hold': { params: { vaultId: string; holdId: string }; result: Record<string, never> }
  'vault.release': { params: { vaultId: string; holdId: string }; result: Record<string, never> }
  'vault.status': { params: { vaultId: string }; result: VaultSummary }
  'vault.approve': { params: { vaultId: string; action: GatedAction; detail: string }; result: { token: string } }
  'vault.setEgress': { params: { vaultId: string; policy: EgressPolicy; token: string }; result: Record<string, never> }
  /** A strictly shorter timeout needs no token; anything else a `lock-timeout` token for exactly this value. */
  'vault.setLockTimeout': { params: { vaultId: string; lockAfterMs: number; token?: string }; result: Record<string, never> }
  /** Restarts an unlocked, unheld vault's idle window (typing in its chat). No prompt; a no-op otherwise. */
  'vault.touch': { params: { vaultId: string }; result: Record<string, never> }
  'vault.resize': { params: { vaultId: string; sizeBytes: number; token: string }; result: Record<string, never> }
  'vault.destroy': { params: { vaultId: string; token: string }; result: Record<string, never> }
  'channel.open': { params: { vaultId: string }; result: { channel: number } }
}
export type HelperMethod = keyof HelperRequestMap

export type HelperEvent =
  | { event: 'vault.state'; vaultId: string; state: VaultState; until?: number | null; lockAfterMs?: number; error?: string }
  | { event: 'egress'; vaultId: string; host: string; verdict: 'allowed' | 'denied' }
  | { event: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }

/** Error codes the helper returns in `{error: {code, message}}`. */
export type HelperErrorCode =
  | 'denied' // the user cancelled or failed the presence prompt
  | 'locked'
  | 'not_found'
  | 'bad_token'
  | 'busy'
  | 'unavailable'
  | 'tampered'
  | 'invalid'
  | 'internal'

// ---------------------------------------------------------------------------
// Approval tokens (helper signs, vaultd verifies)

/** `base64url(JSON(ApprovalClaims)) + "." + base64url(HMAC-SHA256(approvalKey, firstPart))`. */
export interface ApprovalClaims {
  v: 1
  vaultId: string
  action: GatedAction
  /** hex SHA-256 of the canonical detail string of the call it authorizes. */
  detailSha256: string
  nonce: string
  /** epoch ms */
  exp: number
  /**
   * `move-in` / `install` only (D37): the proxy credential that opens the
   * install hosts for the exec this token authorizes, and only for it.
   */
  proxyCred?: string
}

/** Minutes a token stays valid, per action (move-in and install cover long rebuilds). */
export const APPROVAL_TTL_MS: Record<GatedAction, number> = {
  'move-in': 30 * 60_000,
  install: 30 * 60_000,
  export: 10 * 60_000,
  'move-out': 30 * 60_000,
  egress: 10 * 60_000,
  terminal: 10 * 60_000,
  resize: 10 * 60_000,
  destroy: 10 * 60_000,
  'lock-timeout': 10 * 60_000
}

// ---------------------------------------------------------------------------
// vaultd

export const VAULTD_PROTOCOL = 1

/** First line on every vaultd connection. */
export type VaultdHello = { type: 'control' } | { type: 'attach'; stream: string }

export type ExecPreset = 'uv-python-install' | 'uv-sync' | 'rebuild' | 'check' | 'shell'
export type RuntimeKind = 'executable' | 'archive' | 'adapter'

/**
 * Env names main may pass to `engine.spawn`; anything else is refused. The
 * model is never among them: it comes from the vault's own `cinna.launch` (D34).
 */
export const VAULT_ENGINE_EXTRA_ENV = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'MAX_THINKING_TOKENS'
] as const
export type VaultEngineExtraEnv = (typeof VAULT_ENGINE_EXTRA_ENV)[number]

/**
 * The approval mode a new engine session opens in (`engine.spawn`
 * `options.mode`). Claude: vaultd records it as `permissions.defaultMode` in
 * the vault's own `~/.claude/settings.json`, the only input the adapter reads
 * a new session's mode from; without it a session opens in `auto`.
 */
export const VAULT_ENGINE_MODES = ['default', 'auto'] as const
export type VaultEngineMode = (typeof VAULT_ENGINE_MODES)[number]

/** Secret names vaultd turns into engine env. Values never leave the guest. */
export const VAULT_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * The secrets an engine signs in with (an allowlist): passed to that engine
 * as env although their names are in an engine's own namespace.
 */
export const VAULT_ENGINE_SECRET_KEYS: Record<VaultEngine, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  opencode: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  antigravity: ['GEMINI_API_KEY']
}

/** Plain provider API keys: a script may call the provider itself, so any engine's process may carry one. */
const VAULT_PROVIDER_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']

/**
 * Namespaces an engine, its runtime or its network stack reads its own
 * configuration from. A whole family, not a list of today's variables, so a
 * variable an engine release adds is covered too.
 */
const STEERING_PREFIXES: readonly string[] = [
  'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'OPENCODE_', 'GEMINI_', 'GOOGLE_', 'CLOUDSDK_', 'VERTEX',
  'BUN_', 'NODE_', 'NPM_', 'XDG_', 'SSL_', 'LD_', 'DYLD_', 'UV_', 'PYTHON', 'PIP_', 'GIT_', 'DISABLE_', 'BASH_',
  'CINNA_CREDENTIALS_'
]
const STEERING_NAMES: readonly string[] = [
  'HOME', 'SHELL', 'ENV', 'IFS', 'PWD', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'USER', 'LOGNAME', 'LANG',
  'NO_PROXY', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'ELECTRON_RUN_AS_NODE', 'MAX_THINKING_TOKENS', 'DEBUG'
]

/**
 * True when a secret named `name` would steer how an engine runs rather than
 * be read by the agent's own scripts: an engine's or its runtime's namespace
 * (`CLAUDE_*`, `OPENCODE_*`, `NODE_*`, …), any `*_BASE_URL`, `*_CONFIG*`,
 * `*PATH`, `*_PROXY` or `*_CA_*`, and the process basics. Such a secret is
 * refused by `secrets.put` and never turned into env, except an engine's
 * sign-in key ({@link VAULT_ENGINE_SECRET_KEYS}).
 */
export function vaultSecretSteers(name: string): boolean {
  if (STEERING_NAMES.includes(name)) return true
  if (STEERING_PREFIXES.some((prefix) => name.startsWith(prefix))) return true
  return /_BASE_URL$|_API_BASE$|_ENDPOINT$|CONFIG|PATH$|PROXY$|_CA_|_CERT/.test(name)
}

/** Whether a secret of this name may be stored at all: any engine's sign-in key, or a name that steers none. */
export function vaultSecretStorable(name: string): boolean {
  if (!VAULT_SECRET_NAME.test(name)) return false
  return Object.values(VAULT_ENGINE_SECRET_KEYS).some((keys) => keys.includes(name)) || !vaultSecretSteers(name)
}

/**
 * Whether vaultd hands the secret `name` to `engine` as env: that engine's
 * own sign-in keys, a plain provider API key, and any name that steers no
 * engine. Everything else (another engine's token, a secret stored before
 * this rule) stays in the vault's store, unused.
 */
export function vaultSecretAsEnv(engine: VaultEngine, name: string): boolean {
  if (!VAULT_SECRET_NAME.test(name)) return false
  if (VAULT_ENGINE_SECRET_KEYS[engine].includes(name) || VAULT_PROVIDER_KEYS.includes(name)) return true
  return !vaultSecretSteers(name)
}

/**
 * The vault's own key-value entries that decide how its agent runs (D34).
 * Written by main at move-in (`vaultAgentState.ts`); read by main's vault
 * launcher and, for the engines whose config vaultd writes (codex,
 * opencode), by vaultd itself at `engine.spawn`.
 */
export const VAULT_KV_LAUNCH = 'cinna.launch'
export const VAULT_KV_INSTRUCTIONS = 'cinna.instructions'

/** The model providers an OpenCode agent may use inside a vault (their API hosts are in `VAULT_ENGINE_HOSTS.opencode`). */
export const VAULT_LAUNCH_PROVIDERS = ['openai', 'anthropic'] as const
export type VaultLaunchProvider = (typeof VAULT_LAUNCH_PROVIDERS)[number]

/** A model id as `cinna.launch` may hold it (no provider prefix). */
export const VAULT_LAUNCH_MODEL = /^[A-Za-z0-9._:\[\]-]{1,100}$/

/** The two secrets Claude Code signs in with inside a vault; a vault holds one of them. */
export const CLAUDE_LOGIN_SECRETS: readonly string[] = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']

/**
 * Which of {@link CLAUDE_LOGIN_SECRETS} a pasted value belongs in, by its
 * prefix: `claude setup-token` prints an OAuth token (`sk-ant-oat…`), which
 * Claude Code reads only from CLAUDE_CODE_OAUTH_TOKEN (as ANTHROPIC_API_KEY it
 * is sent as an API key and refused); anything else is an API key.
 */
export function claudeLoginSecretName(value: string): 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN' {
  return value.trim().startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'
}

/**
 * Engines whose login is more than one fixed key: the names it may be stored
 * under (a vault keeps one), how a pasted value picks its name, and how the
 * UI names what to paste. Every other engine signs in with
 * {@link vaultEngineKeyName} alone.
 */
export const VAULT_ENGINE_LOGIN: Partial<Record<VaultEngine, { names: readonly string[]; nameFor: (value: string) => string; what: string; short: string }>> = {
  claude: {
    names: CLAUDE_LOGIN_SECRETS,
    nameFor: claudeLoginSecretName,
    what: 'an Anthropic API key or a claude setup-token token',
    short: 'API key or token'
  }
}

/** The secret a pasted engine login is stored under. */
export function vaultEngineLoginSecret(engine: VaultEngine, provider: VaultLaunchProvider | null, value: string): string | null {
  return VAULT_ENGINE_LOGIN[engine]?.nameFor(value) ?? vaultEngineKeyName(engine, provider)
}

/**
 * The secret an engine signs in with inside a vault: the API key it reads
 * from its environment. OpenCode's depends on the agent's model provider
 * (null when the vault names none); Antigravity's is a Gemini API key (its
 * `gemini-api-key` ACP login; Google sign-in cannot be completed inside a vault yet).
 */
export function vaultEngineKeyName(engine: VaultEngine, provider: VaultLaunchProvider | null = null): string | null {
  switch (engine) {
    case 'claude':
      return 'ANTHROPIC_API_KEY'
    case 'codex':
      return 'OPENAI_API_KEY'
    case 'opencode':
      return provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'openai' ? 'OPENAI_API_KEY' : null
    case 'antigravity':
      return 'GEMINI_API_KEY'
  }
}

export interface TranscriptRow {
  id: string
  [column: string]: unknown
}
export type TranscriptOp =
  | { op: 'put'; table: 'messages' | 'inflight'; row: TranscriptRow }
  | { op: 'delete'; table: 'messages' | 'inflight'; id: string }
  | { op: 'chat'; title?: string; updatedAt: number }

export interface VaultdRequestMap {
  hello: { params: Record<string, never>; result: { protocol: number; image: { version: string; node: string; uv: string }; layoutReady: boolean; fake: boolean } }
  'layout.ensure': { params: Record<string, never>; result: Record<string, never> }
  'disk.usage': { params: Record<string, never>; result: { usedBytes: number; sizeBytes: number } }
  'runtime.status': { params: Record<string, never>; result: { runtimes: { engine: VaultEngine; version: string; kind: RuntimeKind; sha256: string }[] } }
  /**
   * `expectedSha256`: the sha256 main pins for these bytes (or hashed before
   * streaming when nothing pins them). vaultd commits the install only when
   * what it received hashes to it; otherwise the stage is deleted and nothing
   * in the vault changes.
   */
  'runtime.install': { params: { engine: VaultEngine; version: string; kind: RuntimeKind; name: string; expectedSha256: string; token: string }; result: { stream: string } }
  'files.import': { params: { dest: 'agent'; token: string }; result: { stream: string } }
  'files.export': { params: { path: string; token: string }; result: { stream: string } }
  'files.list': { params: { path: string }; result: { entries: { name: string; type: 'file' | 'dir' | 'link'; size: number; mtime: number }[] } }
  /**
   * What each path names, for file references in a vault chat. A path is
   * agent-relative, or absolute under the agent folder as processes inside the
   * vault see it (`/vault/agent/…`; the fake's own root). Checked as the
   * `agent` user, after realpath: anything else, missing, or leading out of
   * the agent folder (a symlink) is `type: null`. `rel` is the realpath,
   * agent-relative (`''` for the folder itself), null with `type`. At most
   * {@link VAULT_FILES_STAT_MAX} paths of {@link VAULT_FILES_PATH_MAX}
   * characters; results in request order. No token: the unlock is the gate.
   */
  'files.stat': { params: { paths: string[] }; result: { entries: VaultFileStatEntry[] } }
  /**
   * At most `maxBytes` ({@link VAULT_FILES_READ_MAX} at most) of one file in
   * the agent folder, read as the `agent` user after the same containment
   * check as `files.stat`; `bytes` is base64, `size` the whole file's,
   * `truncated` when it was cut. `rel` is where the opened file really is,
   * agent-relative, taken from the open descriptor after the open (a parent
   * swapped for a symlink out in between is refused): the caller checks it
   * against what it stat-ed. A folder is `invalid`, anything missing or
   * outside `not_found`. No token.
   */
  'files.read': { params: { path: string; maxBytes: number }; result: { rel: string; bytes: string; size: number; truncated: boolean } }
  /** `cols`/`rows` (shell only, optional): the terminal's size at open, as for `exec.resize`. */
  exec: { params: { preset: ExecPreset; token?: string; cols?: number; rows?: number }; result: { stream: string } }
  /**
   * The window size of a live `shell` exec stream (integers, clamped to
   * {@link VAULT_TERMINAL_COLS} / {@link VAULT_TERMINAL_ROWS}). No token: the
   * terminal approval opened the shell, a size grants nothing. The guest sets
   * it on the shell's pty; fake mode applies nothing and answers {}.
   * `not_found` for any other stream.
   */
  'exec.resize': { params: { stream: string; cols: number; rows: number }; result: Record<string, never> }
  'secrets.put': { params: { name: string; value: string }; result: Record<string, never> }
  'secrets.list': { params: Record<string, never>; result: { names: string[] } }
  'secrets.delete': { params: { name: string }; result: Record<string, never> }
  /**
   * A secret **file** (`credentials.json` or a side file `<id>.json`): stored
   * root-only, copied 0400 for the agent to `<root>/run-secrets/<name>`, which
   * `CINNA_CREDENTIALS_PATH` names for every engine. `content: null` removes it.
   */
  'secrets.putFile': { params: { name: string; content: string | null }; result: Record<string, never> }
  'engine.spawn': {
    params: { engine: VaultEngine; options: { extraEnv?: Partial<Record<VaultEngineExtraEnv, string>>; mode?: VaultEngineMode } }
    result: { stream: string; pid: number }
  }
  'engine.kill': { params: { stream: string }; result: Record<string, never> }
  /** `keyName`: the secret this engine signs in with in this vault ({@link vaultEngineKeyName}), when it has one. */
  'auth.status': { params: { engine: VaultEngine }; result: { loggedIn: boolean; method?: 'api_key' | 'oauth_token' | 'login'; keyName?: string } }
  'auth.login': { params: { engine: VaultEngine }; result: { stream: string } }
  'transcript.append': { params: { chatId: string; ops: TranscriptOp[] }; result: Record<string, never> }
  'transcript.read': { params: { chatId: string }; result: { ops: TranscriptOp[] } }
  'transcript.list': { params: Record<string, never>; result: { chatIds: string[] } }
  'transcript.delete': { params: { chatId: string }; result: Record<string, never> }
  'kv.get': { params: { key: string }; result: { value: unknown } }
  'kv.put': { params: { key: string; value: unknown }; result: Record<string, never> }
}
export type VaultdMethod = keyof VaultdRequestMap

/** One answer of `files.stat`, in request order. */
export interface VaultFileStatEntry {
  /** The path as it was asked for. */
  path: string
  /** The realpath, relative to the agent folder (`''` for the folder itself); null when `type` is. */
  rel: string | null
  type: 'file' | 'dir' | null
  size: number
}

/** Paths per `files.stat` call, and the longest path it takes. */
export const VAULT_FILES_STAT_MAX = 200
export const VAULT_FILES_PATH_MAX = 1024
/** The most `files.read` returns in one call: 10 MB. */
export const VAULT_FILES_READ_MAX = 10 * 1024 * 1024

/** Bounds of a vault terminal's size (`exec`, `exec.resize`); values outside are clamped. */
export const VAULT_TERMINAL_COLS = { min: 2, max: 500 } as const
export const VAULT_TERMINAL_ROWS = { min: 2, max: 200 } as const

export type VaultdNotification =
  | { method: 'runtime.installed'; params: { stream: string; sha256: string; bytes: number } }
  | { method: 'files.imported'; params: { stream: string; files: number; bytes: number } }
  | { method: 'exec.exit'; params: { stream: string; code: number | null } }
  | { method: 'engine.exit'; params: { stream: string; code: number | null; signal: string | null; stderrTail: string } }
  | { method: 'stream.error'; params: { stream: string; message: string } }

/**
 * Canonical `detail` string a **single-use** token (export, terminal, move-out;
 * and egress, resize, destroy, which the helper verifies itself) must carry,
 * sha256'd into `detailSha256`. Pass it as `vault.approve`'s `detail`. Session tokens (move-in, install)
 * carry free text for the prompt and are checked by action and expiry only.
 */
export function approvalDetail(
  call:
    | { method: 'runtime.install'; engine: VaultEngine; version: string; kind: RuntimeKind }
    | { method: 'files.import' }
    | { method: 'files.export'; path: string }
    | { method: 'exec'; preset: ExecPreset }
    | { method: 'move-out' }
    | { method: 'vault.setEgress'; policy: EgressPolicy }
    | { method: 'vault.resize'; sizeBytes: number }
    | { method: 'vault.setLockTimeout'; lockAfterMs: number }
    | { method: 'vault.destroy' }
): string {
  switch (call.method) {
    case 'runtime.install':
      return `runtime:${call.engine}@${call.version}:${call.kind}`
    case 'files.import':
      return 'import:agent'
    case 'files.export':
      return `export:${call.path}`
    case 'exec':
      return `exec:${call.preset}`
    case 'move-out':
      return 'export:agent:all'
    // Helper-verified, single use. The helper binds the token to exactly this
    // policy / size, and shows the hosts or the size in its prompt.
    case 'vault.setEgress':
      return `egress:${[...new Set(call.policy.hosts.map((h) => h.trim().toLowerCase()))].sort().join(',')}`
    case 'vault.resize':
      return `resize:${call.sizeBytes}`
    case 'vault.setLockTimeout':
      return `lock-timeout:${call.lockAfterMs}`
    case 'vault.destroy':
      return 'destroy'
  }
}
