import type { ScriptRuntimeCheckpoint } from '../tasks/scriptRuntimeTypes'
import type { LocalScheduleDefinition, LocalScheduleOccurrence } from '../../shared/localSchedules'
import type { TaskScript } from '../../shared/taskScript'
import type { TaskRuntimeCheckpoint } from '../tasks/runtimeTypes'
import { sqliteTable, text, integer, blob, primaryKey } from 'drizzle-orm/sqlite-core'
import type { MessagePart } from '../../shared/messageParts'
import type { RemoteAgentMetadata } from '../../shared/agentMetadata'
import type { MessageAttachment } from '../../shared/attachments'
import type { JobDepDescriptor, JobSyncManifest } from '../../shared/sync'
import type { ChatRouter } from '../../shared/chatRouting'
import type { ChatRunResultStatus } from '../../shared/chatRunResult'
import type { InputRequest, InputResumeMode } from '../../shared/runEvents'
import type { RequestResolution } from '../../shared/localAgentRequests'
import type { TaskStatus } from '../../shared/taskStatus'
import type { TaskHandoffReceipt } from '../../shared/taskHandoff'
import type {
  TaskArtifact,
  TaskAssignee,
  TaskBudget,
  TaskExecutor,
  TaskInputRequestStatus,
  TaskOrigin,
  TaskPriority,
  TaskRouter
} from '../../shared/tasks'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  type: text('type').notNull().default('local_user'), // 'local_user' | 'cinna_user'
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash'),
  salt: text('salt'),
  cinnaFullName: text('cinna_full_name'),
  cinnaServerUrl: text('cinna_server_url'),
  cinnaHostingType: text('cinna_hosting_type'), // 'cloud' | 'self_hosted'
  cinnaClientId: text('cinna_client_id'),
  cinnaAccessTokenEnc: blob('cinna_access_token_enc', { mode: 'buffer' }),
  cinnaRefreshTokenEnc: blob('cinna_refresh_token_enc', { mode: 'buffer' }),
  cinnaTokenExpiresAt: integer('cinna_token_expires_at'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

export const llmProviders = sqliteTable('llm_providers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('__default__'),
  type: text('type').notNull(), // 'anthropic' | 'openai' | 'gemini' | 'openai_compatible'
  name: text('name').notNull(),
  configRevision: integer('config_revision').notNull().default(0),
  apiKeyEncrypted: blob('api_key_enc', { mode: 'buffer' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  defaultModelId: text('default_model_id'),
  /**
   * Curated list of selectable model ids for a managed provider — the Cinna
   * account-config `suggested_models` (admin-curated `available_models`, else the
   * key's `discovered_models`). When non-empty it REPLACES the adapter's model
   * list in the picker (`providerService.listModels`), so the user only sees the
   * models the admin offered. Null/empty for local providers and managed
   * providers with no curation (the adapter list applies as before).
   */
  availableModels: text('available_models', { mode: 'json' }).$type<string[]>(),
  /**
   * Custom API base URL — used by `openai_compatible` providers (self-hosted /
   * enterprise gateways) so the OpenAI adapter targets the right endpoint.
   * Null for the native first-party providers.
   */
  baseUrl: text('base_url'),
  /**
   * True when this provider was auto-materialized from the Cinna account-config
   * endpoint. Sync owns the row content; the row is profile-scoped and read-only
   * in the user's own UI. See `accountConfigService` + `docs/llm/account_provisioning`.
   */
  managed: integer('managed', { mode: 'boolean' }).notNull().default(false),
  /**
   * For managed rows: true when the underlying Cinna credential was provisioned
   * by an admin (`is_admin_managed`), false when it's the user's own Cinna-account
   * credential. Drives the "Managed by your administrator" vs "From your account"
   * UI distinction. Always false for non-managed (local) providers.
   */
  adminManaged: integer('admin_managed', { mode: 'boolean' }).notNull().default(false),
  /**
   * For managed rows: the credential exists but cannot be used for API calls in
   * the app (e.g. an Anthropic OAuth token `sk-ant-oat…`, valid for the Claude
   * apps but not the Messages API). Such rows are still materialized so they show
   * in the AI-credentials list, but get no adapter and no auto-created chat mode;
   * the UI shows a "Not supported" badge. Always false for usable/local providers.
   */
  unsupported: integer('unsupported', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

export const mcpProviders = sqliteTable('mcp_providers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('__default__'),
  name: text('name').notNull(),
  transportType: text('transport_type').notNull(), // 'stdio' | 'sse' | 'streamable-http'
  command: text('command'),
  args: text('args', { mode: 'json' }).$type<string[]>(),
  url: text('url'),
  env: text('env', { mode: 'json' }).$type<Record<string, string>>(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  authTokensEncrypted: blob('auth_tokens_enc', { mode: 'buffer' }),
  clientInfo: text('client_info', { mode: 'json' }).$type<Record<string, unknown>>(),
  oauthDiscoveryState: text('oauth_discovery_state', { mode: 'json' }).$type<import('@modelcontextprotocol/client').OAuthDiscoveryState>(),
  configRevision: integer('config_revision').notNull().default(0),
  /**
   * How a remote (sse / streamable-http) server authenticates: `'oauth'` (DCR,
   * the historic default — also covers servers needing no auth at all, since
   * the OAuth-capable transport just never hits a 401) or `'bearer'` (a static
   * token the user pastes in, sent as `Authorization: Bearer <token>`).
   * Unused for `stdio` transport.
   */
  authType: text('auth_type').notNull().default('oauth'), // 'oauth' | 'bearer'
  bearerTokenEncrypted: blob('bearer_token_enc', { mode: 'buffer' }),
  /**
   * True when this provider was auto-created from a synced job dependency
   * descriptor (disabled "finish setup" shell). Lets the UI mark it amber and
   * cleanup tools distinguish it from user-created providers. Never
   * auto-connected — the user finishes setup (creds/env) before it runs.
   */
  createdBySync: integer('created_by_sync', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('__default__'),
  title: text('title').notNull().default('New Chat'),
  modelId: text('model_id'),
  providerId: text('provider_id'),
  modeId: text('mode_id'),
  agentId: text('agent_id'),
  /**
   * Who answers a message in this chat — `direct` (the bound agent, or the
   * local model when `agentId` is null), `human` (several agents, the user
   * addresses one per message), or `coordinator` (the local model conducts,
   * calling agents and MCP servers as tools). See `src/shared/chatRouting.ts`,
   * which is the only place the value is interpreted.
   */
  router: text('router').$type<ChatRouter>().notNull().default('direct'),
  /**
   * When a chat is spawned by a Job's `executeLocal`, this carries the
   * `job_runs.id` so the stream-completion hook can flip the run's status
   * without the renderer having to remember the pairing.
   */
  originatingJobRunId: text('originating_job_run_id'),
  /**
   * When true, the chat does not appear in the main Chats sidebar list.
   * Used by job-spawned chats so the user's chat list isn't cluttered with
   * every job run. The user can promote a hidden chat to the list via the
   * "Move to Chats" button on the run row (which clears this flag).
   */
  hiddenFromList: integer('hidden_from_list', { mode: 'boolean' }).notNull().default(false),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

export const chatRunResults = sqliteTable('chat_run_results', {
  chatId: text('chat_id').primaryKey().references(() => chats.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  status: text('status').$type<ChatRunResultStatus>().notNull(),
  unread: integer('unread', { mode: 'boolean' }).notNull().default(true)
})

/** A direct-chat agent turn that has started and not yet ended. See `migrations/inflight-turns.ts`. */
export const inflightTurns = sqliteTable('inflight_turns', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  driver: text('driver').notNull(),
  userMessageId: text('user_message_id'),
  draftMessageId: text('draft_message_id'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull()
})

export const chatMcpProviders = sqliteTable(
  'chat_mcp_providers',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    mcpProviderId: text('mcp_provider_id')
      .notNull()
      .references(() => mcpProviders.id, { onDelete: 'cascade' })
  },
  (table) => [primaryKey({ columns: [table.chatId, table.mcpProviderId] })]
)

/**
 * On-demand MCP attachments: MCPs the user `@-mentions` into a specific chat
 * to engage them lazily without bloating every chat's token budget. Lives
 * separately from `chat_mcp_providers` (which is owned by the chat mode) so
 * the user's per-chat engagements don't tangle with the mode's baseline set.
 *
 * `pendingAnnounce = true` means the silent "User specifically enabled MCP X"
 * prefix is still owed on the next send — flipped to false after the prefix
 * is consumed so follow-up turns don't repeat the announcement.
 */
export const chatOnDemandMcps = sqliteTable(
  'chat_on_demand_mcps',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    mcpProviderId: text('mcp_provider_id')
      .notNull()
      .references(() => mcpProviders.id, { onDelete: 'cascade' }),
    pendingAnnounce: integer('pending_announce', { mode: 'boolean' })
      .notNull()
      .default(true),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (table) => [primaryKey({ columns: [table.chatId, table.mcpProviderId] })]
)

export const chatModes = sqliteTable('chat_modes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('__default__'),
  name: text('name').notNull(),
  providerId: text('provider_id'),
  modelId: text('model_id'),
  mcpProviderIds: text('mcp_provider_ids', { mode: 'json' }).$type<string[]>().default([]),
  colorPreset: text('color_preset').notNull().default('slate'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  /**
   * True when this mode was auto-materialized from the Cinna account-config
   * endpoint (one default mode per provisioned credential). Profile-scoped,
   * sync-owned, read-only in the user's own UI. Mirrors `llmProviders.managed`.
   */
  managed: integer('managed', { mode: 'boolean' }).notNull().default(false),
  /** Mirrors {@link llmProviders.adminManaged} for the mode's credential. */
  adminManaged: integer('admin_managed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('__default__'),
  name: text('name').notNull(),
  description: text('description'),
  protocol: text('protocol').notNull(), // 'a2a' (extensible: more protocols later)
  cardUrl: text('card_url'), // A2A: well-known agent card URL
  endpointUrl: text('endpoint_url'), // resolved endpoint from agent card
  protocolInterfaceUrl: text('protocol_interface_url'), // resolved 0.3.x-compatible endpoint URL
  protocolInterfaceVersion: text('protocol_interface_version'), // matched protocol version (e.g. "0.3.0")
  accessTokenEncrypted: blob('access_token_enc', { mode: 'buffer' }),
  cardData: text('card_data', { mode: 'json' }).$type<Record<string, unknown>>(), // cached agent card JSON
  skills: text('skills', { mode: 'json' }).$type<Array<{ id: string; name: string; description?: string }>>(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  source: text('source').notNull().default('local'), // 'local' | 'remote' | 'folder'
  remoteTargetType: text('remote_target_type'), // 'agent' | 'app_mcp_route' | 'identity'
  remoteTargetId: text('remote_target_id'), // UUID from Cinna backend
  remoteMetadata: text('remote_metadata', { mode: 'json' }).$type<RemoteAgentMetadata>(), // entrypoint_prompt, example_prompts, etc.
  /**
   * True when this (local) agent was auto-created from a synced job dependency
   * descriptor — a disabled shell carrying just the card URL. The user enables
   * + configures it to finish setup; card fetch/token happen then.
   */
  createdBySync: integer('created_by_sync', { mode: 'boolean' }).notNull().default(false),
  /**
   * Folder agents only (`source = 'folder'`): the absolute path of the agent
   * folder on this machine. Null for A2A and Cinna-synced agents. Machine-local
   * and never synced — {@link agentRowToDescriptor} skips non-`'local'` rows.
   */
  localPath: text('local_path'),
  /** Folder agents only: the {@link agentRoots} row this folder was scanned
   *  from. No SQL FK on purpose — see `migrations/agent-roots.ts`. */
  localRootId: text('local_root_id'),
  /**
   * Which driver runs this agent. Every insert writes it; migrations backfill
   * legacy rows. Unknown values remain stored and visible but refuse execution.
   * Folder agents use ACP with their launcher in driverConfig.
   */
  driver: text('driver'),
  /** Driver-owned settings. Includes the ACP launcher; never a secret store. */
  driverConfig: text('driver_config', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

/**
 * Registered agents roots — the workshop folders the scanner walks. Exactly one
 * row per user carries `isDefault`: the agents home (`~/Documents/CinnaAgents`
 * unless the `localAgentsHome` app setting overrides it). Extra rows are folders
 * the user adopted, e.g. an existing kit workshop.
 *
 * Everything about a folder agent lives in the folder (Invariant 1); this table
 * only remembers *where to look*.
 */
export const agentRoots = sqliteTable('agent_roots', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  /** Absolute path of the workshop root (the folder containing `Local/`). */
  path: text('path').notNull(),
  /** Display name for the sidebar group. */
  label: text('label').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  /**
   * `'workshop'` — the kit shape: templates installed, agents under `Local/`.
   * `'external'` — a folder the user pointed at, walked for `AGENT.md` /
   * `AGENTS.md` / `CLAUDE.md`, never
   * written into. See `AgentRootKind` in `src/shared/localAgents.ts`.
   */
  kind: text('kind').notNull().default('workshop'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

/**
 * On-demand agent attachments: agents the user `@-mentions` into a specific
 * chat so the orchestrator (local LLM) can call them as emulated MCP tools.
 * Mirrors {@link chatOnDemandMcps} exactly — lives separately from chat-mode
 * config so per-chat engagements don't tangle with the mode's baseline set.
 *
 * `pendingAnnounce = true` means the silent "User specifically enabled agent X"
 * prefix is still owed on the next send — flipped to false after the prefix
 * is consumed so follow-up turns don't repeat the announcement.
 */
export const chatOnDemandAgents = sqliteTable(
  'chat_on_demand_agents',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    pendingAnnounce: integer('pending_announce', { mode: 'boolean' })
      .notNull()
      .default(true),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (table) => [primaryKey({ columns: [table.chatId, table.agentId] })]
)

/**
 * Per-profile enable/disable preference for synced agents. Sync owns the
 * `agents` row content (name, skills, etc.), so user-controllable state is
 * kept here — survives sync without being clobbered, and only affects whether
 * the agent appears in selectors.
 */
export const agentOverrides = sqliteTable(
  'agent_overrides',
  {
    userId: text('user_id').notNull(),
    agentId: text('agent_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })]
)

/**
 * Per-profile enable/disable preference for sync-managed LLM providers and
 * chat modes (materialized from the Cinna account-config endpoint). The synced
 * rows in `llm_providers` / `chat_modes` are owned by account-config sync, so
 * the user's local on/off choice is kept here — survives re-sync (and a
 * remove/re-add round-trip) without being clobbered, exactly like
 * {@link agentOverrides}. `kind` discriminates the two resource families so one
 * table backs both. Manual cleanup of a deleted user's rows happens in
 * `userRepo.deleteWithCascade`.
 */
export const managedOverrides = sqliteTable(
  'managed_overrides',
  {
    userId: text('user_id').notNull(),
    kind: text('kind').notNull(), // 'provider' | 'mode'
    resourceId: text('resource_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    // Per-mode model choice overriding the synced default (null = use default).
    modelId: text('model_id'),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (table) => [primaryKey({ columns: [table.userId, table.kind, table.resourceId] })]
)

export const a2aSessions = sqliteTable('a2a_sessions', {
  id: text('id').primaryKey(),
  chatId: text('chat_id')
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  contextId: text('context_id'), // server-assigned context for conversation continuity
  taskId: text('task_id'), // server-assigned task id for the current/last task
  taskState: text('task_state'), // last known task state (working, completed, etc.)
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

/** Private remote continuity; credential fingerprints never cross the IPC DTO. */
export const managedAgentSessions = sqliteTable('managed_agent_sessions', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  binding: text('binding').notNull(),
  sessionId: text('session_id').notNull(),
  state: text('state').notNull(),
  /** The current turn's acknowledged `user.message` id; relaunch recovery follows from it. */
  kickoffEventId: text('kickoff_event_id'),
  /** The chat's user row that kickoff answers; recovery follows it only for that row's turn. */
  kickoffMessageId: text('kickoff_message_id'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chatId: text('chat_id')
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant' | 'tool_call' | 'error' | 'agent_transition'
  content: text('content').notNull(),
  toolCallId: text('tool_call_id'),
  toolName: text('tool_name'),
  toolInput: text('tool_input', { mode: 'json' }).$type<Record<string, unknown>>(),
  toolCalls: text('tool_calls', { mode: 'json' }).$type<
    Array<{ id: string; name: string; input: Record<string, unknown> }>
  >(),
  toolError: integer('tool_error', { mode: 'boolean' }),
  toolProvider: text('tool_provider'),
  /** Agent id backing an orchestrated agent tool-call (drives the sub-thread's
   *  per-agent hash color); null for MCP tool calls and non-tool rows. */
  toolAgentId: text('tool_agent_id'),
  parts: text('parts', { mode: 'json' }).$type<MessagePart[]>(),
  /** File attachments persisted on user messages — drives badge rendering. */
  attachments: text('attachments', { mode: 'json' }).$type<MessageAttachment[]>(),
  /** Agent a user turn was routed to in a direct-A2A chat (null for LLM root). */
  addressedAgentId: text('addressed_agent_id'),
  /** Agent that produced an assistant turn in a direct-A2A chat (null for LLM root). */
  sourceAgentId: text('source_agent_id'),
  sortOrder: integer('sort_order').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

/**
 * A Job is a reusable unit of work — a saved spec (title, description, prompt,
 * execution config) the user can run repeatedly. Profile-scoped (per-account).
 * Two execution variants:
 *   - 'local'      → spawns a new chat seeded with the prompt; existing chat
 *                    pipeline drives the conversation.
 *   - 'cinna_task' → POSTs to cinna-core /api/v1/tasks/; the conversation lives
 *                    on cinna-core, desktop keeps a pointer + status.
 */
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type').notNull().default('local'), // 'local' | 'cinna_task'
  title: text('title').notNull(),
  description: text('description'),
  prompt: text('prompt').notNull(),
  router: text('router').$type<'coordinator' | 'script'>(),
  script: text('script', { mode: 'json' }).$type<TaskScript>(),
  budget: text('budget', { mode: 'json' }).$type<TaskBudget>(),
  agentId: text('agent_id'),
  modeId: text('mode_id'),
  cinnaAgentId: text('cinna_agent_id'),
  cinnaPriority: text('cinna_priority'), // 'low' | 'normal' | 'high' | 'urgent'
  colorPreset: text('color_preset'),
  iconName: text('icon_name'),
  /**
   * Optional sidebar folder this job lives in. Null = job sits at the root
   * level of the Jobs sidebar. Folders are user-defined groupings (see
   * `jobFolders`). No FK — folder deletes set this column to null manually.
   */
  folderId: text('folder_id'),
  /**
   * Sort key within its parent (folder or root). Lower = closer to the top.
   * Drag-drop renumbers all rows in the affected group; new jobs are inserted
   * at the top (min - 1). Real number to allow occasional gap-based inserts
   * without renumbering, but the move handler still rewrites the full set.
   */
  position: integer('position').notNull().default(0),
  /**
   * Portable dependency manifest ({modeName, deps[]}) — the synced truth for a
   * job's agents/MCPs/mode. The `jobAgents`/`jobMcpProviders` join rows +
   * `modeId` are the materialized resolvable subset. See `shared/sync.ts`
   * `JobSyncManifest` and `src/main/sync/manifest.ts`.
   */
  syncDeps: text('sync_deps', { mode: 'json' }).$type<JobSyncManifest>(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

/**
 * User-defined groupings for jobs in the sidebar. Profile-scoped. A folder is
 * a thin collapsible separator — it has a name, a sort position, and a
 * collapsed flag that persists across launches.
 */
export const jobFolders = sqliteTable('job_folders', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

export const jobMcpProviders = sqliteTable(
  'job_mcp_providers',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    mcpProviderId: text('mcp_provider_id')
      .notNull()
      .references(() => mcpProviders.id, { onDelete: 'cascade' })
  },
  (table) => [primaryKey({ columns: [table.jobId, table.mcpProviderId] })]
)

/**
 * Agents attached to a job. Replaces the single `jobs.agent_id` column so a
 * job can carry multiple counterparties (the orchestration model): at run time
 * `derivePattern(agentIds, mcpIds)` decides direct A2A (one agent, no MCPs) vs.
 * an orchestrated LLM-root chat. Mirrors {@link jobMcpProviders}.
 */
export const jobAgents = sqliteTable(
  'job_agents',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' })
  },
  (table) => [primaryKey({ columns: [table.jobId, table.agentId] })]
)

/**
 * One row per execution of a Job. For local runs `localChatId` points at the
 * spawned chat. For cinna_task runs `cinnaTaskId` + `cinnaShortCode` point at
 * the remote task. Status flips to a terminal value when the run finishes
 * (locally: when the first assistant turn finalizes; cinna: when polling
 * observes a terminal cinna-core status).
 */
export const jobRuns = sqliteTable('job_runs', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  type: text('type').notNull(), // 'local' | 'cinna_task'
  localChatId: text('local_chat_id').references(() => chats.id, { onDelete: 'set null' }),
  cinnaTaskId: text('cinna_task_id'),
  cinnaShortCode: text('cinna_short_code'),
  status: text('status').notNull().default('pending'), // pending | running | succeeded | failed | cancelled
  /**
   * The task this run produced (agent runtime plan, phase 5). Nullable: runs
   * that predate the tasks table are history, and `cinnaTaskId` /
   * `cinnaShortCode` above are mirrors of the task's `remoteId` / `remoteKey`
   * for one phase so a downgrade still finds the remote task.
   */
  taskId: text('task_id'),
  errorMessage: text('error_message'),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

/**
 * Tracks each agent's catch-up cursor per chat — the last message id that has
 * already been replayed to that agent. Catch-up packets start from the next
 * message after this cursor.
 *
 * What makes a `human` chat work: when the user addresses agent B after agent A
 * answered, B's driver is handed the thread it missed ahead of the user's text.
 * The cursor advances only when a turn **completes**, so a failed or cancelled
 * turn leaves the same gap for the retry to carry.
 *
 * A row exists only once an agent has taken a turn in the chat. No row means
 * "has seen nothing", which is what the first turn's whole-thread packet is.
 */
export const chatAgentCursors = sqliteTable(
  'chat_agent_cursors',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** The last message this agent has been shown. Null while it has seen none. */
    lastMessageId: text('last_message_id'),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (table) => [primaryKey({ columns: [table.chatId, table.agentId] })]
)

/**
 * The unit of work that outlives a chat view (agent runtime plan, phase 5).
 *
 * A task is a goal with a status, an assignee, a handoff note and artifacts.
 * SQLite is always where it lives; a linked profile may additionally carry it
 * to the user's other devices through app-sync, and bind it to a remote system
 * through a `RemoteTaskAdapter`. The status vocabulary is cinna-core's — see
 * `src/shared/taskStatus.ts` for why, and `migrations/tasks.ts` for why these
 * columns and not others.
 *
 * `origin` never changes; `executor` does, and flipping it is how work changes
 * hands. Field authority follows `executor` (`taskService`), not this table.
 */
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  /** The original ask, immutable once created. cinna's `original_message`. */
  goal: text('goal').notNull(),
  /** The working description, edited as the task is understood. cinna's `current_description`. */
  description: text('description'),
  status: text('status').$type<TaskStatus>().notNull().default('new'),
  priority: text('priority').$type<TaskPriority>().notNull().default('normal'),
  router: text('router').$type<TaskRouter>().notNull().default('direct'),

  origin: text('origin').$type<TaskOrigin>().notNull().default('local'),
  executor: text('executor').$type<TaskExecutor>().notNull().default('desktop'),
  /**
   * The sync device id running this task while `executor = 'desktop'`. Null
   * means *this* device, which is also what a profile with sync off always
   * has. The claim that keeps two devices from both believing they own a run.
   */
  executorDevice: text('executor_device'),

  /** Never synced — chats are not a synced collection, so a replica opens with no thread. */
  chatId: text('chat_id').references(() => chats.id, { onDelete: 'set null' }),
  /** Device-local `agents` row id. Never synced; `assigneeRef` travels instead. */
  assigneeAgentId: text('assignee_agent_id'),
  /** Display hint. May be stale, may name an agent that exists only on the remote. */
  assigneeName: text('assignee_name'),
  assigneeKind: text('assignee_kind')
    .$type<TaskAssignee['kind']>()
    .notNull()
    .default('model'),
  /** Portable assignee descriptor for app-sync — the `kind: 'agent'` arm of `JobDepDescriptor`. */
  assigneeRef: text('assignee_ref', { mode: 'json' }).$type<JobDepDescriptor | null>(),
  /** One level only. Enforced in `taskService`, not by the schema. */
  parentTaskId: text('parent_task_id'),
  /** Provenance. No FK: jobs can be deleted, and job runs do not sync at all. */
  jobId: text('job_id'),
  jobRunId: text('job_run_id'),

  /** The adapter's id. Null = a desktop-only task. Read nowhere outside `main/tasks/adapters/`. */
  remoteAdapter: text('remote_adapter'),
  remoteId: text('remote_id'),
  /** The remote's human key — a short code, `ENG-421`, `#1234`. Display only. */
  remoteKey: text('remote_key'),
  remoteUrl: text('remote_url'),
  /** Opaque to everything outside the adapter that wrote it. */
  remoteState: text('remote_state', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  /** Per-device bookkeeping: never synced, or a peer inherits a watermark it never earned. */
  remoteSyncedAt: integer('remote_synced_at', { mode: 'timestamp' }),
  /** Field names changed since the last successful push. Dirty-field, never whole-record. */
  remoteDirty: text('remote_dirty', { mode: 'json' }).$type<string[] | null>(),

  handoffNote: text('handoff_note'),
  artifacts: text('artifacts', { mode: 'json' }).$type<TaskArtifact[] | null>(),
  /** Read by the headless task runner in phase 6; carried across sync from here. */
  budget: text('budget', { mode: 'json' }).$type<TaskBudget | null>(),
  script: text('script', { mode: 'json' }).$type<TaskScript>(),
  errorMessage: text('error_message'),

  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
  /** App-sync carries tombstones, so a delete is a soft one. */
  deletedAt: integer('deleted_at', { mode: 'timestamp' })
})

/**
 * One open (or settled) human-input request against a task — the persistent
 * twin of `agents/drivers/pendingRequests`, which is in-memory and dies with the
 * turn.
 *
 * The id **is** the run's `requestId`, because that is already the address an
 * answer is posted to (`per_*` / `que_*` for a local agent). One id, one row,
 * one answer path.
 *
 * Deliberately **not** synced: a `reply`-mode ask is an address on this machine
 * that dies with the driver process holding it, so a row for it on another
 * device would offer a button nothing could answer. A remote's open asks get no
 * row at all — the remote is the registry and the desktop is the view.
 */
// Local execution receipts deliberately survive task deletion and do not sync.
export const taskHandoffs = sqliteTable('task_handoffs', {
  taskId: text('task_id').primaryKey(),
  userId: text('user_id').notNull(),
  chatId: text('chat_id'),
  receipt: text('receipt', { mode: 'json' }).$type<TaskHandoffReceipt>().notNull()
})

export const taskScriptRuntimes = sqliteTable('task_script_runtimes', {
  taskId: text('task_id').primaryKey().references(() => tasks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  checkpoint: text('checkpoint', { mode: 'json' }).$type<ScriptRuntimeCheckpoint>().notNull()
})

// Execution opt-in and receipts belong to one profile on this device. Job/task
// references deliberately survive their deletion so uncertainty stays visible.
export const localScheduleBindings = sqliteTable('local_schedule_bindings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  manifestId: text('manifest_id').notNull(),
  name: text('name').notNull(),
  definition: text('definition', { mode: 'json' }).$type<LocalScheduleDefinition>().notNull(),
  revision: text('revision').notNull(),
  jobId: text('job_id').notNull(),
  jobFingerprint: text('job_fingerprint').notNull(),
  jobIds: text('job_ids', { mode: 'json' }).$type<string[]>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  reason: text('reason'),
  watermark: integer('watermark').notNull()
})
export const localScheduleOccurrences = sqliteTable('local_schedule_occurrences', {
  id: text('id').primaryKey(),
  bindingId: text('binding_id').notNull().references(() => localScheduleBindings.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  civilKey: text('civil_key').notNull(),
  utcMinute: integer('utc_minute').notNull(),
  definition: text('definition', { mode: 'json' }).$type<LocalScheduleDefinition>().notNull(),
  revision: text('revision').notNull(),
  status: text('status').$type<LocalScheduleOccurrence['status']>().notNull(),
  taskId: text('task_id'),
  runId: text('run_id'),
  chatId: text('chat_id'),
  reason: text('reason')
})

export const taskRuntimes = sqliteTable('task_runtimes', {
  taskId: text('task_id').primaryKey().references(() => tasks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  checkpoint: text('checkpoint', { mode: 'json' }).$type<TaskRuntimeCheckpoint>().notNull()
})

export const taskInputRequests = sqliteTable('task_input_requests', {
  /** The run's `requestId`, verbatim. */
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull(),
  agentId: text('agent_id'),
  deliveryOwner: text('delivery_owner').$type<'driver' | 'runner'>().notNull().default('driver'),
  rootRunId: text('root_run_id'),
  invocationId: text('invocation_id'),
  /** The `InputRequest` from `shared/runEvents.ts`, verbatim — not a second union. */
  request: text('request', { mode: 'json' }).$type<InputRequest>().notNull(),
  resume: text('resume').$type<InputResumeMode>().notNull(),
  status: text('status').$type<TaskInputRequestStatus>().notNull().default('open'),
  resolution: text('resolution', { mode: 'json' }).$type<RequestResolution | null>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' })
})

/**
 * Local-store backed attachments. One row per file the user picked into a
 * chat composer where the destination is a raw LLM (no Cinna backend in the
 * picture). The actual bytes live at `storagePath` under `userData/files/...`;
 * this row carries the metadata the renderer and adapter need (filename, mime,
 * size). Cleanup follows the chat — `ON DELETE CASCADE` deletes the metadata
 * row, and a small post-delete sweep removes the on-disk blob.
 */
export const chatFiles = sqliteTable('chat_files', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  chatId: text('chat_id')
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' }),
  storagePath: text('storage_path').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  filename: text('filename').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

/**
 * A Note is a profile-scoped markdown document. Lightweight write-and-read
 * storage — the renderer edits the raw markdown text and renders it via the
 * same react-markdown stack used in chat bubbles.
 */
export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull().default('Untitled note'),
  body: text('body').notNull().default(''),
  /** Sidebar folder this note belongs to. Null = root. No FK (folder
   *  deletion detaches notes back to root manually, same as jobs). */
  folderId: text('folder_id'),
  position: integer('position').notNull().default(0),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

/**
 * User-defined groupings for notes in the sidebar. Profile-scoped. A thin
 * collapsible separator with a name, a sort position, and a collapsed flag —
 * directly mirrors `jobFolders`.
 */
export const noteFolders = sqliteTable('note_folders', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

/**
 * Installation-global key/value store for user-toggleable feature flags
 * (e.g. AI-function switches in Settings > Features). Values are stored as
 * JSON strings so the repo can hand back typed primitives without juggling
 * schema changes per flag.
 */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})
