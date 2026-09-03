import { ipcMain } from 'electron'
import { messageRepo } from '../db/messages'
import { chatRepo } from '../db/chats'
import { a2aSessionRepo } from '../db/agents'
import { type ProtocolResolution } from '../agents/a2a-client'
import { agentService } from '../services/agentService'
import { messageRoutingService } from '../services/messageRoutingService'
import { a2aStreamingService } from '../services/a2aStreamingService'
import { resolveTurnRunner } from '../services/agentTurn'
import { isFolderAgent } from '../services/agentTurn/runner'
import { pendingRequests } from '../services/agentTurn/pendingRequests'
import { resolveCommandRunner } from '../services/localAgents/commandService'
import type { PermissionReply } from '../../shared/localAgentRequests'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { AgentError, ipcErrorShape } from '../errors'
import { createLogger } from '../logger/logger'
import { ipcHandle } from './_wrap'
import { postAgentError } from './_streamPort'
import type { CliCommand } from '../../shared/cliCommands'
import type { AgentSendPayload } from '../../shared/ipcPayloads'
import {
  CINNA_REAUTH_REQUIRED_CODE,
  CINNA_SESSION_EXPIRED_MESSAGE
} from '../../shared/cinnaErrors'

const logger = createLogger('A2A')

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

  // Stream a message to an A2A agent via MessagePort. Thin controller: extract
  // params, auth/ownership/endpoint resolution, then hand off to the routing
  // service (persistence + cursor advance) and the streaming service (A2A pump).
  ipcMain.on(
    'agent:send-message',
    async (event, payload: AgentSendPayload) => {
      const { agentId, chatId, content: userContent, attachments } = payload
      const fileIds = attachments?.map((a) => a.id)
      const port = event.ports?.[0]
      if (!port) return

      if (!userActivation.isActivated()) {
        logger.error('send-message rejected: session not activated', { agentId, chatId })
        port.start()
        postAgentError(port, 'Session not activated — user must authenticate first')
        port.close()
        return
      }

      port.start()

      const profileUserId = getProfileScopeUserId()

      if (!chatRepo.getOwned(profileUserId, chatId)) {
        const err = 'Chat not found'
        logger.error(err, { agentId, chatId })
        postAgentError(port, err)
        port.close()
        return
      }

      const located = agentService.findAgent(getSettingsScopeUserId(), profileUserId, agentId)
      const agent = located?.row
      if (!located || !agent) {
        const err = 'Agent not found or not configured'
        logger.error(err, { agentId, chatId })
        postAgentError(port, err)
        messageRepo.saveError({ chatId, short: err })
        port.close()
        return
      }

      // **The card-URL check comes after the source check, and the order is
      // load-bearing.** Folder agents are inserted with `cardUrl: null`
      // (`src/main/db/agents.ts`), so a combined `!agent || !agent.cardUrl`
      // guard — which is what stood here — matched every folder agent and
      // returned "Agent not found or not configured" before any local branch
      // could be reached. The friendlier branch further down was unreachable
      // code for the whole of Phase 5. Dispatch on `source`, which is the
      // discriminator that actually says what kind of agent this is; a missing
      // card is a symptom several unrelated states share.
      const runner = resolveTurnRunner(agent)
      const isFolder = isFolderAgent(agent)
      if (!isFolder && !agent.cardUrl) {
        const err = 'Agent not found or not configured'
        logger.error(err, { agentId, chatId, cardUrl: agent.cardUrl })
        postAgentError(port, err)
        messageRepo.saveError({ chatId, short: err })
        port.close()
        return
      }
      const agentOwnerId = located.userId

      let endpointUrl: string | null = null
      try {
        // A folder agent has no endpoint at all — it is run by the local
        // engine — and `resolveEndpointIfNeeded` short-circuits to null for
        // it. Skipping the call entirely keeps the local path free of a
        // resolution step that can only ever answer "there isn't one".
        if (!isFolder) endpointUrl = await agentService.resolveEndpointIfNeeded(agentOwnerId, agent)
      } catch (err) {
        const isReauth = err instanceof CinnaReauthRequired
        const errMsg = isReauth
          ? CINNA_SESSION_EXPIRED_MESSAGE
          : err instanceof AgentError
            ? err.message
            : `Failed to resolve agent endpoint: ${err instanceof Error ? err.message : String(err)}`
        const code = isReauth ? CINNA_REAUTH_REQUIRED_CODE : undefined
        logger.error(errMsg, { agentId, cardUrl: agent.cardUrl, reauth: isReauth })
        postAgentError(port, errMsg, code)
        messageRepo.saveError({ chatId, short: errMsg, code })
        port.close()
        return
      }
      if (!isFolder && endpointUrl === null) {
        // A non-folder agent with no endpoint is a misconfiguration, not a
        // kind of agent — say so rather than fail obscurely at the SDK call.
        const errMsg = 'This agent has no endpoint configured.'
        logger.error(errMsg, { agentId, source: agent.source })
        postAgentError(port, errMsg)
        messageRepo.saveError({ chatId, short: errMsg })
        port.close()
        return
      }

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

      // `/run:<name>` for a folder agent is intercepted **here**, before the
      // runner is ever reached — OpenCode has no such convention, so the
      // desktop itself has to recognise the message. Deliberately not inside
      // `resolveTurnRunner`/`LocalAgentTurnRunner`: those are the seam Phase
      // 6's mutation audit hardened, and a command is not a model turn. See
      // `resolveCommandRunner`'s own docstring for why the decision lives
      // there, tested, rather than inline here.
      const effectiveRunner = resolveCommandRunner(isFolder, wireContent, agentOwnerId, agentId, runner)

      let accessToken: string | undefined
      try {
        if (!isFolder) accessToken = await agentService.resolveAccessToken(agentOwnerId, agent)
      } catch (err) {
        const isReauth = err instanceof CinnaReauthRequired
        const errMsg = isReauth
          ? CINNA_SESSION_EXPIRED_MESSAGE
          : `Failed to resolve agent access token: ${err instanceof Error ? err.message : String(err)}`
        const code = isReauth ? CINNA_REAUTH_REQUIRED_CODE : undefined
        logger.error(errMsg, { agentId, reauth: isReauth })
        postAgentError(port, errMsg, code)
        messageRepo.saveError({ chatId, short: errMsg, code })
        port.close()
        return
      }

      await a2aStreamingService.streamToAgent({
        runner: effectiveRunner,
        chatId,
        agentId,
        agentName: agent.name,
        endpointUrl,
        cardUrl: agent.cardUrl,
        accessToken,
        wireContent,
        fileIds,
        port,
        // Remote agents authenticate with a Cinna-issued JWT — a stream-level
        // 401/403 means the server revoked the session and the user needs to
        // re-auth. Local A2A agents use a user-supplied static token so a
        // 401 there is just a wrong-token error, not a reauth signal.
        isCinnaTokenAuth: agent.source === 'remote'
      })
    }
  )

  ipcHandle('agent:cancel-message', async (_event, requestId: string) => {
    a2aStreamingService.cancel(requestId)
    return { success: true }
  })

  /**
   * Answer a permission or question a local agent is parked on.
   *
   * These arrive **out of band** rather than down the turn's MessagePort. The
   * turn is still streaming when the answer is needed, and the port belongs to
   * a direct chat — `runAgentTurn` is port-free by design and orchestrated mode
   * has no port at all — so routing the answer through a registry keyed by the
   * engine's own request id is what lets both modes use one path.
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
    ): Promise<{ ok: boolean; reason?: string }> => {
      userActivation.requireActivated()
      const owner = pendingRequests.owner(data.requestId)
      // An unknown request is the ordinary outcome of answering a dialog whose
      // turn has since been cancelled — the user sees a stale block, not a
      // fault — so it is reported plainly rather than logged as an error.
      if (!owner) return { ok: false, reason: 'This request is no longer waiting for an answer.' }
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
      const resolution = isPermissionReply(data.reply)
        ? ({ kind: 'permission', reply: data.reply } as const)
        : isAnswerMatrix(data.answers)
          ? ({ kind: 'question', answers: data.answers } as const)
          : null
      if (!resolution || resolution.kind !== owner.kind) {
        logger.warn('an answer was rejected as malformed or mismatched', {
          requestId: data.requestId,
          expected: owner.kind,
          got: resolution?.kind ?? 'none'
        })
        return { ok: false, reason: 'Malformed answer' }
      }

      return pendingRequests.resolve(data.requestId, resolution)
        ? { ok: true }
        : { ok: false, reason: 'This request is no longer waiting for an answer.' }
    }
  )

  /** What a chat is currently blocked on, so a reload can re-open the prompt. */
  ipcHandle('agent:pending-requests', async (_event, chatId: string) => {
    userActivation.requireActivated()
    if (!chatRepo.getOwned(getProfileScopeUserId(), chatId)) return []
    return pendingRequests.listForChat(chatId)
  })
}
