import { ipcMain } from 'electron'
import { messageRepo } from '../db/messages'
import { chatRepo } from '../db/chats'
import { a2aSessionRepo } from '../db/agents'
import { type ProtocolResolution } from '../agents/a2a-client'
import { agentService } from '../services/agentService'
import { messageRoutingService } from '../services/messageRoutingService'
import { a2aStreamingService } from '../services/a2aStreamingService'
import { driverFor, respondToOrphanedAsk } from '../agents/drivers'
import { pendingRequests } from '../services/agentTurn/pendingRequests'
import { resolveCommandRunner } from '../services/localAgents/commandService'
import type { PermissionReply } from '../../shared/localAgentRequests'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { AgentError, ipcErrorShape } from '../errors'
import { createLogger } from '../logger/logger'
import { ipcHandle } from './_wrap'
import { postRunError } from './_streamPort'
import type { CliCommand } from '../../shared/cliCommands'
import type { AgentSendPayload } from '../../shared/ipcPayloads'

const logger = createLogger('A2A')

/** An answer to an ask whose turn has since ended — a stale block, not a fault. */
const NO_LONGER_WAITING = 'This request is no longer waiting for an answer.'

/** OpenCode's `PermissionV2Reply`, checked at the boundary rather than cast. */
function isPermissionReply(value: unknown): value is PermissionReply {
  return value === 'once' || value === 'always' || value === 'reject'
}

/** `QuestionV2Reply.answers` — one array of selected labels **per question**. */
function isAnswerMatrix(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((row) => Array.isArray(row) && row.every((s) => typeof s === 'string'))
  )
}

export function registerA2AHandlers(): void {
  // Fetch agent card from URL (for testing / adding a new agent)
  ipcHandle(
    'agent:fetch-card',
    async (
      _event,
      data: { cardUrl: string; accessToken?: string }
    ): Promise<{
      success: boolean
      card?: Record<string, unknown>
      protocol?: ProtocolResolution
      error?: string
    }> => {
      userActivation.requireActivated()
      logger.debug(`Fetching card from ${data.cardUrl}`)
      try {
        const { card, protocol } = await agentService.fetchCardPreview(data)
        logger.info(`Card fetched, protocol ${protocol.version} at ${protocol.url}`)
        return { success: true, card: card as unknown as Record<string, unknown>, protocol }
      } catch (err) {
        logger.error(`Card fetch failed for ${data.cardUrl}`, {
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined
        })
        return { success: false, error: String(err) }
      }
    }
  )

  // Test connection to a saved agent
  ipcHandle(
    'agent:test',
    async (
      _event,
      agentId: string
    ): Promise<{
      success: boolean
      card?: Record<string, unknown>
      error?: string
    }> => {
      userActivation.requireActivated()
      try {
        const located = agentService.findAgent(
          getSettingsScopeUserId(),
          getProfileScopeUserId(),
          agentId
        )
        if (!located) throw new AgentError('not_found', 'Agent not found')
        const { card } = await agentService.testAgent(located.userId, agentId)
        return { success: true, card: card as unknown as Record<string, unknown> }
      } catch (err) {
        const e = ipcErrorShape(err)
        logger.error(`Test failed for agent ${agentId}`, {
          error: e.message,
          stack: err instanceof Error ? err.stack : undefined
        })
        return { success: false, error: e.message }
      }
    }
  )

  // Fetch CLI commands exposed by a saved agent (cinna.run.* skills)
  ipcHandle(
    'agent:list-cli-commands',
    async (
      _event,
      agentId: string
    ): Promise<{ success: boolean; commands: CliCommand[]; error?: string }> => {
      userActivation.requireActivated()
      try {
        const located = agentService.findAgent(
          getSettingsScopeUserId(),
          getProfileScopeUserId(),
          agentId
        )
        if (!located) throw new AgentError('not_found', 'Agent not found')
        const commands = await agentService.listCliCommands(located.userId, agentId)
        return { success: true, commands }
      } catch (err) {
        const e = ipcErrorShape(err)
        // Network-family errors on this low-stakes fetch are expected during
        // brief backend outages; keep them at debug so the logger overlay
        // doesn't flood. Domain errors (ownership, session) stay at warn.
        const isTransient =
          /ECONN(REFUSED|RESET)|ENOTFOUND|ETIMEDOUT|terminated|socket hang up|Could not reach|timed out|closed/i.test(
            e.message
          )
        const log = isTransient ? logger.debug : logger.warn
        log(`CLI commands fetch failed for agent ${agentId}`, { error: e.message })
        return { success: false, commands: [], error: e.message }
      }
    }
  )

  // Look up the A2A session for a chat (used by renderer to detect agent chats)
  ipcHandle('agent:get-session', async (_event, chatId: string) => {
    userActivation.requireActivated()
    if (!chatRepo.getOwned(getProfileScopeUserId(), chatId)) return null
    return a2aSessionRepo.getByChat(chatId) ?? null
  })

  // Stream a message to an agent via MessagePort. Thin controller: extract
  // params, auth/ownership, then hand off to the routing service (persistence
  // + cursor advance) and the streaming service (the port pump), with the
  // agent's driver running the turn.
  ipcMain.on('agent:send-message', async (event, payload: AgentSendPayload) => {
    const { agentId, chatId, content: userContent, attachments } = payload
    const fileIds = attachments?.map((a) => a.id)
    const port = event.ports?.[0]
    if (!port) return

    if (!userActivation.isActivated()) {
      logger.error('send-message rejected: session not activated', { agentId, chatId })
      port.start()
      postRunError(port, 'Session not activated — user must authenticate first')
      port.close()
      return
    }

    port.start()

    const profileUserId = getProfileScopeUserId()

    if (!chatRepo.getOwned(profileUserId, chatId)) {
      const err = 'Chat not found'
      logger.error(err, { agentId, chatId })
      postRunError(port, err)
      port.close()
      return
    }

    const located = agentService.findAgent(getSettingsScopeUserId(), profileUserId, agentId)
    if (!located) {
      const err = 'Agent not found or not configured'
      logger.error(err, { agentId, chatId })
      postRunError(port, err)
      messageRepo.saveError({ chatId, short: err })
      port.close()
      return
    }
    const { row: agent, userId: agentOwnerId } = located

    // **No kind-specific pre-flight here any more.** The card check, endpoint
    // and token resolution and the Cinna re-auth mapping all run inside the A2A
    // driver's `run`, which reports each as `result.error` — so a failure there
    // arrives after the user's message is persisted, and is finalized by
    // `streamToAgent` like any failed turn, exactly as a folder agent's always
    // was.
    const driver = driverFor(agent)

    // Persist the user message + fire title generation in one place. Service
    // throws ChatError on ownership mismatch (already re-checked above; this
    // is defense-in-depth).
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
    // `resolveCommandRunner`'s own docstring for why the decision lives there,
    // tested, rather than inline here.
    const run = resolveCommandRunner(
      driver.capabilities(agent).commands,
      wireContent,
      agentOwnerId,
      agentId,
      (io) =>
        driver.run(agentOwnerId, agent, {
          chatId,
          wireContent,
          fileIds,
          signal: io.signal,
          onEvent: io.onEvent
        })
    )

    await a2aStreamingService.streamToAgent({ run, chatId, agentId, port })
  })

  ipcHandle('agent:cancel-message', async (_event, requestId: string) => {
    a2aStreamingService.cancel(requestId)
    return { success: true }
  })

  /**
   * Answer a permission or question a local agent is parked on.
   *
   * These arrive **out of band** rather than down the turn's MessagePort. The
   * turn is still streaming when the answer is needed, and the port belongs to
   * a direct chat — a driver's `run` is port-free by design and orchestrated
   * mode has no port at all — so routing the answer through a registry keyed by
   * the engine's own request id is what lets both modes use one path.
   *
   * The result is returned **as data, never thrown**: `ipcMain.handle`
   * serialises a rejection to message + stack and `contextBridge` re-clones it,
   * so a renderer guard testing `err.code` silently never fires (see
   * `src/main/ipc/_wrap.ts`).
   */
  ipcHandle(
    'agent:answer-request',
    async (
      _event,
      data: { requestId: string; reply?: PermissionReply; answers?: string[][] }
    ): Promise<{ ok: boolean; reason?: string; remembered?: boolean }> => {
      userActivation.requireActivated()
      const owner = pendingRequests.owner(data.requestId)
      // An unknown request is the ordinary outcome of answering a dialog whose
      // turn has since been cancelled — the user sees a stale block, not a
      // fault — so it is reported plainly rather than logged as an error.
      if (!owner) return { ok: false, reason: NO_LONGER_WAITING }
      if (!chatRepo.getOwned(getProfileScopeUserId(), owner.chatId)) {
        logger.warn('answer rejected: the caller does not own that chat', {
          requestId: data.requestId
        })
        return { ok: false, reason: 'Chat not found' }
      }

      // Validated here rather than trusted, and against the *engine's* enum
      // rather than against TypeScript's belief about it. A renderer bug or a
      // stale preload would otherwise send `'allow'`, or a flat `string[]`,
      // and the first anyone would know is a 400 the runner logs at warn while
      // the dialog has already told the user their answer landed — the same
      // shape of lie the permission block's own tests exist to prevent.
      const parsed = isPermissionReply(data.reply)
        ? ({ kind: 'permission', reply: data.reply } as const)
        : isAnswerMatrix(data.answers)
          ? ({ kind: 'question', answers: data.answers } as const)
          : null
      if (!parsed || parsed.kind !== owner.kind) {
        logger.warn('an answer was rejected as malformed or mismatched', {
          requestId: data.requestId,
          expected: owner.kind,
          got: parsed?.kind ?? 'none'
        })
        return { ok: false, reason: 'Malformed answer' }
      }

      // The driver that parked the ask answers it — for a folder agent that is
      // where *Always allow* becomes a rule beside the agent and a `once` for
      // the engine.
      //
      // **A turn can outlive its row.** Removing an agents folder prunes the
      // rows of every agent in it without waiting for the turn lock, so an ask
      // can still be parked on an agent `findAgent` no longer knows. The answer
      // is delivered anyway — refusing it would leave the turn stuck until the
      // park times out — with no rule written, since there is no agent left to
      // keep one beside: `always` goes through as `once`, `remembered: false`.
      const located = agentService.findAgent(
        getSettingsScopeUserId(),
        getProfileScopeUserId(),
        owner.agentId
      )
      if (!located) {
        logger.warn('an answer arrived for an agent whose row is gone; delivering it without a rule', {
          requestId: data.requestId,
          agentId: owner.agentId
        })
      }

      // **Everything from `owner()` above to `respond()` is synchronous, and it
      // has to stay so.** `respond` writes the rule before it resolves the
      // park, and the resolve can still find nothing waiting — the turn was
      // cancelled in between. Nothing can interleave today; an `await`
      // inserted anywhere on this path makes it real. See `respondToParkedAsk`.
      const ask = { requestId: data.requestId, ...owner }
      const outcome = located
        ? driverFor(located.row).respond(ask, parsed)
        : respondToOrphanedAsk(ask, parsed)

      return outcome.delivered
        ? {
            ok: true,
            // Present only for a permission answered *always*: the block reads
            // it to decide between "remembered for this agent" and "allowed
            // once — the rule could not be saved".
            ...(outcome.remembered !== undefined ? { remembered: outcome.remembered } : {})
          }
        : { ok: false, reason: NO_LONGER_WAITING }
    }
  )

  /** What a chat is currently blocked on, so a reload can re-open the prompt. */
  ipcHandle('agent:pending-requests', async (_event, chatId: string) => {
    userActivation.requireActivated()
    if (!chatRepo.getOwned(getProfileScopeUserId(), chatId)) return []
    return pendingRequests.listForChat(chatId)
  })
}
