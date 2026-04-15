import { useState, useCallback, useEffect, useRef } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { MessageStream } from '../chat/MessageStream'
import { ChatInput } from '../chat/ChatInput'
import { SettingsPage } from '../settings/SettingsPage'
import { ChatConfigMenu } from '../chat/ChatConfigMenu'
import { useCreateChat, useUpdateChat } from '../../hooks/useChat'
import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders } from '../../hooks/useMcp'
import { Sparkles } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

function useDefaultProviderId(): string | null {
  const { data: providers } = useProviders()
  if (!providers) return null
  const enabled = providers.filter((p) => p.enabled && p.hasApiKey)
  const def = enabled.find((p) => p.isDefault)
  return def?.id ?? enabled[0]?.id ?? null
}

export function MainArea(): React.JSX.Element {
  const { activeView } = useUIStore()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const createChat = useCreateChat()
  const updateChat = useUpdateChat()
  const defaultProviderId = useDefaultProviderId()
  const { data: providers } = useProviders()
  const { data: allModels } = useModels()
  const queryClient = useQueryClient()
  const { data: mcpProviders } = useMcpProviders()
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [activeMcpIds, setActiveMcpIds] = useState<Set<string>>(new Set())
  const mcpDefaultsApplied = useRef(false)

  // Initialize activeMcpIds with enabled MCP providers on first load
  useEffect(() => {
    if (mcpDefaultsApplied.current || !mcpProviders) return
    const enabledIds = mcpProviders.filter((p) => p.enabled).map((p) => p.id)
    if (enabledIds.length > 0) {
      setActiveMcpIds(new Set(enabledIds))
      mcpDefaultsApplied.current = true
    }
  }, [mcpProviders])

  // Resolve which provider to use: explicit selection > default
  const effectiveProviderId = selectedProviderId ?? defaultProviderId

  const handleToggleMcp = useCallback((mcpId: string) => {
    setActiveMcpIds((prev) => {
      const next = new Set(prev)
      if (next.has(mcpId)) {
        next.delete(mcpId)
      } else {
        next.add(mcpId)
      }
      return next
    })
  }, [])

  const handleNewChat = useCallback(
    async (message: string) => {
      try {
        const chat = await createChat.mutateAsync()

        // Use the provider's configured default model, or fall back to first available
        const providerData = (providers ?? []).find((p) => p.id === effectiveProviderId)
        const providerModels = (allModels ?? []).filter(
          (m) => m.providerId === effectiveProviderId
        )
        const defaultModelId =
          (providerData?.defaultModelId && providerModels.some((m) => m.id === providerData.defaultModelId)
            ? providerData.defaultModelId
            : null) ?? providerModels[0]?.id

        // Set title to first user message (truncated)
        const title = message.length > 50 ? message.slice(0, 50) + '…' : message

        if (effectiveProviderId && defaultModelId) {
          await updateChat.mutateAsync({
            chatId: chat.id,
            updates: { providerId: effectiveProviderId, modelId: defaultModelId, title }
          })
        } else {
          await updateChat.mutateAsync({
            chatId: chat.id,
            updates: { title }
          })
        }

        const mcpSnapshot = Array.from(activeMcpIds)
        if (mcpSnapshot.length > 0) {
          await window.api.chat.setMcpProviders(chat.id, mcpSnapshot)
        }

        // Explicitly navigate to the new chat
        useChatStore.getState().setActiveChatId(chat.id)

        // Send the message using the store actions directly
        window.api.llm.sendMessage(chat.id, message, (event) => {
          switch (event.type) {
            case 'request-id':
              useChatStore.getState().startStreaming(event.requestId!)
              break
            case 'delta':
              useChatStore.getState().appendDelta(event.text!)
              break
            case 'tool_use':
              useChatStore.getState().addToolCall({
                id: event.id!,
                name: event.name!,
                input: event.input!,
                provider: event.provider
              })
              break
            case 'tool_result':
              useChatStore.getState().resolveToolCall(event.id!, event.result)
              break
            case 'tool_error':
              useChatStore.getState().failToolCall(event.id!, event.error!)
              break
            case 'done':
              useChatStore.getState().stopStreaming()
              queryClient.invalidateQueries({ queryKey: ['chat', chat.id] })
              queryClient.invalidateQueries({ queryKey: ['chats'] })
              break
            case 'error':
              console.error('LLM error:', event.error)
              useChatStore.getState().setStreamError(
                event.error ?? 'Unknown error',
                event.errorDetail
              )
              break
          }
        })

        // Invalidate after a short delay so the user message (saved by main process) appears
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['chat', chat.id] })
        }, 300)
      } catch (err) {
        console.error('Failed to create chat:', err)
      }
    },
    [createChat, updateChat, effectiveProviderId, providers, allModels, activeMcpIds, queryClient]
  )

  if (activeView === 'settings') {
    return <SettingsPage />
  }

  // Default / New Chat screen
  if (!activeChatId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="mb-8 text-center">
          <Sparkles size={32} className="mx-auto mb-3 text-[var(--color-accent)] opacity-60" />
          <h1 className="text-lg font-semibold text-[var(--color-text)]">What can I help with?</h1>
        </div>
        <ChatInput
          chatId={null}
          onNewChat={handleNewChat}
          leftSlot={
            <ChatConfigMenu
              selectedProviderId={effectiveProviderId}
              onSelectProvider={setSelectedProviderId}
              activeMcpIds={activeMcpIds}
              onToggleMcp={handleToggleMcp}
            />
          }
        />
      </div>
    )
  }

  // Active chat
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <MessageStream chatId={activeChatId} />
      <div className="py-3 bg-[var(--color-bg)]">
        <ChatInput chatId={activeChatId} />
      </div>
    </div>
  )
}
