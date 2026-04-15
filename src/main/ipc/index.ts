import { registerChatHandlers } from './chat.ipc'
import { registerProviderHandlers } from './provider.ipc'
import { registerMcpHandlers } from './mcp.ipc'
import { registerLlmHandlers } from './llm.ipc'

export function registerAllIpcHandlers(): void {
  registerChatHandlers()
  registerProviderHandlers()
  registerMcpHandlers()
  registerLlmHandlers()
}
