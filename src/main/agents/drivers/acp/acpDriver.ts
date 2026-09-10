/**
 * The `acp` driver: every local CLI agent, over the Agent Client Protocol.
 *
 * One implementation replaces two — `LocalAgentTurnRunner` (a shared
 * `opencode serve` reached over HTTP, with an SSE event bus, a durable cursor
 * and hole-and-heal recovery) and `ClaudeAgentTurnRunner` (the Claude Agent SDK
 * inside this process) — because with the transport standardised there is
 * nothing left for those two to disagree about. What differs between engines is
 * how a process is started, and that is a launcher (`acpLaunchers.ts`).
 *
 * ## What a turn is, here
 *
 * ```
 * read the folder → which launcher does it name now
 *   → plan the launch (or refuse, in a sentence)
 *     → withLock(agentId, 'turn')
 *       → acquire the agent's process (started lazily, reaped when idle)
 *         → session/load(remembered) or session/new
 *           → set the mode / config options the launcher asked for
 *             → session/prompt, translating session/update into RunEvents
 *               → stopReason → RunAgentTurnResult
 * ```
 *
 * Every guarantee the two runners made is kept, and the ones that are easy to
 * lose in a rewrite are called out where they are implemented:
 *
 * - **The folder is the truth, the row is a cache** (Invariant 1). The stored
 *   launcher is what the scanner last read; the folder is re-read per turn.
 * - **`enabled`, `invalid` and `contract_too_new` are refusals**, in the
 *   runners' own sentences, before any process is touched.
 * - **The turn lock is held for the streaming half only**, and a lock refusal
 *   is a `result.error` rather than a throw — `ipcMain.handle` drops the code
 *   off a rejection, and the renderer would stream forever.
 * - **A parked ask is announced once and released on every exit.** The `open`
 *   gate and the `parked` map are the same mechanism the Claude runner used,
 *   for the same reason.
 * - **An abort is not an error.** The parts collected so far are returned with
 *   no `error`, which is what the A2A path does too.
 * - **A session id reaches both stores** (`a2a_sessions.context_id` and the
 *   folder's `desktop.json`) through the injected `saveSession`.
 *
 * ## The one thing that is genuinely new
 *
 * `session/load` **replays the whole conversation** as `session/update`
 * notifications before it answers — verified on OpenCode 1.18.27
 * (`spike/acp/opencode/recordings/q4-sessions-second.ndjson`). Ingesting that
 * replay would append the entire history to this turn's message. So the driver
 * binds first (there is nowhere else to put the traffic) and drops every update
 * until `loadSession` resolves: see {@link AcpTurn.replaying}.
 */

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import type { AgentRow } from '../../../db/agents'
import type { RunAgentTurnResult } from '../../../services/a2aStreamingService'
import type { LocalAgentKind } from '../../../../shared/localAgents'
import type { RunEvent } from '../../../../shared/runEvents'
import type {
  LocalPermissionRequest,
  RequestResolution
} from '../../../../shared/localAgentRequests'
import type { AgentCapabilities, AgentReadiness } from '../../../../shared/agentDrivers'
import { StreamPartsAccumulator, type MessageLike } from '../../streamPartsAccumulator'
import { createLogger } from '../../../logger/logger'
import { capabilitiesFor } from '../capabilities'
import { launcherOfRow } from '../driverOf'
import type { AgentDriver, ParkedAsk, RespondOutcome, RunInput } from '../driver'
import { AcpMessageStream } from './acpMessages'
import { isRefusal, newSessionParams, type AcpLaunchPlan, type AcpLauncher } from './acpLaunchers'
import { mintAcpRequestId, pickPermissionOption, toAcpPermissionRequest } from './acpPermissions'
import { toElicitationContent, toInputQuestions } from './acpQuestions'
import type { AcpConnection, AcpLauncherId, AcpProcessPool } from './types'

const logger = createLogger('acp-driver')

/**
 * The backstop, matching both runners'.
 *
 * A turn that never settles holds its per-agent lock for the life of the app.
 * Generous on purpose: a real agent doing real work takes minutes, and a
 * ceiling that fires on a working turn is worse than no ceiling.
 */
export const ACP_TURN_CEILING_MS = 20 * 60 * 1000

/**
 * How long an aborted turn waits for the agent to answer its `session/cancel`.
 *
 * `session/cancel` is a notification: the pending `session/prompt` is supposed
 * to come back `cancelled` once the agent has unwound, and OpenCode answers
 * within milliseconds. But *supposed to* is the whole problem — an agent that
 * ignores the notification would hold this turn, and with it the agent's lock,
 * until the twenty-minute ceiling, for a stop the user asked for and watched do
 * nothing.
 *
 * So the wait is bounded, and a grace that expires **retires the process**: an
 * agent that did not acknowledge a cancel still has a turn running inside it,
 * and the next prompt on that session would interleave with work the user
 * stopped. Three seconds is far longer than an acknowledgement takes and far
 * shorter than a user's patience with a Stop button.
 */
export const ACP_CANCEL_GRACE_MS = 3_000

/** Shown when a folder agent's folder is gone — the runners' own sentence. */
export const ACP_FOLDER_NOT_FOUND = 'This agent’s folder could not be found on disk.'

/** The folder as it is on disk right now, reduced to what a turn decides on. */
export interface AcpFolderView {
  name: string
  slug: string
  description: string
  path: string
  kind: LocalAgentKind
  enabled: boolean
  /** `LocalAgentReadiness`. A string, because the scanner's own view types it so. */
  readiness: string
  readinessReason: string | null
  /** The runtime block the engine is read from — the manifest's, or a bare folder's state. */
  runtime: { engine?: unknown } | null
}

export interface AcpDriverDeps {
  pool: AcpProcessPool
  /** The launcher for an engine, or undefined when this build has none. */
  launcher(id: AcpLauncherId): AcpLauncher | undefined
  /** The folder, freshly read; null when it cannot be. Must not throw. */
  readFolder(userId: string, agentId: string): AcpFolderView | null
  /** The remembered session id for this (chat, agent), if any. */
  readSession(chatId: string, agentId: string): string | null
  /** Remember it, in both `desktop.json` and `a2a_sessions.context_id`. */
  saveSession(input: {
    chatId: string
    agentId: string
    agentDir: string
    agentKind: LocalAgentKind
    sessionId: string
  }): void
  /** True when this agent folder already holds a grant covering an ask. Must not throw. */
  isGranted(agentDir: string, agentKind: LocalAgentKind, request: LocalPermissionRequest): boolean
  /** Write an *Always allow* against the folder the ask came from. False when it is not on disk. */
  rememberGrant(agentId: string, request: LocalPermissionRequest): boolean
  /** Park an ask in the pending-request registry. */
  registerRequest(input: {
    requestId: string
    chatId: string
    agentId: string
    kind: 'permission' | 'question'
    request?: LocalPermissionRequest
  }): { answered: Promise<RequestResolution>; cancel: () => void }
  /** Settle a parked ask; false when nothing waits on it. */
  resolveRequest(requestId: string, resolution: RequestResolution): boolean
  /** Take the per-agent lock for the streaming part of the turn. */
  withLock<T>(agentId: string, owner: string, fn: () => Promise<T>): Promise<T>
  /** Override the turn ceiling. Tests only. */
  turnCeilingMs?: number
  /** Override the wait for a `session/cancel` acknowledgement. Tests only. */
  cancelGraceMs?: number
}

function fail(message: string, raw?: string): RunAgentTurnResult {
  return { text: '', parts: [], notices: [], error: { message, raw: raw ?? message } }
}

export function createAcpDriver(deps: AcpDriverDeps): AgentDriver {
  const driver: AgentDriver = {
    id: 'acp',

    capabilities(agent: AgentRow): AgentCapabilities {
      return capabilitiesFor(agent)
    },

    async readiness(userId, agent, options): Promise<AgentReadiness | null> {
      try {
        const folder = deps.readFolder(userId, agent.id)
        const state = folderReadiness(folder)
        if (state.state !== 'ok') return state
        // The engine's own rungs, and they are asked about the launcher the
        // *folder* names rather than the one the row stores: a user who has
        // just switched an agent to Claude in the Runtime card is asking
        // "can it run now", and the row may not have been rescanned yet.
        const launcher = deps.launcher(reconcile(launcherOfRow(agent), folder))
        if (!launcher?.readiness) return state
        return await launcher.readiness(options)
      } catch (err) {
        // `readFolder` and the launcher rungs promise not to throw; this is the
        // backstop that keeps a list from failing on the day one does.
        logger.warn('an ACP agent’s readiness could not be read', {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err)
        })
        return { state: 'invalid', reason: ACP_FOLDER_NOT_FOUND }
      }
    },

    async run(userId, agent, input): Promise<RunAgentTurnResult> {
      const folder = deps.readFolder(userId, agent.id)
      if (!folder) return fail(ACP_FOLDER_NOT_FOUND)
      if (!folder.enabled) {
        return fail(`“${folder.name}” is switched off. Turn it back on to chat with it.`)
      }
      if (folder.readiness === 'invalid' || folder.readiness === 'contract_too_new') {
        return fail(
          folder.readinessReason ?? 'This agent’s folder is not in a state it can be run from.'
        )
      }

      // **Which engine, decided from the folder** — the reconcile the two
      // folder drivers used to do by handing the turn to each other. With one
      // driver it is a lookup, which is the whole point of the collapse.
      const launcherId = reconcile(launcherOfRow(agent), folder)
      const launcher = deps.launcher(launcherId)
      if (!launcher) {
        logger.warn('an agent names an engine this build cannot run', {
          agentId: agent.id,
          launcher: launcherId
        })
        return fail('This agent runs on an engine this version of Cinna does not support.')
      }

      // **Planned before the lock is taken.** "There is no Claude Code on this
      // machine" and "this agent's credential is unavailable" are answerable
      // without spawning anything, and answering them here means a user reads a
      // sentence naming the remedy instead of queueing behind another chat's
      // turn to be told.
      const plan = await launcher
        .plan({ userId, agentId: agent.id, folder })
        .catch((err: unknown) => {
          logger.warn('a launcher failed to plan a turn', {
            agentId: agent.id,
            launcher: launcherId,
            error: err instanceof Error ? err.message : String(err)
          })
          return { error: 'This agent could not be started.' }
        })
      if (isRefusal(plan)) return fail(plan.error)

      try {
        return await deps.withLock(agent.id, 'turn', () =>
          runTurn(deps, { userId, agent, folder, launcherId, plan, input })
        )
      } catch (err) {
        // `turnLock.acquire` throws rather than queueing, and its message is
        // already user-facing ("This agent is busy right now…"). Letting it
        // escape would break the never-throws contract at the one place the
        // renderer cannot recover: the port closes having posted neither `done`
        // nor `error`, and the chat streams forever.
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('an ACP turn could not start', {
          agentId: agent.id,
          chatId: input.chatId,
          error: message
        })
        return fail(message, String(err))
      }
    },

    respond(ask: ParkedAsk, resolution: RequestResolution): RespondOutcome {
      return respondToAcpAsk(deps, ask, resolution)
    }
  }
  return driver
}

/* --------------------------------------------------------------------- turn */

interface TurnContext {
  userId: string
  agent: AgentRow
  folder: AcpFolderView
  launcherId: AcpLauncherId
  plan: AcpLaunchPlan
  input: RunInput
}

/**
 * State one turn carries that a handler has to see, in one object.
 *
 * `replaying` is the load-replay gate described in the header; `open` gates the
 * two ask events; `parked` is what every exit releases.
 */
interface AcpTurn {
  replaying: boolean
  open: boolean
  parked: Map<string, () => void>
}

async function runTurn(deps: AcpDriverDeps, ctx: TurnContext): Promise<RunAgentTurnResult> {
  const { agent, folder, plan, input } = ctx
  const chatId = input.chatId
  const stream = new AcpMessageStream({ launcher: ctx.launcherId })
  const accumulator = new StreamPartsAccumulator({
    onToolCall: ({ name, input: toolInput }) =>
      logger.info(`tool call → ${name}`, { input: toolInput })
  })
  const deltaPort = { postMessage: (event: RunEvent): void => input.onEvent?.(event) }
  const emit: EmitMessage = (message) => {
    if (message) accumulator.ingestMessage(message, deltaPort)
  }

  const turn: AcpTurn = { replaying: false, open: true, parked: new Map() }
  let connection: AcpConnection | undefined
  let sessionId: string | null = null
  let hitCeiling = false

  /**
   * Both ways a turn is told to stop, in one signal.
   *
   * The user's Stop and the ceiling do the same two things — send
   * `session/cancel` and start the grace that bounds the wait for an
   * acknowledgement — and they have to share the second one. A grace armed only
   * by the user's abort would leave the ceiling with no way out of a prompt the
   * agent never answers: the timer would fire, the notification would go
   * unheard, and the turn would hold its lock for the life of the app. Which is
   * the failure the ceiling exists to prevent.
   */
  let requestCancel: () => void = () => {}
  const cancelRequested = new Promise<void>((resolve) => {
    requestCancel = resolve
  })
  /**
   * Tell the agent to stop, in the order that lets it stop cleanly.
   *
   * **The parked asks go first.** An agent blocked on
   * `session/request_permission` cannot act on a `session/cancel` it has not
   * read: it is inside a request, waiting for us. Releasing the parks answers
   * that request with a refusal, the agent unwinds, and the pending
   * `session/prompt` then comes back `cancelled` inside the grace — so a Stop
   * pressed while a permission block is on screen ends the turn instead of
   * timing out and killing a perfectly good process. The old OpenCode runner
   * posted the same refusal from its teardown, for the same reason.
   *
   * `open` is closed first, before the release: an ask the turn's own ending
   * settles was answered by nobody, and the terminal event posted above this
   * driver already says the park is gone. The `finally` closes it again and
   * sweeps whatever a later ask parked.
   *
   * `session/cancel` is a notification, so nothing here waits. A connection
   * that has already died has nothing to tell, which is why the rejection is
   * swallowed rather than reported.
   */
  const askAgentToStop = (): void => {
    turn.open = false
    for (const [, cancel] of turn.parked) cancel()
    turn.parked.clear()
    if (sessionId) void connection?.cancel(sessionId).catch(() => {})
    requestCancel()
  }

  const ceiling = setTimeout(
    () => {
      hitCeiling = !input.signal.aborted
      askAgentToStop()
    },
    deps.turnCeilingMs ?? ACP_TURN_CEILING_MS
  )
  ceiling.unref?.()

  const release = deps.pool.hold(agent.id)
  const onAbort = (): void => askAgentToStop()
  input.signal.addEventListener('abort', onAbort, { once: true })

  try {
    /**
     * **A listener added to an already-aborted signal never fires**, and
     * everything before this point can await — planning walks the login-shell
     * PATH and may write a config. A cancellation in that window used to be
     * dropped entirely, and the turn ran to completion on the user's plan
     * after they had stopped it.
     */
    if (input.signal.aborted) {
      logger.info('an ACP turn was stopped before it started', { agentId: agent.id, chatId })
      return { text: '', parts: [], notices: [] }
    }

    try {
      connection = await deps.pool.acquire(agent.id, plan.spec, plan.init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('an ACP agent’s process would not start', { agentId: agent.id, error: message })
      return fail(startFailureMessage(ctx.launcherId, message), message)
    }

    const handlers = {
      onUpdate: (notification: SessionNotification): void => {
        // The load replay, dropped: see the header. The session's *state* is
        // still worth reading out of it — a loaded session comes back with the
        // mode it was left in — but nothing goes into the transcript.
        if (turn.replaying) return
        emit(stream.apply(notification).message)
      },
      onPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> =>
        answerPermission(deps, ctx, { stream, emit, turn }, params),
      onElicitation: (params: CreateElicitationRequest): Promise<CreateElicitationResponse> =>
        answerElicitation(deps, ctx, { stream, emit, turn }, params),
      onExtNotification: (method: string, params: Record<string, unknown>): void => {
        if (turn.replaying) return
        emit(stream.applyExt(method, params).message)
      }
    }

    const remembered = deps.readSession(chatId, agent.id)
    const canLoad = connection.initialized.agentCapabilities?.loadSession === true
    let unbind: (() => void) | undefined

    if (remembered && canLoad) {
      unbind = connection.bindSession(remembered, handlers)
      turn.replaying = true
      try {
        await connection.loadSession({
          sessionId: remembered,
          ...newSessionParams(plan, folder.path)
        })
        sessionId = remembered
      } catch (err) {
        // **A remembered session is verified by use, not by a probe** — there
        // is nothing to ask. A load against a session the engine has forgotten
        // fails, and the right answer is to start a fresh one and carry on
        // without explaining: the user asked a question, not to be told about
        // our bookkeeping. Nothing has streamed yet, because the replay gate
        // was closed for exactly this window.
        logger.info('the remembered ACP session was gone; starting a fresh one', {
          agentId: agent.id,
          chatId,
          error: err instanceof Error ? err.message : String(err)
        })
        unbind()
        unbind = undefined
      } finally {
        turn.replaying = false
      }
    }

    if (!sessionId) {
      try {
        const created = await connection.newSession(newSessionParams(plan, folder.path))
        sessionId = created.sessionId
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('an ACP session could not be created', { agentId: agent.id, error: message })
        return fail(startFailureMessage(ctx.launcherId, message), message)
      }
      // Bound on the response, which is why the connection buffers what
      // arrived before the bind: `available_commands_update` lands in the same
      // read as the answer often enough that a turn binding here would
      // otherwise never see it.
      unbind = connection.bindSession(sessionId, handlers)
    }

    try {
      await applySetup(connection, sessionId, plan)
    } catch (err) {
      // **A refusal, not a warning.** The launcher's setup is what makes the
      // desktop's own choices true: OpenCode's `mode` selects the agent
      // definition (without it the turn runs the engine's stock coding agent in
      // the user's folder), and Claude's `session/set_mode` is the only thing
      // that overrides a `defaultMode` from the user's settings — which can be
      // `bypassPermissions`. Running the turn anyway would run it under a
      // policy nobody chose.
      const message = err instanceof Error ? err.message : String(err)
      logger.error('an ACP session would not accept its setup', {
        agentId: agent.id,
        launcher: ctx.launcherId,
        error: message
      })
      unbind?.()
      return fail('This agent could not be set up for the turn.', message)
    }

    try {
      const answer = await promptWithCancelGrace(
        deps,
        connection,
        { sessionId, prompt: [{ type: 'text', text: input.wireContent }] },
        cancelRequested,
        agent.id
      )
      if (!answer) {
        // The grace expired: the agent never acknowledged the cancel. What was
        // streamed is kept, and a stop the user asked for is not an error — but
        // a *ceiling* that had to give up this way is, because nobody asked.
        logger.warn('an ACP agent did not acknowledge a cancel; its process was retired', {
          agentId: agent.id,
          chatId,
          ceiling: hitCeiling
        })
        return finish(deps, ctx, accumulator, sessionId, hitCeiling ? ceilingMessage() : undefined)
      }
      logger.info('ACP turn complete', {
        agentId: agent.id,
        chatId,
        launcher: ctx.launcherId,
        sessionId,
        stopReason: answer.stopReason
      })
      if (input.signal.aborted || answer.stopReason === 'cancelled') {
        return finish(deps, ctx, accumulator, sessionId, hitCeiling ? ceilingMessage() : undefined)
      }
      return finish(deps, ctx, accumulator, sessionId, stopReasonError(answer.stopReason))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Abort first, and the order is the point: a stop that lands mid-turn
      // takes the connection down with it, and reporting that as an error would
      // call something the user did deliberately a failure.
      if (input.signal.aborted) {
        logger.info('an ACP turn was stopped by the user', { agentId: agent.id, chatId })
        return finish(deps, ctx, accumulator, sessionId, undefined)
      }
      if (hitCeiling) {
        logger.error('an ACP turn hit the ceiling without ending', { agentId: agent.id, chatId })
        return finish(deps, ctx, accumulator, sessionId, ceilingMessage())
      }
      logger.warn('an ACP turn failed', { agentId: agent.id, chatId, error: message })
      return finish(deps, ctx, accumulator, sessionId, message)
    } finally {
      unbind?.()
    }
  } finally {
    clearTimeout(ceiling)
    input.signal.removeEventListener('abort', onAbort)
    release()
    // Every exit releases what this turn parked on. A request left registered
    // keeps `isPending` true, so a persisted block goes on rendering as
    // answerable and answering it reports success into a turn that has ended.
    turn.open = false // first, so the release below reports nothing
    for (const [, cancel] of turn.parked) cancel()
    turn.parked.clear()
  }
}

/**
 * `session/prompt`, with the bounded wait an abort turns it into.
 *
 * Null means the grace expired with no answer — see {@link ACP_CANCEL_GRACE_MS}
 * for why that retires the process rather than merely giving up on the promise.
 */
async function promptWithCancelGrace(
  deps: AcpDriverDeps,
  connection: AcpConnection,
  params: Parameters<AcpConnection['prompt']>[0],
  cancelRequested: Promise<void>,
  agentId: string
): Promise<Awaited<ReturnType<AcpConnection['prompt']>> | null> {
  const prompt = connection.prompt(params)
  // Nothing is bounded while the turn is simply running: an agent that takes
  // ten minutes to think is working, and the ceiling is what covers one that
  // never finishes. The clock starts only once a cancel has been asked for.
  const grace = cancelRequested.then(
    () =>
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), deps.cancelGraceMs ?? ACP_CANCEL_GRACE_MS)
        timer.unref?.()
        // The prompt settling first makes the timer irrelevant; clearing it
        // keeps a cancelled turn from holding a handle for three seconds after
        // it has already ended.
        void prompt.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer)
        )
      })
  )
  const answer = await Promise.race([prompt, grace])
  if (answer !== null) return answer
  // A promise nobody awaits still rejects; swallow it so the process does not
  // report an unhandled rejection for a turn we deliberately stopped reading.
  void prompt.catch(() => {})
  deps.pool.retire(agentId)
  return null
}

/** `session/set_mode` and `session/set_config_option`, in the order the launcher gave. */
async function applySetup(
  connection: AcpConnection,
  sessionId: string,
  plan: AcpLaunchPlan
): Promise<void> {
  if (plan.setup.modeId) {
    await connection.setSessionMode({ sessionId, modeId: plan.setup.modeId })
  }
  for (const option of plan.setup.configOptions ?? []) {
    const set = connection.setSessionConfigOption({
      sessionId,
      configId: option.configId,
      value: option.value
    })
    if (!option.optional) {
      await set
      continue
    }
    try {
      await set
    } catch (err) {
      // See `AcpSessionSetup.configOptions`: an optional option is one the
      // session has already been told through its config, and refusing a turn
      // over a race about something already true is worse than proceeding.
      logger.info('an ACP session declined an optional config option', {
        configId: option.configId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

/* ---------------------------------------------------------------------- asks */

/** Hand one folded message to the accumulator, or nothing when the fold changed none. */
type EmitMessage = (message: MessageLike | undefined) => void

interface AskWorld {
  stream: AcpMessageStream
  emit: EmitMessage
  turn: AcpTurn
}

/**
 * The permission gate.
 *
 * The promise **is** the park: the agent is blocked on this JSON-RPC request
 * until it settles, so there is no out-of-band reply to post and no id for the
 * agent to correlate — the same shape the Claude SDK's `canUseTool` had, now
 * true for OpenCode as well, which used to need a POST back to a URL.
 *
 * Note what is never selected: `allow_always`. See {@link pickPermissionOption}.
 */
async function answerPermission(
  deps: AcpDriverDeps,
  ctx: TurnContext,
  world: AskWorld,
  params: RequestPermissionRequest
): Promise<RequestPermissionResponse> {
  const { agent, folder, input } = ctx
  const toolName = world.stream.toolName(params.toolCall.toolCallId)
  const request = toAcpPermissionRequest(ctx.launcherId, params, toolName)

  const selected = (decision: 'allow' | 'reject'): RequestPermissionResponse => {
    const optionId = pickPermissionOption(params.options, decision)
    // An agent that offered no usable option gets `cancelled`, which every
    // implementation understands as "no decision" — better than selecting an
    // `always` we refuse to send or inventing an id it never offered.
    return optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }

  // **Answered before anything is written.** A standing grant settles the ask
  // silently: no block, no wait. A block that appeared and answered itself
  // milliseconds later would be a widget the user cannot act on, in the middle
  // of streaming text.
  let granted = false
  try {
    granted = deps.isGranted(folder.path, folder.kind, request)
  } catch (err) {
    // An unreadable store means "ask the user" — the safe direction.
    logger.warn('could not read this agent’s permission grants', {
      agentId: agent.id,
      error: err instanceof Error ? err.message : String(err)
    })
  }
  if (granted) return selected('allow')

  const requestId = mintAcpRequestId('permission')
  const handle = deps.registerRequest({
    requestId,
    chatId: input.chatId,
    agentId: agent.id,
    kind: 'permission',
    // The ask travels with the registration so the answer path can scope a
    // grant to what was actually named, without a second parse.
    request
  })
  world.turn.parked.set(requestId, handle.cancel)
  world.emit(world.stream.askPermission(requestId, request).message)
  // After the registration and the block, so an answer posted the moment this
  // arrives finds both.
  if (world.turn.open) {
    input.onEvent?.({
      type: 'needs_input',
      requestId,
      request: {
        kind: 'permission',
        action: request.action,
        resources: request.resources,
        ...(request.callId ? { callId: request.callId } : {})
      },
      resume: 'reply'
    })
  }

  const settle = (note: string, answer: RequestPermissionResponse): RequestPermissionResponse => {
    world.emit(world.stream.settlePermission(requestId, note).message)
    return answer
  }

  try {
    const resolution = await handle.answered
    // Before the decision line, so the renderer stops offering the block before
    // it reads what was decided.
    if (world.turn.open) input.onEvent?.({ type: 'input_resolved', requestId, resolution })

    // **`rejected` is not a user saying no.** The registry settles with it when
    // the park times out or the turn ends underneath, and it *resolves* rather
    // than rejecting — so this is the expiry path, not the `catch` below.
    // Denying is the only safe answer either way, but the transcript must not
    // record "Denied" for a decision nobody made.
    if (resolution.kind === 'rejected') {
      return settle('No answer — the request expired.', selected('reject'))
    }
    if (resolution.kind === 'permission' && resolution.reply !== 'reject') {
      // `always` is answered by the desktop and never sent onward — the grant
      // was written beside the folder, and what the agent is told is a plain
      // allow-once. The transcript says which of the two happened.
      return settle(
        resolution.remembered ? 'Allowed, and remembered for this agent.' : 'Allowed once.',
        selected('allow')
      )
    }
    return settle('Denied.', selected('reject'))
  } catch (err) {
    // Not the timeout — that resolves, above. This is the registry itself
    // failing, which has never been seen. Denying is the only safe answer:
    // nobody approved anything.
    logger.warn('a permission request failed to settle', {
      agentId: agent.id,
      error: err instanceof Error ? err.message : String(err)
    })
    return settle('No decision was recorded.', selected('reject'))
  } finally {
    world.turn.parked.delete(requestId)
  }
}

/**
 * A question, which over ACP is an elicitation.
 *
 * This is the one capability the transport *adds*: the in-process Claude runner
 * had no question path at all, and the adapter enables its `AskUserQuestion`
 * tool because the launcher declares `elicitation.form`. OpenCode's own
 * question tool is not registered under ACP, so for that launcher nothing
 * arrives here — see the Q3 verdict in the phase 3 plan.
 */
async function answerElicitation(
  deps: AcpDriverDeps,
  ctx: TurnContext,
  world: AskWorld,
  params: CreateElicitationRequest
): Promise<CreateElicitationResponse> {
  const { agent, input } = ctx
  const form = toInputQuestions(params)
  if (!form) {
    // `decline` rather than `cancel`: declining tells the model the user
    // skipped and lets the turn continue, where cancelling aborts the tool call
    // — and what happened here is that *this build* could not render the form,
    // which is not the user refusing.
    logger.info('an elicitation arrived in a shape this build cannot ask', {
      agentId: agent.id,
      mode: params.mode
    })
    return { action: 'decline' }
  }

  const requestId = mintAcpRequestId('question')
  const handle = deps.registerRequest({
    requestId,
    chatId: input.chatId,
    agentId: agent.id,
    kind: 'question'
  })
  world.turn.parked.set(requestId, handle.cancel)
  world.emit(world.stream.askQuestion(requestId, form.questions).message)
  if (world.turn.open) {
    input.onEvent?.({
      type: 'needs_input',
      requestId,
      request: { kind: 'question', questions: form.questions },
      resume: 'reply'
    })
  }

  try {
    const resolution = await handle.answered
    if (world.turn.open) input.onEvent?.({ type: 'input_resolved', requestId, resolution })
    if (resolution.kind === 'question') {
      const answers = resolution.answers.flat().filter(Boolean)
      world.emit(
        world.stream.settleQuestion(
          requestId,
          answers.length > 0 ? `Answered: ${answers.join(', ')}` : 'Answered.'
        ).message
      )
      return { action: 'accept', content: toElicitationContent(form, resolution.answers) }
    }
    world.emit(world.stream.settleQuestion(requestId, 'No answer — the request expired.').message)
    return { action: 'decline' }
  } catch (err) {
    logger.warn('a question failed to settle', {
      agentId: agent.id,
      error: err instanceof Error ? err.message : String(err)
    })
    world.emit(world.stream.settleQuestion(requestId, 'No decision was recorded.').message)
    return { action: 'decline' }
  } finally {
    world.turn.parked.delete(requestId)
  }
}

/**
 * Answer a parked ask: write an *Always allow* first, then settle the park.
 *
 * **Synchronous, and the order is only safe because it is.** The rule is
 * written before the answer is delivered, and `resolveRequest` can still answer
 * false — the turn was cancelled between the caller's registry lookup and here
 * — in which case a grant exists for an answer the user is told did not land.
 * Nothing can interleave today; an `await` inserted anywhere between the lookup
 * and the resolve makes it real, and the write cannot simply move after the
 * resolve because the resolution has to carry `remembered` into the transcript.
 */
export function respondToAcpAsk(
  deps: Pick<AcpDriverDeps, 'rememberGrant' | 'resolveRequest'>,
  ask: ParkedAsk,
  resolution: RequestResolution
): RespondOutcome {
  const settled = rememberIfAlways(deps, ask, resolution)
  if (!deps.resolveRequest(ask.requestId, settled)) return { delivered: false }
  return resolution.kind === 'permission' &&
    resolution.reply === 'always' &&
    settled.kind === 'permission'
    ? { delivered: true, remembered: settled.remembered === true }
    : { delivered: true }
}

/**
 * Turn a user's *Always allow* into a rule stored beside the agent, and into
 * the `once` the engine is actually told.
 *
 * `remembered` is deliberately allowed to be false: the user allowed this
 * action, so a store that refused the write must not cancel the action they
 * approved. They are asked again next time, and the block and the transcript
 * both say "allowed once" rather than claiming a rule that does not exist.
 */
function rememberIfAlways(
  deps: Pick<AcpDriverDeps, 'rememberGrant'>,
  ask: ParkedAsk,
  resolution: RequestResolution
): RequestResolution {
  if (resolution.kind !== 'permission' || resolution.reply !== 'always') return resolution
  if (!ask.request) {
    logger.warn('an always answer arrived for a request with no recorded ask', {
      agentId: ask.agentId
    })
    return { kind: 'permission', reply: 'once', remembered: false }
  }
  return {
    kind: 'permission',
    reply: 'once',
    remembered: deps.rememberGrant(ask.agentId, ask.request)
  }
}

/* -------------------------------------------------------------------- exits */

/**
 * One exit for every path, so a turn that failed after streaming still keeps
 * what it streamed — an error should not blank a partial answer, and every
 * other driver behaves the same way.
 */
function finish(
  deps: AcpDriverDeps,
  ctx: TurnContext,
  accumulator: StreamPartsAccumulator,
  sessionId: string | null,
  error: string | undefined
): RunAgentTurnResult {
  if (sessionId) {
    try {
      deps.saveSession({
        chatId: ctx.input.chatId,
        agentId: ctx.agent.id,
        agentDir: ctx.folder.path,
        agentKind: ctx.folder.kind,
        sessionId
      })
    } catch (err) {
      // Continuity is a convenience; losing it must not fail a turn that
      // otherwise worked.
      logger.warn('could not record the ACP session', {
        agentId: ctx.agent.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  const parts = accumulator.snapshotParts()
  const answer = accumulator.answerText()
  return {
    text: answer || parts.map((part) => part.text).join(''),
    parts,
    notices: accumulator.snapshotNotices(),
    ...(sessionId ? { contextId: sessionId } : {}),
    ...(error ? { error: { message: error, raw: error } } : {})
  }
}

function ceilingMessage(): string {
  return 'The agent stopped responding and the turn was ended.'
}

/**
 * Why a turn ended, when the reason is not "it finished".
 *
 * `max_tokens` and `max_turn_requests` are the agent's own limits and are
 * reported as text rather than swallowed: a reply that stops mid-sentence with
 * no explanation reads as a bug in this app. `refusal` is the model declining,
 * which it will usually also have said in the transcript.
 */
function stopReasonError(stopReason: string): string | undefined {
  switch (stopReason) {
    case 'max_tokens':
      return 'The agent reached its output limit before finishing this reply.'
    case 'max_turn_requests':
      return 'The agent reached its limit for how much work one turn may do.'
    case 'refusal':
      return 'The agent declined to answer.'
    default:
      return undefined
  }
}

/**
 * A process that would not start, in a sentence.
 *
 * The underlying message is a spawn error or a protocol timeout — accurate and
 * unreadable — so it is carried as `raw` while the sentence names the engine,
 * which is the part a user can act on.
 */
function startFailureMessage(launcher: AcpLauncherId, detail: string): string {
  const engine = launcher === 'claude' ? 'Claude Code' : 'the local engine'
  return `${engine} could not be started for this agent: ${detail}`
}

/** The folder half of readiness, in the scanner's own words. */
export function folderReadiness(folder: AcpFolderView | null): AgentReadiness {
  if (!folder) return { state: 'invalid', reason: ACP_FOLDER_NOT_FOUND }
  switch (folder.readiness) {
    case 'ok':
      return { state: 'ok', reason: null }
    case 'credentials_needed':
    case 'invalid':
    case 'contract_too_new':
      return {
        state: folder.readiness,
        reason:
          folder.readinessReason ?? 'This agent’s folder is not in a state it can be run from.'
      }
    default:
      // A readiness this build does not know is not one it can vouch for.
      return {
        state: 'invalid',
        reason:
          folder.readinessReason ?? 'This agent’s folder is not in a state it can be run from.'
      }
  }
}

/**
 * Which launcher the folder names right now.
 *
 * **Keeps the stored launcher whenever the folder cannot speak for itself** —
 * it cannot be read, or it is `invalid` / `contract_too_new`. A manifest is
 * unparseable for a moment every time an assistant saves it, and its runtime
 * then reads as none, which would otherwise hand a Claude agent to the default
 * engine. The turn refuses such a folder with the same sentence anyway, so
 * nothing is gained by moving it.
 */
function reconcile(stored: AcpLauncherId, folder: AcpFolderView | null): AcpLauncherId {
  if (!folder || folder.readiness === 'invalid' || folder.readiness === 'contract_too_new') {
    return stored
  }
  return launcherOfFolderRuntime(folder.runtime, stored)
}

/**
 * The launcher a folder's runtime block names.
 *
 * The same tolerant read `runtimeService` makes: a missing or unrecognised
 * engine keeps what the row already said, rather than silently moving an agent
 * to the default engine because a newer tool wrote a name this build has not
 * heard of.
 */
function launcherOfFolderRuntime(
  runtime: { engine?: unknown } | null | undefined,
  stored: AcpLauncherId
): AcpLauncherId {
  const raw = typeof runtime?.engine === 'string' ? runtime.engine.trim() : ''
  if (raw === 'opencode' || raw === 'claude' || raw === 'gemini' || raw === 'codex') return raw
  return stored
}
