export interface McpProviderConfig {
  id: string
  name: string
  transportType: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled: boolean
  /** How a remote server authenticates. Unused for `stdio`. Defaults to `'oauth'`. */
  authType?: 'oauth' | 'bearer'
  /** Encrypted OAuth tokens (from DB) */
  authTokensEncrypted?: Buffer
  /** DCR client registration info (from DB) */
  clientInfo?: Record<string, unknown>
  /** Encrypted static bearer token (from DB), used when `authType === 'bearer'` */
  bearerTokenEncrypted?: Buffer
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mcpProviderId: string
  /** Always `'mcp'` — kept structurally compatible with `ToolDefinition`. */
  providerType: 'mcp'
}

export interface McpConnection {
  config: McpProviderConfig
  tools: McpTool[]
  status: 'connected' | 'disconnected' | 'error' | 'awaiting-auth'
  error?: string
}
