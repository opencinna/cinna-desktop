import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('./client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))

const { handoverRepo } = await import('./handovers')

const USER = '__default__'
const AGENT = 'folder:external:root:.'

beforeEach(() => {
  holder.current = createTestDatabase()
  // `createTestDatabase` already seeds the default profile.
})
afterEach(() => {
  holder.current?.close()
  holder.current = null
})

function insert(overrides: Partial<Parameters<typeof handoverRepo.insert>[0]> = {}) {
  return handoverRepo.insert({
    userId: USER,
    agentId: AGENT,
    folderPath: '/projects/uploader',
    handoverId: '20260917-1200-retry',
    taskId: null,
    depth: 1,
    execution: 'ask',
    state: 'gated',
    briefDigest: 'digest-one',
    ...overrides
  })
}

describe('handoverRepo', () => {
  it('round-trips a row and finds it by the pair the unique index is on', () => {
    const row = insert()
    expect(handoverRepo.byAgentAndHandoverId(AGENT, '20260917-1200-retry')?.id).toBe(row.id)
    expect(handoverRepo.getById(USER, row.id)?.briefDigest).toBe('digest-one')
    expect(handoverRepo.getById('someone-else', row.id)).toBeUndefined()
  })

  it('refuses a second row for the same brief', () => {
    insert()
    expect(() => insert({ handoverId: '20260917-1200-retry' })).toThrow()
    // A different brief in the same folder, and the same id in another folder,
    // are both fine: the id is unique per folder only.
    expect(() => insert({ handoverId: '20260917-1300-other' })).not.toThrow()
    expect(() => insert({ agentId: 'folder:external:root:other' })).not.toThrow()
  })

  it('updates only within the profile that owns the row', () => {
    const row = insert()
    expect(handoverRepo.update('someone-else', row.id, { state: 'done' })).toBeUndefined()
    expect(handoverRepo.update(USER, row.id, { state: 'running', runId: 'run-1' })).toMatchObject({
      state: 'running',
      runId: 'run-1'
    })
  })

  it('reports a row whose task is gone as skipped, whatever the column says', () => {
    // A deleted task is how the work is withdrawn; the row survives only to keep
    // holding the unique pair, and calling it `running` would claim a task that
    // no longer exists is under way.
    const row = insert({ state: 'running', taskId: null })
    expect(handoverRepo.toDto(row).state).toBe('skipped')
    // A terminal state is a fact about work that happened and is kept.
    expect(handoverRepo.toDto({ ...row, state: 'done' }).state).toBe('done')
  })

  it('does not call a scan that found nothing a change', () => {
    // `updated_at` means "when this handover last changed", and the staleness
    // check that notices a run the app lost reads exactly that column. A minute
    // tick touching every live row would make it a freshness nothing outlives.
    //
    // The row is backdated by hand rather than by waiting: the column is
    // Drizzle's `mode: 'timestamp'`, which is **seconds**, so two writes a
    // millisecond apart are indistinguishable and a sleep long enough to tell
    // them apart would be a second per assertion.
    const row = insert()
    const long_ago = 1_700_000_000
    holder.current!.raw.prepare('UPDATE handovers SET updated_at = ? WHERE id = ?').run(long_ago, row.id)

    handoverRepo.update(USER, row.id, { lastScannedAt: new Date(1_800_000_000_000) })
    const scanned = handoverRepo.getById(USER, row.id)!
    expect(scanned.updatedAt.getTime()).toBe(long_ago * 1000)
    expect(scanned.lastScannedAt?.getTime()).toBe(1_800_000_000_000)

    // Anything else is a change, even alongside a scan timestamp.
    handoverRepo.update(USER, row.id, { state: 'done', lastScannedAt: new Date(1_800_000_060_000) })
    expect(handoverRepo.getById(USER, row.id)!.updatedAt.getTime()).toBeGreaterThan(long_ago * 1000)
  })

  it('records the wake once, and reports it as a number', () => {
    const row = insert()
    expect(handoverRepo.toDto(row).wokeAt).toBeNull()
    const woken = handoverRepo.update(USER, row.id, { wokeAt: new Date(1_700_000_000_000), wakeRunId: 'run-9' })!
    expect(handoverRepo.toDto(woken).wokeAt).toBe(1_700_000_000_000)
    expect(woken.wakeRunId).toBe('run-9')
  })

  it('reports a missing brief as a number, and clears it when it is back', () => {
    // The row that names `.cinna/handovers/<id>` on the task page reads this
    // column: a directory the requester deleted must stop being claimed (§9).
    const row = insert()
    expect(handoverRepo.toDto(row).briefMissingAt).toBeNull()
    const gone = handoverRepo.update(USER, row.id, { briefMissingAt: new Date(1_700_000_000_000) })!
    expect(handoverRepo.toDto(gone).briefMissingAt).toBe(1_700_000_000_000)
    const back = handoverRepo.update(USER, row.id, { briefMissingAt: null })!
    expect(handoverRepo.toDto(back).briefMissingAt).toBeNull()
  })

  it('never puts a digest on the wire', () => {
    const dto = handoverRepo.toDto(insert({ reportDigest: 'digest-two' })) as unknown as Record<string, unknown>
    expect(dto).not.toHaveProperty('briefDigest')
    expect(dto).not.toHaveProperty('reportDigest')
    expect(dto).not.toHaveProperty('gateChatId')
    expect(dto).not.toHaveProperty('wakeRunId')
    expect(typeof dto.createdAt).toBe('number')
  })

  it('lists one fan-out group, and keeps two origins apart', () => {
    // A group id is a string a requester chose, so the origin chat is half the
    // key: two conversations both picking `release-cut` are two groups, and
    // waking one with the other's results would be the bug.
    const a = insert({ handoverId: '20260917-1200-api', groupId: 'release-cut', originChatId: 'chat-1' })
    const b = insert({
      agentId: 'folder:external:root:web',
      handoverId: '20260917-1200-web',
      groupId: 'release-cut',
      originChatId: 'chat-1'
    })
    insert({
      agentId: 'folder:external:root:docs',
      handoverId: '20260917-1200-docs',
      groupId: 'release-cut',
      originChatId: 'chat-2'
    })
    insert({ handoverId: '20260917-1200-solo', groupId: null, originChatId: 'chat-1' })

    expect(handoverRepo.listForGroup(USER, 'chat-1', 'release-cut').map((row) => row.id).sort()).toEqual(
      [a.id, b.id].sort()
    )
    expect(handoverRepo.listForGroup('someone-else', 'chat-1', 'release-cut')).toEqual([])
  })

  it('round-trips the revisions it has delivered and the last summary', () => {
    const row = insert()
    expect(row.revisionsDelivered).toBeNull()
    const updated = handoverRepo.update(USER, row.id, {
      revisionsDelivered: JSON.stringify(['001.md', '002.md']),
      summary: 'Retry added'
    })!
    expect(JSON.parse(updated.revisionsDelivered as string)).toEqual(['001.md', '002.md'])
    expect(updated.summary).toBe('Retry added')
  })

  it('lists a profile’s rows for one agent, and the orphans across them', () => {
    const mine = insert()
    insert({ agentId: 'folder:external:root:other', handoverId: '20260917-1300-other' })
    expect(handoverRepo.listForAgent(USER, AGENT).map((row) => row.id)).toEqual([mine.id])
    expect(handoverRepo.orphaned(USER).length).toBe(2)
  })
})
