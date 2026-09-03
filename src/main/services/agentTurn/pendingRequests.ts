/**
 * The permission and question asks a turn is currently blocked on.
 *
 * ## Why the answer arrives out of band
 *
 * A local agent's ask happens **mid-turn**: `POST /prompt` has been admitted,
 * the agent loop is running, and it is parked waiting on a human. So unlike the
 * A2A relay — where a question ends the turn and the answer arrives as the next
 * user message — the turn here is still open when the answer is needed.
 *
 * The answer could have ridden the turn's `MessagePort`, but that port only
 * exists for a *direct chat*: `runAgentTurn` is deliberately port-free, and
 * orchestrated mode has no port at all. Routing the reply through a registry
 * keyed by request id means the same code serves both, and the turn primitive
 * keeps the shape the plan insists on.
 *
 * ## Why nothing here reaches the engine
 *
 * This module holds *resolvers*, not HTTP. The runner owns the request that
 * actually posts a reply, because it is the runner that knows the session id
 * and holds `engineManager.request`. Keeping the door in one place is the same
 * rule Phase 5 set for the engine's base URL and Basic auth.
 *
 * ## The wedge, and why every path out of a turn clears the registry
 *
 * A parked question with no answer coming is a session that never goes idle.
 * `POST .../question/{id}/reject` and a `reject` permission reply are the clean
 * exits, and the runner takes them on cancel, on error, and on teardown — so
 * the invariant this module enforces is only that a request is registered
 * exactly once and can be resolved exactly once, from either side.
 */

import { createLogger } from '../../logger/logger'
import {
  REQUEST_PARK_TIMEOUT_MS,
  type PermissionReply
} from '../../../shared/localAgentRequests'

const logger = createLogger('local-agent-requests')

/** How a pending request was settled. */
export type RequestResolution =
  | { kind: 'permission'; reply: PermissionReply }
  | { kind: 'question'; answers: string[][] }
  | { kind: 'rejected' }

interface Entry {
  chatId: string
  agentId: string
  kind: 'permission' | 'question'
  settle: (resolution: RequestResolution) => void
}

const entries = new Map<string, Entry>()
/** Park timers, cleared on settle so an answered request leaves nothing behind. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export const pendingRequests = {
  /**
   * Register a request the turn is now blocked on.
   *
   * Returns a handle whose `answered` promise resolves when somebody — the
   * user through IPC, or the runner tearing the turn down — settles it. A
   * second registration under the same id replaces the first and settles it as
   * rejected, so a re-asked request (a reconnect replaying it) cannot leave an
   * orphan promise nothing will ever resolve.
   */
  register(input: {
    requestId: string
    chatId: string
    agentId: string
    kind: 'permission' | 'question'
    /**
     * Override the park timeout. Tests only — production takes
     * {@link REQUEST_PARK_TIMEOUT_MS}, and a per-call value would make the
     * app-wide stall this bounds depend on the call site.
     */
    timeoutMs?: number
  }): { answered: Promise<RequestResolution>; cancel: () => void } {
    const existing = entries.get(input.requestId)
    if (existing) {
      logger.warn('a request id was registered twice; settling the first as rejected', {
        requestId: input.requestId
      })
      existing.settle({ kind: 'rejected' })
      entries.delete(input.requestId)
    }

    let settle!: (resolution: RequestResolution) => void
    const answered = new Promise<RequestResolution>((resolve) => {
      settle = (resolution) => {
        // Only the first settlement counts, and it removes the entry — so a
        // late IPC answer for a turn that already gave up is a no-op rather
        // than a reply posted into a dead session.
        if (entries.get(input.requestId)?.settle !== settle) return
        entries.delete(input.requestId)
        const timer = timers.get(input.requestId)
        if (timer) {
          clearTimeout(timer)
          timers.delete(input.requestId)
        }
        resolve(resolution)
      }
    })
    entries.set(input.requestId, { ...input, settle })

    // **The bound on an abandoned dialog.** The turn holds its per-agent lock
    // while parked, and `applyConfigChange` defers while *any* lock is held —
    // so without this, one modal left open blocks every config change from
    // reaching the engine, for every folder agent, until the user comes back.
    //
    // Expiry rejects rather than abandoning: the engine is told "denied" and
    // the session goes idle by the same path a deliberate Deny takes. Timing
    // out into silence would leave the agent loop parked forever, which is the
    // wedge this whole registry exists to prevent.
    //
    // `unref` so a pending timer cannot hold the process open at quit.
    const timer = setTimeout(() => {
      logger.warn('a request went unanswered long enough to be rejected for the user', {
        requestId: input.requestId,
        kind: input.kind
      })
      settle({ kind: 'rejected' })
    }, input.timeoutMs ?? REQUEST_PARK_TIMEOUT_MS)
    timer.unref?.()
    timers.set(input.requestId, timer)

    return {
      answered,
      cancel: () => settle({ kind: 'rejected' })
    }
  },

  /**
   * Settle a request from the renderer.
   *
   * Returns the chat and agent it belonged to so the caller can check
   * ownership, or null when the request is unknown — which is the ordinary
   * outcome of answering a dialog whose turn has since been cancelled, not an
   * error worth surfacing.
   */
  resolve(
    requestId: string,
    resolution: RequestResolution
  ): { chatId: string; agentId: string } | null {
    const entry = entries.get(requestId)
    if (!entry) return null
    if (entry.kind !== resolution.kind && resolution.kind !== 'rejected') {
      // A permission answer posted to a question id would be delivered to the
      // wrong endpoint and rejected by the engine — but only after the wrong
      // dialog had already told the user it worked.
      logger.warn('a request was answered with the wrong kind of answer', {
        requestId,
        expected: entry.kind,
        got: resolution.kind
      })
      return null
    }
    const { chatId, agentId } = entry
    entry.settle(resolution)
    return { chatId, agentId }
  },

  /**
   * Forget a request the **engine** has already settled.
   *
   * Deliberately not `resolve()`. The engine tells us about a reply through
   * `permission.v2.replied` / `question.v2.*`, including replies made from
   * somewhere other than this window — and by then there is nothing left to
   * deliver. Routing that through `resolve` would settle the runner's
   * `answered` promise with a rejection and make it POST a redundant reject at
   * a request the engine has already closed.
   *
   * What this must not do is nothing: an entry left behind lives for the full
   * park timeout, during which `isPending` keeps returning true, a persisted
   * block keeps rendering as answerable, and answering it reports success
   * while the reply 404s.
   */
  drop(requestId: string): void {
    const entry = entries.get(requestId)
    if (!entry) return
    entries.delete(requestId)
    const timer = timers.get(requestId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(requestId)
    }
  },

  /**
   * Who a request belongs to, without settling it.
   *
   * The IPC handler has to check that the caller owns the chat **before** the
   * request is consumed — `resolve` settles as a side effect, so checking
   * ownership from its return value would have already delivered the answer by
   * the time the check failed.
   */
  owner(requestId: string): { chatId: string; agentId: string; kind: 'permission' | 'question' } | null {
    const entry = entries.get(requestId)
    return entry ? { chatId: entry.chatId, agentId: entry.agentId, kind: entry.kind } : null
  },

  /** What a chat is currently blocked on. Used to re-open the UI after a reload. */
  listForChat(chatId: string): { requestId: string; kind: 'permission' | 'question' }[] {
    const out: { requestId: string; kind: 'permission' | 'question' }[] = []
    for (const [requestId, entry] of entries) {
      if (entry.chatId === chatId) out.push({ requestId, kind: entry.kind })
    }
    return out
  },

  /** Only for tests and shutdown. */
  clear(): void {
    for (const [, entry] of [...entries]) entry.settle({ kind: 'rejected' })
    entries.clear()
    for (const [, timer] of timers) clearTimeout(timer)
    timers.clear()
  }
}
