import { registerAppHandlers } from './app.ipc'
import { registerChatHandlers } from './chat.ipc'
import { registerProviderHandlers } from './provider.ipc'
import { registerMcpHandlers } from './mcp.ipc'
import { registerLlmHandlers } from './llm.ipc'
import { registerChatModeHandlers } from './chatmode.ipc'
import { registerAgentHandlers } from './agent.ipc'
import { registerAgentStatusHandlers } from './agent_status.ipc'
import { registerAuthHandlers } from './auth.ipc'
import { registerLoggerHandlers } from './logger.ipc'
import { registerUpdaterHandlers } from './updater.ipc'
import { registerMultiAgentHandlers } from './multi_agent.ipc'
import { registerFilesHandlers } from './files.ipc'
import { registerJobHandlers } from './job.ipc'
import { registerNoteHandlers } from './note.ipc'
import { registerCinnaHandlers } from './cinna.ipc'
import { registerSettingsHandlers } from './settings.ipc'

export function registerAllIpcHandlers(): void {
  registerLoggerHandlers()
  registerAppHandlers()
  registerAuthHandlers()
  registerChatHandlers()
  registerProviderHandlers()
  registerMcpHandlers()
  registerLlmHandlers()
  registerChatModeHandlers()
  registerAgentHandlers()
  registerAgentStatusHandlers()
  registerUpdaterHandlers()
  registerMultiAgentHandlers()
  registerFilesHandlers()
  registerJobHandlers()
  registerNoteHandlers()
  registerCinnaHandlers()
  registerSettingsHandlers()
}
