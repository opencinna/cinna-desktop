import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { disconnectedKey, type SkillDisconnectedInboxItem, type UpdateAvailableInboxItem } from '../../shared/inbox'

/**
 * The Inbox's "Disconnected" skill cards as `inboxService` wires them: the
 * dismissals of the profile are what the computation is handed, the ones it
 * names as over are forgotten, a desktop agent behind its team reaches it as
 * `behind`, and a failed team read as null. The computation itself is
 * `catalogSkillService.test.ts`'s; here it is faked.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  listing: null as unknown,
  teamChanges: null as null | (() => Promise<UpdateAvailableInboxItem[]>),
  compute: vi.fn()
}))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))
vi.mock('../tasks/adapters', async () => {
  const { createNullAdapter } = await import('../tasks/adapters/nullAdapter')
  return { adapterFor: (id: string) => createNullAdapter(id) }
})
vi.mock('../agents/drivers', () => ({ driverFor: () => ({ run: vi.fn() }) }))
vi.mock('./runExecutionService', () => ({ runExecutionService: { start: vi.fn(), isRunning: () => false } }))
vi.mock('./agentService', () => ({ agentService: { findAgent: () => ({ row: {}, userId: '__default__' }) } }))
vi.mock('../mcp/manager', () => ({ mcpManager: {} }))
vi.mock('./fileStore', () => ({ attachmentToMediaPart: async () => null }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__', getProfileScopeUserId: () => 'profile-1' }))
vi.mock('./cloudUpdateNotices', () => ({ cloudUpdateItems: () => [] }))
vi.mock('./libraryService', () => ({ libraryService: { cached: () => holder.listing } }))
vi.mock('./localAgents/localAgentService', () => ({
  localAgentService: { list: () => ({ agents: [{ id: 'folder:a', name: 'Invoices', path: '/x', skills: [] }] }) }
}))
vi.mock('./localAgents/sharingService', () => ({
  sharingService: { teamChanges: () => (holder.teamChanges ? holder.teamChanges() : Promise.resolve([])) }
}))
vi.mock('./catalogSkillUpdates', () => ({
  catalogSkillUpdateItems: () => [],
  catalogSkillDisconnectedItems: holder.compute
}))

const { inboxService } = await import('./inboxService')
const { inboxDismissalRepo } = await import('../db/inboxDismissals')

const PROFILE = 'profile-1'
const UUID = '0b6f3c1e-1111-4222-8333-444455556666'
const ITEM: SkillDisconnectedInboxItem = {
  kind: 'skill_disconnected', agentId: 'folder:a', agentName: 'Invoices', skillName: 'erp-lookup', skillTitle: 'erp-lookup',
  packageUuid: UUID, revision: 1, removable: true, cached: true
}
const BEHIND: UpdateAvailableInboxItem = {
  kind: 'update_available', target: 'desktop_agent', agentId: 'folder:b', agentName: 'B', repoId: 'r1',
  version: 2, versionLabel: null, changedBy: null, changedAt: null
}

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.listing = { host: 'https://cinna.test', items: [], agents: [{ repoId: 'r1' }], available: true }
  holder.teamChanges = null
  holder.compute.mockReset().mockReturnValue({ items: [ITEM], clear: [] })
})
afterEach(() => holder.current?.close())

describe('Disconnected skill cards in the Inbox', () => {
  it('lists what the computation finds, handing it this profile’s dismissals and the agents behind their team', async () => {
    holder.teamChanges = async () => [BEHIND]
    inboxService.dismissDisconnected(PROFILE, { agentId: 'folder:a', packageUuid: UUID.toUpperCase(), revision: 1 })
    const snapshot = await inboxService.list(PROFILE)
    expect(snapshot.disconnected).toEqual([ITEM])
    expect(snapshot.updates).toEqual([BEHIND])
    const [agents, options] = holder.compute.mock.calls[0]
    expect(agents).toEqual([expect.objectContaining({ id: 'folder:a' })])
    expect([...options.behind]).toEqual(['folder:b'])
    // Keyed by the agent, the package (lowercase) and the revision.
    expect([...options.dismissed]).toEqual([disconnectedKey('folder:a', UUID, 1)])
  })

  it('forgets the dismissals the computation names as over, so a later disconnect is a new card', async () => {
    inboxService.dismissDisconnected(PROFILE, { agentId: 'folder:a', packageUuid: UUID, revision: 1 })
    inboxService.dismissDisconnected(PROFILE, { agentId: 'folder:a', packageUuid: UUID, revision: 2 })
    holder.compute.mockReturnValue({ items: [], clear: [disconnectedKey('folder:a', UUID, 1)] })
    await inboxService.list(PROFILE)
    expect([...inboxDismissalRepo.keys(PROFILE, 'skill_disconnected')]).toEqual([disconnectedKey('folder:a', UUID, 2)])
  })

  it('passes no `behind` when the team read failed, and derives nothing without a cached listing', async () => {
    holder.teamChanges = async () => {
      throw new Error('git')
    }
    await inboxService.list(PROFILE)
    expect(holder.compute.mock.calls[0][1].behind).toBeNull()
    holder.compute.mockClear()
    holder.listing = null
    expect((await inboxService.list(PROFILE)).disconnected).toEqual([])
    expect(holder.compute).not.toHaveBeenCalled()
  })

  it('ignores a malformed dismissal', () => {
    inboxService.dismissDisconnected(PROFILE, { agentId: '', packageUuid: UUID, revision: 1 })
    inboxService.dismissDisconnected(PROFILE, null as never)
    expect([...inboxDismissalRepo.keys(PROFILE, 'skill_disconnected')]).toEqual([])
  })
})
