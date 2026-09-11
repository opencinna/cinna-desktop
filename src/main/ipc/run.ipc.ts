import { ipcMain, type MessagePortMain } from 'electron'
import { messageRepo } from '../db/messages'
import { chatRepo } from '../db/chats'
import { chatAgentCursorRepo } from '../db/chatAgentCursors'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { agentService } from '../services/agentService'
import { messageRoutingService } from '../services/messageRoutingService'
import { a2aStreamingService } from '../services/a2aStreamingService'
import { jobService } from '../services/jobService'
import { chatStreamingService } from '../services/chatStreamingService'
import { buildCatchUpPacket, withCatchUp } from '../services/threadContextService'
import { driverFor } from '../agents/drivers'
import { resolveCommandRunner } from '../services/localAgents/commandService'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { inboxService } from '../services/inboxService'
import { routingOf } from '../../shared/chatRouting'
import { createLogger } from '../logger/logger'
import { postRunError } from './_streamPort'
import type { StreamPort } from '../services/a2aStreamingService'
import type { AgentSendPayload, LlmSendPayload, RunSendPayload } from '../../shared/ipcPayloads'

const logger = createLogger('run')

/** The port `ipcRenderer.postMessage` hands the handler. */
type Port = MessagePortMain

/**
 * One send channel for every chat.
 *
 * Who answers a message is a property of the **chat**, not of which IPC channel
 * the composer happened to pick — that was the shape phase 4 of the agent
 * runtime plan removed. `run:send` reads `chats.router`, asks
 * `src/shared/chatRouting.ts` who answers, and dispatches: the local model
 * through `chatStreamingService`, an agent through its driver.
 *
 * `agent:send-message` and `llm:send-message` are kept for one phase as thin
 * forwards onto the same function, so a renderer build that predates this one —
 * or a preload that was not reloaded — still sends. They add nothing: both
 * arrive at the same routing decision, because the decision is made from the
 * chat row either way. Phase 7 removes them.
 */
export function registerRunHandlers(): void {
  // ipcRenderer.postMessage passes the payload as the 2nd arg to the listener
  // and the MessagePort on event.ports — see CLAUDE.md.
  ipcMain.on('run:send', (event, payload: RunSendPayload) => {
    void dispatchRun(event.ports?.[0], payload)
  })

  // The two forwards. `agent:send-message` carried an explicit `agentId`; it is
  // taken as the addressed agent, which is exactly what it meant in the one
  // chat shape that used it (a direct chat's root — where the router reaches
  // the same agent on its own, so the field changes nothing).
  ipcMain.on('agent:send-message', (event, payload: AgentSendPayload) => {
    void dispatchRun(event.ports?.[0], {
      chatId: payload.chatId,
      content: payload.content,
      attachments: payload.attachments,
      addressedAgentId: payload.agentId
    })
  })

  ipcMain.on('llm:send-message', (event, payload: LlmSendPayload) => {
    void dispatchRun(event.ports?.[0], {
      chatId: payload.chatId,
      content: payload.content,
      attachments: payload.attachments
    })
  })
}

/**
 * Resolve who answers, persist the user message, and run the turn.
 *
 * **Never throws, and the guarantee is enforced rather than promised.** Every
 * refusal is posted to the port and the port is closed; everything else is
 * wrapped, because a throw out of here is invisible — the caller is
 * `void dispatchRun(...)` in an `ipcMain.on` listener, so nothing posts, the
 * port is never closed, and the renderer streams until the user navigates away.
 * There is real work between `port.start()` and the streaming service that can
 * throw: persisting the user row (`ChatError` on an ownership mismatch),
 * reading the thread, building the packet, resolving a `/run:` command.
 *
 * The wrapper tracks **ownership**: once the port is handed to a streaming
 * service, that service posts the terminal event and closes it, and this
 * function must not post to a closed port on the way out.
 */
async function dispatchRun(port: Port | undefined, payload: RunSendPayload): Promise<void> {
  if (!port) {
    logger.error('a send arrived with no MessagePort', { chatId: payload.chatId })
    return
  }
  port.start()
  try {
    await resolveAndRun(port, payload)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('a send threw before its turn had an owner', {
      chatId: payload.chatId,
      error: message,
      stack: err instanceof Error ? err.stack : undefined
    })
    // Only reachable while this function still owns the port: `runTurn` marks
    // the hand-off before it awaits either service, and both of them own the
    // ending from that point on.
    postRunError(port, message)
    port.close()
    reportRefusal(payload.chatId, message)
  }
}

/**
 * A turn that ended before any streaming service owned it.
 *
 * **A refusal is an ending.** Nothing else will report one from here: the two
 * services report their own, and a turn that never reached either leaves the
 * job run it belongs to at `running` for the life of the app — nothing reaps a
 * stale one, and `countInProgressByJob` (the sidebar's busy indicator) counts
 * it. Through `reportRunCompletion` the task hears about it too, which is what
 * keeps the task page's "Re-run from the last message" from turning the state
 * it recovers from into one nothing can move: without this, a re-run that is
 * refused for a missing agent leaves the task claimed and running for ever.
 *
 * Safe to call on a chat that belongs to no job run, and safe to call twice:
 * `reportRunCompletion` no-ops for both.
 *
 * **It swallows its own errors, by contract**, for the same reason
 * `observeAsks` does. One call site is inside `dispatchRun`'s catch, and that
 * function's guarantee is that it never throws — a throw out of there is
 * invisible, because the caller is `void dispatchRun(...)` in an `ipcMain.on`
 * listener. Letting bookkeeping break the one path whose job is to report a
 * failure would trade a stale run row for a renderer that streams for ever.
 */
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

async function resolveAndRun(port: Port, payload: RunSendPayload): Promise<void> {
  if (!userActivation.isActivated()) {
    // **The one unowned exit that deliberately reports nothing.** Every other
    // refusal below goes through `reportRefusal`, and the asymmetry is the
    // point: this branch is the app declining to do *anything* profile-scoped,
    // and a job-run write here would be the only place main touches a locked
    // profile's rows. A run that is stale-`running` when the profile locks was
    // orphaned by the lock, not by this send — nothing reaps it at unlock or at
    // boot either, and that reaper is the fix for the whole class rather than a
    // write smuggled past the guard that exists to prevent it.
    postRunError(port, 'Session not activated — user must authenticate first')
    port.close()
    return
  }

  const { chatId, content: userContent, attachments } = payload
  const profileUserId = getProfileScopeUserId()
  const chat = chatRepo.getOwned(profileUserId, chatId)
  if (!chat) {
    const err = 'Chat not found'
    logger.error(err, { chatId })
    postRunError(port, err)
    port.close()
    reportRefusal(chatId, err)
    return
  }

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
  const target = routing.answerer(addressing)

  // **Where an ask becomes an inbox row.** Every event of every turn passes
  // through here on its way to the renderer, which makes this the one place
  // that sees a `needs_input` from any driver, in any router — including one a
  // nested agent raised, which arrives wrapped in a `child`. The alternative
  // was a hook in each streaming service, which is two places that would have
  // to agree about a third (the orchestrated path) forever.
  const observed = observeAsks(port, {
    userId: profileUserId,
    chatId,
    agentId: target.kind === 'model' ? null : target.agentId
  })

  if (target.kind === 'model') {
    const { wireContent } = messageRoutingService.prepareLlmSend({
      userId: profileUserId,
      chatId,
      userContent,
      attachments
    })
    await handOff(() =>
      chatStreamingService.stream({ userId: profileUserId, chatId, wireContent, port: observed })
    )
    return
  }

  await runAgentTurn(observed, {
    chatId,
    profileUserId,
    agentId: target.agentId,
    userContent,
    attachments,
    // A direct chat has one counterparty and therefore no gap to close; the
    // packet exists for the messages *another* agent wrote.
    catchUp: routing.router === 'human'
  })
}

/**
 * The same port, with every event mirrored into the inbox on the way past.
 *
 * Recording happens **before** the event is forwarded, so an ask the renderer
 * answers the instant it renders finds its row already there. It cannot fail
 * the turn: `recordRunEvent` swallows its own errors, by contract.
 */
function observeAsks(port: Port, ctx: Parameters<typeof inboxService.recordRunEvent>[0]): StreamPort {
  return {
    postMessage(msg) {
      inboxService.recordRunEvent(ctx, msg)
      port.postMessage(msg)
    },
    close() {
      port.close()
    }
  }
}

interface AgentTurnInput {
  chatId: string
  profileUserId: string
  agentId: string
  userContent: string
  attachments: RunSendPayload['attachments']
  catchUp: boolean
}

async function runAgentTurn(port: StreamPort, input: AgentTurnInput): Promise<void> {
  const { chatId, profileUserId, agentId, userContent, attachments, catchUp } = input
  const fileIds = attachments?.map((a) => a.id)

  const located = agentService.findAgent(getSettingsScopeUserId(), profileUserId, agentId)
  if (!located) {
    const err = 'Agent not found or not configured'
    logger.error(err, { agentId, chatId })
    postRunError(port, err)
    messageRepo.saveError({ chatId, short: err })
    port.close()
    reportRefusal(chatId, err)
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
        names: agentNames(profileUserId)
      })
    : null

  // Persist the user message + fire title generation in one place. The message
  // is stored as the user typed it; the packet travels on the wire only.
  const { wireContent } = messageRoutingService.prepareAgentSend({
    userId: profileUserId,
    chatId,
    agentId,
    userContent,
    attachments
  })

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

  await handOff(() =>
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
    })
  )
}

/**
 * Run a streaming service, which owns the port's ending from here on.
 *
 * Its failure is logged and swallowed rather than rethrown: both services post
 * a terminal event and close the port in their own `finally`, so re-raising it
 * would have `dispatchRun`'s wrapper post to a port that is already closed —
 * and would report as unhandled a turn the user has already been told about.
 */
async function handOff(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (err) {
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
function agentNames(profileUserId: string): Map<string, string> {
  const names = new Map<string, string>()
  try {
    for (const agent of agentService.listMerged(getSettingsScopeUserId(), profileUserId)) {
      names.set(agent.id, agent.name)
    }
  } catch (err) {
    logger.warn('could not read agent names for a catch-up packet', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
  return names
}
