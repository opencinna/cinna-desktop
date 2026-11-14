import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { engineCommand } from '../src/engine'
import { attach, Client, startVaultd, type Harness } from './harness'

/**
 * Codex and OpenCode inside a vault (D34): vaultd builds each engine's
 * command, environment and config from the vault's own `cinna.launch` and
 * `cinna.instructions`, writes the config into the agent's home before the
 * engine starts, and reports each engine's login from the vault's secrets.
 */

let h: Harness
let c: Client

beforeEach(async () => {
  h = await startVaultd()
  c = await Client.open(h.sock)
  await c.call('layout.ensure')
})

afterEach(async () => {
  c?.close()
  await h?.stop()
})

/** A secret as an older vault holds it (stored before `secrets.put` refused its name): one JSON file in the store. */
function storeSecretDirectly(name: string, value: string): void {
  mkdirSync(join(h.root, 'secrets'), { recursive: true, mode: 0o700 })
  writeFileSync(join(h.root, 'secrets', name), JSON.stringify(value), { mode: 0o600 })
}

/** Index an installed runtime (and adapter) the way `runtime.install` would, with a stand-in executable. */
function installRuntime(engine: string, name: string, executable: string, adapterEntry?: string): void {
  const dir = join(h.root, 'runtime', engine, '1.0.0')
  mkdirSync(join(dir, name, '..'), { recursive: true })
  writeFileSync(join(dir, name), executable, { mode: 0o755 })
  const runtimes: unknown[] = [{ engine, version: '1.0.0', kind: 'archive', name, sha256: 'x', installedAt: 1 }]
  if (adapterEntry) {
    const adapter = join(h.root, 'adapter', engine, '2.0.0', adapterEntry)
    mkdirSync(join(adapter, '..'), { recursive: true })
    writeFileSync(adapter, '')
    runtimes.push({ engine, version: '2.0.0', kind: 'adapter', name: 'adapter', sha256: 'y', installedAt: 2 })
  }
  writeFileSync(join(h.root, 'runtime', 'index.json'), JSON.stringify({ runtimes }))
}

const CODEX_ENTRY = 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'

describe('codex in a vault', () => {
  it('runs the installed codex-acp on the installed codex, configured from the vault\'s kv, never from main', async () => {
    installRuntime('codex', 'codex', '#!/bin/sh\n', CODEX_ENTRY)
    await c.call('kv.put', { key: 'cinna.launch', value: { kind: 'kit', model: 'gpt-5.6-luna', approval: 'auto' } })
    await c.call('kv.put', { key: 'cinna.instructions', value: 'You are Payroll, inside a vault.' })
    let cmd = engineCommand(h.vaultd.ctx, 'codex', {})
    expect(cmd.args).toEqual([join(h.root, 'adapter', 'codex', '2.0.0', CODEX_ENTRY)])
    expect(cmd.env).toMatchObject({
      CODEX_PATH: join(h.root, 'runtime', 'codex', '1.0.0', 'codex'),
      CODEX_HOME: join(h.root, 'home', '.codex'),
      INITIAL_AGENT_MODE: 'agent'
    })
    expect(JSON.parse(cmd.env['CODEX_CONFIG']!)).toEqual({ developer_instructions: 'You are Payroll, inside a vault.', model: 'gpt-5.6-luna' })
    expect(cmd.home).toEqual({ dirs: ['.codex'], files: [] })
    // No key yet: no default login, so the adapter reports auth required.
    expect(cmd.env['DEFAULT_AUTH_REQUEST']).toBeUndefined()

    // A bare agent asking: no captured prompt (Codex reads AGENTS.md itself), the asking mode.
    await c.call('kv.put', { key: 'cinna.launch', value: { kind: 'bare', model: null, approval: 'ask' } })
    await c.call('secrets.put', { name: 'OPENAI_API_KEY', value: 'sk-test' })
    // A secret that would steer Codex's own config is refused, and one stored
    // before that rule never reaches it; the fixed variables win anyway.
    expect(await c.code('secrets.put', { name: 'CODEX_SANDBOX', value: 'danger' })).toBe('invalid')
    storeSecretDirectly('CODEX_SANDBOX', 'danger')
    await c.call('secrets.put', { name: 'CODEX_API_KEY', value: 'sk-codex' })
    cmd = engineCommand(h.vaultd.ctx, 'codex', {})
    expect(JSON.parse(cmd.env['CODEX_CONFIG']!)).toEqual({})
    expect(cmd.env).toMatchObject({ INITIAL_AGENT_MODE: 'workspace-write', OPENAI_API_KEY: 'sk-test', CODEX_API_KEY: 'sk-codex' })
    expect(JSON.parse(cmd.env['DEFAULT_AUTH_REQUEST']!)).toEqual({ methodId: 'api-key' })
    expect(cmd.env['CODEX_SANDBOX']).toBeUndefined()
  })

  it('opens asking and sealed when the vault holds no launch settings, whatever main passes', async () => {
    installRuntime('codex', 'codex', '#!/bin/sh\n', CODEX_ENTRY)
    await c.call('kv.put', { key: 'cinna.launch', value: { kind: 'kit', model: '../../etc', approval: 'yes-please' } })
    const cmd = engineCommand(h.vaultd.ctx, 'codex', {})
    expect(cmd.env['INITIAL_AGENT_MODE']).toBe('workspace-write')
    expect(JSON.parse(cmd.env['CODEX_CONFIG']!)).toEqual({})
  })

  it('reports the API key as its login, and names the key', async () => {
    expect(await c.call('auth.status', { engine: 'codex' })).toEqual({ loggedIn: false, keyName: 'OPENAI_API_KEY' })
    await c.call('secrets.put', { name: 'OPENAI_API_KEY', value: 'sk-test' })
    expect(await c.call('auth.status', { engine: 'codex' })).toEqual({ loggedIn: true, method: 'api_key', keyName: 'OPENAI_API_KEY' })
  })

  it('refuses to start without its adapter', async () => {
    installRuntime('codex', 'codex', '#!/bin/sh\n')
    expect(() => engineCommand(h.vaultd.ctx, 'codex', {})).toThrow(/codex adapter is not installed/)
  })
})

describe('opencode in a vault', () => {
  it('runs `opencode acp` on a config built from the vault\'s kv, with its config and database in the agent home', async () => {
    installRuntime('opencode', 'package/bin/opencode', '#!/bin/sh\n')
    await c.call('kv.put', { key: 'cinna.launch', value: { kind: 'kit', model: 'claude-haiku-4-5', approval: 'ask', provider: 'anthropic' } })
    await c.call('kv.put', { key: 'cinna.instructions', value: 'You are Payroll.' })
    await c.call('secrets.put', { name: 'ANTHROPIC_API_KEY', value: 'sk-ant' })
    expect(await c.code('secrets.put', { name: 'OPENCODE_CONFIG_CONTENT', value: '{"permission":{"*":"allow"}}' })).toBe('invalid')
    storeSecretDirectly('OPENCODE_CONFIG_CONTENT', '{"permission":{"*":"allow"}}')
    const home = join(h.root, 'home')
    const cmd = engineCommand(h.vaultd.ctx, 'opencode', {})
    expect(cmd.command).toBe(join(h.root, 'runtime', 'opencode', '1.0.0', 'package/bin/opencode'))
    expect(cmd.args).toEqual(['acp'])
    expect(cmd.env).toMatchObject({
      OPENCODE_CONFIG: join(home, '.config', 'cinna-opencode', 'opencode.json'),
      OPENCODE_CONFIG_DIR: join(home, '.config', 'cinna-opencode'),
      OPENCODE_DB: join(home, '.local', 'share', 'cinna-opencode', 'opencode.db'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      XDG_DATA_HOME: join(home, '.local', 'share'),
      ANTHROPIC_API_KEY: 'sk-ant'
    })
    // A secret that would rewrite OpenCode's config (its permissions) never reaches it.
    expect(cmd.env['OPENCODE_CONFIG_CONTENT']).toBeUndefined()
    expect(cmd.home.dirs).toEqual(['.local/share/cinna-opencode'])
    const config = JSON.parse(cmd.home.files[0]!.content) as { model: string; plugins: string[]; agent: Record<string, { model: string; prompt?: string; permission: Record<string, unknown> }> }
    expect(cmd.home.files[0]!.path).toBe('.config/cinna-opencode/opencode.json')
    expect(config.model).toBe('anthropic/claude-haiku-4-5')
    expect(config.plugins).toEqual(['-opencode.config.compatibility'])
    expect(config.agent['cinna']).toMatchObject({ mode: 'primary', model: 'anthropic/claude-haiku-4-5', prompt: 'You are Payroll.' })
    expect(config.agent['cinna']!.permission['*']).toBe('ask')

    await c.call('kv.put', { key: 'cinna.launch', value: { kind: 'bare', model: 'gpt-5.6-luna', approval: 'auto', provider: 'openai' } })
    const auto = JSON.parse(engineCommand(h.vaultd.ctx, 'opencode', {}).home.files[0]!.content) as { agent: Record<string, { prompt?: string; permission: unknown }> }
    expect(auto.agent['cinna']).toMatchObject({ permission: { '*': 'allow' } })
    expect(auto.agent['cinna']!.prompt).toBeUndefined()
  })

  it('refuses to start when the vault names no provider or model', async () => {
    installRuntime('opencode', 'package/bin/opencode', '#!/bin/sh\n')
    await c.call('kv.put', { key: 'cinna.launch', value: { kind: 'kit', model: 'gemini-3', approval: 'ask', provider: 'gemini' } })
    expect(await c.code('engine.spawn', { engine: 'opencode', options: {} })).toBe('invalid')
  })

  it('writes its config into the agent home before the engine starts', async () => {
    // A stand-in `opencode` that reports what it found at start, then waits.
    installRuntime('opencode', 'package/bin/opencode', '#!/bin/sh\ncat "$OPENCODE_CONFIG" > "$HOME/seen-config.json"\n[ -d "$(dirname "$OPENCODE_DB")" ] && echo yes > "$HOME/seen-db-dir"\nexec cat\n')
    await c.call('kv.put', { key: 'cinna.launch', value: { kind: 'kit', model: 'gpt-5.6-luna', approval: 'ask', provider: 'openai' } })
    const { stream } = await c.call<{ stream: string }>('engine.spawn', { engine: 'opencode', options: {} })
    const socket = await attach(h.sock, stream)
    const home = join(h.root, 'home')
    for (let i = 0; i < 100 && !existsSync(join(home, 'seen-db-dir')); i++) await new Promise((r) => setTimeout(r, 20))
    expect(JSON.parse(readFileSync(join(home, 'seen-config.json'), 'utf8'))).toMatchObject({ model: 'openai/gpt-5.6-luna' })
    expect(readFileSync(join(home, 'seen-db-dir'), 'utf8').trim()).toBe('yes')
    socket.destroy()
  })

  it('reports the key of the vault\'s model provider as its login', async () => {
    expect(await c.call('auth.status', { engine: 'opencode' })).toEqual({ loggedIn: false })
    await c.call('kv.put', { key: 'cinna.launch', value: { kind: 'kit', model: 'gpt-5.6-luna', approval: 'ask', provider: 'openai' } })
    await c.call('secrets.put', { name: 'ANTHROPIC_API_KEY', value: 'sk-ant' })
    expect(await c.call('auth.status', { engine: 'opencode' })).toEqual({ loggedIn: false, keyName: 'OPENAI_API_KEY' })
    await c.call('secrets.put', { name: 'OPENAI_API_KEY', value: 'sk-test' })
    expect(await c.call('auth.status', { engine: 'opencode' })).toEqual({ loggedIn: true, method: 'api_key', keyName: 'OPENAI_API_KEY' })
  })
})

describe('antigravity in a vault', () => {
  it('reports a Gemini API key as its login (its Google login cannot be completed inside), and hands the key to the server', async () => {
    expect(await c.call('auth.status', { engine: 'antigravity' })).toEqual({ loggedIn: false, keyName: 'GEMINI_API_KEY' })
    await c.call('secrets.put', { name: 'GEMINI_API_KEY', value: 'k' })
    expect(await c.call('auth.status', { engine: 'antigravity' })).toEqual({ loggedIn: true, method: 'api_key', keyName: 'GEMINI_API_KEY' })
    installRuntime('antigravity', 'agy_acp_server.par', '#!/bin/sh\n')
    const cmd = engineCommand(h.vaultd.ctx, 'antigravity', {})
    expect(cmd.env).toMatchObject({ GEMINI_API_KEY: 'k', GEMINI_HOME: join(h.root, 'home', '.gemini') })
  })
})
