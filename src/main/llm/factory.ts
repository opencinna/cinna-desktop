import { AnthropicAdapter } from './anthropic'
import { OpenAIAdapter } from './openai'
import { GeminiAdapter } from './gemini'
import { LLMAdapter } from './types'

export type ProviderType = 'anthropic' | 'openai' | 'gemini'

export function isProviderType(type: string): type is ProviderType {
  return type === 'anthropic' || type === 'openai' || type === 'gemini'
}

export function createAdapter(
  type: string,
  apiKey: string,
  providerId: string
): LLMAdapter | null {
  switch (type) {
    case 'anthropic':
      return new AnthropicAdapter(apiKey, providerId)
    case 'openai':
      return new OpenAIAdapter(apiKey, providerId)
    case 'gemini':
      return new GeminiAdapter(apiKey, providerId)
    default:
      return null
  }
}
