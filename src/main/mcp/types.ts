export interface McpProviderConfig {
  id: string
  name: string
  transportType: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled: boolean
  /** Encrypted OAuth tokens (from DB) */
  authTokensEncrypted?: Buffer
  /** DCR client registration info (from DB) */
  clientInfo?: Record<string, unknown>
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mcpProviderId: string
}

export interface McpConnection {
  config: McpProviderConfig
  tools: McpTool[]
  status: 'connected' | 'disconnected' | 'error' | 'awaiting-auth'
  error?: string
}
