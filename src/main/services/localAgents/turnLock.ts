/**
 * The per-agent turn lock — a readers-writer lock.
 *
 * Invariant 3 says the desktop never writes into an agent folder while a turn
 * is streaming. Three parties need to agree on that: the runner holds the lock
 * for the length of a turn, the page editors refuse to save while it is held,
 * and the folder watcher defers its rescan until it is released.
 *
 * **Turns share; the desktop's own writes are exclusive.** Model turns and
 * `/run:` commands take a *shared* hold ({@link TurnLock.acquireShared}), so
 * any number of them run on one agent at once — different chats, scheduled
 * jobs, task runs, delegations. What they may do to the folder between them is
 * the user's business (worktrees and the like). The desktop's own folder
 * writes — the page editors, credential materialization, the credential
 * helper, deleting the agent — take an *exclusive* hold
 * ({@link TurnLock.acquire}), which is refused while any holder exists, and
 * every shared acquisition is refused while an exclusive one is held — except
 * that {@link TurnLock.withSharedLock} waits a few seconds out a `credentials`
 * write, which is short and may be a background auto-attach the user never saw.
 *
 * **Reader preference.** A queued exclusive waiter is admitted only when no
 * holder at all remains; a steady stream of overlapping turns can therefore
 * keep it waiting indefinitely. Accepted: the exclusive owners are short
 * desktop housekeeping, and turns are bounded by their ceiling.
 *
 * In-memory and process-local on purpose — it coordinates this process with
 * itself, nothing more. A coding assistant editing the same folder from a
 * terminal is *not* covered by it; that is what the modified-underneath stamp
 * in `manifestIo.writeIfUnchanged` is for. The two guards are complementary.
 *
 * Every acquisition has an explicit release path: {@link TurnLock.withLock}
 * releases in a `finally`, and the handle {@link TurnLock.acquire} returns
 * releases idempotently and only its own hold, so a double release (error path
 * plus cleanup path) cannot free a hold someone else has since taken.
 */

import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'

const logger = createLogger('local-agent-lock')

type LockMode = 'shared' | 'exclusive'

interface HeldLock {
  /** Who took it — `'turn'`, `'editor'`, … Logged, never shown to the user. */
  owner: string
  acquiredAt: number
  mode: LockMode
}

export interface TurnLockHandle {
  /** Release the lock. Safe to call more than once. */
  release(): void
}

/** Per agent, every current holder by its monotonic token. An agent with no holder has no entry. */
const held = new Map<string, Map<number, HeldLock>>()
/** Called when an agent's last holder leaves: `whenFree` callbacks and queued acquisitions. */
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

function exclusiveHolder(agentId: string): HeldLock | undefined {
  for (const lock of held.get(agentId)?.values() ?? []) if (lock.mode === 'exclusive') return lock
  return undefined
}

/** Whether a `mode` acquisition must wait (or be refused) right now, and whom it would wait for. */
function blocker(agentId: string, mode: LockMode): HeldLock | undefined {
  if (mode === 'shared') return exclusiveHolder(agentId)
  const holders = held.get(agentId)
  return holders ? holders.values().next().value : undefined
}

function take(agentId: string, owner: string, mode: LockMode): TurnLockHandle {
  const existing = blocker(agentId, mode)
  if (existing) {
    throw new LocalAgentError(
      'turn_in_progress',
      'This agent is busy right now. Try again when the current run finishes.',
      `held by ${existing.owner} for ${Date.now() - existing.acquiredAt}ms`
    )
  }
  const token = nextToken++
  const holders = held.get(agentId) ?? new Map<number, HeldLock>()
  holders.set(token, { owner, acquiredAt: Date.now(), mode })
  held.set(agentId, holders)
  logger.debug('turn lock acquired', { agentId, owner, mode })

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      const current = held.get(agentId)
      const mine = current?.get(token)
      // Only release what this handle actually took.
      if (!current || !mine) return
      current.delete(token)
      logger.debug('turn lock released', { agentId, owner, mode, heldMs: Date.now() - mine.acquiredAt })
      if (current.size > 0) return
      held.delete(agentId)
      fireWaiters(agentId)
    }
  }
}

async function withQueued<T>(agentId: string, owner: string, mode: LockMode, signal: AbortSignal, fn: () => Promise<T> | T): Promise<T> {
  const handle = await new Promise<TurnLockHandle>((resolve, reject) => {
    const remove = (): void => {
      signal.removeEventListener('abort', abort)
      const waiters = releaseWaiters.get(agentId)?.filter((waiter) => waiter !== acquire)
      if (waiters?.length) releaseWaiters.set(agentId, waiters)
      else releaseWaiters.delete(agentId)
    }
    const abort = (): void => { remove(); reject(new Error('The task was stopped while waiting for its agent.')) }
    const acquire = (): void => {
      if (signal.aborted) { abort(); return }
      if (blocker(agentId, mode)) {
        const waiters = releaseWaiters.get(agentId) ?? []
        waiters.push(acquire)
        releaseWaiters.set(agentId, waiters)
        return
      }
      remove()
      resolve(take(agentId, owner, mode))
    }
    signal.addEventListener('abort', abort, { once: true })
    acquire()
  })
  try {
    if (signal.aborted) throw new Error('The task was stopped.')
    return await fn()
  } finally { handle.release() }
}

/**
 * Exclusive owners a turn's shared hold waits out, briefly, instead of refusing:
 * a credential write (`writeAttachments`, a materialization) holds the agent for
 * well under a second, and the background auto-attach after a pinned-skill fetch
 * can land on the very moment the user sends. Every other exclusive owner — the
 * page editors, sharing verbs, deleting the agent — keeps refusing at once.
 *
 * Known limit: a `credentials` hold is usually a short local write, but
 * `writeAttachments` (`serviceCredentials/service.ts`) can materialize a newly
 * attached record with a network fetch to cinna-core under the lock. On a slow
 * core the turn then waits the full {@link BRIEF_EXCLUSIVE_WAIT_MS} and is
 * refused as before. Moving that fetch outside the lock is a possible follow-up.
 */
const BRIEF_EXCLUSIVE_OWNERS: ReadonlySet<string> = new Set(['credentials'])
/** The longest a shared hold waits for brief exclusive holders before refusing as before. */
export const BRIEF_EXCLUSIVE_WAIT_MS = 3000

/** What a turn stopped during the wait (or before its body) rejects with; the caller maps it to its canceled ending. */
const STOPPED_WHILE_WAITING = 'The turn was stopped while waiting for its agent.'

/**
 * A shared hold now, or after the brief exclusive holders ahead of it are gone
 * (bounded by {@link BRIEF_EXCLUSIVE_WAIT_MS}). Refuses as {@link take} does
 * when the holder is not brief, or the wait runs out. An abort of `signal`
 * ends the wait at once, removing its waiter, and rejects.
 */
async function takeSharedWaitingOutBrief(agentId: string, owner: string, signal?: AbortSignal): Promise<TurnLockHandle> {
  const deadline = Date.now() + BRIEF_EXCLUSIVE_WAIT_MS
  for (;;) {
    if (signal?.aborted) throw new Error(STOPPED_WHILE_WAITING)
    const existing = blocker(agentId, 'shared')
    const left = deadline - Date.now()
    if (!existing || !BRIEF_EXCLUSIVE_OWNERS.has(existing.owner) || left <= 0) return take(agentId, owner, 'shared')
    await new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        const waiters = releaseWaiters.get(agentId)?.filter((waiter) => waiter !== wake)
        if (waiters?.length) releaseWaiters.set(agentId, waiters)
        else releaseWaiters.delete(agentId)
      }
      const wake = (): void => { settle(); resolve() }
      const abort = (): void => { settle(); reject(new Error(STOPPED_WHILE_WAITING)) }
      const timer = setTimeout(() => { settle(); resolve() }, left)
      const waiters = releaseWaiters.get(agentId) ?? []
      waiters.push(wake)
      releaseWaiters.set(agentId, waiters)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

async function withHeld<T>(handle: TurnLockHandle, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } finally {
    handle.release()
  }
}

export const turnLock = {
  /** True while anything — a turn, a command, an editor write — holds this agent. */
  isLocked(agentId: string): boolean {
    return held.has(agentId)
  },

  /** True while an exclusive holder (the desktop's own folder write) holds this agent. */
  isExclusivelyLocked(agentId: string): boolean {
    return exclusiveHolder(agentId) !== undefined
  },

  /**
   * Take the lock exclusively, or refuse — while any holder, shared or
   * exclusive, exists. Never queues: a save that arrives mid-turn should tell
   * the user "the agent is running", not silently land seconds later.
   *
   * @throws LocalAgentError `turn_in_progress`
   */
  acquire(agentId: string, owner: string): TurnLockHandle {
    return take(agentId, owner, 'exclusive')
  },

  /**
   * Take a shared hold, or refuse while an exclusive holder exists. Any number
   * of shared holders coexist: this is what a turn or a command takes.
   *
   * @throws LocalAgentError `turn_in_progress`
   */
  acquireShared(agentId: string, owner: string): TurnLockHandle {
    return take(agentId, owner, 'shared')
  },

  /** Run `fn` under the exclusive lock, releasing it however `fn` ends. */
  async withLock<T>(agentId: string, owner: string, fn: () => Promise<T> | T): Promise<T> {
    return withHeld(take(agentId, owner, 'exclusive'), fn)
  },

  /**
   * Run `fn` under a shared hold, releasing it however `fn` ends. Refuses while
   * an exclusive holder exists, except a brief credential write, which it waits
   * out for up to {@link BRIEF_EXCLUSIVE_WAIT_MS}. An abort of `signal` during
   * that wait rejects at once, and a signal already aborted once the hold is
   * taken releases it without running `fn`.
   *
   * @throws LocalAgentError `turn_in_progress`
   */
  async withSharedLock<T>(agentId: string, owner: string, fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    return withHeld(await takeSharedWaitingOutBrief(agentId, owner, signal), () => {
      if (signal?.aborted) throw new Error(STOPPED_WHILE_WAITING)
      return fn()
    })
  },

  /** Exclusive, queued: acquires atomically once no holder remains; cancellation removes its waiter. */
  withQueuedLock<T>(agentId: string, owner: string, signal: AbortSignal, fn: () => Promise<T> | T): Promise<T> {
    return withQueued(agentId, owner, 'exclusive', signal, fn)
  },

  /** Shared, queued: waits only while an exclusive holder exists; cancellation removes its waiter. */
  withQueuedSharedLock<T>(agentId: string, owner: string, signal: AbortSignal, fn: () => Promise<T> | T): Promise<T> {
    return withQueued(agentId, owner, 'shared', signal, fn)
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
   * Call `fn` once the agent has no holder at all — immediately when it already
   * has none. Used by the watcher to defer a rescan it must not run mid-turn.
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
