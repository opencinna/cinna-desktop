import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
const { setGuestPinForTest } = await import('./guestImage')
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
  setGuestPinForTest(null)
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

  it('a shorter lock timeout picked while an unlock waits at its prompt does not void that unlock', async () => {
    await vaultService.unlock(USER, AGENT)
    await vaultService.lock(USER, AGENT)
    const realUnlock = backend.unlock.bind(backend)
    const spy = vi.spyOn(backend, 'unlock').mockImplementation(async (vaultId, purpose) => {
      // The prompt is up; the Security tab's "Lock after" changes meanwhile (no prompt: it is shorter).
      await vaultService.setLockTimeout(USER, AGENT, 30_000)
      return realUnlock(vaultId, purpose)
    })
    try {
      expect((await vaultService.unlock(USER, AGENT)).state).toBe('unlocked')
    } finally {
      spy.mockRestore()
    }
    expect(vaultTranscripts.isOpen(VAULT)).toBe(true)
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

  it('sets a shorter lock timeout without a prompt and asks for a longer one, refusing anything not offered', async () => {
    const approve = vi.spyOn(backend, 'approve')
    const set = vi.spyOn(backend, 'setLockTimeout')
    expect(await vaultService.result(() => vaultService.setLockTimeout(USER, AGENT, 60_000))).toMatchObject({ ok: false, code: 'invalid' })
    expect(set).not.toHaveBeenCalled()
    await vaultService.refresh(USER)
    expect(vaultService.list(USER)[0].lockAfterMs).toBe(300_000)

    // Shorter (5 min → 30 s): no approval, no token.
    expect((await vaultService.setLockTimeout(USER, AGENT, 30_000)).lockAfterMs).toBe(30_000)
    expect(approve).not.toHaveBeenCalled()
    expect(set).toHaveBeenLastCalledWith(VAULT, 30_000, undefined)

    // Longer (30 s → until Cinna quits): the helper's lock-timeout approval for exactly this value.
    expect((await vaultService.setLockTimeout(USER, AGENT, 0)).lockAfterMs).toBe(0)
    expect(approve).toHaveBeenCalledWith(VAULT, 'lock-timeout', 'lock-timeout:0')
    expect(set).toHaveBeenLastCalledWith(VAULT, 0, expect.any(String))
    expect((await backend.status(VAULT)).lockAfterMs).toBe(0)

    // The same value again changes nothing and asks nothing.
    approve.mockClear()
    set.mockClear()
    await vaultService.setLockTimeout(USER, AGENT, 0)
    expect(approve).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses a lock timeout the backend’s capabilities do not list, and never touches where it keeps no idle window', async () => {
    await vaultService.refresh(USER)
    vi.spyOn(backend, 'capabilities').mockReturnValue({ ...backend.capabilities(), lockTimeouts: [300_000], idleTouch: false })
    const set = vi.spyOn(backend, 'setLockTimeout')
    expect(await vaultService.result(() => vaultService.setLockTimeout(USER, AGENT, 30_000))).toMatchObject({ ok: false, code: 'invalid' })
    expect(set).not.toHaveBeenCalled()
    await vaultService.unlock(USER, AGENT)
    const touch = vi.spyOn(backend, 'touch')
    vaultService.touch(USER, AGENT)
    expect(touch).not.toHaveBeenCalled()
  })

  it('answers a refused prompt for a longer lock timeout as denied, and keeps the old one', async () => {
    await vaultService.refresh(USER)
    await vaultService.setLockTimeout(USER, AGENT, 30_000)
    vi.spyOn(backend, 'approve').mockRejectedValueOnce(Object.assign(new (await import('./backend')).VaultBackendError('denied', 'the user did not approve')))
    expect(await vaultService.result(() => vaultService.setLockTimeout(USER, AGENT, 300_000))).toMatchObject({ ok: false, code: 'denied' })
    expect((await backend.status(VAULT)).lockAfterMs).toBe(30_000)
  })

  it('touches only an unlocked vault, and never throws', async () => {
    const touch = vi.spyOn(backend, 'touch')
    vaultService.touch(USER, AGENT)
    vaultService.touch(USER, 'folder:not-a-vault-agent')
    expect(touch).not.toHaveBeenCalled()
    await vaultService.unlock(USER, AGENT)
    touch.mockRejectedValueOnce(new Error('helper gone'))
    expect(() => vaultService.touch(USER, AGENT)).not.toThrow()
    expect(touch).toHaveBeenCalledWith(VAULT)
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

  it('refuses an agent’s settings details as data while its vault is locked, and for an agent not in one', async () => {
    expect(vaultService.stateOf(VAULT)).toBe('locked')
    expect(await vaultService.result(() => vaultService.agentDetails(USER, AGENT))).toMatchObject({ ok: false, code: 'locked' })
    expect(await vaultService.result(() => vaultService.agentDetails(USER, 'folder:not-a-vault'))).toMatchObject({ ok: false, code: 'not_vault_agent' })
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

  describe('the guest image an unlock boots', () => {
    /** The fake, posing as the real helper so the image counts; its unlock recorded. */
    function realLike(): { calls: { vaultId: string; purpose: string; rootfsPath?: string }[] } {
      const calls: { vaultId: string; purpose: string; rootfsPath?: string }[] = []
      installVaultBackend({
        ...backend,
        kind: 'apple-vz',
        unlock: (vaultId: string, purpose: string, rootfsPath?: string) => {
          calls.push({ vaultId, purpose, rootfsPath })
          return backend.unlock(vaultId, purpose)
        }
      })
      return { calls }
    }

    it('is the image this build has, not the one the vault was created with (dev: the dev image)', async () => {
      const { calls } = realLike()
      mkdirSync(join(home, 'build', 'vault-guest'), { recursive: true })
      writeFileSync(join(home, 'build', 'vault-guest', 'rootfs.img'), '')
      expect((await vaultService.unlock(USER, AGENT)).state).toBe('unlocked')
      expect(calls).toEqual([{ vaultId: VAULT, purpose: 'Use this agent', rootfsPath: join(home, 'build', 'vault-guest', 'rootfs.img') }])
    })

    it('packaged: downloads the pinned image first, with progress on vault:unlock-progress, then boots it', async () => {
      const image = Buffer.from('rootfs'.repeat(50_000))
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-length': String(image.length) })
        res.end(image)
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const { calls } = realLike()
        host(true)
        setGuestPinForTest({
          published: true, version: '2.0.0-1', rootHash: 'a'.repeat(64), hashOffset: 4096,
          kernel: { file: 'k', url: '', sha256: '', size: 0 },
          initrd: { file: 'i', url: '', sha256: '', size: 0 },
          rootfs: { file: 'vault-guest-2.0.0-1-rootfs.img', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/r`, sha256: createHash('sha256').update(image).digest('hex'), size: image.length }
        })
        expect((await vaultService.unlock(USER, AGENT)).state).toBe('unlocked')
        const target = join(home, 'SecureAgents', '.images', 'rootfs-2.0.0-1.img')
        expect(calls.at(-1)?.rootfsPath).toBe(target)
        expect(readFileSync(target).equals(image)).toBe(true)
        const progress = published.filter((p) => p.channel === 'vault:unlock-progress').map((p) => p.payload as { agentId: string; vaultId: string; percent: number | null })
        expect(progress.at(-2)).toEqual({ agentId: AGENT, vaultId: VAULT, percent: 100 })
        // Done: the label goes back.
        expect(progress.at(-1)).toEqual({ agentId: AGENT, vaultId: VAULT, percent: null })
      } finally {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    })

    it('packaged: a failed download is the unlock\'s error, and nothing is unlocked', async () => {
      const { calls } = realLike()
      host(true)
      setGuestPinForTest({
        published: true, version: '2.0.0-1', rootHash: 'a'.repeat(64), hashOffset: 4096,
        kernel: { file: 'k', url: '', sha256: '', size: 0 },
        initrd: { file: 'i', url: '', sha256: '', size: 0 },
        rootfs: { file: 'r', url: 'http://127.0.0.1:1/r', sha256: 'b'.repeat(64), size: 10 }
      })
      expect(await vaultService.result(() => vaultService.unlock(USER, AGENT))).toMatchObject({ ok: false, code: 'unavailable' })
      expect(calls).toEqual([])
      expect(vaultService.stateOf(VAULT)).toBe('locked')
    })

    it('names the image on every unlock, even of a vault main thinks is unlocked (the helper keeps it for its next cold boot)', async () => {
      const { calls } = realLike()
      mkdirSync(join(home, 'build', 'vault-guest'), { recursive: true })
      writeFileSync(join(home, 'build', 'vault-guest', 'rootfs.img'), '')
      await vaultService.unlock(USER, AGENT)
      expect(vaultService.stateOf(VAULT)).toBe('unlocked')
      await vaultService.unlock(USER, AGENT)
      expect(calls.map((c) => c.rootfsPath)).toEqual([join(home, 'build', 'vault-guest', 'rootfs.img'), join(home, 'build', 'vault-guest', 'rootfs.img')])
    })

    it('dev without a guest image: the unlock says which folder and what to run', async () => {
      const { calls } = realLike()
      expect(await vaultService.result(() => vaultService.unlock(USER, AGENT))).toEqual({
        ok: false, code: 'unavailable', message: 'No guest image in build/vault-guest: run make vault-image (or make vault-dev-restart).'
      })
      expect(calls).toEqual([])
    })

    it('packaged: a lock during the image download voids the unlock before the helper is asked', async () => {
      const image = Buffer.from('rootfs'.repeat(50_000))
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      let asked: () => void = () => {}
      const requested = new Promise<void>((resolve) => { asked = resolve })
      const server = createServer((_req, res) => {
        asked()
        void gate.then(() => {
          res.writeHead(200, { 'content-length': String(image.length) })
          res.end(image)
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const { calls } = realLike()
        host(true)
        setGuestPinForTest({
          published: true, version: '2.0.0-2', rootHash: 'a'.repeat(64), hashOffset: 4096,
          kernel: { file: 'k', url: '', sha256: '', size: 0 },
          initrd: { file: 'i', url: '', sha256: '', size: 0 },
          rootfs: { file: 'r', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/r`, sha256: createHash('sha256').update(image).digest('hex'), size: image.length }
        })
        const unlocking = vaultService.unlock(USER, AGENT)
        await requested
        await vaultService.lock(USER, AGENT)
        release()
        expect((await unlocking).state).toBe('locked')
        expect(calls).toEqual([])
      } finally {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    })

    it('the fake boots no image: no path, no download', async () => {
      const calls: (string | undefined)[] = []
      installVaultBackend({ ...backend, unlock: (vaultId: string, purpose: string, rootfsPath?: string) => { calls.push(rootfsPath); return backend.unlock(vaultId, purpose) } })
      host(true)
      await vaultService.unlock(USER, AGENT)
      expect(calls).toEqual([undefined])
    })
  })
})
