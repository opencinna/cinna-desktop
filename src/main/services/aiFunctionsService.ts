import { appSettingsRepo } from '../db/appSettings'
import { llmProviderRepo, type LlmProviderRow } from '../db/llmProviders'
import { decryptApiKey } from '../security/keystore'
import { requiresApiKey } from '../../shared/credentials'
import { createAdapter, isProviderType } from '../llm/factory'
import { DomainError } from '../errors'
import { createLogger } from '../logger/logger'
import { getManagedResourceScopes } from '../auth/scope'
import type { LLMAdapter, ChatMessage } from '../llm/types'

const logger = createLogger('ai-functions')

export type AiFunctionErrorCode = 'llm_failed' | 'empty_output'

export class AiFunctionError extends DomainError<AiFunctionErrorCode> {}

export type AiFunctionBackend =
  | { kind: 'adapter'; adapter: LLMAdapter; modelId: string }
  | { kind: 'runtime'; userId: string }

export const AI_FUNCTION_TIMEOUT_MS = 90_000
export const AI_FUNCTION_MAX_OUTPUT_CHARS = 16_000

export interface RunSingleShotInput {
  backend: AiFunctionBackend
  /** Background titles may reuse a warm runtime, but must not spawn one. */
  warmOnly?: boolean
  systemPrompt: string
  userText: string
  /** Short tag emitted in logs (`label=rewrite`, `label=title`, etc.). */
  label?: string
  /** Truncate output, bounded by the shared AI-function ceiling. */
  maxOutputChars?: number
  signal?: AbortSignal
}

interface ProviderModelPair {
  providerId: string | null
  modelId: string | null
}

/**
 * User credentials live in Default scope; managed credentials may live in the
 * active profile. Resolve the explicit AI Functions binding across both.
 */
function tryResolve(pair: ProviderModelPair): Extract<AiFunctionBackend, { kind: 'adapter' }> | null {
  if (!pair.providerId) {
    logger.debug('candidate skipped: missing provider/model id', pair)
    return null
  }
  // User-created providers live in Default scope; account-provisioned managed
  // ones in the active Profile scope. Search both.
  let provider: LlmProviderRow | undefined
  for (const scope of getManagedResourceScopes()) {
    provider = llmProviderRepo.getOwned(scope, pair.providerId)
    if (provider) break
  }
  if (!provider) {
    logger.debug('candidate skipped: provider not found', { providerId: pair.providerId })
    return null
  }
  // A keyless credential (Ollama) has no key to be missing, and skipping it here
  // would silently exclude a local model from every AI function — chat titles,
  // drafted prompts — while it worked perfectly well for chat. The symptom would
  // be a feature that quietly does nothing for exactly the users who chose to run
  // everything locally.
  if (!provider.apiKeyEncrypted && requiresApiKey(provider.type)) {
    logger.debug('candidate skipped: provider has no api key', {
      providerId: pair.providerId
    })
    return null
  }
  // A managed subscription token that cannot call the API is not a usable
  // one-shot credential, even while its associated runtime can authenticate.
  if (!provider.enabled || provider.unsupported) {
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
    provider.apiKeyEncrypted ? decryptApiKey(provider.apiKeyEncrypted) : '',
    provider.id,
    {
      baseUrl: provider.baseUrl,
      fallbackModels:
        provider.availableModels && provider.availableModels.length > 0
          ? provider.availableModels
          : provider.defaultModelId
            ? [provider.defaultModelId]
            : []
    }
  )
  if (!adapter) {
    logger.debug('candidate skipped: adapter factory returned null', {
      providerId: pair.providerId,
      type: provider.type
    })
    return null
  }
  const modelId = pair.modelId || provider.defaultModelId || provider.availableModels?.[0]
  return modelId ? { kind: 'adapter', adapter, modelId } : null
}

/** The stale credential last warned about, so the fallback logs once, not per call. */
let warnedStaleCredentialId: string | null = null

/** AI Functions have their own binding; chat modes never choose this backend. */
export const aiFunctions = {
  resolveBackend(userId: string): AiFunctionBackend {
    const providerId = appSettingsRepo.get('aiFunctionsCredentialId').trim()
    if (!providerId) return { kind: 'runtime', userId }
    const resolved = tryResolve({ providerId, modelId: appSettingsRepo.get('aiFunctionsModelId').trim() || null })
    if (resolved) {
      warnedStaleCredentialId = null
      return resolved
    }
    // A deleted, disabled or keyless credential falls back to the Default
    // runtime rather than failing every title and draft; Settings → Features
    // still marks it missing. Warned once per stale credential, not per call.
    if (warnedStaleCredentialId !== providerId) {
      warnedStaleCredentialId = providerId
      logger.warn('AI Functions credential unavailable; using the default runtime', { providerId })
    }
    return { kind: 'runtime', userId }
  },

  /** Both backends obey the same cancellation, timeout and output contract. */
  async runSingleShot(input: RunSingleShotInput): Promise<string> {
    const { backend, systemPrompt, userText, label = 'ai-function' } = input
    const cap = Math.max(1, Math.min(input.maxOutputChars ?? AI_FUNCTION_MAX_OUTPUT_CHARS, AI_FUNCTION_MAX_OUTPUT_CHARS))
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
    if (input.signal?.aborted) forwardAbort()
    const timeout = setTimeout(() => controller.abort(new Error('AI function timed out')), AI_FUNCTION_TIMEOUT_MS)
    timeout.unref?.()
    let removeAbort = (): void => {}
    try {
      controller.signal.throwIfAborted()
      const started = Date.now()
      const work = async (): Promise<string> => {
        if (backend.kind === 'runtime') {
          const { runAiFunctionOnRuntime } = await import('./aiFunctionRuntimeService')
          controller.signal.throwIfAborted()
          return runAiFunctionOnRuntime({
            userId: backend.userId, systemPrompt, userText, warmOnly: input.warmOnly ?? false,
            signal: controller.signal, maxOutputChars: cap
          })
        }
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt }, { role: 'user', content: userText }
        ]
        const result = await backend.adapter.stream({ model: backend.modelId, messages, onDelta: () => {}, signal: controller.signal })
        return result.content
      }
      // A provider ignoring its abort signal cannot hold a draft/title caller.
      const canceled = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(controller.signal.reason ?? new Error('AI function canceled'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
        removeAbort = () => controller.signal.removeEventListener('abort', onAbort)
      })
      const output = (await Promise.race([work(), canceled])).trim().slice(0, cap)
      if (!output) throw new AiFunctionError('empty_output', `${label}: model returned empty output`)
      logger.info('single-shot complete', { label, backend: backend.kind, duration: Date.now() - started, inLen: userText.length, outLen: output.length })
      return output
    } catch (error) {
      if (error instanceof AiFunctionError) throw error
      const detail = error instanceof Error ? error.message : String(error)
      logger.warn('single-shot failed', { label, backend: backend.kind, error: detail })
      throw new AiFunctionError('llm_failed', `${label} call failed`, detail)
    } finally {
      clearTimeout(timeout)
      removeAbort()
      input.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
