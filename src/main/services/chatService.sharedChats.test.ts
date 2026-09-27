import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * Chats shared across profiles, against a real database.
 *
 * With `showLocalDataInAllProfiles` on (the default), a signed-in profile lists
 * and uses the default (signed-out) profile's chats next to its own, and a new
 * chat's owner follows its first runtime binding: local agents and local chat
 * modes make it the computer's (the default profile's), anything of the account
 * keeps it in the profile. Once something was said in it, it never moves.
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
vi.mock('../auth/scope', () => ({
  getSettingsScopeUserId: () => '__default__',
  getProfileScopeUserId: () => PROFILE,
  getAgentLookupScope: () => ['__default__', PROFILE]
}))
const modes = vi.hoisted(() => new Map<string, { managed: boolean; userId: string; providerId: null; modelId: string }>())
/** The mode `resolveEffectiveDefault` picks — which honours `prioritizeAccountDefaults` in the real service. */
const effectiveDefault = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('./chatModeService', () => ({ chatModeService: {
  findMerged: (id: string) => modes.get(id) ?? null,
  resolveEffectiveDefault: () => (effectiveDefault.id ? modes.get(effectiveDefault.id) ?? null : null)
} }))
vi.mock('./agentService', async () => {
  const { agentRepo } = await import('../db/agents')
  // `findAgent`'s own rule: `remote:` ids in the profile, others in the default
  // scope, and a profile's chat conductor as the one exception.
  return { agentService: { findAgent: (settings: string, profile: string, id: string) => {
    const scope = id.startsWith('remote:') ? profile : settings
    const row = agentRepo.getOwned(scope, id) ?? agentRepo.getOwned(profile, id)
    return row ? { row, userId: row.userId } : null
  } } }
})
vi.mock('./chatConductorService', async (original) => {
  const actual = await original<typeof import('./chatConductorService')>()
  const { agentRepo } = await import('../db/agents')
  return { ...actual, chatConductorService: { remove: vi.fn(), ensure: (userId: string, chat: { id: string }) =>
    agentRepo.list(userId).find((agent) => agent.driverConfig?.conductorChatId === chat.id) ??
    agentRepo.createRuntime(userId, { name: 'Claude', driver: 'acp', config: { launcher: 'claude', conductorChatId: chat.id } }) } }
})
vi.mock('./conductorBridge', () => ({ conductorBridge: { refresh: async () => {} } }))

const DEFAULT = '__default__'
const PROFILE = 'profile-1'

const { chatService } = await import('./chatService')
const { chatRepo } = await import('../db/chats')
const { agentRepo } = await import('../db/agents')
const { messageRepo } = await import('../db/messages')
const { appSettingsRepo } = await import('../db/appSettings')
const { handoverOriginProfile } = await import('./handoverOrigin')

beforeEach(() => {
  holder.current = createTestDatabase()
  modes.clear()
  effectiveDefault.id = null
  modes.set('local-mode', { managed: false, userId: DEFAULT, providerId: null, modelId: 'sonnet' })
  modes.set('account-mode', { managed: true, userId: PROFILE, providerId: null, modelId: 'sonnet' })
  const agent = holder.current.raw.prepare(
    `INSERT INTO agents (id, user_id, name, protocol, source, driver, driver_config, created_at)
     VALUES (?, ?, ?, 'a2a', ?, ?, ?, 1)`
  )
  agent.run('folder:local', DEFAULT, 'Local', 'folder', 'acp', JSON.stringify({ launcher: 'claude', cwd: '/tmp/local' }))
  agent.run('hand-added', DEFAULT, 'Hand added', 'local', 'a2a', null)
  agent.run('folder:dev', DEFAULT, 'In development', 'folder', 'acp', JSON.stringify({ launcher: 'claude', developmentProfileId: PROFILE }))
  agent.run('remote:account', PROFILE, 'Account', 'remote', 'a2a', null)
  const provider = holder.current.raw.prepare(
    'INSERT INTO llm_providers (id, user_id, type, name, managed, created_at) VALUES (?, ?, \'anthropic\', ?, ?, 1)'
  )
  provider.run('local-key', DEFAULT, 'My key', 0)
  provider.run('managed:account-key', PROFILE, 'Account key', 1)
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

/** A chat last touched `ago` ms before now. */
function chatOf(owner: string, ago: number): string {
  const chat = chatRepo.create(owner)
  holder.current!.raw.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Math.floor((Date.now() - ago) / 1000), chat.id)
  return chat.id
}
const ownerOf = (id: string): string | undefined =>
  (holder.current!.raw.prepare('SELECT user_id FROM chats WHERE id = ?').get(id) as { user_id: string } | undefined)?.user_id

describe('the merged list', () => {
  it('lists the default profile\'s chats with the profile\'s own, newest first, and never the other way round', () => {
    const shared = chatOf(DEFAULT, 1_000)
    const own = chatOf(PROFILE, 2_000)
    const older = chatOf(DEFAULT, 3_000)
    expect(chatService.list(PROFILE).map((chat) => chat.id)).toEqual([shared, own, older])
    expect(Object.keys(chatService.listSummaries(PROFILE)).sort()).toEqual([shared, own, older].sort())
    expect(chatService.list(DEFAULT).map((chat) => chat.id)).toEqual([shared, older])
    expect(chatService.get(DEFAULT, own)).toBeNull()

    appSettingsRepo.set('showLocalDataInAllProfiles', false)
    expect(chatService.list(PROFILE).map((chat) => chat.id)).toEqual([own])
    expect(chatService.get(PROFILE, shared)).toBeNull()
  })

  it('uses a shared chat from the profile — rename, trash, restore, empty trash — writing it as the default profile\'s', () => {
    const shared = chatOf(DEFAULT, 0)
    const own = chatOf(PROFILE, 0)
    chatService.rename(PROFILE, shared, 'Renamed while signed in')
    expect(chatService.get(DEFAULT, shared)?.title).toBe('Renamed while signed in')
    chatService.delete(PROFILE, shared)
    chatService.delete(PROFILE, own)
    expect(chatService.listTrash(PROFILE).map((chat) => chat.id).sort()).toEqual([shared, own].sort())
    expect(chatService.listTrash(DEFAULT).map((chat) => chat.id)).toEqual([shared])
    chatService.restore(PROFILE, shared)
    expect(chatService.list(DEFAULT).map((chat) => chat.id)).toEqual([shared])
    chatService.delete(PROFILE, shared)
    chatService.emptyTrash(PROFILE)
    expect(ownerOf(shared)).toBeUndefined()
    expect(ownerOf(own)).toBeUndefined()
  })

  it('ranks Pinned across both owners, so a shared chat and the profile\'s own never share a place', () => {
    const shared = chatOf(DEFAULT, 0)
    const own = chatOf(PROFILE, 0)
    const first = chatService.setPinned(PROFILE, shared, true)
    const second = chatService.setPinned(PROFILE, own, true)
    expect(second).toBeGreaterThan(first!)
    chatService.move(PROFILE, shared, { list: 'pinned', rank: second! + 1 })
    chatService.move(PROFILE, own, { list: 'chats', rank: 7 })
    const rows = chatService.list(PROFILE)
    expect(rows.find((chat) => chat.id === shared)?.pinnedRank).toBe(second! + 1)
    expect(rows.find((chat) => chat.id === own)?.sortKey).toBe(7)
  })
})

describe('the owner of a new chat, decided at its first binding', () => {
  it('gives a chat with a local agent to the computer, and one with an account agent to the profile', () => {
    const folder = chatService.create(PROFILE).id
    chatService.update(PROFILE, folder, { agentId: 'folder:local', router: 'direct' })
    expect(ownerOf(folder)).toBe(DEFAULT)
    const handAdded = chatService.create(PROFILE).id
    chatService.update(PROFILE, handAdded, { agentId: 'hand-added', router: 'direct' })
    expect(ownerOf(handAdded)).toBe(DEFAULT)

    const remote = chatService.create(PROFILE).id
    chatService.update(PROFILE, remote, { agentId: 'remote:account', router: 'direct' })
    expect(ownerOf(remote)).toBe(PROFILE)
    const developing = chatService.create(PROFILE).id
    chatService.update(PROFILE, developing, { agentId: 'folder:dev', router: 'direct' })
    expect(ownerOf(developing)).toBe(PROFILE)
    expect(chatService.list(PROFILE).map((chat) => chat.id).sort()).toEqual([folder, handAdded, remote, developing].sort())
  })

  it('keeps a human-routed chat with any account agent attached in the profile', () => {
    const mixed = chatService.create(PROFILE).id
    chatService.addOnDemandAgent(PROFILE, mixed, 'folder:local')
    chatService.addOnDemandAgent(PROFILE, mixed, 'remote:account')
    chatService.update(PROFILE, mixed, { router: 'human' })
    expect(ownerOf(mixed)).toBe(PROFILE)
    const local = chatService.create(PROFILE).id
    chatService.addOnDemandAgent(PROFILE, local, 'folder:local')
    chatService.update(PROFILE, local, { router: 'human' })
    expect(ownerOf(local)).toBe(DEFAULT)
  })

  it('follows the chat mode of a plain chat, making its conductor under the owner, and moves it with a rebinding while empty', () => {
    const plain = chatService.create(PROFILE).id
    chatService.update(PROFILE, plain, { modeId: 'account-mode', router: 'direct' })
    expect(ownerOf(plain)).toBe(PROFILE)
    const conductor = chatRepo.getOwned(PROFILE, plain)!.agentId!
    expect(agentRepo.getOwned(PROFILE, conductor)).toBeTruthy()

    chatService.update(PROFILE, plain, { modeId: 'local-mode' })
    expect(ownerOf(plain)).toBe(DEFAULT)
    // The conductor moved with it: it is looked up under the chat's owner.
    expect(agentRepo.getOwned(DEFAULT, conductor)).toBeTruthy()
    expect(agentRepo.getOwned(PROFILE, conductor)).toBeUndefined()
    expect(chatRepo.getOwned(DEFAULT, plain)?.agentId).toBe(conductor)

    const unbound = chatService.create(PROFILE).id
    chatService.update(PROFILE, unbound, { router: 'direct' })
    expect(ownerOf(unbound)).toBe(DEFAULT)
  })

  it('keeps a plain chat on an account credential in the profile, and one on a local credential on the computer', () => {
    const account = chatService.create(PROFILE).id
    chatService.update(PROFILE, account, { router: 'direct', providerId: 'managed:account-key', modelId: 'sonnet' })
    expect(ownerOf(account)).toBe(PROFILE)
    const local = chatService.create(PROFILE).id
    chatService.update(PROFILE, local, { router: 'direct', providerId: 'local-key', modelId: 'sonnet' })
    expect(ownerOf(local)).toBe(DEFAULT)
  })

  it('follows the effective default mode for a chat that names neither mode nor credential, unless a local agent answers it', () => {
    effectiveDefault.id = 'account-mode'
    const plain = chatService.create(PROFILE).id
    chatService.update(PROFILE, plain, { router: 'direct' })
    expect(ownerOf(plain)).toBe(PROFILE)
    const agentRooted = chatService.create(PROFILE).id
    chatService.update(PROFILE, agentRooted, { agentId: 'folder:local', router: 'direct' })
    expect(ownerOf(agentRooted)).toBe(DEFAULT)

    effectiveDefault.id = 'local-mode'
    const localDefault = chatService.create(PROFILE).id
    chatService.update(PROFILE, localDefault, { router: 'direct' })
    expect(ownerOf(localDefault)).toBe(DEFAULT)
  })

  it('never moves a chat once something was said in it', () => {
    const chat = chatService.create(PROFILE).id
    messageRepo.saveUser({ chatId: chat, content: 'hello' })
    chatService.update(PROFILE, chat, { agentId: 'folder:local', router: 'direct' })
    expect(ownerOf(chat)).toBe(PROFILE)

    const shared = chatService.create(PROFILE).id
    chatService.update(PROFILE, shared, { agentId: 'folder:local', router: 'direct' })
    messageRepo.saveUser({ chatId: shared, content: 'hello' })
    chatService.update(PROFILE, shared, { agentId: 'remote:account' })
    expect(ownerOf(shared)).toBe(DEFAULT)
  })

  it('keeps every new chat in the profile when local data stays in its own profile, and in the default profile anyway', () => {
    appSettingsRepo.set('showLocalDataInAllProfiles', false)
    const chat = chatService.create(PROFILE).id
    chatService.update(PROFILE, chat, { agentId: 'folder:local', router: 'direct' })
    expect(ownerOf(chat)).toBe(PROFILE)

    appSettingsRepo.set('showLocalDataInAllProfiles', true)
    const guest = chatService.create(DEFAULT).id
    chatService.update(DEFAULT, guest, { modeId: 'local-mode', router: 'direct' })
    expect(ownerOf(guest)).toBe(DEFAULT)
  })
})

describe('a handover from a shared chat', () => {
  const brief = (chatId: string) => ({ origin: { chatId, agentId: 'folder:local' } }) as unknown as Parameters<typeof handoverOriginProfile>[0]

  it('belongs to the active profile, which takes it in, and to the default profile while signed out', () => {
    const shared = chatOf(DEFAULT, 0)
    chatService.update(DEFAULT, shared, { agentId: 'folder:local', router: 'direct' })
    // `intake` drops a handover whose origin profile is not the scope's.
    expect(handoverOriginProfile(brief(shared), PROFILE)).toBe(PROFILE)
    expect(handoverOriginProfile(brief(shared), DEFAULT)).toBe(DEFAULT)
    expect(handoverOriginProfile(brief(shared), 'profile-2')).toBe('profile-2')
  })

  it('stays the default profile\'s when local chats are kept in their own profile, and a profile\'s chat stays its own', () => {
    const shared = chatOf(DEFAULT, 0)
    chatService.update(DEFAULT, shared, { agentId: 'folder:local', router: 'direct' })
    const own = chatOf(PROFILE, 0)
    chatService.update(PROFILE, own, { agentId: 'remote:account', router: 'direct' })
    expect(handoverOriginProfile({ origin: { chatId: own, agentId: 'remote:account' } } as never, DEFAULT)).toBe(PROFILE)
    appSettingsRepo.set('showLocalDataInAllProfiles', false)
    expect(handoverOriginProfile(brief(shared), PROFILE)).toBe(DEFAULT)
  })
})
