import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { useAgents } from '../../hooks/useAgents'
import { MessageStream } from '../chat/MessageStream'
import { ChatInput, type ChatInputHandle } from '../chat/ChatInput'
import { SettingsPage } from '../settings/SettingsPage'
import { ChatConfigMenu } from '../chat/ChatConfigMenu'
import { AgentSelector } from '../chat/AgentSelector'
import { ExamplePromptTags } from '../chat/ExamplePromptTags'
import { extractExamplePrompts } from '../../utils/examplePrompts'
import { useUpdateChat, useChatDetail } from '../../hooks/useChat'
import { useChatModes } from '../../hooks/useChatModes'
import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders, useSetChatMcpProviders } from '../../hooks/useMcp'
import { useDefaultProviderId } from '../../hooks/useDefaultProvider'
import { useNewChatFlow, resolveModel } from '../../hooks/useNewChatFlow'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'
import { Sparkles } from 'lucide-react'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

export function MainArea(): React.JSX.Element {
  const { activeView, pendingAgentId, setPendingAgentId } = useUIStore()
  const agentStatusOpen = useUIStore((s) => s.agentStatusOpen)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const { data: agentList } = useAgents()
  const updateChat = useUpdateChat()
  const defaultProviderId = useDefaultProviderId()
  const { data: providers } = useProviders()
  const { data: allModels } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const setChatMcp = useSetChatMcpProviders()
  const { startNewChat } = useNewChatFlow()
  const [activeMode, setActiveMode] = useState<ChatModeData | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<AgentData | null>(null)
  const examplePrompts = useMemo(() => extractExamplePrompts(selectedAgent), [selectedAgent])
  const chatInputRef = useRef<ChatInputHandle>(null)
  const inputWrapperRef = useRef<HTMLDivElement>(null)
  const [inputHeight, setInputHeight] = useState(0)

  // Track input wrapper height for overlay padding
  // Re-attach when activeView changes because the input wrapper unmounts in settings
  useEffect(() => {
    const el = inputWrapperRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setInputHeight(entry.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [activeChatId, activeView])
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

  // Pending-agent selection from AgentStatusOverlay: land on new-chat screen,
  // preselect the agent, and focus the input. One-shot; cleared after handling.
  useEffect(() => {
    if (!pendingAgentId || !agentList) return
    const agent = agentList.find((a) => a.id === pendingAgentId)
    if (!agent) {
      setPendingAgentId(null)
      return
    }
    setActiveChatId(null)
    setSelectedAgent(agent)
    setPendingAgentId(null)
    // Focus after the new-chat screen mounts the input.
    requestAnimationFrame(() => chatInputRef.current?.focus())
  }, [pendingAgentId, agentList, setActiveChatId, setPendingAgentId])

  // When the agent-status overlay closes and we're on the chat view (new-chat
  // form or active chat), return focus to the chat input so the user can keep
  // typing without another click.
  const prevStatusOpen = useRef(agentStatusOpen)
  useEffect(() => {
    if (prevStatusOpen.current && !agentStatusOpen && activeView === 'chat') {
      requestAnimationFrame(() => chatInputRef.current?.focus())
    }
    prevStatusOpen.current = agentStatusOpen
  }, [agentStatusOpen, activeView])

  const handleNewChat = useCallback(
    async (message: string) => {
      await startNewChat({
        message,
        agent: selectedAgent,
        mode: activeMode,
        providerId: effectiveProviderId,
        providers,
        allModels,
        mcpIds: effectiveMcpIds
      })
      setSelectedAgent(null)
      setActiveMode(null)
    },
    [startNewChat, selectedAgent, activeMode, effectiveProviderId, providers, allModels, effectiveMcpIds]
  )

  // Active chat: resolve current mode from chatData.modeId
  const { data: activeChatData } = useChatDetail(activeChatId)
  const { data: chatModes } = useChatModes()

  const activeChatMode = activeChatData?.modeId
    ? (chatModes ?? []).find((m) => m.id === activeChatData.modeId) ?? null
    : null

  const handleActiveChatModeChange = useCallback(
    async (mode: ChatModeData | null) => {
      if (!activeChatId) return

      if (!mode) {
        await updateChat.mutateAsync({ chatId: activeChatId, updates: { modeId: null } })
        return
      }

      const resolvedProviderId = mode.providerId ?? defaultProviderId
      const resolvedModelId = resolveModel(mode, resolvedProviderId, providers, allModels)

      const updates: { modeId: string; providerId?: string; modelId?: string } = { modeId: mode.id }
      if (resolvedProviderId && resolvedModelId) {
        updates.providerId = resolvedProviderId
        updates.modelId = resolvedModelId
      }
      await updateChat.mutateAsync({ chatId: activeChatId, updates })

      const mcpIds = mode.mcpProviderIds?.length
        ? mode.mcpProviderIds
        : Array.from(defaultMcpIds)
      setChatMcp.mutate({ chatId: activeChatId, mcpProviderIds: mcpIds })
    },
    [activeChatId, updateChat, defaultProviderId, providers, allModels, defaultMcpIds, setChatMcp]
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
        <ExamplePromptTags
          prompts={examplePrompts}
          animationKey={selectedAgent?.id ?? 'none'}
          onSelect={(p) => handleNewChat(p.full)}
        />
        <ChatInput
          ref={chatInputRef}
          chatId={null}
          onNewChat={handleNewChat}
          modeColor={modeColorPreset}
          onSelectAgent={setSelectedAgent}
          selectedAgent={selectedAgent}
          onDoubleEscape={() => setSelectedAgent(null)}
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
  const activeChatModeColor = activeChatMode ? getPreset(activeChatMode.colorPreset) : null

  return (
    <div className="flex-1 flex flex-col min-w-0 relative overflow-hidden">
      <MessageStream chatId={activeChatId} bottomPadding={inputHeight} />
      <div
        ref={inputWrapperRef}
        className="absolute bottom-0 left-0 right-0 pt-6 pb-3 pointer-events-none"
        style={{
          WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 24px)',
          maskImage: 'linear-gradient(to bottom, transparent, black 24px)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)'
        }}
      >
        <div className="pointer-events-auto">
          <ChatInput
            ref={chatInputRef}
            chatId={activeChatId}
            modeColor={activeChatModeColor}
            leftSlot={
              activeChatMode ? (
                <ChatConfigMenu
                  activeMode={activeChatMode}
                  onSelectMode={handleActiveChatModeChange}
                />
              ) : undefined
            }
          />
        </div>
      </div>
    </div>
  )
}
