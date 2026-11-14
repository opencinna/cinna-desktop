import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * D6: every Cinna channel refuses a vault agent even when called directly,
 * with the agent's real `agents` row (`source = 'vault'`) behind the
 * predicate. One test per channel; the D23 transcript paths (titles, Inbox)
 * are in `transcriptRouting.test.ts`.
 */

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
vi.mock('../auth/scope', async (original) => ({
  ...(await original<typeof import('../auth/scope')>()),
  getProfileScopeUserId: () => '__default__',
  getSettingsScopeUserId: () => '__default__'
}))
vi.mock('../tasks/adapters', async (original) => ({ ...(await original<typeof import('../tasks/adapters')>()), allAdapters: () => [] }))

const { agentRepo } = await import('../db/agents')
const { chatRepo } = await import('../db/chats')
const { chatOnDemandAgentRepo } = await import('../db/chatOnDemandAgent')
const { resetVaultAgentsForTest } = await import('./isVaultAgent')
const { vaultTranscripts } = await import('./transcriptStore')
const { userActivation } = await import('../auth/activation')
const { localAgentService } = await import('../services/localAgents/localAgentService')
const { delegationService } = await import('../services/delegationService')
const { chatService } = await import('../services/chatService')
const { buildAgentToolProviders } = await import('../services/a2aAsMcpProvider')
const { conductorBridge } = await import('../services/conductorBridge')
const { localScheduleService } = await import('../services/localScheduleService')
const { commandService } = await import('../services/localAgents/commandService')
const { createOpenInService } = await import('../services/localAgents/openInService')
const { createAgentFileService } = await import('../services/agentFiles/agentFileService')
const { createConsentRegistry } = await import('../services/agentFiles/consent')
const { serviceCredentialService } = await import('../services/serviceCredentials/service')
const { attachmentUploadsDir } = await import('../agents/drivers')

const USER = '__default__'
const SCOPE = { profileUserId: USER, settingsUserId: USER }
const VAULT_AGENT = 'folder:aaaaaaaa-0000-0000-0000-000000000001'
const HOST_AGENT = 'folder:bbbbbbbb-0000-0000-0000-000000000002'

const entry = (id: string, name: string) => ({
  id, name, description: null, localPath: `/agents/Local/${name.toLowerCase()}`, remoteMetadata: {} as never, launcher: 'claude' as const
})

const refused = { code: 'vault_agent' }

beforeEach(() => {
  holder.current = createTestDatabase()
  vaultTranscripts.resetForTest()
  agentRepo.replaceFolderIndex(USER, 'root-1', [entry(VAULT_AGENT, 'Payroll'), entry(HOST_AGENT, 'Helper')])
  agentRepo.markVault(USER, VAULT_AGENT, { vaultId: 'vault-1', engine: 'claude' })
  // Read from the rows, as at boot.
  resetVaultAgentsForTest()
  vi.spyOn(userActivation, 'requireActivated').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  resetVaultAgentsForTest()
  holder.current?.close()
  holder.current = null
})

describe('delegation', () => {
  it('refuses a vault agent as the requester', async () => {
    const chat = chatRepo.create(USER, { agentId: VAULT_AGENT })
    await expect(delegationService.targetEntries({ scope: SCOPE, chatId: chat.id, agentId: VAULT_AGENT })).rejects.toMatchObject(refused)
  })

  it('refuses a vault agent as the target', async () => {
    const chat = chatRepo.create(USER, { agentId: HOST_AGENT })
    await expect(delegationService.create({ scope: SCOPE, chatId: chat.id, agentId: HOST_AGENT },
      { id: '20261113-1200-pay', title: 'Pay', brief: 'Pay it', target: { kind: 'kit', agentId: VAULT_AGENT } })).rejects.toMatchObject(refused)
  })

  it('never lists a vault agent among the targets', async () => {
    const chat = chatRepo.create(USER, { agentId: HOST_AGENT })
    const dto = (id: string) => ({ id, kind: 'kit', name: id, path: '/x', enabled: true, desktop: { delegations: null, handovers: null } })
    vi.spyOn(localAgentService, 'get').mockReturnValue(dto(HOST_AGENT) as never)
    vi.spyOn(localAgentService, 'list').mockReturnValue({ agents: [dto(HOST_AGENT), dto(VAULT_AGENT)] } as never)
    const targets = await delegationService.targetEntries({ scope: SCOPE, chatId: chat.id, agentId: HOST_AGENT })
    expect(targets.map((target) => target.target.agentId)).toEqual([HOST_AGENT])
  })
})

describe('chats', () => {
  it('refuses a vault agent as an on-demand agent, and any agent into a vault chat', () => {
    const chat = chatRepo.create(USER, {})
    expect(() => chatService.addOnDemandAgent(USER, chat.id, VAULT_AGENT)).toThrow(expect.objectContaining(refused))
    const vaultChat = chatRepo.create(USER, { agentId: VAULT_AGENT })
    chatRepo.bindVault(USER, vaultChat.id, 'vault-1', 'Payroll · 1 Jan 2026')
    expect(() => chatService.addOnDemandAgent(USER, vaultChat.id, HOST_AGENT)).toThrow(expect.objectContaining(refused))
    expect(chatOnDemandAgentRepo.listAgentIds(vaultChat.id)).toEqual([])
  })

  it('binds a fresh chat to its vault agent, and refuses one with host messages', () => {
    const fresh = chatRepo.create(USER, {})
    chatService.update(USER, fresh.id, { agentId: VAULT_AGENT, router: 'direct' })
    expect(chatRepo.getOwned(USER, fresh.id)).toMatchObject({ vaultId: 'vault-1', title: expect.stringMatching(/^Payroll · /) })

    const used = chatRepo.create(USER, {})
    holder.current!.sqlite.prepare("INSERT INTO messages (id, chat_id, role, content, sort_order, created_at) VALUES ('m', ?, 'user', 'hi', 0, 1)").run(used.id)
    expect(() => chatService.update(USER, used.id, { agentId: VAULT_AGENT })).toThrow(/new chat/)
    expect(chatRepo.getOwned(USER, used.id)!.vaultId).toBeNull()
  })

  it('offers no vault agent as a tool of another session', () => {
    const chat = chatRepo.create(USER, {})
    chatOnDemandAgentRepo.add(chat.id, VAULT_AGENT)
    expect(buildAgentToolProviders(chat.id, USER, USER, new Set())).toEqual([])
  })

  it('gives a vault agent no conductor server (no cinna tools, no loopback URL)', async () => {
    const row = agentRepo.getOwned(USER, VAULT_AGENT)!
    expect(row.driver).toBe('acp')
    const plan = { spec: { env: {}, key: 'k' } } as never
    const lease = await conductorBridge.prepare(USER, row, { runScope: SCOPE, chatId: 'c', signal: new AbortController().signal } as never, plan, () => {}, () => true)
    expect(lease).toBeUndefined()
  })
})

describe('folder-bound channels', () => {
  it('refuses schedules', () => {
    expect(() => localScheduleService.save(SCOPE, { profileUserId: USER, agentId: VAULT_AGENT, enabled: true, name: 'n', cron: '* * * * *' } as never)).toThrow(expect.objectContaining(refused))
    expect(() => localScheduleService.enable(SCOPE, { profileUserId: USER, agentId: VAULT_AGENT, name: 'n', revision: 'r', timezone: 'UTC' })).toThrow(expect.objectContaining(refused))
  })

  it('refuses Run commands', async () => {
    expect(() => commandService.resolve(USER, VAULT_AGENT, '/run:check')).toThrow(expect.objectContaining(refused))
    expect(await commandService.runScheduled(USER, VAULT_AGENT, 'echo hi')).toMatchObject({ started: false, spawnError: expect.stringContaining('vault') })
    expect(await commandService.run(USER, VAULT_AGENT, 'check')).toMatchObject({ ok: false, error: expect.stringContaining('vault') })
  })

  it('refuses the folder, uploads and credentials file, and locate itself', async () => {
    expect(() => localAgentService.locate(USER, VAULT_AGENT)).toThrow(expect.objectContaining(refused))
    expect(() => localAgentService.openPath(USER, { agentId: VAULT_AGENT })).toThrow(expect.objectContaining(refused))
    await expect(localAgentService.openUploads(USER, VAULT_AGENT)).rejects.toMatchObject(refused)
    await expect(localAgentService.openCredentials(USER, VAULT_AGENT)).rejects.toMatchObject(refused)
  })

  it('refuses credential files (they go into the vault instead)', async () => {
    await expect(serviceCredentialService.prepare(VAULT_AGENT)).rejects.toMatchObject(refused)
  })

  it('refuses file preview and open', async () => {
    const locateAgent = vi.fn(() => '/agents/Local/payroll')
    const files = createAgentFileService({
      locateAgent, agentName: () => 'Payroll', getConsentUserId: () => USER, consent: createConsentRegistry(), platform: 'darwin',
      isGuardedLocation: () => false, getDefaultEditor: async () => null, launchEditor: async () => {}, openPath: async () => '',
      openInTextEditor: async () => {}, showItemInFolder: () => {}, openInBrowser: async () => {}
    })
    expect(await files.resolve({ agentId: VAULT_AGENT, entries: [{ text: 'notes.md', source: 'span' }] })).toMatchObject({ success: false, error: expect.stringContaining('vault') })
    expect(locateAgent).not.toHaveBeenCalled()
  })

  it('copies no attachment of a vault agent to disk', () => {
    const agent = agentRepo.getOwned(USER, VAULT_AGENT)!
    const runtime = { type: 'folder', folder: { kind: 'kit', path: '/agents/Local/payroll' } }
    expect(attachmentUploadsDir({ agent, runtime, plan: { spec: {} } } as never)).toBeNull()
  })
})

describe('Open in', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cinna-openin-'))
    mkdirSync(join(root, 'SecureAgents', 'vault-1'), { recursive: true })
    mkdirSync(join(root, 'Local', 'helper'), { recursive: true })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('refuses anything under SecureAgents/, any case', async () => {
    const shown: string[] = []
    const service = createOpenInService({ getAllowedRoots: () => [root] } as never)
    const realRuntime = await import('../host/runtimeHost')
    vi.spyOn(realRuntime, 'runtimeHost', 'get').mockReturnValue({ shell: { showItemInFolder: (p: string) => shown.push(p) } } as never)
    await expect(service.openIn({ action: 'reveal', folder: join(root, 'SecureAgents', 'vault-1') })).rejects.toMatchObject({ code: 'forbidden_path' })
    await expect(service.openIn({ action: 'reveal', folder: join(root, 'secureagents') })).rejects.toMatchObject({ code: 'forbidden_path' })
    expect(shown).toEqual([])
  })
})

describe('the folder index and the agent list', () => {
  it('never takes a vault row back, re-points or prunes it', () => {
    // The host copy still on disk under the same id (mid-move) is scanned again.
    agentRepo.replaceFolderIndex(USER, 'root-1', [entry(VAULT_AGENT, 'Payroll renamed')])
    agentRepo.updateFolderIndex(USER, entry(VAULT_AGENT, 'Payroll again'), 'root-1')
    // A scan that no longer sees it at all.
    agentRepo.replaceFolderIndex(USER, 'root-1', [])
    agentRepo.pruneFolderIndexForRoot(USER, 'root-1')
    expect(agentRepo.getOwned(USER, VAULT_AGENT)).toMatchObject({ source: 'vault', name: 'Payroll', localPath: null, localRootId: 'root-1' })
    expect(agentRepo.rekeyFolderRow(USER, VAULT_AGENT, 'folder:new').moved).toBe(false)
  })

  it('lists vault agents only when asked, with no path', () => {
    const home = mkdtempSync(join(tmpdir(), 'cinna-home-'))
    try {
      vi.spyOn(localAgentService, 'overlayEnabled').mockImplementation((_u, agents) => agents)
      const homeService = (async () => (await import('../services/localAgents/agentsHomeService')).agentsHomeService)()
      return homeService.then((service) => {
        vi.spyOn(service, 'refreshHome').mockReturnValue('ready' as never)
        vi.spyOn(service, 'homeMissing').mockReturnValue(false)
        vi.spyOn(service, 'homePath').mockReturnValue(home)
        vi.spyOn(service, 'rootRows').mockReturnValue([{ id: 'root-1', path: home, isDefault: true, kind: 'workshop' } as never])
        vi.spyOn(service, 'rootDtos').mockReturnValue([])
        expect(localAgentService.list(USER).agents.map((a) => a.id)).not.toContain(VAULT_AGENT)
        const listed = localAgentService.list(USER, { includeVault: true }).agents.find((a) => a.id === VAULT_AGENT)
        expect(listed).toMatchObject({ path: '', name: 'Payroll', vault: { vaultId: 'vault-1', engine: 'claude', state: 'locked' } })
      })
    } finally {
      writeFileSync(join(home, '.done'), '')
    }
  })
})
