/**
 * One ACP process per agent: started on the turn that needs it, replaced when
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
 * config. The key is a digest precisely because it must be safe to hold in
 * memory and to log; the values behind it include credentials.
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

interface Entry {
  startSignal?: AbortSignal
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
  /** A retire arrived while a turn held the process; stop on the last release. */
  retireOnRelease: boolean
}

export function createAcpProcessPool(deps: AcpProcessPoolDeps): AcpProcessPool {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const idleReapMs = deps.idleReapMs ?? ACP_IDLE_REAP_MS
  const isBusy = deps.isBusy ?? (() => false)
  const lastActivityAt = deps.lastActivityAt ?? (() => undefined)

  const entries = new Map<string, Entry>()
  const listeners = new Set<(agentId: string, state: AcpProcessState) => void>()

  const entryFor = (agentId: string): Entry => {
    const existing = entries.get(agentId)
    if (existing) return existing
    const fresh: Entry = { state: { state: 'stopped' }, holds: 0, retireOnRelease: false }
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
    for (const listener of listeners) {
      try {
        listener(agentId, state)
      } catch (err) {
        logger.warn('process state listener threw', { agentId, error: String(err) })
      }
    }
  }

  const cancelReap = (entry: Entry): void => {
    if (entry.reap === undefined) return
    clearTimer(entry.reap)
    entry.reap = undefined
  }

  const stopNow = async (agentId: string, entry: Entry, why: string): Promise<void> => {
    cancelReap(entry)
    const conn = entry.conn
    entry.conn = undefined
    entry.key = undefined
    entry.retireOnRelease = false
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
      cancelReap(entry)
      logger.warn('an ACP process exited', { agentId, code: exit.code, signal: exit.signal })
      setState(agentId, entry, { state: 'exited', exit, at: now() })
    })
  }

  const acquire = (
    agentId: string,
    spec: AcpLaunchSpec,
    init: InitializeRequest,
    signal?: AbortSignal
  ): Promise<AcpConnection> => {
    const entry = entryFor(agentId)
    cancelReap(entry)
    entry.retireOnRelease = false
    // Concurrent turns on one agent share one start. Only the key decides: two
    // callers asking for the same key want the same process by definition.
    if (entry.starting && entry.startKey === spec.key && !entry.startSignal?.aborted) return entry.starting

    const run = (async (): Promise<AcpConnection> => {
      // A start already in flight for a *different* key still owns the entry;
      // let it finish rather than spawning a second process behind its back.
      if (entry.starting) await entry.starting.catch(() => undefined)

      if (signal?.aborted) throw new Error('The ACP start was canceled.')
      if (entry.conn && (entry.key !== spec.key || !entry.conn.alive)) {
        await stopNow(agentId, entry, entry.key === spec.key ? 'not alive' : 'spec changed')
      }
      if (entry.conn) return entry.conn

      setState(agentId, entry, { state: 'starting' })
      const conn = await (signal ? deps.start(spec, init, { signal }) : deps.start(spec, init))
      if (signal?.aborted) { await conn.dispose(); throw new Error('The ACP start was canceled.') }
      entry.conn = conn
      entry.key = spec.key
      watch(agentId, entry, conn)
      setState(agentId, entry, { state: 'running', pid: conn.pid, since: now() })
      return conn
    })()

    entry.starting = run
    entry.startKey = spec.key
    entry.startSignal = signal
    const done = (): void => {
      if (entry.starting === run) {
        entry.starting = undefined
        entry.startKey = undefined
        entry.startSignal = undefined
      }
    }
    return run.then(
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
  }

  const hold = (agentId: string): (() => void) => {
    const entry = entryFor(agentId)
    entry.holds += 1
    cancelReap(entry)
    let released = false
    return () => {
      if (released) return
      released = true
      entry.holds -= 1
      if (entry.holds > 0) return
      if (entry.retireOnRelease) {
        void stopNow(agentId, entry, 'retired')
        return
      }
      scheduleReap(agentId, entry)
    }
  }

  const retire = (agentId: string): void => {
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
    acquire,
    hold,
    retire,
    held: (agentId) => {
      const entry = entries.get(agentId)
      return !!entry && (entry.holds > 0 || !!entry.starting)
    },
    status: (agentId) => entries.get(agentId)?.state ?? { state: 'stopped' },
    onStatus: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    shutdown: async () => {
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
       * one an unawaited `will-quit` can lose. It is a ~1 s window per agent,
       * and the alternative (refusing to start a process while quitting) needs a
       * quitting flag the pool does not have; noted rather than papered over.
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
