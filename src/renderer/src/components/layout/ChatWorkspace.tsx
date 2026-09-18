import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { useAgents } from '../../hooks/useAgents'
import { MessageStream } from '../chat/MessageStream'
import { ChatInput, type ChatInputHandle } from '../chat/ChatInput'
import { RefusableExamplePrompts, readinessRefusal } from '../chat/ComposerReadiness'
import { ExamplePromptTags } from '../chat/ExamplePromptTags'
import { HintBar } from '../ui/HintBar'
import { useHintsEnabled } from '../../hooks/useHintsEnabled'
import { extractExamplePrompts } from '../../utils/examplePrompts'
import { resolveMcpNames } from '../../utils/mcpNames'
import { useChatDetail } from '../../hooks/useChat'
import { useChatModes, useDefaultChatMode } from '../../hooks/useChatModes'
import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders } from '../../hooks/useMcp'
import { useNewChatFlow, resolveModel } from '../../hooks/useNewChatFlow'
import { useApplyChatMode } from '../../hooks/useApplyChatMode'
import { useAppSettings } from '../../hooks/useAppSettings'
import { canConduct, newChatRouter } from '../../../../shared/chatRouting'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'
import { CinnaLogoDraw } from '../ui/CinnaLogoDraw'
import type { ComposerAttachment } from '../../../../shared/attachments'
import { useComposerDraftField, useComposerDraftKey } from '../../hooks/useComposerDraft'
import { useComposerDraftStore } from '../../stores/composerDraft.store'

export function ChatWorkspace({ agentId, embedded = false }: { agentId?: string; embedded?: boolean }): React.JSX.Element {
  const { activeView, pendingAgentId, setPendingAgentId } = useUIStore()
  const agentStatusOpen = useUIStore((s) => s.agentStatusOpen)
  const storedChatId = useChatStore((s) => s.activeChatId)
  const activeChatId = embedded ? null : storedChatId
  const newChatDraftKey = useComposerDraftKey(null, embedded ? agentId : undefined)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const sendError = useChatStore((s) => s.sendError)
  const setSendError = useChatStore((s) => s.setSendError)
  const { data: agentList } = useAgents()
  const { data: providers } = useProviders()
  const { data: allModels } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const { data: defaultMode } = useDefaultChatMode()
  const { data: chatModes } = useChatModes()
  const hintsEnabled = useHintsEnabled()
  const { data: appSettings } = useAppSettings()
  const { startNewChat } = useNewChatFlow()
  const applyChatMode = useApplyChatMode()
  // New-chat mode selection, modelled as intent rather than a snapshot:
  //   'auto'      → follow the current default mode REACTIVELY (so changing the
  //                 default chat mode, editing it, or flipping the account/local
  //                 precedence in Settings updates the composer immediately),
  //   'none'      → the user explicitly cleared the mode,
  //   { id }      → the user picked a specific mode (re-derived from the live
  //                 list so edits to that mode propagate too).
  const [modeSelection, setModeSelection] = useComposerDraftField(newChatDraftKey, 'modeSelection')
  const activeMode = useMemo<ChatModeData | null>(() => {
    if (modeSelection === 'none') return null
    if (modeSelection === 'auto') return defaultMode ?? null
    return (chatModes ?? []).find((m) => m.id === modeSelection.id) ?? null
  }, [modeSelection, defaultMode, chatModes])
  // On-demand MCP buffer for the new-chat screen — the chat row doesn't
  // exist yet, so picks are held here until `useNewChatFlow.startNewChat`
  // flushes them onto the created chat.
  const [coordinate, setCoordinate] = useComposerDraftField(newChatDraftKey, 'coordinate')
  const [pendingMcpIds, setPendingMcpIds] = useComposerDraftField(newChatDraftKey, 'pendingMcpIds')
  // The new-chat agent set — a single ordered list. Both the `[+]` capability
  // picker and the `@` popup toggle into it; the "primary" agent (first picked)
  // is derived below for example-prompt sourcing and the comm badge.
  const [storedPendingAgentIds, setPendingAgentIds] = useComposerDraftField(newChatDraftKey, 'pendingAgentIds')
  const initialAgentIds = useMemo(() => agentId ? [agentId] : [], [agentId])
  const pendingAgentIds = storedPendingAgentIds ?? initialAgentIds

  const togglePendingMcp = useCallback((mcpId: string) => {
    setPendingMcpIds((curr) =>
      curr.includes(mcpId) ? curr.filter((id) => id !== mcpId) : [...curr, mcpId]
    )
  }, [setPendingMcpIds])

  const removePendingMcp = useCallback((mcpId: string) => {
    setPendingMcpIds((curr) => curr.filter((id) => id !== mcpId))
  }, [setPendingMcpIds])

  const togglePendingAgent = useCallback((agentId: string) => {
    setPendingAgentIds((stored) => {
      const curr = stored ?? initialAgentIds
      return curr.includes(agentId) ? curr.filter((id) => id !== agentId) : [...curr, agentId]
    })
  }, [initialAgentIds, setPendingAgentIds])

  const removePendingAgent = useCallback((agentId: string) => {
    setPendingAgentIds((curr) => (curr ?? initialAgentIds).filter((id) => id !== agentId))
  }, [initialAgentIds, setPendingAgentIds])
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
  // Resolve effective provider exclusively from the active chat mode — the
  // app no longer keeps a "default LLM provider" concept, so the mode is the
  // single source of truth for both new chats and active chats that switch
  // modes mid-conversation.
  const effectiveProviderId = activeMode?.providerId ?? null
  // The new chat's baseline MCP set is exactly the active mode's list —
  // nothing selected means nothing attached. There is deliberately no
  // "fall back to every enabled MCP" rule: it silently handed each chat every
  // connector the user owned (and their tool schemas) without any selection
  // gesture. Extra servers come in per-chat via the on-demand picks below.
  const activeModeMcpIds = useMemo(() => activeMode?.mcpProviderIds ?? [], [activeMode])
  const effectiveMcpIds = useMemo(() => new Set(activeModeMcpIds), [activeModeMcpIds])

  // The full agent set for the new chat is just the ordered pick list. Drives
  // both the routing decision and the badge.
  const combinedAgentIds = pendingAgentIds

  // "Coordinate by…" is one-way inside a chat, but nothing exists yet: a draft
  // whose agents were all removed starts over, or the next pick would be
  // coordinated with no control on screen that says why or undoes it.
  useEffect(() => {
    if (coordinate && combinedAgentIds.length === 0) setCoordinate(false)
  }, [coordinate, combinedAgentIds.length, setCoordinate])

  // The router this selection would create — the same call `startNewChat`
  // makes, so the badge cannot promise a shape the send does not build.
  const newRouter = useMemo(
    () => newChatRouter({ agentIds: combinedAgentIds, mcpIds: [...activeModeMcpIds, ...pendingMcpIds], defaultMultiAgentRouting: appSettings?.defaultMultiAgentRouting, coordinate }),
    [combinedAgentIds, pendingMcpIds, activeModeMcpIds, appSettings?.defaultMultiAgentRouting, coordinate]
  )

  const routerInfo = useMemo(() => {
    if (combinedAgentIds.length === 0 && pendingMcpIds.length === 0) return undefined
    const nameOf = (id: string | undefined): string | undefined =>
      id ? (agentList ?? []).find((a) => a.id === id)?.name : undefined
    const resolvedModelId = resolveModel(activeMode, effectiveProviderId, providers, allModels)
    const modelName = resolvedModelId
      ? (allModels ?? []).find((m) => m.id === resolvedModelId)?.name ?? resolvedModelId
      : undefined
    return {
      router: newRouter,
      coordinateAction: newRouter !== 'coordinator' && combinedAgentIds.length > 0 ? { conductorName: selectedAgent && canConduct(selectedAgent) ? selectedAgent.name : 'Default runtime', onCoordinate: () => setCoordinate(true) } : undefined,
      conductorId: selectedAgent && canConduct(selectedAgent) ? selectedAgent.id : null,
      conductorName: selectedAgent && canConduct(selectedAgent) ? selectedAgent.name : 'Default runtime',
      agentName: nameOf(combinedAgentIds[0]),
      // The first agent picked is who `startNewChat` sends the first message to.
      answererName: nameOf(combinedAgentIds[0]),
      modelName
    }
  }, [newRouter, setCoordinate, selectedAgent, combinedAgentIds, pendingMcpIds, agentList, activeMode, effectiveProviderId, providers, allModels])

  // The refusal an example prompt would meet: the same rule the composer
  // applies to the agent a message goes straight to. Example prompts are never
  // `/run:`, and a chat the model coordinates refuses nothing here — an
  // agent's failure comes back to it as a tool result.
  const exampleRefusal = newRouter !== 'coordinator' ? readinessRefusal(selectedAgent) : null

  const handleSelectMode = useCallback((mode: ChatModeData | null) => {
    setModeSelection(mode ? { id: mode.id } : 'none')
    setSendError(null)
  }, [setModeSelection, setSendError])

  // The `~` sole-character shortcut opens a chat-modes popup above the textarea
  // (rendered by ChatInput). The `[+]` button's own chat-mode sub-menu manages
  // its open state internally, so only the tilde popup needs coordinating here.
  const [tildeModePopupOpen, setTildeModePopupOpen] = useState(false)
  useEffect(() => setTildeModePopupOpen(false), [activeChatId, newChatDraftKey])

  const handleTildeOpenRequest = useCallback(() => {
    setTildeModePopupOpen(true)
  }, [])

  const handleTildeCancel = useCallback(() => {
    setTildeModePopupOpen(false)
  }, [])

  // Pending-agent selection from AgentStatusOverlay: land on new-chat screen,
  // preselect the agent, and focus the input. One-shot; cleared after handling.
  useEffect(() => {
    if (embedded || !pendingAgentId || !agentList) return
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
  }, [embedded, pendingAgentId, agentList, setActiveChatId, setPendingAgentId, setPendingAgentIds])

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
      // A chat an agent answers — `direct` with an agent, or `human` — needs no
      // local model at all. Only a coordinated chat, or a plain chat with the
      // model itself, requires a resolvable provider + model.
      setSendError(null)
      const started = await startNewChat({
        message,
        agentIds: combinedAgentIds,
        defaultMultiAgentRouting: appSettings?.defaultMultiAgentRouting,
        coordinate,
        mode: activeMode,
        providerId: effectiveProviderId,
        providers,
        allModels,
        mcpIds: effectiveMcpIds,
        onDemandMcpIds: pendingMcpIds,
        attachments,
        noteIds
      })
      if (!started) return false
      if (embedded) {
        useUIStore.getState().setActiveView('chat')
        useUIStore.getState().setSidebarTab('chats')
      }
      // Navigation never consumes a draft. Successful sends reset only the
      // selections that have not been edited while preparation was in flight.
      useComposerDraftStore.getState().update(newChatDraftKey, (draft) => ({
        ...(draft.coordinate === coordinate ? { coordinate: false } : {}),
        ...(draft.modeSelection === modeSelection ? { modeSelection: 'auto' as const } : {}),
        ...(draft.pendingMcpIds === pendingMcpIds ? { pendingMcpIds: [] } : {}),
        ...(draft.pendingAgentIds === storedPendingAgentIds ? { pendingAgentIds: null } : {})
      }))
      return true
    },
    [
      startNewChat,
      embedded,
      combinedAgentIds,
      appSettings?.defaultMultiAgentRouting,
      coordinate,
      activeMode,
      effectiveProviderId,
      providers,
      allModels,
      effectiveMcpIds,
      pendingMcpIds,
      newChatDraftKey,
      modeSelection,
      storedPendingAgentIds
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
      await applyChatMode(activeChatId, mode)
    },
    [activeChatId, applyChatMode]
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
      <div
        className={`relative flex-1 flex flex-col items-center justify-center px-4 ${embedded ? 'min-h-64 py-8' : 'pt-[var(--topbar-h)]'} ${
          // Reserve the strip the absolutely-positioned HintBar overlays, so a
          // tall composer on a short window can't grow underneath it.
          hintsEnabled ? 'pb-8' : ''
        }`}
      >
        {!embedded && <div className="mb-8 text-center">
          <CinnaLogoDraw className="mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[var(--color-text)]">What can I help with?</h1>
        </div>}
        <RefusableExamplePrompts refusal={exampleRefusal}>
          <ExamplePromptTags
            prompts={examplePrompts}
            animationKey={selectedAgent?.id ?? 'none'}
            // An example prompt sends past the composer, so its refusal is
            // applied here, where it is clicked (the tags are also inert).
            onSelect={(p) => {
              if (!exampleRefusal) void handleNewChat(p.full)
            }}
          />
        </RefusableExamplePrompts>
        {sendErrorBanner}
        <ChatInput
          ref={chatInputRef}
          chatId={null}
          draftKey={newChatDraftKey}
          onNewChat={handleNewChat}
          modeColor={modeColorPreset}
          selectedAgent={selectedAgent}
          pendingMcpIds={pendingMcpIds}
          onTogglePendingMcp={togglePendingMcp}
          onRemovePendingMcp={removePendingMcp}
          baselineMcpIds={activeModeMcpIds}
          pendingAgentIds={pendingAgentIds}
          onTogglePendingAgent={togglePendingAgent}
          onRemovePendingAgent={removePendingAgent}
          routerInfo={routerInfo}
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
        {/* Sits outside the centered stack (absolute, bottom-anchored) so a
            hint appearing or changing never shifts the composition above it. */}
        {!embedded && <HintBar selectedAgent={selectedAgent} pendingAgentCount={pendingAgentIds.length} />}
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
