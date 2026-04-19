import { registerChatHandlers } from './chat.ipc'
import { registerProviderHandlers } from './provider.ipc'
import { registerMcpHandlers } from './mcp.ipc'
import { registerLlmHandlers } from './llm.ipc'
import { registerChatModeHandlers } from './chatmode.ipc'
import { registerAgentHandlers } from './agent.ipc'
import { registerAgentStatusHandlers } from './agent_status.ipc'
import { registerAuthHandlers } from './auth.ipc'
import { registerLoggerHandlers } from './logger.ipc'

export function registerAllIpcHandlers(): void {
  registerLoggerHandlers()
  registerAuthHandlers()
  registerChatHandlers()
  registerProviderHandlers()
  registerMcpHandlers()
  registerLlmHandlers()
  registerChatModeHandlers()
  registerAgentHandlers()
  registerAgentStatusHandlers()
}
