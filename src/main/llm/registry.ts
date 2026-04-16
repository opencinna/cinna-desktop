import { LLMAdapter, ModelInfo } from './types'

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
      console.error(`Failed to list models for provider ${providerId}:`, err)
    }
  }
  return allModels
}
