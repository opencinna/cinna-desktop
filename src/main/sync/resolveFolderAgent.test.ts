import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * The apply side of a folder-agent job dependency, against a real database with
 * the real migrations.
 *
 * Two claims, and the second is the one worth a database. **A folder agent must
 * never auto-create a shell row on a miss.** Its two neighbours in the same
 * dispatch do exactly that — `resolveLocalAgent` and `resolveMcp` both insert a
 * disabled row from the descriptor's coords — because a URL or a command is the
 * whole of what those dependencies are. A folder agent is a *directory on this
 * machine*, so a row without one would assert an agent that does not exist,
 * would appear in every picker, and would fail at the first turn with nothing
 * on screen explaining why. The honest answer is no row and a job that says it
 * needs setup.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const scope = vi.hoisted(() => ({ settings: '__default__' }))

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
  getSettingsScopeUserId: () => scope.settings,
  getProfileScopeUserId: () => 'profile-1',
  getAgentLookupScope: () => [scope.settings, 'profile-1']
}))
vi.mock('../services/cinnaApiService', () => ({ getCinnaServerUrl: () => null }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  })
}))

const { resolveFolderAgent, buildResolveIndex } = await import('./resolvers')
const { agentIdentityKey } = await import('./identity')
const { agentRepo } = await import('../db/agents')

const USER = '__default__'

const desc = {
  kind: 'agent' as const,
  source: 'folder' as const,
  manifestId: '6f1a-uuid',
  name: 'Invoice Checker'
}

function indexFolder(): void {
  agentRepo.replaceFolderIndex(USER, 'r1', [
    {
      id: 'folder:6f1a-uuid',
      name: 'Invoice Checker',
      description: null,
      localPath: '/w/Local/invoice-checker'
    }
  ])
}

function agentCount(): number {
  return agentRepo.list(USER).length
}

beforeEach(() => {
  holder.current = createTestDatabase()
  scope.settings = USER
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('resolveFolderAgent', () => {
  it('creates nothing when the workshop is not on this device', () => {
    // The consequence first: the database is untouched. `resolveLocalAgent`
    // would have inserted a disabled row here.
    expect(agentCount()).toBe(0)
    expect(resolveFolderAgent(desc)).toBeNull()
    expect(agentCount()).toBe(0)
  })

  it('finds the row a scan already indexed', () => {
    indexFolder()
    expect(resolveFolderAgent(desc)).toBe('folder:6f1a-uuid')
    expect(agentCount()).toBe(1)
  })

  it('finds a folder agent the user has switched off', () => {
    // Resolution and readiness are different questions: the join row must still
    // point at the agent, and `manifestNeedsSetup` is what reports the toggle.
    indexFolder()
    agentRepo.update(USER, 'folder:6f1a-uuid', { enabled: false })
    expect(resolveFolderAgent(desc)).toBe('folder:6f1a-uuid')
  })

  it('will not bind a row at that id whose source is not `folder`', () => {
    // Written through raw SQL because no repo write can produce this state —
    // `agentRepo.update` does not expose `source`, which is the point: the id
    // namespaces are what normally keep these apart. The guard is what stops a
    // descriptor from binding to whatever else ended up at that id, and the
    // alternative to checking is running some other agent under this one's
    // name.
    indexFolder()
    holder.current?.sqlite
      .prepare("UPDATE agents SET source = 'local' WHERE id = 'folder:6f1a-uuid'")
      .run()
    expect(resolveFolderAgent(desc)).toBeNull()
  })

  it('resolves nothing for an empty manifest id, and touches no rows doing it', () => {
    indexFolder()
    expect(resolveFolderAgent({ ...desc, manifestId: '' })).toBeNull()
    expect(agentCount()).toBe(1)
  })
})

describe('buildResolveIndex', () => {
  it('indexes a folder agent under its own key, with its enabled flag', () => {
    indexFolder()
    const idx = buildResolveIndex('profile-1')
    expect(idx.folderAgent.get(agentIdentityKey(desc))).toBe(true)
    // Not under the local-agent key: the two maps are what keep a card URL and
    // a manifest id from being asked the same question.
    expect(idx.localAgent.size).toBe(0)
  })

  it('reports a switched-off folder agent as present-but-false', () => {
    indexFolder()
    agentRepo.update(USER, 'folder:6f1a-uuid', { enabled: false })
    const idx = buildResolveIndex('profile-1')
    expect(idx.folderAgent.get(agentIdentityKey(desc))).toBe(false)
  })
})

describe('an unstamped folder agent, whose id is positional rather than portable', () => {
  const legacyId = 'folder:legacy:r1:invoice-checker'
  const legacyDesc = {
    kind: 'agent' as const,
    source: 'folder' as const,
    manifestId: 'legacy:r1:invoice-checker',
    name: 'Invoice Checker'
  }

  it('resolves on the device it came from, so the origin does not report needing setup', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [
      { id: legacyId, name: 'Invoice Checker', description: null, localPath: '/w/Local/ic' }
    ])
    expect(resolveFolderAgent(legacyDesc)).toBe(legacyId)
  })

  it('reconstructs the id with its `folder:` prefix intact', () => {
    // Load-bearing beyond this lookup: `agentService.findAgent` dispatches to a
    // *single* scope on the id's shape and has no fallback, so an id that lost
    // the prefix would resolve in the wrong scope and return null rather than
    // being searched for elsewhere. The descriptor strips the prefix on the way
    // out and this puts it back; the round trip has to be exact.
    agentRepo.replaceFolderIndex(USER, 'r1', [
      { id: legacyId, name: 'Invoice Checker', description: null, localPath: '/w/Local/ic' }
    ])
    expect(resolveFolderAgent(legacyDesc)?.startsWith('folder:')).toBe(true)
  })

  it('finds nothing on a peer, which is the point of emitting it rather than dropping it', () => {
    // `legacy:<rootId>:<name>` names a directory on the device that made it. A
    // descriptor that cannot resolve makes the job say "needs setup"; the
    // alternative — returning null from the descriptor and dropping the
    // dependency — made the peer run the job with no agent and report success.
    expect(resolveFolderAgent(legacyDesc)).toBeNull()
  })
})
