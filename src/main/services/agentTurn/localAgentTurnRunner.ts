/**
 * One turn against a folder agent, run by the local OpenCode engine.
 *
 * The A2A side of this seam calls one SDK method and reads a stream back. The
 * local side cannot: `POST /api/session/{id}/prompt` returns an **admission
 * ack** (`SessionInputAdmitted`, carrying `admittedSeq`) and not the answer, so
 * a turn is assembled from a *separate* subscription. That inversion is the
 * reason this file exists at all, and it drives the order of everything below:
 *
 *   ensure the engine → resolve the agent key → open or resume the session →
 *   **subscribe and wait for the socket** → prompt → consume → settle.
 *
 * Subscribing before prompting is not an optimisation. The global stream takes
 * no cursor, so anything emitted before the socket is live is gone with no way
 * to ask for it again.
 *
 * ## Where the turn lock sits, and what is deliberately outside it
 *
 * `engineManager.ensureRunning` is the config choke point: it re-derives the
 * config from current state and restarts if the bytes moved. One `opencode
 * serve` backs every folder agent, so that restart ends *every* streaming turn
 * — which is why `applyConfigChange` refuses while `turnLock.anyHeld()`.
 * Calling it after taking the lock is therefore not unsafe, merely useless: the
 * change would be deferred past the very turn that asked for it. So it is
 * called **before** the lock, and the lock is taken for the streaming part
 * only.
 *
 * ## The `enabled` gate lives here, and this is the only place it exists
 *
 * `collectEngineAgents` skips readiness `invalid` and `contract_too_new` and
 * does **not** consult `enabled`, so a folder agent the user has switched off
 * still gets an OpenCode agent entry and a written prompt file. That is
 * coherent — the engine config is a catalogue of what *can* be addressed, and
 * the runner decides what a turn may reach, which also leaves a disabled
 * agent's prompt on disk for the user's own assistant to read. But it means the
 * gate does not exist anywhere else. Removing the check below makes a disabled
 * agent chattable.
 *
 * ## Permissions and questions keep the turn open
 *
 * Both arrive mid-turn and park the agent loop. They are emitted as A2A-shaped
 * `tool` parts (see `turnStream.ts`) and answered out of band through
 * `pendingRequests`, so `runAgentTurn`'s port-free shape is preserved and
 * orchestrated mode — which has no port — works identically. Every exit from a
 * turn rejects whatever is still pending, because a parked request with no
 * answer coming is a session that never goes idle.
 */

import type { RunAgentTurnInput, RunAgentTurnResult } from '../a2aStreamingService'
import { StreamPartsAccumulator } from '../../agents/streamPartsAccumulator'
import type { AgentStreamEvent } from '../../../shared/agentStreamEvents'
import { createLogger } from '../../logger/logger'
import type { AgentTurnRunner } from './runner'
import type { EngineEventBus, SessionEventListener } from './engineEventBus'
import { parseEngineEvent, type EngineEvent } from './engineEvents'
import { SseParser } from './sseParser'
import { TurnStream, type PendingRequest } from './turnStream'
import { pendingRequests, type RequestResolution } from './pendingRequests'
import type { EngineModelRef } from '../../engine/configGenerator'

const logger = createLogger('local-agent-turn')

/**
 * How long a single turn may run before it is ended for the user.
 *
 * Not a timeout on the model — it is a ceiling on *never settling*. See the
 * comment at the timer for why one exists at all.
 */
export const TURN_CEILING_MS = 20 * 60 * 1000

/**
 * How long a turn waits for the engine to know about its agent and its model.
 *
 * **A cold `opencode serve` answers `GET /api/health` long before it can run
 * anything.** Watched against 1.18.27 on 3 Sep 2026: `{"healthy":true}` comes
 * back in about a second, and it is then **thirty to sixty seconds** before
 * `GET /api/model` returns anything at all and before a config-defined agent is
 * addressable. Both failures in that window are silent:
 *
 * - the model does not resolve, and the engine reports
 *   `SessionRunnerModel.ModelUnavailableError` **on no event whatsoever** — the
 *   only trace is a `Failed to drain Session` line in its own log, so the turn
 *   sits until {@link TURN_CEILING_MS}, twenty minutes later;
 * - the agent is not loaded, and the turn runs with **no system prompt** — the
 *   folder agent answers as a generic assistant, which reads as the agent being
 *   badly written rather than as a race.
 *
 * So the readiness of a turn is asked of the engine rather than assumed from
 * its health check. Long enough to cover the observed cold start, and short
 * enough that a genuinely unusable model is a prompt error rather than a hang.
 */
export const ENGINE_READY_MS = 60 * 1000

/** Gap between readiness probes. */
const ENGINE_READY_POLL_MS = 1_000

/** The bits of the world this runner touches, injected so it can be driven in a test. */
export interface LocalTurnDeps {
  /** `engineManager.ensureRunning` — the config choke point. */
  ensureEngineRunning(userId: string): Promise<{ status: string; error: string | null }>
  /** `engineManager.agentKey` — the key **the running process loaded**, or null. */
  agentKey(agentId: string): string | null
  /** `engineManager.agentModel` — the model **the running process loaded**, or null. */
  agentModel(agentId: string): EngineModelRef | null
  /** Why the running config left this agent out, for the error line. */
  skipReason(agentId: string): string | null
  /** `engineManager.request` — the only door to the engine. */
  request(path: string, init?: RequestInit): Promise<Response>
  bus: EngineEventBus
  /** The folder agent as it is on disk right now. */
  getAgent(
    userId: string,
    agentId: string
  ): { name: string; path: string; enabled: boolean; readiness: string; readinessReason: string | null } | null
  /** The engine session id remembered for this (chat, agent), if any. */
  readSession(chatId: string, agentId: string): string | null
  /** Remember it, in both `desktop.json` and `a2a_sessions.context_id`. */
  saveSession(input: {
    chatId: string
    agentId: string
    agentDir: string
    sessionId: string
  }): void
  /** Take the per-agent lock for the streaming part of the turn. */
  withLock<T>(agentId: string, owner: string, fn: () => Promise<T>): Promise<T>
  /** The settings-scope user id that owns folder agents. */
  userId(): string
  /** Override the turn ceiling. Tests only; production takes {@link TURN_CEILING_MS}. */
  turnCeilingMs?: number
  /** Override the readiness window. Tests only; production takes {@link ENGINE_READY_MS}. */
  engineReadyMs?: number
}

interface Outcome {
  idle?: boolean
  error?: string
  aborted?: boolean
}

function fail(message: string, raw?: string): RunAgentTurnResult {
  return { text: '', parts: [], notices: [], error: { message, raw: raw ?? message } }
}

/**
 * Sleep, or wake early when the turn is aborted.
 *
 * The listener is removed on both exits. A poll loop that added one per
 * iteration and never removed it would leak a listener per second onto a signal
 * that outlives the loop, and `AbortSignal` warns about exactly that at ten.
 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

export class LocalAgentTurnRunner implements AgentTurnRunner {
  constructor(private readonly deps: LocalTurnDeps) {}

  async runTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const { chatId, agentId, wireContent, signal } = input
    const userId = this.deps.userId()

    const agent = this.deps.getAgent(userId, agentId)
    if (!agent) return fail('This agent’s folder could not be found on disk.')

    // The gate Phase 5 left to this phase. Deleting it makes a disabled agent
    // chattable, because the engine config still carries an entry for it.
    if (!agent.enabled) {
      return fail(`“${agent.name}” is switched off. Turn it back on to chat with it.`)
    }
    if (agent.readiness === 'invalid' || agent.readiness === 'contract_too_new') {
      return fail(
        agent.readinessReason ?? 'This agent’s folder is not in a state it can be run from.'
      )
    }

    // **Before the lock, deliberately** — see the header. A reconcile that
    // restarts the engine here ends no turn, because none is holding yet.
    const engine = await this.deps.ensureEngineRunning(userId)
    if (engine.status !== 'running') {
      return fail(engine.error ?? 'The local engine is not running.', engine.error ?? undefined)
    }

    const agentKey = this.deps.agentKey(agentId)
    if (!agentKey) {
      // Null covers all three ways an agent is unaddressable, and the skip
      // reason is the only one of them that can say what to fix.
      return fail(
        this.deps.skipReason(agentId) ??
          'This agent is not available in the running engine yet. Try again in a moment.'
      )
    }

    // Null is tolerated rather than fatal: an agent entry always names a model
    // (`buildEngineConfig` skips one that does not), so this is only null for
    // an engine that has no entry at all — which `agentKey` above has already
    // turned into an error — and for a config generated before this field
    // existed. Sending no `model` is what the runner did until now, so the
    // fallback is the old behaviour rather than a new failure.
    const model = this.deps.agentModel(agentId)

    try {
      return await this.deps.withLock(agentId, 'turn', () =>
        this.stream({ input, agent, agentKey, model, userId, signal, wireContent, chatId, agentId })
      )
    } catch (err) {
      // **`turnLock.acquire` throws and never queues.** Opening the same folder
      // agent in a second chat used to let `LocalAgentError('turn_in_progress')`
      // escape `runTurn` — whose own contract says it never throws — past
      // `streamToAgent`'s try/finally, which had no catch. The port closed
      // having posted neither `done` nor `error`, so the renderer sat in the
      // streaming state forever. The message is already user-facing ("This
      // agent is busy right now…"), which is the whole reason it is worth
      // surfacing rather than swallowing.
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('a turn could not start', { agentId, chatId, error: message })
      return fail(message, String(err))
    }
  }

  private async stream(ctx: {
    input: RunAgentTurnInput
    agent: { name: string; path: string }
    agentKey: string
    model: EngineModelRef | null
    userId: string
    signal: AbortSignal
    wireContent: string
    chatId: string
    agentId: string
  }): Promise<RunAgentTurnResult> {
    const { agent, agentKey, model, signal, wireContent, chatId, agentId } = ctx

    const notReady = await this.awaitEngineReady(agent.name, agent.path, agentKey, model, signal)
    // **Abort is checked first, and that order is the point.** A stop that
    // lands on the last poll would otherwise be reported to the user as "the
    // engine has no such model" — an error message for something they did on
    // purpose. An aborted turn is not an error anywhere else in this file
    // either: the mid-turn path returns parts with no `error` field.
    if (signal.aborted) {
      logger.info('the turn was stopped while the engine was still coming up', { agentId })
      return { text: '', parts: [], notices: [] }
    }
    if (notReady) {
      logger.warn('the engine never became ready for this turn', { agentId, agentKey, model })
      return fail(notReady)
    }

    let sessionId: string
    try {
      sessionId = await this.openSession(chatId, agentId, agent.path, agentKey, model)
    } catch (err) {
      logger.error('could not open an engine session', { agentId, error: String(err) })
      return fail('Could not start a session with the local engine.', String(err))
    }

    const turn = new TurnStream()
    const accumulator = new StreamPartsAccumulator({
      onToolCall: ({ name, input }) => logger.info(`tool call → ${name}`, { input })
    })
    // The accumulator's narrow sender-side port. Direct chat forwards these to
    // the chat's MessagePort; orchestrated mode wraps them; a buffered turn
    // passes no sink at all and they go nowhere.
    const deltaPort = {
      postMessage: (event: AgentStreamEvent): void => ctx.input.onEvent?.(event)
    }

    let settle!: (outcome: Outcome) => void
    const finished = new Promise<Outcome>((resolve) => {
      let done = false
      settle = (outcome) => {
        if (done) return
        done = true
        resolve(outcome)
      }
    })

    // **The backstop for every door that has not been found yet.**
    //
    // Only four things can end a turn: a terminal engine event, an abort, the
    // engine closing, and this. Three separate defects in this phase all ended
    // at the same place — a turn that never settles, holding its per-agent lock
    // for the life of the app and, through `turnLock.anyHeld()`, stopping the
    // engine being reconciled for *every* folder agent. Each was fixed at its
    // own door. This caps them all, including the doors nobody has opened yet,
    // and it turns the worst outcome from "the app is permanently degraded and
    // only a restart fixes it" into "one turn failed with a readable message".
    //
    // Generous on purpose: a real agent run doing real work can take minutes,
    // and a ceiling that fires on a working turn is worse than no ceiling.
    // `unref` so it cannot hold the process open at quit.
    const ceiling = setTimeout(() => {
      logger.error('a turn hit the ceiling without ever settling', {
        agentId,
        chatId,
        sessionId
      })
      settle({
        error:
          'The agent stopped responding and the turn was ended. Nothing further was received from the local engine.'
      })
    }, this.deps.turnCeilingMs ?? TURN_CEILING_MS)
    ceiling.unref?.()

    /** Requests this turn parked on, so every exit can reject them. */
    const parked = new Map<string, () => void>()
    let disconnected = false

    const startedAt = Date.now()
    // What the engine actually sent, counted by type. The first real turn
    // against a live credential currently leaves almost no trace, and every
    // remaining unknown in this phase is a question about *ordering and
    // presence* of events — whether a permission can arrive before the first
    // text, which `finish` values really occur, whether anything follows the
    // terminal step. One line per turn answers all of those from a user's log
    // without spending another probe session on a binary.
    const eventTypeCounts: Record<string, number> = {}
    let admittedSeq: number | undefined

    const ingest = (event: EngineEvent): void => {
      eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1
      if (event.type === 'session.next.prompt.admitted' && event.durable) {
        admittedSeq = event.durable.seq
      }
      const update = turn.apply(event)
      if (update.message) accumulator.ingestMessage(update.message, deltaPort)
      if (update.settled) {
        // **Both stores, not just the local one.** `parked` holds this turn's
        // cancel handles; `pendingRequests` is the module-level registry the
        // IPC layer answers from. Dropping only the former left the entry live
        // for the full park timeout: `isPending` kept returning true, a
        // persisted block kept rendering as answerable, and answering it
        // returned `{ok: true}` while the reply 404'd into a warn — telling the
        // user their decision landed when it did not.
        //
        // `drop`, not `resolve`: the engine has already settled this request,
        // so resolving would make the runner POST a redundant reject at it.
        parked.delete(update.settled)
        pendingRequests.drop(update.settled)
      }
      if (update.asked) this.park(update.asked, ctx, sessionId, parked)
      if (update.error) settle({ error: update.error })
      if (update.idle) settle({ idle: true })
    }

    const listener: SessionEventListener = {
      onEvent: ingest,
      onDisconnect: () => {
        disconnected = true
      },
      onReconnect: () => {
        if (!disconnected) return
        disconnected = false
        // The hole is unrecoverable from the global stream, so fill it from
        // the durable per-session one — which carries both the words that were
        // missed and `session.next.step.ended`, the event that actually ends a
        // turn. A turn that finished inside the hole is otherwise invisible
        // forever.
        void this.heal(sessionId, turn, ingest)
      },
      onClosed: () => {
        // The engine stopped. `ses_…` belonged to that process, so nothing
        // will ever arrive for it and no reconnect is coming. Ending the turn
        // here is what stops the per-agent lock being held for the life of the
        // app — and, because `applyConfigChange` refuses to restart while any
        // lock is held, what stops the *engine* becoming permanently
        // un-reconcilable too.
        settle({ error: 'The local engine stopped while the agent was answering.' })
      }
    }

    const unsubscribe = this.deps.bus.subscribe(sessionId, listener)
    const onAbort = (): void => settle({ aborted: true })
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      await this.deps.bus.ready()
      await this.prompt(sessionId, wireContent)
      const outcome = await finished

      if (outcome.aborted) {
        // Tell the engine, not just ourselves: an agent loop we stopped reading
        // keeps running, keeps spending tokens, and keeps holding the session.
        await this.post(`/api/session/${sessionId}/interrupt`).catch((err) =>
          logger.warn('interrupt failed', { sessionId, error: String(err) })
        )
      }

      const parts = accumulator.snapshotParts()
      const answer = accumulator.answerText()
      logger.info('turn complete', {
        sessionId,
        agentId,
        admittedSeq,
        durationMs: Date.now() - startedAt,
        outcome: outcome.aborted ? 'aborted' : outcome.error ? 'error' : 'ok',
        lastSeq: turn.lastSeq(),
        parts: parts.length,
        eventTypeCounts
      })
      this.deps.saveSession({ chatId, agentId, agentDir: agent.path, sessionId })

      if (outcome.error) {
        // Parts already streamed are kept: an error after a partial answer
        // should not blank the answer, and the A2A path behaves the same way
        // through `result.parts` on the error branch.
        return { text: answer, parts, notices: accumulator.snapshotNotices(), error: { message: outcome.error, raw: outcome.error }, contextId: sessionId }
      }
      return {
        text: answer || parts.map((p) => p.text).join(''),
        parts,
        notices: accumulator.snapshotNotices(),
        contextId: sessionId
      }
    } catch (err) {
      logger.error('local agent turn failed', { agentId, chatId, error: String(err) })
      return fail('The local agent could not complete this turn.', String(err))
    } finally {
      clearTimeout(ceiling)
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
      // Every exit clears the parked requests. A question left unanswered is a
      // session that never goes idle again, and the reject endpoint is the
      // clean way out of one.
      for (const [, cancel] of parked) cancel()
      parked.clear()
    }
  }

  /**
   * Register a request the agent is blocked on and post the answer when it
   * comes.
   *
   * Fire-and-forget on purpose: awaiting here would stall the event loop that
   * is still delivering this turn's other events — including the `idle` that
   * would end it.
   */
  private park(
    asked: PendingRequest,
    ctx: { chatId: string; agentId: string },
    sessionId: string,
    parked: Map<string, () => void>
  ): void {
    const handle = pendingRequests.register({
      requestId: asked.requestId,
      chatId: ctx.chatId,
      agentId: ctx.agentId,
      kind: asked.kind
    })
    parked.set(asked.requestId, handle.cancel)
    void handle.answered
      .then((resolution) => this.reply(sessionId, asked, resolution))
      .catch((err) =>
        logger.warn('could not deliver an answer to the engine', {
          requestId: asked.requestId,
          error: String(err)
        })
      )
      .finally(() => parked.delete(asked.requestId))
  }

  private async reply(
    sessionId: string,
    asked: PendingRequest,
    resolution: RequestResolution
  ): Promise<void> {
    const base = `/api/session/${sessionId}/${asked.kind === 'permission' ? 'permission' : 'question'}/${asked.requestId}`
    if (resolution.kind === 'permission') {
      await this.post(`${base}/reply`, { reply: resolution.reply })
      return
    }
    if (resolution.kind === 'question') {
      await this.post(`${base}/reply`, { answers: resolution.answers })
      return
    }
    // Rejected — the clean exit that keeps a parked request from wedging the
    // session. A question has its own no-body endpoint; a permission is
    // rejected by replying `reject`.
    if (asked.kind === 'question') await this.post(`${base}/reject`)
    else await this.post(`${base}/reply`, { reply: 'reject' })
  }

  /**
   * Fill the hole a dropped socket left.
   *
   * One call, not two, and that is a correction rather than a simplification.
   * This used to replay the durable stream and then call
   * `POST /api/session/{id}/wait` for completion, because `session.idle` — the
   * documented terminal event — is not on the durable stream. Running the real
   * binary showed **`session.idle` is never emitted at all**, and `/wait`
   * answers `503 "Session wait is not available yet"` in ~16ms: declared in the
   * OpenAPI document, unimplemented in 1.18.27. Both documented completion
   * signals are dead.
   *
   * The signal that does work — `session.next.step.ended` with a terminal
   * `finish` — **is** one of the 28 durable variants. So the replay below now
   * carries both halves of the recovery: the content that was missed, and the
   * end of the turn. `/wait` is not called, and not retried, because there is
   * nothing it could add even if it worked.
   */
  private async heal(
    sessionId: string,
    turn: TurnStream,
    ingest: (event: EngineEvent) => void
  ): Promise<void> {
    try {
      await this.replayDurable(sessionId, turn.lastSeq(), ingest)
    } catch (err) {
      logger.warn('could not replay the durable session stream', { sessionId, error: String(err) })
    }
  }

  /** Read `GET /api/session/{id}/event?after=<seq>` to the end and fold it in. */
  private async replayDurable(
    sessionId: string,
    after: number | null,
    ingest: (event: EngineEvent) => void
  ): Promise<void> {
    const query = after === null ? '' : `?after=${after}`
    const res = await this.deps.request(`/api/session/${sessionId}/event${query}`)
    if (!res.ok || !res.body) return
    const parser = new SseParser()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
          const event = parseEngineEvent(message.data)
          if (event) ingest(event)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * Wait until the engine can actually run this turn, or say why it cannot.
   *
   * Returns null when it is ready, and a user-facing sentence when the window
   * closed first. **It never fails a turn on its own trouble**: a readiness
   * probe that errors, 404s or answers something unparseable returns null and
   * lets the turn proceed, because the old behaviour — try it and see — is
   * strictly better than refusing over a diagnostic we added ourselves.
   *
   * The two questions are asked in that order and the cheap one first: an
   * unloaded config fails both, and `GET /api/agent` is a handful of entries
   * where `GET /api/model` is every model of every available provider.
   *
   * **It polls rather than deciding on the first answer, and a non-empty
   * catalog missing the model is not evidence of a misconfiguration.** Polled
   * at 50 ms through a fresh start, `GET /api/model` goes empty → *the whole
   * models.dev catalog* (~7500 models, every provider "available" because the
   * integration list has not populated yet) → the four our config defines, over
   * about 160 ms. Custom provider entries — a second credential of a type, and
   * every OpenAI-compatible gateway — exist only after the last of those
   * transforms. Failing fast on "the catalog has models but not yours" would
   * break exactly those and nothing else. See the contract, §9.5.8.
   *
   * **Both are scoped to the folder the session will be opened in, and that is
   * the whole point rather than a refinement.** The engine's catalog and agent
   * registry are per-*location*: it boots a location's services the first time
   * something uses that location, and an unscoped probe answers for the
   * engine's own working directory — which is warm from the moment it starts
   * and says nothing about the folder a turn is about to run in. Watched on
   * 3 Sep 2026: with an unscoped probe reporting ready, the first turn in a
   * fresh folder still went out **with no system prompt**; with the probe
   * scoped, the same first turn carried it. The probe is therefore also what
   * warms the location.
   *
   * **It gives up the moment the turn is aborted.** The wait happens inside the
   * per-agent lock, and `turnLock.anyHeld()` blocks every engine reconcile, so
   * a user who presses stop during a cold start would otherwise hold the whole
   * app's engine still for the rest of the window with nothing to show for it.
   * The caller distinguishes the two exits by reading the signal itself, so
   * this returns null on an abort — "nothing to report" rather than a reason.
   */
  private async awaitEngineReady(
    agentName: string,
    directory: string,
    agentKey: string,
    model: EngineModelRef | null,
    signal: AbortSignal
  ): Promise<string | null> {
    const at = `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
    const deadline = Date.now() + (this.deps.engineReadyMs ?? ENGINE_READY_MS)
    let missing: string | null = null
    for (;;) {
      if (signal.aborted) return null
      const agents = await this.readList(`/api/agent${at}`)
      if (agents === null) return null
      if (agents.some((entry) => entry.id === agentKey)) {
        if (!model) return null
        const models = await this.readList(`/api/model${at}`)
        if (models === null) return null
        if (models.some((m) => m.providerID === model.providerID && m.id === model.id)) return null
        missing = `“${agentName}” is set to run on ${model.providerID}/${model.id}, and the local engine has no such model. Check the agent’s Runtime, then restart the engine from Settings.`
      } else {
        missing = `“${agentName}” is not loaded in the local engine yet. Try again in a moment.`
      }
      if (Date.now() + ENGINE_READY_POLL_MS >= deadline) return missing
      await sleepUnlessAborted(ENGINE_READY_POLL_MS, signal)
    }
  }

  /** `GET path` as a `{data:[…]}` list of records, or null if it cannot be read. */
  private async readList(path: string): Promise<Record<string, string>[] | null> {
    try {
      const res = await this.deps.request(path)
      if (!res.ok) return null
      const body = (await res.json()) as { data?: unknown }
      const list = Array.isArray(body) ? body : body?.data
      return Array.isArray(list) ? (list as Record<string, string>[]) : null
    } catch {
      return null
    }
  }

  /**
   * Resume the remembered session, or open a new one bound to the folder.
   *
   * A remembered id is verified rather than trusted: the engine's own storage
   * can be cleared, and prompting into a session that no longer exists returns
   * a 404 the user would see as an unexplained failure. `POST /api/session`
   * takes the OpenCode agent key at creation, so the session is bound to the
   * folder *and* the agent in one call; a resumed session whose key has moved
   * — the config changed and the engine restarted — is switched with
   * `POST .../agent` rather than abandoned, so the conversation survives.
   *
   * **The model is sent with it, and that is not decoration.** OpenCode
   * 1.18.27's v2 session runner resolves a model from the *session's* own
   * `model` and never from `agent.<key>.model`, so a session opened with an
   * agent and no model runs on whatever the engine picks for itself — verified
   * 3 Sep 2026 to be a free `opencode/muse-spark-*` gateway on which every tool
   * call fails, and once a provider with no key at all. The model therefore
   * travels the same two routes the agent key does: in the create call, and as
   * a `POST .../model` re-point on a remembered session whose config has moved
   * underneath it. The ref is `{providerID, id}`; `{providerID, modelID}` is
   * rejected at creation and does not even answer JSON.
   */
  private async openSession(
    chatId: string,
    agentId: string,
    directory: string,
    agentKey: string,
    model: EngineModelRef | null
  ): Promise<string> {
    const remembered = this.deps.readSession(chatId, agentId)
    if (remembered) {
      const res = await this.deps.request(`/api/session/${remembered}`)
      if (res.ok) {
        await this.post(`/api/session/${remembered}/agent`, { agent: agentKey }).catch((err) =>
          logger.warn('could not re-point the session at its agent', {
            sessionId: remembered,
            error: String(err)
          })
        )
        if (model) {
          await this.post(`/api/session/${remembered}/model`, { model }).catch((err) =>
            logger.warn('could not re-point the session at its model', {
              sessionId: remembered,
              error: String(err)
            })
          )
        }
        return remembered
      }
      logger.info('the remembered engine session is gone; opening a new one', {
        chatId,
        agentId
      })
    }
    const created = await this.post('/api/session', {
      agent: agentKey,
      ...(model ? { model } : {}),
      location: { directory }
    })
    const id = (created as { data?: { id?: string } })?.data?.id
    if (typeof id !== 'string' || !id.startsWith('ses')) {
      throw new Error(`the engine returned no session id: ${JSON.stringify(created)}`)
    }
    return id
  }

  private async prompt(sessionId: string, text: string): Promise<void> {
    await this.post(`/api/session/${sessionId}/prompt`, { prompt: { text } })
  }

  /**
   * A JSON POST to the engine.
   *
   * Never logs the body of a response: `/config` is not the only thing behind
   * this door that can carry an `{env:…}`-substituted secret, and a helpful
   * debug dump is how one reaches a log file.
   */
  private async post(path: string, body?: unknown): Promise<unknown> {
    const res = await this.deps.request(path, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    })
    if (!res.ok) {
      throw new Error(`${path} responded ${res.status}`)
    }
    if (res.status === 204) return undefined
    const text = await res.text()
    if (text === '') return undefined
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
}
