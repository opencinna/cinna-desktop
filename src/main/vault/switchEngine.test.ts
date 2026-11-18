import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { VaultMoveProgressEvent } from '../../shared/vault/types'
import { VAULT_ENGINE_HOSTS, type VaultEngine } from '../../shared/vault/protocol'

/**
 * Changing a vault agent's engine after Move to vault… (`moveService.switchEngine`),
 * against the real cinna-vaultd run by the fake backend with fake Claude and
 * Codex runtimes: a new engine is set up (install and egress prompts), a set-up
 * one switches without a prompt, the instructions captured per engine at
 * move-in become the active ones, and any failure leaves the row and
 * `cinna.launch` as they were.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const env = vi.hoisted(() => ({ root: '', folder: '' }))

vi.mock('../db/client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))
vi.mock('../services/jobService', () => ({ jobService: { reportRunCompletion: () => {} } }))
vi.mock('../services/localAgents/agentsHomeService', () => ({
  agentsHomeService: { rootRows: () => [{ id: 'root-1', path: env.root, isDefault: true }] }
}))
vi.mock('../services/localAgents/scannerService', () => ({ markRootDirty: () => {}, scannerService: { markRootDirty: () => {} } }))
vi.mock('../services/localAgents/localAgentService', () => ({
  localAgentService: {
    get: (_userId: string, agentId: string) => ({
      id: agentId, manifestId: agentId.slice('folder:'.length), name: 'Ledger', path: env.folder, kind: 'kit', rootId: 'root-1',
      runtime: { engine: 'claude' }, credentials: [], manifest: {}
    })
  }
}))

const { installEventPublisher } = await import('../host/events')
const { agentRepo } = await import('../db/agents')
const { installVaultBackend, VaultBackendError } = await import('./backend')
const { createFakeBackend } = await import('./fakeBackend')
const { vaultService } = await import('./vaultService')
const { vaultTranscripts } = await import('./transcriptStore')
const { resetVaultAgentsForTest } = await import('./isVaultAgent')
const { vaultAgentState } = await import('./vaultAgentState')
const { vaultCredentials } = await import('./vaultCredentials')
const { moveService, installVaultMoveDeps } = await import('./moveService')
const { buildVaultd, fakeRuntimeSource, FAKE_CLAUDE_ADAPTER } = await import('./testSupport/fakeRuntime')
const { vaultDriverDeps } = await import('../agents/drivers/acp/vaultRuntime')
const { turnLock } = await import('../services/localAgents/turnLock')
type RuntimeSource = import('./runtimeInstall').RuntimeSource
type Backend = ReturnType<typeof createFakeBackend>

const USER = '__default__'
const AGENT = 'folder:dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAUNCH = { kind: 'kit', model: 'haiku', approval: 'ask' }

let work = ''
let vaultdPath = ''
let codexAdapter: Buffer = Buffer.alloc(0)
let events: VaultMoveProgressEvent[] = []
let backend: Backend
let calls: Record<string, number> = {}

async function* bytesOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  yield buffer
}

/** A codex-acp tar answering like the fake Claude adapter (enough for a plan and a session). */
function codexAdapterTar(): Buffer {
  const stage = join(work, 'codex-stage')
  const pkg = join(stage, 'node_modules', '@agentclientprotocol', 'codex-acp')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'dist', 'index.js'), FAKE_CLAUDE_ADAPTER)
  writeFileSync(join(pkg, 'package.json'), '{"name":"@agentclientprotocol/codex-acp","version":"0.0.0-fake","type":"commonjs"}\n')
  const tar = join(work, 'codex-adapter.tar')
  const made = spawnSync('tar', ['-c', '-f', tar, '-C', stage, ...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : []), 'node_modules'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (made.status !== 0) throw new Error(`tar failed: ${made.stderr}`)
  return readFileSync(tar)
}

/** Fake Claude (as Move to vault… tests use it), Codex and OpenCode; counts the artifacts asked for per engine. */
function source(): RuntimeSource {
  const claude = fakeRuntimeSource(work)
  const codex = Buffer.from('#!/bin/sh\necho codex\n')
  const codexSha = createHash('sha256').update(codex).digest('hex')
  const opencode = Buffer.from('#!/bin/sh\necho opencode\n')
  const opencodeSha = createHash('sha256').update(opencode).digest('hex')
  return {
    pins: (engine) => engine === 'claude' ? claude.pins(engine) : engine === 'codex' ? [
      { engine: 'codex', kind: 'executable', version: '9.9.9-fake', sha256: codexSha },
      { engine: 'codex', kind: 'adapter', version: '0.0.0-fake', sha256: null }
    ] : engine === 'opencode' ? [{ engine: 'opencode', kind: 'executable', version: '8.8.8-fake', sha256: opencodeSha }] : [],
    async artifacts(engine: VaultEngine) {
      calls[engine] = (calls[engine] ?? 0) + 1
      if (engine === 'claude') return claude.artifacts(engine)
      if (engine === 'opencode') {
        return [{ engine: 'opencode', version: '8.8.8-fake', kind: 'executable', name: 'opencode', open: () => bytesOf(opencode), expectedSha256: opencodeSha }]
      }
      if (engine !== 'codex') throw new Error(`no fake ${engine}`)
      return [
        { engine: 'codex', version: '9.9.9-fake', kind: 'executable', name: 'codex', open: () => bytesOf(codex), expectedSha256: codexSha },
        { engine: 'codex', version: '0.0.0-fake', kind: 'adapter', name: 'codex-acp', open: () => bytesOf(codexAdapter), expectedSha256: null }
      ]
    }
  }
}

function vaultIdOf(): string {
  return (agentRepo.getOwned(USER, AGENT)!.driverConfig!['vault'] as { vaultId: string }).vaultId
}

function rowEngine(): unknown {
  return (agentRepo.getOwned(USER, AGENT)!.driverConfig!['vault'] as { engine: unknown }).engine
}

async function moveInClaude(): Promise<string> {
  const { moveId } = await moveService.moveIn(USER, AGENT, { apiKey: 'sk-ant-test-0123456789' })
  await moveService.waitForMove(moveId)
  const final = events.filter((event) => event.moveId === moveId).at(-1)
  expect(final, JSON.stringify(events.filter((e) => e.moveId === moveId && !e.output))).toMatchObject({ status: 'done' })
  return vaultIdOf()
}

async function kv(key: string): Promise<unknown> {
  return (await (await vaultService.client(vaultIdOf())).request('kv.get', { key })).value
}

/** Switch, wait, and return the switch's events (steps without output) and its last one. */
async function switchTo(options: Record<string, unknown>): Promise<{ final: VaultMoveProgressEvent; steps: string[] }> {
  const { moveId } = await moveService.switchEngine(USER, AGENT, options)
  await moveService.waitForMove(moveId)
  const mine = events.filter((event) => event.moveId === moveId && !event.output)
  return { final: mine.at(-1)!, steps: mine.filter((e) => e.status !== 'running').map((e) => `${e.step}:${e.status}`) }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'cinna-switch-engine-'))
  vaultdPath = await buildVaultd(work)
  codexAdapter = codexAdapterTar()
}, 60_000)

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

beforeEach(() => {
  holder.current = createTestDatabase()
  env.root = mkdtempSync(join(tmpdir(), 'cinna-switch-engine-root-'))
  env.folder = join(env.root, 'Local', 'ledger')
  mkdirSync(env.folder, { recursive: true })
  writeFileSync(join(env.folder, 'agent.md'), '# Ledger\n')
  events = []
  calls = {}
  installEventPublisher((channel, payload) => {
    if (channel === 'vault:move-progress') events.push(payload as VaultMoveProgressEvent)
  })
  agentRepo.replaceFolderIndex(USER, 'root-1', [{
    id: AGENT, name: 'Ledger', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: 'claude'
  }])
  resetVaultAgentsForTest()
  vaultTranscripts.resetForTest()
  vaultAgentState.resetForTest()
  vaultCredentials.resetForTest()
  vaultService.resetForTest()
  backend = createFakeBackend({ vaultdPath, nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }), windowMs: 60_000 })
  installVaultBackend(backend)
  vaultService.init()
  const fixed = source()
  installVaultMoveDeps({
    runtimeSource: () => fixed,
    instructions: (_userId, _agentId, engine) => `Prompt for ${engine}`,
    launchFacts: () => ({ model: 'haiku', approval: 'ask' }),
    hostClaudeOnSubscription: async () => true,
    defaultEngine: () => 'claude',
    hasBackgroundWork: () => false,
    stopAgentProcesses: () => {}
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  turnLock.releaseAll()
  await vaultService.shutdown()
  vaultTranscripts.resetForTest()
  resetVaultAgentsForTest()
  holder.current?.close()
  holder.current = null
  installEventPublisher(() => {})
  rmSync(env.root, { recursive: true, force: true })
})

describe('move-in captures every engine’s instructions', () => {
  it('writes cinna.instructions.<engine> for all four vault engines, and the active one for the move-in engine', async () => {
    await moveInClaude()
    for (const engine of ['claude', 'codex', 'opencode', 'antigravity']) {
      expect(await kv(`cinna.instructions.${engine}`)).toBe(`Prompt for ${engine}`)
    }
    expect(await kv('cinna.instructions')).toBe('Prompt for claude')
  }, 60_000)
})

describe('the row is the current engine', () => {
  it('status names the row’s engine, not the one the vault was created with', async () => {
    await moveInClaude()
    agentRepo.patchVaultConfig(USER, AGENT, { engine: 'codex' })
    expect((await vaultService.status(USER, AGENT)).engine).toBe('codex')
    expect(vaultService.list(USER)[0]?.engine).toBe('codex')
  }, 60_000)
})

describe('switching the engine', () => {
  it('sets up a new engine with two prompts, then switches back to a set-up one with none', async () => {
    await moveInClaude()
    const claudePlan = await vaultDriverDeps().launcher('claude')!.plan({ userId: USER, agentId: AGENT } as never)
    if (!('spec' in claudePlan)) throw new Error(JSON.stringify(claudePlan))
    expect((await vaultService.engines(USER, AGENT)).map((e) => `${e.engine}:${e.setUp}`)).toEqual(['claude:true', 'codex:false', 'opencode:false', 'antigravity:false'])

    const approve = vi.spyOn(backend, 'approve')
    const toCodex = await switchTo({ engine: 'codex', apiKey: 'sk-openai-test-0123456789' })
    expect(toCodex.final, JSON.stringify(toCodex.steps)).toEqual(expect.objectContaining({ step: 'engine', status: 'done', message: 'The agent runs on Codex now.' }))
    expect(toCodex.steps).toEqual(['runtime:done', 'egress:done', 'credentials:done', 'engine:done'])
    expect(approve.mock.calls.map(([, action]) => action)).toEqual(['install', 'egress'])
    expect(rowEngine()).toBe('codex')
    expect(agentRepo.getOwned(USER, AGENT)!.driverConfig!['vault']).not.toHaveProperty('model')
    // The model resets to the CLI's default; mode and kind stay.
    expect(await kv('cinna.launch')).toEqual({ kind: 'kit', model: null, approval: 'ask' })
    expect(await kv('cinna.instructions')).toBe('Prompt for codex')
    const client = await vaultService.client(vaultIdOf())
    expect((await client.request('secrets.list', {})).names.sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
    const status = await vaultService.status(USER, AGENT)
    expect(status.engine).toBe('codex')
    expect(status.egress.hosts).toEqual([...new Set([...VAULT_ENGINE_HOSTS.claude, ...VAULT_ENGINE_HOSTS.codex])].sort())
    const engines = await vaultService.engines(USER, AGENT)
    expect(engines.map((e) => `${e.engine}:${e.setUp}`)).toEqual(['claude:true', 'codex:true', 'opencode:false', 'antigravity:false'])
    expect(engines.find((e) => e.engine === 'codex')?.version).toBe('9.9.9-fake')
    // Every runtime row has its own engine's pinned version, not only the current engine's.
    expect((await vaultService.runtimes(USER, AGENT)).every((r) => r.pinned !== null)).toBe(true)

    // The pool's spec key moves with the engine, which retires the old engine's process.
    const codexPlan = await vaultDriverDeps().launcher('codex')!.plan({ userId: USER, agentId: AGENT } as never)
    if (!('spec' in codexPlan)) throw new Error(JSON.stringify(codexPlan))
    expect(codexPlan.spec.key).not.toBe(claudePlan.spec.key)
    expect(await vaultDriverDeps().launcher('claude')!.plan({ userId: USER, agentId: AGENT } as never)).toEqual({ error: 'This agent runs on Codex, not Claude.' })

    approve.mockClear()
    const back = await switchTo({ engine: 'claude' })
    expect(back.final).toMatchObject({ step: 'engine', status: 'done', message: 'The agent runs on Claude Agent now.' })
    expect(back.steps).toEqual(['runtime:skipped', 'egress:skipped', 'credentials:skipped', 'engine:done'])
    expect(approve).not.toHaveBeenCalled()
    expect(rowEngine()).toBe('claude')
    expect(await kv('cinna.instructions')).toBe('Prompt for claude')
    expect(await kv('cinna.launch')).toEqual({ kind: 'kit', model: null, approval: 'ask' })
  }, 60_000)

  it('switches to OpenCode with its provider and model in cinna.launch and on the row, and to another model on it', async () => {
    await moveInClaude()
    const { final } = await switchTo({ engine: 'opencode', provider: 'anthropic', model: 'claude-sonnet-5-5' })
    expect(final).toMatchObject({ step: 'engine', status: 'done', message: 'The agent runs on OpenCode now.' })
    expect(await kv('cinna.launch')).toEqual({ kind: 'kit', model: 'claude-sonnet-5-5', approval: 'ask', provider: 'anthropic' })
    expect(await kv('cinna.instructions')).toBe('Prompt for opencode')
    expect(agentRepo.getOwned(USER, AGENT)!.driverConfig!['vault']).toMatchObject({ engine: 'opencode', model: 'claude-sonnet-5-5', provider: 'anthropic' })
    // OpenCode again, on another provider: nothing to set up, the launch follows.
    const approve = vi.spyOn(backend, 'approve')
    const again = await switchTo({ engine: 'opencode', provider: 'openai', model: 'gpt-5.6-luna' })
    expect(again.steps).toEqual(['runtime:skipped', 'egress:skipped', 'credentials:skipped', 'engine:done'])
    expect(approve).not.toHaveBeenCalled()
    expect(await kv('cinna.launch')).toEqual({ kind: 'kit', model: 'gpt-5.6-luna', approval: 'ask', provider: 'openai' })
  }, 60_000)

  it('a declined install leaves the engine, cinna.launch and the instructions as they were', async () => {
    await moveInClaude()
    vi.spyOn(backend, 'approve').mockRejectedValueOnce(new VaultBackendError('denied', 'the user did not approve'))
    const { final } = await switchTo({ engine: 'codex' })
    expect(final).toEqual(expect.objectContaining({ step: 'runtime', status: 'failed', message: 'Cancelled at the prompt.' }))
    expect(rowEngine()).toBe('claude')
    expect(await kv('cinna.launch')).toEqual(LAUNCH)
    expect(await kv('cinna.instructions')).toBe('Prompt for claude')
  }, 60_000)

  it('a declined egress prompt fails the egress step; the runtime set up before it stays', async () => {
    await moveInClaude()
    const real = backend.approve.bind(backend)
    vi.spyOn(backend, 'approve').mockImplementation(async (vaultId, action, detail) =>
      action === 'egress' ? Promise.reject(new VaultBackendError('denied', 'the user did not approve')) : real(vaultId, action, detail))
    const { final } = await switchTo({ engine: 'codex' })
    expect(final).toMatchObject({ step: 'egress', status: 'failed' })
    expect(rowEngine()).toBe('claude')
    expect(await kv('cinna.launch')).toEqual(LAUNCH)
    expect((await vaultService.engines(USER, AGENT)).find((e) => e.engine === 'codex')?.setUp).toBe(true)
    expect((await vaultService.status(USER, AGENT)).egress.hosts).toEqual([...VAULT_ENGINE_HOSTS.claude].sort())
  }, 60_000)

  it('a key the vault cannot store fails the credentials step and changes nothing else', async () => {
    await moveInClaude()
    const real = vaultService.client.bind(vaultService)
    vi.spyOn(vaultService, 'client').mockImplementation(async (id) => {
      const c = await real(id)
      return new Proxy(c, { get: (target, key) => key === 'request'
        ? (method: string, params: unknown) => method === 'secrets.put' ? Promise.reject(new Error('the vault refused the secret')) : target.request(method as never, params as never)
        : Reflect.get(target, key) }) as never
    })
    const { final } = await switchTo({ engine: 'codex', apiKey: 'sk-openai-test-0123456789' })
    expect(final).toMatchObject({ step: 'credentials', status: 'failed', message: 'the vault refused the secret.' })
    vi.restoreAllMocks()
    expect(rowEngine()).toBe('claude')
    expect(await kv('cinna.launch')).toEqual(LAUNCH)
  }, 60_000)

  it('keeps every other login name when it stores a key', async () => {
    await moveInClaude()
    const client = await vaultService.client(vaultIdOf())
    await client.request('secrets.put', { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-oat01-0123456789' })
    expect((await switchTo({ engine: 'codex' })).final).toMatchObject({ status: 'done' })
    const back = await switchTo({ engine: 'claude', apiKey: 'sk-ant-api03-0123456789' })
    expect(back.final).toMatchObject({ step: 'engine', status: 'done' })
    // An API key wins over the token for Claude; the token is left as it was.
    expect((await client.request('secrets.list', {})).names.sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
  }, 60_000)

  it('refuses a Claude token while the vault holds an Anthropic API key, before anything runs', async () => {
    await moveInClaude()
    expect((await switchTo({ engine: 'opencode', provider: 'anthropic', model: 'claude-sonnet-5-5' })).final).toMatchObject({ status: 'done' })
    events = []
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'claude', apiKey: 'sk-ant-oat01-0123456789' })).rejects.toMatchObject({
      code: 'invalid',
      message: 'This vault already holds an Anthropic API key, which Claude would use over a token. Paste an API key, or leave the field empty to use the one it holds.'
    })
    expect(events).toEqual([])
    expect(rowEngine()).toBe('opencode')
    const client = await vaultService.client(vaultIdOf())
    expect((await client.request('secrets.list', {})).names).toEqual(['ANTHROPIC_API_KEY'])
  }, 60_000)

  it('puts back the instructions and cinna.launch when the row cannot be updated', async () => {
    await moveInClaude()
    vi.spyOn(agentRepo, 'patchVaultConfig').mockReturnValueOnce(false)
    const { final } = await switchTo({ engine: 'codex' })
    expect(final).toMatchObject({ step: 'engine', status: 'failed', message: 'The agent changed while its engine was switching.' })
    expect(rowEngine()).toBe('claude')
    expect(await kv('cinna.launch')).toEqual(LAUNCH)
    expect(await kv('cinna.instructions')).toBe('Prompt for claude')
  }, 60_000)

  it('says so when the launch settings cannot be put back either', async () => {
    await moveInClaude()
    vi.spyOn(agentRepo, 'patchVaultConfig').mockImplementationOnce(() => { throw new Error('the database is gone') })
    const realWrite = vaultAgentState.writeLaunch.bind(vaultAgentState)
    vi.spyOn(vaultAgentState, 'writeLaunch').mockImplementation(async (client, launch) => {
      // The switch's own write lands; putting the old one back fails.
      if (launch.model === 'haiku') throw new Error('the vault went away')
      return realWrite(client, launch)
    })
    const { final } = await switchTo({ engine: 'codex' })
    expect(final).toMatchObject({ step: 'engine', status: 'failed', message: 'the database is gone. The vault’s launch settings could not be put back; switch the engine again.' })
  }, 60_000)

  it('lets go of the turn lock and the vault before it says done', async () => {
    await moveInClaude()
    const order: string[] = []
    const realRelease = backend.release.bind(backend)
    vi.spyOn(backend, 'release').mockImplementation(async (...args) => {
      order.push('vault released')
      return realRelease(...args)
    })
    installEventPublisher((channel, payload) => {
      if (channel !== 'vault:move-progress') return
      const event = payload as VaultMoveProgressEvent
      events.push(event)
      if (event.step === 'engine' && event.status === 'done') {
        order.push(turnLock.isLocked(AGENT) ? 'done while locked' : 'done')
        // A send at that moment takes its shared hold.
        turnLock.acquireShared(AGENT, 'turn').release()
      }
    })
    const { final } = await switchTo({ engine: 'codex' })
    expect(final).toMatchObject({ step: 'engine', status: 'done' })
    expect(order.slice(-2)).toEqual(['vault released', 'done'])
  }, 60_000)

  it('stops a dashboard run holding the agent instead of refusing as busy', async () => {
    await moveInClaude()
    let preempted = false
    const dashboard = turnLock.tryAcquireSharedYielding(AGENT, 'dashboard', () => { preempted = true })
    expect(dashboard).not.toBeNull()
    const { final } = await switchTo({ engine: 'codex' })
    expect(preempted).toBe(true)
    expect(final).toMatchObject({ step: 'engine', status: 'done' })
  }, 60_000)

  it('refuses a key that cannot sign in before anything runs', async () => {
    await moveInClaude()
    events = []
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'opencode', provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-oat01-0123456789' }))
      .rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('Claude Code token') })
    expect(events).toEqual([])
    expect(rowEngine()).toBe('claude')
    expect(await kv('cinna.launch')).toEqual(LAUNCH)
  }, 60_000)

  it('refuses OpenCode without a provider and a model, the same engine, and an unknown one', async () => {
    await moveInClaude()
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'opencode' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'opencode', provider: 'openai' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'opencode', model: 'gpt-5.6-luna' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'opencode', provider: 'gemini', model: 'x' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'codex', model: 'gpt-5' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'claude' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'custom' })).rejects.toMatchObject({ code: 'invalid' })
    expect(rowEngine()).toBe('claude')
  }, 60_000)

  it('refuses while the vault is locked, while the agent updates, and while a turn runs', async () => {
    await moveInClaude()
    // A turn holds the agent's turn lock.
    const turn = turnLock.acquireShared(AGENT, 'turn')
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'codex' })).rejects.toMatchObject({ code: 'busy' })
    turn.release()

    // Update dependencies is running (its exec stubbed: no uv on the host).
    const real = vaultService.client.bind(vaultService)
    vi.spyOn(vaultService, 'client').mockImplementation(async (id) => {
      const c = await real(id)
      return new Proxy(c, { get: (target, key) => key === 'request'
        ? (method: string, params: unknown) => method === 'exec' ? Promise.reject(new Error('no exec in this test')) : target.request(method as never, params as never)
        : Reflect.get(target, key) }) as never
    })
    const { moveId } = await moveService.updateDependencies(USER, AGENT)
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'codex' })).rejects.toMatchObject({ code: 'busy' })
    await moveService.waitForMove(moveId)
    vi.restoreAllMocks()

    await vaultService.lock(USER, AGENT)
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'codex' })).rejects.toMatchObject({ code: 'locked' })
    expect(rowEngine()).toBe('claude')
  }, 60_000)

  it('refuses while background work runs on the agent, before anything runs', async () => {
    await moveInClaude()
    const busy = new Set<string>([AGENT])
    const stopped: string[] = []
    installVaultMoveDeps({ hasBackgroundWork: (agentId) => busy.has(agentId), stopAgentProcesses: (agentId) => { stopped.push(agentId) } })
    events = []
    await expect(moveService.switchEngine(USER, AGENT, { engine: 'codex' })).rejects.toMatchObject({
      code: 'busy',
      message: 'Background work is still running on this agent. Change the engine when it ends.'
    })
    expect(events).toEqual([])
    expect(stopped).toEqual([])
    expect(turnLock.isLocked(AGENT)).toBe(false)
    expect(rowEngine()).toBe('claude')
    // Once it ends, the switch goes ahead.
    busy.clear()
    expect((await switchTo({ engine: 'codex' })).final).toMatchObject({ step: 'engine', status: 'done' })
  }, 60_000)

  it('stops the agent’s pooled engine process after a switch, before it says done; a failure to stop is not the switch’s', async () => {
    await moveInClaude()
    const order: string[] = []
    let fail = false
    installVaultMoveDeps({
      stopAgentProcesses: async (agentId) => {
        order.push(`stop ${agentId}`)
        if (fail) throw new Error('the pool is gone')
      }
    })
    installEventPublisher((channel, payload) => {
      if (channel !== 'vault:move-progress') return
      const event = payload as VaultMoveProgressEvent
      events.push(event)
      if (event.status === 'done' && event.step === 'engine') order.push('done')
    })
    expect((await switchTo({ engine: 'codex' })).final).toMatchObject({ step: 'engine', status: 'done' })
    expect(order).toEqual([`stop ${AGENT}`, 'done'])

    // A switch that fails stops nothing: the old engine is still the agent's.
    order.length = 0
    vi.spyOn(agentRepo, 'patchVaultConfig').mockReturnValueOnce(false)
    expect((await switchTo({ engine: 'claude' })).final).toMatchObject({ step: 'engine', status: 'failed' })
    expect(order).toEqual([])

    fail = true
    const back = await switchTo({ engine: 'claude' })
    expect(back.final).toMatchObject({ step: 'engine', status: 'done', message: 'The agent runs on Claude Agent now.' })
    expect(order).toEqual([`stop ${AGENT}`, 'done'])
    expect(rowEngine()).toBe('claude')
  }, 60_000)

  it('holds the turn lock while it runs, so no turn starts on the old engine mid-switch', async () => {
    await moveInClaude()
    let releaseInstall: (() => void) | null = null
    const real = backend.approve.bind(backend)
    vi.spyOn(backend, 'approve').mockImplementation(async (vaultId, action, detail) => {
      // The install prompt waits for the test; the rest answer at once.
      if (action === 'install') await new Promise<void>((resolve) => { releaseInstall = resolve })
      return real(vaultId, action, detail)
    })
    const { moveId } = await moveService.switchEngine(USER, AGENT, { engine: 'codex' })
    await vi.waitFor(() => expect(releaseInstall).not.toBeNull())
    expect(() => turnLock.acquireShared(AGENT, 'turn')).toThrow()
    releaseInstall!()
    await moveService.waitForMove(moveId)
    expect(events.filter((e) => e.moveId === moveId).at(-1)).toMatchObject({ step: 'engine', status: 'done' })
    expect(turnLock.isLocked(AGENT)).toBe(false)
  }, 60_000)
})

describe('Update dependencies', () => {
  it('updates every engine set up in the vault, not only the current one', async () => {
    await moveInClaude()
    expect((await switchTo({ engine: 'codex' })).final).toMatchObject({ status: 'done' })
    calls = {}
    const real = vaultService.client.bind(vaultService)
    vi.spyOn(vaultService, 'client').mockImplementation(async (id) => {
      const c = await real(id)
      return new Proxy(c, { get: (target, key) => key === 'request'
        ? (method: string, params: unknown) => method === 'exec' ? Promise.reject(new Error('no exec in this test')) : target.request(method as never, params as never)
        : Reflect.get(target, key) }) as never
    })
    const { moveId } = await moveService.updateDependencies(USER, AGENT)
    await moveService.waitForMove(moveId)
    expect(calls).toEqual({ claude: 1, codex: 1 })
  }, 60_000)
})

describe('Runs with: model, effort and work complexity (vault:set-runs-with)', () => {
  function rowVault(): Record<string, unknown> {
    return agentRepo.getOwned(USER, AGENT)!.driverConfig!['vault'] as Record<string, unknown>
  }

  it('writes model and effort into cinna.launch, keeping kind and approval, then the row; the next Claude plan runs on them', async () => {
    await moveInClaude()
    await moveService.setRunsWith(USER, AGENT, { model: 'opus', effort: 'high', complexity: null })
    expect(await kv('cinna.launch')).toEqual({ kind: 'kit', model: 'opus', approval: 'ask', effort: 'high' })
    expect(rowVault()).toMatchObject({ model: 'opus', effort: 'high' })
    expect(rowVault()['complexity']).toBeUndefined()
    const plan = await vaultDriverDeps().launcher('claude')!.plan({ userId: USER, agentId: AGENT } as never)
    if (!('spec' in plan)) throw new Error(JSON.stringify(plan))
    expect(plan.setup).toEqual({ modeId: 'default', model: 'opus', configOptions: [{ configId: 'effort', value: 'high', optional: true }] })
  }, 60_000)

  it('a complexity replaces the model and its effort, in the vault and on the row', async () => {
    await moveInClaude()
    await moveService.setRunsWith(USER, AGENT, { model: 'opus', effort: 'high', complexity: null })
    await moveService.setRunsWith(USER, AGENT, { model: null, effort: null, complexity: 'simple' })
    expect(await kv('cinna.launch')).toEqual({ kind: 'kit', approval: 'ask', model: null, complexity: 'simple' })
    expect(rowVault()).toMatchObject({ complexity: 'simple' })
    expect(rowVault()['model']).toBeUndefined()
    expect(rowVault()['effort']).toBeUndefined()
  }, 60_000)

  it('refuses what main cannot run, before writing anything', async () => {
    await moveInClaude()
    const before = await kv('cinna.launch')
    for (const bad of [
      { model: 'opus', effort: 'turbo', complexity: null },
      // Codex's efforts, not Claude's: Claude Code has no `minimal` or `none`.
      { model: 'opus', effort: 'minimal', complexity: null },
      { model: 'opus', effort: 'none', complexity: null },
      { model: null, effort: 'high', complexity: null },
      { model: 'opus', effort: null, complexity: 'medium' },
      { model: 'opus; rm -rf /', effort: null, complexity: null },
      { model: null, effort: null, complexity: 'hard' }
    ]) {
      await expect(moveService.setRunsWith(USER, AGENT, bad)).rejects.toMatchObject({ code: 'invalid' })
    }
    // And Claude's are not Codex's: Codex has no `max`.
    agentRepo.patchVaultConfig(USER, AGENT, { engine: 'codex' })
    await expect(moveService.setRunsWith(USER, AGENT, { model: 'gpt-5.6', effort: 'max', complexity: null })).rejects.toMatchObject({ code: 'invalid', message: 'Codex takes no “max” effort.' })
    agentRepo.patchVaultConfig(USER, AGENT, { engine: 'antigravity' })
    await expect(moveService.setRunsWith(USER, AGENT, { model: 'gemini-3.8-pro', effort: 'high', complexity: null })).rejects.toMatchObject({ code: 'invalid', message: 'Antigravity takes no reasoning effort.' })
    agentRepo.patchVaultConfig(USER, AGENT, { engine: 'opencode' })
    await expect(moveService.setRunsWith(USER, AGENT, { model: 'gpt-5.6', effort: null, complexity: null })).rejects.toMatchObject({ code: 'invalid' })
    expect(await kv('cinna.launch')).toEqual(before)
  }, 60_000)

  it('needs the vault unlocked', async () => {
    await moveInClaude()
    await vaultService.lock(USER, AGENT)
    await expect(moveService.setRunsWith(USER, AGENT, { model: null, effort: null, complexity: 'complex' })).rejects.toMatchObject({ code: 'locked' })
  }, 60_000)

  it('a switch of engine drops the model’s effort and keeps a complexity', async () => {
    await moveInClaude()
    await moveService.setRunsWith(USER, AGENT, { model: null, effort: null, complexity: 'complex' })
    expect((await switchTo({ engine: 'codex' })).final).toMatchObject({ status: 'done' })
    expect(await kv('cinna.launch')).toEqual({ kind: 'kit', approval: 'ask', model: null, complexity: 'complex' })
    expect(rowVault()).toMatchObject({ engine: 'codex', complexity: 'complex' })
    await moveService.setRunsWith(USER, AGENT, { model: 'gpt-5.6', effort: 'xhigh', complexity: null })
    expect((await switchTo({ engine: 'claude' })).final).toMatchObject({ status: 'done' })
    expect(await kv('cinna.launch')).toEqual({ kind: 'kit', approval: 'ask', model: null })
    expect(rowVault()['effort']).toBeUndefined()
    expect(rowVault()['complexity']).toBeUndefined()
  }, 60_000)
})
