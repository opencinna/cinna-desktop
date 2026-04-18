import { useCallback } from 'react'
import { useCreateChat, useUpdateChat } from './useChat'
import { useChatStore } from '../stores/chat.store'
import { useChatStream } from './useChatStream'
import type { ChatModeData } from '../constants/chatModeColors'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]
type ProviderData = Awaited<ReturnType<typeof window.api.providers.list>>[number]
type ModelData = Awaited<ReturnType<typeof window.api.providers.listModels>>[number]

export interface NewChatOptions {
  message: string
  agent: AgentData | null
  mode: ChatModeData | null
  providerId: string | null
  providers: ProviderData[] | undefined
  allModels: ModelData[] | undefined
  mcpIds: Iterable<string>
}

export function resolveModel(
  mode: ChatModeData | null,
  providerId: string | null,
  providers: ProviderData[] | undefined,
  allModels: ModelData[] | undefined
): string | null {
  if (!providerId) return null
  const providerData = (providers ?? []).find((p) => p.id === providerId)
  const providerModels = (allModels ?? []).filter((m) => m.providerId === providerId)

  const modeModelValid =
    mode?.modelId && providerModels.some((m) => m.id === mode.modelId) ? mode.modelId : null
  if (modeModelValid) return modeModelValid

  const defaultValid =
    providerData?.defaultModelId && providerModels.some((m) => m.id === providerData.defaultModelId)
      ? providerData.defaultModelId
      : null
  return defaultValid ?? providerModels[0]?.id ?? null
}

export function useNewChatFlow(): {
  startNewChat: (opts: NewChatOptions) => Promise<void>
} {
  const createChat = useCreateChat()
  const updateChat = useUpdateChat()
  const { startLlm, startAgent } = useChatStream()

  const startNewChat = useCallback(
    async (opts: NewChatOptions): Promise<void> => {
      const { message, agent, mode, providerId, providers, allModels, mcpIds } = opts
      const title = message.length > 50 ? message.slice(0, 50) + '…' : message

      try {
        const chat = await createChat.mutateAsync()

        if (agent) {
          await updateChat.mutateAsync({
            chatId: chat.id,
            updates: { title, agentId: agent.id }
          })
          useChatStore.getState().setActiveChatId(chat.id)
          startAgent(agent.id, chat.id, message)
          return
        }

        const resolvedModelId = resolveModel(mode, providerId, providers, allModels)
        const updates: {
          title: string
          providerId?: string
          modelId?: string
          modeId?: string
        } = { title }
        if (providerId && resolvedModelId) {
          updates.providerId = providerId
          updates.modelId = resolvedModelId
        }
        if (mode) updates.modeId = mode.id

        await updateChat.mutateAsync({ chatId: chat.id, updates })

        const mcpSnapshot = Array.from(mcpIds)
        if (mcpSnapshot.length > 0) {
          await window.api.chat.setMcpProviders(chat.id, mcpSnapshot)
        }

        useChatStore.getState().setActiveChatId(chat.id)
        startLlm(chat.id, message)
      } catch (err) {
        console.error('Failed to create chat:', err)
      }
    },
    [createChat, updateChat, startAgent, startLlm]
  )

  return { startNewChat }
}
