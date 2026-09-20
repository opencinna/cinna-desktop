import type { AgentRow } from '../db/agents'
import type { DevelopmentContext } from '../../shared/developmentSession'

/** Optional desktop features. A headless host omits these entirely. */
export interface DesktopFeatures {
  authCompleted(): void
  clearDevelopment(): void
  reconcileDevelopment(userId: string): Promise<unknown>
  developmentAgentContext(userId: string, agentId: string): DevelopmentContext | null
  contextForDevelopmentAgent(row: AgentRow): DevelopmentContext
  restoreDevelopmentContext(row: AgentRow, options?: { fresh?: boolean }): Promise<DevelopmentContext>
  developmentExecutionContext(profileId: string): Promise<{ env: NodeJS.ProcessEnv }>
}

function unavailable(): never { throw new Error('Local Development is unavailable on this host.') }
const absent: DesktopFeatures = {
  authCompleted() {},
  clearDevelopment() {},
  async reconcileDevelopment() {},
  developmentAgentContext: () => null,
  contextForDevelopmentAgent: unavailable,
  restoreDevelopmentContext: unavailable,
  developmentExecutionContext: unavailable
}
let features: DesktopFeatures = absent
export function installDesktopFeatures(next: DesktopFeatures): void { features = next }
export const desktopFeatures: DesktopFeatures = new Proxy({} as DesktopFeatures, {
  get(_target, key: keyof DesktopFeatures) { return features[key].bind(features) }
})
