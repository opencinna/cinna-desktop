import { registerServiceCredentialHandlers } from './service_credentials.ipc'
import { registerAppHandlers } from './app.ipc'
import { registerChatHandlers } from './chat.ipc'
import { registerProviderHandlers } from './provider.ipc'
import { registerMcpHandlers } from './mcp.ipc'
import { registerLlmHandlers } from './llm.ipc'
import { registerRunHandlers } from './run.ipc'
import { registerSessionActivityHandlers } from './session_activity.ipc'
import { registerSessionTelemetryHandlers } from './session_telemetry.ipc'
import { registerChatModeHandlers } from './chatmode.ipc'
import { registerAgentHandlers } from './agent.ipc'
import { registerAgentStatusHandlers } from './agent_status.ipc'
import { registerAuthHandlers } from './auth.ipc'
import { registerLoggerHandlers } from './logger.ipc'
import { registerUpdaterHandlers } from './updater.ipc'
import { registerFilesHandlers } from './files.ipc'
import { registerJobHandlers } from './job.ipc'
import { registerNoteHandlers } from './note.ipc'
import { registerTaskHandlers } from './task.ipc'
import { registerTaskDispatchHandlers } from './taskDispatch.ipc'
import { registerAgentSessionHandlers } from './agent_sessions.ipc'
import { registerLocalScheduleHandlers } from './localSchedule.ipc'
import { registerCinnaHandlers } from './cinna.ipc'
import { registerCatalogHandlers } from './catalog.ipc'
import { registerSettingsHandlers } from './settings.ipc'
import { registerTrayHandlers } from './tray.ipc'
import { registerNotificationHandlers } from './notifications.ipc'
import { registerSpeechHandlers } from './speech.ipc'
import { registerSyncHandlers } from './sync.ipc'
import { registerLocalToolsHandlers } from './local_tools.ipc'
import { registerLocalAgentHandlers } from './local_agent.ipc'
import { registerAgentFileHandlers } from './agent_files.ipc'
import { registerArtifactHandlers } from './artifacts.ipc'
import { registerHtmlPreviewHandlers } from './html_preview.ipc'
import { registerEngineHandlers } from './engine.ipc'
import { registerConnectHandlers } from './connect.ipc'
import { registerLocalDevHandlers } from './localdev.ipc'
import { registerSharingHandlers } from './sharing.ipc'
import { registerCatalogSkillHandlers } from './catalogSkills.ipc'
import { registerMarketplaceSkillHandlers } from './marketplaceSkills.ipc'
import { registerSkillPublishHandlers } from './skillPublish.ipc'

export function registerAllIpcHandlers(): void {
  registerLoggerHandlers()
  registerAppHandlers()
  registerAuthHandlers()
  registerChatHandlers()
  registerProviderHandlers()
  registerMcpHandlers()
  registerLlmHandlers()
  // The one send channel, plus the two it replaced (kept as forwards for one phase).
  registerRunHandlers()
  // What a chat's agent session runs beside its turns: subagents, background work.
  registerSessionActivityHandlers()
  registerSessionTelemetryHandlers()
  registerChatModeHandlers()
  registerAgentHandlers()
  registerAgentStatusHandlers()
  registerUpdaterHandlers()
  registerFilesHandlers()
  registerJobHandlers()
  registerNoteHandlers()
  // Tasks, and the inbox that is a view over them.
  registerTaskHandlers()
  // An agent's task queue: run mode, pause, Run next.
  registerTaskDispatchHandlers()
  // Which agents already run a session, for the warning before starting one more.
  registerAgentSessionHandlers()
  registerLocalScheduleHandlers()
  registerCinnaHandlers()
  registerCatalogHandlers()
  registerSettingsHandlers()
  registerTrayHandlers()
  registerNotificationHandlers()
  // Voice input in the composer: speech-to-text on this machine.
  registerSpeechHandlers()
  registerSyncHandlers()
  registerLocalToolsHandlers()
  registerLocalAgentHandlers()
  // Team sharing of folder agents: Get, Update, Share changes, the team library.
  registerSharingHandlers()
  // Catalog skills pinned in folder agents: add, update, remove, fetch.
  registerCatalogSkillHandlers()
  // Marketplace skills pinned in folder agents: discover, add, update, remove, fetch, status.
  registerMarketplaceSkillHandlers()
  registerSkillPublishHandlers()
  registerServiceCredentialHandlers()
  registerAgentFileHandlers()
  // Artifacts: publish a file or folder from an agent's folder to cinna-core, and share it.
  registerArtifactHandlers()
  registerHtmlPreviewHandlers()
  registerEngineHandlers()
  registerConnectHandlers()
  registerLocalDevHandlers()
}
