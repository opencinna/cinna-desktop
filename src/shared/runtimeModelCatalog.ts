import type { AgentEngine } from './engine'

export interface RuntimeModelChoice {
  id: string
  name: string
  description?: string
}

/** Models last advertised by this profile's runtime session, never a live probe. */
export interface RuntimeModelCatalog {
  engine: AgentEngine
  models: RuntimeModelChoice[]
  source: 'session' | 'unavailable'
  updatedAt: number | null
}
