import { readHandbackNote } from './handback'
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
import type { RunAgentTurnResult, TurnSteer } from '../../../services/a2aStreamingService'
import type { RunEvent } from '../../../../shared/runEvents'
import { describeQuestionAnswers } from '../../../../shared/localAgentRequests'
import type {
  LocalPermissionRequest,
  RequestResolution
} from '../../../../shared/localAgentRequests'
import type { AgentCapabilities, AgentReadiness } from '../../../../shared/agentDrivers'
import { StreamPartsAccumulator, type MessageLike } from '../../streamPartsAccumulator'
import { createLogger } from '../../../logger/logger'
import { capabilitiesFor } from '../capabilities'
import { launcherOfFolder } from '../driverOf'
import type { AgentEngine } from '../../../../shared/engine'
import type { AgentDriver, ParkedAsk, RespondOutcome, RunInput, ReadinessOptions, SteerFn } from '../driver'
import { AcpMessageStream } from './acpMessages'
import { isRefusal, newSessionParams, type AcpLaunchPlan, type AcpLauncher } from './acpLaunchers'
import { mintAcpRequestId, pickPermissionOption, toAcpPermissionRequest } from './acpPermissions'
import { toElicitationContent, toInputQuestions } from './acpQuestions'
import type { AcpConnection, AcpLauncherId, AcpProcessPool } from './types'

import type { AcpFolderView, AcpRuntimeView } from './acpRuntime'
export type { AcpFolderView, AcpRuntimeView } from './acpRuntime'

const logger = createLogger('acp-driver')
// Servers without session/load still retain sessions on their current connection.
const remoteSessions = new WeakMap<AcpConnection, Set<string>>()

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

export interface AcpDriverDeps {
  pool: AcpProcessPool
  /** The launcher for an engine, or undefined when this build has none. */
  launcher(id: AcpLauncherId): AcpLauncher | undefined
  /** Resolve and capture the actual folder or external command and its state. */
  readRuntime(userId: string, agent: AgentRow, options?: ReadinessOptions): AcpRuntimeView | null | Promise<AcpRuntimeView | null>
  /** Park an ask in the pending-request registry. */
  registerRequest(input: {
    requestId: string
    chatId: string
    agentId: string
    kind: 'permission' | 'question'
    request?: LocalPermissionRequest
    validate?(): void
  }): { answered: Promise<RequestResolution>; cancel: () => void }
  /** Settle a parked ask; false when nothing waits on it. */
  resolveRequest(requestId: string, resolution: RequestResolution): boolean
  /**
   * This machine's Default Runtime — what a folder that names no engine runs
   * on.
   *
   * A dependency rather than an import, like everything else this driver needs
   * from the rest of the app: the golden suites build a driver with no settings
   * store behind it, and a direct read would make every one of them depend on
   * one. Absent means the historical default, which is what those suites assert.
   */
  defaultEngine?(): AgentEngine
  /** Take the per-agent lock for the streaming part of the turn. */
  withLock<T>(agentId: string, owner: string, fn: () => Promise<T>, queuedSignal?: AbortSignal): Promise<T>
  /** Override the turn ceiling. Tests only. */
  turnCeilingMs?: number
  /** Override the wait for a `session/cancel` acknowledgement. Tests only. */
  cancelGraceMs?: number
}

function fail(message: string, raw?: string): RunAgentTurnResult {
  return { text: '', parts: [], notices: [], error: { message, raw: raw ?? message } }
}

function canceled(): RunAgentTurnResult {
  return { text: '', parts: [], notices: [], taskState: 'canceled', stopReason: 'canceled' }
}

/** Stop waiting without canceling restoration that other turns may share. */
async function beforeStart<T>(signal: AbortSignal, operation: () => T | Promise<T>): Promise<T> {
  const stopped = new Error('The agent was stopped before its prompt started.')
  if (signal.aborted) throw stopped
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(stopped)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    // Both outcomes stay observed after cancellation, including a late failure
    // from shared setup. No continuation of the canceled turn can launch it.
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw stopped
        return operation()
      }),
      aborted
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function createAcpDriver(deps: AcpDriverDeps): AgentDriver {
  const parkedRuntimes = new Map<string, AcpRuntimeView>()
  const driver: AgentDriver = {
    id: 'acp',

    capabilities(agent: AgentRow): AgentCapabilities {
      return capabilitiesFor(agent)
    },

    async readiness(userId, agent, options): Promise<AgentReadiness | null> {
      try {
        const runtime = await deps.readRuntime(userId, agent, options)
        if (runtime?.type === 'external') { runtime.validate(); return await runtime.readiness(options) }
        const folder = runtime?.folder ?? null
        const state = folderReadiness(folder)
        if (state.state !== 'ok') return state
        // The engine's own rungs, asked about the launcher the **folder** names
        // rather than the one the row stores: a user who has just switched an
        // agent to Claude in the Runtime card is asking "can it run now", and
        // the row may not have been rescanned yet. `folder` is non-null here —
        // `folderReadiness` refused it above otherwise.
        const launcher = deps.launcher(launcherOfFolder(folder?.runtime, deps.defaultEngine?.()))
        if (!launcher) return { state: 'invalid', reason: 'This agent declares an unsupported engine. Choose a supported runtime.' }
        if (!launcher.readiness) return state
        return await launcher.readiness(options)
      } catch (err) {
        // `readFolder` and the launcher rungs promise not to throw; this is the
        // backstop that keeps a list from failing on the day one does.
        logger.warn('an ACP agent’s readiness could not be read', {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err)
        })
        return { state: 'invalid', reason: agent.driverConfig?.launcher === 'custom' && err instanceof Error ? err.message : ACP_FOLDER_NOT_FOUND }
      }
    },

    async run(userId, agent, input): Promise<RunAgentTurnResult> {
      if (input.signal.aborted) return canceled()
      let runtime: AcpRuntimeView | null
      try {
        runtime = await beforeStart(input.signal, () => deps.readRuntime(userId, agent))
        if (input.signal.aborted) return canceled()
        runtime?.validate(input.chatId)
      } catch (error) {
        return input.signal.aborted ? canceled() : fail(error instanceof Error ? error.message : 'This agent configuration is unavailable.')
      }
      if (input.signal.aborted) return canceled()
      if (!runtime) return fail(ACP_FOLDER_NOT_FOUND)
      const folder = runtime.type === 'folder' ? runtime.folder : null
      const name = folder?.name ?? (runtime.type === 'external' ? runtime.name : agent.name)
      const enabled = folder?.enabled ?? (runtime.type === 'external' && runtime.enabled)
      if (!enabled) return fail(`“${name}” is switched off. Turn it back on to chat with it.`)
      if (folder && (folder.readiness === 'invalid' || folder.readiness === 'contract_too_new')) {
        return fail(folder.readinessReason ?? 'This agent’s folder is not in a state it can be run from.')
      }
      const launcherId =
        runtime.type === 'folder'
          ? launcherOfFolder(runtime.folder.runtime, deps.defaultEngine?.())
          : 'custom'
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
      const plan = await beforeStart(input.signal, () => launcher
        .plan({ userId, agentId: agent.id, ...(runtime.type === 'folder' ? { folder: runtime.folder } : { custom: runtime.config, binding: runtime.binding, accessToken: runtime.accessToken }) }))
        .catch((err: unknown) => {
          if (input.signal.aborted) return { error: 'The agent was stopped before its prompt started.' }
          logger.warn('a launcher failed to plan a turn', {
            agentId: agent.id,
            launcher: launcherId,
            error: err instanceof Error ? err.message : String(err)
          })
          return { error: 'This agent could not be started.' }
        })
      if (input.signal.aborted) return canceled()
      if (isRefusal(plan)) return fail(plan.error)

      try {
        if (input.queueWhenBusy) return await deps.withLock(agent.id, 'turn', () =>
          runTurn(deps, { userId, agent, runtime, launcherId, plan, input, parkedRuntimes, steers: [] }), input.signal)
        return await deps.withLock(agent.id, 'turn', () =>
          runTurn(deps, { userId, agent, runtime, launcherId, plan, input, parkedRuntimes, steers: [] })
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
        return input.signal.aborted ? { text: '', parts: [], notices: [], taskState: 'canceled', stopReason: 'canceled' } : fail(message, String(err))
      }
    },

    respond(ask: ParkedAsk, resolution: RequestResolution): RespondOutcome {
      const runtime = parkedRuntimes.get(ask.requestId)
      if (!runtime) return { delivered: false }
      try { runtime.validate(ask.chatId) } catch { return { delivered: false } }
      return respondToAcpAsk({ resolveRequest: deps.resolveRequest, rememberGrant: (_agentId, request) => {
        try { return runtime.rememberGrant(request) } catch { return false }
      } }, ask, resolution)
    }
  }
  return driver
}

/* --------------------------------------------------------------------- turn */

interface TurnContext {
  userId: string
  agent: AgentRow
  runtime: AcpRuntimeView
  parkedRuntimes: Map<string, AcpRuntimeView>
  launcherId: AcpLauncherId
  plan: AcpLaunchPlan
  input: RunInput
  /** User messages the agent took into this turn, where they landed. */
  steers: TurnSteer[]
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
  /**
   * A stop is in progress, so a park released from here was **not** abandoned.
   *
   * The registry settles a released park as `rejected`, which is also what an
   * expiry looks like — and this file argues at length that a decision nobody
   * made must not be recorded as one. "Denied" is not written for an expiry;
   * by the same standard "no answer in time" must not be written for a turn the
   * user deliberately stopped.
   */
  stopping: boolean
}

async function runTurn(deps: AcpDriverDeps, ctx: TurnContext): Promise<RunAgentTurnResult> {
  const { agent, runtime, plan, input } = ctx
  const sessionCwd = runtime.type === 'folder' ? runtime.folder.path : runtime.config.cwd
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

  const turn: AcpTurn = { replaying: false, open: true, parked: new Map(), stopping: false }
  let connection: AcpConnection | undefined
  let sessionId: string | null = null
  let hitCeiling = false
  /**
   * The mode the session says it is in, when it says anything.
   *
   * Watched because the desktop's approval setting is a promise to the user and
   * the agent can quietly not keep it. The in-process Claude runner learned the
   * same thing from the SDK's `init` message — asked for `auto` on a model with
   * no classifier, the CLI ran `default` and said so nowhere else — and told the
   * user in a notice. Over ACP the equivalent signal is a `current_mode_update`
   * (or a `config_option_update` for `mode`) naming a mode other than the one
   * `session/set_mode` was given. Without this line, "automatic approvals are
   * on" and "I was asked for every command" are indistinguishable from a bug.
   */
  let reportedMode: string | null = null
  /**
   * What the agent said it authenticated with, when it says anything.
   *
   * The in-process Claude runner read this off the SDK's `init` message as
   * `apiKeySource` and put a **notice** in the transcript whenever it was not
   * `'none'` — because a turn billed to an account the user did not choose
   * looks exactly like a turn billed to the right one, and a log line is no use
   * to somebody who does not already suspect it. That notice was briefly lost
   * with the runner; the ACP equivalent is the adapter's `_auth/status_update`,
   * whose `authStatus.kind` is `'account'` for a subscription login (recorded:
   * `{kind:'account', label:'Claude Max', account:{plan:'max', …}}`).
   *
   * Only the kind and the label are kept. The same payload carries the
   * account's **email address**, unasked and with no way to switch it off short
   * of refusing subscription use, and {@link scrubbed} is what keeps a future
   * adapter from smuggling one into the label.
   */
  let reportedAuth: { kind: string; label: string | null } | null = null

  /**
   * Mid-turn messages, over the steering extension.
   *
   * **Open only while this turn's `session/prompt` is in flight, and not before
   * the agent has started the turn.** The window opens at the first turn
   * content — a message or thought chunk, a tool call or its update — that
   * arrives after the prompt was sent, not when it is sent. An agent can take a
   * steer only into a turn it has already registered: codex-acp answers one
   * that arrives earlier only once the whole turn is over, with
   * `startedNewTurn`, and the Claude adapter answers it `promptRequired`. A mode
   * or command update is not the turn starting, nor is a plan: the Claude
   * adapter republishes the plan an earlier turn left before it registers the
   * new turn. A turn that streams no content before its prompt settles never
   * offers steering: a message sent meanwhile queues and drains when the turn
   * ends.
   *
   * It closes synchronously — before anything awaits — the moment the prompt
   * settles or a stop is asked for, and a window closed before it opened stays
   * closed. A message offered after that is `unavailable`, and the caller waits
   * for the next turn instead: otherwise it could land in a turn whose result
   * has already been read, and belong to no row. A request already sent is
   * awaited before the turn finishes, for the same reason.
   *
   * **And only while no tool call is in flight.** The Claude adapter steers at
   * `priority: "now"`, and the CLI aborts the running cycle for a `now` command:
   * a message sent while `Bash` ran killed the command, and the agent answered
   * the message instead. A call is in flight from its `tool_call`, or from a
   * `tool_call_update` that says `pending` or `in_progress`, until one says
   * `completed` or `failed`; a status-less update for a call never announced
   * does not start one. A call that never ends keeps steering withdrawn for the
   * rest of the turn, and a message sent meanwhile queues and drains when the
   * turn ends. Every engine gets the rule, not only Claude: waiting for the tool
   * boundary costs Codex nothing, and it protects against any adapter that
   * pre-empts. The window and the tools are separate state, so a tool finishing
   * after the window closed never re-offers.
   */
  let steerWindow: 'waiting' | 'armed' | 'open' | 'closed' = 'waiting'
  /** Tool calls the agent has started and not yet reported `completed` or `failed`. */
  const toolsInFlight = new Set<string>()
  /**
   * Tool calls already reported `completed` or `failed`. **An update after that
   * does not reopen one**: the Claude adapter sends status-less updates past
   * completion — the PostToolUse `toolResponse`, a compaction's enriched
   * result — and reading those as a call starting would withdraw steering for
   * the rest of the turn.
   */
  const toolsDone = new Set<string>()
  /** The function the window offers, while it exists; `offered` is whether the caller holds it now. */
  let steerOffer: SteerFn | null = null
  let offered = false
  /** Set once the turn stopped waiting for steers: its result no longer takes one. */
  let steeringSettled = false
  const steering = new Set<Promise<'injected' | 'late' | 'unavailable'>>()
  const steerable = (): boolean => steerWindow === 'open' && toolsInFlight.size === 0
  /** Closed for good, from whichever state; only a window that was open had anything to withdraw. */
  const closeSteering = (): void => {
    const wasOpen = steerWindow === 'open'
    steerWindow = 'closed'
    if (!wasOpen) return
    offered = false
    input.registerSteer?.(null)
  }
  /** Offer or withdraw after a tool call started or ended; the window itself is untouched. */
  const reofferSteering = (): void => {
    const want = steerable() && !!steerOffer
    if (want === offered) return
    offered = want
    input.registerSteer?.(want ? steerOffer : null)
  }
  const trackToolCall = (notification: SessionNotification): void => {
    // Not before this turn's prompt went out: a re-bound session flushes the
    // pen, which can hold the tail of a stopped turn — a call that never ends,
    // and would keep steering withdrawn for the whole of this one.
    if (steerWindow === 'waiting') return
    const update = notification.update
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    if (update.status === 'completed' || update.status === 'failed') {
      toolsInFlight.delete(update.toolCallId)
      toolsDone.add(update.toolCallId)
    } else if (!toolsDone.has(update.toolCallId) &&
      (update.sessionUpdate === 'tool_call' || update.status === 'pending' || update.status === 'in_progress')) {
      // A status-less update for a call never announced is not a call starting:
      // reading it as one would withdraw steering for the rest of the turn.
      toolsInFlight.add(update.toolCallId)
    }
    reofferSteering()
  }
  const deliverSteer = async (to: AcpConnection, session: string, text: string): Promise<'injected' | 'late' | 'unavailable'> => {
    let outcome: unknown
    try {
      outcome = (await to.steer({
        sessionId: session,
        prompt: [{ type: 'text', text }],
        _meta: { steering: { idleBehavior: 'promptRequired' } }
      }))?.outcome
    } catch (err) {
      logger.info('an ACP agent did not take a mid-turn message', {
        agentId: agent.id,
        chatId,
        error: err instanceof Error ? err.message : String(err)
      })
      return 'unavailable'
    }
    if (outcome === 'injected') {
      if (steeringSettled) {
        // The turn gave up waiting and its result is already built: this
        // message belongs to no row of it. The caller saves it on its own.
        logger.warn('an ACP agent took a mid-turn message after the turn was finished', { agentId: agent.id, chatId })
        return 'late'
      }
      ctx.steers.push({ afterPart: accumulator.partCount(), text })
      accumulator.breakContinuation()
      try { input.onEvent?.({ type: 'user_message', text }) } catch { /* a lost subscriber, not a lost message */ }
      return 'injected'
    }
    if (outcome === 'startedNewTurn') {
      // Codex ignores `promptRequired`: the turn had ended underneath, and it
      // started a turn of its own that nobody here is reading. Stop it; the
      // message goes to the next turn instead.
      logger.warn('an ACP agent started an unowned turn for a mid-turn message; cancelling it', {
        agentId: agent.id,
        chatId
      })
      void to.cancel(session).catch(() => {})
      if (!steeringSettled || !deps.pool.held(agent.id)) {
        // Retired too, as an unacknowledged cancel retires it: nothing confirms
        // the orphan has stopped, and the next prompt on this session would run
        // beside it. While this turn still waits, the retire waits for this
        // turn's hold, so the next turn starts clean.
        deps.pool.retire(agent.id)
      } else {
        // This turn has let go, so the hold is someone else's — the next turn,
        // a drained one, or another chat on this agent. A retire would wait for
        // it and then kill the process under that turn. Left running, and said.
        logger.warn('an ACP agent’s unowned turn may still be running beside another turn; its process was left up', {
          agentId: agent.id,
          chatId
        })
      }
    }
    return 'unavailable'
  }
  /** The prompt is on the wire: the agent's first turn content opens the window. */
  const armSteering = (): void => {
    if (steerWindow === 'waiting') steerWindow = 'armed'
  }
  /** The agent has started the turn: open the window, when this turn can offer one at all. */
  const openSteering = (): void => {
    if (steerWindow !== 'armed') return
    const to = connection
    const session = sessionId
    if (!to || !session || !turn.open || !input.registerSteer || !advertisesSteering(to)) {
      steerWindow = 'closed'
      return
    }
    steerWindow = 'open'
    steerOffer = (text) => {
      if (!steerable()) return Promise.resolve('unavailable')
      const request = deliverSteer(to, session, text)
      steering.add(request)
      void request.finally(() => steering.delete(request))
      return request
    }
    reofferSteering()
  }
  const settleSteering = async (): Promise<void> => {
    closeSteering()
    if (steering.size) {
      await Promise.race([
        Promise.allSettled([...steering]),
        new Promise<void>((resolve) => { const timer = setTimeout(resolve, deps.cancelGraceMs ?? ACP_CANCEL_GRACE_MS); timer.unref?.() })
      ])
    }
    steeringSettled = true
  }

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
  const startupController = new AbortController()
  let startingSession = true
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
    closeSteering()
    turn.open = false
    // **Only the user's Stop, not the ceiling.** The ceiling shares this
    // function, and a park it releases genuinely *was* never answered in time —
    // which is what the expiry wording says. Claiming the user stopped a turn
    // they left running for twenty minutes is the same kind of wrong this note
    // exists to avoid.
    if (!hitCeiling) turn.stopping = true
    for (const [, cancel] of turn.parked) cancel()
    turn.parked.clear()
    if (sessionId) void connection?.cancel(sessionId).catch(() => {})
    startupController.abort()
    if (startingSession) { deps.pool.retire(agent.id); void connection?.dispose() }
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

  const startCanceled = cancelRequested.then(() => { throw new Error('The agent was stopped before its prompt started.') })
  // The rejection is also observed when a completed turn never needed it.
  void startCanceled.catch(() => {})
  const duringStart = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, startCanceled])
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
      return { text: '', parts: [], notices: [], taskState: 'canceled', stopReason: 'canceled' }
    }

    try {
      runtime.validate(chatId)
      connection = await duringStart(deps.pool.acquire(agent.id, plan.spec, plan.init, startupController.signal))
      try { runtime.validate(chatId) } catch (error) { deps.pool.retire(agent.id); throw error }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('an ACP agent’s process would not start', { agentId: agent.id, error: message })
      return input.signal.aborted ? finish(ctx, accumulator, sessionId, undefined) : fail(plan.spec.remote ? `Could not connect to the remote ACP agent: ${message}` : startFailureMessage(ctx.launcherId, message), message)
    }

    const handlers = {
      onUpdate: (notification: SessionNotification): void => {
        // The load replay, dropped whole: see the header. Not even the mode
        // it reports is read, and that is deliberate rather than an oversight —
        // the mode a *loaded* session comes back in is the one it was left in,
        // and the setup that follows overwrites it before the first prompt, so
        // reading it here would only give the fallback notice a stale value to
        // compare against.
        if (turn.replaying) return
        trackToolCall(notification)
        const update = stream.apply(notification)
        if (update.modeId) reportedMode = update.modeId
        emit(update.message)
        // After the call is tracked, so a turn that starts with a tool call
        // opens its window withdrawn rather than offering and withdrawing.
        if (TURN_CONTENT.has(notification.update.sessionUpdate)) openSteering()
      },
      onPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> =>
        answerPermission(deps, ctx, { stream, emit, turn }, params),
      onElicitation: (params: CreateElicitationRequest): Promise<CreateElicitationResponse> =>
        answerElicitation(deps, ctx, { stream, emit, turn }, params),
      onExtNotification: (method: string, params: Record<string, unknown>): void => {
        if (turn.replaying) return
        if (method === AUTH_STATUS_METHOD) reportedAuth = readAuthStatus(params) ?? reportedAuth
        emit(stream.applyExt(method, params).message)
      }
    }

    const remembered = runtime.readSession(chatId)
    const canLoad = connection.initialized.agentCapabilities?.loadSession === true
    let unbind: (() => void) | undefined

    if (plan.spec.remote && remembered && remoteSessions.get(connection)?.has(remembered)) {
      sessionId = remembered
      unbind = connection.bindSession(remembered, handlers)
    } else if (plan.spec.remote && remembered && !canLoad) {
      return fail('This ACP server cannot reload sessions after disconnecting. Start a new chat.')
    }

    if (!sessionId && remembered && canLoad) {
      // **The gate closes before the bind, not after it.** `bindSession`
      // flushes the pre-bind pen *synchronously*, and the pen for this very
      // session id can be holding the tail of the previous turn — a stop, then
      // a resend in the same chat inside the pen's window, and the last chunks
      // of the turn the user stopped would be folded into this one's message.
      turn.replaying = true
      unbind = connection.bindSession(remembered, handlers)
      try {
        runtime.validate(chatId)
        await duringStart(connection.loadSession({
          sessionId: remembered,
          ...newSessionParams(plan, sessionCwd)
        }))
        runtime.validate(chatId)
        sessionId = remembered
      } catch (err) {
        // **A remembered session is verified by use, not by a probe** — there
        // is nothing to ask. A load against a session the engine has forgotten
        // fails, and the right answer is to start a fresh one and carry on
        // without explaining: the user asked a question, not to be told about
        // our bookkeeping. Nothing has streamed yet, because the replay gate
        // was closed for exactly this window.
        if (plan.spec.remote) { unbind(); throw err }
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

    if (startupController.signal.aborted) throw new Error('The agent was stopped before its prompt started.')
    if (!sessionId) {
      try {
        runtime.validate(chatId)
        const created = await duringStart(connection.newSession(newSessionParams(plan, sessionCwd)))
        runtime.validate(chatId)
        sessionId = created.sessionId
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('an ACP session could not be created', { agentId: agent.id, error: message })
        return input.signal.aborted ? finish(ctx, accumulator, sessionId, undefined) : fail(plan.spec.remote ? `Could not connect to the remote ACP agent: ${message}` : startFailureMessage(ctx.launcherId, message), message)
      }
      // Bound on the response, which is why the connection buffers what
      // arrived before the bind: `available_commands_update` lands in the same
      // read as the answer often enough that a turn binding here would
      // otherwise never see it.
      unbind = connection.bindSession(sessionId, handlers)
    }

    if (plan.spec.remote) {
      const known = remoteSessions.get(connection) ?? new Set<string>()
      known.add(sessionId)
      remoteSessions.set(connection, known)
    }

    /**
     * **The baseline is dropped here, before anything is set.**
     *
     * A session reports the mode it *starts* in — `session/new` answers with it,
     * and a loaded session comes back in whatever it was left in — and comparing
     * that against the mode we are about to ask for would put the fallback
     * notice on every single turn: asked for `auto`, told `default` by a
     * notification that predates the request. Measured exactly that way. Only a
     * mode reported from the setup onwards is evidence about the setup, and the
     * reset is before the call rather than after it because the acknowledging
     * notification can race its own response.
     */
    reportedMode = null

    try {
      runtime.validate(chatId)
      await duringStart(applySetup(connection, sessionId, plan))
      runtime.validate(chatId)
    } catch (err) {
      if (input.signal.aborted || hitCeiling) {
        unbind?.()
        return finish(ctx, accumulator, sessionId, hitCeiling ? ceilingMessage() : undefined)
      }
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
      // Through `finish`, so the session this turn *did* create is recorded.
      // A bare failure leaves it behind engine-side and mints another on every
      // retry, and the chat never gets a `contextId` to continue from.
      return finish(
        ctx,
        accumulator,
        sessionId,
        'This agent could not be set up for the turn.',
        message
      )
    }

    // **Checked again here.** Everything since the first check awaited — a
    // spawn, `session/new`, the setup calls — and that is one to two seconds in
    // which a Stop lands with `sessionId` still null, so `askAgentToStop` had
    // nothing to cancel. Sending the prompt anyway would start the agent on work
    // the user cancelled and then kill its process three seconds later, leaving
    // an empty reply and a cold start for the next turn.
    if (input.signal.aborted) {
      logger.info('an ACP turn was stopped before its prompt was sent', {
        agentId: agent.id,
        chatId
      })
      unbind?.()
      return finish(ctx, accumulator, sessionId, undefined)
    }

    try {
      runtime.validate(chatId)
      startingSession = false
      const answer = await promptWithCancelGrace(
        deps,
        connection,
        { sessionId, prompt: [{ type: 'text', text: input.wireContent }] },
        cancelRequested,
        agent.id,
        armSteering
      ).finally(settleSteering)
      if (!answer) {
        // The grace expired: the agent never acknowledged the cancel. What was
        // streamed is kept, and a stop the user asked for is not an error — but
        // a *ceiling* that had to give up this way is, because nobody asked.
        logger.warn('an ACP agent did not acknowledge a cancel; its process was retired', {
          agentId: agent.id,
          chatId,
          ceiling: hitCeiling
        })
        if (runtime.type === 'external') emit(stream.note('The local command was closed without confirmation that the remote agent stopped. Check its remote workspace before starting more work.').message)
        return finish(ctx, accumulator, sessionId, hitCeiling ? ceilingMessage() : undefined)
      }
      noteModeFallback(plan, reportedMode, stream, emit)
      noteForeignAuth(reportedAuth, stream, emit)
      logger.info('ACP turn complete', {
        agentId: agent.id,
        chatId,
        launcher: ctx.launcherId,
        sessionId,
        stopReason: answer.stopReason
      })
      if (input.signal.aborted || answer.stopReason === 'cancelled') {
        return finish(ctx, accumulator, sessionId, hitCeiling ? ceilingMessage() : undefined, undefined, false, !hitCeiling)
      }
      return finish(ctx, accumulator, sessionId, stopReasonError(answer.stopReason), undefined, answer.stopReason === 'end_turn')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Abort first, and the order is the point: a stop that lands mid-turn
      // takes the connection down with it, and reporting that as an error would
      // call something the user did deliberately a failure.
      if (input.signal.aborted) {
        logger.info('an ACP turn was stopped by the user', { agentId: agent.id, chatId })
        return finish(ctx, accumulator, sessionId, undefined)
      }
      if (hitCeiling) {
        logger.error('an ACP turn hit the ceiling without ending', { agentId: agent.id, chatId })
        return finish(ctx, accumulator, sessionId, ceilingMessage())
      }
      logger.warn('an ACP turn failed', { agentId: agent.id, chatId, error: message })
      return finish(ctx, accumulator, sessionId, message)
    } finally {
      unbind?.()
    }
  } catch (error) {
    if (input.signal.aborted) return finish(ctx, accumulator, sessionId, undefined)
    return finish(ctx, accumulator, sessionId, hitCeiling ? ceilingMessage() : error instanceof Error ? error.message : 'The agent could not start.')
  } finally {
    clearTimeout(ceiling)
    startupController.abort()
    input.signal.removeEventListener('abort', onAbort)
    try { runtime.validate(chatId) } catch { deps.pool.retire(agent.id) }
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
  agentId: string,
  /**
   * Called once the prompt is on the wire. It arms the window mid-turn messages
   * use; the agent's first turn content, not this call, opens it.
   */
  onSent?: () => void
): Promise<Awaited<ReturnType<AcpConnection['prompt']>> | null> {
  const prompt = connection.prompt(params)
  onSent?.()
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

/**
 * Say, in the transcript, that the agent did not run in the mode it was given.
 *
 * Only for the mode the desktop actually promises something about: `auto` is
 * "you will not be asked", and an agent that ran in anything else asked. The
 * other direction — asked for `default`, ran in `auto` — would be far worse,
 * and is why this does not check for equality only in one direction: any
 * disagreement is reported, in the words of whichever way it went.
 *
 * A notice, not a status line, because it belongs beside the turn it describes:
 * a panel would say it once, about whichever turn ran last, on a screen the
 * user may not be looking at.
 */
function noteModeFallback(
  plan: AcpLaunchPlan,
  reportedMode: string | null,
  stream: AcpMessageStream,
  emit: EmitMessage
): void {
  const asked = plan.setup.modeId
  if (!asked || !reportedMode || asked === reportedMode) return
  emit(
    stream.note(
      asked === 'auto'
        ? `Automatic approvals are not available here, so this turn asked before each action instead (the agent ran in “${reportedMode}”).`
        : `This agent asked to run in “${asked}” and the engine ran it in “${reportedMode}” instead.`
    ).message
  )
}

/**
 * The `session/update` kinds that mean the agent has started the turn, and so
 * open its steering window. A mode, command or usage update can precede a turn
 * the agent has not registered yet, and a steer sent then finds no turn to join.
 * So can a plan: `claude-agent-acp` (0.76.0) `prompt()` republishes the tasks an
 * earlier turn left before it queues the new turn.
 */
const TURN_CONTENT: ReadonlySet<string> = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'])

/**
 * Whether the agent advertised the steering extension: top-level
 * `initialize._meta.steering.supported` (the Claude Code and Codex adapters).
 */
function advertisesSteering(connection: AcpConnection): boolean {
  const steering = connection.initialized._meta?.steering
  return !!steering && typeof steering === 'object' && (steering as { supported?: unknown }).supported === true
}

/** The adapter's own notification about which login is paying for the turn. */
const AUTH_STATUS_METHOD = '_auth/status_update'

/**
 * The kind of login the agent reported, and its label — never the account.
 *
 * Structural, and deliberately narrow: it reads two strings out of a payload
 * whose third field is an email address. Anything else in there stays where it
 * is.
 */
function readAuthStatus(params: Record<string, unknown>): { kind: string; label: string | null } | null {
  const status = params.authStatus
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null
  const kind = (status as { kind?: unknown }).kind
  if (typeof kind !== 'string' || kind === '') return null
  const label = (status as { label?: unknown }).label
  return { kind, label: typeof label === 'string' && label !== '' ? scrubbed(label) : null }
}

/**
 * A string with anything email-shaped taken out of it.
 *
 * The label observed is a plan name (`Claude Max`), but the payload it arrives
 * in carries the account's email two fields away, and the one thing this driver
 * promises about that payload is that it does not pass the address on. A guard
 * rather than a comment, because the promise has to survive an adapter version
 * that decides the label should name the account.
 */
function scrubbed(text: string): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '…')
}

/**
 * Say, in the transcript, that the turn was not paid for by the login the user
 * chose.
 *
 * **`account` is the only kind that means "the install's own subscription".**
 * Anything else — an API key the environment carried in, a gateway — means
 * something reached the child that this app intended to strip, and the person
 * is being billed somewhere they did not pick. Silence when the agent reported
 * nothing: this app never asserts a subscription, it only reports when the
 * agent says otherwise.
 */
function noteForeignAuth(
  auth: { kind: string; label: string | null } | null,
  stream: AcpMessageStream,
  emit: EmitMessage
): void {
  if (!auth || auth.kind === 'account') return
  const what = auth.label ?? auth.kind
  emit(
    stream.note(
      `This turn did not run on the agent’s own login — it reported “${what}”. ` +
        'It may be billed to that account instead.'
    ).message
  )
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
  const { agent, runtime, input } = ctx
  try { runtime.validate(input.chatId) } catch { return { outcome: { outcome: 'cancelled' } } }
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
    runtime.validate(input.chatId)
    granted = runtime.isGranted(request)
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
    validate: () => ctx.runtime.validate(input.chatId),
    chatId: input.chatId,
    agentId: agent.id,
    kind: 'permission',
    // The ask travels with the registration so the answer path can scope a
    // grant to what was actually named, without a second parse.
    request
  })
  ctx.parkedRuntimes.set(requestId, ctx.runtime)
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
    ctx.runtime.validate(input.chatId)
    // Before the decision line, so the renderer stops offering the block before
    // it reads what was decided.
    if (world.turn.open) input.onEvent?.({ type: 'input_resolved', requestId, resolution })

    // **`rejected` is not a user saying no.** The registry settles with it when
    // the park times out or the turn ends underneath, and it *resolves* rather
    // than rejecting — so this is the expiry path, not the `catch` below.
    // Denying is the only safe answer either way, but the transcript must not
    // record "Denied" for a decision nobody made.
    if (resolution.kind === 'rejected') {
      return settle(
        world.turn.stopping ? 'Not answered — the turn was stopped.' : 'No answer — the request expired.',
        selected('reject')
      )
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
    ctx.parkedRuntimes.delete(requestId)
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
  try { ctx.runtime.validate(input.chatId) } catch { return { action: 'cancel' } }
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
    validate: () => ctx.runtime.validate(input.chatId),
    chatId: input.chatId,
    agentId: agent.id,
    kind: 'question'
  })
  ctx.parkedRuntimes.set(requestId, ctx.runtime)
  world.turn.parked.set(requestId, handle.cancel)
  // The call the question belongs to. The Claude adapter names its own
  // `AskUserQuestion` call here; the field is optional in the schema and an MCP
  // server's elicitation may name its tool call or nothing.
  const callId = (params as { toolCallId?: unknown }).toolCallId
  world.emit(
    world.stream.askQuestion(
      requestId,
      form.questions,
      typeof callId === 'string' && callId !== '' ? callId : undefined
    ).message
  )
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
    ctx.runtime.validate(input.chatId)
    if (world.turn.open) input.onEvent?.({ type: 'input_resolved', requestId, resolution })
    if (resolution.kind === 'question') {
      // The old OpenCode runner's own sentence, now shared with the inbox,
      // which renders the same record on a row answered with this chat closed.
      world.emit(
        world.stream.settleQuestion(
          requestId,
          describeQuestionAnswers(resolution.answers)
        ).message
      )
      return { action: 'accept', content: toElicitationContent(form, resolution.answers) }
    }
    world.emit(
      world.stream.settleQuestion(
        requestId,
        world.turn.stopping ? 'Not answered — the turn was stopped.' : 'No answer — the request expired.'
      ).message
    )
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
    ctx.parkedRuntimes.delete(requestId)
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
  deps: { rememberGrant(agentId: string, request: LocalPermissionRequest): boolean; resolveRequest: AcpDriverDeps['resolveRequest'] },
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
  deps: { rememberGrant(agentId: string, request: LocalPermissionRequest): boolean },
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
  ctx: TurnContext,
  accumulator: StreamPartsAccumulator,
  sessionId: string | null,
  error: string | undefined,
  /** The underlying detail, when the sentence above is not it. Kept apart, as `fail` keeps them. */
  raw?: string,
  completed = false,
  canceled = ctx.input.signal.aborted
): RunAgentTurnResult {
  if (sessionId) {
    try {
      ctx.runtime.validate(ctx.input.chatId)
      ctx.runtime.saveSession(ctx.input.chatId, sessionId)
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
  const note = completed && !error && !ctx.input.signal.aborted && ctx.input.handbackEligible &&
    ctx.runtime.type === 'folder' && ctx.runtime.folder.kind === 'kit' && ctx.runtime.folder.coordinatorHandback ? readHandbackNote(answer) : null
  return {
    ...(canceled ? { taskState: 'canceled' as const, stopReason: 'canceled' as const } : {}),
    ...(note ? { handback: { note } } : {}),
    text: answer || parts.map((part) => part.text).join(''),
    parts,
    notices: accumulator.snapshotNotices(),
    ...(ctx.steers.length ? { steers: ctx.steers.slice() } : {}),
    ...(sessionId ? { contextId: sessionId } : {}),
    ...(error ? { error: { message: error, raw: raw ?? error } } : {})
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
  const engine = launcher === 'claude' ? 'Claude Code' : launcher === 'codex' ? 'Codex' : 'the local engine'
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
