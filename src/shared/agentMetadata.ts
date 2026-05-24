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
  /**
   * Bundle membership flags, only present for `target_type='agent'`:
   *   - `bundle_uuid` is the cinna-server `AgentBundle.id` this install
   *     descends from (null for unpublished agents).
   *   - `is_publisher_install` distinguishes the publisher's working copy
   *     (`true`) from a foreign install obtained via the catalog (`false`).
   * Together: `bundle_uuid != null && !is_publisher_install` ⇒ installed
   * from the catalog.
   */
  bundle_id?: string | null
  bundle_uuid?: string | null
  is_publisher_install?: boolean | null
  /** Carries through any extra fields the backend attaches under `metadata`. */
  [key: string]: unknown
}
