import { chatConductorService } from './chatConductorService'
import { runNestedAgentTurn } from './nestedAgentTurn'
import { nanoid } from 'nanoid'
import { taskRunnersByChat } from './taskRunnerState'
import { liveRunHub } from './liveRunHub'
import type { TurnCompletion, TurnOutcome } from './turnCompletion'
import { recordTurnResult, terminalEventOf } from './turnRecord'
import { taskRepo } from '../db/tasks'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { syncRepo } from '../db/sync'
import { messageRepo } from '../db/messages'
import { chatRepo } from '../db/chats'
import { chatAgentCursorRepo } from '../db/chatAgentCursors'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { agentService } from './agentService'
import { messageRoutingService } from './messageRoutingService'
import { a2aStreamingService } from './a2aStreamingService'
import { buildCatchUpPacket, buildTurnHeader, withCatchUp } from './threadContextService'
import { driverFor } from '../agents/drivers'
import { agentTitlesChat } from '../agents/drivers/acp/acpSessionTitle'
import { resolveCommandRunner } from './localAgents/commandService'
import { routingOf, type RoutableChat, type RunTarget } from '../../shared/chatRouting'
import { createLogger } from '../logger/logger'
import type { StreamPort } from './a2aStreamingService'
import type { RunSendPayload } from '../../shared/ipcPayloads'
import { isDesktopAuthored, type TurnInputOrigin } from '../../shared/turnOrigin'

import type { RunEvent } from '../../shared/runEvents'
import type { RunEventContext } from './inboxService'
import { activeRunsByChat as activeChats } from './runExecutionState'
import { handingOffChats } from './taskOperationState'
import { taskHandoffRepo } from '../db/taskHandoffs'
import { handoverRepo } from '../db/handovers'
import type { CoordinatorToolProvider } from './coordinatorToolProvider'
import type { AgentDriver, FollowUpScope, SteerFn } from '../agents/drivers/driver'
import type { AgentRow } from '../db/agents'
import type { TurnRun } from './a2aStreamingService'

const logger = createLogger('run')
export interface RunScope { profileUserId: string; settingsUserId: string }
export type RunObserver = (ctx: RunEventContext, event: RunEvent) => void
export interface RunOutcome extends TurnOutcome {
  runId: string
  accepted: boolean
  /** Durable Inbox addresses belonging to this run after dead reply cleanup. */
  inputRequestIds: string[]
  /** When present, request IDs are unknown and a runner must not advance. */
  inputRequestReadError?: string
}
export interface RunHandle {
  id: string
  /** Resolves after the user message is persisted, before execution starts. */
  accepted: Promise<void>
  /** Resolves when the stream closes, including the model's asynchronous loop. */
  completed: Promise<RunOutcome>
  cancel(): void
  /**
   * Hand a user message to this turn while it runs. `injected` when the turn
   * took it and saves it with its own rows; `saved` when the engine took it
   * after those rows were built, so it was saved here as a row of its own —
   * possibly after a view already read the chat; `unavailable` unless the
   * turn's driver offered mid-turn delivery and still does. Never rejects.
   */
  steer(content: string): Promise<'injected' | 'saved' | 'unavailable'>
  /**
   * The driver offers mid-turn delivery right now. It can go false and true
   * again within one turn: an ACP driver withdraws it while a tool call runs.
   */
  readonly steerable: boolean
  /**
   * Told each time the driver offers mid-turn delivery again while the run is
   * neither closed nor cancelled. Listeners are dropped when the run closes.
   */
  onSteerable(listener: () => void): () => void
  /** The agent answering this turn, once resolved; null for the local model or before routing. */
  readonly agentId: string | null
}

/** What {@link runExecutionService.adopt} hands the code that drives an adopted turn. */
export interface AdoptedRunIO {
  /** Aborted when the user stops the run. */
  signal: AbortSignal
  /** A live event for the chat's watchers. Nothing is saved. */
  post(event: RunEvent): void
  /** Record an event the way a live turn's observer does (an ask opening). Also posts it. */
  observe(event: RunEvent): void
  /**
   * Run the agent's turn again for a user row that is already saved: sent
   * with the row's id as its `messageId`, no new user row, its output saved
   * and streamed as any turn's. Resolves with the turn's outcome; never rejects.
   */
  resend(userMessageId: string): Promise<TurnOutcome>
}

/**
 * Who answers `payload` in `chat`: the routing rule every send goes by, with
 * the addressing only a `human` chat reads (and only it pays the two reads for).
 */
export function answererOf(chat: RoutableChat, payload: Pick<RunSendPayload, 'chatId' | 'addressedAgentId'>): RunTarget {
  const routing = routingOf(chat)
  if (routing.router !== 'human') return routing.answerer()
  return routing.answerer({
    addressed: payload.addressedAgentId,
    lastAddressed: messageRepo.lastAddressedAgentId(payload.chatId),
    attached: chatOnDemandAgentRepo.listAgentIds(payload.chatId)
  })
}

/**
 * The asks a closed run leaves behind: the ids a runner or the next message
 * still answers, and whether any live reply address was left dead or the
 * rows could not be read. Every run close reads it the same way.
 */
export function remainingRunRequests(chatId: string, runId: string): { inputRequestIds: string[]; inputRequestReadError?: string } {
  try {
    const requests = taskInputRequestRepo.listOpenForRun(chatId, runId)
    const inputRequestIds = requests.filter((row) => row.resume === 'next_message' || row.deliveryOwner === 'runner').map((row) => row.id)
    if (requests.some((row) => row.resume === 'reply' && row.deliveryOwner !== 'runner')) {
      return { inputRequestIds, inputRequestReadError: 'The turn left input requests whose live reply addresses have closed.' }
    }
    return { inputRequestIds }
  } catch (error) {
    logger.warn('could not read remaining turn requests', { chatId, error: String(error) })
    return { inputRequestIds: [], inputRequestReadError: 'The turn could not read its remaining input requests.' }
  }
}

/** Main owns the turn. A renderer is an optional subscriber, never its lifetime. */
export const runExecutionService = {
  answererOf,

  isRunning(chatId: string): boolean { return activeChats.has(chatId) || !!taskRunnersByChat.get(chatId)?.working },

  cancelChat(userId: string, chatId: string): void {
    if (!chatRepo.getOwned(userId, chatId)) throw new Error('Chat not found')
    const runner = taskRunnersByChat.get(chatId)
    if (runner?.userId === userId) runner.cancel()
    else activeChats.get(chatId)?.cancel()
  },

  /**
   * Show a turn that is not a send as the chat's running turn: a turn the app
   * was closed under, being collected from its agent. It holds the chat as
   * `start` does — the sidebar spinner, the live view, Stop (which aborts
   * `io.signal`, and a resent turn), and the queue for messages sent
   * meanwhile — but saves nothing and records no result of its own: `drive`
   * writes the rows and settles the bookkeeping before it resolves, and the
   * run closes after that. Throws, and opens nothing, when the chat is busy.
   * `hiddenMessageIds` are left out of the live view's baseline: rows `drive`
   * will replace, which the live replay stands in for until then.
   */
  adopt(scope: RunScope, input: { chatId: string; agentId: string; runId: string; observe: RunObserver; hiddenMessageIds?: string[] },
    drive: (io: AdoptedRunIO) => Promise<TurnOutcome>): RunHandle {
    const { chatId, agentId, runId } = input
    if (activeChats.has(chatId) || taskRunnersByChat.has(chatId) || handingOffChats.has(chatId) ||
      taskHandoffRepo.unresolvedForChat(scope.profileUserId, chatId)) {
      throw new Error('This conversation already has a turn running.')
    }
    if (!chatRepo.getOwned(scope.profileUserId, chatId)) throw new Error('Chat not found')
    const hidden = new Set(input.hiddenMessageIds ?? [])
    const live = liveRunHub.begin(scope.profileUserId, chatId, runId,
      chatRepo.listMessageIds(chatId).filter((id) => !hidden.has(id)))
    live.setAgentId(agentId)
    const controller = new AbortController()
    let complete!: (outcome: RunOutcome) => void
    let closed = false
    let terminalPosted = false
    let requestId: string | null = null
    const ctx: RunEventContext = { userId: scope.profileUserId, chatId, agentId, turnId: runId, rootRunId: runId, completionOwner: 'turn' }
    const handle: RunHandle = {
      id: runId,
      accepted: Promise.resolve(),
      completed: new Promise<RunOutcome>((resolve) => { complete = resolve }),
      cancel() {
        controller.abort()
        if (requestId) a2aStreamingService.cancel(requestId)
      },
      agentId,
      steerable: false,
      onSteerable: () => () => {},
      steer: async () => 'unavailable'
    }
    activeChats.set(chatId, handle)
    live.accepted()
    const post = (event: RunEvent): void => {
      if (closed) return
      if (event.type === 'request-id') {
        requestId = event.requestId
        if (controller.signal.aborted) a2aStreamingService.cancel(requestId)
      }
      if (event.type === 'done' || event.type === 'error') terminalPosted = true
      live.push(event)
    }
    const observe = (event: RunEvent): void => {
      try { input.observe(ctx, event) } catch (error) {
        logger.warn('run observer failed', { chatId, error: String(error) })
      }
    }
    const io: AdoptedRunIO = {
      signal: controller.signal,
      post,
      observe(event) {
        if (closed) return
        observe(event)
        post(event)
      },
      resend: (userMessageId) => new Promise<TurnOutcome>((resolve) => {
        let settled = false
        const finish: TurnCompletion = (outcome) => {
          if (settled) return
          settled = true
          resolve(outcome)
        }
        const port: StreamPort = {
          // The driver's asks are recorded as a live turn's are. Its ending is
          // not: `drive` settles the turn once, with its own bookkeeping.
          postMessage(event) {
            if (event.type !== 'done' && event.type !== 'error') observe(event)
            post(event)
          },
          close() {}
        }
        resendAgentTurn(port, { chatId, profileUserId: scope.profileUserId, settingsUserId: scope.settingsUserId, agentId, userMessageId, finish })
          .catch((error) => logger.error('a resent turn failed', { chatId, error: String(error) }))
          .finally(() => finish({ state: 'failed', text: '', error: { message: 'The resent turn ended without an outcome.' } }))
      })
    }
    const close = (outcome: TurnOutcome): void => {
      if (closed) return
      if (!terminalPosted) post(terminalEventOf(outcome))
      closed = true
      if (activeChats.get(chatId) === handle) activeChats.delete(chatId)
      let inputRequestIds: string[] = []
      try {
        inputRequestIds = taskInputRequestRepo.listOpenForRun(chatId, runId)
          .filter((row) => row.resume === 'next_message' || row.deliveryOwner === 'runner').map((row) => row.id)
      } catch (error) {
        logger.warn('could not read remaining turn requests', { chatId, error: String(error) })
      }
      live.close()
      complete({ ...outcome, state: outcome.state === 'completed' && inputRequestIds.length ? 'needs_input' : outcome.state,
        runId, accepted: true, inputRequestIds })
    }
    void Promise.resolve()
      .then(() => drive(io))
      .then(close, (error) => {
        logger.error('an adopted run failed', { chatId, error: error instanceof Error ? error.message : String(error) })
        close({ state: 'failed', text: '', error: { message: error instanceof Error ? error.message : String(error) } })
      })
    return handle
  },

  start(scope: RunScope, payload: RunSendPayload, options: {
    observe: RunObserver
    port?: StreamPort
    /** Runs inside the message transaction. Must contain only local bookkeeping. */
    onAccepted?: (ctx: RunEventContext) => void
    /** Inbox retry: a refused answer must leave the prior waiting request intact. */
    preserveOnRefusal?: boolean
    /** Internal continuation targets the agent that owns the waiting ask. */
    agentId?: string
    /** Internal runner admission. Never accepted from an IPC payload. */
    runnerTaskId?: string
    /** Internal eligibility for the current handed-off owner's completed answer. */
    handbackEligible?: boolean
    toolCallBudget?: import('../agents/drivers/driver').RunInput['toolCallBudget']
    nested?: { toolCallId: string }
    coordinator?: CoordinatorToolProvider
    inputOrigin?: TurnInputOrigin
  }): RunHandle {
    if (options.handbackEligible && (!options.runnerTaskId || !options.agentId || options.coordinator)) {
      throw new Error('Handback requires a handed-off agent owned by a task runner.')
    }
    // **`runner` only.** A `handover` turn is a report coming back from another
    // project: it writes into the chat the requester was talking in and owns no
    // task runner, so requiring one here would refuse every return packet.
    if ((options.coordinator || options.inputOrigin === 'runner') && !options.runnerTaskId) {
      throw new Error('Coordinator tools require an owning task runner.')
    }
    if (handingOffChats.has(payload.chatId) || taskHandoffRepo.unresolvedForChat(scope.profileUserId, payload.chatId)) {
      throw new Error('This conversation has a pending remote handoff. Resolve it on the task page first.')
    }
    const reservation = taskRunnersByChat.get(payload.chatId)
    if (reservation && (reservation.userId !== scope.profileUserId || reservation.taskId !== options.runnerTaskId)) {
      throw new Error('This conversation belongs to an autonomous task. Answer in the Inbox or use the task controls.')
    }
    if (activeChats.has(payload.chatId)) throw new Error('This conversation already has a turn running.')
    const chat = chatRepo.getOwned(scope.profileUserId, payload.chatId)
    if (!chat) throw new Error('Chat not found')
    if (options.coordinator && (routingOf(chat).router !== 'coordinator' || options.agentId)) {
      throw new Error('Coordinator tools are only available to the coordinator model.')
    }
    if (options.runnerTaskId) {
      const task = taskRepo.getById(scope.profileUserId, options.runnerTaskId)
      if (!task || task.deletedAt || !['in_progress', 'blocked'].includes(task.status) ||
        task.chatId !== payload.chatId || task.executor !== 'desktop' ||
        task.executorDevice !== (syncRepo.getState(scope.profileUserId)?.deviceId ?? null)) {
        throw new Error('This runner does not own the task conversation on this device.')
      }
    }
    const runId = nanoid()
    const live = liveRunHub.begin(scope.profileUserId, payload.chatId, runId,
      chatRepo.listMessageIds(payload.chatId))
    let accept!: () => void
    let refuse!: (error: Error) => void
    let complete!: (outcome: RunOutcome) => void
    let outcome: TurnOutcome | null = null
    let accepted = false
    let closed = false
    let requestId: string | null = null
    let cancelRequested = false
    let failure: string | null = null
    let context: RunEventContext | null = null
    let terminalObserved = false
    let steerFn: SteerFn | null = null
    const steerableListeners = new Set<() => void>()
    const handle: RunHandle = {
      id: runId,
      accepted: new Promise<void>((resolve, reject) => { accept = resolve; refuse = reject }),
      completed: new Promise<RunOutcome>((resolve) => { complete = resolve }),
      cancel() {
        cancelRequested = true
        steerFn = null
        if (requestId) {
          a2aStreamingService.cancel(requestId)
        }
      },
      get agentId() {
        return context?.agentId ?? null
      },
      get steerable() {
        return !!steerFn && !closed && !cancelRequested
      },
      onSteerable(listener) {
        if (closed) return () => {}
        steerableListeners.add(listener)
        return () => { steerableListeners.delete(listener) }
      },
      async steer(content) {
        const steer = steerFn
        if (!steer || closed || cancelRequested) return 'unavailable'
        const agentId = context?.agentId ?? null
        let outcome: Awaited<ReturnType<SteerFn>>
        try { outcome = await steer(content) } catch (error) {
          logger.warn('a mid-turn message failed', { chatId: payload.chatId, error: String(error) })
          return 'unavailable'
        }
        if (outcome !== 'late') return outcome
        // The engine has the message, but the turn's rows were already built
        // without it. Keep the user's words in the transcript on their own.
        logger.warn('a mid-turn message landed after the turn was saved; saving it separately', { chatId: payload.chatId })
        try {
          messageRepo.saveUser({ chatId: payload.chatId, content, addressedAgentId: agentId })
          messageRepo.touchChat(payload.chatId)
        } catch (error) {
          logger.warn('a late mid-turn message could not be saved', { chatId: payload.chatId, error: String(error) })
          // No row to show, and the engine already has it: sending it again would say it twice.
          return 'injected'
        }
        return 'saved'
      }
    }
    // The IPC caller need not await acceptance, but headless callers can.
    void handle.accepted.catch(() => {})
    activeChats.set(payload.chatId, handle)
    const finish: TurnCompletion = (result) => {
      if (outcome) return
      outcome = result
    }
    const port: StreamPort = {
      postMessage(event) {
        if (closed) return
        if (event.type === 'request-id') {
          requestId = event.requestId
          if (cancelRequested) handle.cancel()
        }
        if (event.type === 'error') failure = event.error
        live.push(event)
        try { options.port?.postMessage(event) } catch {
          // A closed view is only a lost subscriber. Persistence and asks live on.
        }
      },
      close() {
        if (closed) return
        if (!outcome) finish({ state: 'failed', text: '', error: { message: failure ?? 'The turn closed without a terminal outcome.' } })
        if (!terminalObserved && context) {
          const event: RunEvent = terminalEventOf(outcome!)
          observe(context, event)
          port.postMessage(event)
        }
        closed = true
        steerFn = null
        steerableListeners.clear()
        if (!accepted) refuse(new Error(failure ?? 'The turn could not be started.'))
        if (activeChats.get(payload.chatId) === handle) activeChats.delete(payload.chatId)
        try { options.port?.close() } catch { /* subscriber already disconnected */ }
        const { inputRequestIds, inputRequestReadError } = remainingRunRequests(payload.chatId, handle.id)
        const result = outcome!
        const final: RunOutcome = { ...result, state: result.state === 'completed' && inputRequestIds.length ? 'needs_input' : result.state,
          runId: handle.id, accepted, inputRequestIds, ...(inputRequestReadError ? { inputRequestReadError } : {}) }
        // A runner owns the session outcome: a successful leaf may continue,
        // and its cancellation can be the controller enforcing a time limit.
        // The boot pass records a killed turn through the same function.
        if (!options.runnerTaskId && !options.nested && (accepted || !options.preserveOnRefusal)) {
          recordTurnResult(payload.chatId, handle.id, final, { canceled: cancelRequested })
        }
        live.close()
        complete(final)
      }
    }
    const observe: RunObserver = (ctx, event) => {
      if (closed || (!accepted && options.preserveOnRefusal && event.type === 'error')) return
      if (event.type === 'done' || event.type === 'error') terminalObserved = true
      try { options.observe({ ...ctx, turnId: handle.id, rootRunId: handle.id, completionOwner: options.runnerTaskId ? 'runner' : 'turn' }, event) } catch (error) {
        logger.warn('run observer failed', { chatId: ctx.chatId, error: String(error) })
      }
    }
    const refusal = (_chatId: string, message: string): void => {
      finish({ state: 'failed', text: '', error: { message } })
    }
    void resolveAndRun(port, payload, scope, chat, {
      observe,
      finish,
      context: (ctx) => { context = ctx; live.setAgentId(ctx.agentId) },
      persisted: (ctx) => options.onAccepted?.({ ...ctx, turnId: handle.id, rootRunId: handle.id, completionOwner: options.runnerTaskId ? 'runner' : 'turn' }),
      accepted: () => { accepted = true; accept(); live.accepted() },
      registerSteer: (steer) => {
        steerFn = closed || cancelRequested ? null : steer
        if (!steerFn) return
        // The queue learns the turn can take a message again, at a tool boundary.
        for (const listener of [...steerableListeners]) {
          try { listener() } catch (error) {
            logger.warn('a steerable listener failed', { chatId: payload.chatId, error: String(error) })
          }
        }
      },
      refusal,
      agentId: options.agentId,
      coordinator: options.coordinator,
      nested: options.nested,
      toolCallBudget: options.toolCallBudget,
      inputOrigin: options.inputOrigin,
      runnerOwned: !!options.runnerTaskId,
      handbackEligible: options.handbackEligible
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (context) observe(context, { type: 'error', error: message })
      port.postMessage({ type: 'error', error: message })
      finish({ state: 'failed', text: '', error: { message } })
      port.close()
      if (context) refusal(payload.chatId, message)
    })
    return handle
  }
}

interface RunLifecycle {
  toolCallBudget?: import('../agents/drivers/driver').RunInput['toolCallBudget']
  nested?: { toolCallId: string }
  handbackEligible?: boolean
  runnerOwned: boolean
  inputOrigin?: TurnInputOrigin
  observe: RunObserver
  finish: TurnCompletion
  agentId?: string
  coordinator?: CoordinatorToolProvider
  context(ctx: RunEventContext): void
  persisted(ctx: RunEventContext): void
  accepted(): void
  /** The driver offering (a function) or withdrawing (`null`) mid-turn delivery. */
  registerSteer(steer: SteerFn | null): void
  refusal(chatId: string, message: string): void
}

async function resolveAndRun(
  port: StreamPort,
  payload: RunSendPayload,
  scope: RunScope,
  chat: NonNullable<ReturnType<typeof chatRepo.getOwned>>,
  lifecycle: RunLifecycle
): Promise<void> {
  const { chatId, content: userContent, attachments } = payload
  const { profileUserId, settingsUserId } = scope
  lifecycle.context({ userId: profileUserId, chatId, agentId: null })
  if (!chat.agentId && chat.router !== 'human' && !lifecycle.agentId) chat = chatConductorService.bind(profileUserId, chat)
  const routing = routingOf(chat)
  const target: RunTarget = lifecycle.agentId
    ? { kind: 'agent' as const, agentId: lifecycle.agentId }
    : answererOf(chat, payload)
  if (target.kind !== 'agent') throw new Error('This conversation has no configured runtime.')

  // Every event is observed once whether or not a renderer is attached, which makes this the one place
  // that sees a `needs_input` from any driver, in any router — including one a
  // nested agent raised, which arrives wrapped in a `child`. The alternative
  // was a hook in each streaming service, which is two places that would have
  // to agree about a third (the orchestrated path) forever.
  const context: RunEventContext = {
    userId: profileUserId, chatId, agentId: target.agentId
  }
  lifecycle.context(context)
  const observed = observeAsks(port, context, lifecycle.observe)

  await runAgentTurn(observed, {
    chatId,
    profileUserId,
    settingsUserId,
    persisted: () => lifecycle.persisted(context),
    accepted: () => lifecycle.accepted(),
    registerSteer: lifecycle.registerSteer,
    refusal: lifecycle.refusal,
    finish: lifecycle.finish,
    inputOrigin: lifecycle.inputOrigin,
    includeToolResults: lifecycle.runnerOwned,
    runnerOwned: lifecycle.runnerOwned,
    queueWhenBusy: lifecycle.runnerOwned,
    handbackEligible: lifecycle.handbackEligible,
    nested: lifecycle.nested,
    toolCallBudget: lifecycle.toolCallBudget,
    coordinator: lifecycle.coordinator,
    agentId: target.agentId,
    userContent,
    attachments,
    // Coordinators retain their ACP session while specialists own the chat.
    // On return, their cursor must catch up with those specialists' messages.
    catchUp: routing.router !== 'direct' || (!!lifecycle.agentId && chat.agentId !== lifecycle.agentId)
  })
}

/**
 * The same port, with every event mirrored into the inbox on the way past.
 *
 * Recording happens **before** the event is forwarded, so an ask the renderer
 * answers the instant it renders finds its row already there. It cannot fail
 * the turn: `recordRunEvent` swallows its own errors, by contract.
 */
function observeAsks(port: StreamPort, ctx: RunEventContext, observe: RunObserver): StreamPort {
  return {
    postMessage(msg) {
      observe(ctx, msg)
      port.postMessage(msg)
    },
    close() { port.close() }
  }
}

interface AgentTurnInput {
  toolCallBudget?: import('../agents/drivers/driver').RunInput['toolCallBudget']
  nested?: { toolCallId: string }
  coordinator?: CoordinatorToolProvider
  handbackEligible?: boolean
  /** A task runner owns this turn's outcome, and its checkpoint is the in-flight record. */
  runnerOwned?: boolean
  queueWhenBusy?: boolean
  includeToolResults?: boolean
  inputOrigin?: TurnInputOrigin
  chatId: string
  profileUserId: string
  settingsUserId: string
  persisted: () => void
  accepted: () => void
  registerSteer?: (steer: SteerFn | null) => void
  refusal: (chatId: string, message: string) => void
  finish: TurnCompletion
  agentId: string
  userContent: string
  attachments: RunSendPayload['attachments']
  catchUp: boolean
}

async function runAgentTurn(port: StreamPort, input: AgentTurnInput): Promise<void> {
  const { chatId, profileUserId, settingsUserId, agentId, userContent, attachments, catchUp } = input
  const fileIds = attachments?.map((a) => a.id)

  const located = agentService.findAgent(settingsUserId, profileUserId, agentId)
  if (!located) {
    const err = 'Agent not found or not configured'
    logger.error(err, { agentId, chatId })
    port.postMessage({ type: 'error', error: err })
    messageRepo.saveError({ chatId, short: err })
    input.finish({ state: 'failed', text: '', error: { message: err } })
    port.close()
    input.refusal(chatId, err)
    return
  }
  const { row: agent, userId: agentOwnerId } = located

  // **No kind-specific pre-flight here.** The card check, endpoint and token
  // resolution and the Cinna re-auth mapping all run inside the driver's `run`,
  // which reports each as `result.error` — so a failure there arrives after the
  // user's message is persisted and is finalized like any failed turn.
  const driver = driverFor(agent)

  // The catch-up packet is built **before** the user row is persisted, so the
  // message being sent right now cannot appear in the transcript of what the
  // agent missed. (`renderRow` drops it too, by its `addressedAgentId` — belt
  // and braces, because the two guards fail in opposite directions and this one
  // is the cheap one.)
  const packet = catchUp
    ? buildCatchUpPacket({
        messages: chatRepo.listMessages(chatId),
        agentId,
        cursorMessageId: chatAgentCursorRepo.get(chatId, agentId)?.lastMessageId ?? null,
        names: agentNames(settingsUserId, profileUserId),
        includeToolResults: input.includeToolResults
      })
    : null

  // Persist the user message + fire title generation in one place. The message
  // is stored as the user typed it; the packet travels on the wire only.
  // A chat whose root runs on Codex is named by Codex's own thread title.
  const engineTitles = !input.nested && agentTitlesChat(agent)
    && routingOf(chatRepo.getOwned(profileUserId, chatId) ?? {}).rootAgentId === agentId
  const { wireContent, userMessageId } = messageRoutingService.prepareAgentSend({
    userId: profileUserId,
    chatId,
    agentId,
    userContent,
    attachments,
    engineTitles,
    origin: input.inputOrigin,
    onPersisted: input.persisted
  })
  input.accepted()

  // `/run:<name>` is intercepted before the driver: see `bindTurn`.
  const run = bindTurn({
    driver,
    agent,
    agentOwnerId,
    chatId,
    wireContent,
    packet,
    turnHeader: turnHeaderFor({ driver, agent, profileUserId, chatId }),
    fileIds,
    attachments,
    // The user row's id is the A2A `messageId`: the Cinna backend echoes
    // it back in `tasks/get` history and deduplicates a resend by it. A
    // desktop-authored send (a runner's prompt, a handover's return packet)
    // stores a system row instead, so it sends none.
    messageId: isDesktopAuthored(input.inputOrigin) ? undefined : userMessageId,
    queueWhenBusy: input.queueWhenBusy,
    handbackEligible: input.handbackEligible,
    nested: input.nested,
        toolCallBudget: input.toolCallBudget,
    coordinator: input.coordinator,
    registerSteer: input.registerSteer,
    runScope: { profileUserId, settingsUserId }
  })

  await handOff(port, () =>
    a2aStreamingService.streamToAgent({
      run,
      chatId,
      agentId,
      port,
      onFinished: input.finish,
      ...(input.runnerOwned ? {} : {
        // **Null for anything the desktop authored.** The marker's id is what
        // recovery offers to send again, and `interruptedTurnService` matches
        // it against a **user** row: a handover's return packet stored a system
        // row, so naming it here would greet the user on relaunch with "the app
        // closed while your message was being answered" about a message nobody
        // typed, and a remote resend would carry an id `resendAgentTurn`
        // refuses. Not `runnerOwned`, which also decides `includeToolResults`
        // and `queueWhenBusy`.
        marker: {
          profileId: profileUserId,
          userMessageId: isDesktopAuthored(input.inputOrigin) ? null : userMessageId ?? null,
          driver: driver.id
        }
      }),
      // Only a turn that finished moves the cursor. A failed or stopped one
      // leaves the gap for the retry to carry.
      onCompleted: () => {
        const last = messageRepo.lastId(chatId)
        if (last) chatAgentCursorRepo.advance(chatId, agentId, last)
        if (!isDesktopAuthored(input.inputOrigin)) messageRoutingService.retryTitleAfterTurn(profileUserId, chatId, engineTitles)
      }
    }),
    (message) => input.refusal(chatId, message)
  )
}

/**
 * The turn a driver runs for one message, or the `/run:` command it names.
 *
 * `/run:<name>` for an agent whose commands come from a folder catalog is
 * intercepted **here**, before the driver is ever reached — OpenCode has no
 * such convention, so the desktop itself has to recognise the message.
 * Deliberately not inside the driver: a command is not a model turn. See
 * `resolveCommandRunner`'s own docstring for why the decision lives there.
 *
 * It matches on the *typed* text, not on the packet in front of it: a
 * `/run:` prefixed by a catch-up transcript is still the command the user
 * typed, and a packet is never built for one anyway (a command runs a script
 * on this machine, so there is nothing to catch it up on).
 */
/**
 * The wire-only turn header for this turn, or null.
 *
 * `capabilities.cwd` is the question being asked: only an agent running in a
 * folder on this machine can act on a chat id or a handover depth, because
 * acting on them means writing `.cinna/handovers/<id>/brief.md` somewhere. A
 * remote A2A or Managed agent has no path on this disk, so it is told nothing
 * — the header is free of tokens, but it is still noise in a prompt that
 * cannot use it.
 *
 * Depth comes from the chain this chat is already in: the chat's task, and the
 * handover row that task belongs to. No task, or a task nobody handed over, is
 * depth 0 — which is what makes a brief written from this turn depth 1.
 */
function turnHeaderFor(input: {
  driver: AgentDriver
  agent: AgentRow
  profileUserId: string
  chatId: string
}): string | null {
  if (!input.driver.capabilities(input.agent).cwd) return null
  let taskId: string | null = null
  let depth = 0
  try {
    const task = taskRepo.getByChatId(input.profileUserId, input.chatId)
    taskId = task?.id ?? null
    if (task) depth = handoverRepo.byTaskId(input.profileUserId, task.id)?.depth ?? 0
  } catch (error) {
    // A header is context, never a precondition: a turn still runs without it.
    logger.warn('the turn header could not be built', {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return buildTurnHeader({ chatId: input.chatId, taskId, depth })
}

function bindTurn(input: {
  toolCallBudget?: import('../agents/drivers/driver').RunInput['toolCallBudget']
  attachments?: RunSendPayload['attachments']
  nested?: { toolCallId: string }
  coordinator?: CoordinatorToolProvider
  driver: AgentDriver
  agent: AgentRow
  agentOwnerId: string
  chatId: string
  wireContent: string
  packet: string | null
  fileIds?: string[]
  messageId?: string
  queueWhenBusy?: boolean
  handbackEligible?: boolean
  registerSteer?: (steer: SteerFn | null) => void
  /** Wire-only turn context, in front of everything else. */
  turnHeader?: string | null
  /** The chat's scope, for a follow-up turn the agent starts after this one. */
  runScope?: FollowUpScope
}): TurnRun {
  const { driver, agent, agentOwnerId, wireContent } = input
  return resolveCommandRunner(
    driver.capabilities(agent).commands,
    wireContent,
    agentOwnerId,
    agent.id,
    (io) =>
      (input.nested ? (owner: string, row: AgentRow, runInput: import('../agents/drivers/driver').RunInput) => runNestedAgentTurn(driver, owner, row, { ...runInput, nested: input.nested! }) : driver.run.bind(driver))(agentOwnerId, agent, {
        chatId: input.chatId,
        nested: input.nested,
        toolCallBudget: input.toolCallBudget,
        coordinator: input.coordinator,
        // Header, then the catch-up packet, then what the user sent. Both
        // prefixes are wire-only by construction: the row was persisted from
        // `wireContent` alone, before this call.
        wireContent: withCatchUp(input.turnHeader ?? null, withCatchUp(input.packet, wireContent)),
        fileIds: input.fileIds,
        attachments: input.attachments,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        signal: io.signal,
        flush: io.flush,
        ...(input.queueWhenBusy ? { queueWhenBusy: true } : {}),
        ...(input.handbackEligible ? { handbackEligible: true } : {}),
        ...(input.registerSteer ? { registerSteer: input.registerSteer } : {}),
        ...(io.registerSnapshot ? { registerSnapshot: io.registerSnapshot } : {}),
        ...(input.runScope ? { runScope: input.runScope } : {}),
        onEvent: io.onEvent
      })
  )
}

/**
 * The agent's turn for a user row that is already saved — a send the agent
 * never received. Built as {@link runAgentTurn} builds a send, from the row
 * (its text, its files, the catch-up of what came before it), with the row's
 * id as the `messageId`, and saved and streamed by the same wrapper. No marker:
 * the turn being recovered keeps its own until it is settled.
 */
async function resendAgentTurn(port: StreamPort, input: {
  chatId: string
  profileUserId: string
  settingsUserId: string
  agentId: string
  userMessageId: string
  finish: TurnCompletion
}): Promise<void> {
  const { chatId, profileUserId, settingsUserId, agentId, userMessageId } = input
  const fail = (message: string): void => {
    logger.error(message, { chatId, agentId })
    input.finish({ state: 'failed', text: '', error: { message } })
  }
  /** The error row a resend that never streamed leaves: all the transcript keeps of the turn. */
  const saveErrorRow = (message: string): void => {
    try {
      messageRepo.saveError({ chatId, short: message })
    } catch (error) {
      logger.error('a refused resend could not save its error', { chatId, error: String(error) })
    }
  }
  /**
   * A resend that fails before it streams: the turn's rows were removed for
   * it, so the error row is what the transcript keeps of it, and the error
   * event ends the live view.
   */
  const refuse = (message: string): void => {
    saveErrorRow(message)
    port.postMessage({ type: 'error', error: message })
    fail(message)
  }
  const located = agentService.findAgent(settingsUserId, profileUserId, agentId)
  if (!located) return refuse('Agent not found or not configured')
  const chat = chatRepo.getOwned(profileUserId, chatId)
  const messages = chatRepo.listMessages(chatId)
  const row = messages.find((message) => message.id === userMessageId)
  if (!chat || !row || row.role !== 'user') return refuse('The message to send again is no longer in the chat.')
  const { row: agent, userId: agentOwnerId } = located
  let run: ReturnType<typeof bindTurn>
  try {
    const catchUp = routingOf(chat).router !== 'direct' || chat.agentId !== agentId
    const packet = catchUp
      ? buildCatchUpPacket({
          messages: messages.filter((message) => message.sortOrder < row.sortOrder),
          agentId,
          cursorMessageId: chatAgentCursorRepo.get(chatId, agentId)?.lastMessageId ?? null,
          names: agentNames(settingsUserId, profileUserId)
        })
      : null
    const driver = driverFor(agent)
    run = bindTurn({
      driver,
      agent,
      agentOwnerId,
      chatId,
      wireContent: row.content,
      packet,
      turnHeader: turnHeaderFor({ driver, agent, profileUserId, chatId }),
      fileIds: row.attachments?.map((attachment) => attachment.id),
      messageId: userMessageId,
      runScope: { profileUserId, settingsUserId }
    })
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  await handOff(port, () =>
    a2aStreamingService.streamToAgent({
      run,
      chatId,
      agentId,
      port,
      // A recovery's turn: its rows land without moving the chat up the list.
      touchChat: false,
      onFinished: input.finish,
      onCompleted: () => {
        const last = messageRepo.lastId(chatId)
        if (last) chatAgentCursorRepo.advance(chatId, agentId, last)
      }
    }),
    // `handOff` has posted the error event already; only the row is missing.
    (message) => {
      saveErrorRow(message)
      fail(message)
    }
  )
}

/**
 * Streaming wrappers normally own their terminal event, persistence and close.
 * An unexpected throw still gets an observed ending and job cleanup. The main
 * port suppresses events after close, so an already-ended stream is untouched.
 */
async function handOff(
  port: StreamPort,
  run: () => Promise<unknown>,
  refusal: (message: string) => void
): Promise<void> {
  try {
    await run()
  } catch (err) {
    port.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    port.close()
    refusal(err instanceof Error ? err.message : String(err))
    logger.error('a stream failed after it owned the port', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    })
  }
}

/**
 * Display names for the transcript labels in a catch-up packet.
 *
 * Built from the merged agent list rather than looked up per row: a packet
 * names every agent that spoke in the gap, and one query is cheaper than one
 * per line. An agent whose row is gone keeps its turn in the packet under a
 * generic label — the words it said are the point, not who it was.
 */
function agentNames(settingsUserId: string, profileUserId: string): Map<string, string> {
  const names = new Map<string, string>()
  try {
    for (const agent of agentService.listMerged(settingsUserId, profileUserId)) {
      names.set(agent.id, agent.name)
    }
  } catch (err) {
    logger.warn('could not read agent names for a catch-up packet', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
  return names
}
