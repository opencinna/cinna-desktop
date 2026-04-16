import { setCurrentUser } from './session'
import { reloadUserProviders } from './reload'
import { clearAllAdapters } from '../llm/registry'
import { mcpManager } from '../mcp/manager'

/**
 * Centralizes user session activation — LLM adapters and MCP connectors
 * only start when a user is explicitly authenticated through the auth flow.
 */
class UserActivation {
  private _activated = false

  isActivated(): boolean {
    return this._activated
  }

  /** Activate a user session: set current user, load their providers, open the gate. */
  async activate(userId: string): Promise<void> {
    setCurrentUser(userId)
    await reloadUserProviders()
    this._activated = true
  }

  /** Tear down the active session without loading any providers. */
  async deactivate(): Promise<void> {
    this._activated = false
    clearAllAdapters()
    await mcpManager.disconnectAll()
    setCurrentUser('__default__')
  }

  /** Guard for IPC handlers — throws if no user is activated. */
  requireActivated(): void {
    if (!this._activated) {
      throw new Error('Session not activated — user must authenticate first')
    }
  }
}

export const userActivation = new UserActivation()
