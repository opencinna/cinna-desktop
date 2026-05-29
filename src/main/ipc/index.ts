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
import { registerFilesHandlers } from './files.ipc'
import { registerJobHandlers } from './job.ipc'
import { registerNoteHandlers } from './note.ipc'
import { registerCinnaHandlers } from './cinna.ipc'
import { registerCatalogHandlers } from './catalog.ipc'
import { registerSettingsHandlers } from './settings.ipc'
import { registerTrayHandlers } from './tray.ipc'

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
  registerFilesHandlers()
  registerJobHandlers()
  registerNoteHandlers()
  registerCinnaHandlers()
  registerCatalogHandlers()
  registerSettingsHandlers()
  registerTrayHandlers()
}
