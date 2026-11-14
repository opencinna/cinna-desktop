import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { VaultMoveProgressEvent } from '../../shared/vault/types'

/**
 * Move to vault… for the other engines (phase 2) against the real
 * cinna-vaultd run by the fake backend: the pre-check lets Codex and OpenCode
 * through (Antigravity too, on a Gemini key), a Codex agent moves in with its key
 * stored as `OPENAI_API_KEY` and its settings in the vault's kv, the move's
 * engine check passes even before a key exists (`auth_required` is an
 * answer), and a turn's plan starts codex-acp configured by vaultd.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const env = vi.hoisted(() => ({ root: '', folder: '', engine: 'codex', rootDefault: true }))

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
  agentsHomeService: { rootRows: () => [{ id: 'root-1', path: env.root, isDefault: env.rootDefault }] }
}))
vi.mock('../services/localAgents/scannerService', () => ({ markRootDirty: () => {}, scannerService: { markRootDirty: () => {} } }))
vi.mock('../services/localAgents/localAgentService', () => ({
  localAgentService: {
    get: (_userId: string, agentId: string) => ({
      id: agentId, manifestId: agentId.slice('folder:'.length), name: 'Ledger', path: env.folder, kind: 'kit', rootId: 'root-1',
      runtime: { engine: env.engine }, credentials: [], manifest: {}
    })
  }
}))

const { installEventPublisher } = await import('../host/events')
const { agentRepo } = await import('../db/agents')
const { installVaultBackend } = await import('./backend')
const { createFakeBackend } = await import('./fakeBackend')
const { vaultService } = await import('./vaultService')
const { vaultTranscripts } = await import('./transcriptStore')
const { resetVaultAgentsForTest } = await import('./isVaultAgent')
const { vaultAgentState } = await import('./vaultAgentState')
const { vaultCredentials } = await import('./vaultCredentials')
const { moveService, installVaultMoveDeps } = await import('./moveService')
const { buildVaultd, FAKE_CLAUDE_ADAPTER } = await import('./testSupport/fakeRuntime')
const { vaultDriverDeps } = await import('../agents/drivers/acp/vaultRuntime')
const { startVaultAcpConnection } = await import('../agents/drivers/acp/vaultAcpConnection')
type RuntimeSource = import('./runtimeInstall').RuntimeSource

const USER = '__default__'
const AGENT = 'folder:cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'

/**
 * A stand-in for codex-acp: records the environment vaultd gave it, then
 * answers like the fake Claude adapter — except that `session/new` is
 * `auth_required` while no OpenAI key is set, as codex-acp's is.
 */
const FAKE_CODEX_ADAPTER = `
const fsx = require('node:fs')
fsx.writeFileSync(require('node:path').join(process.env.HOME, 'codex-env.json'), JSON.stringify({
  CODEX_PATH: process.env.CODEX_PATH, CODEX_HOME: process.env.CODEX_HOME, homeExists: fsx.existsSync(process.env.CODEX_HOME || '/nonexistent'),
  CODEX_CONFIG: process.env.CODEX_CONFIG, INITIAL_AGENT_MODE: process.env.INITIAL_AGENT_MODE,
  DEFAULT_AUTH_REQUEST: process.env.DEFAULT_AUTH_REQUEST || null, OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'set' : 'unset'
}))
if (!process.env.OPENAI_API_KEY) {
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    pending += chunk
    let nl
    while ((nl = pending.indexOf('\\n')) >= 0) {
      const line = pending.slice(0, nl).trim(); pending = pending.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.id === undefined) continue
      const out = msg.method === 'initialize'
        ? { result: { protocolVersion: 1, agentCapabilities: {} } }
        : { error: { code: -32000, message: 'Authentication required' } }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...out }) + '\\n')
    }
  })
} else {
${FAKE_CLAUDE_ADAPTER}
}
`

let work = ''
let vaultdPath = ''
let events: VaultMoveProgressEvent[] = []

async function* bytesOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  yield buffer
}

/** Fake `codex` (vaultd only checks it is there) and a codex-acp tar holding {@link FAKE_CODEX_ADAPTER}. */
function fakeCodexSource(): RuntimeSource {
  const stage = join(work, 'codex-stage')
  const pkg = join(stage, 'node_modules', '@agentclientprotocol', 'codex-acp')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'dist', 'index.js'), FAKE_CODEX_ADAPTER)
  writeFileSync(join(pkg, 'package.json'), '{"name":"@agentclientprotocol/codex-acp","version":"0.0.0-fake","type":"commonjs"}\n')
  const tar = join(work, 'codex-adapter.tar')
  const made = spawnSync('tar', ['-c', '-f', tar, '-C', stage, ...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : []), 'node_modules'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (made.status !== 0) throw new Error(`tar failed: ${made.stderr}`)
  const adapter = readFileSync(tar)
  const executable = Buffer.from('#!/bin/sh\necho codex\n')
  return {
    pins: (engine) => engine !== 'codex' ? [] : [
      { engine: 'codex', kind: 'executable', version: '9.9.9-fake', sha256: createHash('sha256').update(executable).digest('hex') },
      { engine: 'codex', kind: 'adapter', version: '0.0.0-fake', sha256: null }
    ],
    async artifacts(engine) {
      if (engine !== 'codex') throw new Error(`no fake ${engine}`)
      return [
        { engine: 'codex', version: '9.9.9-fake', kind: 'executable', name: 'codex', open: () => bytesOf(executable), expectedSha256: createHash('sha256').update(executable).digest('hex') },
        { engine: 'codex', version: '0.0.0-fake', kind: 'adapter', name: 'codex-acp', open: () => bytesOf(adapter), expectedSha256: null }
      ]
    }
  }
}

async function moveIn(options: Record<string, unknown>): Promise<{ vaultId: string; final: VaultMoveProgressEvent }> {
  const { moveId } = await moveService.moveIn(USER, AGENT, options)
  await moveService.waitForMove(moveId)
  const final = events.filter((event) => event.moveId === moveId && (event.status === 'failed' || event.rotation)).at(-1)!
  expect(final, JSON.stringify(events.filter((e) => e.moveId === moveId && !e.output))).toMatchObject({ status: 'done' })
  const row = agentRepo.getOwned(USER, AGENT)!
  return { vaultId: (row.driverConfig!['vault'] as { vaultId: string }).vaultId, final }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'cinna-move-engines-'))
  vaultdPath = await buildVaultd(work)
}, 60_000)

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

beforeEach(() => {
  holder.current = createTestDatabase()
  env.root = mkdtempSync(join(tmpdir(), 'cinna-move-engines-root-'))
  env.folder = join(env.root, 'Local', 'ledger')
  env.engine = 'codex'
  env.rootDefault = true
  mkdirSync(env.folder, { recursive: true })
  writeFileSync(join(env.folder, 'AGENTS.md'), '# Ledger\n')
  events = []
  installEventPublisher((channel, payload) => {
    if (channel === 'vault:move-progress') events.push(payload as VaultMoveProgressEvent)
  })
  agentRepo.replaceFolderIndex(USER, 'root-1', [{
    id: AGENT, name: 'Ledger', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: 'codex'
  }])
  resetVaultAgentsForTest()
  vaultTranscripts.resetForTest()
  vaultAgentState.resetForTest()
  vaultCredentials.resetForTest()
  vaultService.resetForTest()
  installVaultBackend(createFakeBackend({ vaultdPath, nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }), windowMs: 60_000 }))
  vaultService.init()
  installVaultMoveDeps({
    runtimeSource: fakeCodexSource,
    instructions: (_userId, _agentId, engine) => `You are Ledger, on ${engine}.`,
    launchFacts: () => ({ model: 'gpt-5.6-luna', approval: 'ask', provider: 'openai' }),
    hostClaudeOnSubscription: async () => false,
    defaultEngine: () => 'claude'
  })
})

afterEach(async () => {
  await vaultService.shutdown()
  vaultTranscripts.resetForTest()
  resetVaultAgentsForTest()
  holder.current?.close()
  holder.current = null
  installEventPublisher(() => {})
  rmSync(env.root, { recursive: true, force: true })
})

describe('pre-check for the other engines', () => {
  it('lets Codex through and always asks for an OpenAI key (the ChatGPT login here never goes in)', async () => {
    const check = await moveService.precheck(USER, AGENT)
    expect(check).toMatchObject({ canMove: true, engine: 'codex', needsApiKey: true })
    expect(check.items.find((item) => item.kind === 'engine-login')).toMatchObject({ title: 'Codex needs an API key inside the vault', detail: expect.stringContaining('an OpenAI API key') })
  })

  it('lets OpenCode through on an OpenAI or Anthropic model only, and Antigravity through on a Gemini key', async () => {
    env.engine = 'opencode'
    installVaultMoveDeps({ launchFacts: () => ({ model: 'claude-haiku-4-5', approval: 'ask', provider: 'anthropic' }) })
    let check = await moveService.precheck(USER, AGENT)
    expect(check).toMatchObject({ canMove: true, engine: 'opencode', needsApiKey: true })
    expect(check.items.find((item) => item.kind === 'engine-login')?.detail).toContain('an Anthropic API key')
    installVaultMoveDeps({ launchFacts: () => ({ model: 'gemini-3-pro', approval: 'ask', provider: 'gemini' }) })
    check = await moveService.precheck(USER, AGENT)
    expect(check.canMove).toBe(false)
    expect(check.items.find((item) => item.severity === 'blocker')?.title).toBe('OpenCode in a vault reaches OpenAI and Anthropic models only')
    installVaultMoveDeps({ launchFacts: () => ({ model: null, approval: 'ask', provider: 'openai' }) })
    expect((await moveService.precheck(USER, AGENT)).items.find((item) => item.severity === 'blocker')?.title).toBe('This agent names no model')

    // Antigravity signs in inside with a Gemini API key (its Google sign-in cannot go in).
    env.engine = 'antigravity'
    check = await moveService.precheck(USER, AGENT)
    expect(check).toMatchObject({ canMove: true, engine: 'antigravity', needsApiKey: true })
    expect(check.items.find((item) => item.kind === 'engine-login')).toMatchObject({ severity: 'info', title: 'Antigravity needs an API key inside the vault', detail: expect.stringContaining('a Gemini API key') })
  })
})

describe('a pasted login that cannot sign in', () => {
  it('refuses a claude setup-token token for OpenCode on an Anthropic model before the move starts', async () => {
    env.engine = 'opencode'
    installVaultMoveDeps({ launchFacts: () => ({ model: 'claude-haiku-4-5', approval: 'ask', provider: 'anthropic' }) })
    await expect(moveService.moveIn(USER, AGENT, { apiKey: 'sk-ant-oat01-0123456789' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('Claude Code token') })
    expect(events).toEqual([])
    expect(agentRepo.getOwned(USER, AGENT)!.driverConfig?.['vault']).toBeUndefined()
  })
})

describe('Move to vault… on Codex', () => {
  it('moves in with the key as OPENAI_API_KEY and the settings in the vault; a turn\'s engine is configured by vaultd from them', async () => {
    const { vaultId } = await moveIn({ apiKey: 'sk-openai-test-0123456789' })
    const row = agentRepo.getOwned(USER, AGENT)!
    expect(row.driverConfig!['vault']).toMatchObject({ vaultId, engine: 'codex' })
    const client = await vaultService.client(vaultId)
    expect((await client.request('secrets.list', {})).names).toEqual(['OPENAI_API_KEY'])
    // No provider recorded for Codex; the prompt is the one assembled for Codex.
    expect((await client.request('kv.get', { key: 'cinna.launch' })).value).toEqual({ kind: 'kit', model: 'gpt-5.6-luna', approval: 'ask' })
    expect((await client.request('kv.get', { key: 'cinna.instructions' })).value).toBe('You are Ledger, on codex.')
    expect(await client.request('auth.status', { engine: 'codex' })).toEqual({ loggedIn: true, method: 'api_key', keyName: 'OPENAI_API_KEY' })

    // The readiness and the plan a turn takes.
    const deps = vaultDriverDeps()
    expect(await deps.readiness(USER, row)).toEqual({ state: 'ok', reason: null })
    const plan = await deps.launcher('codex')!.plan({ userId: USER, agentId: AGENT } as never)
    if (!('spec' in plan)) throw new Error(JSON.stringify(plan))
    expect(plan.setup).toEqual({ modeId: 'workspace-write' })
    const connection = await startVaultAcpConnection(plan.spec.vault!, plan.init)
    try {
      expect((await connection.newSession({ cwd: vaultService.agentCwd(vaultId), mcpServers: [] })).sessionId).toBeTruthy()
    } finally {
      await connection.dispose()
    }
    const home = join(env.root, 'SecureAgents', vaultId, 'fake-root', 'home')
    const seen = JSON.parse(readFileSync(join(home, 'codex-env.json'), 'utf8')) as Record<string, unknown>
    expect(seen).toMatchObject({
      CODEX_HOME: join(home, '.codex'), homeExists: true, INITIAL_AGENT_MODE: 'workspace-write',
      DEFAULT_AUTH_REQUEST: '{"methodId":"api-key"}', OPENAI_API_KEY: 'set'
    })
    expect(JSON.parse(seen['CODEX_CONFIG'] as string)).toEqual({ developer_instructions: 'You are Ledger, on codex.', model: 'gpt-5.6-luna' })
    expect(existsSync(String(seen['CODEX_PATH']))).toBe(true)
  }, 60_000)

  it('moves in without a key: the engine\'s auth_required is an answer, and readiness asks for the key', async () => {
    const { vaultId } = await moveIn({})
    const row = agentRepo.getOwned(USER, AGENT)!
    expect(row.source).toBe('vault')
    const client = await vaultService.client(vaultId)
    expect((await client.request('secrets.list', {})).names).toEqual([])
    expect(await vaultDriverDeps().readiness(USER, row)).toEqual({ state: 'not_logged_in', reason: 'Codex is not signed in inside this vault. Add an OpenAI API key on the agent’s Security tab.' })
  }, 60_000)
})
