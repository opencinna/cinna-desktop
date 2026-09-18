import type { AgentEngine } from '../../shared/engine'
import type { RuntimeModelCatalog, RuntimeModelChoice } from '../../shared/runtimeModelCatalog'

const catalogs = new Map<string, RuntimeModelCatalog>()
const key = (userId: string, engine: AgentEngine): string => JSON.stringify([userId, engine])
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Observe session/new, session/load, or config_option_update; never starts a runtime. */
export function recordRuntimeModelCatalog(userId: string, engine: AgentEngine, metadata: unknown): void {
  const data = record(metadata)
  if (!data) return
  const options = Array.isArray(data.configOptions) ? data.configOptions : []
  const modelOption = options.map(record).find(option => option?.category === 'model' || option?.id === 'model')
  const models: RuntimeModelChoice[] = []
  const addOptions = (items: unknown[]): void => {
    for (const value of items) {
      const item = record(value)
      if (!item) continue
      if (Array.isArray(item.options)) addOptions(item.options)
      const id = typeof item.value === 'string' ? item.value : typeof item.modelId === 'string' ? item.modelId : null
      if (!id || models.some(model => model.id === id)) continue
      models.push({ id, name: typeof item.name === 'string' ? item.name : id,
        ...(typeof item.description === 'string' ? { description: item.description } : {}) })
    }
  }
  const available = record(data.models)?.availableModels
  if (modelOption && Array.isArray(modelOption.options)) addOptions(modelOption.options)
  else if (Array.isArray(available)) addOptions(available)
  else return // Unrelated updates must not erase the previously advertised catalog.
  catalogs.set(key(userId, engine), { engine, models, source: 'session', updatedAt: Date.now() })
}

export function getRuntimeModelCatalog(userId: string, engine: AgentEngine): RuntimeModelCatalog {
  const catalog = catalogs.get(key(userId, engine))
  return catalog ? { ...catalog, models: catalog.models.map(model => ({ ...model })) }
    : { engine, models: [], source: 'unavailable', updatedAt: null }
}
