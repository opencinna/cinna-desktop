import { AnthropicAdapter } from './anthropic'
import { OpenAIAdapter } from './openai'
import { GeminiAdapter } from './gemini'
import { LLMAdapter } from './types'

export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'openai_compatible'

export function isProviderType(type: string): type is ProviderType {
  return (
    type === 'anthropic' ||
    type === 'openai' ||
    type === 'gemini' ||
    type === 'openai_compatible'
  )
}

/** Extra construction options for adapters that need per-provider config. */
export interface CreateAdapterOptions {
  /** Custom API base URL — required for `openai_compatible` gateways. */
  baseUrl?: string | null
  /** Models to advertise when a gateway doesn't implement live model listing. */
  fallbackModels?: string[]
}

export function createAdapter(
  type: string,
  apiKey: string,
  providerId: string,
  opts: CreateAdapterOptions = {}
): LLMAdapter | null {
  switch (type) {
    case 'anthropic':
      return new AnthropicAdapter(apiKey, providerId)
    case 'openai':
      return new OpenAIAdapter(apiKey, providerId)
    // OpenAI-compatible gateways (self-hosted / enterprise) speak the same wire
    // protocol; the only difference is the base URL. The credential's model is
    // the source of truth since live `models.list()` is often unimplemented.
    case 'openai_compatible':
      return new OpenAIAdapter(apiKey, providerId, {
        baseURL: opts.baseUrl ?? undefined,
        fallbackModels: opts.fallbackModels
      })
    case 'gemini':
      return new GeminiAdapter(apiKey, providerId)
    default:
      return null
  }
}
