import { nanoid } from 'nanoid'
import { taskRunnersByChat } from './taskRunnerState'
import { liveRunHub } from './liveRunHub'
import { reportStandaloneTurn, type TurnCompletion, type TurnOutcome } from './turnCompletion'
import { taskRepo } from '../db/tasks'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { syncRepo } from '../db/sync'
import { messageRepo } from '../db/messages'
import { chatRepo } from '../db/chats'
import { chatRunResultRepo } from '../db/chatRunResults'
import { chatAgentCursorRepo } from '../db/chatAgentCursors'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { agentService } from './agentService'
import { messageRoutingService } from './messageRoutingService'
import { a2aStreamingService } from './a2aStreamingService'
import { chatStreamingService } from './chatStreamingService'
import { buildCatchUpPacket, withCatchUp } from './threadContextService'
import { driverFor } from '../agents/drivers'
import { resolveCommandRunner } from './localAgents/commandService'
import { routingOf, type RoutableChat, type RunTarget } from '../../shared/chatRouting'
import { createLogger } from '../logger/logger'
import type { StreamPort } from './a2aStreamingService'
import type { RunSendPayload } from '../../shared/ipcPayloads'

import type { RunEvent } from '../../shared/runEvents'
import type { RunEventContext } from './inboxService'
import { activeRunsByChat as activeChats } from './runExecutionState'
import { handingOffChats } from './taskOperationState'
import { taskHandoffRepo } from '../db/taskHandoffs'
import type { CoordinatorToolProvider } from './coordinatorToolProvider'
import type { SteerFn } from '../agents/drivers/driver'

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
    coordinator?: CoordinatorToolProvider
    inputOrigin?: 'user' | 'runner'
  }): RunHandle {
    if (options.handbackEligible && (!options.runnerTaskId || !options.agentId || options.coordinator)) {
      throw new Error('Handback requires a handed-off agent owned by a task runner.')
    }
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
          chatStreamingService.cancel(requestId)
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
          const result = outcome!
          const event: RunEvent = result.state === 'failed'
            ? { type: 'error', error: result.error?.message ?? 'The turn failed.' }
            : { type: 'done', stopReason: result.state === 'canceled' ? 'canceled' : result.state === 'budget' ? 'budget' : 'end_turn' }
          observe(context, event)
          port.postMessage(event)
        }
        closed = true
        steerFn = null
        steerableListeners.clear()
        if (!accepted) refuse(new Error(failure ?? 'The turn could not be started.'))
        if (activeChats.get(payload.chatId) === handle) activeChats.delete(payload.chatId)
        try { options.port?.close() } catch { /* subscriber already disconnected */ }
        let inputRequestIds: string[] = []
        let inputRequestReadError: string | undefined
        try {
          const requests = taskInputRequestRepo.listOpenForRun(payload.chatId, handle.id)
          inputRequestIds = requests.filter((row) => row.resume === 'next_message' || row.deliveryOwner === 'runner').map((row) => row.id)
          if (requests.some((row) => row.resume === 'reply' && row.deliveryOwner !== 'runner')) {
            inputRequestReadError = 'The turn left input requests whose live reply addresses have closed.'
          }
        }
        catch (error) {
          inputRequestReadError = 'The turn could not read its remaining input requests.'
          logger.warn('could not read remaining turn requests', { chatId: payload.chatId, error: String(error) })
        }
        const result = outcome!
        const final: RunOutcome = { ...result, state: result.state === 'completed' && inputRequestIds.length ? 'needs_input' : result.state,
          runId: handle.id, accepted, inputRequestIds, ...(inputRequestReadError ? { inputRequestReadError } : {}) }
        try {
          // A runner owns the session outcome: a successful leaf may continue,
          // and its cancellation can be the controller enforcing a time limit.
          if (!options.runnerTaskId && (accepted || !options.preserveOnRefusal)) {
            chatRunResultRepo.record(payload.chatId, handle.id,
              cancelRequested ? 'canceled' : final.state === 'budget' || final.inputRequestReadError ? 'failed' : final.state)
          }
        } catch (error) {
          logger.warn('could not save sidebar run result', { chatId: payload.chatId, error: String(error) })
        }
        live.close()
        if (!options.runnerTaskId && (accepted || !options.preserveOnRefusal)) {
          try { reportStandaloneTurn(payload.chatId, final) }
          catch (error) { logger.warn('turn status projection failed', { chatId: payload.chatId, error: String(error) }) }
        }
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
  handbackEligible?: boolean
  runnerOwned: boolean
  inputOrigin?: 'user' | 'runner'
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
  const routing = routingOf(chat)
  const target: RunTarget = lifecycle.agentId
    ? { kind: 'agent' as const, agentId: lifecycle.agentId }
    : answererOf(chat, payload)

  // Every event is observed once whether or not a renderer is attached, which makes this the one place
  // that sees a `needs_input` from any driver, in any router — including one a
  // nested agent raised, which arrives wrapped in a `child`. The alternative
  // was a hook in each streaming service, which is two places that would have
  // to agree about a third (the orchestrated path) forever.
  const context: RunEventContext = {
    userId: profileUserId, chatId, agentId: target.kind === 'model' ? null : target.agentId
  }
  lifecycle.context(context)
  const observed = observeAsks(port, context, lifecycle.observe)

  if (target.kind === 'model') {
    const { wireContent } = messageRoutingService.prepareLlmSend({
      userId: profileUserId,
      chatId,
      userContent,
      attachments,
      origin: lifecycle.inputOrigin,
      onPersisted: () => lifecycle.persisted(context)
    })
    lifecycle.accepted()
    await handOff(observed, () =>
      chatStreamingService.stream({ userId: profileUserId, settingsUserId, chatId, wireContent, port: observed, onFinished: lifecycle.finish, coordinator: lifecycle.coordinator, wireRole: lifecycle.inputOrigin === 'runner' ? 'system' : 'user' }),
      (message) => lifecycle.refusal(chatId, message)
    )
    return
  }

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
    queueWhenBusy: lifecycle.runnerOwned,
    handbackEligible: lifecycle.handbackEligible,
    agentId: target.agentId,
    userContent,
    attachments,
    // A direct chat has one counterparty and therefore no gap to close; the
    // packet exists for the messages *another* agent wrote.
    catchUp: routing.router === 'human' || (!!lifecycle.agentId && chat.agentId !== lifecycle.agentId)
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
  handbackEligible?: boolean
  queueWhenBusy?: boolean
  includeToolResults?: boolean
  inputOrigin?: 'user' | 'runner'
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
  const { wireContent } = messageRoutingService.prepareAgentSend({
    userId: profileUserId,
    chatId,
    agentId,
    userContent,
    attachments,
    origin: input.inputOrigin,
    onPersisted: input.persisted
  })
  input.accepted()

  // `/run:<name>` for an agent whose commands come from a folder catalog is
  // intercepted **here**, before the driver is ever reached — OpenCode has no
  // such convention, so the desktop itself has to recognise the message.
  // Deliberately not inside the driver: a command is not a model turn. See
  // `resolveCommandRunner`'s own docstring for why the decision lives there.
  //
  // It matches on the *typed* text, not on the packet in front of it: a
  // `/run:` prefixed by a catch-up transcript is still the command the user
  // typed, and a packet is never built for one anyway (a command runs a script
  // on this machine, so there is nothing to catch it up on).
  const run = resolveCommandRunner(
    driver.capabilities(agent).commands,
    wireContent,
    agentOwnerId,
    agentId,
    (io) =>
      driver.run(agentOwnerId, agent, {
        chatId,
        wireContent: withCatchUp(packet, wireContent),
        fileIds,
        signal: io.signal,
        ...(input.queueWhenBusy ? { queueWhenBusy: true } : {}),
        ...(input.handbackEligible ? { handbackEligible: true } : {}),
        ...(input.registerSteer ? { registerSteer: input.registerSteer } : {}),
        onEvent: io.onEvent
      })
  )

  await handOff(port, () =>
    a2aStreamingService.streamToAgent({
      run,
      chatId,
      agentId,
      port,
      onFinished: input.finish,
      // Only a turn that finished moves the cursor. A failed or stopped one
      // leaves the gap for the retry to carry.
      onCompleted: () => {
        const last = messageRepo.lastId(chatId)
        if (last) chatAgentCursorRepo.advance(chatId, agentId, last)
      }
    }),
    (message) => input.refusal(chatId, message)
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
