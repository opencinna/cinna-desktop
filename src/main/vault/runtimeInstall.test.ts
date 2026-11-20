import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mint, startVaultd, type Harness } from '../../../native/vault/guest/vaultd/test/harness'
import { RUNTIME_PINS } from '../../shared/runtimePins'
import type { VaultChannel } from './backend'
import { VaultdClient } from './vaultdClient'
import { installRuntimeHost } from '../host/runtimeHost'
import { adapterClosure, ADAPTER_TAR_PATH, claudeAdapterFiles, closureFiles, CODEX_ADAPTER_TAR_PATH, codexAdapterFiles, deterministicTar, deterministicTarSha256, deterministicTarSize, ensureClaudeAdapterTar, ensureCodexAdapterTar, writeClaudeAdapterTar, writeDeterministicTar } from './adapterTar'
import { codexAdapterVersionLabel, defaultRuntimeSource, matchesPin, pinnedVaultRuntimes, ensureRuntimes, hostRuntimeSource, claudeAdapterVersionLabel, installRuntimeArtifact, pinnedVaultVersions, tarFiles } from './runtimeInstall'
import { installedRuntime } from '../agents/drivers/acp/vaultLauncher'

/**
 * D28 against the real cinna-vaultd (in process, fake mode): this app's own
 * patched Claude adapter and its dependency closure, tarred the way a move
 * sends them, pass the guest's archive check and land where `engine.spawn`
 * looks; the hash main computed is the one the guest reports.
 */

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))

let harness: Harness | null = null

afterEach(async () => {
  await harness?.stop()
  harness = null
})

async function channelTo(sock: string): Promise<VaultChannel> {
  const socket = connect(sock)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const web = Duplex.toWeb(socket) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
  return { readable: web.readable, writable: web.writable, close: () => socket.destroy() }
}

describe('vault runtime install (D28)', () => {
  it('computes the adapter closure without any Claude Agent SDK platform binary', () => {
    const root = process.cwd()
    const packages = adapterClosure(root)
    expect(packages).toContain('node_modules/@agentclientprotocol/claude-agent-acp')
    expect(packages).toContain('node_modules/@agentclientprotocol/sdk')
    expect(packages).toContain('node_modules/@anthropic-ai/claude-agent-sdk')
    expect(packages).toContain('node_modules/zod')
    expect(packages).toContain('node_modules/diff')
    expect(packages.filter((p) => p.includes('claude-agent-sdk-'))).toEqual([])
    const files = closureFiles(root, packages)
    expect(files.some((f) => /\/node_modules\/[^/]+\/node_modules\//.test(f) && f.startsWith('node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-'))).toBe(false)
    expect(files).toEqual([...files].sort())
  })

  it('streams the real adapter closure into vaultd, which accepts the archive and reports main\'s hash', async () => {
    harness = await startVaultd()
    const root = process.cwd()
    // The adapter in this checkout is the patched one the app pins.
    const entry = join(root, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js')
    expect(createHash('sha256').update(readFileSync(entry)).digest('hex')).toBe(RUNTIME_PINS.claude.adapterPatchedSha256)
    const files = closureFiles(root, adapterClosure(root))
    const sock = harness.sock
    const client = await VaultdClient.connect(await channelTo(sock), { openChannel: () => channelTo(sock) })
    try {
      await client.request('layout.ensure', {})
      const version = claudeAdapterVersionLabel()
      const result = await installRuntimeArtifact(client, {
        engine: 'claude', version, kind: 'adapter', name: 'claude-agent-acp',
        open: () => tarFiles(root, files), expectedSha256: null
      }, mint('move-in'))
      expect(result.bytes).toBeGreaterThan(1_000_000)
      const { runtimes } = await client.request('runtime.status', {})
      expect(runtimes).toEqual([{ engine: 'claude', version, kind: 'adapter', sha256: result.sha256 }])
      const installed = join(harness.root, 'adapter', 'claude', version, 'node_modules')
      expect(existsSync(join(installed, '@agentclientprotocol/claude-agent-acp/dist/index.js'))).toBe(true)
      expect(readFileSync(join(installed, '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'))).toEqual(readFileSync(entry))
      expect(existsSync(join(installed, '@agentclientprotocol/sdk/package.json'))).toBe(true)
    } finally {
      client.close()
    }
  }, 60_000)

  it('pins the whole adapter closure: the deterministic tar of this checkout equals runtimePins (npm run vault:pin-adapter prints it)', async () => {
    const root = process.cwd()
    const files = claudeAdapterFiles(root)
    const first = await deterministicTarSha256(root, files)
    if (process.env['CINNA_PRINT_ADAPTER_PIN']) console.log(`vaultAdapterTarSha256: '${first.sha256}' (${first.bytes} bytes, ${files.length} files)`)
    // Deterministic: the same tree, the same bytes.
    expect(await deterministicTarSha256(root, files)).toEqual(first)
    expect(first.sha256, 'update RUNTIME_PINS.claude.vaultAdapterTarSha256 (npm run vault:pin-adapter)').toBe(RUNTIME_PINS.claude.vaultAdapterTarSha256)
  }, 60_000)

  it('the deterministic tar passes the guest archive check and a changed closure byte changes its hash', async () => {
    harness = await startVaultd()
    const root = process.cwd()
    const files = claudeAdapterFiles(root)
    const sock = harness.sock
    const client = await VaultdClient.connect(await channelTo(sock), { openChannel: () => channelTo(sock) })
    try {
      await client.request('layout.ensure', {})
      const { sha256 } = await deterministicTarSha256(root, files)
      const result = await installRuntimeArtifact(client, {
        engine: 'claude', version: claudeAdapterVersionLabel(), kind: 'adapter', name: 'claude-agent-acp',
        open: () => deterministicTar(root, files), expectedSha256: sha256
      }, mint('move-in'))
      expect(result.sha256).toBe(sha256)
      const installed = join(harness.root, 'adapter', 'claude', claudeAdapterVersionLabel(), 'node_modules')
      expect(readFileSync(join(installed, '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'))).toEqual(readFileSync(join(root, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js')))
      // A modified closure (one byte appended to a dependency, as the stream
      // would carry it) is refused against the pin by the guest, before it commits.
      await expect(installRuntimeArtifact(client, {
        engine: 'claude', version: 'tampered', kind: 'adapter', name: 'claude-agent-acp',
        open: async function* () { for await (const chunk of deterministicTar(root, files)) yield chunk; yield Buffer.alloc(512) },
        expectedSha256: sha256
      }, mint('move-in'))).rejects.toThrow(/does not match what this app pins/)
    } finally {
      client.close()
    }
  }, 60_000)

  it('a source streams the tar the build wrote, and refuses one that differs from the pin before anything is streamed', async () => {
    const appPath = mkdtempSync(join(tmpdir(), 'adapter-app-'))
    try {
      installRuntimeHost({ isPackaged: false, getAppPath: () => appPath } as never)
      const source = hostRuntimeSource(async () => '/bin/sh')
      // No tar built: a readable refusal naming the build step.
      await expect(source.artifacts('claude')).rejects.toThrow(/electron-vite build/)
      const tar = join(appPath, ...ADAPTER_TAR_PATH.split('/'))
      const written = await writeClaudeAdapterTar(process.cwd(), tar)
      expect(written.sha256).toBe(RUNTIME_PINS.claude.vaultAdapterTarSha256)
      const adapter = (await source.artifacts('claude')).find((a) => a.kind === 'adapter')!
      expect(adapter.expectedSha256).toBe(RUNTIME_PINS.claude.vaultAdapterTarSha256)
      const streamed = createHash('sha256')
      for await (const chunk of adapter.open()) streamed.update(chunk)
      expect(streamed.digest('hex')).toBe(RUNTIME_PINS.claude.vaultAdapterTarSha256)
      // One byte changed in the shipped tar: refused by its hash.
      const bytes = readFileSync(tar)
      bytes[bytes.length - 2000] ^= 1
      writeFileSync(tar, bytes)
      await expect(source.artifacts('claude')).rejects.toThrow(/not the ones this app pins/)
    } finally {
      rmSync(appPath, { recursive: true, force: true })
    }
  }, 60_000)

  it('the fake backend’s source sets up Codex too: this computer’s codex and the Codex adapter tar, which vaultd installs as set up', async () => {
    harness = await startVaultd()
    const sock = harness.sock
    const appPath = mkdtempSync(join(tmpdir(), 'host-codex-app-'))
    const client = await VaultdClient.connect(await channelTo(sock), { openChannel: () => channelTo(sock) })
    try {
      installRuntimeHost({ isPackaged: false, getAppPath: () => appPath } as never)
      const hostCodex = join(appPath, 'codex')
      writeFileSync(hostCodex, '#!/bin/sh\necho host codex\n', { mode: 0o755 })
      const source = hostRuntimeSource(async () => '/bin/sh', async () => hostCodex)
      // No Codex adapter tar built: refused in words naming the build step.
      await expect(source.artifacts('codex')).rejects.toThrow(/No Codex adapter tar.*electron-vite build/)
      await writeDeterministicTar(process.cwd(), codexAdapterFiles(process.cwd()), join(appPath, ...CODEX_ADAPTER_TAR_PATH.split('/')))
      const hostVersion = `${RUNTIME_PINS.codex.cli}-host`
      expect(source.pins('codex')).toEqual([
        { engine: 'codex', kind: 'executable', version: hostVersion, sha256: null },
        { engine: 'codex', kind: 'adapter', version: codexAdapterVersionLabel(), sha256: RUNTIME_PINS.codex.vaultAdapterTarSha256,
          accepted: [{ version: codexAdapterVersionLabel(RUNTIME_PINS.codex.vaultAdapterEarlier.patchedSha256), sha256: RUNTIME_PINS.codex.vaultAdapterEarlier.tarSha256 }] }
      ])
      const artifacts = await source.artifacts('codex')
      expect(artifacts.map((a) => `${a.kind}:${a.name}:${a.version}`)).toEqual([`executable:codex:${hostVersion}`, `adapter:codex-acp:${codexAdapterVersionLabel()}`])

      await client.request('layout.ensure', {})
      await ensureRuntimes(client, source, 'codex', mint('install'))
      const { runtimes } = await client.request('runtime.status', {})
      expect(installedRuntime(runtimes, 'codex', source.pins('codex'))).not.toBe('missing')
      expect(installedRuntime(runtimes, 'codex', source.pins('codex'))).not.toBe('not_pinned')
      // Where vaultd's engine.spawn finds it (CODEX_PATH): the host bytes.
      expect(readFileSync(join(harness.root, 'runtime', 'codex', hostVersion, 'codex'), 'utf8')).toBe('#!/bin/sh\necho host codex\n')

      // A Codex the app cannot resolve, and the engines with Linux builds only, say so.
      const unresolved = hostRuntimeSource(async () => '/bin/sh', async () => { throw new Error('Codex is not installed') })
      await expect(unresolved.artifacts('codex')).rejects.toThrow(/Codex is not available on this computer: Codex is not installed/)
      await expect(source.artifacts('opencode')).rejects.toThrow(/Claude or Codex only, not opencode/)
      expect(source.pins('opencode')).toEqual([])
      expect(hostRuntimeSource(async () => '/bin/sh').pins('codex')).toEqual([])
    } finally {
      client.close()
      rmSync(appPath, { recursive: true, force: true })
    }
  }, 60_000)

  it('the fake backend’s source sets up Antigravity from this computer’s server, with no adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-agy-'))
    try {
      const server = join(dir, 'agy_acp_server.par')
      writeFileSync(server, '#!/bin/sh\necho host antigravity\n', { mode: 0o755 })
      const source = hostRuntimeSource(async () => '/bin/sh', async () => '/bin/sh', async () => server)
      const version = `${RUNTIME_PINS.antigravity.cli}-host`
      expect(source.pins('antigravity')).toEqual([{ engine: 'antigravity', kind: 'executable', version, sha256: null }])
      const artifacts = await source.artifacts('antigravity')
      expect(artifacts.map((a) => `${a.kind}:${a.name}:${a.version}`)).toEqual([`executable:antigravity:${version}`])
      await expect(source.artifacts('opencode')).rejects.toThrow(/Claude, Codex or Antigravity only, not opencode/)
      expect(hostRuntimeSource(async () => '/bin/sh', async () => '/bin/sh').pins('antigravity')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the build writes the adapter tar once and leaves an already pinned one alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-out-'))
    try {
      const root = process.cwd()
      const out = join(dir, 'claude-adapter.tar')
      const pin = RUNTIME_PINS.claude.vaultAdapterTarSha256
      const first = await ensureClaudeAdapterTar(root, out, pin)
      expect(first).toMatchObject({ sha256: pin, written: true })
      expect(deterministicTarSize(root, claudeAdapterFiles(root))).toBe(first.bytes)
      // Unchanged: not rewritten (the file is left as it was, mtime included).
      const marker = new Date(2000, 0, 1)
      utimesSync(out, marker, marker)
      expect(await ensureClaudeAdapterTar(root, out, pin)).toMatchObject({ sha256: pin, written: false })
      expect(statSync(out).mtimeMs).toBe(marker.getTime())
      // Same size, one byte different: hashed, found wrong, rewritten.
      const bytes = readFileSync(out)
      bytes[600] ^= 1
      writeFileSync(out, bytes)
      expect(await ensureClaudeAdapterTar(root, out, pin)).toMatchObject({ sha256: pin, written: true })
      // A pin this tar is not: rewritten every time rather than skipped.
      expect(await ensureClaudeAdapterTar(root, out, 'f'.repeat(64))).toMatchObject({ sha256: pin, written: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('pins the whole adapter closure of Codex too: codex-acp alone, a bundle that imports nothing but Node builtins', async () => {
    const root = process.cwd()
    const files = codexAdapterFiles(root)
    expect(files).toEqual([
      'node_modules/@agentclientprotocol/codex-acp/LICENSE',
      'node_modules/@agentclientprotocol/codex-acp/dist/index.js',
      'node_modules/@agentclientprotocol/codex-acp/package.json'
    ])
    // The patched adapter the app pins (a codex-acp bump or patch change moves both pins).
    const entry = readFileSync(join(root, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'))
    expect(createHash('sha256').update(entry).digest('hex')).toBe(RUNTIME_PINS.codex.adapterPatchedSha256)
    // Nothing but builtins: none of its declared dependencies (@openai/codex's own binary among them) is needed.
    const specifiers = [...entry.toString('utf8').matchAll(/(?:__require|require)\("([^"]+)"\)|from "([^"]+)"|import\("([^"]+)"\)/g)].map((m) => m[1] ?? m[2] ?? m[3]!)
    const builtins = new Set((await import('node:module')).builtinModules)
    expect(specifiers.filter((name) => !name.startsWith('node:') && !builtins.has(name))).toEqual([])
    const first = await deterministicTarSha256(root, files)
    if (process.env['CINNA_PRINT_ADAPTER_PIN']) console.log(`codex vaultAdapterTarSha256: '${first.sha256}' (${first.bytes} bytes, ${files.length} files)`)
    expect(first.sha256, 'update RUNTIME_PINS.codex.vaultAdapterTarSha256 (npm run vault:pin-adapter)').toBe(RUNTIME_PINS.codex.vaultAdapterTarSha256)
  })

  it('the Codex adapter tar lands where vaultd starts it, and the build writes it once', async () => {
    harness = await startVaultd()
    const dir = mkdtempSync(join(tmpdir(), 'codex-adapter-out-'))
    const sock = harness.sock
    const client = await VaultdClient.connect(await channelTo(sock), { openChannel: () => channelTo(sock) })
    try {
      const out = join(dir, 'codex-adapter.tar')
      const pin = RUNTIME_PINS.codex.vaultAdapterTarSha256
      expect(await ensureCodexAdapterTar(process.cwd(), out, pin)).toMatchObject({ sha256: pin, written: true })
      expect(await ensureCodexAdapterTar(process.cwd(), out, pin)).toMatchObject({ sha256: pin, written: false })
      await client.request('layout.ensure', {})
      const version = codexAdapterVersionLabel()
      await installRuntimeArtifact(client, {
        engine: 'codex', version, kind: 'adapter', name: 'codex-acp',
        open: async function* () { yield readFileSync(out) }, expectedSha256: pin
      }, mint('move-in'))
      // vaultd engine.ts ADAPTER_ENTRY.codex
      expect(existsSync(join(harness.root, 'adapter', 'codex', version, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'))).toBe(true)
    } finally {
      client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('names the pinned versions of every engine, and refuses runtime files on this computer that are not the pinned ones', async () => {
    expect(pinnedVaultVersions('codex')).toEqual({ executable: RUNTIME_PINS.codex.cli, adapter: codexAdapterVersionLabel() })
    expect(pinnedVaultVersions('opencode')).toEqual({ executable: RUNTIME_PINS.opencode.cli, adapter: null })
    expect(pinnedVaultVersions('antigravity')).toEqual({ executable: RUNTIME_PINS.antigravity.cli, adapter: null })
    const appPath = mkdtempSync(join(tmpdir(), 'runtime-app-'))
    const userData = mkdtempSync(join(tmpdir(), 'runtime-ud-'))
    try {
      installRuntimeHost({ isPackaged: false, getAppPath: () => appPath, getPath: () => userData } as never)
      await writeDeterministicTar(process.cwd(), codexAdapterFiles(process.cwd()), join(appPath, ...CODEX_ADAPTER_TAR_PATH.split('/')))
      // An unpacked Codex already here (so nothing is downloaded), but not the pinned bytes.
      const dir = join(userData, 'vault', 'runtime', `codex-${RUNTIME_PINS.codex.cli}-linux-arm64`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho planted\n', { mode: 0o755 })
      writeFileSync(join(dir, 'codex-code-mode-host'), '#!/bin/sh\n', { mode: 0o755 })
      await expect(defaultRuntimeSource().artifacts('codex')).rejects.toThrow(/not the ones this app pins/)
      // OpenCode streams the cached archive itself, Claude the cached executable:
      // each hashed against its pin before a byte is sent, and a changed one
      // removed so the next try downloads it again.
      const oc = join(userData, 'vault', 'runtime', `opencode-${RUNTIME_PINS.opencode.cli}-linux-arm64`)
      mkdirSync(oc, { recursive: true })
      writeFileSync(join(oc, RUNTIME_PINS.opencode.assets['linux-arm64']!.file), 'not the tarball')
      await expect(defaultRuntimeSource().artifacts('opencode')).rejects.toThrow(/opencode files for vaults on this computer are not the ones this app pins/)
      expect(existsSync(oc)).toBe(false)
      await writeClaudeAdapterTar(process.cwd(), join(appPath, ...ADAPTER_TAR_PATH.split('/')))
      const cl = join(userData, 'vault', 'runtime', `claude-${RUNTIME_PINS.claude.cli}-linux-arm64`)
      mkdirSync(cl, { recursive: true })
      writeFileSync(join(cl, 'claude'), '#!/bin/sh\necho planted\n', { mode: 0o755 })
      await expect(defaultRuntimeSource().artifacts('claude')).rejects.toThrow(/claude files for vaults on this computer are not the ones this app pins/)
      expect(existsSync(cl)).toBe(false)
    } finally {
      rmSync(appPath, { recursive: true, force: true })
      rmSync(userData, { recursive: true, force: true })
    }
  }, 60_000)

  it('refuses a stream whose guest hash does not match the pin', async () => {
    harness = await startVaultd()
    const sock = harness.sock
    const client = await VaultdClient.connect(await channelTo(sock), { openChannel: () => channelTo(sock) })
    try {
      await client.request('layout.ensure', {})
      const bytes = Buffer.from('#!/bin/sh\necho fake\n')
      const sent: unknown[] = []
      const request = client.request.bind(client)
      const spy = {
        attach: client.attach.bind(client),
        onNotification: client.onNotification.bind(client),
        request: ((method: string, params: Record<string, unknown>, ms?: number) => { sent.push({ method, ...params }); return request(method as never, params as never, ms) }) as typeof client.request
      }
      // The guest refuses to commit bytes that are not the pin: nothing is installed.
      await expect(installRuntimeArtifact(spy as never, {
        engine: 'claude', version: '1.0.0', kind: 'executable', name: 'claude',
        open: async function* () { yield bytes }, expectedSha256: '0'.repeat(64)
      }, mint('install'))).rejects.toThrow(/does not match what this app pins/)
      expect(sent[0]).toMatchObject({ method: 'runtime.install', expectedSha256: '0'.repeat(64) })
      expect((await client.request('runtime.status', {})).runtimes).toEqual([])
      expect(existsSync(join(harness.root, 'runtime', 'claude', '1.0.0'))).toBe(false)
      // Unpinned bytes (a fake backend's host executable) are hashed first and that hash is sent.
      const result = await installRuntimeArtifact(spy as never, {
        engine: 'claude', version: '1.0.0', kind: 'executable', name: 'claude',
        open: async function* () { yield bytes }, expectedSha256: null
      }, mint('install'))
      expect(sent.at(-1)).toMatchObject({ method: 'runtime.install', expectedSha256: createHash('sha256').update(bytes).digest('hex') })
      expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    } finally {
      client.close()
    }
  })
})

/*
 * A Codex vault set up on v0.12.0 holds the five-edit adapter patch. The launch
 * gate still runs it (vaults never set the network key the sixth edit reads),
 * and only that one earlier row: any other version or bytes are refused.
 * Update dependencies still installs the current pin over it.
 */
describe('the Codex vault adapter gate accepts the one earlier reviewed patch', () => {
  const executable = { engine: 'codex' as const, kind: 'archive' as const, version: RUNTIME_PINS.codex.cli, sha256: RUNTIME_PINS.codex.vaultRuntimeTarSha256 }
  const adapterRow = (version: string, sha256: string) => ({ engine: 'codex' as const, kind: 'adapter' as const, version, sha256 })
  const current = adapterRow(codexAdapterVersionLabel(), RUNTIME_PINS.codex.vaultAdapterTarSha256)
  const earlier = adapterRow('2.5.0-f1dc49e2', '40ae19a642c9f578918f9bbcb6c6c1b582ba8dcbe14cc7031d94f2d8635e6d12')

  it('runs the current adapter and the v0.12.0 one, and refuses anything else', () => {
    const pins = pinnedVaultRuntimes('codex')
    expect(installedRuntime([executable, current], 'codex', pins)).toMatchObject({ adapter: current })
    expect(installedRuntime([executable, earlier], 'codex', pins)).toMatchObject({ adapter: earlier })
    // The earlier label with other bytes, the earlier bytes under another label, and an unknown patch.
    for (const row of [
      adapterRow(earlier.version, 'ab'.repeat(32)),
      adapterRow('2.5.0-deadbeef', earlier.sha256),
      adapterRow('2.5.0-deadbeef', 'ab'.repeat(32)),
      adapterRow(current.version, earlier.sha256)
    ]) expect(installedRuntime([executable, row], 'codex', pins), JSON.stringify(row)).toBe('not_pinned')
    // The last installed row is the one vaultd runs: a newer unknown one after the earlier is refused.
    expect(installedRuntime([executable, earlier, adapterRow('2.5.0-deadbeef', 'ab'.repeat(32))], 'codex', pins)).toBe('not_pinned')
  })

  it('still installs the current adapter over the earlier one on Update dependencies', () => {
    // ensureRuntimes skips an artifact only on an exact matchesPin, which never reads `accepted`.
    const pin = pinnedVaultRuntimes('codex').find((each) => each.kind === 'adapter')!
    expect(matchesPin(earlier, pin)).toBe(false)
    expect(matchesPin(current, pin)).toBe(true)
  })
})
