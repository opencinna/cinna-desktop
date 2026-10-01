/**
 * One ACP process per agent or compatible synthetic runtime group: started
 * on the turn that needs it, replaced when
 * what it was started with changed, stopped when nobody has wanted it for a
 * while.
 *
 * ## Why lazily, and why not restarted on its own
 *
 * The spike measured an idle Claude adapter at ~100 MB, ~400 MB once a session
 * has started its `claude` child. A desktop with a dozen folder agents that
 * started every one of them at boot would cost gigabytes to sit still. A cold
 * start is ~200 ms to `initialize` plus ~900 ms to `session/new` — about a
 * second, paid by the turn that asked, which is a price a turn can afford and
 * an idle app cannot.
 *
 * The same reasoning bans a supervisor loop. A process that exited stays exited
 * and shows as `exited` on the agent page; the *next* {@link AcpProcessPool.acquire}
 * starts a fresh one. An agent that crashes on start would otherwise become a
 * respawn loop nobody asked for, burning CPU on a machine whose owner is not
 * even looking at that agent.
 *
 * ## Why the spec key, and why it is a digest
 *
 * A running process froze its binary, its arguments, its environment and any
 * config file it read at start. Change the model or a provider key and the
 * process still holds the old ones — so the launcher summarises all of it into
 * `spec.key`, and a key that moved means the next `acquire` retires the old
 * process before the turn starts rather than running the turn against stale
 * config. Other chats' turns may still be running on it: the acquire waits
 * for them to finish (the process to drain) and then replaces it, rather than
 * killing their turns or failing its own. The key is a digest precisely
 * because it must be safe to hold in memory and to log; the values behind it
 * include credentials.
 *
 * ## Why holds instead of "is a turn running"
 *
 * Reaping is time-based, and a turn can be quiet for minutes — a long Bash
 * tool call, a model thinking, a permission ask parked waiting for the user
 * (an hour, per the ask contract). Idle time is the wrong signal for "in
 * use", so a turn takes a {@link AcpProcessPool.hold} for its whole length and
 * the clock only starts when the last one is released.
 *
 * ## Why the clock and the timers are injected
 *
 * The reap window is two minutes. A test that proved reaping by waiting for it
 * would be two minutes long, so it would not be written, so the reap would
 * ship untested. Injecting the timer makes the same test instant and lets it
 * assert the *delay* against {@link ACP_IDLE_REAP_MS} rather than against a
 * number copied into the test.
 */

import type { InitializeRequest } from '@agentclientprotocol/sdk'
import { createLogger } from '../../../logger/logger'
import {
  ACP_BUSY_REAP_CEILING_MS,
  ACP_IDLE_REAP_MS,
  type AcpConnection,
  type AcpLaunchSpec,
  type AcpProcessPool,
  type AcpProcessState,
  type StartAcpConnection
} from './types'

const logger = createLogger('acp-pool')

/** An opaque handle for whatever `setTimer` returned. */
export type TimerHandle = unknown

export interface AcpProcessPoolDeps {
  /** How a process is started. Production passes `startAcpConnection`. */
  start: StartAcpConnection
  /** Wall clock for `since` / `at`. */
  now?: () => number
  /** Schedules the idle reap. Production uses `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  /** Overrides {@link ACP_IDLE_REAP_MS}. Tests only; production reads the constant. */
  idleReapMs?: number
  /**
   * The agent's process still has work running that no turn holds —
   * background shells, subagents — so an idle reap now would kill it. The reap
   * is rescheduled instead, up to {@link ACP_BUSY_REAP_CEILING_MS}. Default:
   * never busy, which is the reaper as it was.
   */
  isBusy?: (agentId: string) => boolean
  /**
   * When the agent's running work last changed, for the busy ceiling. The
   * ceiling counts from this or from when the process last went idle,
   * whichever is later; absent (or `undefined`) means the latter alone.
   */
  lastActivityAt?: (agentId: string) => number | undefined
}

/**
 * The callers waiting on one start. Concurrent turns of one agent join the
 * same start, so no single caller's Stop may cancel it: each caller leaves on
 * its own abort, and the start is canceled only when the last one has left.
 */
interface StartGroup {
  /** Absent when the start cannot be canceled (a shared runtime, or a first caller with no signal). */
  cancel?: AbortController
  /** Callers still waiting; `Infinity` once one joined that can never leave. */
  waiters: number
  /** The start with its bookkeeping done, which every caller's promise follows. */
  settled: Promise<AcpConnection>
  /** Who of this start's callers still counts as blocked; see {@link Blocked}. */
  blocked: Blocked
}

/**
 * The callers of one start that are still waiting on it, for the drain count.
 *
 * A caller takes its {@link AcpProcessPool.hold} *before* it acquires, so a
 * caller waiting for the live process to drain is itself one of the holds on
 * it. The process is drained when every hold left belongs to such a caller:
 * counting them is what keeps two waiters from waiting on each other. A caller
 * stops counting when it aborts, and all of a start's callers stop counting
 * the moment that start resolves — from then on they are using the process,
 * not waiting for it.
 */
interface Blocked {
  callers: Set<() => void>
  /** The start has resolved; a caller joining now is not blocked. */
  finished: boolean
}

interface Entry {
  startGroup?: StartGroup
  state: AcpProcessState
  /** The live process, if there is one. */
  conn?: AcpConnection
  /** The spec key `conn` was started with. */
  key?: string
  /** The acquire currently in flight, shared by every caller asking for `startKey`. */
  starting?: Promise<AcpConnection>
  startKey?: string
  holds: number
  reap?: TimerHandle
  /** When the last hold was released (or the start finished), for the busy ceiling's fallback. */
  idleSince?: number
  /**
   * A retire arrived while a turn held the process; stop on the last release.
   * A marked live process is never handed to a new caller: it waits for the
   * drain and gets a fresh one.
   */
  retireOnRelease: boolean
  /** Callers blocked inside `acquire` (every start's {@link Blocked} callers). */
  blocked: number
  /** Starts waiting for the live process to drain; woken by anything that may have drained it. */
  drainWaiters: Set<() => void>
}

export function createAcpProcessPool(deps: AcpProcessPoolDeps): AcpProcessPool {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const idleReapMs = deps.idleReapMs ?? ACP_IDLE_REAP_MS
  const entries = new Map<string, Entry>()
  const aliases = new Map<string, string>()
  /** Set by `shutdown`: a start waiting out a drain must not spawn a process the app is quitting past. */
  let closing = false
  const ownerHolds = new Map<string, number>()
  const listeners = new Set<(agentId: string, state: AcpProcessState) => void>()
  const keyFor = (agentId: string): string => aliases.get(agentId) ?? agentId
  const owners = (key: string): string[] => [key, ...[...aliases].filter(([, target]) => target === key).map(([id]) => id)]
  const isBusy = (key: string): boolean => owners(key).some((id) => deps.isBusy?.(id))
  const lastActivityAt = (key: string): number | undefined => {
    const values = owners(key).map((id) => deps.lastActivityAt?.(id)).filter((value): value is number => value !== undefined)
    return values.length > 0 ? Math.max(...values) : undefined
  }

  const notify = (agentId: string, state: AcpProcessState): void => {
    for (const listener of listeners) {
      try { listener(agentId, state) }
      catch (err) { logger.warn('process state listener threw', { agentId, error: String(err) }) }
    }
  }

  const entryFor = (agentId: string): Entry => {
    const existing = entries.get(agentId)
    if (existing) return existing
    const fresh: Entry = { state: { state: 'stopped' }, holds: 0, retireOnRelease: false, blocked: 0, drainWaiters: new Set() }
    entries.set(agentId, fresh)
    return fresh
  }

  /**
   * Every state change reaches the listeners, and a process leaving `running`
   * always goes through here: a crash or a closed stream as `exited` (`watch`),
   * and an idle or busy-ceiling reap, a retire and a shutdown as `stopped`
   * (`stopNow`). A listener that has to write off what that process was doing
   * — the session activity it can no longer report — keys on "left running",
   * and hears each exit once: `watch` stays silent for a process `stopNow`
   * already let go.
   */
  const setState = (agentId: string, entry: Entry, state: AcpProcessState): void => {
    entry.state = state
    for (const owner of owners(agentId)) notify(owner, state)
  }

  const cancelReap = (entry: Entry): void => {
    if (entry.reap === undefined) return
    clearTimer(entry.reap)
    entry.reap = undefined
  }

  /** Something that may have drained the live process happened: every waiting start looks again. */
  const wakeDrain = (entry: Entry): void => {
    const waiters = [...entry.drainWaiters]
    entry.drainWaiters.clear()
    for (const wake of waiters) wake()
  }

  /** Until the next {@link wakeDrain}, or the signal's abort. */
  const nextDrainChange = (entry: Entry, signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const aborted = (): void => {
        entry.drainWaiters.delete(woken)
        reject(new Error('The ACP start was canceled.'))
      }
      const woken = (): void => {
        signal?.removeEventListener('abort', aborted)
        resolve()
      }
      if (signal?.aborted) {
        reject(new Error('The ACP start was canceled.'))
        return
      }
      entry.drainWaiters.add(woken)
      signal?.addEventListener('abort', aborted, { once: true })
    })

  /**
   * Count one caller as blocked on this start until it aborts or the start
   * resolves. A caller with no signal counts until the start resolves.
   */
  const countBlocked = (entry: Entry, blocked: Blocked, signal: AbortSignal | undefined): void => {
    if (blocked.finished || signal?.aborted) return
    const leave = (): void => {
      if (!blocked.callers.delete(leave)) return
      signal?.removeEventListener('abort', leave)
      entry.blocked -= 1
    }
    blocked.callers.add(leave)
    entry.blocked += 1
    signal?.addEventListener('abort', leave, { once: true })
    // One more of the holds is a waiter's: that may be the drain.
    wakeDrain(entry)
  }

  const finishBlocked = (blocked: Blocked): void => {
    blocked.finished = true
    for (const leave of [...blocked.callers]) leave()
  }

  const stopNow = async (agentId: string, entry: Entry, why: string): Promise<void> => {
    cancelReap(entry)
    const conn = entry.conn
    entry.conn = undefined
    entry.key = undefined
    entry.retireOnRelease = false
    // A start waiting for this process to drain has nothing left to wait for.
    wakeDrain(entry)
    if (!conn) return
    logger.info('stopping an ACP process', { agentId, why, pid: conn.pid })
    setState(agentId, entry, { state: 'stopped' })
    try {
      await conn.dispose()
    } catch (err) {
      logger.warn('could not stop an ACP process cleanly', { agentId, error: String(err) })
    }
  }

  const armReap = (agentId: string, entry: Entry): void => {
    cancelReap(entry)
    if (!entry.conn || entry.holds > 0) return
    entry.reap = setTimer(() => {
      entry.reap = undefined
      // A hold taken between the timer firing and this line is rare but real;
      // it wins, and the reap is rescheduled by its release.
      if (entry.holds > 0 || !entry.conn) return
      if (isBusy(agentId)) {
        // No turn holds it, but the process is still doing something the user
        // is waiting for (the background shell that merges the PR). Look again
        // in another window — unless it has been quiet past the ceiling.
        // Quiet means neither its work nor a turn: a user who kept chatting
        // while an old background process ran is measured from their last turn.
        const idleSince = entry.idleSince ?? now()
        const since = Math.max(lastActivityAt(agentId) ?? idleSince, idleSince)
        if (now() - since < ACP_BUSY_REAP_CEILING_MS) {
          logger.debug('an idle ACP process still has work running; reap deferred', { agentId })
          armReap(agentId, entry)
          return
        }
        logger.warn('an ACP process with work running went quiet past the ceiling; stopping it', {
          agentId,
          quietMs: now() - since
        })
        void stopNow(agentId, entry, 'busy past ceiling')
        return
      }
      void stopNow(agentId, entry, 'idle')
    }, idleReapMs)
  }

  const scheduleReap = (agentId: string, entry: Entry): void => {
    entry.idleSince = now()
    armReap(agentId, entry)
  }

  /**
   * Watch a process we just started.
   *
   * The pool never restarts it — the state flips to `exited` and stays there
   * until a turn asks for the agent again — but it must stop *claiming* a dead
   * process, or every following `acquire` would hand back a connection whose
   * pipe is closed.
   */
  const watch = (agentId: string, entry: Entry, conn: AcpConnection): void => {
    void conn.exited.then((exit) => {
      if (entry.conn !== conn) return
      entry.conn = undefined
      entry.key = undefined
      // A retire mark on a live process was aimed at this one, which is gone.
      entry.retireOnRelease = false
      cancelReap(entry)
      logger.warn('an ACP process exited', { agentId, code: exit.code, signal: exit.signal })
      setState(agentId, entry, { state: 'exited', exit, at: now() })
      // A start waiting for it to drain may proceed.
      wakeDrain(entry)
    })
  }

  /**
   * One caller's promise for a start in flight. A caller that aborts gets its
   * rejection at once and leaves; the start itself is canceled only when no
   * caller is left waiting on it. A caller that cannot leave — no signal, or a
   * shared runtime, whose owners race their own signals and are cleaned up by
   * retirement — pins the start for good.
   */
  const join = (entry: Entry, group: StartGroup, signal: AbortSignal | undefined, shared: boolean): Promise<AcpConnection> => {
    // A shared caller cannot leave the start, but it stops counting as a
    // drain waiter on its own abort all the same: its hold is about to go.
    countBlocked(entry, group.blocked, signal)
    if (shared || !signal) {
      group.waiters = Number.POSITIVE_INFINITY
      return group.settled
    }
    group.waiters += 1
    return new Promise<AcpConnection>((resolve, reject) => {
      const aborted = (): void => {
        signal.removeEventListener('abort', aborted)
        reject(new Error('The ACP start was canceled.'))
        group.waiters -= 1
        if (group.waiters === 0) group.cancel?.abort()
      }
      if (signal.aborted) {
        aborted()
        return
      }
      signal.addEventListener('abort', aborted, { once: true })
      group.settled.then(
        (conn) => { signal.removeEventListener('abort', aborted); resolve(conn) },
        (err) => { signal.removeEventListener('abort', aborted); reject(err) }
      )
    })
  }

  const acquire = (
    agentId: string,
    spec: AcpLaunchSpec,
    init: InitializeRequest,
    signal?: AbortSignal
  ): Promise<AcpConnection> => {
    const shared = aliases.has(agentId)
    agentId = keyFor(agentId)
    const entry = entryFor(agentId)
    cancelReap(entry)
    // A retire mark aimed at a process that no longer exists (it exited, or
    // its start failed) must not doom the fresh one this acquire starts. A
    // mark on a live process or a start in flight stands: other turns of this
    // agent may share that process, and it dies after the last release. A new
    // caller is not handed a marked live process; it waits for the drain.
    if (!entry.conn && !entry.starting) entry.retireOnRelease = false
    // Concurrent turns on one agent share one start. Only the key decides: two
    // callers asking for the same key want the same process by definition.
    // A start every caller already left is canceled, and is not joined.
    const current = entry.startGroup
    if (entry.starting && current && entry.startKey === spec.key && !current.cancel?.signal.aborted) {
      return join(entry, current, signal, shared)
    }

    // One chat canceling a shared startup cannot cancel another chat's
    // process: a shared start gets no cancel at all. Its caller races its own
    // signal; retirement handles the case where every owner leaves before
    // initialization finishes.
    const cancel = signal && !shared ? new AbortController() : undefined
    // A caller that already stopped never spawns anything.
    if (signal?.aborted) cancel?.abort()
    const startSignal = cancel?.signal
    const blocked: Blocked = { callers: new Set(), finished: false }
    const run = (async (): Promise<AcpConnection> => {
      try {
        // A start already in flight for a *different* key still owns the entry;
        // let it finish rather than spawning a second process behind its back.
        if (entry.starting) await entry.starting.catch(() => undefined)

        if ((shared ? signal : startSignal)?.aborted) throw new Error('The ACP start was canceled.')
        // The live process cannot serve this start — its key moved, or a retire
        // marked it — but other turns may still be using it. One process per
        // agent: wait for it to drain (every hold left is a caller blocked in
        // here), then replace it. A dead one is replaced at once. The wait ends
        // early when every caller of this start has left (`startSignal`); a
        // shared start has no such signal, and its callers race their own.
        while (entry.conn && (entry.key !== spec.key || entry.retireOnRelease || !entry.conn.alive)) {
          if (entry.conn.alive && entry.holds > entry.blocked) {
            await nextDrainChange(entry, startSignal)
            continue
          }
          await stopNow(agentId, entry, !entry.conn.alive ? 'not alive' : entry.key !== spec.key ? 'spec changed' : 'retired')
        }
        if (startSignal?.aborted || closing) throw new Error('The ACP start was canceled.')
        if (entry.conn) return entry.conn

        setState(agentId, entry, { state: 'starting' })
        const conn = await (startSignal ? deps.start(spec, init, { signal: startSignal }) : deps.start(spec, init))
        if (startSignal?.aborted) { await conn.dispose(); throw new Error('The ACP start was canceled.') }
        entry.conn = conn
        entry.key = spec.key
        watch(agentId, entry, conn)
        setState(agentId, entry, { state: 'running', pid: conn.pid, since: now() })
        return conn
      } finally {
        // Its callers are using the process now (or have their failure): none
        // of their holds is a waiter's any more. Before the next start in the
        // chain looks at the count.
        finishBlocked(blocked)
      }
    })()

    const done = (): void => {
      if (entry.starting === run) {
        entry.starting = undefined
        entry.startKey = undefined
        entry.startGroup = undefined
      }
    }
    const settled = run.then(
      (conn) => {
        done()
        // A retire (or a shutdown) that landed while this was starting has
        // nothing to kill yet; it leaves its mark here instead, and this is
        // where the process it was aimed at finally arrives.
        if (entry.retireOnRelease && entry.holds === 0) void stopNow(agentId, entry, 'retired')
        else if (entry.holds === 0) scheduleReap(agentId, entry)
        return conn
      },
      (err) => {
        done()
        if (!entry.conn) setState(agentId, entry, { state: 'stopped' })
        throw err
      }
    )
    // Every caller may have left before it settles; its failure is theirs, not unhandled.
    settled.catch(() => undefined)
    const group: StartGroup = { cancel, waiters: 0, settled, blocked }
    entry.starting = run
    entry.startKey = spec.key
    entry.startGroup = group
    return join(entry, group, signal, shared)
  }

  const hold = (agentId: string): (() => void) => {
    const ownerId = agentId
    agentId = keyFor(agentId)
    const entry = entryFor(agentId)
    ownerHolds.set(ownerId, (ownerHolds.get(ownerId) ?? 0) + 1)
    entry.holds += 1
    cancelReap(entry)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (ownerHolds.get(ownerId) ?? 1) - 1
      if (remaining > 0) ownerHolds.set(ownerId, remaining)
      else ownerHolds.delete(ownerId)
      entry.holds -= 1
      // The holds left may all be callers waiting for this process to drain.
      wakeDrain(entry)
      if (entry.holds > 0) return
      if (entry.retireOnRelease) {
        void stopNow(agentId, entry, 'retired')
        return
      }
      scheduleReap(agentId, entry)
    }
  }

  const retire = (agentId: string): void => {
    const sharedKey = aliases.get(agentId)
    if (sharedKey) {
      aliases.delete(agentId)
      notify(agentId, { state: 'stopped' })
      // Detach this logical owner. Its captured hold still releases the right
      // entry, but other chat owners keep their process and session bindings.
      if (owners(sharedKey).length > 1) return
      agentId = sharedKey
    }
    const entry = entries.get(agentId)
    if (!entry) return
    if (entry.holds > 0 || entry.starting) {
      // Killing a process mid-turn would fail the turn. The turn is short; the
      // stale config it is running under is the one it started with anyway. A
      // start in flight is the same problem seen earlier: there is no process
      // to signal yet, and one will exist a moment from now.
      entry.retireOnRelease = true
      return
    }
    void stopNow(agentId, entry, 'retired')
  }

  return {
    share: (agentId, poolKey) => {
      if (keyFor(agentId) === poolKey) return
      if ((ownerHolds.get(agentId) ?? 0) > 0) throw new Error('Cannot change a chat runtime while its turn is running')
      if (aliases.has(agentId)) retire(agentId)
      else if (entries.has(agentId)) retire(agentId)
      aliases.set(agentId, poolKey)
      const entry = entries.get(poolKey)
      if (entry) notify(agentId, entry.state)
    },
    hasOtherOwners: (agentId, ownHolds) => {
      const key = keyFor(agentId)
      const entry = entries.get(key)
      // `ownHolds` is what the caller itself holds: every other hold — another
      // alias's, or a sibling turn's of this very agent — is another owner.
      return owners(key).some((id) => id !== key && id !== agentId) || (entry?.holds ?? 0) > (ownHolds ?? ownerHolds.get(agentId) ?? 0)
    },
    peek: (agentId, specKey) => {
      const entry = entries.get(keyFor(agentId))
      return entry?.key === specKey && entry.conn?.alive && !entry.retireOnRelease ? entry.conn : undefined
    },
    acquire,
    hold,
    retire,
    held: (agentId) => {
      const entry = entries.get(keyFor(agentId))
      return !!entry && ((ownerHolds.get(agentId) ?? 0) > 0 || !!entry.starting)
    },
    status: (agentId) => entries.get(keyFor(agentId))?.state ?? { state: 'stopped' },
    onStatus: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    shutdown: async () => {
      closing = true
      /**
       * **Every live process is killed before the first await, and the reason is
       * that nobody awaits this.**
       *
       * The one caller is Electron's `will-quit`, which does not await its
       * handlers — so anything this function does *after* yielding may simply
       * not happen. A single pass that waited on each in-flight start before
       * killing anything therefore left every already-running agent alive too:
       * the loop yielded on the first entry and the app was gone.
       *
       * So the running ones go first, synchronously: `dispose()` reaches
       * `killTree` before its own first await, which is what makes an unawaited
       * call enough for them.
       */
      const running = [...entries.entries()].filter(([, entry]) => entry.conn !== undefined)
      const disposed = running.map(([agentId, entry]) => {
        entry.holds = 0
        entry.retireOnRelease = true
        return stopNow(agentId, entry, 'shutdown')
      })

      /**
       * Then the starts in flight, which cannot be killed because there is
       * nothing to kill yet.
       *
       * A process that finishes starting after the app is gone is an orphan
       * holding a session open, so they are waited out — and this half is the
       * one an unawaited `will-quit` can lose. It is a ~1 s window per agent.
       * `closing` keeps it from growing: a start still waiting out a drain
       * refuses here, so only starts already spawning are left to wait out.
       */
      const starting = [...entries.entries()]
        .filter(([, entry]) => entry.starting !== undefined)
        .map(async ([agentId, entry]) => {
          entry.holds = 0
          entry.retireOnRelease = true
          await entry.starting?.catch(() => undefined)
          await stopNow(agentId, entry, 'shutdown')
        })

      await Promise.all([...disposed, ...starting])
    }
  }
}
