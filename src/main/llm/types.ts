export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerType: string
}

export interface ToolCallInfo {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_call'
  content: string
  toolCalls?: ToolCallInfo[]
  toolCallId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolError?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mcpProviderId: string
}

export interface ToolUseEvent {
  id: string
  name: string
  input: Record<string, unknown>
  mcpProviderId: string
}

export interface StreamResult {
  content: string
  toolCalls: ToolCallInfo[]
}

export interface StreamParams {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  onDelta: (text: string) => void
}

export interface LLMError {
  short: string
  detail: string
}

export interface LLMAdapter {
  readonly providerType: string
  listModels(): Promise<ModelInfo[]>
  stream(params: StreamParams): Promise<StreamResult>
  parseError(error: Error): LLMError
}
