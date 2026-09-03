/**
 * The per-agent turn lock.
 *
 * Invariant 3 says the desktop never writes into an agent folder while a turn
 * is streaming. Three parties need to agree on that: the runner (Phase 6) holds
 * the lock for the length of a turn, the page editors refuse to save while it
 * is held, and the folder watcher defers its rescan until it is released.
 *
 * In-memory and process-local on purpose — it coordinates this process with
 * itself, nothing more. A coding assistant editing the same folder from a
 * terminal is *not* covered by it; that is what the modified-underneath stamp
 * in `manifestIo.writeIfUnchanged` is for. The two guards are complementary.
 *
 * Every acquisition has an explicit release path: {@link TurnLock.withLock}
 * releases in a `finally`, and the handle {@link TurnLock.acquire} returns
 * releases idempotently, so a double release (error path plus cleanup path)
 * cannot free a lock someone else has since taken.
 */

import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'

const logger = createLogger('local-agent-lock')

interface HeldLock {
  /** Who took it — `'turn'`, `'editor'`, … Logged, never shown to the user. */
  owner: string
  acquiredAt: number
  /** Monotonic token so a stale handle cannot release a newer lock. */
  token: number
}

export interface TurnLockHandle {
  /** Release the lock. Safe to call more than once. */
  release(): void
}

const held = new Map<string, HeldLock>()
const releaseWaiters = new Map<string, Array<() => void>>()
let nextToken = 1

function fireWaiters(agentId: string): void {
  const waiters = releaseWaiters.get(agentId)
  if (!waiters || waiters.length === 0) return
  releaseWaiters.delete(agentId)
  for (const waiter of waiters) {
    try {
      waiter()
    } catch (err) {
      // A waiter is a rescan; one that throws must not strand the others.
      logger.error('a lock-release waiter failed', { agentId, error: err })
    }
  }
}

export const turnLock = {
  /** True while a turn (or an editor write) holds this agent. */
  isLocked(agentId: string): boolean {
    return held.has(agentId)
  },

  /**
   * Take the lock, or refuse. Never queues: a save that arrives mid-turn should
   * tell the user "the agent is running", not silently land seconds later.
   *
   * @throws LocalAgentError `turn_in_progress`
   */
  acquire(agentId: string, owner: string): TurnLockHandle {
    const existing = held.get(agentId)
    if (existing) {
      throw new LocalAgentError(
        'turn_in_progress',
        'This agent is busy right now. Try again when the current run finishes.',
        `held by ${existing.owner} for ${Date.now() - existing.acquiredAt}ms`
      )
    }
    const token = nextToken++
    held.set(agentId, { owner, acquiredAt: Date.now(), token })
    logger.debug('turn lock acquired', { agentId, owner })

    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        const current = held.get(agentId)
        // Only release what this handle actually took.
        if (current && current.token === token) {
          held.delete(agentId)
          logger.debug('turn lock released', { agentId, owner, heldMs: Date.now() - current.acquiredAt })
          fireWaiters(agentId)
        }
      }
    }
  },

  /** Run `fn` under the lock, releasing it however `fn` ends. */
  async withLock<T>(agentId: string, owner: string, fn: () => Promise<T> | T): Promise<T> {
    const handle = this.acquire(agentId, owner)
    try {
      return await fn()
    } finally {
      handle.release()
    }
  },

  /**
   * True while **any** agent is held.
   *
   * For the one guard whose blast radius is not a single agent: the local
   * engine is one process shared by every folder agent, so restarting it to
   * pick up a new config would end every conversation in flight, not just the
   * one whose folder changed. `isLocked` cannot answer that question — a
   * per-agent check would happily restart the engine out from under a turn
   * running in a different folder.
   */
  anyHeld(): boolean {
    return held.size > 0
  },

  /**
   * Call `fn` once the agent is free — immediately when it already is. Used by
   * the watcher to defer a rescan it must not run mid-turn.
   */
  whenFree(agentId: string, fn: () => void): void {
    if (!held.has(agentId)) {
      fn()
      return
    }
    const waiters = releaseWaiters.get(agentId) ?? []
    waiters.push(fn)
    releaseWaiters.set(agentId, waiters)
  },

  /**
   * Drop everything. Only for shutdown and tests — a lock outliving the thing
   * that took it would block every later write for the life of the process.
   */
  releaseAll(): void {
    const ids = [...held.keys()]
    held.clear()
    for (const agentId of ids) fireWaiters(agentId)
    releaseWaiters.clear()
  }
}
