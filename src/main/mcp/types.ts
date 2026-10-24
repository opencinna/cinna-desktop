export interface McpProviderConfig {
  id: string
  userId: string
  configRevision: number
  name: string
  transportType: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled: boolean
  /**
   * How a remote server authenticates. Unused for `stdio`. Required — an
   * omitted value used to fall through to the OAuth/DCR branch in `manager.ts`.
   * Build configs with `mcpRowToConfig` rather than by hand.
   */
  authType: 'oauth' | 'bearer'
  /** Encrypted OAuth tokens (from DB) */
  authTokensEncrypted?: Buffer
  /** DCR client registration info (from DB) */
  clientInfo?: Record<string, unknown>
  oauthDiscoveryState?: import('@modelcontextprotocol/client').OAuthDiscoveryState
  /** Encrypted static bearer token (from DB), used when `authType === 'bearer'` */
  bearerTokenEncrypted?: Buffer
  /** Extra request headers of a remote server, resolved (a plugin's declared `headers`, `mcp/managed.ts`). */
  headers?: Record<string, string>
  /** Set when the provider must not be launched now; the connect ends as `error` with this sentence. */
  blockedReason?: string
  /** A plugin server's writable working copy, checked and made in the connect once the old process has stopped (`workCopy.ts`). */
  workCopy?: import('./workCopy').WorkCopySpec
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
