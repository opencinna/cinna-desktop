import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { approvalDetail } from '../../../../../src/shared/vault/protocol'
import { attach, Client, collect, KEY_HEX, makeTar, mint, startVaultd, VAULT_ID, type Harness, type TarEntry } from './harness'

/** A well-formed sha256 for calls that never stream. */
const ANY_SHA = '0'.repeat(64)

let h: Harness
let c: Client

async function boot(extra: string[] = [], options = {}): Promise<void> {
  h = await startVaultd(extra, options)
  c = await Client.open(h.sock)
  await c.call('layout.ensure')
}

afterEach(async () => {
  c?.close()
  await h?.stop()
})

const ADAPTER_JS = `
process.stderr.write('fake-adapter-stderr\\n')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (msg.method === 'initialize') {
      const e = process.env
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, probe: {
        argv: process.argv.slice(1), cwd: process.cwd(),
        env: { HOME: e.HOME, CLAUDE_CODE_EXECUTABLE: e.CLAUDE_CODE_EXECUTABLE, DISABLE_AUTOUPDATER: e.DISABLE_AUTOUPDATER,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, CLAUDE_CODE_EFFORT_LEVEL: e.CLAUDE_CODE_EFFORT_LEVEL,
          ANTHROPIC_API_KEY: e.ANTHROPIC_API_KEY, UV_CACHE_DIR: e.UV_CACHE_DIR, FROM_HOST: e.VAULTD_TEST_LEAK,
          GH_TOKEN: e.GH_TOKEN, ANTHROPIC_BASE_URL: e.ANTHROPIC_BASE_URL } } } }) + '\\n')
    }
  }
})
`
const ADAPTER_PATH = 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'

/** runtime.install over a stream; resolves with the runtime.installed or stream.error notification. */
async function install(kind: 'executable' | 'archive' | 'adapter', name: string, data: Buffer, token = mint('install'), version = '1.0.0', expectedSha256 = createHash('sha256').update(data).digest('hex')) {
  const { stream } = await c.call<{ stream: string }>('runtime.install', { engine: 'claude', version, kind, name, expectedSha256, token })
  const s = await attach(h.sock, stream)
  s.end(data)
  return c.waitFor((n) => n.params.stream === stream)
}

async function installFakeClaude(loggedIn = false): Promise<void> {
  const exe = Buffer.from(`#!/bin/sh\necho '{"loggedIn":${loggedIn}}'\n`)
  expect((await install('executable', 'claude', exe, mint('install'), '2.0.0')).method).toBe('runtime.installed')
  const tar = makeTar([
    { name: 'node_modules/', type: '5' },
    { name: 'node_modules/@agentclientprotocol/', type: '5' },
    { name: 'node_modules/@agentclientprotocol/claude-agent-acp/', type: '5' },
    { name: 'node_modules/@agentclientprotocol/claude-agent-acp/dist/', type: '5' },
    { name: ADAPTER_PATH, data: ADAPTER_JS }
  ])
  expect((await install('adapter', 'claude-agent-acp', tar, mint('install'), '0.9.0')).method).toBe('runtime.installed')
}

async function importTar(entries: TarEntry[] | Buffer, token = mint('move-in')) {
  const { stream } = await c.call<{ stream: string }>('files.import', { dest: 'agent', token })
  const s = await attach(h.sock, stream)
  s.end(Buffer.isBuffer(entries) ? entries : makeTar(entries))
  return c.waitFor((n) => n.params.stream === stream)
}

describe('hello and layout', () => {
  it('reports fake mode and the layout', async () => {
    h = await startVaultd()
    c = await Client.open(h.sock)
    const before = await c.call<{ fake: boolean; layoutReady: boolean; protocol: number; image: { version: string } }>('hello')
    expect(before).toMatchObject({ protocol: 1, fake: true, layoutReady: false, image: { version: 'fake' } })
    await c.call('layout.ensure')
    expect((await c.call<{ layoutReady: boolean }>('hello')).layoutReady).toBe(true)
    expect(statSync(join(h.root, 'secrets')).mode & 0o777).toBe(0o700)
    const usage = await c.call<{ usedBytes: number; sizeBytes: number }>('disk.usage')
    expect(usage.sizeBytes).toBeGreaterThan(0)
    expect(await c.code('no.such.method')).toBe('-32601')
  })
})

describe('approval tokens', () => {
  beforeEach(() => boot())

  it('refuses a bad signature, another vault, an expired token and the wrong action', async () => {
    const call = (token: string) => c.code('runtime.install', { engine: 'claude', version: '1.0.0', kind: 'executable', name: 'claude', expectedSha256: ANY_SHA, token })
    expect(await call(mint('install'))).toBe('ok')
    expect(await call(mint('install', { key: 'cd'.repeat(32) }))).toBe('bad_token')
    const good = mint('install')
    expect(await call(good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA'))).toBe('bad_token')
    expect(await call(mint('install', { vaultId: 'other-vault' }))).toBe('bad_token')
    expect(await call(mint('install', { exp: Date.now() - 1 }))).toBe('bad_token')
    expect(await call(mint('export'))).toBe('bad_token')
    expect(await call('')).toBe('bad_token')
    expect(await call('garbage')).toBe('bad_token')
  })

  it('lets a session token be reused until it expires', async () => {
    const token = mint('install')
    const params = { engine: 'claude', version: '1.0.0', kind: 'executable', name: 'claude', expectedSha256: ANY_SHA, token }
    expect(await c.code('runtime.install', params)).toBe('ok')
    expect(await c.code('runtime.install', params)).toBe('ok')
    expect(await c.code('exec', { preset: 'check', token })).toBe('ok')
    // install does not authorize an import; move-in does
    expect(await c.code('files.import', { dest: 'agent', token })).toBe('bad_token')
    expect(await c.code('files.import', { dest: 'agent', token: mint('move-in') })).toBe('ok')
  })

  it('spends a single-use token once and binds it to the exact call', async () => {
    writeFileSync(join(h.root, 'agent', 'a.txt'), 'a')
    writeFileSync(join(h.root, 'agent', 'b.txt'), 'b')
    const token = mint('export', { detail: approvalDetail({ method: 'files.export', path: 'a.txt' }) })
    expect(await c.code('files.export', { path: 'b.txt', token })).toBe('bad_token')
    expect(await c.code('files.export', { path: 'a.txt', token })).toBe('ok')
    expect(await c.code('files.export', { path: 'a.txt', token })).toBe('bad_token')
    // move-out covers the whole folder only
    const out = mint('move-out', { detail: approvalDetail({ method: 'move-out' }) })
    expect(await c.code('files.export', { path: 'a.txt', token: out })).toBe('bad_token')
    expect(await c.code('files.export', { path: '.', token: mint('move-out', { detail: approvalDetail({ method: 'move-out' }) }) })).toBe('ok')
    // a terminal needs a terminal token for exec:shell
    expect(await c.code('exec', { preset: 'shell', token: mint('install') })).toBe('bad_token')
    expect(await c.code('exec', { preset: 'shell', token: mint('terminal', { detail: 'exec:uv-sync' }) })).toBe('bad_token')
    expect(await c.code('exec', { preset: 'shell', token: mint('terminal', { detail: approvalDetail({ method: 'exec', preset: 'shell' }) }) })).toBe('ok')
  })

  it('refuses every token when the vault id is unknown', async () => {
    c.close()
    await h.stop()
    h = await startVaultd([], {}, null)
    c = await Client.open(h.sock)
    expect(await c.code('runtime.install', { engine: 'claude', version: '1.0.0', kind: 'executable', name: 'claude', expectedSha256: ANY_SHA, token: mint('install') })).toBe('bad_token')
  })
})

describe('runtime.install', () => {
  beforeEach(() => boot())

  it('hashes what it received, installs it executable and records it', async () => {
    const data = Buffer.from('#!/bin/sh\necho hi\n')
    const n = await install('executable', 'claude', data)
    expect(n.method).toBe('runtime.installed')
    expect(n.params.sha256).toBe(createHash('sha256').update(data).digest('hex'))
    expect(n.params.bytes).toBe(data.length)
    const file = join(h.root, 'runtime', 'claude', '1.0.0', 'claude')
    expect(readFileSync(file)).toEqual(data)
    expect(statSync(file).mode & 0o777).toBe(0o755)
    const status = await c.call<{ runtimes: unknown[] }>('runtime.status')
    expect(status.runtimes).toEqual([{ engine: 'claude', version: '1.0.0', kind: 'executable', sha256: n.params.sha256 }])
    // reinstalling the same version replaces the entry
    await install('executable', 'claude', Buffer.from('#!/bin/sh\n'))
    expect((await c.call<{ runtimes: unknown[] }>('runtime.status')).runtimes).toHaveLength(1)
  })

  it('commits nothing when the bytes are not the pinned ones', async () => {
    const good = Buffer.from('#!/bin/sh\necho good\n')
    expect((await install('executable', 'claude', good)).method).toBe('runtime.installed')
    const pinned = createHash('sha256').update(good).digest('hex')
    // A tampered executable under the same version: refused, the installed one stays.
    const n = await install('executable', 'claude', Buffer.from('#!/bin/sh\necho evil\n'), mint('install'), '1.0.0', pinned)
    expect(n.method).toBe('stream.error')
    expect(String(n.params.message)).toMatch(/sha256 mismatch/)
    expect(readFileSync(join(h.root, 'runtime', 'claude', '1.0.0', 'claude'))).toEqual(good)
    expect((await c.call<{ runtimes: { sha256: string }[] }>('runtime.status')).runtimes).toEqual([expect.objectContaining({ sha256: pinned })])
    // A tampered archive under a new version: never unpacked, never recorded.
    const tar = makeTar([{ name: 'node_modules/x/index.js', data: 'evil' }])
    expect((await install('adapter', 'claude-agent-acp', tar, mint('install'), '2.0.0', 'a'.repeat(64))).method).toBe('stream.error')
    expect(existsSync(join(h.root, 'adapter', 'claude', '2.0.0'))).toBe(false)
    expect((await c.call<{ runtimes: unknown[] }>('runtime.status')).runtimes).toHaveLength(1)
    // Nothing of either attempt is left in tmp.
    expect(readdirSync(join(h.root, 'tmp')).filter((name) => /^(runtime|spool|old)/.test(name))).toEqual([])
  })

  it('reports runtimes in install order, the last of a kind being the one an engine runs', async () => {
    await install('executable', 'claude', Buffer.from('#!/bin/sh\n'), mint('install'), '2.0.0')
    await install('executable', 'claude', Buffer.from('#!/bin/sh\n#1\n'), mint('install'), '1.0.0')
    expect((await c.call<{ runtimes: { version: string }[] }>('runtime.status')).runtimes.map((r) => r.version)).toEqual(['2.0.0', '1.0.0'])
    rmSync(join(h.root, 'runtime', 'claude', '1.0.0'), { recursive: true })
    expect((await c.call<{ runtimes: { version: string }[] }>('runtime.status')).runtimes.map((r) => r.version)).toEqual(['2.0.0'])
  })

  it('extracts an adapter archive into adapter/<engine>/<version>', async () => {
    const n = await install('adapter', 'claude-agent-acp', makeTar([{ name: 'node_modules/x/index.js', data: 'ok' }]))
    expect(n.method).toBe('runtime.installed')
    expect(readFileSync(join(h.root, 'adapter', 'claude', '1.0.0', 'node_modules', 'x', 'index.js'), 'utf8')).toBe('ok')
  })

  it('refuses traversal in version and name, and unsafe archives', async () => {
    const token = mint('install')
    for (const bad of [
      { version: '../x', name: 'claude', kind: 'executable' },
      { version: '1.0.0', name: '../claude', kind: 'executable' },
      { version: '1.0.0', name: 'a/b', kind: 'executable' },
      { version: '..', name: 'claude', kind: 'executable' },
      { version: '1.0.0', name: 'claude', kind: 'bogus' }
    ]) {
      expect(await c.code('runtime.install', { engine: 'claude', token, expectedSha256: ANY_SHA, ...bad })).toBe('invalid')
    }
    expect(await c.code('runtime.install', { engine: 'gpt', version: '1', name: 'x', kind: 'executable', expectedSha256: ANY_SHA, token })).toBe('invalid')
    for (const expectedSha256 of [undefined, '', 'F'.repeat(64), 'a'.repeat(63)]) {
      expect(await c.code('runtime.install', { engine: 'claude', version: '1.0.0', name: 'claude', kind: 'executable', expectedSha256, token })).toBe('invalid')
    }
    const n = await install('adapter', 'a', makeTar([{ name: '../escape.js', data: 'x' }]))
    expect(n.method).toBe('stream.error')
    expect(existsSync(join(h.root, 'adapter', 'claude', 'escape.js'))).toBe(false)
  })
})

describe('files.import', () => {
  beforeEach(() => boot())

  it('imports a normal archive', async () => {
    const n = await importTar([
      { name: 'docs/', type: '5' },
      { name: 'docs/prompt.md', data: 'hello' },
      { name: './scripts/run.py', data: 'print(1)' },
      { name: 'link', type: '2', link: 'docs/prompt.md' }
    ])
    expect(n).toMatchObject({ method: 'files.imported', params: { files: 2, bytes: 13 } })
    expect(readFileSync(join(h.root, 'agent', 'docs', 'prompt.md'), 'utf8')).toBe('hello')
    expect(readFileSync(join(h.root, 'agent', 'link'), 'utf8')).toBe('hello')
    const list = await c.call<{ entries: { name: string; type: string }[] }>('files.list', { path: '' })
    expect(list.entries.map((e) => `${e.name}:${e.type}`)).toEqual(['docs:dir', 'link:link', 'scripts:dir'])
  })

  const evil: [string, TarEntry[]][] = [
    ['a parent reference', [{ name: '../evil.txt', data: 'x' }]],
    ['a nested parent reference', [{ name: 'a/../../evil.txt', data: 'x' }]],
    ['an absolute path', [{ name: '/tmp/vaultd-evil.txt', data: 'x' }]],
    ['an absolute symlink', [{ name: 'etc', type: '2', link: '/etc' }]],
    ['a symlink out of the folder', [{ name: 'up', type: '2', link: '../..' }]],
    ['a symlink through a parent', [{ name: 's', type: '2', link: 'x/..' }]],
    ['a hard link out of the folder', [{ name: 'h', type: '1', link: '../secrets/KEY' }]],
    ['a device', [{ name: 'dev', type: '3' }]]
  ]
  for (const [what, entries] of evil) {
    it(`refuses ${what} and writes nothing`, async () => {
      const n = await importTar([{ name: 'ok.txt', data: 'fine' }, ...entries])
      expect(n.method).toBe('stream.error')
      expect(String(n.params.message)).toMatch(/Archive refused/)
      expect(existsSync(join(h.root, 'evil.txt'))).toBe(false)
      expect(existsSync(join(h.root, 'agent', 'ok.txt'))).toBe(false)
      expect(existsSync('/tmp/vaultd-evil.txt')).toBe(false)
    })
  }

  it('refuses a corrupted header checksum', async () => {
    const tar = makeTar([{ name: 'ok.txt', data: 'x' }])
    tar[0] = 'P'.charCodeAt(0)
    expect((await importTar(tar)).method).toBe('stream.error')
  })
})

describe('files.export and files.list', () => {
  beforeEach(() => boot())

  it('exports a path as tar', async () => {
    mkdirSync(join(h.root, 'agent', 'docs'))
    writeFileSync(join(h.root, 'agent', 'docs', 'a.md'), 'A')
    const token = mint('export', { detail: approvalDetail({ method: 'files.export', path: 'docs' }) })
    const { stream } = await c.call<{ stream: string }>('files.export', { path: 'docs', token })
    const tar = await collect(await attach(h.sock, stream))
    const listing = spawnSync('tar', ['-t', '-f', '-'], { input: tar }).stdout.toString()
    expect(listing.split('\n')).toContain('docs/a.md')
  })

  it('refuses paths outside the agent folder', async () => {
    for (const path of ['../secrets', '/etc', 'a/../../x', '..']) {
      const token = mint('export', { detail: approvalDetail({ method: 'files.export', path }) })
      expect(await c.code('files.export', { path, token })).toBe('invalid')
      expect(await c.code('files.list', { path })).toBe('invalid')
    }
    // a symlink inside the folder pointing out of it
    const { symlinkSync } = await import('node:fs')
    symlinkSync(join(h.root, 'secrets'), join(h.root, 'agent', 'out'))
    expect(await c.code('files.list', { path: 'out' })).toBe('invalid')
  })
})

describe('secrets', () => {
  beforeEach(() => boot())

  it('stores 0600 files, lists names, and never returns a value', async () => {
    const value = 'sk-ant-SECRET-VALUE-123'
    await c.call('secrets.put', { name: 'ANTHROPIC_API_KEY', value })
    const file = join(h.root, 'secrets', 'ANTHROPIC_API_KEY')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await c.call('secrets.list')).toEqual({ names: ['ANTHROPIC_API_KEY'] })
    expect(await c.code('secrets.get', { name: 'ANTHROPIC_API_KEY' })).toBe('-32601')
    expect(await c.code('secrets.put', { name: 'lower', value: 'x' })).toBe('invalid')
    expect(await c.code('secrets.put', { name: 'PATH', value: 'x' })).toBe('invalid')
    expect(await c.code('secrets.put', { name: 'NODE_OPTIONS', value: 'x' })).toBe('invalid')
    expect(await c.code('secrets.put', { name: 'LD_PRELOAD', value: 'x' })).toBe('invalid')
    // Names that would steer an engine, whichever: refused, except an engine's sign-in key.
    for (const name of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'OPENCODE_PERMISSION', 'GOOGLE_CLOUD_PROJECT', 'HTTPS_PROXY', 'MY_SERVICE_BASE_URL', 'BUN_INSTALL', 'XDG_CONFIG_HOME', 'REQUESTS_CA_BUNDLE']) {
      expect(await c.code('secrets.put', { name, value: 'x' })).toBe('invalid')
    }
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GH_TOKEN']) {
      expect(await c.code('secrets.put', { name, value: 'x' })).toBe('ok')
      await c.call('secrets.delete', { name })
    }
    // Nothing a caller can read carries the value.
    const reads = await Promise.all([
      c.call('hello'), c.call('secrets.list'), c.call('runtime.status'), c.call('transcript.list'),
      c.call('kv.get', { key: 'ANTHROPIC_API_KEY' }), c.call('files.list', { path: '' }),
      c.call('auth.status', { engine: 'claude' })
    ])
    expect(JSON.stringify(reads)).not.toContain(value)
    expect(JSON.stringify(c.notifications)).not.toContain(value)
    await c.call('secrets.delete', { name: 'ANTHROPIC_API_KEY' })
    expect(await c.call('secrets.list')).toEqual({ names: [] })
  })
})

describe('engine.spawn and auth', () => {
  beforeEach(() => boot())

  it('refuses env outside the allowlist and a missing runtime', async () => {
    expect(await c.code('engine.spawn', { engine: 'claude', options: { extraEnv: { NODE_OPTIONS: '--require x' } } })).toBe('invalid')
    expect(await c.code('engine.spawn', { engine: 'claude', options: { extraEnv: { PATH: '/tmp' } } })).toBe('invalid')
    // The model comes from the vault's own launch settings, never from main.
    expect(await c.code('engine.spawn', { engine: 'claude', options: { extraEnv: { ANTHROPIC_MODEL: 'opus' } } })).toBe('invalid')
    expect(await c.code('engine.spawn', { engine: 'claude', options: {} })).toBe('unavailable')
    expect(await c.code('engine.spawn', { engine: 'bash', options: {} })).toBe('invalid')
  })

  it('builds the claude command and speaks ACP over the stream', async () => {
    await installFakeClaude()
    await c.call('secrets.put', { name: 'ANTHROPIC_API_KEY', value: 'sk-test' })
    await c.call('secrets.put', { name: 'GH_TOKEN', value: 'gh-user' })
    writeFileSync(join(h.root, 'secrets', 'ANTHROPIC_BASE_URL'), JSON.stringify('https://api.openai.com'), { mode: 0o600 })
    process.env.VAULTD_TEST_LEAK = 'leaked'
    let spawned: { stream: string; pid: number }
    try {
      spawned = await c.call<{ stream: string; pid: number }>('engine.spawn', { engine: 'claude', options: { extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } } })
    } finally {
      delete process.env.VAULTD_TEST_LEAK
    }
    expect(spawned.pid).toBeGreaterThan(0)
    const s = await attach(h.sock, spawned.stream)
    s.setEncoding('utf8')
    const reply = new Promise<string>((resolve) => {
      let buf = ''
      s.on('data', (d: string) => { buf += d; if (buf.includes('\n')) resolve(buf.slice(0, buf.indexOf('\n'))) })
    })
    s.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } }) + '\n')
    const probe = (JSON.parse(await reply) as { result: { probe: { argv: string[]; cwd: string; env: Record<string, string | undefined> } } }).result.probe
    const { realpathSync } = await import('node:fs')
    expect(probe.argv).toEqual([join(h.root, 'adapter', 'claude', '0.9.0', ADAPTER_PATH)])
    expect(realpathSync(probe.cwd)).toBe(realpathSync(join(h.root, 'agent')))
    expect(probe.env).toEqual({
      HOME: join(h.root, 'home'),
      CLAUDE_CODE_EXECUTABLE: join(h.root, 'runtime', 'claude', '2.0.0', 'claude'),
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      ANTHROPIC_API_KEY: 'sk-test',
      // A user's own secret reaches the engine's tools; one that would steer it (stored before the rule) does not.
      GH_TOKEN: 'gh-user',
      UV_CACHE_DIR: join(h.root, 'home', '.cache', 'uv')
    })

    await c.call('engine.kill', { stream: spawned.stream })
    const exit = await c.waitFor((n) => n.method === 'engine.exit' && n.params.stream === spawned.stream)
    expect(exit.params.signal).toBe('SIGTERM')
    expect(exit.params.stderrTail).toContain('fake-adapter-stderr')
    expect(await c.code('engine.kill', { stream: spawned.stream })).toBe('not_found')
  })

  it('kills an engine whose stream is never attached', async () => {
    c.close()
    await h.stop()
    await boot([], { attachTimeoutMs: 150 })
    await installFakeClaude()
    const { stream } = await c.call<{ stream: string }>('engine.spawn', { engine: 'claude', options: {} })
    const exit = await c.waitFor((n) => n.method === 'engine.exit' && n.params.stream === stream)
    expect(exit.params.signal).toBe('SIGTERM')
  })

  it('reports claude auth from secrets or from claude auth status', async () => {
    const keyName = 'ANTHROPIC_API_KEY'
    expect(await c.call('auth.status', { engine: 'claude' })).toEqual({ loggedIn: false, keyName })
    await installFakeClaude(true)
    expect(await c.call('auth.status', { engine: 'claude' })).toEqual({ loggedIn: true, method: 'login', keyName })
    await c.call('secrets.put', { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 't' })
    expect(await c.call('auth.status', { engine: 'claude' })).toEqual({ loggedIn: true, method: 'oauth_token', keyName })
    await c.call('secrets.put', { name: 'ANTHROPIC_API_KEY', value: 'k' })
    expect(await c.call('auth.status', { engine: 'claude' })).toEqual({ loggedIn: true, method: 'api_key', keyName })
  })
})

describe('exec', () => {
  beforeEach(() => boot())

  it('runs the check preset on the stream and reports its exit', async () => {
    const { stream } = await c.call<{ stream: string }>('exec', { preset: 'check', token: mint('move-in') })
    const out = await collect(await attach(h.sock, stream))
    expect(out.toString()).toContain('no check')
    expect((await c.waitFor((n) => n.method === 'exec.exit' && n.params.stream === stream)).params.code).toBe(0)
  })

  it('runs uv-sync as nothing to do without a pyproject', async () => {
    const { stream } = await c.call<{ stream: string }>('exec', { preset: 'uv-sync', token: mint('install') })
    expect((await collect(await attach(h.sock, stream))).toString()).toContain('No pyproject.toml')
  })
})

describe('exec.resize', () => {
  beforeEach(() => boot())
  const shellToken = (): string => mint('terminal', { detail: approvalDetail({ method: 'exec', preset: 'shell' }) })

  it('takes integer sizes for a live shell stream, with no token, and answers {} (fake mode applies nothing)', async () => {
    const { stream } = await c.call<{ stream: string }>('exec', { preset: 'shell', token: shellToken(), cols: 120, rows: 40 })
    expect(await c.call('exec.resize', { stream, cols: 100, rows: 30 })).toEqual({})
    // Out of range is clamped, not refused.
    expect(await c.code('exec.resize', { stream, cols: 1, rows: 10_000 })).toBe('ok')
    for (const bad of [{ cols: 80.5, rows: 24 }, { cols: '80', rows: 24 }, { cols: 80 }, { rows: 24 }, { cols: null, rows: 24 }, { cols: Number.NaN, rows: 24 }]) {
      expect(await c.code('exec.resize', { stream, ...bad })).toBe('invalid')
    }
  })

  it('refuses an unknown stream, a non-shell exec and a shell that has exited', async () => {
    expect(await c.code('exec.resize', { stream: 'nope', cols: 80, rows: 24 })).toBe('not_found')
    expect(await c.code('exec.resize', { cols: 80, rows: 24 })).toBe('not_found')
    const check = await c.call<{ stream: string }>('exec', { preset: 'check', token: mint('move-in') })
    expect(await c.code('exec.resize', { stream: check.stream, cols: 80, rows: 24 })).toBe('not_found')
    await collect(await attach(h.sock, check.stream))

    const { stream } = await c.call<{ stream: string }>('exec', { preset: 'shell', token: shellToken() })
    const s = await attach(h.sock, stream)
    s.end('exit 0\n')
    await collect(s)
    await c.waitFor((n) => n.method === 'exec.exit' && n.params.stream === stream)
    expect(await c.code('exec.resize', { stream, cols: 80, rows: 24 })).toBe('not_found')
  })

  it('refuses a bad initial size on exec before asking anything of the token', async () => {
    expect(await c.code('exec', { preset: 'shell', token: shellToken(), cols: 'wide', rows: 24 })).toBe('invalid')
  })
})

describe('transcripts and kv', () => {
  beforeEach(() => boot())

  it('appends and reads ops in order', async () => {
    const ops = [
      { op: 'put', table: 'messages', row: { id: 'm1', role: 'user', content: 'hi' } },
      { op: 'chat', title: 'T', updatedAt: 5 },
      { op: 'delete', table: 'inflight', id: 'i1' }
    ]
    await c.call('transcript.append', { chatId: 'chat-1', ops: ops.slice(0, 2) })
    await c.call('transcript.append', { chatId: 'chat-1', ops: ops.slice(2) })
    expect(await c.call('transcript.read', { chatId: 'chat-1' })).toEqual({ ops })
    expect(await c.call('transcript.list')).toEqual({ chatIds: ['chat-1'] })
    expect(await c.code('transcript.append', { chatId: '../x', ops })).toBe('invalid')
    expect(await c.code('transcript.append', { chatId: 'c', ops: [{ op: 'drop' }] })).toBe('invalid')
    await c.call('transcript.delete', { chatId: 'chat-1' })
    expect(await c.call('transcript.read', { chatId: 'chat-1' })).toEqual({ ops: [] })
  })

  it('puts and gets values', async () => {
    expect(await c.call('kv.get', { key: 'desktop.json' })).toEqual({ value: null })
    await c.call('kv.put', { key: 'desktop.json', value: { sessions: { a: 1 } } })
    expect(await c.call('kv.get', { key: 'desktop.json' })).toEqual({ value: { sessions: { a: 1 } } })
    await c.call('kv.put', { key: 'desktop.json', value: null })
    expect(await c.call('kv.get', { key: 'desktop.json' })).toEqual({ value: null })
    expect(await c.code('kv.put', { key: '../x', value: 1 })).toBe('invalid')
  })
})

describe('streams', () => {
  it('refuses an unknown, a spent and an expired stream', async () => {
    await boot([], { attachTimeoutMs: 100 })
    const refused = async (stream: string) => (await collect(await attach(h.sock, stream))).length === 0
    expect(await refused('deadbeef')).toBe(true)

    const { stream } = await c.call<{ stream: string }>('exec', { preset: 'check', token: mint('install') })
    const first = await attach(h.sock, stream)
    expect((await collect(first)).toString()).toContain('no check')
    expect(await refused(stream)).toBe(true)

    const late = await c.call<{ stream: string }>('exec', { preset: 'check', token: mint('install') })
    await new Promise((r) => setTimeout(r, 250))
    expect(await refused(late.stream)).toBe(true)
  })

  it('drops a connection with a bad hello', async () => {
    await boot()
    const s = connect(h.sock)
    s.write('{"type":"nope"}\n')
    expect((await collect(s)).length).toBe(0)
  })
})

describe('helper control socket', () => {
  it('acks ping, suspend and resume in fake mode and rejects a bad key', async () => {
    await boot()
    const s = connect(h.helperSock)
    s.setEncoding('utf8')
    const lines: string[] = []
    const got = (n: number) => new Promise<void>((resolve) => {
      const check = () => { if (lines.length >= n) resolve() }
      s.on('data', (d: string) => { lines.push(...d.split('\n').filter(Boolean)); check() })
    })
    const done = got(4)
    s.write('{"op":"ping"}\n{"op":"suspend"}\n{"op":"resume","key":"' + 'aa'.repeat(32) + '"}\n{"op":"resume","key":"zz"}\n')
    await done
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: false, error: 'bad key' }])
    s.destroy()
  })

  it('cuts the resume key out of the line as bytes and refuses anything but 64 lowercase hex', async () => {
    const { takeKey } = await import('../src/helperControl')
    const key = 'c0'.repeat(32)
    const line = Buffer.from(`{"op":"resume", "key" : "${key}"}`)
    const got = takeKey(line)
    expect(Buffer.isBuffer(got) && got.toString('latin1')).toBe(key)
    expect(line.toString('latin1')).toBe(`{"op":"resume", "key" : "${'0'.repeat(64)}"}`)
    expect(JSON.parse(line.toString()).op).toBe('resume')
    for (const bad of ['C0'.repeat(32), 'c0'.repeat(31), 'c0'.repeat(33), 'zz'.repeat(32)]) {
      expect(takeKey(Buffer.from(`{"op":"resume","key":"${bad}"}`))).toBe('bad')
    }
    expect(takeKey(Buffer.from('{"op":"resume","key":12}'))).toBe('bad')
    expect(takeKey(Buffer.from('{"op":"ping"}'))).toBe('none')
  })

  it('hands resume a zeroed-after Buffer, never a string', async () => {
    const seen: unknown[] = []
    await boot([], { helperOps: { async suspend() {}, async resume(k: Buffer) { seen.push(k); seen.push(Buffer.from(k).toString('latin1')) } } })
    const s = connect(h.helperSock)
    const key = '5a'.repeat(32)
    const reply = new Promise<string>((resolve) => s.once('data', (d) => resolve(d.toString())))
    // Split across writes: the line is reassembled from Buffers.
    s.write(`{"op":"resume","key":"${key.slice(0, 20)}`)
    await new Promise((r) => setTimeout(r, 20))
    s.write(`${key.slice(20)}"}\n`)
    expect(JSON.parse(await reply)).toEqual({ ok: true })
    expect(Buffer.isBuffer(seen[0])).toBe(true)
    expect(seen[1]).toBe(key)
    expect((seen[0] as Buffer).every((b) => b === 0)).toBe(true)
    s.destroy()
  })

  it('pushes exec-end with the proxy credential to subscribers when the last exec carrying it ends', async () => {
    await boot([], { attachTimeoutMs: 1000 })
    const s = connect(h.helperSock)
    const lines: Record<string, unknown>[] = []
    s.on('data', (d: Buffer) => lines.push(...d.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)))
    s.write('{"op":"subscribe"}\n')
    await vi.waitFor(() => expect(lines).toEqual([{ ok: true }]))
    const bin = join(h.dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'uv'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    h.vaultd.ctx.config.path = `${bin}:/usr/bin:/bin`
    const cred = 'ab'.repeat(16)
    const token = mint('install', { proxyCred: cred })
    // Two execs on one session token: the credential ends with the second.
    const one = await c.call<{ stream: string }>('exec', { preset: 'rebuild', token })
    const two = await c.call<{ stream: string }>('exec', { preset: 'uv-python-install', token })
    // check and uv-sync never carry the credential, so they push nothing.
    const plain = await c.call<{ stream: string }>('exec', { preset: 'check', token })
    const sync = await c.call<{ stream: string }>('exec', { preset: 'uv-sync', token })
    await collect(await attach(h.sock, sync.stream))
    await c.waitFor((n) => n.method === 'exec.exit' && n.params.stream === sync.stream)
    const a = await attach(h.sock, one.stream)
    await collect(a)
    await c.waitFor((n) => n.method === 'exec.exit' && n.params.stream === one.stream)
    const p = await attach(h.sock, plain.stream)
    await collect(p)
    await c.waitFor((n) => n.method === 'exec.exit' && n.params.stream === plain.stream)
    await new Promise((r) => setTimeout(r, 50))
    expect(lines.filter((l) => l.event)).toEqual([])
    // The second one never attaches: it ends when its stream expires.
    await vi.waitFor(() => expect(lines.filter((l) => l.event)).toEqual([{ event: 'exec-end', proxyCred: cred }]), { timeout: 5000 })
    // The connection still answers ops.
    s.write('{"op":"ping"}\n')
    await vi.waitFor(() => expect(lines.at(-1)).toEqual({ ok: true }))
    s.destroy()
    void two
  })
})

describe('rebuild preset', () => {
  async function withFakeUv(script: string): Promise<string> {
    await boot([], { attachTimeoutMs: 2000 })
    const bin = join(h.dir, 'bin')
    mkdirSync(bin)
    const log = join(h.dir, 'uv.log')
    writeFileSync(join(bin, 'uv'), `#!/bin/sh\necho "$* cred=$(printf %s "$HTTPS_PROXY" | grep -c cinna:)" >> ${log}\n${script}\n`, { mode: 0o755 })
    h.vaultd.ctx.config.path = `${bin}:/usr/bin:/bin`
    h.vaultd.ctx.config.proxyEnv = { HTTPS_PROXY: 'http://127.0.0.1:3128' }
    return log
  }

  async function run(token: string): Promise<{ code: unknown; events: Record<string, unknown>[]; out: string }> {
    const s = connect(h.helperSock)
    const events: Record<string, unknown>[] = []
    s.on('data', (d: Buffer) => events.push(...d.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)))
    s.write('{"op":"subscribe"}\n')
    await vi.waitFor(() => expect(events).toEqual([{ ok: true }]))
    const { stream } = await c.call<{ stream: string }>('exec', { preset: 'rebuild', token })
    const out = (await collect(await attach(h.sock, stream))).toString()
    const exit = await c.waitFor((n) => n.method === 'exec.exit' && n.params.stream === stream)
    await vi.waitFor(() => expect(events.length).toBe(2))
    s.destroy()
    return { code: exit.params.code, events: events.slice(1), out }
  }

  it('installs Python then syncs in one exec with one credential and one exec-end', async () => {
    const log = await withFakeUv('exit 0')
    writeFileSync(join(h.root, 'agent', 'pyproject.toml'), '[project]\nname = "x"\n')
    writeFileSync(join(h.root, 'agent', 'uv.lock'), '')
    const cred = 'cd'.repeat(16)
    const { code, events } = await run(mint('move-in', { proxyCred: cred }))
    expect(code).toBe(0)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['python install cred=1', 'sync --locked --no-build --no-install-project --no-install-workspace cred=1'])
    expect(events).toEqual([{ event: 'exec-end', proxyCred: cred }])
  })

  it('locks first, wheels only, when there is no uv.lock, then syncs, all under the one credential', async () => {
    const log = await withFakeUv('if [ "$1" = lock ]; then : > uv.lock; fi\nexit 0')
    writeFileSync(join(h.root, 'agent', 'pyproject.toml'), '[project]\nname = "x"\n')
    const cred = '12'.repeat(16)
    const { code, events, out } = await run(mint('move-in', { proxyCred: cred }))
    expect(code).toBe(0)
    expect(out).toContain('No uv.lock: resolving and locking the dependencies (wheels only).')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'python install cred=1',
      'lock --no-build cred=1',
      'sync --locked --no-build --no-install-project --no-install-workspace cred=1'
    ])
    expect(events).toEqual([{ event: 'exec-end', proxyCred: cred }])
    expect(existsSync(join(h.root, 'agent', 'uv.lock'))).toBe(true)
  })

  it('stops when the lock fails, and the credential-less sync never locks', async () => {
    const log = await withFakeUv('case "$1" in lock) echo "no wheel for x" >&2; exit 4 ;; esac\nexit 0')
    writeFileSync(join(h.root, 'agent', 'pyproject.toml'), '[project]\nname = "x"\n')
    const { code, out } = await run(mint('install', { proxyCred: '56'.repeat(16) }))
    expect(code).toBe(4)
    expect(out).toContain('no wheel for x')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['python install cred=1', 'lock --no-build cred=1'])
    // uv-sync has no install credential: without a lock it says so and resolves nothing.
    const { stream } = await c.call<{ stream: string }>('exec', { preset: 'uv-sync', token: mint('install') })
    const synced = (await collect(await attach(h.sock, stream))).toString()
    expect(synced).toContain('no uv.lock yet')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('says in plain words when a dependency has no prebuilt wheel', async () => {
    await withFakeUv([
      'case "$1" in sync) ;; *) exit 0 ;; esac',
      'echo "Resolved 2 packages in 1ms" >&2',
      'echo "error: Distribution \\`docopt==0.6.2 @ registry+https://pypi.org/simple\\` can\'t be installed because it is marked as \\`--no-build\\` but has no binary distribution" >&2',
      'exit 2'
    ].join('\n'))
    writeFileSync(join(h.root, 'agent', 'pyproject.toml'), '[project]\nname = "x"\n')
    writeFileSync(join(h.root, 'agent', 'uv.lock'), '')
    const { code, out } = await run(mint('install', { proxyCred: '34'.repeat(16) }))
    expect(code).toBe(2)
    expect(out).toContain('marked as `--no-build`')
    expect(out).toContain("docopt has no prebuilt wheel; packages that build from source can't be installed in a vault yet.")
  })

  it('stops when the Python install fails, and skips sync without a pyproject', async () => {
    const log = await withFakeUv('exit 3')
    const cred = 'ef'.repeat(16)
    const { code, events } = await run(mint('install', { proxyCred: cred }))
    expect(code).toBe(3)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['python install cred=1'])
    expect(events).toEqual([{ event: 'exec-end', proxyCred: cred }])
    expect(await c.code('exec', { preset: 'rebuild', token: mint('terminal', { detail: 'exec:rebuild' }) })).toBe('bad_token')
  })
})

describe('limits', () => {
  it('drops a control line over 1 MiB, but takes a transcript batch up to 8 MiB', async () => {
    await boot()
    const big = 'x'.repeat(2 * 1024 * 1024)
    const ok = await c.call('transcript.append', { chatId: 'c1', ops: [{ op: 'put', table: 'messages', row: { id: 'm1', content: big } }] })
    expect(ok).toEqual({})
    const other = await Client.open(h.sock)
    const closed = new Promise<void>((resolve) => (other as unknown as { socket: import('node:net').Socket }).socket.once('close', () => resolve()))
    void other.call('kv.put', { key: 'k', value: big }).catch(() => {})
    await closed
    const huge = await Client.open(h.sock)
    const hugeClosed = new Promise<void>((resolve) => (huge as unknown as { socket: import('node:net').Socket }).socket.once('close', () => resolve()))
    void huge.call('transcript.append', { chatId: 'c1', ops: [{ op: 'put', table: 'messages', row: { id: 'm2', content: 'y'.repeat(9 * 1024 * 1024) } }] }).catch(() => {})
    await hugeClosed
    expect(await c.call('kv.get', { key: 'k' })).toEqual({ value: null })
  })

  it('refuses a seventeenth control connection', async () => {
    await boot()
    const more: Client[] = []
    for (let i = 0; i < 15; i++) more.push(await Client.open(h.sock))
    await Promise.all(more.map((m) => m.call('hello')))
    const extra = await Client.open(h.sock)
    const closed = new Promise<void>((resolve) => (extra as unknown as { socket: import('node:net').Socket }).socket.once('close', () => resolve()))
    void extra.call('hello').catch(() => {})
    await closed
    more.pop()!.close()
    await new Promise((r) => setTimeout(r, 50))
    const again = await Client.open(h.sock)
    expect(await again.call<{ protocol: number }>('hello')).toMatchObject({ protocol: 1 })
    for (const m of [...more, again]) m.close()
  })
})

describe('spent nonces', () => {
  it('survive a vaultd restart through the spent-nonce file', async () => {
    const { TokenVerifier } = await import('../src/tokens')
    const file = join(mkdtempSync(join(tmpdir(), 'vdn-')), 'spent-nonces')
    const source = { approvalKey: Buffer.from(KEY_HEX, 'hex'), approvalKeyFile: null, vaultId: VAULT_ID, vaultIdFile: null, spentNoncesFile: file }
    const detail = approvalDetail({ method: 'exec', preset: 'shell' })
    const need = { actions: ['terminal'] as const, detail: () => detail }
    const token = mint('terminal', { detail })
    new TokenVerifier(source).verify(token, need)
    expect(() => new TokenVerifier(source).verify(token, need)).toThrow('Approval already used.')
    // Without the file a restarted verifier would have taken it again.
    expect(() => new TokenVerifier({ ...source, spentNoncesFile: null }).verify(token, need)).not.toThrow()
    // Expired nonces are pruned from the file.
    let now = Date.now()
    const v = new TokenVerifier(source, () => now)
    now += 120_000
    v.verify(mint('terminal', { detail, exp: now + 60_000 }), need)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('passes the key to cryptsetup on stdin, not argv', async () => {
    const { cryptsetupOps } = await import('../src/helperControl')
    // A fake cryptsetup on PATH that records its argv and stdin.
    h = await startVaultd()
    c = await Client.open(h.sock)
    const bin = join(h.dir, 'bin')
    mkdirSync(bin)
    const log = join(h.dir, 'cs.log')
    writeFileSync(join(bin, 'cryptsetup'), `#!/bin/sh\necho "argv:$*" >> ${log}\necho "stdin:$(cat)" >> ${log}\n`, { mode: 0o755 })
    const ops = cryptsetupOps(`${bin}:/usr/bin:/bin`)
    const key = 'ef'.repeat(32)
    await ops.resume(Buffer.from(key))
    await ops.suspend()
    const text = readFileSync(log, 'utf8')
    expect(text).toContain('argv:luksResume vault --key-file=-')
    expect(text).toContain(`stdin:${key}`)
    expect(text).toContain('argv:luksSuspend vault')
    expect(text.split('\n').filter((l) => l.startsWith('argv:')).join('\n')).not.toContain(key)
  })
})

describe('bundle', () => {
  const bundle = join(__dirname, '..', '..', '..', '..', '..', 'out', 'main', 'vaultd.js')
  it.skipIf(!existsSync(bundle))('starts from out/main/vaultd.js in fake mode', async () => {
    h = await startVaultd()
    await h.vaultd.close()
    const sock = join(h.dir, 'b.sock')
    const child = spawn(process.execPath, [bundle, '--fake', '--root', join(h.dir, 'broot'), '--listen', sock, '--approval-key', KEY_HEX, '--vault-id', VAULT_ID], { stdio: 'ignore' })
    try {
      for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50))
      c = await Client.open(sock)
      expect(await c.call('hello')).toMatchObject({ protocol: 1, fake: true })
    } finally {
      child.kill()
    }
  })
})
