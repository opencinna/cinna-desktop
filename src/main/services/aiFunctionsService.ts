import { chatRepo } from '../db/chats'
import { chatModeRepo } from '../db/chatModes'
import { llmProviderRepo } from '../db/llmProviders'
import { decryptApiKey } from '../security/keystore'
import { createAdapter, isProviderType } from '../llm/factory'
import { DomainError } from '../errors'
import { createLogger } from '../logger/logger'
import { getSettingsScopeUserId } from '../auth/scope'
import type { LLMAdapter, ChatMessage } from '../llm/types'

const logger = createLogger('ai-functions')

export type AiFunctionErrorCode = 'no_provider' | 'llm_failed' | 'empty_output'

export class AiFunctionError extends DomainError<AiFunctionErrorCode> {}

export interface ResolvedAdapter {
  adapter: LLMAdapter
  modelId: string
}

export interface RunSingleShotInput {
  adapter: LLMAdapter
  modelId: string
  systemPrompt: string
  userText: string
  /** Short tag emitted in logs (`label=rewrite`, `label=title`, etc.). */
  label?: string
  /** Truncate the trimmed output at this many characters. No cap when omitted. */
  maxOutputChars?: number
  signal?: AbortSignal
}

interface ProviderModelPair {
  providerId: string | null
  modelId: string | null
}

/**
 * LLM providers and chat modes are shared across profiles — they live under
 * the settings scope, not the active profile. Resolve adapters from there
 * regardless of which profile is calling us.
 */
function tryResolve(pair: ProviderModelPair): ResolvedAdapter | null {
  if (!pair.providerId || !pair.modelId) {
    logger.debug('candidate skipped: missing provider/model id', pair)
    return null
  }
  const settingsUserId = getSettingsScopeUserId()
  const provider = llmProviderRepo.getOwned(settingsUserId, pair.providerId)
  if (!provider) {
    logger.debug('candidate skipped: provider not found in settings scope', {
      providerId: pair.providerId,
      settingsUserId
    })
    return null
  }
  if (!provider.apiKeyEncrypted) {
    logger.debug('candidate skipped: provider has no api key', {
      providerId: pair.providerId
    })
    return null
  }
  if (!provider.enabled) {
    logger.debug('candidate skipped: provider disabled', {
      providerId: pair.providerId
    })
    return null
  }
  if (!isProviderType(provider.type)) {
    logger.debug('candidate skipped: unsupported provider type', {
      providerId: pair.providerId,
      type: provider.type
    })
    return null
  }
  const adapter = createAdapter(
    provider.type,
    decryptApiKey(provider.apiKeyEncrypted),
    provider.id
  )
  if (!adapter) {
    logger.debug('candidate skipped: adapter factory returned null', {
      providerId: pair.providerId,
      type: provider.type
    })
    return null
  }
  return { adapter, modelId: pair.modelId }
}

/**
 * Build the ordered provider/model candidate list for a chat: its own chat
 * mode, then the user's default chat mode, then (LLM chats) the chat's bound
 * provider/model. Shared by the adapter resolver and the provider/model-pair
 * resolver so both honor the same precedence.
 */
function buildChatModeCandidates(
  userId: string,
  chatId: string
): Array<{ source: string } & ProviderModelPair> {
  const chat = chatRepo.getOwned(userId, chatId)
  if (!chat) {
    throw new AiFunctionError('no_provider', 'Chat not found for AI-function adapter resolution')
  }
  // Chat modes are scoped to the settings (shared) user, not the active profile.
  const settingsUserId = getSettingsScopeUserId()

  const candidates: Array<{ source: string } & ProviderModelPair> = []
  if (chat.modeId) {
    const mode = chatModeRepo.getOwned(settingsUserId, chat.modeId)
    if (mode) {
      candidates.push({ source: 'chat-mode', providerId: mode.providerId, modelId: mode.modelId })
    }
  }
  const defaultMode = chatModeRepo.list(settingsUserId).find((m) => m.isDefault)
  if (defaultMode) {
    candidates.push({
      source: 'default-mode',
      providerId: defaultMode.providerId,
      modelId: defaultMode.modelId
    })
  }
  if (chat.providerId && chat.modelId) {
    candidates.push({ source: 'chat-bound', providerId: chat.providerId, modelId: chat.modelId })
  }

  logger.debug('resolve adapter candidates', {
    chatId,
    profileUserId: userId,
    settingsUserId,
    chatModeId: chat.modeId,
    defaultModeId: defaultMode?.id ?? null,
    candidates: candidates.map((c) => ({
      source: c.source,
      providerId: c.providerId,
      modelId: c.modelId
    }))
  })

  return candidates
}

/**
 * One-shot LLM utilities shared across features that need to run a short,
 * non-streaming, non-tool LLM call — Smart Rewrite (multi-agent), future
 * chat-title autogeneration, future chat-summary, etc.
 *
 * Two pieces:
 *   - adapter resolvers — pick `{adapter, modelId}` from a chat's chat mode
 *     or the user's default chat mode
 *   - runSingleShot — execute the call against the resolved adapter
 *
 * Callers compose these and map `AiFunctionError` codes to their own
 * domain errors before crossing IPC.
 */
export const aiFunctions = {
  /**
   * Resolve the provider/model pair an orchestrated chat should run on, using
   * the same precedence as the adapter resolver (chat mode → default mode →
   * chat-bound). Each candidate is validated via {@link tryResolve} so a
   * provider that is missing, disabled, or has no key is skipped. Throws
   * `AiFunctionError('no_provider')` when none are usable — the caller maps
   * this to the "configure a model" refusal when promoting a chat.
   */
  resolveProviderModelFromChatMode(
    userId: string,
    chatId: string
  ): { providerId: string; modelId: string } {
    const candidates = buildChatModeCandidates(userId, chatId)
    for (const candidate of candidates) {
      if (candidate.providerId && candidate.modelId && tryResolve(candidate)) {
        logger.info('resolved provider/model', {
          source: candidate.source,
          providerId: candidate.providerId,
          modelId: candidate.modelId
        })
        return { providerId: candidate.providerId, modelId: candidate.modelId }
      }
    }
    logger.warn('no provider/model resolved', { chatId, profileUserId: userId })
    throw new AiFunctionError(
      'no_provider',
      'No chat mode with a configured LLM provider is available for this AI function'
    )
  },

  /**
   * Resolve an adapter from the user's default chat mode only. Useful for
   * AI functions that run before a chat exists (e.g. generating a title
   * from the first user message on a brand-new chat).
   */
  resolveAdapterFromDefaultMode(_userId: string): ResolvedAdapter {
    const settingsUserId = getSettingsScopeUserId()
    const defaultMode = chatModeRepo.list(settingsUserId).find((m) => m.isDefault)
    if (defaultMode) {
      const resolved = tryResolve({
        providerId: defaultMode.providerId,
        modelId: defaultMode.modelId
      })
      if (resolved) return resolved
    }
    throw new AiFunctionError(
      'no_provider',
      'No default chat mode with a configured LLM provider is available'
    )
  },

  /**
   * Run a single-shot LLM call: system prompt + user text in, trimmed text
   * out. Streaming is internally consumed but never propagated to the
   * caller — these are utility calls, not conversational. Tool use is not
   * enabled.
   *
   * Throws `AiFunctionError('llm_failed')` on adapter errors and
   * `AiFunctionError('empty_output')` when the model returns nothing
   * usable after trimming.
   */
  async runSingleShot(input: RunSingleShotInput): Promise<string> {
    const {
      adapter,
      modelId,
      systemPrompt,
      userText,
      label = 'ai-function',
      maxOutputChars,
      signal
    } = input

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ]

    try {
      const started = Date.now()
      const result = await adapter.stream({
        model: modelId,
        messages,
        onDelta: () => {
          /* utility call — caller does not subscribe to streamed deltas */
        },
        signal
      })
      const trimmed = result.content.trim()
      const output = maxOutputChars ? trimmed.slice(0, maxOutputChars) : trimmed
      logger.info('single-shot complete', {
        label,
        modelId,
        providerType: adapter.providerType,
        duration: Date.now() - started,
        inLen: userText.length,
        outLen: output.length
      })
      if (!output) {
        throw new AiFunctionError(
          'empty_output',
          `${label}: model returned empty output`
        )
      }
      return output
    } catch (err) {
      if (err instanceof AiFunctionError) throw err
      const detail = err instanceof Error ? err.message : String(err)
      logger.error('single-shot failed', { label, modelId, error: detail })
      throw new AiFunctionError('llm_failed', `${label} LLM call failed`, detail)
    }
  }
}
