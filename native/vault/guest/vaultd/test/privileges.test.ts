/**
 * D36/D37 in guest mode (users set), on a host that cannot switch uid: spawn
 * and lchown are recorded, then run without the uid/gid (spawn) or skipped
 * (lchown). The real switch is checked in the VM by scripts/vault/guest-smoke.mjs.
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawns: { command: string; args: string[]; uid?: number; gid?: number; env: Record<string, string> }[] = []
const chowns = new Map<string, [number, number]>()

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      const rest = options as { env: Record<string, string> }
      if (command !== '/usr/bin/setpriv') {
        spawns.push({ command, args, env: rest.env })
        return real.spawn(command, args, rest)
      }
      // Unwrap the setpriv drop: record who it switches to, check it drops everything, run the rest.
      const sep = args.indexOf('--')
      const flags = args.slice(0, sep)
      expect(flags).toEqual(expect.arrayContaining(['--clear-groups', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all']))
      const num = (name: string): number => Number(flags.find((f) => f.startsWith(name + '='))?.split('=')[1])
      const [cmd, ...cmdArgs] = args.slice(sep + 1)
      spawns.push({ command: cmd, args: cmdArgs, uid: num('--reuid'), gid: num('--regid'), env: rest.env })
      return real.spawn(cmd, cmdArgs, rest)
    }
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, lchownSync: (path: string, uid: number, gid: number) => { chowns.set(path, [uid, gid]) } }
})

const { GUEST_USERS, layoutOf, parseArgs } = await import('../src/config')
const { createVaultd } = await import('../src/server')
const { setQuiet } = await import('../src/util')
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { attach, Client, collect, KEY_HEX, makeTar, mint, VAULT_ID } = await import('./harness')
type Client = import('./harness').Client
const { approvalDetail } = await import('../../../../../src/shared/vault/protocol')

const GUEST_PROXY = 'http://127.0.0.1:3128'
const CRED = '0123456789abcdef0123456789abcdef'

let dir = ''
let stop: (() => Promise<void>) | null = null

afterEach(async () => {
  await stop?.()
  stop = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  spawns.length = 0
  chowns.clear()
})

async function guestVaultd(): Promise<{ c: Client; sock: string; root: string }> {
  setQuiet(true)
  dir = mkdtempSync(join(tmpdir(), 'vdp-'))
  const root = join(dir, 'root')
  const sock = join(dir, 'v.sock')
  // A uv that does nothing, so the install presets never reach the network.
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const config = {
    ...parseArgs(['--fake', '--root', root, '--listen', sock, '--approval-key', KEY_HEX, '--vault-id', VAULT_ID]),
    path: `${bin}:/usr/bin:/bin`,
    users: GUEST_USERS,
    proxyEnv: { HTTPS_PROXY: GUEST_PROXY, HTTP_PROXY: GUEST_PROXY, https_proxy: GUEST_PROXY, http_proxy: GUEST_PROXY, NO_PROXY: 'localhost,127.0.0.1' }
  }
  const vaultd = createVaultd(config)
  await vaultd.listen()
  const c = await Client.open(sock)
  stop = async () => { c.close(); await vaultd.close() }
  await c.call('layout.ensure')
  return { c, sock, root }
}

async function runExec(c: Client, sock: string, preset: string, token: string): Promise<void> {
  const { stream } = await c.call<{ stream: string }>('exec', { preset, token })
  const s = await attach(sock, stream)
  if (preset === 'shell') s.end('exit\n')
  await collect(s)
  await c.waitFor((n) => n.method === 'exec.exit' && n.params.stream === stream)
}

const mode = (path: string): number => lstatSync(path).mode & 0o777
/** Owner set on a path ending in `rel` (trees are chowned in vaultd's staging dir, then renamed into place). */
const ownerOf = (rel: string): [number, number] | undefined =>
  [...chowns].find(([path]) => path.endsWith('/' + rel))?.[1]

describe('guest users (D36)', () => {
  it('gives the layout its owners: agent folder and home to agent, uv cache and Python to build, the rest to root', async () => {
    const { root } = await guestVaultd()
    const l = layoutOf(root)
    expect(chowns.get(l.agent)).toEqual([1000, 1000])
    expect(chowns.get(l.home)).toEqual([1000, 1000])
    expect(chowns.get(l.uvCache)).toEqual([1001, 1001])
    expect(chowns.get(l.python)).toEqual([1001, 1001])
    expect(chowns.get(l.buildHome)).toEqual([1001, 1001])
    expect(chowns.get(l.userTmp)).toEqual([0, 1000])
    for (const d of [l.secrets, l.transcripts, l.state, l.tmp, l.runtime, l.adapter]) expect(chowns.get(d)).toEqual([0, 0])
    expect(mode(l.home)).toBe(0o700)
    expect(mode(l.secrets)).toBe(0o700)
    expect(mode(l.agent)).toBe(0o775)
  })

  it('runs install and check presets as build, gives the proxy credential only to rebuild and uv-python-install, the terminal as agent without it', async () => {
    const { c, sock, root } = await guestVaultd()
    writeFileSync(join(root, 'agent', 'pyproject.toml'), '[project]\nname = "x"\n')
    writeFileSync(join(root, 'agent', 'uv.lock'), '')
    mkdirSync(join(root, 'agent', '.cinna-kit', 'tools'), { recursive: true })
    writeFileSync(join(root, 'agent', '.cinna-kit', 'tools', 'kit.py'), '')
    const token = mint('move-in', { proxyCred: CRED })
    for (const preset of ['rebuild', 'uv-python-install', 'uv-sync', 'check']) await runExec(c, sock, preset, token)
    await runExec(c, sock, 'shell', mint('terminal', { detail: approvalDetail({ method: 'exec', preset: 'shell' }) }))
    const script = (s: (typeof spawns)[number]): string => s.args.join(' ')
    const rebuild = spawns.find((s) => script(s).includes('uv python install') && script(s).includes('uv sync'))!
    const python = spawns.find((s) => script(s) === '-c exec uv python install')!
    const sync = spawns.find((s) => script(s).includes('uv sync') && !script(s).includes('uv python install'))!
    const check = spawns.find((s) => s.command === 'uv' && script(s).includes('kit.py'))!
    const shell = spawns.find((s) => s.command === 'script')!
    for (const s of [rebuild, python, sync, check]) {
      expect([s.uid, s.gid]).toEqual([1001, 1000])
      expect(s.env.HOME).toBe(layoutOf(root).buildHome)
    }
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(rebuild.env[name]).toBe(`http://cinna:${CRED}@127.0.0.1:3128`)
      expect(python.env[name]).toBe(`http://cinna:${CRED}@127.0.0.1:3128`)
      // check runs the agent's own kit.py; uv-sync only reads the cache.
      expect(check.env[name]).toBe(GUEST_PROXY)
      expect(sync.env[name]).toBe(GUEST_PROXY)
      expect(shell.env[name]).toBe(GUEST_PROXY)
    }
    expect([shell.uid, shell.gid]).toEqual([1000, 1000])
    expect(shell.env.HOME).toBe(layoutOf(root).home)
  })

  it('runs the engine, its settings write and claude auth as agent, never with a proxy credential', async () => {
    const { c, sock, root } = await guestVaultd()
    const install = async (kind: string, name: string, data: Buffer, version: string): Promise<void> => {
      const { stream } = await c.call<{ stream: string }>('runtime.install', { engine: 'claude', version, kind, name, expectedSha256: createHash('sha256').update(data).digest('hex'), token: mint('install', { proxyCred: CRED }) })
      const s = await attach(sock, stream)
      s.end(data)
      expect((await c.waitFor((n) => n.params.stream === stream)).method).toBe('runtime.installed')
    }
    await install('executable', 'claude', Buffer.from('#!/bin/sh\necho \'{"loggedIn":false}\'\n'), '2.0.0')
    const entry = 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
    await install('adapter', 'claude-agent-acp', makeTar([
      { name: 'node_modules/', type: '5', mode: 0o777 },
      { name: 'node_modules/@agentclientprotocol/', type: '5' },
      { name: 'node_modules/@agentclientprotocol/claude-agent-acp/', type: '5' },
      { name: 'node_modules/@agentclientprotocol/claude-agent-acp/dist/', type: '5' },
      { name: entry, data: 'setInterval(() => {}, 1000)', mode: 0o666 }
    ]), '0.9.0')
    // Runtimes: root-owned, readable and runnable by all, writable by none.
    const exe = join(root, 'runtime', 'claude', '2.0.0', 'claude')
    expect(ownerOf('claude')).toEqual([0, 0])
    expect(mode(exe)).toBe(0o755)
    const adapterDir = join(root, 'adapter', 'claude', '0.9.0')
    expect(mode(join(adapterDir, 'node_modules'))).toBe(0o755)
    expect(mode(join(adapterDir, entry))).toBe(0o644)
    expect(ownerOf(entry)).toEqual([0, 0])

    spawns.length = 0
    const { stream } = await c.call<{ stream: string }>('engine.spawn', { engine: 'claude', options: { mode: 'default' } })
    await c.call('auth.status', { engine: 'claude' })
    await c.call('engine.kill', { stream })
    expect(spawns.length).toBe(3)
    for (const s of spawns) {
      expect([s.uid, s.gid]).toEqual([1000, 1000])
      expect(JSON.stringify(s.env)).not.toContain('cinna:')
    }
    expect(JSON.parse(readFileSync(join(root, 'home', '.claude', 'settings.json'), 'utf8'))).toEqual({ permissions: { defaultMode: 'default' } })
  })

  it('exports with tar running as agent', async () => {
    const { c, sock, root } = await guestVaultd()
    const { writeFileSync: write } = await import('node:fs')
    write(join(layoutOf(root).agent, 'a.txt'), 'a')
    spawns.length = 0
    const token = mint('export', { detail: approvalDetail({ method: 'files.export', path: 'a.txt' }) })
    const { stream } = await c.call<{ stream: string }>('files.export', { path: 'a.txt', token })
    const out = await collect(await attach(sock, stream))
    expect(out.length).toBeGreaterThan(0)
    await vi.waitFor(() => expect(spawns.find((s) => s.command === 'tar')).toBeDefined())
    const tar = spawns.find((s) => s.command === 'tar')!
    expect([tar.uid, tar.gid]).toEqual([1000, 1000])
  })

  it('stats and reads agent files with node running as agent', async () => {
    const { c, root } = await guestVaultd()
    writeFileSync(join(layoutOf(root).agent, 'a.txt'), 'hi')
    spawns.length = 0
    expect((await c.call<{ entries: { type: string }[] }>('files.stat', { paths: ['a.txt'] })).entries[0].type).toBe('file')
    const read = await c.call<{ bytes: string }>('files.read', { path: 'a.txt', maxBytes: 10 })
    expect(Buffer.from(read.bytes, 'base64').toString()).toBe('hi')
    expect(spawns.length).toBe(2)
    for (const s of spawns) {
      expect(s.args[0]).toBe('-e')
      expect([s.uid, s.gid]).toEqual([1000, 1000])
    }
  })

  it('hands imported files to agent, group-writable', async () => {
    const { c, sock, root } = await guestVaultd()
    const { stream } = await c.call<{ stream: string }>('files.import', { dest: 'agent', token: mint('move-in') })
    const s = await attach(sock, stream)
    s.end(makeTar([
      { name: 'src/', type: '5', mode: 0o700 },
      { name: 'src/run.sh', data: 'echo', mode: 0o700 },
      { name: 'README.md', data: 'x', mode: 0o600 }
    ]))
    expect((await c.waitFor((n) => n.params.stream === stream)).method).toBe('files.imported')
    const agent = layoutOf(root).agent
    for (const p of ['src', 'src/run.sh', 'README.md']) expect(ownerOf(p)).toEqual([1000, 1000])
    expect(mode(join(agent, 'src'))).toBe(0o775)
    expect(mode(join(agent, 'src', 'run.sh'))).toBe(0o775)
    expect(mode(join(agent, 'README.md'))).toBe(0o664)
  })
})
