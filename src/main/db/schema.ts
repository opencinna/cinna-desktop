import { sqliteTable, text, integer, blob, primaryKey } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  type: text('type').notNull().default('local_user'), // 'local_user' | 'cinna_user'
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash'),
  salt: text('salt'),
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
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
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

export const chatModes = sqliteTable('chat_modes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('__default__'),
  name: text('name').notNull(),
  providerId: text('provider_id'),
  modelId: text('model_id'),
  mcpProviderIds: text('mcp_provider_ids', { mode: 'json' }).$type<string[]>().default([]),
  colorPreset: text('color_preset').notNull().default('slate'),
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
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})

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
  role: text('role').notNull(), // 'user' | 'assistant' | 'tool_call'
  content: text('content').notNull(),
  toolCallId: text('tool_call_id'),
  toolName: text('tool_name'),
  toolInput: text('tool_input', { mode: 'json' }).$type<Record<string, unknown>>(),
  toolCalls: text('tool_calls', { mode: 'json' }).$type<
    Array<{ id: string; name: string; input: Record<string, unknown> }>
  >(),
  toolError: integer('tool_error', { mode: 'boolean' }),
  toolProvider: text('tool_provider'),
  sortOrder: integer('sort_order').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
})
