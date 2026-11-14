/**
 * `engine.spawn` / `engine.kill` / `auth.status` / `auth.login` (D29).
 *
 * Main names an engine and a few allowlisted env values; vaultd picks the
 * installed runtime and adapter and builds the command. The engine's stdin
 * and stdout are the stream (ACP ndjson); stderr is kept as a 40-line tail
 * and sent with `engine.exit`.
 *
 * **claude**, **codex** and **opencode** run for real. codex and opencode
 * take their per-agent config (codex: `CODEX_CONFIG` and the initial mode;
 * opencode: its config file and database) from the vault's own kv
 * (`engineConfig.ts`, D34), written into the agent's home as the agent.
 * antigravity builds the host launcher's command shape (antigravityLauncher.ts)
 * and signs in with a Gemini API key (`GEMINI_API_KEY`, its `gemini-api-key`
 * ACP method, which main sends); its Google login cannot be completed inside
 * a vault yet.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { VAULT_ENGINE_EXTRA_ENV, VAULT_ENGINE_MODES, VAULT_ENGINES, vaultEngineKeyName, vaultSecretAsEnv, type VaultEngine, type VaultEngineMode } from '../../../../../src/shared/vault/protocol'
import type { Ctx, Handler } from './context'
import { codexConfig, codexMode, opencodeConfig, opencodePaths, readInstructions, readLaunch, writeAgentHome, xdgEnv } from './engineConfig'
import { bindChild, killGroup, LineTail, nodeSelfEnv, runCollect, spawnGroup } from './procs'
import { engineExecutable, installDir, latest } from './runtime'
import { hasSecret, secretEnv } from './secrets'
import { credentialsEnv } from './secretFiles'
import { roleEnv, spawnIdentity } from './users'
import { invalid, log, oneOf, VaultdError } from './util'

export interface EngineCommand {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  /** Written into the agent's home, as the agent, before the engine starts (paths relative to the home). */
  home: { dirs: string[]; files: { path: string; content: string }[] }
}

/**
 * The secrets an engine's process gets as env (`vaultSecretAsEnv`): its own
 * sign-in keys by an allowlist, plain provider keys, and the user's secrets
 * whose names steer no engine. A secret in an engine's or its runtime's
 * namespace (`OPENCODE_CONFIG_CONTENT`, `CODEX_…`, `ANTHROPIC_BASE_URL`,
 * `NODE_…`) is never handed over, whichever engine it would steer; the fixed
 * variables win over any secret anyway.
 */
function engineSecretEnv(ctx: Ctx, engine: VaultEngine): Record<string, string> {
  return Object.fromEntries(Object.entries(secretEnv(ctx)).filter(([name]) => vaultSecretAsEnv(engine, name)))
}

/** codex-acp signs in with the key in its environment when the CLI has no login of its own. */
const CODEX_API_KEY_LOGIN = JSON.stringify({ methodId: 'api-key' })

const ADAPTER_ENTRY: Partial<Record<VaultEngine, string>> = {
  claude: 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
  codex: 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'
}

function extraEnvOf(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('Invalid extraEnv.')
  const out: Record<string, string> = {}
  for (const [name, v] of Object.entries(value)) {
    if (!(VAULT_ENGINE_EXTRA_ENV as readonly string[]).includes(name)) throw invalid(`Env ${name} is not allowed.`)
    if (typeof v !== 'string' || v.length > 4096 || v.includes('\0')) throw invalid(`Invalid value for ${name}.`)
    out[name] = v
  }
  return out
}

const unavailable = (engine: VaultEngine, what: string): VaultdError =>
  new VaultdError('unavailable', `The ${engine} ${what} is not installed in this vault.`)

function adapterEntry(ctx: Ctx, engine: VaultEngine): string {
  const rel = ADAPTER_ENTRY[engine]
  const adapter = latest(ctx, engine, ['adapter'])
  if (!rel || !adapter) throw unavailable(engine, 'adapter')
  const entry = join(installDir(ctx, adapter), rel)
  if (!existsSync(entry)) throw unavailable(engine, 'adapter')
  return entry
}

function executable(ctx: Ctx, engine: VaultEngine): string {
  const path = engineExecutable(ctx, engine)
  if (!path || !existsSync(path)) throw unavailable(engine, 'runtime')
  return path
}

/**
 * The full command for an engine. Fixed variables are applied last, so
 * neither a secret nor an allowlisted extra can override them.
 */
export function engineCommand(ctx: Ctx, engine: VaultEngine, extraEnv: Record<string, string>): EngineCommand {
  const fixed: Record<string, string> = {
    ...roleEnv(ctx, 'agent'),
    // The delivered service credentials, the agent's own 0400 copy (secretFiles.ts).
    ...credentialsEnv(ctx),
    DISABLE_AUTOUPDATER: '1'
  }
  const env = (own: Record<string, string>): Record<string, string> => ({ ...engineSecretEnv(ctx, engine), ...extraEnv, ...fixed, ...own })
  const cwd = ctx.layout.agent
  const home = ctx.layout.home
  const none = { dirs: [], files: [] }
  switch (engine) {
    case 'claude':
      return {
        command: ctx.config.node,
        args: [adapterEntry(ctx, engine)],
        env: env({
          ...nodeSelfEnv(),
          CLAUDE_CODE_EXECUTABLE: executable(ctx, engine),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
        }),
        cwd,
        home: none
      }
    case 'codex': {
      // The host launcher's inputs (codexLauncher.ts), from the vault's kv (D34).
      const launch = readLaunch(ctx)
      const secrets = secretEnv(ctx)
      const hasKey = Boolean(secrets['OPENAI_API_KEY'] || secrets['CODEX_API_KEY'])
      return {
        command: ctx.config.node,
        args: [adapterEntry(ctx, engine)],
        env: env({
          ...nodeSelfEnv(),
          CODEX_PATH: executable(ctx, engine),
          // Codex refuses a CODEX_HOME that does not exist: made below, as the agent.
          CODEX_HOME: join(home, '.codex'),
          CODEX_CONFIG: JSON.stringify(codexConfig(launch, readInstructions(ctx, launch))),
          INITIAL_AGENT_MODE: codexMode(launch),
          // The vault's API key is its login; without one the adapter reports auth required.
          ...(hasKey ? { DEFAULT_AUTH_REQUEST: CODEX_API_KEY_LOGIN } : {})
        }),
        cwd,
        home: { dirs: ['.codex'], files: [] }
      }
    }
    case 'opencode': {
      const launch = readLaunch(ctx)
      const config = opencodeConfig(launch, readInstructions(ctx, launch))
      const paths = opencodePaths(home)
      const rel = (path: string): string => path.slice(home.length + 1)
      return {
        command: executable(ctx, engine),
        args: ['acp'],
        env: env({
          ...xdgEnv(home),
          // Both: the v1 loader reads the file, the v2 loader the directory (acpLaunchers.ts).
          OPENCODE_CONFIG: paths.config,
          OPENCODE_CONFIG_DIR: paths.configDir,
          OPENCODE_DB: paths.db,
          OPENCODE_DISABLE_AUTOUPDATE: '1'
        }),
        cwd,
        // OpenCode 2 dies without a word given an OPENCODE_DB whose directory is missing.
        home: { dirs: [rel(join(paths.db, '..'))], files: [{ path: rel(paths.config), content: `${JSON.stringify(config, null, 2)}\n` }] }
      }
    }
    case 'antigravity':
      return {
        command: executable(ctx, engine),
        args: process.platform === 'linux' ? ['--uid='] : [],
        env: env({ GEMINI_HOME: join(home, '.gemini') }),
        cwd,
        home: { dirs: ['.gemini'], files: [] }
      }
  }
}

/**
 * Run as a child (as the agent user in the guest, D36): `/vault/home` belongs
 * to the agent, so root must not write into it (a planted symlink would
 * point root's write anywhere). Reads `$HOME/.claude/settings.json`, sets
 * `permissions.defaultMode` to argv[1], keeps the rest, writes atomically.
 */
const SET_MODE_SCRIPT = `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const mode = process.argv[1]
const dir = path.join(process.env.HOME, '.claude'), file = path.join(dir, 'settings.json')
let settings = {}
try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (p && typeof p === 'object' && !Array.isArray(p)) settings = p } catch {}
const perms = settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions) ? settings.permissions : {}
if (perms.defaultMode === mode) process.exit(0)
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const tmp = path.join(dir, '.' + crypto.randomBytes(6).toString('hex') + '.tmp')
const fd = fs.openSync(tmp, 'w', 0o600)
fs.writeSync(fd, JSON.stringify({ ...settings, permissions: { ...perms, defaultMode: mode } }))
fs.fsyncSync(fd); fs.closeSync(fd)
fs.renameSync(tmp, file)
`

/**
 * Claude reads a new session's approval mode only from settings
 * (`permissions.defaultMode`; none ⇒ `auto`). Record the mode main asked for
 * in the vault's own user settings (`$HOME/.claude/settings.json`), keeping
 * whatever else the file holds. Unchanged files are not rewritten. Runs as
 * `identity` (the agent user in the guest), so the file is the agent's.
 */
export async function setClaudeDefaultMode(
  home: string,
  mode: VaultEngineMode,
  identity: { asUser?: { uid: number; gid: number } } = {},
  node: string = process.execPath
): Promise<void> {
  if (!(VAULT_ENGINE_MODES as readonly string[]).includes(mode)) throw invalid('Invalid mode.')
  const r = await runCollect(node, ['-e', SET_MODE_SCRIPT, mode], {
    env: { HOME: home, PATH: '/usr/bin:/bin', ...nodeSelfEnv() },
    cwd: home,
    timeoutMs: 15_000,
    maxBytes: 4096,
    ...identity
  })
  if (r.code !== 0) throw new VaultdError('internal', 'The engine settings could not be written.')
}

export const engineSpawn: Handler = async (ctx, params, conn) => {
  const engine = oneOf(params.engine, VAULT_ENGINES, 'engine')
  const options = params.options ?? {}
  if (typeof options !== 'object' || options === null) throw invalid('Invalid options.')
  const extraEnv = extraEnvOf((options as Record<string, unknown>).extraEnv)
  const rawMode = (options as Record<string, unknown>).mode
  const mode = rawMode === undefined ? null : oneOf(rawMode, VAULT_ENGINE_MODES, 'mode')
  const cmd = engineCommand(ctx, engine, extraEnv)
  if (mode && engine === 'claude') await setClaudeDefaultMode(ctx.layout.home, mode, spawnIdentity(ctx, 'agent'), ctx.config.node)
  if (cmd.home.dirs.length > 0 || cmd.home.files.length > 0) await writeAgentHome(ctx.layout.home, cmd.home, spawnIdentity(ctx, 'agent'), ctx.config.node)

  const child = spawnGroup(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'], ...spawnIdentity(ctx, 'agent') })
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('spawn', () => resolve(child.pid!))
    child.once('error', () => reject(new VaultdError('internal', `The ${engine} engine could not be started.`)))
  })
  const tail = new LineTail(40)
  child.stderr!.on('data', (chunk: Buffer) => tail.push(chunk))

  let attached = false
  const stream = ctx.streams.create(
    (socket) => {
      attached = true
      bindEngine(child, socket)
    },
    () => killGroup(child)
  )
  ctx.engines.set(stream, child)
  child.on('exit', (code, signal) => {
    ctx.engines.delete(stream)
    log('info', 'engine exited', { engine, stream, code, signal, attached })
    // Wait for stderr to drain so the tail is complete.
    const send = (): void => conn.notify('engine.exit', { stream, code, signal, stderrTail: tail.text() })
    if (child.stderr!.closed) send()
    else child.stderr!.once('close', send)
  })
  log('info', 'engine started', { engine, stream, pid })
  return { stream, pid }
}

/** Engine stdout → socket, socket → engine stdin; the socket going away kills the engine. */
function bindEngine(child: import('node:child_process').ChildProcess, socket: import('node:net').Socket): void {
  child.stdout!.pipe(socket)
  child.stdin!.on('error', () => {})
  socket.pipe(child.stdin!)
  socket.on('error', () => {})
  socket.on('close', () => killGroup(child))
}

export const engineKill: Handler = async (ctx, params) => {
  if (typeof params.stream !== 'string') throw invalid('Invalid stream.')
  const child = ctx.engines.get(params.stream)
  if (!child) throw new VaultdError('not_found', 'No such engine.')
  killGroup(child)
  return {}
}

export const authStatus: Handler = async (ctx, params) => {
  const engine = oneOf(params.engine, VAULT_ENGINES, 'engine')
  const keyName = vaultEngineKeyName(engine, engine === 'opencode' ? readLaunch(ctx).provider : null)
  const withKey = keyName ? { keyName } : {}
  switch (engine) {
    case 'codex':
      // The API key is the vault's codex login (DEFAULT_AUTH_REQUEST at spawn).
      return hasSecret(ctx, 'OPENAI_API_KEY') || hasSecret(ctx, 'CODEX_API_KEY') ? { loggedIn: true, method: 'api_key', ...withKey } : { loggedIn: false, ...withKey }
    case 'opencode':
      // The key of the vault's model provider; none named ⇒ not signed in.
      return keyName && hasSecret(ctx, keyName) ? { loggedIn: true, method: 'api_key', ...withKey } : { loggedIn: false, ...withKey }
    case 'antigravity':
      // A Gemini API key (main sends ACP `authenticate {methodId: 'gemini-api-key'}`);
      // its Google login cannot be completed inside a vault yet.
      return keyName && hasSecret(ctx, keyName) ? { loggedIn: true, method: 'api_key', ...withKey } : { loggedIn: false, ...withKey }
    case 'claude':
      break
  }
  if (hasSecret(ctx, 'ANTHROPIC_API_KEY')) return { loggedIn: true, method: 'api_key', ...withKey }
  if (hasSecret(ctx, 'CLAUDE_CODE_OAUTH_TOKEN')) return { loggedIn: true, method: 'oauth_token', ...withKey }
  const claude = engineExecutable(ctx, 'claude')
  if (!claude || !existsSync(claude)) return { loggedIn: false, ...withKey }
  const result = await runCollect(claude, ['auth', 'status'], {
    cwd: ctx.layout.agent,
    env: { ...roleEnv(ctx, 'agent'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    timeoutMs: 15_000,
    maxBytes: 64 * 1024,
    ...spawnIdentity(ctx, 'agent')
  })
  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown }
    if (parsed.loggedIn === true) return { loggedIn: true, method: 'login', ...withKey }
  } catch {
    // Unparseable = not known to be logged in.
  }
  return { loggedIn: false, ...withKey }
}

/**
 * `claude setup-token` with its stdio on the stream (the paste-code flow).
 * The live flow inside the guest is still to be probed: whether setup-token
 * prints the URL and reads the code on plain pipes, and where it leaves the
 * token (the caller is expected to `secrets.put CLAUDE_CODE_OAUTH_TOKEN`).
 */
export const authLogin: Handler = async (ctx, params, conn) => {
  const engine = oneOf(params.engine, VAULT_ENGINES, 'engine')
  if (engine !== 'claude') throw new VaultdError('unavailable', `Signing in to ${engine} inside a vault is not supported yet.`)
  const claude = executable(ctx, engine)
  const stream = ctx.streams.create((socket) => {
    const child = spawnGroup(claude, ['setup-token'], {
      cwd: ctx.layout.agent,
      env: { ...roleEnv(ctx, 'agent'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnIdentity(ctx, 'agent')
    })
    bindChild(child, socket, true, (code) => conn.notify('exec.exit', { stream, code }))
  })
  return { stream }
}
