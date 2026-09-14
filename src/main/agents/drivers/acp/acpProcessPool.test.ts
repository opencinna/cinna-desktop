/**
 * The pool, with the process replaced by a stub.
 *
 * The pool's job is bookkeeping — one process per agent, who is holding it,
 * whether what it was started with still matches, when it may be reaped — and
 * none of that needs a real child. `acpConnection.test.ts` owns the process
 * facts; here `start` is a stub, and the clock and the timers are injected so
 * the five-minute reap can be proven in a millisecond and asserted against
 * `ACP_IDLE_REAP_MS` rather than against a number copied into the test.
 */
import { describe, expect, it, vi } from 'vitest'
import type { InitializeRequest, InitializeResponse } from '@agentclientprotocol/sdk'
import { createAcpProcessPool, type TimerHandle } from './acpProcessPool'
import {
  ACP_IDLE_REAP_MS,
  ACP_PROTOCOL_VERSION,
  type AcpConnection,
  type AcpExit,
  type AcpLaunchSpec,
  type StartAcpConnection
} from './types'

const INIT: InitializeRequest = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} }
const INITIALIZED: InitializeResponse = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }

function spec(key: string): AcpLaunchSpec {
  return { command: '/bin/agent', args: [], env: {}, cwd: '/tmp', key }
}

interface StubConnection extends AcpConnection {
  disposals: number
  /** Make the process exit on its own, as a crash does. */
  die(exit?: Partial<AcpExit>): void
}

function stubConnection(pid: number): StubConnection {
  let settle!: (exit: AcpExit) => void
  const exited = new Promise<AcpExit>((resolve) => {
    settle = resolve
  })
  const stub: StubConnection = {
    pid,
    initialized: INITIALIZED,
    alive: true,
    exited,
    disposals: 0,
    newSession: async () => ({ sessionId: 'ses' }),
    loadSession: async () => ({}),
    setSessionMode: async () => ({}),
    setSessionConfigOption: async () => ({ configOptions: [] }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    cancel: async () => undefined,
    steer: async () => ({ outcome: 'promptRequired' }),
    bindSession: () => () => undefined,
    stderrTail: () => '',
    dispose: async () => {
      stub.disposals += 1
      ;(stub as { alive: boolean }).alive = false
      settle({ code: null, signal: 'SIGTERM', stderrTail: '' })
    },
    die: (exit) => {
      ;(stub as { alive: boolean }).alive = false
      settle({ code: 1, signal: null, stderrTail: '', ...exit })
    }
  }
  return stub
}

/** A `setTimer` that never fires on its own, so a test decides when time passes. */
function fakeTimers(): {
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (handle: TimerHandle) => void
  pending: { fn: () => void; ms: number; cleared: boolean }[]
  fire(): void
} {
  const pending: { fn: () => void; ms: number; cleared: boolean }[] = []
  return {
    pending,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cleared: false }
      pending.push(entry)
      return entry
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    fire: () => {
      const live = pending.filter((entry) => !entry.cleared)
      for (const entry of live) {
        entry.cleared = true
        entry.fn()
      }
    }
  }
}

function poolWith(
  connections: StubConnection[],
  extra: { start?: StartAcpConnection } = {}
): {
  pool: ReturnType<typeof createAcpProcessPool>
  timers: ReturnType<typeof fakeTimers>
  start: ReturnType<typeof vi.fn>
} {
  const timers = fakeTimers()
  let next = 0
  const start = vi.fn(async () => connections[next++] ?? stubConnection(900 + next))
  const pool = createAcpProcessPool({
    start: (extra.start ?? start) as StartAcpConnection,
    now: () => 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })
  return { pool, timers, start }
}

describe('createAcpProcessPool', () => {
  it('starts nothing until a turn asks, then reports the running process', async () => {
    const conn = stubConnection(101)
    const { pool, start } = poolWith([conn])

    expect(pool.status('a')).toEqual({ state: 'stopped' })
    expect(start).not.toHaveBeenCalled()

    const acquired = await pool.acquire('a', spec('k1'), INIT)

    expect(acquired).toBe(conn)
    expect(pool.status('a')).toEqual({ state: 'running', pid: 101, since: 1_000 })
  })

  it('hands the same process to the next turn while the spec key holds', async () => {
    const { pool, start } = poolWith([stubConnection(1), stubConnection(2)])

    const first = await pool.acquire('a', spec('k1'), INIT)
    const second = await pool.acquire('a', spec('k1'), INIT)

    expect(second).toBe(first)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('shares one start between concurrent turns on one agent', async () => {
    const conn = stubConnection(1)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = vi.fn(async () => {
      await gate
      return conn
    })
    const { pool } = poolWith([], { start: start as unknown as StartAcpConnection })

    const both = Promise.all([
      pool.acquire('a', spec('k1'), INIT),
      pool.acquire('a', spec('k1'), INIT)
    ])
    expect(pool.status('a')).toEqual({ state: 'starting' })
    release()

    expect(await both).toEqual([conn, conn])
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('keeps one process per agent', async () => {
    const [one, two] = [stubConnection(1), stubConnection(2)]
    const { pool, start } = poolWith([one, two])

    expect(await pool.acquire('a', spec('k1'), INIT)).toBe(one)
    expect(await pool.acquire('b', spec('k1'), INIT)).toBe(two)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('retires and replaces a process whose spec key moved', async () => {
    const [one, two] = [stubConnection(1), stubConnection(2)]
    const { pool } = poolWith([one, two])

    await pool.acquire('a', spec('k1'), INIT)
    const replacement = await pool.acquire('a', spec('k2'), INIT)

    expect(replacement).toBe(two)
    expect(one.disposals).toBe(1)
    expect(pool.status('a')).toEqual({ state: 'running', pid: 2, since: 1_000 })
  })

  it('replaces a process that is no longer alive, key or no key', async () => {
    const [one, two] = [stubConnection(1), stubConnection(2)]
    const { pool } = poolWith([one, two])

    await pool.acquire('a', spec('k1'), INIT)
    one.die()
    await Promise.resolve()

    expect(await pool.acquire('a', spec('k1'), INIT)).toBe(two)
  })

  it('does not restart an exited process on its own, and says so', async () => {
    const [one, two] = [stubConnection(1), stubConnection(2)]
    const { pool, start } = poolWith([one, two])

    await pool.acquire('a', spec('k1'), INIT)
    one.die({ code: 9 })
    await one.exited

    expect(pool.status('a')).toEqual({
      state: 'exited',
      exit: { code: 9, signal: null, stderrTail: '' },
      at: 1_000
    })
    expect(start).toHaveBeenCalledTimes(1)

    await pool.acquire('a', spec('k1'), INIT)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('reaps an idle process after exactly the idle window', async () => {
    const conn = stubConnection(1)
    const { pool, timers } = poolWith([conn])

    await pool.acquire('a', spec('k1'), INIT)
    const reap = timers.pending.find((entry) => !entry.cleared)

    expect(reap?.ms).toBe(ACP_IDLE_REAP_MS)
    timers.fire()

    expect(conn.disposals).toBe(1)
    expect(pool.status('a')).toEqual({ state: 'stopped' })
  })

  it('does not reap while a turn holds the process', async () => {
    const conn = stubConnection(1)
    const { pool, timers } = poolWith([conn])

    await pool.acquire('a', spec('k1'), INIT)
    const release = pool.hold('a')
    timers.fire()

    expect(conn.disposals).toBe(0)
    expect(pool.status('a')).toEqual({ state: 'running', pid: 1, since: 1_000 })

    release()
    timers.fire()
    expect(conn.disposals).toBe(1)
  })

  it('waits for the last hold before the clock starts', async () => {
    const conn = stubConnection(1)
    const { pool, timers } = poolWith([conn])

    await pool.acquire('a', spec('k1'), INIT)
    const first = pool.hold('a')
    const second = pool.hold('a')

    first()
    timers.fire()
    expect(conn.disposals).toBe(0)

    second()
    timers.fire()
    expect(conn.disposals).toBe(1)
  })

  it('ignores a release that runs twice', async () => {
    const conn = stubConnection(1)
    const { pool, timers } = poolWith([conn])

    await pool.acquire('a', spec('k1'), INIT)
    const first = pool.hold('a')
    const second = pool.hold('a')
    first()
    first()

    timers.fire()
    expect(conn.disposals).toBe(0)
    second()
  })

  it('cancels a pending reap when the next turn acquires', async () => {
    const conn = stubConnection(1)
    const { pool, timers } = poolWith([conn])

    await pool.acquire('a', spec('k1'), INIT)
    await pool.acquire('a', spec('k1'), INIT)

    // One armed timer, not two: a stale one left behind by the first acquire
    // would fire in the middle of a later turn and take its process away.
    expect(timers.pending.filter((entry) => !entry.cleared)).toHaveLength(1)
    timers.fire()
    expect(conn.disposals).toBe(1)
  })

  it('lets an in-flight start finish before replacing it for a moved key', async () => {
    const [one, two] = [stubConnection(1), stubConnection(2)]
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let call = 0
    const start = vi.fn(async () => {
      if (call++ === 0) {
        await gate
        return one
      }
      return two
    })
    const { pool } = poolWith([], { start: start as unknown as StartAcpConnection })

    const first = pool.acquire('a', spec('k1'), INIT)
    const second = pool.acquire('a', spec('k2'), INIT)
    release()

    expect(await first).toBe(one)
    expect(await second).toBe(two)
    // The first process is not leaked: the second acquire owns retiring it.
    expect(one.disposals).toBe(1)
    expect(pool.status('a')).toEqual({ state: 'running', pid: 2, since: 1_000 })
  })

  it('stops a retired process at once when nothing holds it', async () => {
    const conn = stubConnection(1)
    const { pool } = poolWith([conn])

    await pool.acquire('a', spec('k1'), INIT)
    pool.retire('a')
    await Promise.resolve()

    expect(conn.disposals).toBe(1)
    expect(pool.status('a')).toEqual({ state: 'stopped' })
  })

  it('defers a retire that lands mid-turn to the last release', async () => {
    const conn = stubConnection(1)
    const { pool } = poolWith([conn])

    await pool.acquire('a', spec('k1'), INIT)
    const release = pool.hold('a')
    pool.retire('a')

    expect(conn.disposals).toBe(0)

    release()
    await Promise.resolve()
    expect(conn.disposals).toBe(1)
  })

  it('stops a process that was still starting when it was retired', async () => {
    const conn = stubConnection(1)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = vi.fn(async () => {
      await gate
      return conn
    })
    const { pool } = poolWith([], { start: start as unknown as StartAcpConnection })

    const acquiring = pool.acquire('a', spec('k1'), INIT)
    pool.retire('a')
    release()
    await acquiring
    await Promise.resolve()

    expect(conn.disposals).toBe(1)
    expect(pool.status('a')).toEqual({ state: 'stopped' })
  })

  it('waits out a start in flight before declaring shutdown done', async () => {
    const conn = stubConnection(1)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = vi.fn(async () => {
      await gate
      return conn
    })
    const { pool } = poolWith([], { start: start as unknown as StartAcpConnection })

    const acquiring = pool.acquire('a', spec('k1'), INIT)
    const done = pool.shutdown()
    release()
    await acquiring
    await done

    // Nothing survives quit: a process that finished starting after the window
    // closed would otherwise hold a session open with nobody to stop it.
    expect(conn.disposals).toBe(1)
  })

  it('retiring an agent nobody ever started is a no-op', () => {
    const { pool } = poolWith([])
    expect(() => pool.retire('never')).not.toThrow()
    expect(pool.status('never')).toEqual({ state: 'stopped' })
  })

  it('reports every state change until the listener unsubscribes', async () => {
    const conn = stubConnection(1)
    const { pool } = poolWith([conn])
    const seen: string[] = []
    const off = pool.onStatus((agentId, state) => seen.push(`${agentId}:${state.state}`))

    await pool.acquire('a', spec('k1'), INIT)
    off()
    pool.retire('a')
    await Promise.resolve()

    expect(seen).toEqual(['a:starting', 'a:running'])
  })

  it('kills a running process before it yields, because nobody awaits shutdown', async () => {
    // Electron does not await a `will-quit` handler, so **anything `shutdown`
    // does after its first await may simply not happen** — and that makes the
    // ordering inside it a property worth pinning rather than a style. A start
    // in flight has nothing to kill yet and has to be waited out; a process
    // that is already running does not, and must not end up behind that wait.
    //
    // This holds today whichever way the two passes are written, because
    // `stopNow` reaches `killTree` before its own first await. What it guards
    // is the edit that puts an await in front of the kill.
    const running = stubConnection(1)
    let stuck = false
    const { pool } = poolWith([running], {
      start: (async (spec) => {
        if (spec.key === 'never') {
          stuck = true
          return new Promise<never>(() => {})
        }
        return running
      }) as unknown as StartAcpConnection
    })

    await pool.acquire('a', spec('k1'), INIT)
    void pool.acquire('b', spec('never'), INIT)
    expect(stuck).toBe(true)

    // No await between the call and the assertion: the kill has to have already
    // happened by the time `shutdown` first yields.
    void pool.shutdown()
    expect(running.disposals).toBe(1)
  })

  it('leaves nothing running after shutdown', async () => {
    const [one, two] = [stubConnection(1), stubConnection(2)]
    const { pool } = poolWith([one, two])

    await pool.acquire('a', spec('k1'), INIT)
    await pool.acquire('b', spec('k1'), INIT)
    pool.hold('a')
    await pool.shutdown()

    expect([one.disposals, two.disposals]).toEqual([1, 1])
    expect(pool.status('a')).toEqual({ state: 'stopped' })
    expect(pool.status('b')).toEqual({ state: 'stopped' })
  })

  it('reports a failed start as stopped, and lets the next turn try again', async () => {
    const conn = stubConnection(1)
    const start = vi
      .fn<StartAcpConnection>()
      .mockRejectedValueOnce(new Error('/bin/agent exited (code 1) before answering initialize'))
      .mockResolvedValueOnce(conn)
    const { pool } = poolWith([], { start })

    await expect(pool.acquire('a', spec('k1'), INIT)).rejects.toThrow(/before answering initialize/)
    expect(pool.status('a')).toEqual({ state: 'stopped' })

    expect(await pool.acquire('a', spec('k1'), INIT)).toBe(conn)
  })
})
