import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { canonicalJson } from './crypto/canonicalJson'
import type { JobDepDescriptor } from '../../shared/sync'

/**
 * The `task` collection end to end against a real database: this device
 * encodes a task, and a peer applies what it sent.
 *
 * It is written at the mapper rather than at the repo because everything this
 * step can get wrong is *between* the two. `taskMapper.listDirty` and its
 * `apply` are both private to `collections.ts`, the assignee descriptor is
 * derived on the way out and resolved on the way in by two different modules,
 * and the columns that must **not** travel are absent from a payload rather
 * than refused by a repo — so a unit test of either end would assert the shape
 * it was handed instead of the shape that crosses.
 *
 * The round trip is modelled the way the engine really does it: two devices
 * that are two databases holding the same profile, a JSON trip (`syncEngine`
 * encrypts what `listDirty` returns and the peer decrypts it), and a
 * `clientUpdatedAt` carried beside the payload rather than in it.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  userData: '',
  deviceId: null as string | null
}))

vi.mock('electron', () => ({ app: { getPath: () => holder.userData } }))
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
  getProfileScopeUserId: () => 'profile-1',
  getAgentLookupScope: () => ['__default__', 'profile-1']
}))
vi.mock('../services/cinnaApiService', () => ({
  getCinnaServerUrl: () => null,
  cinnaApiService: {}
}))
vi.mock('../db/sync', () => ({
  syncRepo: {
    getState: () => (holder.deviceId ? { deviceId: holder.deviceId } : null)
  }
}))
vi.mock('../services/syncService', () => ({ syncService: { markDirty: () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { COLLECTION_MAPPERS, newResolveCache } = await import('./collections')
const { agentRepo } = await import('../db/agents')
const { taskRepo } = await import('../db/tasks')
const { taskService } = await import('../services/taskService')

/**
 * **The same profile on two devices, which is two databases.**
 *
 * Modelling the peer as a second *profile id* in one database looks simpler and
 * is wrong in the way that matters: `client_entity_id` is the row's own primary
 * key and it is the same on both devices, so the two copies would collide on
 * one table — and `upsertFromSync`'s cross-profile guard would refuse the apply
 * outright, quietly, leaving every assertion below testing nothing. Two
 * databases is also what it really is.
 *
 * Each device gets its own `userData` too, or the exported handoff notes of the
 * two would be one folder and the file assertions would not know whose file
 * they had found.
 */
const USER = '__default__'

interface Device {
  db: TestDatabase
  userData: string
  /** This device's sync id — the value `executor_device` is compared against. */
  deviceId: string | null
}

let deviceA: Device
let deviceB: Device

const taskMapper = COLLECTION_MAPPERS.find((m) => m.collection === 'task')

function newDevice(label: string): Device {
  return {
    db: createTestDatabase(),
    userData: mkdtempSync(join(tmpdir(), `cinna-task-sync-${label}-`)),
    deviceId: `device-${label}`
  }
}

/** Run `fn` as the given device: its database, its storage folder, its sync id. */
function on<T>(device: Device, fn: () => T): T {
  holder.current = device.db
  holder.userData = device.userData
  holder.deviceId = device.deviceId
  return fn()
}

beforeEach(() => {
  deviceA = newDevice('a')
  deviceB = newDevice('b')
  holder.current = deviceA.db
  holder.userData = deviceA.userData
  holder.deviceId = deviceA.deviceId
})

afterEach(() => {
  for (const d of [deviceA, deviceB]) {
    d?.db.close()
    if (d?.userData) rmSync(d.userData, { recursive: true, force: true })
  }
  holder.current = null
})

interface Encoded {
  plaintext: Record<string, unknown>
  deleted: boolean
  clientUpdatedAt: number
}

/** What `device` would push for `taskId`, decoded as the other one sees it. */
function encode(device: Device, taskId: string): Encoded {
  return on(device, () => {
    const records = taskMapper!.listDirty(USER, 0)
    const record = records.find((r) => r.clientEntityId === taskId)
    if (!record) throw new Error(`task ${taskId} was not in the push batch`)
    // The wire is JSON: what the peer decrypts is a parse of what we encrypted.
    return {
      plaintext: JSON.parse(JSON.stringify(record.plaintext)) as Record<string, unknown>,
      deleted: record.deleted,
      clientUpdatedAt: record.clientUpdatedAt
    }
  })
}

/**
 * How much later than the sender's own `updatedAt` a record comes back.
 *
 * **The engine does not carry the sender's timestamp.** `ApplyContext.
 * clientUpdatedAt` is `PullRecordWire.updated_at_ms`, which `syncApi.ts` spells
 * out is derived from the server's `server_updated_at` — "the server does NOT
 * echo the peer's `client_updated_at`". So a replica is always *newer* than the
 * row it mirrors, by the push latency, and a harness that fed the sender's time
 * would be proving a property production does not have. What keeps the replica
 * from being re-pushed is not its timestamp being small; it is that the
 * watermark is taken from `maxUpdatedAt` **after** the apply.
 */
const SERVER_LAG_MS = 4_000

/** Apply an encoded record on the receiving device, as the engine would. */
function applyTo(device: Device, id: string, encoded: Encoded): number {
  const serverUpdatedAt = encoded.clientUpdatedAt + SERVER_LAG_MS
  on(device, () =>
    taskMapper!.apply(USER, id, encoded.plaintext, encoded.deleted, {
      clientUpdatedAt: serverUpdatedAt,
      cache: newResolveCache()
    })
  )
  return serverUpdatedAt
}

/**
 * Push a task's `updatedAt` into the past.
 *
 * Every timestamp column here is drizzle `integer({ mode: 'timestamp' })`,
 * which is **seconds** — so a replica that stamped `new Date()` instead of
 * carrying the peer's time compares *equal* to a row written in the same
 * second. A test that did not back-date first passed against exactly that
 * mutation.
 */
function backdate(device: Device, taskId: string, when: Date): void {
  on(device, () => taskRepo.update(USER, taskId, { updatedAt: when }))
}

/** A hand-added A2A agent, whose row id is a fresh `nanoid` on each device. */
function localAgent(device: Device, cardUrl: string, name: string): string {
  return on(
    device,
    () => agentRepo.create(USER, { name, protocol: 'a2a', cardUrl, enabled: true }).id
  )
}

/**
 * Index a workshop on a device, the way a folder scan does. The row id is
 * `folder:<manifestId>` on every device that has the same folder — which is the
 * property that makes the descriptor resolvable at all.
 */
function folderAgent(device: Device, manifestId: string, name: string): string {
  const id = `folder:${manifestId}`
  on(device, () =>
    agentRepo.replaceFolderIndex(USER, 'r1', [
      {
        id,
        name,
        description: null,
        localPath: `/w/Local/${name}`,
        launcher: 'opencode',
        remoteMetadata: {
          entrypoint_prompt: null,
          example_prompts: [],
          session_mode: null,
          ui_color_preset: null,
          protocol_versions: []
        }
      }
    ])
  )
  return id
}

describe('what a task carries across app-sync', () => {
  it('leaves behind the four columns that must not travel', () => {
    const task = on(deviceA, () => {
      const created = taskService.create(USER, {
        title: 'Reconcile payouts',
        goal: 'Reconcile payouts for the last 7 days',
        chatId: null,
        assigneeAgentId: 'agt_local_only',
        assigneeName: 'Ledger',
        assigneeKind: 'agent',
        remoteAdapter: 'fake',
        remoteId: 'r-1'
      })
      // Give it the two per-device bookkeeping values a bound task acquires.
      taskService.update(USER, created.id, { title: 'Reconcile payouts again' })
      taskService.markRemoteSynced(USER, created.id, ['title'], { contacted: true })
      return created
    })

    const { plaintext } = encode(deviceA, task.id)

    // `chat_id` — chats are not a synced collection, so an id from here names
    // nothing there and would offer "Open the conversation" over a void.
    expect(plaintext).not.toHaveProperty('chatId')
    // `assignee_agent_id` — device-local. `assigneeRef` travels in its place.
    expect(plaintext).not.toHaveProperty('assigneeAgentId')
    // The two watermarks. A peer that has never spoken to that service must not
    // inherit a claim that it has, nor a list of what this device still owes it.
    expect(plaintext).not.toHaveProperty('remoteSyncedAt')
    expect(plaintext).not.toHaveProperty('remoteDirty')

    // What a bound task *does* carry: the binding itself, so the peer opens the
    // same remote record rather than creating a second one.
    expect(plaintext.remoteAdapter).toBe('fake')
    expect(plaintext.remoteId).toBe('r-1')
  })

  it('carries the executor claim, which is the whole point of it', () => {
    const task = on(deviceA, () =>
      taskService.create(USER, {
        title: 'Long job',
        goal: 'Run the long job',
        executorDevice: 'device-a'
      })
    )
    expect(encode(deviceA, task.id).plaintext.executorDevice).toBe('device-a')
  })

  it('carries the times a task page prints', () => {
    const created = new Date('2026-02-01T09:00:00.000Z')
    const task = on(deviceA, () => {
      const t = taskService.create(USER, {
        title: 'Old work',
        goal: 'Old work, please',
        createdAt: created
      })
      taskService.setStatus(USER, t.id, 'in_progress')
      taskService.setStatus(USER, t.id, 'completed')
      return t
    })

    const { plaintext } = encode(deviceA, task.id)
    expect(plaintext.createdAt).toBe(created.getTime())
    expect(typeof plaintext.startedAt).toBe('number')
    expect(typeof plaintext.finishedAt).toBe('number')
  })
})

describe('the assignee, which is the only thing a task cannot send as it stands', () => {
  it('travels as a portable descriptor and resolves to the peer’s own row id', () => {
    const here = folderAgent(deviceA, '6f1a-uuid', 'Invoice Checker')
    // The same workshop is on B too, under the id B derives from its manifest.
    const there = folderAgent(deviceB, '6f1a-uuid', 'Invoice Checker')
    const task = on(deviceA, () =>
      taskService.create(USER, {
        title: 'Check invoices',
        goal: 'Check every invoice from August',
        assigneeAgentId: here,
        assigneeName: 'Invoice Checker',
        assigneeKind: 'agent'
      })
    )

    const encoded = encode(deviceA, task.id)
    const ref = encoded.plaintext.assigneeRef as JobDepDescriptor
    expect(ref).toMatchObject({ kind: 'agent', source: 'folder', manifestId: '6f1a-uuid' })
    // Not a path: the workshop directory is this machine's business, and a peer
    // that received one would learn a filesystem layout it has no use for.
    expect(JSON.stringify(encoded.plaintext)).not.toContain('/w/Local/')

    applyTo(deviceB, task.id, encoded)

    expect(on(deviceB, () => taskRepo.getById(USER, task.id)?.assigneeAgentId)).toBe(there)
  })

  /**
   * The sharper version of the claim above, because a folder agent has the same
   * row id on every device by construction. A hand-added A2A agent does not: it
   * is a `nanoid` minted where it was added, so the peer's id for the same
   * agent is a different string — and the task still lands on it.
   */
  it('resolves to a *different* local row id on the peer, which is the whole point', () => {
    const here = localAgent(deviceA, 'https://agents.test/.well-known/agent.json', 'Ledger')
    const there = localAgent(deviceB, 'https://agents.test/.well-known/agent.json', 'Ledger')
    expect(there).not.toBe(here)

    const task = on(deviceA, () =>
      taskService.create(USER, {
        title: 'Reconcile',
        goal: 'Reconcile the ledger',
        assigneeAgentId: here,
        assigneeName: 'Ledger',
        assigneeKind: 'agent'
      })
    )
    const encoded = encode(deviceA, task.id)
    // The device-local id is nowhere on the wire; the card URL is the identity.
    expect(JSON.stringify(encoded.plaintext)).not.toContain(here)
    expect(encoded.plaintext.assigneeRef).toMatchObject({
      kind: 'agent',
      source: 'local',
      cardUrl: 'https://agents.test/.well-known/agent.json'
    })

    applyTo(deviceB, task.id, encoded)
    expect(on(deviceB, () => taskRepo.getById(USER, task.id)?.assigneeAgentId)).toBe(there)
  })

  /**
   * The departure from the job apply path beside it, and the one worth pinning:
   * `resolveLocalAgent` auto-creates a disabled shell on a miss and
   * `resolveTaskAssignee` deliberately does not. A profile syncs a great many
   * tasks, and a row per synced task would fill the user's Agents list with
   * agents they never added, from work that already finished somewhere else.
   *
   * Both arms, because only one of them is the deviation: a folder agent never
   * auto-created anywhere, so a version of this test that used only a folder
   * assignee would pass against the auto-creating resolver too — which is what
   * the mutation check found.
   */
  it.each([
    [
      'a hand-added A2A agent',
      (): string => localAgent(deviceA, 'https://agents.test/.well-known/agent.json', 'Ledger')
    ],
    ['a folder agent', (): string => folderAgent(deviceA, 'only-on-a', 'Ledger')]
  ])(
    'leaves the assignee unresolved on a device that lacks %s, and creates nothing',
    (_label, seed) => {
      const here = seed()
      const task = on(deviceA, () =>
        taskService.create(USER, {
          title: 'Reconcile',
          goal: 'Reconcile the ledger',
          assigneeAgentId: here,
          assigneeName: 'Ledger',
          assigneeKind: 'agent'
        })
      )
      // B has never had it.
      const agentsBefore = on(deviceB, () => agentRepo.list(USER).length)

      applyTo(deviceB, task.id, encode(deviceA, task.id))

      on(deviceB, () => {
        const row = taskRepo.getById(USER, task.id)
        expect(row?.assigneeAgentId).toBeNull()
        // The name still arrives, so the page can say who it was assigned to
        // even though it cannot link to them.
        expect(row?.assigneeName).toBe('Ledger')
        expect(agentRepo.list(USER)).toHaveLength(agentsBefore)
      })
    }
  )

  /**
   * And the reason the unresolved case stores the descriptor rather than
   * dropping it: the replica has to be able to hand the same assignee to a
   * *third* device. Deriving from `assigneeAgentId` alone — which is null here
   * — would send a task assigned to nobody.
   */
  it('re-emits a descriptor it could not resolve, byte for byte', () => {
    const here = folderAgent(deviceA, 'only-on-a', 'Invoice Checker')
    const task = on(deviceA, () =>
      taskService.create(USER, {
        title: 'Check invoices',
        goal: 'Check every invoice from August',
        assigneeAgentId: here,
        assigneeName: 'Invoice Checker',
        assigneeKind: 'agent'
      })
    )
    const fromA = encode(deviceA, task.id)
    applyTo(deviceB, task.id, fromA)
    // B edits something else and pushes: the assignee it could not resolve must
    // still be in what a third device receives.
    on(deviceB, () => taskService.update(USER, task.id, { title: 'Renamed on B' }))

    const fromB = encode(deviceB, task.id)
    expect(fromB.plaintext.assigneeRef).toEqual(fromA.plaintext.assigneeRef)
  })

  it('sends no descriptor for an assignee that names nothing on this device', () => {
    const { remote, model } = on(deviceA, () => ({
      remote: taskService.create(USER, {
        title: 'Ask the service',
        goal: 'Ask the service to do it',
        // A `remote_agent` id is the bound *service's* id for the agent, not a
        // row here — a local lookup would miss, or hit something unrelated.
        assigneeAgentId: 'cinna-uuid-1',
        assigneeName: 'Researcher',
        assigneeKind: 'remote_agent'
      }),
      model: taskService.create(USER, { title: 'Think', goal: 'Think about it' })
    }))

    expect(encode(deviceA, remote.id).plaintext.assigneeRef).toBeNull()
    expect(encode(deviceA, model.id).plaintext.assigneeRef).toBeNull()
    // The kind and the name still travel, which is what the page renders.
    expect(encode(deviceA, remote.id).plaintext.assigneeKind).toBe('remote_agent')
    expect(encode(deviceA, remote.id).plaintext.assigneeName).toBe('Researcher')
  })
})

describe('a delete', () => {
  it('travels as an upsert carrying deletedAt, not as a tombstone', () => {
    const task = on(deviceA, () => {
      const t = taskService.create(USER, { title: 'Drop it', goal: 'Drop it' })
      taskService.remove(USER, t.id)
      return t
    })

    const encoded = encode(deviceA, task.id)
    // The wire flag the server records, and the payload field the peer applies.
    // A task has no trash and no restore, so this soft delete is its only one —
    // `syncRepo.addTombstone` is app-sync's carrier for a *hard* delete and
    // nothing here writes one.
    expect(encoded.deleted).toBe(true)
    expect(typeof encoded.plaintext.deletedAt).toBe('number')

    applyTo(deviceB, task.id, encoded)
    on(deviceB, () => {
      expect(taskRepo.getById(USER, task.id)?.deletedAt).not.toBeNull()
      expect(taskService.list(USER)).toHaveLength(0)
    })
  })

  it('takes the peer’s exported note with it', () => {
    const task = on(deviceA, () =>
      taskService.create(USER, {
        title: 'Drop it',
        goal: 'Drop it',
        handoffNote: 'Half done.'
      })
    )
    applyTo(deviceB, task.id, encode(deviceA, task.id))
    const file = join(deviceB.userData, 'tasks', `${task.id}.md`)
    expect(existsSync(file)).toBe(true)

    on(deviceA, () => taskService.remove(USER, task.id))
    applyTo(deviceB, task.id, encode(deviceA, task.id))
    expect(existsSync(file)).toBe(false)
  })

  /**
   * The null-plaintext arm. Nothing this build writes produces one for a task,
   * but every mapper has to answer it — a record a mapper ignores is one the
   * server hands back on every pull for ever.
   */
  it('applies a tombstone as a hard delete', () => {
    on(deviceB, () => {
      const task = taskService.create(USER, { title: 'Gone', goal: 'Gone' })
      taskMapper!.apply(USER, task.id, null, true, {
        clientUpdatedAt: Date.now(),
        cache: newResolveCache()
      })
      expect(taskRepo.getById(USER, task.id)).toBeUndefined()
    })
  })
})

describe('what the peer ends up with', () => {
  it('is the same task, minus what is this device’s business', () => {
    const agent = folderAgent(deviceA, 'shared-uuid', 'Invoice Checker')
    folderAgent(deviceB, 'shared-uuid', 'Invoice Checker')
    const task = on(deviceA, () => {
      const t = taskService.create(USER, {
        title: 'Reconcile payouts',
        goal: 'Reconcile payouts for the last 7 days',
        description: 'The ledger and the bank disagree.',
        priority: 'high',
        router: 'direct',
        chatId: null,
        assigneeAgentId: agent,
        assigneeName: 'Invoice Checker',
        assigneeKind: 'agent',
        jobId: 'job-1',
        jobRunId: 'run-1',
        handoffNote: 'Half done.',
        budget: { maxRounds: 4 }
      })
      taskService.setStatus(USER, t.id, 'in_progress')
      return t
    })

    const serverUpdatedAt = applyTo(deviceB, task.id, encode(deviceA, task.id))

    const mine = on(deviceA, () => taskService.getById(USER, task.id))
    const theirs = on(deviceB, () => taskService.getById(USER, task.id))
    expect(theirs).toEqual({
      ...mine,
      // Two fields differ, and both differences are the point of the feature.
      // The replica is stamped with the *server's* time, not A's (see
      // `SERVER_LAG_MS`) — and it knows A is running this, so it is read-only.
      updatedAt: new Date(serverUpdatedAt),
      runsHere: false
    })
    expect(mine.runsHere).toBe(true)
  })

  /**
   * The push watermark, in the units every caller works in.
   *
   * `maxUpdatedAt` is answered by SQLite's `max()`, and the column is drizzle
   * `integer({ mode: 'timestamp' })` — **seconds**. Every caller, and the
   * `Date.getTime()` the JS reduction used to return, works in milliseconds. A
   * factor of a thousand either way makes `listChangedSince` see everything on
   * every cycle or nothing ever, and neither says so.
   */
  it('reports the newest updated_at in milliseconds', () => {
    const newest = new Date('2026-03-04T05:06:07.000Z')
    on(deviceA, () => {
      const older = taskService.create(USER, { title: 'Older', goal: 'Older work' })
      const newer = taskService.create(USER, { title: 'Newer', goal: 'Newer work' })
      backdate(deviceA, older.id, new Date('2026-02-01T09:00:00.000Z'))
      backdate(deviceA, newer.id, newest)

      expect(taskMapper!.maxUpdatedAt(USER)).toBe(newest.getTime())
      // And the watermark it produces excludes everything, which is the use.
      expect(taskMapper!.listDirty(USER, newest.getTime())).toHaveLength(0)
      expect(taskMapper!.listDirty(USER, newest.getTime() - 1000)).toHaveLength(1)
    })
  })

  it('reports zero for a profile with no tasks', () => {
    expect(on(deviceB, () => taskMapper!.maxUpdatedAt(USER))).toBe(0)
  })

  /**
   * The times land as the times, not as the moment this device heard about
   * them.
   *
   * Pinned against dates a week apart rather than against "what it was a moment
   * ago": every timestamp column here is stored as **seconds**, so a replica
   * that stamped `new Date()` would compare equal to a task created in the same
   * second — which is what a version of this test written against a
   * just-created task did, and it passed against the mutation it was meant to
   * catch.
   */
  it('keeps the peer’s created, started and finished times', () => {
    const created = new Date('2026-02-01T09:00:00.000Z')
    const task = on(deviceA, () => {
      const t = taskService.create(USER, {
        title: 'Old work',
        goal: 'Old work, please',
        createdAt: created
      })
      taskService.setStatus(USER, t.id, 'in_progress')
      taskService.setStatus(USER, t.id, 'completed')
      return t
    })
    backdate(deviceA, task.id, new Date('2026-02-08T09:00:00.000Z'))
    const encoded = encode(deviceA, task.id)

    const serverUpdatedAt = applyTo(deviceB, task.id, encoded)

    on(deviceB, () => {
      const row = taskRepo.getById(USER, task.id)
      expect(row?.createdAt.getTime()).toBe(created.getTime())
      expect(row?.startedAt?.getTime()).toBe(encoded.plaintext.startedAt)
      expect(row?.finishedAt?.getTime()).toBe(encoded.plaintext.finishedAt)
      // `updatedAt` alone is **not** the sender's: the engine writes the
      // server's time, because the server does not echo `client_updated_at`.
      // The three above are payload fields and do survive verbatim, which is
      // the whole distinction — a replica may look newer than the row it
      // mirrors, but it must not claim the work started when it arrived.
      expect(row?.updatedAt.getTime()).toBe(serverUpdatedAt)
      expect(serverUpdatedAt).toBeGreaterThan(encoded.clientUpdatedAt)
    })
  })

  /**
   * A second apply of the same payload must be a no-op on the row, or the
   * replica's `updatedAt` would creep forward and it would start winning
   * last-writer-wins rounds it should lose.
   */
  it('does not drift when the same record is applied twice', () => {
    const task = on(deviceA, () =>
      taskService.create(USER, { title: 'Steady', goal: 'Stay steady' })
    )
    const encoded = encode(deviceA, task.id)
    applyTo(deviceB, task.id, encoded)
    const first = on(deviceB, () => taskRepo.getById(USER, task.id))
    applyTo(deviceB, task.id, encoded)
    expect(on(deviceB, () => taskRepo.getById(USER, task.id))).toEqual(first)
  })

  /**
   * And it is the *watermark* that stops it, not the timestamp being small.
   * The replica is stamped with the server's time, which is newer than the
   * sender's row — so an argument from "the replica carries an older time"
   * would be false. What actually holds is the order `syncEngine` does things
   * in: it advances `lastPushedAt` to `maxUpdatedAt` **after** the pull loop,
   * so the row it has just applied is already below the line.
   */
  it('is not pushed back: the watermark advances past the applied replica', () => {
    const task = on(deviceA, () =>
      taskService.create(USER, { title: 'Quiet', goal: 'Stay quiet' })
    )
    backdate(deviceA, task.id, new Date('2026-02-08T09:00:00.000Z'))
    const encoded = encode(deviceA, task.id)
    const serverUpdatedAt = applyTo(deviceB, task.id, encoded)

    on(deviceB, () => {
      const watermark = taskMapper!.maxUpdatedAt(USER)
      expect(watermark).toBe(serverUpdatedAt)
      expect(watermark).toBeGreaterThan(encoded.clientUpdatedAt)
      expect(taskMapper!.listDirty(USER, watermark)).toHaveLength(0)
    })
  })
})

/**
 * **Byte-stability across an A → B round trip** — `manifest-stability.test.ts`
 * for tasks, and the reason it lives here rather than in a file of its own is
 * that a task's payload is not a pure function of a stored manifest. A job's is:
 * `sync_deps` holds the wire bytes verbatim, so the claim can be proved with
 * four helpers and no database. A task's payload is derived from its row, and
 * only one field of it (`assigneeRef`) is carried verbatim — so the only honest
 * proof runs the real encode, the real apply and the real re-encode, which is
 * the harness above.
 *
 * What is at stake is the same: B applies A's record, stores it, and re-encodes
 * it to the same canonical bytes, so the server answers `unchanged` and the two
 * devices stop talking about it. Bytes that differ mean a row reported as
 * changed on every sync, for ever, by both devices in turn.
 */
describe('byte-stability across a sync round trip', () => {
  /** The canonical bytes each device would encrypt for the same task. */
  function bothSides(taskId: string): { a: string; b: string } {
    const fromA = encode(deviceA, taskId)
    applyTo(deviceB, taskId, fromA)
    // The bytes B would send only matter once B pushes, and B only pushes
    // after a local edit — so the round trip is completed with one. It writes
    // the title back to exactly what A sent, so any difference below is the
    // trip's doing and not the edit's.
    on(deviceB, () => taskService.update(USER, taskId, { title: String(fromA.plaintext.title) }))
    return {
      a: canonicalJson(fromA.plaintext),
      b: canonicalJson(encode(deviceB, taskId).plaintext)
    }
  }

  it('re-encodes identically when the peer can resolve the assignee', () => {
    const here = localAgent(deviceA, 'https://agents.test/.well-known/agent.json', 'Ledger')
    localAgent(deviceB, 'https://agents.test/.well-known/agent.json', 'Ledger')
    const task = on(deviceA, () =>
      taskService.create(USER, {
        title: 'Reconcile',
        goal: 'Reconcile the ledger',
        description: 'The bank and the ledger disagree.',
        priority: 'high',
        assigneeAgentId: here,
        assigneeName: 'Ledger',
        assigneeKind: 'agent',
        handoffNote: 'Half done.',
        budget: { maxRounds: 4 },
        artifacts: [{ kind: 'link', name: 'The PR', ref: 'https://example.test/pr/1' }]
      })
    )
    const { a, b } = bothSides(task.id)
    expect(b).toBe(a)
  })

  /**
   * The case the verbatim `assigneeRef` column exists for. B cannot rebuild the
   * descriptor — it has no row for that agent — so it must re-emit the one it
   * was given rather than derive one and send nothing.
   */
  it('re-encodes identically when the peer cannot resolve the assignee', () => {
    const here = localAgent(deviceA, 'https://agents.test/.well-known/agent.json', 'Ledger')
    const task = on(deviceA, () =>
      taskService.create(USER, {
        title: 'Reconcile',
        goal: 'Reconcile the ledger',
        assigneeAgentId: here,
        assigneeName: 'Ledger',
        assigneeKind: 'agent'
      })
    )
    const { a, b } = bothSides(task.id)
    expect(b).toBe(a)
    expect(a).toContain('"cardUrl":"https://agents.test/.well-known/agent.json"')
  })

  it('re-encodes a bound task identically, opaque adapter state and all', () => {
    const task = on(deviceA, () => {
      const t = taskService.create(USER, { title: 'Bound', goal: 'Bound work' })
      taskService.bindRemote(USER, t.id, {
        adapter: 'fake',
        id: 'r-1',
        key: 'FAKE-1',
        url: 'https://fake.test/tasks/FAKE-1',
        state: { session: 's1', nested: { page: 2 } }
      })
      return t
    })
    const { a, b } = bothSides(task.id)
    expect(b).toBe(a)
    expect(a).toContain('"session":"s1"')
  })

  /**
   * A peer on a newer build can send a status this one has never heard of. It
   * is stored raw and re-emitted raw — the tolerant parsers in `shared/tasks.ts`
   * and `shared/taskStatus.ts` exist so that such a row still *renders*, and
   * this is the other half of that bargain: it must also still round-trip.
   * Narrowing on the way in would rewrite a peer's value to this build's
   * fallback and hand it back as a change the peer never made.
   */
  it('carries a status from a newer build through unchanged', () => {
    const task = on(deviceA, () => taskService.create(USER, { title: 'Ahead', goal: 'Ahead' }))
    const fromA = encode(deviceA, task.id)
    const fromFuture = { ...fromA, plaintext: { ...fromA.plaintext, status: 'deliberating' } }

    applyTo(deviceB, task.id, fromFuture)
    on(deviceB, () => {
      // Renders as something rather than reaching a `switch` with no case.
      expect(taskService.getById(USER, task.id).status).toBe('in_progress')
      taskService.update(USER, task.id, { title: String(fromA.plaintext.title) })
    })
    expect(encode(deviceB, task.id).plaintext.status).toBe('deliberating')
  })
})

/**
 * **The claim decides who may write the run.**
 *
 * `requireRunsHere` refuses a local `setStatus` / `setAssignee` /
 * `setHandoffNote` for a task another device holds — but `taskService.update`
 * (title, description, priority, router) is deliberately ungated, because
 * fixing a title on the machine in front of you is not a claim on the run. With
 * **whole-record** last-writer-wins, that ungated edit pushes the replica's
 * entire row, stale run state and all, under a newer timestamp.
 *
 * Without the guard on the way in, the holder then applies its own old state
 * back over what its agent had just produced. The note is the one that cannot
 * be recovered: nothing else holds it, and the file under `<userData>/tasks/`
 * is rewritten from the row.
 */
describe('a replica edit does not overwrite the run the holder is following', () => {
  /** A runs it, B holds a replica that is one poll behind. */
  function runningOnA(): { taskId: string; stale: Encoded } {
    const task = on(deviceA, () => {
      const t = taskService.create(USER, { title: 'Reconcile', goal: 'Reconcile the ledger' })
      taskService.start(USER, t.id)
      taskService.setHandoffNote(USER, t.id, 'step 1 done')
      return t
    })
    applyTo(deviceB, task.id, encode(deviceA, task.id))
    // A's agent gets further while B is looking at the older copy.
    on(deviceA, () => {
      taskService.setHandoffNote(USER, task.id, 'step 2 done')
      taskService.setStatus(USER, task.id, 'completed')
    })
    // B fixes the title, which it is allowed to do, and pushes first.
    on(deviceB, () => taskService.update(USER, task.id, { title: 'Reconcile the ledger' }))
    return { taskId: task.id, stale: encode(deviceB, task.id) }
  }

  it('keeps the note, the status and the finish time the holder wrote', () => {
    const { taskId, stale } = runningOnA()
    // The replica really is sending A's old run state back at it.
    expect(stale.plaintext.handoffNote).toBe('step 1 done')
    expect(stale.plaintext.status).toBe('in_progress')

    applyTo(deviceA, taskId, stale)

    on(deviceA, () => {
      const row = taskRepo.getById(USER, taskId)
      expect(row?.handoffNote).toBe('step 2 done')
      expect(row?.status).toBe('completed')
      expect(row?.finishedAt).not.toBeNull()
      // And the edit B was entitled to make lands.
      expect(row?.title).toBe('Reconcile the ledger')
    })
  })

  it('keeps the exported note in step with the row it kept', () => {
    const { taskId, stale } = runningOnA()
    applyTo(deviceA, taskId, stale)
    const file = join(deviceA.userData, 'tasks', `${taskId}.md`)
    expect(readFileSync(file, 'utf8')).toContain('step 2 done')
  })

  /**
   * The guard is narrow on purpose. A record that names a **different** holder
   * is a take-over, and the device that took it over is the one whose run state
   * counts from then on — otherwise the old holder could never be told anything
   * about the task again.
   */
  it('yields everything once the record names a different holder', () => {
    const { taskId, stale } = runningOnA()
    const takenOver = {
      ...stale,
      plaintext: { ...stale.plaintext, executorDevice: deviceB.deviceId }
    }

    applyTo(deviceA, taskId, takenOver)

    on(deviceA, () => {
      const row = taskRepo.getById(USER, taskId)
      expect(row?.handoffNote).toBe('step 1 done')
      expect(row?.executorDevice).toBe(deviceB.deviceId)
      expect(taskService.getById(USER, taskId).runsHere).toBe(false)
    })
  })

  /**
   * And a `null` claim confers nothing. It means nobody in particular, so two
   * devices that each kept their own copy of the run fields would diverge with
   * nothing able to converge them — which is worse than one of them losing.
   */
  /**
   * And **neither** kind of null confers authority — not a task nobody has
   * claimed, and not a device that has no identity to claim it with (which is
   * the state `syncService.disconnect` leaves, since it keeps the `sync_state`
   * row and nulls its `deviceId`).
   *
   * Both arms matter, and the second is the one that is easy to get wrong:
   * `null === null` is `true`, so a guard written as "the local claim equals
   * this device" fires on two devices at once and each keeps its own copy of
   * the run fields for ever, with nothing able to converge them. Losing one
   * edit is recoverable; permanent disagreement is not.
   */
  it.each([
    ['no device has claimed the task', 'device-a' as string | null],
    ['this device has no sync identity', null as string | null]
  ])('yields everything when %s', (_label, deviceId) => {
    const here = { ...deviceA, deviceId }
    const task = on(here, () => {
      const t = taskService.create(USER, {
        title: 'Unclaimed',
        goal: 'Unclaimed work',
        executorDevice: null
      })
      taskService.setHandoffNote(USER, t.id, 'mine')
      return t
    })
    const encoded = encode(here, task.id)
    const fromB = { ...encoded, plaintext: { ...encoded.plaintext, handoffNote: 'theirs' } }

    applyTo(here, task.id, fromB)
    expect(on(here, () => taskRepo.getById(USER, task.id)?.handoffNote)).toBe('theirs')
  })

  /** A peer's delete is a user gesture and outranks the claim. */
  it('still takes a delete from a device that does not hold the task', () => {
    const { taskId, stale } = runningOnA()
    const deleted = {
      ...stale,
      deleted: true,
      plaintext: { ...stale.plaintext, deletedAt: stale.clientUpdatedAt }
    }

    applyTo(deviceA, taskId, deleted)
    expect(on(deviceA, () => taskRepo.getById(USER, taskId)?.deletedAt)).not.toBeNull()
  })
})

/**
 * **"Nobody in particular" and "this device" were the same value.**
 *
 * A profile with sync off writes a null `executor_device`, and
 * {@link taskRunsHere} reads null as "here" — correct while nothing else could
 * disagree. Enrolling a device ends that: those tasks sync with a null claim
 * and read as *mine* on every machine on the account, so both would offer Run
 * on the same task and §5.4's invariant would not hold.
 */
describe('enrolling a device adopts the work that was nobody’s', () => {
  it('claims the live ones and leaves the finished ones alone', () => {
    const before = on({ ...deviceA, deviceId: null }, () => {
      const live = taskService.create(USER, { title: 'Live', goal: 'Live work' })
      const done = taskService.create(USER, { title: 'Done', goal: 'Done work' })
      taskService.setStatus(USER, done.id, 'in_progress')
      taskService.setStatus(USER, done.id, 'completed')
      // Sync off: nobody in particular holds either.
      expect(taskRepo.getById(USER, live.id)?.executorDevice).toBeNull()
      return { live, done }
    })

    on(deviceA, () => {
      expect(taskService.adoptUnclaimed(USER, 'device-a')).toBe(1)
      expect(taskRepo.getById(USER, before.live.id)?.executorDevice).toBe('device-a')
      // Terminal: no run can ever start from it, and claiming the whole of a
      // profile's history would bump `updated_at` on all of it.
      expect(taskRepo.getById(USER, before.done.id)?.executorDevice).toBeNull()
    })
  })

  it('stops the second device believing it owns them too', () => {
    const task = on({ ...deviceA, deviceId: null }, () =>
      taskService.create(USER, { title: 'Live', goal: 'Live work' })
    )
    on(deviceA, () => taskService.adoptUnclaimed(USER, 'device-a'))

    applyTo(deviceB, task.id, encode(deviceA, task.id))

    on(deviceB, () => {
      expect(taskService.getById(USER, task.id).runsHere).toBe(false)
      // Which is the refusal `requireRunsHere` exists for: without the adoption
      // this passed on both devices and started a second run.
      expect(() => taskService.start(USER, task.id)).toThrow()
    })
    expect(on(deviceA, () => taskService.getById(USER, task.id).runsHere)).toBe(true)
  })
})
