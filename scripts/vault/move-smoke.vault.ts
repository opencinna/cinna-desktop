/**
 * Move to vault… against a real VM, end to end through the app's own code:
 * `moveService.moveIn` on the appleVz backend (test-flavor helper: approvals
 * are granted without a prompt), the real guest image, the real pinned
 * linux-arm64 Claude Code (downloaded once into build/vault-guest/smoke/) and
 * this checkout's patched adapter closure (D28). The move's own check starts
 * the engine inside the guest and asks `initialize` and `session/new`; then a
 * second engine is started the way a turn would, timed, and the vault is
 * destroyed. **No prompt is sent**: nothing is billed. The API key handed in
 * is a dummy so the guest reports a login.
 *
 *   sh scripts/vault/build-helper.sh          # FLAVOR=test
 *   make vault-image                          # build/vault-guest/rootfs.img
 *   npx vitest run --config scripts/vault/vitest.move-smoke.config.ts
 *
 * SMOKE_PYPROJECT=1 adds a pyproject.toml so the rebuild step runs
 * `uv python install` and `uv sync` through the helper's proxy (network).
 * SMOKE_KEEP=1 keeps the temp workshop (and the vault) for a look.
 *
 * SMOKE_ENGINE=codex|opencode|antigravity moves an agent on that engine instead (the
 * pinned linux-arm64 Codex + code-mode host + this checkout's codex-acp, or the
 * pinned OpenCode npm build): still initialize and session/new only, no
 * prompt. Its key is a dummy unless SMOKE_REAL_KEY=1, which hands in the repo
 * `.env` OPENAI_API_KEY (session/new sends no inference; nothing is billed).
 * Antigravity's run signs in with a dummy GEMINI_API_KEY and reports how that
 * fails (no real key, no prompt). SMOKE_PROBE_ANTIGRAVITY=1 then also installs the pinned Antigravity server
 * into that vault and asks it initialize and session/new (no login, no prompt).
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../src/main/db/testSupport/nodeSqlite'
import type { VaultMoveProgressEvent } from '../../src/shared/vault/types'

const ROOT = resolve(__dirname, '../..')
const HELPER = join(ROOT, 'resources/vault/VaultHelper.app/Contents/MacOS/VaultHelper')
const ROOTFS = join(ROOT, 'build/vault-guest/rootfs.img')
const USER_DATA = join(ROOT, 'build/vault-guest/smoke/userData')
const AGENT = 'folder:5a0c0e00-0000-4000-8000-00000000c1a0'
const ENGINE = (process.env['SMOKE_ENGINE'] ?? 'claude') as 'claude' | 'codex' | 'opencode' | 'antigravity'
if (!['claude', 'codex', 'opencode', 'antigravity'].includes(ENGINE)) throw new Error(`SMOKE_ENGINE=${ENGINE}: claude, codex, opencode or antigravity`)
/** The model the vault's launch settings name (OpenCode needs one; Codex and Claude take the CLI's default). */
const MODEL = ENGINE === 'opencode' ? 'gpt-5.6-luna' : null

function envFileKey(name: string): string | null {
  try {
    const line = readFileSync(join(ROOT, '.env'), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`))
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : null
  } catch {
    return null
  }
}

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const env = vi.hoisted(() => ({ root: '', folder: '', engine: process.env['SMOKE_ENGINE'] ?? 'claude' }))

vi.mock('../../src/main/db/client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))
vi.mock('../../src/main/logger/logger', () => ({
  createLogger: (scope: string) => ({
    debug: () => {},
    info: (message: string, data?: unknown) => console.log(`[${scope}] ${message}`, data ? JSON.stringify(data) : ''),
    warn: (message: string, data?: unknown) => console.log(`[${scope}] WARN ${message}`, data ? JSON.stringify(data) : ''),
    error: (message: string, data?: unknown) => console.log(`[${scope}] ERROR ${message}`, data ? JSON.stringify(data) : '')
  }),
  setLogValueRedactor: () => {}
}))
vi.mock('../../src/main/services/localAgents/agentsHomeService', () => ({
  agentsHomeService: { rootRows: () => [{ id: 'root-1', path: env.root, isDefault: true }] }
}))
vi.mock('../../src/main/services/localAgents/scannerService', () => ({ markRootDirty: () => {}, scannerService: { markRootDirty: () => {} } }))
vi.mock('../../src/main/services/localAgents/localAgentService', () => ({
  localAgentService: {
    get: (_userId: string, agentId: string) => ({
      id: agentId, manifestId: agentId.slice('folder:'.length), name: 'Smoke Agent', path: env.folder, kind: 'bare', rootId: 'root-1',
      runtime: { engine: env.engine }, credentials: [], manifest: {}
    })
  }
}))

const { installRuntimeHost } = await import('../../src/main/host/runtimeHost')
const { installEventPublisher } = await import('../../src/main/host/events')
const { agentRepo } = await import('../../src/main/db/agents')
const { installVaultBackend } = await import('../../src/main/vault/backend')
const { createAppleVzBackend } = await import('../../src/main/host/desktop/vault/appleVzBackend')
const { vaultService } = await import('../../src/main/vault/vaultService')
const { moveService, installVaultMoveDeps } = await import('../../src/main/vault/moveService')
const { startVaultAcpConnection } = await import('../../src/main/agents/drivers/acp/vaultAcpConnection')
const { approvalDetail } = await import('../../src/shared/vault/protocol')
const { RUNTIME_PINS } = await import('../../src/shared/runtimePins')
const { defaultRuntimeSource, ensureRuntimes } = await import('../../src/main/vault/runtimeInstall')

const t0 = Date.now()
const stamp = (): string => `${String(Date.now() - t0).padStart(7)} ms`
const events: VaultMoveProgressEvent[] = []
const stepStart = new Map<string, number>()
const timings: Record<string, number> = {}
let backend: ReturnType<typeof createAppleVzBackend> | null = null

beforeAll(() => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple silicon only')
  if (!existsSync(HELPER)) throw new Error(`no helper at ${HELPER}: sh scripts/vault/build-helper.sh`)
  if (!existsSync(ROOTFS)) throw new Error(`no guest image at ${ROOTFS}: make vault-image`)
  mkdirSync(USER_DATA, { recursive: true })
  const require = createRequire(join(ROOT, 'package.json'))
  installRuntimeHost({
    getPath: (name: string) => (name === 'userData' ? USER_DATA : tmpdir()),
    getVersion: () => '0.0.0-smoke',
    getAppPath: () => ROOT,
    isPackaged: false,
    resourcesPath: join(ROOT, 'resources'),
    resolvePackageFile: (specifier: string) => require.resolve(specifier),
    http: { fetch: (input: string, init?: RequestInit) => fetch(input, init) },
    nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }),
    onShutdown: () => {}
  } as never)
  holder.current = createTestDatabase()
  env.root = mkdtempSync(join(tmpdir(), 'cinna-move-smoke-'))
  env.folder = join(env.root, 'Local', 'smoke-agent')
  mkdirSync(join(env.folder, 'scripts'), { recursive: true })
  writeFileSync(join(env.folder, 'CLAUDE.md'), '# Smoke agent\nAnswer briefly.\n')
  writeFileSync(join(env.folder, 'scripts', 'hello.py'), 'print("hello from the vault")\n')
  if (process.env['SMOKE_PYPROJECT'] === '1') {
    writeFileSync(join(env.folder, 'pyproject.toml'), '[project]\nname = "smoke-agent"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n')
  }
  agentRepo.replaceFolderIndex('__default__', 'root-1', [{
    id: AGENT, name: 'Smoke Agent', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: ENGINE
  }])
  installEventPublisher((channel, payload) => {
    if (channel !== 'vault:move-progress') return
    const event = payload as VaultMoveProgressEvent
    events.push(event)
    if (event.output) {
      for (const line of event.output.split('\n').filter(Boolean)) console.log(stamp(), `  [${event.step}]`, line.slice(0, 200))
      return
    }
    if (event.status === 'running') stepStart.set(event.step, Date.now())
    else if (stepStart.has(event.step) && !(event.step in timings)) timings[event.step] = Date.now() - stepStart.get(event.step)!
    console.log(stamp(), event.step, event.status, event.message ?? '', event.rolledBack !== undefined ? `rolledBack=${event.rolledBack}` : '')
  })
  backend = createAppleVzBackend({ helperPath: HELPER, isPackaged: false })
  installVaultBackend(backend)
  vaultService.init()
  installVaultMoveDeps({
    instructions: () => null,
    launchFacts: () => ({ model: MODEL, approval: 'ask', provider: ENGINE === 'opencode' ? 'openai' : null }),
    hostClaudeOnSubscription: async () => true
  })
})

afterAll(async () => {
  await vaultService.shutdown().catch(() => {})
  if (process.env['SMOKE_KEEP'] !== '1') rmSync(env.root, { recursive: true, force: true })
  holder.current?.close()
})

describe('Move to vault… on a real VM', () => {
  it(`moves a fixture agent in on ${ENGINE} with the pinned runtime, and the engine answers initialize and session/new inside`, async () => {
    const hello = await backend!.hello()
    console.log(stamp(), 'helper', JSON.stringify(hello))
    expect(hello.flavor).toBe('test')

    const check = await moveService.precheck('__default__', AGENT)
    console.log(stamp(), 'precheck', JSON.stringify({ canMove: check.canMove, files: check.copyFiles, items: check.items.map((i) => i.kind) }))
    expect(check.canMove).toBe(true)

    const started = Date.now()
    const realKey = process.env['SMOKE_REAL_KEY'] === '1' && ENGINE !== 'claude' ? envFileKey('OPENAI_API_KEY') : null
    const apiKey = realKey ?? (ENGINE === 'claude' ? 'sk-ant-smoke-not-a-real-key-000000' : ENGINE === 'antigravity' ? 'AIzaSmokeNotARealKey000000000000000000' : 'sk-smoke-not-a-real-key-000000000000')
    const { moveId } = await moveService.moveIn('__default__', AGENT, { apiKey })
    await moveService.waitForMove(moveId)
    const final = events.filter((e) => e.moveId === moveId && !e.output).at(-1)!
    console.log(stamp(), 'move total', Date.now() - started, 'ms', JSON.stringify(timings))
    expect(final, JSON.stringify(events.filter((e) => !e.output))).toMatchObject({ status: 'done' })

    const row = agentRepo.getOwned('__default__', AGENT)!
    expect(row.source).toBe('vault')
    const vaultId = (row.driverConfig!['vault'] as { vaultId: string }).vaultId
    const client = await vaultService.client(vaultId)
    const { runtimes } = await client.request('runtime.status', {})
    console.log(stamp(), 'runtimes', JSON.stringify(runtimes))
    const pinned = { claude: RUNTIME_PINS.claude.assets['linux-arm64']!.sha256, codex: RUNTIME_PINS.codex.vaultRuntimeTarSha256, opencode: RUNTIME_PINS.opencode.assets['linux-arm64']!.sha256, antigravity: RUNTIME_PINS.antigravity.vaultRuntimeTarSha256 }[ENGINE]
    expect(runtimes.find((r) => r.engine === ENGINE && r.kind !== 'adapter')?.sha256).toBe(pinned)
    console.log(stamp(), 'auth.status', JSON.stringify(await client.request('auth.status', { engine: ENGINE })))
    console.log(stamp(), 'kv cinna.launch', JSON.stringify((await client.request('kv.get', { key: 'cinna.launch' })).value))
    console.log(stamp(), 'files', JSON.stringify((await client.request('files.list', { path: '' })).entries.map((e) => e.name)))

    if (ENGINE === 'antigravity') {
      // Its Gemini key login with a key that is not valid: the start must fail in words and stop the engine.
      // No real key, no prompt: nothing is billed.
      const failed = await startVaultAcpConnection({ agentId: AGENT, vaultId, engine: 'antigravity', extraEnv: {}, authMethod: 'gemini-api-key' }, {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cinna-desktop', version: '1' }
      } as never, { startTimeoutMs: 120_000 }).then(async (connection) => {
        // The method accepted the key without checking it: say what session/new does next.
        const outcome = await connection.newSession({ cwd: '/vault/agent', mcpServers: [] }).then((s) => `session ${s.sessionId}`, (e: unknown) => `session/new failed: ${e instanceof Error ? e.message : String(e)} ${JSON.stringify((e as { data?: unknown }).data ?? null)}`)
        await connection.dispose()
        return `authenticate accepted; ${outcome}`
      }, (error: unknown) => `start failed: ${error instanceof Error ? error.message : String(error)}`)
      console.log(stamp(), 'antigravity gemini-api-key with an invalid key:', failed.slice(0, 600))
      const token = await backend!.approve(vaultId, 'destroy', approvalDetail({ method: 'vault.destroy' }))
      await backend!.destroy(vaultId, token)
      console.log(stamp(), 'destroyed', vaultId)
      return
    }

    // What a turn's start costs on a warm (unlocked) vault: spawn → initialize → session/new.
    const spawnAt = Date.now()
    const connection = await startVaultAcpConnection({ agentId: AGENT, vaultId, engine: ENGINE, extraEnv: {} }, {
      protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } }, clientInfo: { name: 'cinna-desktop', version: '1' }
    } as never)
    const initAt = Date.now()
    const session = await connection.newSession({ cwd: '/vault/agent', mcpServers: [] })
    const sessionAt = Date.now()
    console.log(stamp(), 'engine', JSON.stringify({ agentInfo: connection.initialized.agentInfo, authMethods: connection.initialized.authMethods, session: session.sessionId, modes: session.modes?.currentModeId, configOptions: (session as { configOptions?: { id: string; currentValue?: unknown }[] }).configOptions?.map((o) => `${o.id}=${String(o.currentValue)}`), initializeMs: initAt - spawnAt, sessionNewMs: sessionAt - initAt }))
    expect(session.sessionId).toBeTruthy()
    if (ENGINE === 'opencode') {
      // The vault's agent entry (vaultd's config) is what a turn's setup selects.
      const set = await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: 'mode', value: 'cinna' } as never)
      const mode = (set as { configOptions?: { id: string; currentValue?: unknown }[] }).configOptions?.find((o) => o.id === 'mode')
      console.log(stamp(), 'opencode mode', JSON.stringify(mode?.currentValue))
      expect(mode?.currentValue).toBe('cinna')
    }
    await connection.dispose()

    if (process.env['SMOKE_PROBE_ANTIGRAVITY'] === '1') {
      // Probe only: Antigravity cannot move in (its Google login), so its pinned server goes
      // into this vault with an install approval, and is asked initialize and session/new.
      const install = await backend!.approve(vaultId, 'install', 'Probe Antigravity')
      await ensureRuntimes(client, defaultRuntimeSource(), 'antigravity', install, (message) => console.log(stamp(), '  [antigravity]', message))
      console.log(stamp(), 'antigravity auth.status', JSON.stringify(await client.request('auth.status', { engine: 'antigravity' })))
      try {
        const agy = await startVaultAcpConnection({ agentId: AGENT, vaultId, engine: 'antigravity', extraEnv: {} }, {
          protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cinna-desktop', version: '1' }
        } as never, { startTimeoutMs: 120_000 })
        console.log(stamp(), 'antigravity initialize', JSON.stringify({ agentInfo: agy.initialized.agentInfo, authMethods: agy.initialized.authMethods }))
        try {
          const agySession = await agy.newSession({ cwd: '/vault/agent', mcpServers: [] })
          console.log(stamp(), 'antigravity session/new', JSON.stringify({ session: agySession.sessionId }))
        } catch (error) {
          console.log(stamp(), 'antigravity session/new FAILED', JSON.stringify({ message: error instanceof Error ? error.message : String(error), code: (error as { code?: unknown }).code, data: (error as { data?: unknown }).data }))
        }
        await agy.dispose()
      } catch (error) {
        console.log(stamp(), 'antigravity start FAILED', error instanceof Error ? error.message : String(error))
      }
    }

    // Clean up: the test helper grants the destroy approval without a prompt.
    const token = await backend!.approve(vaultId, 'destroy', approvalDetail({ method: 'vault.destroy' }))
    await backend!.destroy(vaultId, token)
    console.log(stamp(), 'destroyed', vaultId)
  })
})
