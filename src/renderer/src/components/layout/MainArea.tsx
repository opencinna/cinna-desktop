import { useState, useCallback, useEffect, useRef } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { MessageStream } from '../chat/MessageStream'
import { ChatInput, type ChatInputHandle } from '../chat/ChatInput'
import { SettingsPage } from '../settings/SettingsPage'
import { ChatConfigMenu } from '../chat/ChatConfigMenu'
import { AgentSelector } from '../chat/AgentSelector'
import { useCreateChat, useUpdateChat } from '../../hooks/useChat'
import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders } from '../../hooks/useMcp'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]
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
  const [activeMode, setActiveMode] = useState<ChatModeData | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<AgentData | null>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)
  const mcpDefaultsApplied = useRef(false)
  const [defaultMcpIds, setDefaultMcpIds] = useState<Set<string>>(new Set())

  // Initialize default MCP ids with enabled MCP providers on first load
  useEffect(() => {
    if (mcpDefaultsApplied.current || !mcpProviders) return
    const enabledIds = mcpProviders.filter((p) => p.enabled).map((p) => p.id)
    if (enabledIds.length > 0) {
      setDefaultMcpIds(new Set(enabledIds))
      mcpDefaultsApplied.current = true
    }
  }, [mcpProviders])

  // Resolve effective provider: mode > default
  const effectiveProviderId = activeMode?.providerId ?? defaultProviderId
  // Resolve effective MCPs: mode > defaults
  const effectiveMcpIds = activeMode?.mcpProviderIds?.length
    ? new Set(activeMode.mcpProviderIds)
    : defaultMcpIds

  const handleSelectMode = useCallback((mode: ChatModeData | null) => {
    setActiveMode(mode)
  }, [])

  const focusChatInput = useCallback(() => {
    chatInputRef.current?.focus()
  }, [])

  const handleNewChat = useCallback(
    async (message: string) => {
      try {
        const chat = await createChat.mutateAsync()

        // Set title to first user message (truncated)
        const title = message.length > 50 ? message.slice(0, 50) + '…' : message

        // If an agent is selected, use agent messaging
        if (selectedAgent) {
          await updateChat.mutateAsync({ chatId: chat.id, updates: { title, agentId: selectedAgent.id } })
          useChatStore.getState().setActiveChatId(chat.id)

          window.api.agents.sendMessage(selectedAgent.id, chat.id, message, (event) => {
            switch (event.type) {
              case 'request-id':
                useChatStore.getState().startStreaming(event.requestId ?? '')
                break
              case 'delta':
                useChatStore.getState().appendDelta(event.text!)
                break
              case 'done':
                useChatStore.getState().stopStreaming()
                queryClient.invalidateQueries({ queryKey: ['chat', chat.id] })
                queryClient.invalidateQueries({ queryKey: ['chats'] })
                break
              case 'error':
                console.error('Agent error:', event.error)
                useChatStore.getState().stopStreaming()
                queryClient.invalidateQueries({ queryKey: ['chat', chat.id] })
                break
            }
          })

          setSelectedAgent(null)
          setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['chat', chat.id] })
          }, 300)
          return
        }

        // Resolve model: mode > provider default > first available
        const resolvedProviderId = effectiveProviderId
        const providerData = (providers ?? []).find((p) => p.id === resolvedProviderId)
        const providerModels = (allModels ?? []).filter(
          (m) => m.providerId === resolvedProviderId
        )

        let resolvedModelId = activeMode?.modelId ?? null
        if (!resolvedModelId || !providerModels.some((m) => m.id === resolvedModelId)) {
          resolvedModelId =
            (providerData?.defaultModelId && providerModels.some((m) => m.id === providerData.defaultModelId)
              ? providerData.defaultModelId
              : null) ?? providerModels[0]?.id ?? null
        }

        const updates: { providerId?: string; modelId?: string; title: string; modeId?: string } = { title }
        if (resolvedProviderId && resolvedModelId) {
          updates.providerId = resolvedProviderId
          updates.modelId = resolvedModelId
        }
        if (activeMode) {
          updates.modeId = activeMode.id
        }

        await updateChat.mutateAsync({ chatId: chat.id, updates })

        const mcpSnapshot = Array.from(effectiveMcpIds)
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
              useChatStore.getState().stopStreaming()
              queryClient.invalidateQueries({ queryKey: ['chat', chat.id] })
              break
          }
        })

        // Reset mode after starting chat
        setActiveMode(null)

        // Invalidate after a short delay so the user message (saved by main process) appears
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['chat', chat.id] })
        }, 300)
      } catch (err) {
        console.error('Failed to create chat:', err)
      }
    },
    [createChat, updateChat, effectiveProviderId, providers, allModels, effectiveMcpIds, activeMode, selectedAgent, queryClient]
  )

  if (activeView === 'settings') {
    return <SettingsPage />
  }

  const modeColorPreset = activeMode ? getPreset(activeMode.colorPreset) : null

  // Default / New Chat screen
  if (!activeChatId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="mb-8 text-center">
          <Sparkles size={32} className="mx-auto mb-3 text-[var(--color-accent)] opacity-60" />
          <h1 className="text-lg font-semibold text-[var(--color-text)]">What can I help with?</h1>
        </div>
        <ChatInput
          ref={chatInputRef}
          chatId={null}
          onNewChat={handleNewChat}
          modeColor={modeColorPreset}
          onSelectAgent={setSelectedAgent}
          leftSlot={
            <>
              <ChatConfigMenu
                activeMode={activeMode}
                onSelectMode={handleSelectMode}
              />
              <AgentSelector
                selectedAgent={selectedAgent}
                onSelectAgent={setSelectedAgent}
                onCollapsed={focusChatInput}
              />
            </>
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
