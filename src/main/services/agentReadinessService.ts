/**
 * Whether each agent can take a turn right now — the last answer its driver
 * gave, merged into the agent DTO so the composer can refuse a send with a
 * reason before the turn fails with one.
 *
 * Phase 2 of the agent runtime plan: every driver answers `readiness()`, and
 * the user chose to probe on list and refuse in the composer. Asking a driver
 * is not free — an A2A agent's answer is a card fetch over the network, a
 * folder agent's a folder read — so a list never waits on it. The list reads
 * what is here ({@link peek}), and kicks a background refresh for any enabled
 * agent whose answer is missing or old ({@link kick}). A changed answer is
 * pushed to the renderer, which re-reads the list.
 *
 * **`null` means "never checked", and never blocks a send.** An agent is
 * refused only on an answer its driver actually gave, so a probe that has not
 * run yet — or failed to run — can never stop a working agent.
 *
 * Takes its world by injection ({@link AgentReadinessDeps}): the probe is
 * `driverFor(row).readiness`, the broadcast is a `webContents.send`, and both
 * are installed by `agent.ipc.ts` at registration. Until then nothing is
 * probed and every answer is `null`, which is exactly the no-blocking default.
 */
import type { AgentRow } from '../db/agents'
import type {
  AgentReadiness,
  AgentReadinessChangedPayload
} from '../../shared/agentDrivers'
import { capabilitiesFor } from '../agents/drivers/capabilities'
import type { ReadinessOptions } from '../agents/drivers/driver'
import { createLogger } from '../logger/logger'

const logger = createLogger('agent-readiness')

/**
 * How long an answer for an agent reached over the network stays fresh.
 *
 * Each refresh is a card fetch — and for a synced agent a token resolve that
 * may refresh the Cinna session — so a list that re-renders often must not turn
 * into a request per render. A minute is short enough that an agent that went
 * down is refused within one list refetch of the user coming back to it, and
 * the composer's "Check again" and the Settings card's Test skip the wait.
 */
export const REMOTE_READINESS_TTL_MS = 60_000

/**
 * How long an answer for an agent that runs in a folder on this machine stays
 * fresh. One folder read, no network — cheap enough to re-ask often, and the
 * state it reports (a credential added to `credentials/.env`) is one the user
 * fixes by hand and expects to see picked up without pressing anything.
 */
export const LOCAL_READINESS_TTL_MS = 10_000

/** Background refreshes at once: a list of many synced agents is many card fetches. */
export const READINESS_CONCURRENCY = 4

/**
 * The least time between a refusal and the list-time check that re-asks it.
 *
 * A refusal is re-asked on every list read (see `kick`), and an answer that
 * changed is pushed, which re-reads the list. An agent whose answer differs on
 * every check — a proxy alternating 502 and 504, both in the reason — would
 * otherwise drive check → push → list → check with nothing in between. The
 * re-read a push causes lands milliseconds after the check that pushed; a fix
 * the user makes by hand lands seconds later, and *Check again* skips this.
 */
export const REFUSAL_RECHECK_FLOOR_MS = 5_000

export interface AgentReadinessDeps {
  /** The agent's driver's `readiness()`. Promises never to throw; not trusted to. */
  probe(userId: string, agent: AgentRow, options?: ReadinessOptions): Promise<AgentReadiness | null>
  /** Tell the renderer an answer changed. */
  broadcast(payload: AgentReadinessChangedPayload): void
  /** Clock, for tests. */
  now?(): number
}

interface Entry {
  /** Null: the driver could not tell (a check that timed out). Never a refusal. */
  readiness: AgentReadiness | null
  checkedAt: number
  /** Start order of the check that produced this answer — see `run`. */
  seq: number
}

export interface AgentReadinessService {
  /** Install the probe and the broadcast. Replaces any earlier installation. */
  install(deps: AgentReadinessDeps): void
  /** The last answer for an agent, or null when it has never been checked. */
  peek(agentId: string): AgentReadiness | null
  /**
   * Ask now, coalesced with a check already running for the same agent.
   * Resolves with the fresh answer — or the last known one (or null) when the
   * probe could not answer. Never rejects.
   */
  refresh(userId: string, agent: AgentRow, options?: ReadinessOptions): Promise<AgentReadiness | null>
  /**
   * What a list does after reading `peek`: refresh, in the background and a
   * few at a time, every enabled agent whose answer is missing or stale, and
   * forget the answer of a disabled one. Returns immediately.
   */
  kick(rows: ReadonlyArray<{ userId: string; row: AgentRow }>): void
  /** Drop an agent's answer — it was deleted or switched off. */
  forget(agentId: string): void
  /** Test support: forget everything, including the installation. */
  reset(): void
}

export function createAgentReadinessService(): AgentReadinessService {
  let deps: AgentReadinessDeps | null = null
  const entries = new Map<string, Entry>()
  const inflight = new Map<string, Promise<AgentReadiness | null>>()
  /** Bumped by `forget`, so an answer that lands after it is not resurrected. */
  const epochs = new Map<string, number>()
  const queue: Array<{ userId: string; row: AgentRow }> = []
  const queued = new Set<string>()
  let running = 0
  /** Increments per check started; a slower, older check never overwrites a newer answer. */
  let sequence = 0
  /** Bumped by `reset`, so timers and checks from before it touch nothing after it. */
  let generation = 0

  const now = (): number => (deps?.now ? deps.now() : Date.now())
  const ttlFor = (row: AgentRow): number =>
    capabilitiesFor(row).cwd ? LOCAL_READINESS_TTL_MS : REMOTE_READINESS_TTL_MS

  function run(
    userId: string,
    row: AgentRow,
    options?: ReadinessOptions
  ): Promise<AgentReadiness | null> {
    const existing = inflight.get(row.id)
    // A check the user asked for does not settle for one a list started: that
    // one may answer from a probe's own cache, which is what the user is
    // trying to get past.
    if (existing && !options?.fresh) return existing
    const installed = deps
    if (!installed) return Promise.resolve(entries.get(row.id)?.readiness ?? null)

    const epoch = epochs.get(row.id) ?? 0
    const seq = ++sequence
    // The probe starts now, and a synchronous throw becomes a rejection here,
    // so the body below always reaches an `await` before its `finally` runs —
    // after `inflight.set`. A probe that threw synchronously used to clear the
    // map before the entry was set, leaving a settled promise there that
    // answered every later check without asking.
    let probing: Promise<AgentReadiness | null>
    try {
      probing = Promise.resolve(installed.probe(userId, row, options))
    } catch (err) {
      probing = Promise.reject(err)
    }
    let task!: Promise<AgentReadiness | null>
    task = (async (): Promise<AgentReadiness | null> => {
      let readiness: AgentReadiness | null
      try {
        readiness = await probing
      } catch (err) {
        // A driver promises never to throw. This is the backstop for the day
        // one does: the list keeps the answer it had rather than failing.
        logger.warn('an agent’s readiness could not be checked', {
          agentId: row.id,
          error: err instanceof Error ? err.message : String(err)
        })
        return entries.get(row.id)?.readiness ?? null
      } finally {
        // Only its own: a fresh check may have replaced this one meanwhile.
        if (inflight.get(row.id) === task) inflight.delete(row.id)
      }
      if ((epochs.get(row.id) ?? 0) !== epoch) {
        // Forgotten while the probe ran (deleted, or switched off): an answer
        // for it now would outlive the agent it describes.
        return null
      }
      const stored = entries.get(row.id)
      // A check started before the one that stored this answer — a slow list
      // check landing after *Check again* — is older news: keep the newer one.
      if (stored && stored.seq > seq) return stored.readiness
      const previous = stored?.readiness
      entries.set(row.id, { readiness, checkedAt: now(), seq })
      if (changed(previous, readiness)) {
        try {
          installed.broadcast({ agentId: row.id, readiness })
        } catch (err) {
          logger.warn('an agent readiness change could not be broadcast', {
            agentId: row.id,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
      return readiness
    })()
    inflight.set(row.id, task)
    return task
  }

  let pumpScheduled = false

  /**
   * Start the next list-time check — **one per macrotask**, never inline.
   *
   * A folder agent's readiness is a synchronous folder scan. Started inline,
   * `kick`'s checks ran inside the `agent:list` handler before it could answer,
   * and back to back with nothing between them to let an IPC message through;
   * the concurrency cap bounds promises in flight, not blocking work. A timer
   * per start puts the event loop's poll phase between every two scans. An
   * agent forgotten while its start was pending is dropped here.
   */
  function pump(): void {
    if (pumpScheduled || running >= READINESS_CONCURRENCY || queue.length === 0) return
    pumpScheduled = true
    const gen = generation
    setTimeout(() => {
      if (gen !== generation) return
      pumpScheduled = false
      const next = queue.shift()
      if (next && queued.delete(next.row.id)) {
        running++
        void run(next.userId, next.row).finally(() => {
          if (gen !== generation) return
          running--
          pump()
        })
      }
      pump()
    }, 0)
  }

  return {
    install(next) {
      deps = next
    },

    peek(agentId) {
      return entries.get(agentId)?.readiness ?? null
    },

    refresh(userId, agent, options) {
      return run(userId, agent, options)
    },

    kick(rows) {
      if (!deps) return
      const at = now()
      for (const { userId, row } of rows) {
        if (!row.enabled) {
          this.forget(row.id)
          continue
        }
        if (inflight.has(row.id) || queued.has(row.id)) continue
        const entry = entries.get(row.id)
        // **A refusal is re-asked on every list read; only an answer that does
        // not refuse — `ok`, or null for a check that could not tell — waits
        // out its TTL.** The fix for a refusal happens outside this service — a
        // re-auth, a credential typed into `.env`, a server coming back — and
        // each of those re-reads the list, often within seconds of the check
        // that refused. Holding a refusal for its TTL kept Send disabled after
        // the fix, with nothing scheduled to re-read the list later. Checks are
        // still coalesced, and a push fires only on a change, so a list read
        // cannot loop through its own refetch.
        // A refusal still gets `REFUSAL_RECHECK_FLOOR_MS` of rest, so the list
        // read its own push causes does not ask again at once.
        const refuses = entry?.readiness != null && entry.readiness.state !== 'ok'
        const rest = refuses ? REFUSAL_RECHECK_FLOOR_MS : ttlFor(row)
        if (entry && at - entry.checkedAt < rest) continue
        queued.add(row.id)
        queue.push({ userId, row })
      }
      pump()
    },

    forget(agentId) {
      entries.delete(agentId)
      epochs.set(agentId, (epochs.get(agentId) ?? 0) + 1)
      if (queued.delete(agentId)) {
        const index = queue.findIndex((q) => q.row.id === agentId)
        if (index >= 0) queue.splice(index, 1)
      }
    },

    reset() {
      generation++
      pumpScheduled = false
      deps = null
      entries.clear()
      inflight.clear()
      epochs.clear()
      queue.length = 0
      queued.clear()
      running = 0
    }
  }
}

/**
 * Whether an answer is news to the renderer.
 *
 * Only a refusal is visible: `null` (never checked, or could not tell) and
 * `ok` look the same on every surface — neither blocks, neither colours a dot.
 * So a first `ok`, or `ok` becoming a timed-out null, is not pushed; pushing it
 * would make a list refetch once per agent on every launch for nothing on
 * screen to change. A refusal arriving, leaving, or changing its state or
 * reason is.
 */
function changed(previous: AgentReadiness | null | undefined, next: AgentReadiness | null): boolean {
  const refuses = (r: AgentReadiness | null | undefined): boolean => r != null && r.state !== 'ok'
  if (!refuses(previous) && !refuses(next)) return false
  return previous?.state !== next?.state || previous?.reason !== next?.reason
}

export const agentReadinessService = createAgentReadinessService()
