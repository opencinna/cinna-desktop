/**
 * Shape of `agents.remoteMetadata` for agents synced from a Cinna backend
 * (`source === 'remote'`). Populated by `agentService.syncRemoteAgents` from
 * fields on the `/api/v1/external/agents` response.
 *
 * Local agents store `null` here. Keep this file purely type-only so it can
 * be imported from both Electron processes.
 */
export interface RemoteAgentMetadata {
  entrypoint_prompt: string | null
  example_prompts: string[]
  session_mode: string | null
  ui_color_preset: string | null
  protocol_versions: string[]
  /** Carries through any extra fields the backend attaches under `metadata`. */
  [key: string]: unknown
}
