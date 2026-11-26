import type { AgentReadiness } from '../../../../shared/agentDrivers'
import type { CustomAgentConfig } from '../../../../shared/customAgents'
import type { LocalAgentKind } from '../../../../shared/localAgents'
import type { LocalPermissionRequest } from '../../../../shared/localAgentRequests'
import type { ReadinessOptions } from '../driver'
import type { AcpRuntimeMode } from './types'

export interface AcpFolderView {
  coordinatorHandback?: boolean
  name: string
  slug: string
  description: string
  path: string
  kind: LocalAgentKind
  /** Whether this turn's session is sealed by the desktop or the folder's own. */
  runtimeMode: AcpRuntimeMode
  enabled: boolean
  readiness: string
  readinessReason: string | null
  /** `folderReadinessBlocksTurn` of the folder; absent is false. An `invalid` folder whose findings are only findings still runs. */
  blocksTurn?: boolean
  runtime: { engine?: unknown } | null
  /**
   * For the one main-log line per turn: the model this turn resolves to and
   * what decided its engine (`runsOnSourceLabel`). A function, so readiness
   * reads of the view never pay for a credential lookup. Absent in tests.
   */
  describeRuntime?: () => { model: string | null; source: string }
  /**
   * Set for an agent in an Agent Vault: `path` is the guest's agent folder,
   * nothing of it is on this computer, and the driver takes the vault branch
   * (`AcpDriverDeps.vault`) for the launcher, readiness and the turn's hold.
   */
  vault?: { vaultId: string; engine: import('../../../../shared/vault/protocol').VaultEngine }
}

/** Captured storage authority. External state never impersonates a folder. */
export interface AcpRuntimeState {
  validate(chatId?: string): void
  readSession(chatId: string): string | null
  saveSession(chatId: string, sessionId: string): void
  isGranted(request: LocalPermissionRequest): boolean
  rememberGrant(request: LocalPermissionRequest): boolean
  /** Where an *Always allow* is kept, when it is not the agent: a chat runtime's grants are the chat's. */
  rememberScope?: 'chat'
}

export type AcpRuntimeView = AcpRuntimeState & (
  | { type: 'folder'; folder: AcpFolderView }
  | {
      type: 'external'; name: string; enabled: boolean
      config: CustomAgentConfig; binding: string; accessToken?: string
      readiness(options?: ReadinessOptions): Promise<AgentReadiness | null>
    }
)
