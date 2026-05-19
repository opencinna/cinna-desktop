import { useCallback } from 'react'
import { useCreateChat, useUpdateChat } from './useChat'
import { useChatStore } from '../stores/chat.store'
import { useChatStream } from './useChatStream'
import type { ChatModeData } from '../constants/chatModeColors'
import type { MessageAttachment } from '../../../shared/attachments'

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
  /**
   * On-demand MCPs the user `@-mentioned` on the new-chat screen before the
   * chat row existed. Flushed onto the freshly-created chat *before* the
   * first send so the stream loop's announce prefix picks them up.
   */
  onDemandMcpIds?: Iterable<string>
  /** File attachments uploaded to the Cinna backend before chat creation. */
  attachments?: MessageAttachment[]
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
      const {
        message,
        agent,
        mode,
        providerId,
        providers,
        allModels,
        mcpIds,
        onDemandMcpIds,
        attachments
      } = opts
      const title = message.length > 50 ? message.slice(0, 50) + '…' : message

      try {
        const chat = await createChat.mutateAsync()

        // Flush the new-chat MCP buffer before either channel kicks off. The
        // LLM stream loop reads `chat_on_demand_mcps` at setup time, so the
        // rows must exist by the moment `startLlm` fires. For agent-bound
        // chats we still persist (MCPs are LLM-only at send time, but the
        // user may switch to the LLM root later via multi-agent routing).
        const onDemandSnapshot = onDemandMcpIds ? Array.from(onDemandMcpIds) : []
        for (const mcpId of onDemandSnapshot) {
          await window.api.chat.addOnDemandMcp(chat.id, mcpId)
        }

        if (agent) {
          await updateChat.mutateAsync({
            chatId: chat.id,
            updates: { title, agentId: agent.id }
          })
          useChatStore.getState().setActiveChatId(chat.id)
          startAgent(agent.id, chat.id, message, { attachments })
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
