import { registerChatHandlers } from './chat.ipc'
import { registerProviderHandlers } from './provider.ipc'
import { registerMcpHandlers } from './mcp.ipc'
import { registerLlmHandlers } from './llm.ipc'
import { registerChatModeHandlers } from './chatmode.ipc'
import { registerAgentHandlers } from './agent.ipc'
import { registerAuthHandlers } from './auth.ipc'

export function registerAllIpcHandlers(): void {
  registerAuthHandlers()
  registerChatHandlers()
  registerProviderHandlers()
  registerMcpHandlers()
  registerLlmHandlers()
  registerChatModeHandlers()
  registerAgentHandlers()
}
