import { sqliteTable, text, integer, blob, primaryKey } from 'drizzle-orm/sqlite-core'
import type { MessagePart } from '../../shared/messageParts'
import type { RemoteAgentMetadata } from '../../shared/agentMetadata'
import type { MessageAttachment } from '../../shared/attachments'

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
  type: text('type').notNull(), // 'anthropic' | 'openai' | 'gemini'
  name: text('name').notNull(),
  apiKeyEncrypted: blob('api_key_enc', { mode: 'buffer' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  defaultModelId: text('default_model_id'),
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
  activeAgentId: text('active_agent_id'),
  smartAssistDisabled: integer('smart_assist_disabled', { mode: 'boolean' })
    .notNull()
    .default(false),
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
  source: text('source').notNull().default('local'), // 'local' | 'remote'
  remoteTargetType: text('remote_target_type'), // 'agent' | 'app_mcp_route' | 'identity'
  remoteTargetId: text('remote_target_id'), // UUID from Cinna backend
  remoteMetadata: text('remote_metadata', { mode: 'json' }).$type<RemoteAgentMetadata>(), // entrypoint_prompt, example_prompts, etc.
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

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
  parts: text('parts', { mode: 'json' }).$type<MessagePart[]>(),
  /** File attachments persisted on user messages — drives badge rendering. */
  attachments: text('attachments', { mode: 'json' }).$type<MessageAttachment[]>(),
  // Multi-agent routing metadata
  addressedAgentId: text('addressed_agent_id'),
  rewrittenText: text('rewritten_text'),
  originalText: text('original_text'),
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
 */
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

export const chatAgentSessions = sqliteTable(
  'chat_agent_sessions',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    lastReplayedMessageId: text('last_replayed_message_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (table) => [primaryKey({ columns: [table.chatId, table.agentId] })]
)

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
