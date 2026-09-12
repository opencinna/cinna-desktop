import type { AgentReadiness } from '../../../../shared/agentDrivers'
import type { CustomAgentConfig } from '../../../../shared/customAgents'
import type { LocalAgentKind } from '../../../../shared/localAgents'
import type { LocalPermissionRequest } from '../../../../shared/localAgentRequests'
import type { ReadinessOptions } from '../driver'

export interface AcpFolderView {
  coordinatorHandback?: boolean
  name: string
  slug: string
  description: string
  path: string
  kind: LocalAgentKind
  enabled: boolean
  readiness: string
  readinessReason: string | null
  runtime: { engine?: unknown } | null
}

/** Captured storage authority. External state never impersonates a folder. */
export interface AcpRuntimeState {
  validate(chatId?: string): void
  readSession(chatId: string): string | null
  saveSession(chatId: string, sessionId: string): void
  isGranted(request: LocalPermissionRequest): boolean
  rememberGrant(request: LocalPermissionRequest): boolean
}

export type AcpRuntimeView = AcpRuntimeState & (
  | { type: 'folder'; folder: AcpFolderView }
  | {
      type: 'external'; name: string; enabled: boolean
      config: CustomAgentConfig; binding: string; accessToken?: string
      readiness(options?: ReadinessOptions): Promise<AgentReadiness | null>
    }
)
