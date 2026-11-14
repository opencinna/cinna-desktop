import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { VaultMoveProgressEvent } from '../../shared/vault/types'
import type { RunEvent } from '../../shared/runEvents'

/**
 * Move to vault… end to end against the real cinna-vaultd (bundled from
 * source, run by the fake backend as a plain Node process), with a fake
 * Claude runtime streamed in through `runtime.install`: pre-check findings,
 * the whole move (and the host folder left byte-identical), a turn through
 * the real ACP driver on the moved agent whose words reach the vault's
 * journal and never SQLite (D23), a failed move rolled back, and the host
 * copy and Move out.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const env = vi.hoisted(() => ({ root: '', folder: '', engine: 'claude', rootDefault: true, credentials: [] as unknown[] }))

vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
const logged = vi.hoisted(() => [] as string[])
vi.mock('../logger/logger', () => {
  const record = (...args: unknown[]): void => { logged.push(JSON.stringify(args)) }
  return { createLogger: () => ({ debug: record, info: record, warn: record, error: record }), setLogValueRedactor: () => {} }
})
vi.mock('../services/jobService', () => ({ jobService: { reportRunCompletion: () => {} } }))
vi.mock('../services/localAgents/agentsHomeService', () => ({
  agentsHomeService: { rootRows: () => [{ id: 'root-1', path: env.root, isDefault: env.rootDefault }] }
}))
vi.mock('../services/localAgents/scannerService', () => ({ markRootDirty: () => {}, scannerService: { markRootDirty: () => {} } }))
vi.mock('../services/localAgents/localAgentService', () => ({
  localAgentService: {
    get: (_userId: string, agentId: string) => ({
      id: agentId, manifestId: agentId.slice('folder:'.length), name: 'Payroll', path: env.folder, kind: 'kit', rootId: 'root-1',
      runtime: { engine: env.engine }, credentials: env.credentials, manifest: {}
    })
  }
}))

const { installEventPublisher } = await import('../host/events')
const { agentRepo } = await import('../db/agents')
const { chatRepo } = await import('../db/chats')
const { messageRepo } = await import('../db/messages')
const { installVaultBackend } = await import('./backend')
const { createFakeBackend } = await import('./fakeBackend')
const { vaultService } = await import('./vaultService')
const { vaultTranscripts, VAULT_REPLY_NOT_SAVED } = await import('./transcriptStore')
const { VaultdError } = await import('./vaultdClient')
const { resetVaultAgentsForTest, isVaultAgent } = await import('./isVaultAgent')
const { vaultAgentState } = await import('./vaultAgentState')
const { setVaultCredentialSourceForTest, vaultCredentials, VAULT_KV_SERVICE_CREDENTIALS } = await import('./vaultCredentials')
const { moveService, installVaultMoveDeps, vaultPromptName } = await import('./moveService')
const { buildVaultd, fakeRuntimeSource } = await import('./testSupport/fakeRuntime')
const { createAcpDriver } = await import('../agents/drivers/acp/acpDriver')
const { createAcpProcessPool } = await import('../agents/drivers/acp/acpProcessPool')
const { startAcpConnection } = await import('../agents/drivers/acp/acpConnection')
const { vaultAcpRuntime, vaultDriverDeps } = await import('../agents/drivers/acp/vaultRuntime')
const { pendingRequests } = await import('../agents/drivers/pendingRequests')
const { a2aStreamingService } = await import('../services/a2aStreamingService')

const USER = '__default__'
const AGENT = 'folder:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SECRET = 'OKAPI-5521-SECRET'

let work = ''
let vaultdPath = ''
let events: VaultMoveProgressEvent[] = []
let backend: ReturnType<typeof createFakeBackend> | null = null
const pools: { shutdown(): Promise<void> }[] = []

/** Every file and link under `dir` with its content hash: what "byte-identical" compares. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string): void => {
    const entries: Dirent[] = readdirSync(join(dir, rel), { withFileTypes: true })
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(dir, child)
      if (entry.isSymbolicLink()) out[child] = `link:${readlinkSync(full)}`
      else if (entry.isDirectory()) { out[`${child}/`] = 'dir'; walk(child) }
      else out[child] = createHash('sha256').update(readFileSync(full)).digest('hex') + `:${lstatSync(full).mode}`
    }
  }
  walk('')
  return out
}

function writeFolder(folder: string): void {
  const file = (rel: string, content: string | Buffer): void => {
    mkdirSync(join(folder, rel, '..'), { recursive: true })
    writeFileSync(join(folder, rel), content)
  }
  file('agent.md', `# Payroll\n`)
  file('scripts/notify.sh', '#!/bin/sh\nosascript -e "display notification \\"done\\""\n')
  file('scripts/report.py', 'print("hello")\n')
  file('bin/tool', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  file('.venv/lib/site.py', 'x = 1\n')
  file('src/__pycache__/a.cpython-312.pyc', 'junk')
  file('.cinna/antigravity/state.json', '{}')
  file('app-data/desktop.json', '{"sessions":{}}')
  file('credentials/credentials.json', '[{"secret":"generated"}]')
  file('credentials/cloud-1/credentials.json', '{}')
  file('credentials/.env', `PAYROLL_TOKEN=${SECRET}\nexport DB_URL=postgres://x\n`)
  file('.git/config', '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/payroll.git\n')
  file('.git/HEAD', 'ref: refs/heads/main\n')
  mkdirSync(join(folder, '.git', 'refs', 'heads'), { recursive: true })
  symlinkSync('/etc/hosts', join(folder, 'hosts-link'))
  symlinkSync('agent.md', join(folder, 'README.md'))
}

async function waitForFinal(moveId: string): Promise<VaultMoveProgressEvent> {
  await moveService.waitForMove(moveId)
  const final = events.filter((event) => event.moveId === moveId && (event.status === 'failed' || event.rotation)).at(-1)
  if (!final) throw new Error(`no final event: ${JSON.stringify(events.filter((e) => e.moveId === moveId))}`)
  return final
}

function vaultRoot(vaultId: string): string {
  return join(env.root, 'SecureAgents', vaultId, 'fake-root')
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'cinna-move-'))
  vaultdPath = await buildVaultd(work)
}, 60_000)

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

beforeEach(() => {
  holder.current = createTestDatabase()
  env.root = mkdtempSync(join(tmpdir(), 'cinna-move-root-'))
  env.folder = join(env.root, 'Local', 'payroll')
  env.engine = 'claude'
  env.rootDefault = true
  env.credentials = []
  writeFolder(env.folder)
  events = []
  logged.length = 0
  installEventPublisher((channel, payload) => {
    if (channel === 'vault:move-progress') events.push(payload as VaultMoveProgressEvent)
  })
  agentRepo.replaceFolderIndex(USER, 'root-1', [{
    id: AGENT, name: 'Payroll', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: 'claude'
  }])
  resetVaultAgentsForTest()
  vaultTranscripts.resetForTest()
  vaultAgentState.resetForTest()
  vaultCredentials.resetForTest()
  setVaultCredentialSourceForTest(null)
  vaultService.resetForTest()
  backend = createFakeBackend({ vaultdPath, nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }), windowMs: 60_000 })
  installVaultBackend(backend)
  vaultService.init()
  installVaultMoveDeps({
    runtimeSource: () => fakeRuntimeSource(work),
    instructions: () => 'You are Payroll, inside a vault.',
    launchFacts: () => ({ model: 'haiku', approval: 'ask' }),
    hostClaudeOnSubscription: async () => true,
    defaultEngine: () => 'claude'
  })
})

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.shutdown()
  pendingRequests.clear()
  await vaultService.shutdown()
  backend = null
  vaultTranscripts.resetForTest()
  resetVaultAgentsForTest()
  holder.current?.close()
  holder.current = null
  installEventPublisher(() => {})
  rmSync(env.root, { recursive: true, force: true })
})

describe('Move to vault… pre-check', () => {
  it('lists what will not work inside and what is not copied, and changes nothing', async () => {
    const before = tree(env.folder)
    const check = await moveService.precheck(USER, AGENT)
    const kinds = Object.fromEntries(check.items.map((item) => [item.kind, item]))
    expect(kinds['mac-command']).toMatchObject({ severity: 'warning', paths: ['scripts/notify.sh'] })
    expect(kinds['macho-binary']).toMatchObject({ paths: ['bin/tool'] })
    expect(kinds['absolute-symlink']).toMatchObject({ paths: ['hosts-link'] })
    expect(kinds['env-file']).toMatchObject({ paths: ['credentials/.env'] })
    expect(kinds['git-remote']?.detail).toContain('git@github.com:acme/payroll.git')
    expect(kinds['engine-login']).toMatchObject({ severity: 'info' })
    expect(check).toMatchObject({ canMove: true, needsApiKey: true, engine: 'claude', folderPath: env.folder })
    // agent.md, two scripts, bin/tool, credentials/.env, .git/config, .git/HEAD.
    expect(check.copyFiles).toBe(7)
    expect(tree(env.folder)).toEqual(before)
    // No Python project: nothing said about Python.
    expect(kinds['python-lock']).toBeUndefined()
    expect(kinds['python-wheels']).toBeUndefined()
  })

  it('says a Python project without a uv.lock is locked inside on first install, and wheels only for one with it', async () => {
    writeFileSync(join(env.folder, 'pyproject.toml'), '[project]\nname = "payroll"\nversion = "0.1.0"\n')
    const unlocked = await moveService.precheck(USER, AGENT)
    expect(unlocked.items.find((item) => item.kind === 'python-lock')).toMatchObject({ severity: 'info', title: 'No uv.lock: the vault resolves and locks dependencies on first install' })
    // A fresh kit agent has no lock: it still moves.
    expect(unlocked.canMove).toBe(true)
    writeFileSync(join(env.folder, 'uv.lock'), 'version = 1\n')
    const locked = await moveService.precheck(USER, AGENT)
    expect(locked.items.find((item) => item.kind === 'python-lock')).toBeUndefined()
    expect(locked.items.find((item) => item.kind === 'python-wheels')).toMatchObject({ severity: 'info' })
    expect(locked.canMove).toBe(true)
  })

  it('asks the engine a turn would run on: the machine default for a folder that names none, not the row\'s cached launcher', async () => {
    env.engine = ''
    agentRepo.replaceFolderIndex(USER, 'root-1', [{
      id: AGENT, name: 'Payroll', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: 'opencode'
    }])
    installVaultMoveDeps({ defaultEngine: () => 'claude' })
    expect((await moveService.precheck(USER, AGENT)).items.map((item) => item.kind)).not.toContain('unsupported-engine')
    installVaultMoveDeps({ defaultEngine: () => 'antigravity' })
    expect((await moveService.precheck(USER, AGENT)).engine).toBe('antigravity')
  })

  it('blocks another engine and an agent outside the main agents folder', async () => {
    env.engine = 'custom'
    env.rootDefault = false
    const check = await moveService.precheck(USER, AGENT)
    expect(check.items.filter((item) => item.severity === 'blocker').map((item) => item.kind).sort()).toEqual(['external-root', 'unsupported-engine'])
    expect(check.canMove).toBe(false)
    await expect(moveService.moveIn(USER, AGENT, {})).rejects.toMatchObject({ code: 'invalid' })
    expect(existsSync(join(env.root, 'SecureAgents'))).toBe(false)
  })
})

describe('the name the helper prompts with', () => {
  it('keeps letters, digits, spaces and . _ - \' ( ); turns anything else into a space, collapses, trims and caps at 60', () => {
    expect(vaultPromptName('Payroll')).toBe('Payroll')
    expect(vaultPromptName('Zoë’s Agent (v2.1) — beta_test')).toBe('Zoë s Agent (v2.1) beta_test')
    expect(vaultPromptName('  Ledger\n\t"bot"/🙂  ')).toBe('Ledger bot')
    expect(vaultPromptName('Бухгалтер 会計 ٣')).toBe('Бухгалтер 会計 ٣')
    expect(vaultPromptName('a'.repeat(59) + ' bcd')).toBe('a'.repeat(59))
    expect([...vaultPromptName('é'.repeat(80))]).toHaveLength(60)
    // Nothing left: the slug, then "Agent".
    expect(vaultPromptName('🙂🙂 !!', 'payroll-agent')).toBe('payroll-agent')
    expect(vaultPromptName('🙂', '')).toBe('Agent')
  })

  it('a move creates the vault under the mapped name instead of failing on an unusual one', async () => {
    agentRepo.replaceFolderIndex(USER, 'root-1', [{
      id: AGENT, name: 'Payroll 💸 <prod>', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: 'claude'
    }])
    const create = vi.spyOn(backend!, 'create')
    const { moveId } = await moveService.moveIn(USER, AGENT, {})
    await waitForFinal(moveId)
    expect(create.mock.calls[0]?.[0].agentName).toBe('Payroll prod')
  }, 60_000)
})

describe('Move to vault…', () => {
  async function moveInOk(): Promise<{ vaultId: string; final: VaultMoveProgressEvent }> {
    const { moveId } = await moveService.moveIn(USER, AGENT, { apiKey: 'sk-ant-test-0123456789' })
    const final = await waitForFinal(moveId)
    expect(final, JSON.stringify(events)).toMatchObject({ status: 'done' })
    const row = agentRepo.getOwned(USER, AGENT)!
    return { vaultId: (row.driverConfig!['vault'] as { vaultId: string }).vaultId, final }
  }

  it('copies the folder in without build outputs, rebuilds nothing without pyproject, checks the engine, and marks the row', async () => {
    const before = tree(env.folder)
    const { vaultId, final } = await moveInOk()
    const steps = events.filter((e) => !e.output && e.status !== 'running').map((e) => `${e.step}:${e.status}`)
    expect(steps).toEqual(['create:done', 'unlock:done', 'approve:done', 'runtime:done', 'copy:done', 'rebuild:skipped', 'credentials:done', 'check:done', 'check:done'])
    expect(final.rotation).toEqual(expect.arrayContaining([
      { kind: 'env-key', name: 'PAYROLL_TOKEN', detail: 'credentials/.env' },
      { kind: 'env-key', name: 'DB_URL', detail: 'credentials/.env' },
      expect.objectContaining({ kind: 'git-history' })
    ]))
    // No secret value in any progress event.
    expect(JSON.stringify(events)).not.toContain(SECRET)

    const inside = tree(join(vaultRoot(vaultId), 'agent'))
    expect(Object.keys(inside).sort()).toEqual([
      '.git/', '.git/HEAD', '.git/config', '.git/refs/', '.git/refs/heads/', 'README.md', 'agent.md', 'app-data/', 'bin/', 'bin/tool',
      'credentials/', 'credentials/.env', 'credentials/cloud-1/', 'scripts/', 'scripts/notify.sh', 'scripts/report.py', 'src/'
    ])
    expect(inside['README.md']).toBe('link:agent.md')

    const row = agentRepo.getOwned(USER, AGENT)!
    expect(row.source).toBe('vault')
    expect(row.driverConfig!['vault']).toMatchObject({ vaultId, engine: 'claude', kind: 'kit', model: 'haiku', hostCopyPath: env.folder })
    expect(isVaultAgent(AGENT)).toBe(true)
    // The host folder is untouched and still there.
    expect(tree(env.folder)).toEqual(before)

    const client = await vaultService.client(vaultId)
    expect((await client.request('secrets.list', {})).names).toEqual(['ANTHROPIC_API_KEY'])
    expect((await client.request('kv.get', { key: 'cinna.instructions' })).value).toBe('You are Payroll, inside a vault.')
    expect((await client.request('runtime.status', {})).runtimes.map((r) => `${r.kind}:${r.version}`).sort()).toEqual(['adapter:0.0.0-fake', 'executable:9.9.9-fake'])
  }, 60_000)

  it('runs a turn on the moved agent through the ACP driver: the words reach the vault journal and never SQLite', async () => {
    const { vaultId } = await moveInOk()
    const row = agentRepo.getOwned(USER, AGENT)!
    const chatId = chatRepo.create(USER, {}).id
    vaultService.bindChat(USER, USER, chatId, AGENT)
    const pool = createAcpProcessPool({ start: startAcpConnection })
    pools.push(pool)
    const driver = createAcpDriver({
      pool, launcher: () => undefined, vault: vaultDriverDeps(),
      readRuntime: (_userId, agent) => vaultAcpRuntime(agent),
      withLock: (_id, _owner, fn) => fn(),
      registerRequest: (input) => pendingRequests.register(input),
      resolveRequest: (id, resolution) => pendingRequests.resolve(id, resolution) !== null
    })
    expect(await driver.readiness(USER, row)).toEqual({ state: 'ok', reason: null })
    // The move's own check wrote it once; the turn's engine must write it again.
    rmSync(join(vaultRoot(vaultId), 'home', '.claude', 'settings.json'), { force: true })

    const userMessageId = messageRepo.saveUser({ chatId, content: `ask ${SECRET}` })
    const posted: RunEvent[] = []
    await a2aStreamingService.streamToAgent({
      chatId, agentId: AGENT,
      port: { postMessage: (event) => void posted.push(event), close: () => {} },
      marker: { profileId: USER, userMessageId, driver: 'acp' },
      run: (io) => driver.run(USER, row, { chatId, wireContent: `ask ${SECRET}`, signal: io.signal, onEvent: io.onEvent })
    })
    expect(posted.at(-1), JSON.stringify(posted.slice(-3))).toMatchObject({ type: 'done' })
    const reply = chatRepo.listMessages(chatId).at(-1)!
    expect(reply.role).toBe('assistant')
    expect(reply.content).toContain(`vault says: ask ${SECRET}`)
    // It ran inside: the guest's agent folder and home, the vault's own key.
    expect(reply.content).toContain(`cwd=${realpathSync(join(vaultRoot(vaultId), 'agent'))}`)
    expect(reply.content).toContain(`home=${join(vaultRoot(vaultId), 'home')}`)
    expect(reply.content).toContain('key=set')

    // The session opened in the row's approval mode: vaultd recorded it for Claude inside.
    expect(JSON.parse(readFileSync(join(vaultRoot(vaultId), 'home', '.claude', 'settings.json'), 'utf8'))).toEqual({ permissions: { defaultMode: 'default' } })
    // No log line carries them either (D23), tool calls included.
    expect(logged.some((line) => line.includes('tool call'))).toBe(true)
    expect(logged.filter((line) => line.includes(SECRET))).toEqual([])
    // SQLite never saw the chat's words.
    const sqlite = holder.current!.sqlite
    expect((sqlite.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(0)
    expect((sqlite.prepare('SELECT count(*) AS n FROM inflight_turns').get() as { n: number }).n).toBe(0)
    for (const table of ['chats', 'messages', 'messages_search', 'a2a_sessions', 'agents', 'tasks']) {
      expect(JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(SECRET)
    }
    // The vault's journal has both rows.
    const client = await vaultService.client(vaultId)
    await vi.waitFor(async () => {
      const { ops } = await client.request('transcript.read', { chatId })
      const text = JSON.stringify(ops)
      expect(text).toContain(`ask ${SECRET}`)
      expect(text).toContain(`vault says: ask ${SECRET}`)
    }, { timeout: 5_000 })
    // The engine session is remembered inside the vault too.
    await vaultAgentState.settled(vaultId)
    expect((await client.request('kv.get', { key: 'cinna.sessions' })).value).toEqual({ [chatId]: 'fake-session-1' })

    // A chat that is not this vault's is refused before anything runs.
    const hostChat = chatRepo.create(USER, {}).id
    const refused = await driver.run(USER, row, { chatId: hostChat, wireContent: 'hi', signal: new AbortController().signal, onEvent: () => {} })
    expect(refused.error?.message).toContain('in a vault')

    // Locked: readiness says so and a turn is refused without reaching the vault.
    await vaultService.lock(USER, AGENT)
    expect(await driver.readiness(USER, row)).toMatchObject({ state: 'vault_locked' })
  }, 60_000)

  it('launches on the settings inside the vault, not the host row: a tampered mode, model or kind changes nothing (D34)', async () => {
    const { vaultId } = await moveInOk()
    const client = await vaultService.client(vaultId)
    expect((await client.request('kv.get', { key: 'cinna.launch' })).value).toEqual({ kind: 'kit', model: 'haiku', approval: 'ask' })
    // Cinna's database is not trusted: someone rewrites the row.
    agentRepo.patchVaultConfig(USER, AGENT, { approval: 'auto', model: 'opus', kind: 'bare' })
    const row = agentRepo.getOwned(USER, AGENT)!
    expect(row.driverConfig!['vault']).toMatchObject({ approval: 'auto', model: 'opus', kind: 'bare' })

    // The runtime view is the same whatever the row says (display-only, D34).
    const tamperedView = vaultAcpRuntime(row)!
    expect(tamperedView.type === 'folder' && { kind: tamperedView.folder.kind, runtimeMode: tamperedView.folder.runtimeMode }).toEqual({ kind: 'kit', runtimeMode: 'isolated' })

    const launcher = vaultDriverDeps().launcher('claude')!
    // Even handed a native folder view, the plan reads only the vault's cinna.launch.
    const plan = await launcher.plan({ userId: USER, agentId: AGENT, folder: { ...(tamperedView as { folder: object }).folder, kind: 'bare', runtimeMode: 'native' } } as never)
    if (!('spec' in plan)) throw new Error(JSON.stringify(plan))
    expect(plan.spec.vault).toMatchObject({ mode: 'default' })
    expect(plan.setup).toMatchObject({ modeId: 'default', model: 'haiku' })
    const options = (plan.session.meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options
    expect(options).toMatchObject({ model: 'haiku', settingSources: [], systemPrompt: 'You are Payroll, inside a vault.' })

    // And what engine.spawn actually received: vaultd writes the session's mode for Claude inside.
    const chatId = chatRepo.create(USER, {}).id
    vaultService.bindChat(USER, USER, chatId, AGENT)
    const pool = createAcpProcessPool({ start: startAcpConnection })
    pools.push(pool)
    const driver = createAcpDriver({
      pool, launcher: () => undefined, vault: vaultDriverDeps(),
      readRuntime: (_userId, agent) => vaultAcpRuntime(agent),
      withLock: (_id, _owner, fn) => fn(),
      registerRequest: (input) => pendingRequests.register(input),
      resolveRequest: (id, resolution) => pendingRequests.resolve(id, resolution) !== null
    })
    rmSync(join(vaultRoot(vaultId), 'home', '.claude', 'settings.json'), { force: true })
    const result = await driver.run(USER, row, { chatId, wireContent: 'hello', signal: new AbortController().signal, onEvent: () => {} })
    expect(result.error).toBeUndefined()
    expect(JSON.parse(readFileSync(join(vaultRoot(vaultId), 'home', '.claude', 'settings.json'), 'utf8'))).toEqual({ permissions: { defaultMode: 'default' } })
  }, 60_000)

  it('retries a failed journal write in order, and tells the turn when a reply can never reach the vault', async () => {
    const { vaultId } = await moveInOk()
    const chatId = chatRepo.create(USER, {}).id
    vaultService.bindChat(USER, USER, chatId, AGENT)
    const real = vaultService.client.bind(vaultService)
    // Two transient failures (a stalled or closed channel), then through.
    let failures = 2
    const spy = vi.spyOn(vaultService, 'client').mockImplementation(async (id) => {
      if (failures > 0) { failures--; throw new VaultdError('closed', 'channel closed') }
      return real(id)
    })
    messageRepo.saveUser({ chatId, content: 'first' })
    messageRepo.saveUser({ chatId, content: 'second' })
    expect(await vaultTranscripts.settled(vaultId, chatId, 5_000)).toBe('saved')
    const client = await real(vaultId)
    const { ops } = await client.request('transcript.read', { chatId })
    expect(ops.filter((op) => op.op === 'put').map((op) => (op as { row: Record<string, unknown> }).row["content"])).toEqual(['first', 'second'])

    // The vault refuses for good: the turn ends with the error the user reads.
    spy.mockImplementation(async (id) => {
      const c = await real(id)
      return { ...c, request: (async (method: string, params: unknown) => method === 'transcript.append' ? Promise.reject(new VaultdError('not_found', 'gone')) : c.request(method as never, params as never)) } as never
    })
    const posted: RunEvent[] = []
    await a2aStreamingService.streamToAgent({
      chatId, agentId: AGENT,
      port: { postMessage: (event) => void posted.push(event), close: () => {} },
      run: async () => ({ text: 'a reply', parts: [{ kind: 'text', text: 'a reply' } as never], notices: [] })
    })
    expect(posted.at(-1)).toEqual({ type: 'error', error: VAULT_REPLY_NOT_SAVED })
    spy.mockRestore()
  }, 60_000)

  it('a turn that ends after its vault locked keeps its reply: the rows wait in the journal queue for the next unlock, SQLite sees nothing', async () => {
    const { vaultId } = await moveInOk()
    const chatId = chatRepo.create(USER, {}).id
    vaultService.bindChat(USER, USER, chatId, AGENT)
    const userMessageId = messageRepo.saveUser({ chatId, content: `locked ${SECRET}` })
    const posted: RunEvent[] = []
    await a2aStreamingService.streamToAgent({
      chatId, agentId: AGENT,
      port: { postMessage: (event) => void posted.push(event), close: () => {} },
      marker: { profileId: USER, userMessageId, driver: 'acp' },
      // Lock now, mid-stream: the reply arrives after the vault locked.
      run: async () => {
        await vaultService.lock(USER, AGENT)
        return { text: `reply ${SECRET}`, parts: [{ kind: 'text', text: `reply ${SECRET}` } as never], notices: [] }
      }
    })
    expect(posted.at(-1), JSON.stringify(posted.slice(-2))).toMatchObject({ type: 'done' })
    const sqlite = holder.current!.sqlite
    expect((sqlite.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(0)
    expect((sqlite.prepare('SELECT count(*) AS n FROM inflight_turns').get() as { n: number }).n).toBe(0)

    // Delivered, in order, once the vault is unlocked again; the rebuild has it.
    await vaultService.unlock(USER, AGENT)
    await vi.waitFor(() => {
      expect(chatRepo.listMessages(chatId).map((row) => `${row.role}:${row.content}`)).toEqual([`user:locked ${SECRET}`, `assistant:reply ${SECRET}`])
    }, { timeout: 5_000 })
    const { ops } = await (await vaultService.client(vaultId)).request('transcript.read', { chatId })
    expect(JSON.stringify(ops)).toContain(`reply ${SECRET}`)
  }, 60_000)

  it('delivers the attached service credentials into the vault at move-in, and again before a turn once they change', async () => {
    env.credentials = [{ id: 'crm', name: 'CRM key', credentialId: 'cred-1', attached: true }]
    const attachments = { local: [{ ref: 'cred-1' }], accounts: {} }
    let token = `TOKEN-1-${SECRET}`
    const rendered: string[] = []
    setVaultCredentialSourceForTest({
      attachmentsOf: (agentId) => { expect(agentId).toBe(AGENT); return attachments },
      vaultFiles: async (given, directory) => {
        expect(given).toEqual(attachments)
        rendered.push(directory)
        return {
          generation: 'g1',
          files: new Map([
            ['credentials.json', JSON.stringify([{ id: 'crm', credential_data: { token, file_path: `${directory}/sa.json` } }])],
            ['sa.json', '{"type":"service_account"}']
          ])
        }
      }
    })
    const check = await moveService.precheck(USER, AGENT)
    // No longer a warning: they move in with the agent.
    expect(check.items.find((item) => item.kind === 'service-credential')).toMatchObject({ severity: 'info' })
    const { vaultId, final } = await moveInOk()
    expect(final.rotation).toContainEqual({ kind: 'service-credential', name: 'CRM key', credentialId: 'cred-1' })
    const run = join(vaultRoot(vaultId), 'run-secrets')
    expect(rendered[0]).toBe(run)
    expect(readFileSync(join(run, 'credentials.json'), 'utf8')).toContain(`TOKEN-1-${SECRET}`)
    expect(lstatSync(join(run, 'credentials.json')).mode & 0o777).toBe(0o400)
    expect(readFileSync(join(run, 'sa.json'), 'utf8')).toBe('{"type":"service_account"}')
    // Captured inside, and nothing generated on this computer.
    const client = await vaultService.client(vaultId)
    expect((await client.request('kv.get', { key: VAULT_KV_SERVICE_CREDENTIALS })).value).toEqual(attachments)
    expect(readFileSync(join(env.folder, 'credentials', 'credentials.json'), 'utf8')).toBe('[{"secret":"generated"}]')

    const row = agentRepo.getOwned(USER, AGENT)!
    // Unchanged: a turn writes nothing.
    const put = vi.spyOn(client, 'request')
    const release = await vaultDriverDeps().hold(USER, row)
    await release()
    expect(put.mock.calls.filter(([method]) => method === 'secrets.putFile')).toEqual([])
    // Rotated: the next turn delivers it.
    token = `TOKEN-2-${SECRET}`
    const release2 = await vaultDriverDeps().hold(USER, row)
    await release2()
    expect(readFileSync(join(run, 'credentials.json'), 'utf8')).toContain(`TOKEN-2-${SECRET}`)
    expect(JSON.stringify(holder.current!.sqlite.prepare('SELECT * FROM agents').all())).not.toContain(SECRET)
  }, 60_000)

  it('rebuilds a Python agent with one rebuild exec, so one install credential covers uv python install and uv sync', async () => {
    writeFileSync(join(env.folder, 'pyproject.toml'), '[project]\nname = "payroll"\nversion = "0.1.0"\n')
    const presets: string[] = []
    const real = vaultService.client.bind(vaultService)
    const spy = vi.spyOn(vaultService, 'client').mockImplementation(async (id) => {
      const c = await real(id)
      return new Proxy(c, { get: (target, key) => key === 'request'
        ? (method: string, params: { preset?: string }) => { if (method === 'exec' && params.preset) presets.push(params.preset); return target.request(method as never, params as never) }
        : Reflect.get(target, key) }) as never
    })
    try {
      const { moveId } = await moveService.moveIn(USER, AGENT, {})
      await waitForFinal(moveId)
    } finally {
      spy.mockRestore()
    }
    // Whatever uv made of it here: never two execs on the move's token.
    expect(presets[0]).toBe('rebuild')
    expect(presets.filter((p) => p === 'uv-python-install' || p === 'uv-sync')).toEqual([])
  }, 120_000)

  it('rolls back a move whose runtime does not match its pin: the vault is gone and the host folder byte-identical', async () => {
    installVaultMoveDeps({ runtimeSource: () => fakeRuntimeSource(work, { executableSha: 'f'.repeat(64) }) })
    const before = tree(env.folder)
    const { moveId } = await moveService.moveIn(USER, AGENT, {})
    const final = await waitForFinal(moveId)
    expect(final).toMatchObject({ step: 'runtime', status: 'failed', rolledBack: true })
    expect(final.message).toMatch(/does not match[^.]*\.\)?\. Nothing was changed on this computer\.$|does not match.*\. Nothing was changed on this computer\.$/)
    expect(readdirSync(join(env.root, 'SecureAgents')).filter((name) => !name.startsWith('.'))).toEqual([])
    expect(agentRepo.getOwned(USER, AGENT)!.source).toBe('folder')
    expect(isVaultAgent(AGENT)).toBe(false)
    expect(tree(env.folder)).toEqual(before)
  }, 60_000)

  it('reports a failure after the agent was marked as a move with a warning, and keeps the vault', async () => {
    const spy = vi.spyOn(vaultService, 'adoptUnlocked').mockRejectedValue(new Error('the transcripts could not be read'))
    try {
      const { moveId } = await moveService.moveIn(USER, AGENT, {})
      const final = await waitForFinal(moveId)
      expect(final).toMatchObject({ status: 'done', message: 'The agent is in its vault.' })
      expect(final.warning).toContain('the transcripts could not be read')
      expect(final.message).not.toContain('half-built')
    } finally {
      spy.mockRestore()
    }
    const row = agentRepo.getOwned(USER, AGENT)!
    expect(row.source).toBe('vault')
    const vaultId = (row.driverConfig!['vault'] as { vaultId: string }).vaultId
    expect(existsSync(join(env.root, 'SecureAgents', vaultId))).toBe(true)
  }, 60_000)

  it('keeps the host copy until the typed name deletes it, then moves out as a folder agent again', async () => {
    const { vaultId } = await moveInOk()
    expect(await moveService.hostCopy(USER, AGENT)).toMatchObject({ folderPath: env.folder, inGitRepo: true, gitRemote: 'git@github.com:acme/payroll.git' })
    // Move out refuses to overwrite the host copy.
    await expect(moveService.moveOut(USER, AGENT)).rejects.toMatchObject({ code: 'invalid' })
    await expect(moveService.deleteHostCopy(USER, AGENT, 'payroll')).rejects.toMatchObject({ code: 'invalid' })
    expect(existsSync(env.folder)).toBe(true)

    // The stored path is not proof. Another agent's folder now sits there: refused.
    const manifest = join(env.folder, 'cinna-agent.json')
    writeFileSync(manifest, JSON.stringify({ id: 'someone-else', name: 'Other' }))
    await expect(moveService.deleteHostCopy(USER, AGENT, 'Payroll')).rejects.toMatchObject({ code: 'invalid' })
    expect(existsSync(env.folder)).toBe(true)
    // The path itself is a link (to a folder that is this agent's): refused, nothing behind it deleted.
    writeFileSync(manifest, JSON.stringify({ id: AGENT.slice('folder:'.length), name: 'Payroll' }))
    const real = join(env.root, 'Local', 'payroll-real')
    renameSync(env.folder, real)
    symlinkSync(real, env.folder)
    await expect(moveService.deleteHostCopy(USER, AGENT, 'Payroll')).rejects.toMatchObject({ code: 'invalid' })
    expect(existsSync(join(real, 'agent.md'))).toBe(true)
    rmSync(env.folder)
    renameSync(real, env.folder)

    // Its own folder (manifest id = the agent's), really inside the root: deleted.
    await moveService.deleteHostCopy(USER, AGENT, 'Payroll')
    expect(existsSync(env.folder)).toBe(false)
    expect(await moveService.hostCopy(USER, AGENT)).toBeNull()

    const { folderPath } = await moveService.moveOut(USER, AGENT)
    expect(folderPath).toBe(env.folder)
    expect(readFileSync(join(folderPath, 'agent.md'), 'utf8')).toBe('# Payroll\n')
    expect(readFileSync(join(folderPath, 'credentials/.env'), 'utf8')).toContain(SECRET)
    const row = agentRepo.getOwned(USER, AGENT)!
    expect(row).toMatchObject({ source: 'folder', localPath: env.folder, localRootId: 'root-1' })
    expect(row.driverConfig?.['vault']).toBeUndefined()
    expect(isVaultAgent(AGENT)).toBe(false)
    expect(existsSync(join(env.root, 'SecureAgents', vaultId))).toBe(false)
  }, 60_000)
})
