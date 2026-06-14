import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { useAgents } from '../../hooks/useAgents'
import { MessageStream } from '../chat/MessageStream'
import { ChatInput, type ChatInputHandle } from '../chat/ChatInput'
import { SettingsPage } from '../settings/SettingsPage'
import { JobDetail } from '../jobs/JobDetail'
import { JobEditPage } from '../jobs/JobEditPage'
import { CinnaTaskRunView } from '../jobs/CinnaTaskRunView'
import { NoteDetail } from '../notes/NoteDetail'
import { ExamplePromptTags } from '../chat/ExamplePromptTags'
import { extractExamplePrompts } from '../../utils/examplePrompts'
import { resolveMcpNames } from '../../utils/mcpNames'
import { useUpdateChat, useChatDetail } from '../../hooks/useChat'
import { useChatModes, useDefaultChatMode } from '../../hooks/useChatModes'
import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders, useSetChatMcpProviders } from '../../hooks/useMcp'
import { useNewChatFlow, resolveModel } from '../../hooks/useNewChatFlow'
import { derivePattern } from '../../../../shared/commPattern'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'
import { Sparkles } from 'lucide-react'
import type { ComposerAttachment } from '../../../../shared/attachments'

export function MainArea(): React.JSX.Element {
  const { activeView, pendingAgentId, setPendingAgentId } = useUIStore()
  const agentStatusOpen = useUIStore((s) => s.agentStatusOpen)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const sendError = useChatStore((s) => s.sendError)
  const setSendError = useChatStore((s) => s.setSendError)
  const { data: agentList } = useAgents()
  const updateChat = useUpdateChat()
  const { data: providers } = useProviders()
  const { data: allModels } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const { data: defaultMode } = useDefaultChatMode()
  const { data: chatModes } = useChatModes()
  const setChatMcp = useSetChatMcpProviders()
  const { startNewChat } = useNewChatFlow()
  // New-chat mode selection, modelled as intent rather than a snapshot:
  //   'auto'      → follow the current default mode REACTIVELY (so changing the
  //                 default chat mode, editing it, or flipping the account/local
  //                 precedence in Settings updates the composer immediately),
  //   'none'      → the user explicitly cleared the mode,
  //   { id }      → the user picked a specific mode (re-derived from the live
  //                 list so edits to that mode propagate too).
  const [modeSelection, setModeSelection] = useState<'auto' | 'none' | { id: string }>('auto')
  const activeMode = useMemo<ChatModeData | null>(() => {
    if (modeSelection === 'none') return null
    if (modeSelection === 'auto') return defaultMode ?? null
    return (chatModes ?? []).find((m) => m.id === modeSelection.id) ?? null
  }, [modeSelection, defaultMode, chatModes])
  // On-demand MCP buffer for the new-chat screen — the chat row doesn't
  // exist yet, so picks are held here until `useNewChatFlow.startNewChat`
  // flushes them onto the created chat.
  const [pendingMcpIds, setPendingMcpIds] = useState<string[]>([])
  // The new-chat agent set — a single ordered list. Both the `[+]` capability
  // picker and the `@` popup toggle into it; the "primary" agent (first picked)
  // is derived below for example-prompt sourcing and the comm badge.
  const [pendingAgentIds, setPendingAgentIds] = useState<string[]>([])

  const togglePendingMcp = useCallback((mcpId: string) => {
    setPendingMcpIds((curr) =>
      curr.includes(mcpId) ? curr.filter((id) => id !== mcpId) : [...curr, mcpId]
    )
  }, [])

  const removePendingMcp = useCallback((mcpId: string) => {
    setPendingMcpIds((curr) => curr.filter((id) => id !== mcpId))
  }, [])

  const togglePendingAgent = useCallback((agentId: string) => {
    setPendingAgentIds((curr) =>
      curr.includes(agentId) ? curr.filter((id) => id !== agentId) : [...curr, agentId]
    )
  }, [])

  const removePendingAgent = useCallback((agentId: string) => {
    setPendingAgentIds((curr) => curr.filter((id) => id !== agentId))
  }, [])
  // Primary new-chat agent — the first one picked. Sources example prompts and
  // the comm-pattern badge; replaces the old standalone AgentSelector pick.
  const selectedAgent = useMemo(
    () =>
      pendingAgentIds[0]
        ? (agentList ?? []).find((a) => a.id === pendingAgentIds[0]) ?? null
        : null,
    [pendingAgentIds, agentList]
  )
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

  // Resolve effective provider exclusively from the active chat mode — the
  // app no longer keeps a "default LLM provider" concept, so the mode is the
  // single source of truth for both new chats and active chats that switch
  // modes mid-conversation.
  const effectiveProviderId = activeMode?.providerId ?? null
  // Resolve effective MCPs: mode > defaults
  const effectiveMcpIds = activeMode?.mcpProviderIds?.length
    ? new Set(activeMode.mcpProviderIds)
    : defaultMcpIds

  // The full agent set for the new chat is just the ordered pick list. Drives
  // both the routing decision and the badge.
  const combinedAgentIds = pendingAgentIds

  const commPatternInfo = useMemo(() => {
    if (combinedAgentIds.length === 0 && pendingMcpIds.length === 0) return undefined
    const pattern = derivePattern(combinedAgentIds, pendingMcpIds)
    const agentName =
      combinedAgentIds.length === 1
        ? (agentList ?? []).find((a) => a.id === combinedAgentIds[0])?.name
        : undefined
    const resolvedModelId = resolveModel(activeMode, effectiveProviderId, providers, allModels)
    const modelName = resolvedModelId
      ? (allModels ?? []).find((m) => m.id === resolvedModelId)?.name ?? resolvedModelId
      : undefined
    return { pattern, agentName, modelName }
  }, [combinedAgentIds, pendingMcpIds, agentList, activeMode, effectiveProviderId, providers, allModels])

  const handleSelectMode = useCallback((mode: ChatModeData | null) => {
    setModeSelection(mode ? { id: mode.id } : 'none')
    setSendError(null)
  }, [])

  // Returning to the new-chat screen resets the selection to 'auto' so the
  // current default re-applies — a settings change to the default chat mode (or
  // the account/local precedence) then takes effect immediately when the user
  // hasn't picked anything. (A pick/deselect on the screen sticks until they
  // leave and come back, matching the documented chat-mode behavior.)
  const prevChatIdRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const prev = prevChatIdRef.current
    prevChatIdRef.current = activeChatId
    if (activeChatId === null && prev !== null) setModeSelection('auto')
  }, [activeChatId])

  // The `~` sole-character shortcut opens a chat-modes popup above the textarea
  // (rendered by ChatInput). The `[+]` button's own chat-mode sub-menu manages
  // its open state internally, so only the tilde popup needs coordinating here.
  const [tildeModePopupOpen, setTildeModePopupOpen] = useState(false)

  const handleTildeOpenRequest = useCallback(() => {
    setTildeModePopupOpen(true)
  }, [])

  const handleTildeCancel = useCallback(() => {
    setTildeModePopupOpen(false)
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
    setPendingAgentIds([agent.id])
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
    async (
      message: string,
      attachments?: ComposerAttachment[],
      noteIds?: string[]
    ) => {
      // A2A (one agent, no on-demand MCPs) binds the agent as root and needs
      // no local model. Everything else — orchestrated (agents + tools) or a
      // plain LLM chat — runs through the local model, so it requires a
      // resolvable provider+model.
      const isA2A = combinedAgentIds.length === 1 && pendingMcpIds.length === 0
      const resolvedModelId = resolveModel(activeMode, effectiveProviderId, providers, allModels)
      const hasModel = !!effectiveProviderId && !!resolvedModelId
      const hasDestination = isA2A || hasModel
      if (!hasDestination) {
        setSendError(
          combinedAgentIds.length > 0
            ? 'Orchestrated mode needs a local model — pick a chat mode or set a default in Settings.'
            : "Can't send message — no agent, chat mode, or AI credentials are configured. Pick an agent or set a default chat mode in Settings."
        )
        return
      }
      setSendError(null)
      await startNewChat({
        message,
        agentIds: combinedAgentIds,
        mode: activeMode,
        providerId: effectiveProviderId,
        providers,
        allModels,
        mcpIds: effectiveMcpIds,
        onDemandMcpIds: pendingMcpIds,
        attachments,
        noteIds
      })
      setModeSelection('auto')
      setPendingMcpIds([])
      setPendingAgentIds([])
    },
    [
      startNewChat,
      combinedAgentIds,
      activeMode,
      effectiveProviderId,
      providers,
      allModels,
      effectiveMcpIds,
      pendingMcpIds
    ]
  )

  // Active chat: resolve current mode from chatData.modeId
  const { data: activeChatData } = useChatDetail(activeChatId)

  const activeChatMode = activeChatData?.modeId
    ? (chatModes ?? []).find((m) => m.id === activeChatData.modeId) ?? null
    : null

  // Multi-agent routing lives entirely inside ChatInput (via useChatComposer).
  // MainArea no longer needs to thread active-agent / catchup / rewrite state
  // through props — the composer reads fresh React Query state at submit time.

  const handleActiveChatModeChange = useCallback(
    async (mode: ChatModeData | null) => {
      if (!activeChatId) return

      if (!mode) {
        await updateChat.mutateAsync({ chatId: activeChatId, updates: { modeId: null } })
        return
      }

      const resolvedProviderId = mode.providerId ?? null
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
    [activeChatId, updateChat, providers, allModels, defaultMcpIds, setChatMcp]
  )

  // Tilde-driven select: apply the mode, wipe the `~` from the textarea, and
  // close the popup. Button-driven select just closes the popup (no wipe —
  // there's no `~` involved).
  const handleSelectModeViaTilde = useCallback(
    (mode: ChatModeData) => {
      handleSelectMode(mode)
      chatInputRef.current?.clearInput()
      setTildeModePopupOpen(false)
    },
    [handleSelectMode]
  )

  const handleActiveChatModeChangeViaTilde = useCallback(
    async (mode: ChatModeData) => {
      await handleActiveChatModeChange(mode)
      chatInputRef.current?.clearInput()
      setTildeModePopupOpen(false)
    },
    [handleActiveChatModeChange]
  )

  if (activeView === 'settings') {
    return <SettingsPage />
  }

  if (activeView === 'job-detail') {
    return <JobDetail />
  }

  if (activeView === 'job-edit') {
    return <JobEditPage />
  }

  if (activeView === 'cinna-task-run') {
    return <CinnaTaskRunView />
  }

  if (activeView === 'note-detail') {
    return <NoteDetail />
  }

  const modeColorPreset = activeMode ? getPreset(activeMode.colorPreset) : null

  // Helpers shared by both ChatInput instances when wiring the `~` mode popup.
  const renderModeIcon = (mode: ChatModeData): React.ReactNode => (
    <div
      className="w-2.5 h-2.5 rounded-full shrink-0"
      style={{ backgroundColor: getPreset(mode.colorPreset).border }}
    />
  )
  const composeModeSecondary = (mode: ChatModeData): string | null => {
    const model = mode.modelId
      ? (allModels ?? []).find((m) => m.id === mode.modelId)?.name ?? mode.modelId
      : null
    const mcps = resolveMcpNames(mode.mcpProviderIds, mcpProviders)
    if (!model && !mcps.length) return null
    return [model, mcps.length ? mcps.join(', ') : null].filter(Boolean).join(' · ')
  }
  // Drop account-managed modes the user has locally disabled — they shouldn't be
  // selectable in the composer (their provider's adapter is unregistered).
  const availableModes = (chatModes ?? []).filter((m) => m.enabled !== false)

  const sendErrorBanner = sendError ? (
    <div
      role="alert"
      className="w-full max-w-3xl mx-auto px-4 mb-2 text-xs text-[var(--color-danger)]
        bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30
        rounded-lg py-2 text-center"
    >
      {sendError}
    </div>
  ) : null

  // Default / New Chat screen
  if (!activeChatId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 pt-[var(--topbar-h)]">
        <div className="mb-8 text-center">
          <Sparkles size={32} className="mx-auto mb-3 text-[var(--color-accent)] opacity-60" />
          <h1 className="text-lg font-semibold text-[var(--color-text)]">What can I help with?</h1>
        </div>
        <ExamplePromptTags
          prompts={examplePrompts}
          animationKey={selectedAgent?.id ?? 'none'}
          onSelect={(p) => handleNewChat(p.full)}
        />
        {sendErrorBanner}
        <ChatInput
          ref={chatInputRef}
          chatId={null}
          onNewChat={handleNewChat}
          modeColor={modeColorPreset}
          selectedAgent={selectedAgent}
          pendingMcpIds={pendingMcpIds}
          onTogglePendingMcp={togglePendingMcp}
          onRemovePendingMcp={removePendingMcp}
          pendingAgentIds={pendingAgentIds}
          onTogglePendingAgent={togglePendingAgent}
          onRemovePendingAgent={removePendingAgent}
          commPatternInfo={commPatternInfo}
          onDoubleEscape={() => setPendingAgentIds([])}
          chatModeMenu={
            availableModes.length > 0
              ? {
                  modes: availableModes,
                  activeId: activeMode?.id ?? null,
                  onSelectMode: handleSelectMode,
                  renderIcon: renderModeIcon,
                  composeSecondary: composeModeSecondary
                }
              : undefined
          }
          tildeModePopup={
            availableModes.length > 0
              ? {
                  open: tildeModePopupOpen,
                  modes: availableModes,
                  activeId: activeMode?.id ?? null,
                  onOpenRequest: handleTildeOpenRequest,
                  onCancel: handleTildeCancel,
                  onSelect: handleSelectModeViaTilde,
                  renderIcon: renderModeIcon,
                  composeSecondary: composeModeSecondary
                }
              : undefined
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
      >
        {/* Backdrop-blur + top fade rendered as a sibling so it never clips the
            command / mention popups that overflow above the textarea. */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 24px)',
            maskImage: 'linear-gradient(to bottom, transparent, black 24px)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)'
          }}
        />
        <div className="relative pointer-events-auto">
          {sendErrorBanner}
          <ChatInput
            ref={chatInputRef}
            chatId={activeChatId}
            modeColor={activeChatModeColor}
            chatModeMenu={
              activeChatMode && availableModes.length > 0
                ? {
                    modes: availableModes,
                    activeId: activeChatMode.id,
                    onSelectMode: handleActiveChatModeChange,
                    renderIcon: renderModeIcon,
                    composeSecondary: composeModeSecondary
                  }
                : undefined
            }
            tildeModePopup={
              activeChatMode && availableModes.length > 0
                ? {
                    open: tildeModePopupOpen,
                    modes: availableModes,
                    activeId: activeChatMode.id,
                    onOpenRequest: handleTildeOpenRequest,
                    onCancel: handleTildeCancel,
                    onSelect: handleActiveChatModeChangeViaTilde,
                    renderIcon: renderModeIcon,
                    composeSecondary: composeModeSecondary
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  )
}
