import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { MessagePart } from '../shared/messageParts'
import type { RemoteAgentMetadata } from '../shared/agentMetadata'
import type { CliCommand } from '../shared/cliCommands'
import type { AgentSendPayload, LlmSendPayload } from '../shared/ipcPayloads'
import { isAgentStreamEvent, type AgentStreamEvent } from '../shared/agentStreamEvents'
import { isLlmStreamEvent, type LlmStreamEvent } from '../shared/llmStreamEvents'
import type { MessageAttachment, PendingAttachment } from '../shared/attachments'
import type {
  JobData,
  JobDetailData,
  JobRunData,
  JobCreateInputDto,
  JobPatchDto,
  JobFolderData,
  JobFolderCreateInputDto,
  JobFolderPatchDto
} from '../shared/jobs'
import type {
  NoteData,
  NoteCreateInputDto,
  NotePatchDto,
  NoteFolderData,
  NoteFolderCreateInputDto,
  NoteFolderPatchDto,
  NoteAttachAsFilesInputDto,
  NoteAttachAsFilesResultDto
} from '../shared/notes'
import type { CinnaTaskViewDto } from '../shared/cinnaTaskView'
import type {
  McpRegistryInfo,
  McpRegistrySearchAllResult
} from '../shared/mcpRegistries'
import {
  UPDATER_BROADCAST_CHANNEL,
  type UpdaterState
} from '../shared/updaterState'
import {
  CHAT_TITLE_UPDATED_CHANNEL,
  type AppSettingsSchema,
  type ChatTitleUpdatedPayload
} from '../shared/appSettings'

export type { MessageAttachment }

export interface ChatData {
  id: string
  title: string
  modelId: string | null
  providerId: string | null
  modeId: string | null
  agentId: string | null
  activeAgentId: string | null
  smartAssistDisabled: boolean
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface MessageData {
  id: string
  chatId: string
  role: string
  content: string
  toolCallId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolError?: boolean
  toolProvider?: string
  parts?: MessagePart[] | null
  /** Multi-agent: agent the user message was routed to (null when sent to LLM root). */
  addressedAgentId?: string | null
  /** Multi-agent: Smart Rewrite output, when rewrite happened. */
  rewrittenText?: string | null
  /** Multi-agent: user's literal pre-rewrite text. */
  originalText?: string | null
  /** Multi-agent: agent that produced an assistant turn (null for LLM root). */
  sourceAgentId?: string | null
  /** File attachments persisted on user turns (badges below the bubble). */
  attachments?: MessageAttachment[] | null
  sortOrder: number
  createdAt: Date
}

export interface ProviderData {
  id: string
  type: string
  name: string
  enabled: boolean
  defaultModelId: string | null
  hasApiKey: boolean
  createdAt: Date
}

export interface ModelData {
  id: string
  name: string
  providerId: string
  providerType: string
}

export interface ChatModeData {
  id: string
  name: string
  providerId: string | null
  modelId: string | null
  mcpProviderIds: string[]
  colorPreset: string
  isDefault: boolean
  createdAt: Date
}

export interface AgentData {
  id: string
  name: string
  description: string | null
  protocol: string
  cardUrl: string | null
  endpointUrl: string | null
  protocolInterfaceUrl: string | null
  protocolInterfaceVersion: string | null
  hasAccessToken: boolean
  cardData: Record<string, unknown> | null
  skills: Array<{ id: string; name: string; description?: string }> | null
  enabled: boolean
  source: string // 'local' | 'remote'
  remoteTargetType: string | null // 'agent' | 'app_mcp_route' | 'identity'
  remoteTargetId: string | null
  remoteMetadata: RemoteAgentMetadata | null
  createdAt: Date
}

export type AgentStatusSeverity = 'ok' | 'warning' | 'error' | 'info' | 'unknown'

export interface AgentStatusSnapshot {
  agentId: string
  remoteAgentId: string
  name: string
  environmentId: string | null
  severity: AgentStatusSeverity | null
  summary: string | null
  reportedAt: string | null
  reportedAtSource: 'frontmatter' | 'file_mtime' | null
  fetchedAt: string | null
  raw: string | null
  body: string | null
  hasStructuredMetadata: boolean
  prevSeverity: string | null
  severityChangedAt: string | null
}

export interface UserData {
  id: string
  type: string // 'local_user' | 'cinna_user'
  username: string
  displayName: string
  hasPassword: boolean
  createdAt: Date
  cinnaFullName?: string
  cinnaHostingType?: 'cloud' | 'self_hosted'
  cinnaServerUrl?: string
  hasCinnaTokens?: boolean
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  timestamp: number
  level: LogLevel
  scope: string
  source: 'main' | 'renderer'
  message: string
  data?: unknown
}

export interface McpProviderData {
  id: string
  name: string
  transportType: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled: boolean
  hasAuth: boolean
  status: string
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  error?: string
}

const api = {
  app: {
    setTheme: (theme: 'dark' | 'light'): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('app:set-theme', theme)
  },

  auth: {
    listUsers: (): Promise<UserData[]> => ipcRenderer.invoke('auth:list-users'),
    getCurrent: (): Promise<UserData | null> => ipcRenderer.invoke('auth:get-current'),
    getStartup: (): Promise<{
      needsLogin: boolean
      user?: UserData
      pendingUser?: UserData
    }> => ipcRenderer.invoke('auth:get-startup'),
    register: (data: {
      username?: string
      displayName?: string
      password?: string
      accountType: 'local' | 'cinna'
      cinnaHostingType?: 'cloud' | 'self_hosted'
      cinnaServerUrl?: string
    }): Promise<{ success: boolean; user?: UserData; error?: string }> =>
      ipcRenderer.invoke('auth:register', data),
    login: (data: {
      userId: string
      password?: string
    }): Promise<{ success: boolean; user?: UserData; error?: string }> =>
      ipcRenderer.invoke('auth:login', data),
    logout: (): Promise<{ success: boolean }> => ipcRenderer.invoke('auth:logout'),
    cinnaOAuthAbort: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('auth:cinna-oauth-abort'),
    updateUser: (data: {
      userId: string
      displayName?: string
      password?: string
      removePassword?: boolean
    }): Promise<{ success: boolean; user?: UserData; error?: string }> =>
      ipcRenderer.invoke('auth:update-user', data),
    deleteUser: (data: {
      userId: string
      password?: string
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('auth:delete-user', data)
  },

  chat: {
    list: (): Promise<ChatData[]> => ipcRenderer.invoke('chat:list'),
    get: (chatId: string): Promise<(ChatData & { messages: MessageData[] }) | null> =>
      ipcRenderer.invoke('chat:get', chatId),
    create: (): Promise<ChatData> => ipcRenderer.invoke('chat:create'),
    delete: (chatId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('chat:delete', chatId),
    trashList: (): Promise<ChatData[]> => ipcRenderer.invoke('chat:trash-list'),
    restore: (chatId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('chat:restore', chatId),
    permanentDelete: (chatId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('chat:permanent-delete', chatId),
    emptyTrash: (): Promise<{ success: boolean }> => ipcRenderer.invoke('chat:empty-trash'),
    showInList: (chatId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('chat:show-in-list', chatId),
    update: (
      chatId: string,
      updates: {
        title?: string
        modelId?: string
        providerId?: string
        modeId?: string | null
        agentId?: string
      }
    ): Promise<{ success: boolean }> => ipcRenderer.invoke('chat:update', chatId, updates),
    addMessage: (
      chatId: string,
      message: {
        role: string
        content: string
        toolCallId?: string
        toolName?: string
        toolInput?: Record<string, unknown>
      }
    ): Promise<MessageData> => ipcRenderer.invoke('chat:add-message', chatId, message),
    setMcpProviders: (
      chatId: string,
      mcpProviderIds: string[]
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('chat:set-mcp-providers', chatId, mcpProviderIds),
    getMcpProviders: (
      chatId: string
    ): Promise<Array<{ chatId: string; mcpProviderId: string }>> =>
      ipcRenderer.invoke('chat:get-mcp-providers', chatId),
    listOnDemandMcps: (
      chatId: string
    ): Promise<Array<{ mcpProviderId: string; pendingAnnounce: boolean }>> =>
      ipcRenderer.invoke('chat:on-demand-mcp-list', chatId),
    addOnDemandMcp: (
      chatId: string,
      mcpProviderId: string
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('chat:on-demand-mcp-add', chatId, mcpProviderId),
    removeOnDemandMcp: (
      chatId: string,
      mcpProviderId: string
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('chat:on-demand-mcp-remove', chatId, mcpProviderId),
    /**
     * Subscribe to background chat-title autogeneration completions. Fires
     * once per chat (when the auto-title feature is enabled and a first
     * user message triggers a successful title rewrite). Returns an
     * unsubscribe function.
     */
    onTitleUpdated: (
      handler: (payload: ChatTitleUpdatedPayload) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: ChatTitleUpdatedPayload
      ): void => handler(payload)
      ipcRenderer.on(CHAT_TITLE_UPDATED_CHANNEL, listener)
      return () => ipcRenderer.off(CHAT_TITLE_UPDATED_CHANNEL, listener)
    }
  },

  providers: {
    list: (): Promise<ProviderData[]> => ipcRenderer.invoke('provider:list'),
    upsert: (data: {
      id?: string
      type: string
      name: string
      apiKey?: string
      enabled?: boolean
      defaultModelId?: string | null
    }): Promise<{ id: string; success: boolean }> => ipcRenderer.invoke('provider:upsert', data),
    delete: (providerId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('provider:delete', providerId),
    test: (
      providerId: string
    ): Promise<{ success: boolean; models?: ModelData[]; error?: string }> =>
      ipcRenderer.invoke('provider:test', providerId),
    testKey: (data: {
      type: string
      apiKey: string
    }): Promise<{ success: boolean; models?: ModelData[]; error?: string }> =>
      ipcRenderer.invoke('provider:test-key', data),
    listModels: (): Promise<ModelData[]> => ipcRenderer.invoke('provider:list-models')
  },

  chatModes: {
    list: (): Promise<ChatModeData[]> => ipcRenderer.invoke('chatmode:list'),
    get: (id: string): Promise<ChatModeData | null> => ipcRenderer.invoke('chatmode:get', id),
    upsert: (data: {
      id?: string
      name: string
      providerId?: string | null
      modelId?: string | null
      mcpProviderIds?: string[]
      colorPreset?: string
      isDefault?: boolean
    }): Promise<{ id: string; success: boolean }> => ipcRenderer.invoke('chatmode:upsert', data),
    delete: (id: string): Promise<{ success: boolean }> => ipcRenderer.invoke('chatmode:delete', id)
  },

  agents: {
    list: (): Promise<AgentData[]> => ipcRenderer.invoke('agent:list'),
    upsert: (data: {
      id?: string
      name: string
      description?: string
      protocol: string
      cardUrl?: string
      endpointUrl?: string
      protocolInterfaceUrl?: string
      protocolInterfaceVersion?: string
      accessToken?: string
      cardData?: Record<string, unknown>
      skills?: Array<{ id: string; name: string; description?: string }>
      enabled?: boolean
    }): Promise<{ id?: string; success: boolean; error?: string }> =>
      ipcRenderer.invoke('agent:upsert', data),
    delete: (agentId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('agent:delete', agentId),
    setEnabled: (
      agentId: string,
      enabled: boolean
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('agent:set-enabled', { agentId, enabled }),
    syncRemote: (): Promise<{
      success: boolean
      synced?: number
      removed?: number
      code?: string
      error?: string
    }> => ipcRenderer.invoke('agent:sync-remote'),
    fetchCard: (data: {
      cardUrl: string
      accessToken?: string
    }): Promise<{
      success: boolean
      card?: Record<string, unknown>
      protocol?: { url: string; version: string }
      error?: string
    }> => ipcRenderer.invoke('agent:fetch-card', data),
    test: (
      agentId: string
    ): Promise<{ success: boolean; card?: Record<string, unknown>; error?: string }> =>
      ipcRenderer.invoke('agent:test', agentId),
    listCliCommands: (
      agentId: string
    ): Promise<{ success: boolean; commands: CliCommand[]; error?: string }> =>
      ipcRenderer.invoke('agent:list-cli-commands', agentId),
    sendMessage: (
      agentId: string,
      chatId: string,
      content: string,
      onEvent: (event: AgentStreamEvent) => void,
      extras?: {
        catchupPacket?: string
        rewrittenText?: string | null
        originalText?: string | null
        attachments?: MessageAttachment[]
      }
    ): void => {
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => {
        // Guard at the IPC trust boundary: drop messages that don't match
        // the contract instead of casting blindly. Logged so a regression
        // surfaces in dev tools rather than as a silent no-op.
        if (!isAgentStreamEvent(event.data)) {
          console.warn('[preload] dropped off-contract agent stream event', event.data)
          return
        }
        onEvent(event.data)
      }
      const payload: AgentSendPayload = {
        agentId,
        chatId,
        content,
        catchupPacket: extras?.catchupPacket,
        rewrittenText: extras?.rewrittenText,
        originalText: extras?.originalText,
        attachments: extras?.attachments
      }
      ipcRenderer.postMessage('agent:send-message', payload, [channel.port2])
    },
    cancelMessage: (requestId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agent:cancel-message', requestId),
    getSession: (
      chatId: string
    ): Promise<{
      id: string
      chatId: string
      agentId: string
      contextId: string | null
      taskId: string | null
      taskState: string | null
    } | null> => ipcRenderer.invoke('agent:get-session', chatId),
    onRemoteSyncComplete: (
      handler: (payload: { error?: 'reauth_required' | 'sync_failed' }) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: { error?: 'reauth_required' | 'sync_failed' }
      ): void => handler(payload ?? {})
      ipcRenderer.on('agents:remote-sync-complete', listener)
      return () => ipcRenderer.off('agents:remote-sync-complete', listener)
    }
  },

  agentStatus: {
    list: (): Promise<{
      success: boolean
      items?: AgentStatusSnapshot[]
      code?: string
      error?: string
    }> => ipcRenderer.invoke('agent-status:list'),
    get: (data: {
      agentId: string
      forceRefresh?: boolean
    }): Promise<{
      success: boolean
      item?: AgentStatusSnapshot | null
      code?: string
      error?: string
    }> => ipcRenderer.invoke('agent-status:get', data)
  },

  mcp: {
    list: (): Promise<McpProviderData[]> => ipcRenderer.invoke('mcp:list'),
    upsert: (data: {
      id?: string
      name: string
      transportType: string
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
      enabled?: boolean
    }): Promise<{ id: string; success: boolean }> => ipcRenderer.invoke('mcp:upsert', data),
    delete: (providerId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('mcp:delete', providerId),
    connect: (
      providerId: string
    ): Promise<{ success: boolean; tools?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('mcp:connect', providerId),
    disconnect: (providerId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('mcp:disconnect', providerId),
    listTools: (providerId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('mcp:list-tools', providerId),
    registryList: (): Promise<McpRegistryInfo[]> =>
      ipcRenderer.invoke('mcp:registry-list'),
    registrySearchAll: (data: {
      query?: string
      limit?: number
    }): Promise<McpRegistrySearchAllResult> =>
      ipcRenderer.invoke('mcp:registry-search-all', data),
    /**
     * Subscribe to MCP connection state transitions. The main process emits
     * one event per transition; the renderer typically reacts by invalidating
     * its `mcp-providers` cache so cards and chips reflect the new status.
     * Returns an unsubscribe function.
     */
    onStatusChanged: (
      handler: (payload: { providerId: string; status: string }) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: { providerId: string; status: string }
      ): void => handler(payload)
      ipcRenderer.on('mcp:status-changed', listener)
      return () => ipcRenderer.off('mcp:status-changed', listener)
    }
  },

  logger: {
    getAll: (): Promise<LogEntry[]> => ipcRenderer.invoke('logger:get-all'),
    clear: (): Promise<{ success: boolean }> => ipcRenderer.invoke('logger:clear'),
    log: (payload: {
      level: LogLevel
      scope: string
      message: string
      data?: unknown
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('logger:log', payload),
    onEntry: (handler: (entry: LogEntry) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, entry: LogEntry): void => handler(entry)
      ipcRenderer.on('logger:entry', listener)
      return () => ipcRenderer.off('logger:entry', listener)
    },
    onToggleOverlay: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('logger:toggle-overlay', listener)
      return () => ipcRenderer.off('logger:toggle-overlay', listener)
    }
  },

  llm: {
    sendMessage: (
      chatId: string,
      content: string,
      onEvent: (event: LlmStreamEvent) => void,
      extras?: { catchupPacket?: string; attachments?: MessageAttachment[] }
    ): void => {
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => {
        if (!isLlmStreamEvent(event.data)) {
          console.warn('[preload] dropped off-contract llm stream event', event.data)
          return
        }
        onEvent(event.data)
      }
      const payload: LlmSendPayload = {
        chatId,
        content,
        catchupPacket: extras?.catchupPacket,
        attachments: extras?.attachments
      }
      ipcRenderer.postMessage('llm:send-message', payload, [channel.port2])
    },
    cancel: (requestId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('llm:cancel', requestId),
    /**
     * Reports what MIME types + size envelope the given (provider, model)
     * accepts. Drives the renderer's attach-button gating and the picker's
     * file-type filter. Empty `acceptedMimeTypes` ⇒ hide the button.
     */
    getModelCapability: (data: {
      providerId: string
      modelId: string
    }): Promise<{
      acceptedMimeTypes: string[]
      maxFileSizeBytes: number
      maxFilesPerMessage: number
    }> => ipcRenderer.invoke('llm:get-model-capability', data)
  },

  files: {
    /**
     * Opens the native file picker and routes the upload based on `scope`:
     *
     *  - `cinna` (default for back-compat) — pushes bytes to the user's
     *    Cinna backend; required for remote-agent (A2A) sends.
     *  - `local` — copies bytes into the per-user local store; required
     *    for raw LLM chats that ship images inline. Needs a `chatId` so
     *    the store can scope and clean up alongside the chat row.
     *
     * Cancellation is a successful `canceled: true` response.
     */
    pickAndUpload: (opts?: {
      scope?: 'cinna' | 'local'
      chatId?: string | null
    }): Promise<
      | { success: true; canceled?: false; files: MessageAttachment[] }
      | { success: true; canceled: true; files: [] }
      | { success: false; canceled?: false; error: string; code?: string }
    > => ipcRenderer.invoke('files:pick-and-upload', opts),
    /**
     * Ingest pre-resolved paths into the same backing store the picker
     * uses. Used by the drag-drop flow — the picker has no role there
     * because the OS already handed us the file. Paths come from
     * {@link getPathForFile} (which wraps Electron's `webUtils`).
     */
    ingestPaths: (data: {
      scope?: 'cinna' | 'local'
      chatId?: string | null
      paths: string[]
    }): Promise<
      | { success: true; files: MessageAttachment[] }
      | { success: false; error: string; code?: string }
    > => ipcRenderer.invoke('files:ingest-paths', data),
    /**
     * Deferred-ingest picker. Opens the file dialog and returns metadata
     * for each picked file as `source: 'pending'` attachments — bytes
     * stay on disk. The new-chat composer uses this so the scope (Cinna
     * vs local) is chosen at send time, after the user picks a
     * destination.
     */
    pickPaths: (): Promise<
      | { success: true; canceled?: false; files: PendingAttachment[] }
      | { success: true; canceled: true; files: [] }
      | { success: false; canceled?: false; error: string; code?: string }
    > => ipcRenderer.invoke('files:pick-paths'),
    /**
     * Resolve drag-dropped paths to badge-ready metadata without
     * ingesting. Same deferred semantics as {@link pickPaths} but for
     * the drop flow.
     */
    resolvePaths: (data: {
      paths: string[]
    }): Promise<
      | { success: true; files: PendingAttachment[] }
      | { success: false; error: string; code?: string }
    > => ipcRenderer.invoke('files:resolve-paths', data),
    /**
     * Resolve the OS path of a dropped File. Renderers can't read paths
     * off File objects directly under the contextIsolated + sandboxed
     * config; this wraps Electron's `webUtils.getPathForFile`.
     *
     * As a side-effect, every resolved path is reported to the main
     * process via `files:track-path` so the path-guard allowlist
     * picks it up before the renderer round-trips it through
     * `resolvePaths` / `ingestPaths`. A path the renderer can't
     * legitimately get a File handle for never goes through this
     * function, and therefore never reaches the allowlist.
     */
    getPathForFile: (file: File): string => {
      const path = webUtils.getPathForFile(file)
      if (path) ipcRenderer.send('files:track-path', path)
      return path
    },
    /**
     * Remove a pending or persisted attachment from its backing store.
     * The legacy single-string signature (Cinna only) is preserved for
     * older callers that don't carry a `source`.
     */
    remove: (
      arg: string | { id: string; source?: 'cinna' | 'local' }
    ): Promise<{ success: true } | { success: false; error: string; code?: string }> =>
      ipcRenderer.invoke('files:remove', arg),
    /**
     * Save-as for a previously-attached file. Streams from whichever store
     * owns the attachment (Cinna backend for `source: 'cinna'`, local
     * disk-to-disk for `source: 'local'`), then reveals the file in
     * Finder/Explorer.
     */
    download: (data: {
      fileId: string
      filename: string
      source?: 'cinna' | 'local'
    }): Promise<
      | { success: true; canceled?: false; savedPath: string }
      | { success: true; canceled: true }
      | { success: false; canceled?: false; error: string; code?: string }
    > => ipcRenderer.invoke('files:download', data),
    /**
     * Save-as for a TaskAttachment (cinna task-scoped). Distinct from
     * `download` above because these are not FileUpload rows — their
     * download URL is task-scoped.
     */
    downloadTaskAttachment: (data: {
      taskId: string
      attachmentId: string
      filename: string
    }): Promise<
      | { success: true; canceled?: false; savedPath: string }
      | { success: true; canceled: true }
      | { success: false; canceled?: false; error: string; code?: string }
    > => ipcRenderer.invoke('files:download-task-attachment', data)
  },

  multiAgent: {
    rewrite: (data: {
      chatId: string
      targetAgentId: string
      userText: string
    }): Promise<{ rewrittenText: string | null }> =>
      ipcRenderer.invoke('multiAgent:rewrite', data),
    setActiveAgent: (data: {
      chatId: string
      agentId: string | null
    }): Promise<{ changed: boolean }> =>
      ipcRenderer.invoke('multiAgent:set-active-agent', data),
    disableSmartAssist: (data: { chatId: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('multiAgent:disable-smart-assist', data),
    buildCatchup: (data: {
      chatId: string
      targetAgentId: string
    }): Promise<{ packet: string }> =>
      ipcRenderer.invoke('multiAgent:build-catchup', data)
  },

  jobs: {
    list: (): Promise<JobData[]> => ipcRenderer.invoke('job:list'),
    get: (jobId: string): Promise<JobDetailData> => ipcRenderer.invoke('job:get', jobId),
    create: (input: JobCreateInputDto): Promise<JobData> =>
      ipcRenderer.invoke('job:create', input),
    update: (jobId: string, patch: JobPatchDto): Promise<JobData> =>
      ipcRenderer.invoke('job:update', jobId, patch),
    delete: (jobId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('job:delete', jobId),
    setMcpProviders: (
      jobId: string,
      mcpProviderIds: string[]
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('job:set-mcp-providers', jobId, mcpProviderIds),
    listRuns: (jobId: string): Promise<JobRunData[]> =>
      ipcRenderer.invoke('job:list-runs', jobId),
    execute: (
      jobId: string
    ): Promise<
      | {
          type: 'local'
          chatId: string
          runId: string
          prompt: string
          agentId: string | null
          modeId: string | null
        }
      | {
          type: 'cinna_task'
          runId: string
          cinnaTaskId: string
          cinnaShortCode: string | null
        }
    > => ipcRenderer.invoke('job:execute', jobId),
    cancelRun: (runId: string): Promise<JobRunData> =>
      ipcRenderer.invoke('job:cancel-run', runId),
    deleteRun: (
      runId: string
    ): Promise<{ success: true; chatId: string | null; chatDeleted: boolean }> =>
      ipcRenderer.invoke('job:delete-run', runId),
    refreshRun: (
      runId: string,
      options?: { force?: boolean }
    ): Promise<JobRunData> => ipcRenderer.invoke('job:refresh-run', runId, options),
    cinnaServerUrl: (): Promise<string> => ipcRenderer.invoke('job:cinna-server-url'),
    reorder: (
      targetFolderId: string | null,
      orderedJobIds: string[]
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('job:reorder', targetFolderId, orderedJobIds)
  },

  jobFolders: {
    list: (): Promise<JobFolderData[]> => ipcRenderer.invoke('jobFolder:list'),
    create: (input: JobFolderCreateInputDto): Promise<JobFolderData> =>
      ipcRenderer.invoke('jobFolder:create', input),
    update: (
      folderId: string,
      patch: JobFolderPatchDto
    ): Promise<JobFolderData> =>
      ipcRenderer.invoke('jobFolder:update', folderId, patch),
    delete: (folderId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('jobFolder:delete', folderId),
    reorder: (orderedIds: string[]): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('jobFolder:reorder', orderedIds)
  },

  notes: {
    list: (): Promise<NoteData[]> => ipcRenderer.invoke('note:list'),
    get: (noteId: string): Promise<NoteData> => ipcRenderer.invoke('note:get', noteId),
    create: (input?: NoteCreateInputDto): Promise<NoteData> =>
      ipcRenderer.invoke('note:create', input ?? {}),
    update: (noteId: string, patch: NotePatchDto): Promise<NoteData> =>
      ipcRenderer.invoke('note:update', noteId, patch),
    delete: (noteId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('note:delete', noteId),
    trashList: (): Promise<NoteData[]> => ipcRenderer.invoke('note:trash-list'),
    restore: (noteId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('note:restore', noteId),
    permanentDelete: (noteId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('note:permanent-delete', noteId),
    emptyTrash: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('note:empty-trash'),
    reorder: (
      targetFolderId: string | null,
      orderedNoteIds: string[]
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('note:reorder', targetFolderId, orderedNoteIds),
    /**
     * Materialize selected notes as real {@link MessageAttachment}s by
     * writing each note's body to a synthetic `.md` file routed through
     * the file ingest pipeline. Used by the composer when the user
     * attaches notes via the `?` mention popup.
     */
    attachAsFiles: (
      data: NoteAttachAsFilesInputDto
    ): Promise<NoteAttachAsFilesResultDto> =>
      ipcRenderer.invoke('note:attach-as-files', data)
  },

  noteFolders: {
    list: (): Promise<NoteFolderData[]> => ipcRenderer.invoke('noteFolder:list'),
    create: (input: NoteFolderCreateInputDto): Promise<NoteFolderData> =>
      ipcRenderer.invoke('noteFolder:create', input),
    update: (folderId: string, patch: NoteFolderPatchDto): Promise<NoteFolderData> =>
      ipcRenderer.invoke('noteFolder:update', folderId, patch),
    delete: (folderId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('noteFolder:delete', folderId),
    reorder: (orderedIds: string[]): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('noteFolder:reorder', orderedIds)
  },

  cinna: {
    listAgents: (): Promise<
      Array<{ id: string; name: string; description: string | null }>
    > => ipcRenderer.invoke('cinna:list-agents'),
    getTaskView: (taskId: string): Promise<CinnaTaskViewDto> =>
      ipcRenderer.invoke('cinna:get-task-view', taskId)
  },

  system: {
    openExternal: (
      url: string
    ): Promise<{ success: true } | { success: false; error: string }> =>
      ipcRenderer.invoke('app:open-external', url)
  },

  updater: {
    getState: (): Promise<UpdaterState> => ipcRenderer.invoke('updater:get-state'),
    promptInstall: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('updater:prompt-install'),
    onState: (handler: (state: UpdaterState) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, state: UpdaterState): void => handler(state)
      ipcRenderer.on(UPDATER_BROADCAST_CHANNEL, listener)
      return () => ipcRenderer.off(UPDATER_BROADCAST_CHANNEL, listener)
    }
  },

  settings: {
    getAll: (): Promise<AppSettingsSchema> => ipcRenderer.invoke('settings:get-all'),
    set: <K extends keyof AppSettingsSchema>(
      key: K,
      value: AppSettingsSchema[K]
    ): Promise<{ success: true }> => ipcRenderer.invoke('settings:set', key, value)
  }
}

export type API = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.api = api
}
