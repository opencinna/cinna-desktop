import { LLMAdapter, ModelInfo } from './types'
import { createLogger } from '../logger/logger'

const logger = createLogger('llm-registry')

const adapters = new Map<string, LLMAdapter>()

export function registerAdapter(providerId: string, adapter: LLMAdapter): void {
  adapters.set(providerId, adapter)
}

export function unregisterAdapter(providerId: string): void {
  adapters.delete(providerId)
}

export function clearAllAdapters(): void {
  adapters.clear()
}

export function getAdapter(providerId: string): LLMAdapter | undefined {
  return adapters.get(providerId)
}

export async function getAllModels(): Promise<ModelInfo[]> {
  const allModels: ModelInfo[] = []
  for (const [providerId, adapter] of adapters) {
    try {
      const models = await adapter.listModels()
      allModels.push(
        ...models.map((m) => ({ ...m, providerId }))
      )
    } catch (err) {
      logger.error('failed to list models', {
        providerId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return allModels
}
