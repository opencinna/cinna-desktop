import { nanoid } from 'nanoid'
import { messageRepo } from '../db/messages'
import { chatRepo } from '../db/chats'
import { chatAgentCursorRepo } from '../db/chatAgentCursors'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { agentService } from './agentService'
import { messageRoutingService } from './messageRoutingService'
import { a2aStreamingService } from './a2aStreamingService'
import { jobService } from './jobService'
import { chatStreamingService } from './chatStreamingService'
import { buildCatchUpPacket, withCatchUp } from './threadContextService'
import { driverFor } from '../agents/drivers'
import { resolveCommandRunner } from './localAgents/commandService'
import { routingOf } from '../../shared/chatRouting'
import { createLogger } from '../logger/logger'
import type { StreamPort } from './a2aStreamingService'
import type { RunSendPayload } from '../../shared/ipcPayloads'

import type { RunEvent } from '../../shared/runEvents'
import type { RunEventContext } from './inboxService'
import { activeRunsByChat as activeChats } from './runExecutionState'

const logger = createLogger('run')
export interface RunScope { profileUserId: string; settingsUserId: string }
export type RunObserver = (ctx: RunEventContext, event: RunEvent) => void
export interface RunHandle {
  id: string
  /** Resolves after the user message is persisted, before execution starts. */
  accepted: Promise<void>
  /** Resolves when the stream closes, including the model's asynchronous loop. */
  completed: Promise<void>
  cancel(): void
}

/** Main owns the turn. A renderer is an optional subscriber, never its lifetime. */
export const runExecutionService = {
  isRunning(chatId: string): boolean { return activeChats.has(chatId) },

  cancelChat(userId: string, chatId: string): void {
    if (!chatRepo.getOwned(userId, chatId)) throw new Error('Chat not found')
    activeChats.get(chatId)?.cancel()
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
  }): RunHandle {
    if (activeChats.has(payload.chatId)) throw new Error('This conversation already has a turn running.')
    let accept!: () => void
    let refuse!: (error: Error) => void
    let complete!: () => void
    let accepted = false
    let closed = false
    let requestId: string | null = null
    let cancelRequested = false
    let failure: string | null = null
    let context: RunEventContext | null = null
    const handle: RunHandle = {
      id: nanoid(),
      accepted: new Promise<void>((resolve, reject) => { accept = resolve; refuse = reject }),
      completed: new Promise<void>((resolve) => { complete = resolve }),
      cancel() {
        cancelRequested = true
        if (requestId) {
          a2aStreamingService.cancel(requestId)
          chatStreamingService.cancel(requestId)
        }
      }
    }
    // The IPC caller need not await acceptance, but headless callers can.
    void handle.accepted.catch(() => {})
    activeChats.set(payload.chatId, handle)
    const port: StreamPort = {
      postMessage(event) {
        if (closed) return
        if (event.type === 'request-id') {
          requestId = event.requestId
          if (cancelRequested) handle.cancel()
        }
        if (event.type === 'error') failure = event.error
        try { options.port?.postMessage(event) } catch {
          // A closed view is only a lost subscriber. Persistence and asks live on.
        }
      },
      close() {
        if (closed) return
        closed = true
        if (!accepted) refuse(new Error(failure ?? 'The turn could not be started.'))
        if (activeChats.get(payload.chatId) === handle) activeChats.delete(payload.chatId)
        try { options.port?.close() } catch { /* subscriber already disconnected */ }
        complete()
      }
    }
    const observe: RunObserver = (ctx, event) => {
      if (closed || (!accepted && options.preserveOnRefusal && event.type === 'error')) return
      try { options.observe({ ...ctx, turnId: handle.id }, event) } catch (error) {
        logger.warn('run observer failed', { chatId: ctx.chatId, error: String(error) })
      }
    }
    const refusal = (chatId: string, message: string): void => {
      if (accepted || !options.preserveOnRefusal) reportRefusal(chatId, message)
    }
    void resolveAndRun(port, payload, scope, {
      observe,
      context: (ctx) => { context = ctx },
      persisted: (ctx) => options.onAccepted?.({ ...ctx, turnId: handle.id }),
      accepted: () => { accepted = true; accept() },
      refusal,
      agentId: options.agentId
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (context) observe(context, { type: 'error', error: message })
      port.postMessage({ type: 'error', error: message })
      port.close()
      if (context) refusal(payload.chatId, message)
    })
    return handle
  }
}

function reportRefusal(chatId: string, message: string): void {
  try {
    jobService.reportRunCompletion(chatId, 'failed', message)
  } catch (err) {
    logger.warn('could not record a refused turn as an ending', {
      chatId,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

interface RunLifecycle {
  observe: RunObserver
  agentId?: string
  context(ctx: RunEventContext): void
  persisted(ctx: RunEventContext): void
  accepted(): void
  refusal(chatId: string, message: string): void
}

async function resolveAndRun(
  port: StreamPort,
  payload: RunSendPayload,
  scope: RunScope,
  lifecycle: RunLifecycle
): Promise<void> {
  const { chatId, content: userContent, attachments } = payload
  const { profileUserId, settingsUserId } = scope
  const chat = chatRepo.getOwned(profileUserId, chatId)
  if (!chat) {
    const err = 'Chat not found'
    logger.error(err, { chatId })
    port.postMessage({ type: 'error', error: err })
    port.close()
    return
  }

  lifecycle.context({ userId: profileUserId, chatId, agentId: null })
  const routing = routingOf(chat)
  // Only `human` reads any of this, and only `human` pays for the two reads.
  const addressing =
    routing.router === 'human'
      ? {
          addressed: payload.addressedAgentId,
          lastAddressed: messageRepo.lastAddressedAgentId(chatId),
          attached: chatOnDemandAgentRepo.listAgentIds(chatId)
        }
      : undefined
  const target = lifecycle.agentId
    ? { kind: 'agent' as const, agentId: lifecycle.agentId }
    : routing.answerer(addressing)

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
      onPersisted: () => lifecycle.persisted(context)
    })
    lifecycle.accepted()
    await handOff(observed, () =>
      chatStreamingService.stream({ userId: profileUserId, chatId, wireContent, port: observed }),
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
    refusal: lifecycle.refusal,
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
  chatId: string
  profileUserId: string
  settingsUserId: string
  persisted: () => void
  accepted: () => void
  refusal: (chatId: string, message: string) => void
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
        names: agentNames(settingsUserId, profileUserId)
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
        onEvent: io.onEvent
      })
  )

  await handOff(port, () =>
    a2aStreamingService.streamToAgent({
      run,
      chatId,
      agentId,
      port,
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
