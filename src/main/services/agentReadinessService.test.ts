import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentRow } from '../db/agents'
import type { AgentReadiness, AgentReadinessChangedPayload } from '../../shared/agentDrivers'

/**
 * `agentReadinessService` — the cache between a driver's `readiness()` and the
 * agent list the composer refuses sends from.
 *
 * The properties that matter are the ones a list-time probe can get wrong
 * quietly: asking the network once per render (TTL), twice for one agent
 * (coalescing), for an agent the user switched off (enabled-only), for every
 * synced agent at once (concurrency), pushing a refetch for nothing (broadcast
 * only on change), or taking the list down with a probe that threw.
 */

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const {
  createAgentReadinessService,
  LOCAL_READINESS_TTL_MS,
  REMOTE_READINESS_TTL_MS,
  READINESS_CONCURRENCY,
  REFUSAL_RECHECK_FLOOR_MS
} = await import('./agentReadinessService')

const OK: AgentReadiness = { state: 'ok', reason: null }
const DOWN: AgentReadiness = { state: 'unreachable', reason: 'Could not reach the agent.' }

function a2aRow(id: string, over: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    driver: 'a2a',
    source: 'local',
    accessTokenEncrypted: null,
    enabled: true,
    ...over
  } as AgentRow
}

function folderRow(id: string, over: Partial<AgentRow> = {}): AgentRow {
  return a2aRow(id, { driver: 'opencode', source: 'folder', ...over })
}

/** A probe whose answers the test releases by hand. */
function deferredProbe(): {
  probe: (userId: string, row: AgentRow) => Promise<AgentReadiness>
  calls: string[]
  resolve: (id: string, readiness: AgentReadiness) => void
} {
  const calls: string[] = []
  const pending = new Map<string, Array<(r: AgentReadiness) => void>>()
  return {
    calls,
    probe: (_userId, row) => {
      calls.push(row.id)
      return new Promise((resolve) => {
        pending.set(row.id, [...(pending.get(row.id) ?? []), resolve])
      })
    },
    resolve: (id, readiness) => {
      const waiting = pending.get(id) ?? []
      pending.delete(id)
      for (const r of waiting) r(readiness)
    }
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Enough macrotasks for every staggered list-time start to happen — the service starts one per timer turn. */
const settle = async (turns = 12): Promise<void> => {
  for (let i = 0; i < turns; i++) await flush()
}

let clock = 0
let broadcasts: AgentReadinessChangedPayload[] = []

beforeEach(() => {
  clock = 1_000_000
  broadcasts = []
})

function service(probe: (userId: string, row: AgentRow) => Promise<AgentReadiness | null>) {
  const s = createAgentReadinessService()
  s.install({ probe, broadcast: (p) => broadcasts.push(p), now: () => clock })
  return s
}

describe('agentReadinessService', () => {
  it('knows nothing until a check has run, and answers null', async () => {
    const s = service(async () => DOWN)
    expect(s.peek('a')).toBeNull()
    await s.refresh('u', a2aRow('a'))
    expect(s.peek('a')).toEqual(DOWN)
  })

  it('probes nothing before it is installed', async () => {
    const s = createAgentReadinessService()
    s.kick([{ userId: 'u', row: a2aRow('a') }])
    expect(await s.refresh('u', a2aRow('a'))).toBeNull()
    expect(s.peek('a')).toBeNull()
  })

  it('asks a driver once for two checks of the same agent that overlap', async () => {
    const d = deferredProbe()
    const s = service(d.probe)
    const first = s.refresh('u', a2aRow('a'))
    const second = s.refresh('u', a2aRow('a'))
    d.resolve('a', DOWN)
    expect(await first).toEqual(DOWN)
    expect(await second).toEqual(DOWN)
    expect(d.calls).toEqual(['a'])
  })

  it('pushes a first answer only when it is not ok, and later answers only when they change', async () => {
    let answer = OK
    const s = service(async () => answer)
    const row = a2aRow('a')

    await s.refresh('u', row)
    // null and ok look the same everywhere; a push would refetch for nothing.
    expect(broadcasts).toEqual([])

    await s.refresh('u', row)
    expect(broadcasts).toEqual([])

    answer = DOWN
    await s.refresh('u', row)
    expect(broadcasts).toEqual([{ agentId: 'a', readiness: DOWN }])

    await s.refresh('u', row)
    expect(broadcasts).toHaveLength(1)

    answer = { state: 'unreachable', reason: 'Agent connection timed out.' }
    await s.refresh('u', row)
    expect(broadcasts).toHaveLength(2)
  })

  it('pushes a first answer that is not ok', async () => {
    const s = service(async () => DOWN)
    await s.refresh('u', a2aRow('a'))
    expect(broadcasts).toEqual([{ agentId: 'a', readiness: DOWN }])
  })

  it('re-asks an A2A agent only once its answer is older than the remote TTL', async () => {
    const probe = vi.fn(async () => OK)
    const s = service(probe)
    const row = a2aRow('a')
    await s.refresh('u', row)

    clock += REMOTE_READINESS_TTL_MS - 1
    s.kick([{ userId: 'u', row }])
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)

    clock += 1
    s.kick([{ userId: 'u', row }])
    await flush()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('re-asks an agent it refused on the next list, without waiting out the TTL', async () => {
    // A refusal is fixed outside this service — a re-auth, a credential typed
    // into `.env`, a server coming back — and each of those re-reads the list.
    // Mutation: skip every answer inside its TTL (what the service first did)
    // fails this: Send stayed disabled after the fix until Check again.
    let answer = DOWN
    const probe = vi.fn(async () => answer)
    const s = service(probe)
    const row = a2aRow('a')
    await s.refresh('u', row)

    answer = OK
    // Past the short rest a refusal gets, far inside the TTL.
    clock += REFUSAL_RECHECK_FLOOR_MS
    expect(REFUSAL_RECHECK_FLOOR_MS).toBeLessThan(REMOTE_READINESS_TTL_MS)
    s.kick([{ userId: 'u', row }])
    await settle()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(s.peek('a')).toEqual(OK)

    // Once it is ok again, the TTL holds.
    clock += 1
    s.kick([{ userId: 'u', row }])
    await flush()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('rests a refusal for a moment, so the list read its own push causes does not ask again', async () => {
    // Mutation: drop the floor (re-ask a refusal on every list read) fails
    // this — an agent whose reason changes on every check (a 502, then a 504)
    // looped check → push → list → check with nothing in between.
    let n = 0
    const probe = vi.fn(
      async (): Promise<AgentReadiness> => ({
        state: 'unreachable',
        reason: `The agent’s server returned an error (${n++ % 2 ? 504 : 502}).`
      })
    )
    const s = service(probe)
    const row = a2aRow('a')
    await s.refresh('u', row)

    clock += 1
    s.kick([{ userId: 'u', row }])
    await settle()
    expect(probe).toHaveBeenCalledTimes(1)

    clock += REFUSAL_RECHECK_FLOOR_MS
    s.kick([{ userId: 'u', row }])
    await settle()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('keeps the newer answer when an older, slower check lands after it', async () => {
    // Mutation: store every answer as it lands (no start order) fails this — a
    // slow 503 from a list check overwrote the ok Check again had just stored,
    // and Send went back to disabled.
    const pending: Array<(r: AgentReadiness) => void> = []
    const s = service(() => new Promise<AgentReadiness>((resolve) => pending.push(resolve)))
    const row = a2aRow('a')
    s.kick([{ userId: 'u', row }])
    await settle()
    expect(pending).toHaveLength(1)

    const fresh = s.refresh('u', row, { fresh: true })
    expect(pending).toHaveLength(2)
    pending[1](OK)
    expect(await fresh).toEqual(OK)

    pending[0](DOWN)
    await settle()
    expect(s.peek('a')).toEqual(OK)
    expect(broadcasts).toEqual([])
  })

  it('lets no check from before a reset count against the cap after it', async () => {
    // Mutation: drop the generation check from the check's `finally` fails
    // this — a check that settled after `reset()` took `running` below zero,
    // and the next list started one more check than the cap allows.
    const d = deferredProbe()
    const s = service(d.probe)
    s.kick([{ userId: 'u', row: a2aRow('old') }])
    await settle()
    expect(d.calls).toEqual(['old'])

    s.reset()
    s.install({ probe: d.probe, broadcast: (p) => broadcasts.push(p), now: () => clock })
    d.resolve('old', OK)
    await settle()

    const ids = Array.from({ length: READINESS_CONCURRENCY + 1 }, (_, i) => `n${i}`)
    s.kick(ids.map((id) => ({ userId: 'u', row: a2aRow(id) })))
    await settle()
    expect(d.calls.filter((id) => id !== 'old')).toHaveLength(READINESS_CONCURRENCY)
  })

  it('runs a check the user asked for even while a list check is running, and asks for it fresh', async () => {
    // Mutation: hand the in-flight list check back to a fresh request fails
    // this — its answer can come from the Claude login probe's cache, which is
    // exactly what Check again exists to get past.
    const seen: Array<boolean | undefined> = []
    const d = deferredProbe()
    const s = service((userId, row, options?: { fresh?: boolean }) => {
      seen.push(options?.fresh)
      return d.probe(userId, row)
    })
    const row = a2aRow('a')
    s.kick([{ userId: 'u', row }])
    await flush()
    const fresh = s.refresh('u', row, { fresh: true })
    await flush()
    expect(seen).toEqual([undefined, true])
    d.resolve('a', OK)
    expect(await fresh).toEqual(OK)
  })

  it('does not strand a probe that throws synchronously', async () => {
    // Mutation: call the probe inside the async body again (as first written),
    // so a synchronous throw runs the `finally` before `inflight.set` — the
    // settled first check stays in the map, and the second answers null
    // without asking.
    let throws = true
    const probe = vi.fn((): Promise<AgentReadiness> => {
      if (throws) throw new Error('sync')
      return Promise.resolve(DOWN)
    })
    const s = service(probe)
    expect(await s.refresh('u', a2aRow('a'))).toBeNull()
    throws = false
    expect(await s.refresh('u', a2aRow('a'))).toEqual(DOWN)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('re-asks a folder agent on the shorter local TTL', async () => {
    const probe = vi.fn(async () => OK)
    const s = service(probe)
    const folder = folderRow('folder:a')
    const remote = a2aRow('b')
    await s.refresh('u', folder)
    await s.refresh('u', remote)
    expect(LOCAL_READINESS_TTL_MS).toBeLessThan(REMOTE_READINESS_TTL_MS)

    clock += LOCAL_READINESS_TTL_MS
    s.kick([
      { userId: 'u', row: folder },
      { userId: 'u', row: remote }
    ])
    await flush()
    const asked = probe.mock.calls as unknown as Array<[string, AgentRow]>
    expect(asked.map(([, row]) => row.id)).toEqual([
      'folder:a',
      'b',
      'folder:a'
    ])
  })

  it('checks an agent it has never answered for on the first list', async () => {
    const probe = vi.fn(async () => OK)
    const s = service(probe)
    s.kick([{ userId: 'u', row: a2aRow('a') }])
    await flush()
    // No options: a list-time check is never fresh, so it stays on the probes' caches.
    expect(probe).toHaveBeenCalledWith('u', expect.objectContaining({ id: 'a' }), undefined)
  })

  it('never probes a switched-off agent from a list, and forgets its last answer', async () => {
    const probe = vi.fn(async () => DOWN)
    const s = service(probe)
    await s.refresh('u', a2aRow('a'))
    expect(s.peek('a')).toEqual(DOWN)

    clock += REMOTE_READINESS_TTL_MS
    s.kick([{ userId: 'u', row: a2aRow('a', { enabled: false }) }])
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(s.peek('a')).toBeNull()
  })

  it('runs at most a few list-time checks at once', async () => {
    const d = deferredProbe()
    const s = service(d.probe)
    const ids = Array.from({ length: READINESS_CONCURRENCY + 2 }, (_, i) => `a${i}`)
    s.kick(ids.map((id) => ({ userId: 'u', row: a2aRow(id) })))
    await settle()
    expect(d.calls).toEqual(ids.slice(0, READINESS_CONCURRENCY))

    d.resolve('a0', OK)
    await settle()
    expect(d.calls).toEqual(ids.slice(0, READINESS_CONCURRENCY + 1))
  })

  it('starts no list-time check inside the list that kicked it, and one per macrotask after', async () => {
    // A folder agent's check is a synchronous folder scan. Mutation: start the
    // queue inline in `kick` (as first written) fails the first expectation —
    // every scan ran inside the `agent:list` handler before it could answer,
    // back to back with nothing between them to let an IPC message through.
    const d = deferredProbe()
    const s = service(d.probe)
    s.kick([
      { userId: 'u', row: folderRow('folder:a') },
      { userId: 'u', row: folderRow('folder:b') }
    ])
    expect(d.calls).toEqual([])
    await flush()
    expect(d.calls).toEqual(['folder:a'])
    await flush()
    expect(d.calls).toEqual(['folder:a', 'folder:b'])
  })

  it('keeps a check that could not tell as null: it refuses nothing, waits out the TTL, and lifts a refusal', async () => {
    let answer: AgentReadiness | null = DOWN
    const probe = vi.fn(async () => answer)
    const s = service(probe)
    const row = a2aRow('a')
    await s.refresh('u', row)
    expect(broadcasts).toEqual([{ agentId: 'a', readiness: DOWN }])

    // Refused → could not tell: pushed, so the composer lets the send through.
    answer = null
    await s.refresh('u', row)
    expect(s.peek('a')).toBeNull()
    expect(broadcasts).toEqual([
      { agentId: 'a', readiness: DOWN },
      { agentId: 'a', readiness: null }
    ])

    // Null waits out its TTL like `ok`: a slow agent is not re-probed on every
    // list. Mutation: count null as a refusal in `kick` fails this.
    clock += 1
    s.kick([{ userId: 'u', row }])
    await settle()
    expect(probe).toHaveBeenCalledTimes(2)

    // ok → null looks the same on screen: nothing to push.
    answer = OK
    await s.refresh('u', row)
    answer = null
    await s.refresh('u', row)
    expect(broadcasts).toHaveLength(2)
  })

  it('does not queue an agent twice, so a second list cannot spend a slot on it', async () => {
    const d = deferredProbe()
    const s = service(d.probe)
    const ids = Array.from({ length: READINESS_CONCURRENCY + 1 }, (_, i) => `a${i}`)
    const last = ids[READINESS_CONCURRENCY]
    s.kick(ids.map((id) => ({ userId: 'u', row: a2aRow(id) })))
    // A second list while `last` is still waiting for a slot, plus one new agent.
    s.kick([
      { userId: 'u', row: a2aRow(last) },
      { userId: 'u', row: a2aRow('late') }
    ])
    await settle()

    // Two slots free up: one for `last`, one for `late`. A duplicate `last` in
    // the queue would take the second, coalesce into the running check, and
    // leave `late` waiting.
    d.resolve('a0', OK)
    d.resolve('a1', OK)
    await settle()
    expect(d.calls).toContain('late')
    expect(d.calls.filter((id) => id === last)).toHaveLength(1)
  })

  it('survives a driver that throws, keeping the answer it had', async () => {
    let fail = false
    const s = service(async () => {
      if (fail) throw new Error('the driver broke its promise')
      return DOWN
    })
    const row = a2aRow('a')
    await s.refresh('u', row)
    fail = true
    await expect(s.refresh('u', row)).resolves.toEqual(DOWN)
    expect(s.peek('a')).toEqual(DOWN)
  })

  it('answers null when a driver throws on an agent it never answered for', async () => {
    const s = service(async () => {
      throw new Error('boom')
    })
    await expect(s.refresh('u', a2aRow('a'))).resolves.toBeNull()
  })

  it('survives a broadcast that throws', async () => {
    const s = createAgentReadinessService()
    s.install({
      probe: async () => DOWN,
      broadcast: () => {
        throw new Error('the window is gone')
      }
    })
    await expect(s.refresh('u', a2aRow('a'))).resolves.toEqual(DOWN)
  })

  it('does not bring back the answer of an agent forgotten while its check ran', async () => {
    const d = deferredProbe()
    const s = service(d.probe)
    const pending = s.refresh('u', a2aRow('a'))
    s.forget('a')
    d.resolve('a', DOWN)
    await pending
    expect(s.peek('a')).toBeNull()
    expect(broadcasts).toEqual([])
  })
})
