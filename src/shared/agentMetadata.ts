/**
 * Shape of `agents.remoteMetadata` for agents synced from a Cinna backend
 * (`source === 'remote'`). Populated by `agentService.syncRemoteAgents` from
 * fields on the `/api/v1/external/agents` response.
 *
 * Local agents store `null` here. Keep this file purely type-only so it can
 * be imported from both Electron processes.
 */
/**
 * The `cinna.mcp` descriptor — the shared contract a cinna-backend agent emits
 * to describe how it should be exposed as an emulated MCP tool to the
 * orchestrator LLM (agents-as-MCP wrapper). Carried on the external-agents
 * discovery payload under `mcp` and mirrored here in `remoteMetadata`. When
 * absent, the desktop synthesizes a minimal descriptor from the agent's
 * name/description/example_prompts (graceful fallback — also covers non-cinna
 * A2A agents).
 *
 * Note: the desktop deliberately ignores any `context_id` field the backend's
 * MCP exposes. The desktop persists `a2a_sessions` per (chat, agent) and
 * injects continuity itself — the orchestrator LLM only ever passes `message`.
 */
export interface CinnaMcpDescriptor {
  version: number
  /** Stable, backend-deconflicted slug for the LLM-facing tool name. */
  tool_name?: string
  display_name?: string
  description?: string
  /** The JSON schema the orchestrator LLM sees for the tool's input. */
  input_schema?: Record<string, unknown>
  capabilities?: {
    files?: boolean
    resources?: boolean
    run_commands?: boolean
  }
  example_prompts?: string[]
  run_commands?: Array<{ name: string; description?: string; invocation?: string }>
}

/**
 * Installed-vs-latest bundle version state for a consumer install, mirrored
 * straight from cinna-server's `BundleVersionInfo` on each
 * `/api/v1/external/agents` target. Present only for the caller's own
 * consumer installs (`target_type='agent'` with a `bundle_uuid` and
 * `is_publisher_install=false`); absent for publisher working copies, shared
 * routes, identity contacts, and plain (never-from-a-bundle) agents.
 *
 * `update_available` is server-derived from the monotonic `revision_number`
 * comparison (read-only — discovery never mutates `pending_update`). The
 * `*_version` strings are the publisher-supplied labels and may be null on
 * legacy revisions, in which case the UI falls back to the `*_revision_number`.
 */
export interface BundleVersionInfo {
  installed_revision_number: number | null
  installed_version: string | null
  latest_revision_number: number | null
  latest_version: string | null
  update_available: boolean
  update_mode: string | null
  last_update_status: string | null
}

export interface RemoteAgentMetadata {
  entrypoint_prompt: string | null
  example_prompts: string[]
  session_mode: string | null
  ui_color_preset: string | null
  protocol_versions: string[]
  /**
   * The agent's `cinna.mcp` descriptor when the backend supplied one. Consumed
   * by `A2AAsMcpProvider` to build the emulated MCP tool; absent ⇒ synthesize
   * a fallback from name/description/example_prompts.
   */
  cinna_mcp?: CinnaMcpDescriptor
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
  /**
   * Installed-vs-latest version state for the install, surfaced on the
   * external-agents discovery payload under `bundle_version`. Drives the
   * "vX → vY update available" affordance + in-app Update action on both the
   * Catalog card and the Agents list. Absent until a sync runs against a
   * server new enough to send it.
   */
  bundle_version?: BundleVersionInfo | null
  /** Carries through any extra fields the backend attaches under `metadata`. */
  [key: string]: unknown
}
