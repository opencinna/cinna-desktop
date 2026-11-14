import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { STUB_VAULTD } from './testSupport/stubVaultd'

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

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
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))

const { agentRepo } = await import('../db/agents')
const { chatRepo } = await import('../db/chats')
const { messageRepo } = await import('../db/messages')
const { installRuntimeHost } = await import('../host/runtimeHost')
const { installEventPublisher } = await import('../host/events')
const { installVaultBackend, unavailableBackend } = await import('./backend')
const { createFakeBackend } = await import('./fakeBackend')
const { vaultService } = await import('./vaultService')
const { vaultTranscripts } = await import('./transcriptStore')
const { isVaultAgent, resetVaultAgentsForTest, vaultChatReadiness } = await import('./isVaultAgent')
const { agentsHomeService } = await import('../services/localAgents/agentsHomeService')

const USER = '__default__'
const AGENT = 'folder:cccccccc-0000-0000-0000-000000000003'
const VAULT = 'vault-svc'

let home = ''
let published: { channel: string; payload: unknown; audience: string }[] = []
let backend: ReturnType<typeof createFakeBackend>

function host(isPackaged: boolean): void {
  installRuntimeHost({ isPackaged, getAppPath: () => home } as never)
}

beforeEach(async () => {
  holder.current = createTestDatabase()
  home = mkdtempSync(join(tmpdir(), 'cinna-vault-svc-'))
  const stub = join(home, 'stub-vaultd.cjs')
  writeFileSync(stub, STUB_VAULTD)
  host(false)
  published = []
  installEventPublisher((channel, payload, audience) => published.push({ channel, payload, audience }))
  vi.spyOn(agentsHomeService, 'rootRows').mockReturnValue([{ id: 'root-1', path: home, isDefault: true, kind: 'workshop' } as never])
  agentRepo.replaceFolderIndex(USER, 'root-1', [{ id: AGENT, name: 'Ledger', description: null, localPath: join(home, 'Local', 'ledger'), remoteMetadata: {} as never, launcher: 'claude' }])
  agentRepo.markVault(USER, AGENT, { vaultId: VAULT, engine: 'claude' })
  backend = createFakeBackend({ vaultdPath: stub, nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }) })
  vaultTranscripts.resetForTest()
  vaultService.resetForTest()
  installVaultBackend(backend)
  vaultService.init()
  const dir = vaultService.ensureSecureAgentsDir(USER)
  await backend.create({ dir, vaultId: VAULT, agentId: AGENT, agentName: 'Ledger', engine: 'claude', sizeBytes: 10 * 1024 ** 3, egress: { hosts: [] }, rootfsPath: '' })
})

afterEach(async () => {
  await vaultService.shutdown()
  vaultService.resetForTest()
  vaultTranscripts.resetForTest()
  installVaultBackend(unavailableBackend('helper-missing'))
  resetVaultAgentsForTest()
  vi.restoreAllMocks()
  holder.current?.close()
  holder.current = null
  rmSync(home, { recursive: true, force: true })
})

describe('vaultService', () => {
  it('makes SecureAgents/ with a .gitignore of "*" and its marker, and refuses a folder of that name it did not make', () => {
    const dir = join(home, 'SecureAgents')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n')
    expect(existsSync(join(dir, '.cinna-vaults'))).toBe(true)

    const other = mkdtempSync(join(tmpdir(), 'cinna-vault-foreign-'))
    try {
      mkdirSync(join(other, 'secureagents'))
      vi.spyOn(agentsHomeService, 'rootRows').mockReturnValue([{ id: 'root-2', path: other, isDefault: true } as never])
      expect(() => vaultService.ensureSecureAgentsDir(USER)).toThrow(/did not make/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('knows its vault agents from the rows', () => {
    expect(isVaultAgent(AGENT)).toBe(true)
    expect(vaultService.list(USER)).toEqual([expect.objectContaining({ agentId: AGENT, vaultId: VAULT, state: 'locked', engine: 'claude' })])
  })

  it('unlocks, journals a vault chat through vaultd, drops it on lock and rebuilds it on the next unlock', async () => {
    const unlocked = await vaultService.unlock(USER, AGENT)
    expect(unlocked.state).toBe('unlocked')
    expect(published).toContainEqual({ channel: 'vault:state', audience: 'all', payload: expect.objectContaining({ agentId: AGENT, vaultId: VAULT, state: 'unlocked' }) })

    const chat = chatRepo.create(USER, { agentId: AGENT })
    vaultService.bindChat(USER, USER, chat.id, AGENT)
    messageRepo.saveUser({ chatId: chat.id, content: 'what is owed?' })
    messageRepo.saveAssistant({ chatId: chat.id, content: '42', sourceAgentId: AGENT })
    const rows = chatRepo.listMessages(chat.id)
    // Let the journal writes reach the stub vaultd.
    await vi.waitFor(async () => {
      const client = await vaultService.client(VAULT)
      expect((await client.request('transcript.read', { chatId: chat.id })).ops).toHaveLength(2)
    })

    // Memory dropped while vaultd keeps the journal (a real guest keeps it on
    // its disk across a lock; the fake's lock stops its process): the next
    // unlock rebuilds the chat from it.
    vaultTranscripts.closeVault(VAULT)
    expect(chatRepo.listMessages(chat.id)).toEqual([])
    await vaultService.unlock(USER, AGENT)
    expect(chatRepo.listMessages(chat.id)).toEqual(rows)

    const locked = await vaultService.lock(USER, AGENT)
    expect(locked.state).toBe('locked')
    expect(vaultTranscripts.isOpen(VAULT)).toBe(false)
    expect(chatRepo.listMessages(chat.id)).toEqual([])
    expect(() => messageRepo.saveUser({ chatId: chat.id, content: 'while locked' })).toThrow(/locked/)
    expect(published.at(-1)).toMatchObject({ channel: 'vault:state', payload: { agentId: AGENT, state: 'locked' } })
  })

  it('drops the attachment copies of its chats that no turn took when it locks, and of every vault chat at start', async () => {
    const userData = join(home, 'userData')
    installRuntimeHost({ isPackaged: false, getAppPath: () => home, getPath: () => userData } as never)
    const { fileService } = await import('../services/fileService')
    await vaultService.unlock(USER, AGENT)
    const chat = chatRepo.create(USER, { agentId: AGENT })
    vaultService.bindChat(USER, USER, chat.id, AGENT)
    const picked = join(home, 'draft.txt')
    writeFileSync(picked, 'a draft never sent')
    const count = (): number => (holder.current!.sqlite.prepare('SELECT count(*) AS n FROM chat_files').get() as { n: number }).n
    await fileService.ingest({ userId: USER, scope: 'local', chatId: chat.id, filePaths: [picked] })
    expect(count()).toBe(1)
    await vaultService.lock(USER, AGENT)
    await vi.waitFor(() => expect(count()).toBe(0))
    expect(existsSync(join(userData, 'vault', 'chat-files', USER, chat.id))).toBe(false)

    // A copy a crash left behind goes at the next start.
    mkdirSync(join(userData, 'vault', 'chat-files', USER, chat.id), { recursive: true })
    writeFileSync(join(userData, 'vault', 'chat-files', USER, chat.id, 'left.txt'), 'x')
    vaultService.resetForTest()
    vaultService.init()
    await vi.waitFor(() => expect(existsSync(join(userData, 'vault', 'chat-files'))).toBe(false))
  })

  it('a lock that lands during the unlock’s journal rebuild wins: nothing is opened and the state stays locked', async () => {
    await vaultService.unlock(USER, AGENT)
    const chat = chatRepo.create(USER, { agentId: AGENT })
    vaultService.bindChat(USER, USER, chat.id, AGENT)
    messageRepo.saveUser({ chatId: chat.id, content: 'kept inside' })
    expect(await vaultTranscripts.settled(VAULT, chat.id, 5_000)).toBe('saved')
    await vaultService.lock(USER, AGENT)

    // The rebuild's read is where the lock lands (the helper locked it while
    // the journals were being read back).
    const spy = vi.spyOn(vaultService, 'client').mockImplementation(async () => ({
      request: async (method: string) => {
        if (method !== 'transcript.read') throw new Error(`unexpected ${method}`)
        await backend.lock(VAULT)
        return { ops: [{ op: 'put', table: 'messages', row: { id: 'm1', chatId: chat.id, role: 'user', content: 'kept inside', sortOrder: 0, createdAt: 0 } }] }
      }
    }) as never)
    try {
      const status = await vaultService.unlock(USER, AGENT)
      expect(status.state).not.toBe('unlocked')
    } finally {
      spy.mockRestore()
    }
    expect(vaultTranscripts.isOpen(VAULT)).toBe(false)
    expect(vaultService.stateOf(VAULT)).not.toBe('unlocked')
    expect(chatRepo.listMessages(chat.id)).toEqual([])
  })

  it('only talks to vaultd while the vault is unlocked (transcript.read and kv.get are gated by the unlock alone)', async () => {
    await expect(vaultService.client(VAULT)).rejects.toMatchObject({ code: 'locked' })
    await vaultService.unlock(USER, AGENT)
    await expect(vaultService.client(VAULT)).resolves.toBeTruthy()
    // Main believes it locked (a lock event) while the helper still answers:
    // main must not ask on its own account.
    vaultService.track({ ...(await backend.status(VAULT)), state: 'locked' })
    await expect(vaultService.client(VAULT)).rejects.toMatchObject({ code: 'locked' })
  })

  it('at quit, delivers each unlocked vault’s queued journal writes before it closes', async () => {
    await vaultService.unlock(USER, AGENT)
    const chat = chatRepo.create(USER, { agentId: AGENT })
    vaultService.bindChat(USER, USER, chat.id, AGENT)
    const client = await vaultService.client(VAULT)
    const delivered: unknown[] = []
    const request = client.request.bind(client)
    client.request = (async (method: string, params: { ops?: unknown[] }) => {
      // Slow enough that a close that did not wait would cut it off.
      if (method === 'transcript.append') { await new Promise((resolve) => setTimeout(resolve, 200)); delivered.push(...(params.ops ?? [])) }
      return request(method as never, params as never)
    }) as never
    // Queued, not yet delivered: the quit must not drop them.
    messageRepo.saveUser({ chatId: chat.id, content: 'said just before quit' })
    messageRepo.saveAssistant({ chatId: chat.id, content: 'answered just before quit', sourceAgentId: AGENT })
    const shutdown = vaultService.shutdown()
    expect(vaultService.pendingQuitDrain()).not.toBeNull()
    await shutdown
    expect(JSON.stringify(delivered)).toContain('answered just before quit')
  })

  it('answers vault_other_chat for its agent in a chat that is not in its vault, and nothing in its own', () => {
    const row = agentRepo.getOwned(USER, AGENT)!
    const old = chatRepo.create(USER, { agentId: AGENT })
    expect(vaultChatReadiness(row, old.id)).toEqual({ state: 'vault_other_chat', reason: 'This chat started before Ledger moved into its vault. Start a new chat to talk to it.' })
    const own = chatRepo.create(USER, { agentId: AGENT })
    vaultService.bindChat(USER, USER, own.id, AGENT)
    expect(vaultChatReadiness(row, own.id)).toBeNull()
    // Any other agent: never.
    expect(vaultChatReadiness({ ...row, id: 'folder:other', source: 'folder', driverConfig: {} }, old.id)).toBeNull()
  })

  it('checks a size before asking for approval, and records the new one', async () => {
    expect(await vaultService.result(() => vaultService.setSize(USER, AGENT, 1024))).toMatchObject({ ok: false, code: 'invalid' })
    expect(await vaultService.result(() => vaultService.setSize(USER, AGENT, 'big'))).toMatchObject({ ok: false, code: 'invalid' })
    await vaultService.refresh(USER)
    const status = await vaultService.setSize(USER, AGENT, 20 * 1024 ** 3)
    expect(status.sizeBytes).toBe(20 * 1024 ** 3)
    expect((await backend.status(VAULT)).sizeBytes).toBe(20 * 1024 ** 3)
  })

  it('validates the allowlist, and stores it normalized', async () => {
    expect(await vaultService.result(() => vaultService.setEgress(USER, AGENT, ['not a host']))).toMatchObject({ ok: false, code: 'invalid' })
    await vaultService.refresh(USER)
    const status = await vaultService.setEgress(USER, AGENT, ['PyPI.org', '*.githubusercontent.com', 'pypi.org'])
    expect(status.egress).toEqual({ hosts: ['*.githubusercontent.com', 'pypi.org'] })
  })

  it('files a Claude login by its prefix: a setup-token token as CLAUDE_CODE_OAUTH_TOKEN, a key as ANTHROPIC_API_KEY, one at a time', async () => {
    await vaultService.unlock(USER, AGENT)
    await vaultService.setSecret(USER, AGENT, 'ANTHROPIC_API_KEY', 'sk-ant-oat01-from-setup-token')
    expect((await vaultService.secrets(USER, AGENT)).names).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
    await vaultService.setSecret(USER, AGENT, 'ANTHROPIC_API_KEY', 'sk-ant-api03-a-key')
    expect((await vaultService.secrets(USER, AGENT)).names).toEqual(['ANTHROPIC_API_KEY'])
    await vaultService.setSecret(USER, AGENT, 'DB_URL', 'sk-ant-oat01-not-a-login')
    expect((await vaultService.secrets(USER, AGENT)).names).toEqual(['ANTHROPIC_API_KEY', 'DB_URL'])
    await vaultService.setSecret(USER, AGENT, 'ANTHROPIC_API_KEY', 'sk-ant-oat01-again')
    await vaultService.deleteSecret(USER, AGENT, 'ANTHROPIC_API_KEY')
    expect((await vaultService.secrets(USER, AGENT)).names).toEqual(['DB_URL'])
  })

  it('answers failures as data with a code, for the renderer', async () => {
    expect(await vaultService.result(() => vaultService.unlock(USER, 'folder:not-a-vault'))).toEqual({
      ok: false, code: 'not_vault_agent', message: 'That agent is not in a vault.'
    })
  })

  it('destroys the vault and the agent with it', async () => {
    await vaultService.refresh(USER)
    await vaultService.destroy(USER, AGENT)
    expect(agentRepo.getOwned(USER, AGENT)).toBeUndefined()
    expect(isVaultAgent(AGENT)).toBe(false)
    expect(existsSync(join(home, 'SecureAgents', VAULT))).toBe(false)
  })

  it('reports availability: the fake needs no image; a packaged build has no published image yet', async () => {
    expect(await vaultService.availability(true)).toMatchObject({ availability: { ok: true }, backend: 'fake', flavor: 'fake' })
    installVaultBackend({ ...createFakeBackend({ vaultdPath: join(home, 'stub-vaultd.cjs'), nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }) }), kind: 'apple-vz' })
    host(true)
    expect(await vaultService.availability(true)).toMatchObject({ availability: { ok: false, reason: 'image-missing' } })
    host(false)
    // Dev reads build/vault-guest/rootfs.img under the app path.
    expect(await vaultService.availability(true)).toMatchObject({ availability: { ok: false, reason: 'image-missing' } })
    mkdirSync(join(home, 'build', 'vault-guest'), { recursive: true })
    writeFileSync(join(home, 'build', 'vault-guest', 'rootfs.img'), '')
    expect(await vaultService.availability(true)).toMatchObject({ availability: { ok: true } })
    installVaultBackend(unavailableBackend('unsupported-hardware'))
    expect(await vaultService.availability()).toMatchObject({ availability: { ok: false, reason: 'unsupported-hardware' }, backend: 'unavailable' })
  })
})
