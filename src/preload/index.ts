import { contextBridge, ipcRenderer } from 'electron'

export interface ChatData {
  id: string
  title: string
  modelId: string | null
  providerId: string | null
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
  sortOrder: number
  createdAt: Date
}

export interface ProviderData {
  id: string
  type: string
  name: string
  enabled: boolean
  isDefault: boolean
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
  createdAt: Date
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
    update: (
      chatId: string,
      updates: { title?: string; modelId?: string; providerId?: string; modeId?: string }
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
      ipcRenderer.invoke('chat:get-mcp-providers', chatId)
  },

  providers: {
    list: (): Promise<ProviderData[]> => ipcRenderer.invoke('provider:list'),
    upsert: (data: {
      id?: string
      type: string
      name: string
      apiKey?: string
      enabled?: boolean
      isDefault?: boolean
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
    }): Promise<{ id: string; success: boolean }> => ipcRenderer.invoke('chatmode:upsert', data),
    delete: (id: string): Promise<{ success: boolean }> => ipcRenderer.invoke('chatmode:delete', id)
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
      ipcRenderer.invoke('mcp:list-tools', providerId)
  },

  llm: {
    sendMessage: (
      chatId: string,
      content: string,
      onEvent: (event: {
        type: string
        text?: string
        id?: string
        name?: string
        input?: Record<string, unknown>
        result?: unknown
        error?: string
        errorDetail?: string
        requestId?: string
        provider?: string
      }) => void
    ): void => {
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => {
        onEvent(event.data)
      }
      ipcRenderer.postMessage('llm:send-message', [chatId, content], [channel.port2])
    },
    cancel: (requestId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('llm:cancel', requestId)
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
