import { chatRepo } from '../db/chats'
import type { MessageRow } from '../db/messages'
import { chatAgentSessionRepo } from '../db/chatAgentSessions'
import { agentService } from './agentService'
import { aiFunctions, AiFunctionError } from './aiFunctionsService'
import { getSettingsScopeUserId, getProfileScopeUserId } from '../auth/scope'
import { DomainError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('multi-agent')

const CATCHUP_WINDOW_TURNS = 20
const REWRITE_MAX_OUTPUT_CHARS = 4000
/**
 * Sentinel the rewrite LLM emits when the user's message is already
 * self-contained and needs no rewriting. We detect it and short-circuit the
 * double-send confirmation — the original text is dispatched as-is.
 */
const KEEP_ORIGINAL_SENTINEL = '__KEEP_ORIGINAL__'

export type MultiAgentErrorCode =
  | 'chat_not_found'
  | 'agent_not_found'
  | 'no_rewrite_provider'
  | 'rewrite_failed'
  | 'rewrite_empty'

export class MultiAgentError extends DomainError<MultiAgentErrorCode> {}

/**
 * Map shared AI-function errors to multi-agent codes the renderer already
 * handles. Keeps the IPC-visible error surface stable while the underlying
 * one-shot LLM call lives in {@link aiFunctions}.
 */
function mapAiFunctionError(err: AiFunctionError): MultiAgentError {
  if (err.code === 'no_provider') {
    return new MultiAgentError('no_rewrite_provider', err.message, err.detail)
  }
  if (err.code === 'empty_output') {
    return new MultiAgentError('rewrite_empty', err.message, err.detail)
  }
  return new MultiAgentError('rewrite_failed', err.message, err.detail)
}

function describeAgentName(agentId: string | null): string {
  if (!agentId) return 'the assistant'
  const located = agentService.findAgent(
    getSettingsScopeUserId(),
    getProfileScopeUserId(),
    agentId
  )
  return located?.row.name ?? agentId
}

function turnLineForCatchup(msg: MessageRow): string | null {
  if (msg.role === 'user') {
    const text = msg.rewrittenText ?? msg.content
    return `User: ${text}`
  }
  if (msg.role === 'assistant') {
    const speaker = msg.sourceAgentId
      ? describeAgentName(msg.sourceAgentId)
      : 'Assistant'
    return `${speaker}: ${msg.content}`
  }
  // Skip tool calls / errors / transitions: not relevant to catch-up context.
  return null
}

export const multiAgentService = {
  /**
   * Run the Smart Rewrite LLM call. Returns the rewritten text, or `null`
   * when the LLM judged the message already self-contained (caller should
   * send the original as-is, skipping the confirmation step). Throws a
   * MultiAgentError so the renderer can surface a "smart rewrite failed"
   * banner with a "send anyway / disable" prompt.
   */
  async rewriteMessage(input: {
    userId: string
    chatId: string
    targetAgentId: string
    userText: string
  }): Promise<string | null> {
    const { userId, chatId, targetAgentId, userText } = input

    if (!chatRepo.getOwned(userId, chatId)) {
      throw new MultiAgentError('chat_not_found', 'Chat not found')
    }

    const located = agentService.findAgent(
      getSettingsScopeUserId(),
      userId,
      targetAgentId
    )
    if (!located) throw new MultiAgentError('agent_not_found', 'Target agent not found')

    let resolved
    try {
      resolved = aiFunctions.resolveAdapterFromChatMode(userId, chatId)
    } catch (err) {
      if (err instanceof AiFunctionError) throw mapAiFunctionError(err)
      throw err
    }

    const history = chatRepo
      .listMessages(chatId)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-CATCHUP_WINDOW_TURNS)
      .map(turnLineForCatchup)
      .filter((line): line is string => !!line)
      .join('\n')

    const agentDescription =
      located.row.description?.trim() ||
      `An assistant called ${located.row.name}.`

    const systemPrompt = [
      'You are a Smart Rewrite assistant inside a multi-agent chat client.',
      'The user is bringing a new agent into an existing conversation. The new',
      'agent has no access to prior history, so the user\'s next message must',
      'be rephrased into a SELF-CONTAINED prompt that does not rely on context',
      'from the conversation so far. Preserve the user\'s intent and any',
      'specific names, ids, or details from the prior conversation that are',
      'relevant. Do NOT add new requests. Keep it short and natural — one or',
      'two sentences at most when possible.',
      '',
      `Target agent: ${located.row.name}`,
      `Agent description: ${agentDescription}`,
      '',
      'Conversation so far:',
      history || '(no prior turns)',
      '',
      'IMPORTANT — skip rewriting when not needed:',
      `If the user's message is ALREADY self-contained — meaning a reader who`,
      'knows nothing about the prior conversation could fully understand and',
      `act on it (no unresolved pronouns like "him"/"that"/"the issue"/etc.,`,
      'no implicit references to earlier turns) — then output EXACTLY this',
      `single token and nothing else: ${KEEP_ORIGINAL_SENTINEL}`,
      '',
      'Otherwise, output ONLY the rewritten prompt. No preamble, no quotation',
      'marks, no explanation.'
    ].join('\n')

    try {
      const rewritten = await aiFunctions.runSingleShot({
        adapter: resolved.adapter,
        modelId: resolved.modelId,
        systemPrompt,
        userText,
        label: 'multi-agent-rewrite',
        maxOutputChars: REWRITE_MAX_OUTPUT_CHARS
      })
      // Strip optional surrounding quotes/backticks so a "polite" LLM that
      // still complied with the sentinel ("__KEEP_ORIGINAL__" or `…`) is
      // detected correctly.
      const stripped = rewritten.trim().replace(/^["'`]+|["'`]+$/g, '')
      if (stripped === KEEP_ORIGINAL_SENTINEL) {
        logger.info('rewrite skipped: message already self-contained', {
          chatId,
          targetAgentId,
          modelId: resolved.modelId
        })
        return null
      }
      logger.info('rewrite completed', {
        chatId,
        targetAgentId,
        modelId: resolved.modelId,
        outLen: rewritten.length
      })
      return rewritten
    } catch (err) {
      if (err instanceof AiFunctionError) throw mapAiFunctionError(err)
      throw err
    }
  },

  /**
   * Build a catch-up replay packet covering messages from the target agent's
   * cursor forward. Returns an empty string when there is nothing new to
   * replay. Caller is responsible for prepending the result to the user
   * message before sending to the agent.
   */
  buildCatchupPacket(input: {
    userId: string
    chatId: string
    targetAgentId: string
  }): string {
    const { userId, chatId, targetAgentId } = input
    // Ownership gate — the IPC-exposed entry point must refuse foreign chats
    // even though only the renderer of the same profile can reach it.
    if (!chatRepo.getOwned(userId, chatId)) {
      throw new MultiAgentError('chat_not_found', 'Chat not found')
    }
    const cursor = chatAgentSessionRepo.getCursor(chatId, targetAgentId)

    // First engagement: no catchup. Smart Rewrite already produced a
    // self-contained prompt for the agent's join moment, so prepending the
    // full transcript on top would be redundant (and wasteful in tokens).
    // Catchup only applies *between* engagements of the same agent — i.e.
    // when a cursor already exists.
    if (!cursor) return ''

    const all = chatRepo.listMessages(chatId)
    const cursorIdx = all.findIndex((m) => m.id === cursor)
    const startIdx = cursorIdx >= 0 ? cursorIdx + 1 : 0

    const slice = all
      .slice(startIdx)
      .filter((m) => {
        // Errors and transitions are noise.
        if (m.role !== 'user' && m.role !== 'assistant') return false
        // Skip the target agent's own prior outputs — the cursor only advances
        // on user-message-send, so the slice after it includes the agent's
        // own reply that followed. Replaying it back as "the user's exchange
        // with another assistant" would feed the agent its own words.
        if (m.sourceAgentId === targetAgentId) return false
        return true
      })

    if (slice.length === 0) return ''

    const windowed = slice.slice(-CATCHUP_WINDOW_TURNS)
    const lines = windowed
      .map(turnLineForCatchup)
      .filter((line): line is string => !!line)

    if (lines.length === 0) return ''

    const packet = [
      'Since your last message in this chat, the user had this exchange with another assistant:',
      '',
      ...lines,
      '',
      '---',
      'Now the user is addressing you again with the message below.',
      ''
    ].join('\n')

    logger.debug('catchup built', {
      chatId,
      targetAgentId,
      cursor: cursor ?? null,
      turnCount: lines.length,
      packetChars: packet.length
    })

    return packet
  },

  advanceCatchupCursor(input: {
    userId: string
    chatId: string
    targetAgentId: string
    lastMessageId: string
  }): void {
    if (!chatRepo.getOwned(input.userId, input.chatId)) {
      throw new MultiAgentError('chat_not_found', 'Chat not found')
    }
    chatAgentSessionRepo.upsertCursor(
      input.chatId,
      input.targetAgentId,
      input.lastMessageId
    )
  },

  /**
   * Set the chat's active agent. The persistent "Talking to X / Switch back"
   * banner above the input already shows the current routing target, so no
   * transcript-level transition message is inserted — the banner is the
   * source of truth for the user.
   */
  setActiveAgent(input: {
    userId: string
    chatId: string
    agentId: string | null
  }): { changed: boolean } {
    const { userId, chatId, agentId } = input
    const chat = chatRepo.getOwned(userId, chatId)
    if (!chat) throw new MultiAgentError('chat_not_found', 'Chat not found')

    const current = chat.activeAgentId ?? null
    if (current === agentId) return { changed: false }

    chatRepo.updateRouting(userId, chatId, { activeAgentId: agentId })
    logger.info('active agent changed', { chatId, from: current, to: agentId })
    return { changed: true }
  },

  disableSmartAssist(input: { userId: string; chatId: string }): void {
    const { userId, chatId } = input
    const chat = chatRepo.getOwned(userId, chatId)
    if (!chat) throw new MultiAgentError('chat_not_found', 'Chat not found')
    chatRepo.updateRouting(userId, chatId, { smartAssistDisabled: true })
    logger.info('smart assist disabled', { chatId })
  }
}
