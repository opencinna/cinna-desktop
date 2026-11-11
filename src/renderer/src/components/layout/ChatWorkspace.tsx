import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { NO_CHAT_MODE, useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { useAgents } from '../../hooks/useAgents'
import { MessageStream } from '../chat/MessageStream'
import { ChatInput, type ChatInputHandle } from '../chat/ChatInput'
import { RefusableExamplePrompts, readinessRefusal, usePickedFolder } from '../chat/ComposerReadiness'
import { GUIDED_BUILD_HEADING, guidedBuildPlaceholder } from '../chat/GuidedBuildNotice'
import { ExamplePromptTags } from '../chat/ExamplePromptTags'
import { HintBar } from '../ui/HintBar'
import { DesktopAppsBanner } from '../chat/DesktopAppsBanner'
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
import { useNewChatLike } from '../../hooks/useNewChatLike'
import { unwrapIpcError } from '../../utils/ipcError'
import { useAppSettings } from '../../hooks/useAppSettings'
import { canConduct, newChatRouter } from '../../../../shared/chatRouting'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'
import { composerModes } from '../../utils/composerModes'
import { ChatModeGlyph } from '../chat/ChatModeGlyph'
import { CinnaLogoDraw } from '../ui/CinnaLogoDraw'
import { useBrandThemeStore } from '../../stores/brandTheme.store'
import type { ComposerAttachment } from '../../../../shared/attachments'
import { useComposerDraftField, useComposerDraftKey } from '../../hooks/useComposerDraft'
import { useComposerDraftStore } from '../../stores/composerDraft.store'
import { requestMinimalView, useMinimalView } from '../../hooks/useMinimalView'
import { useWipeGesture } from '../../hooks/useWipeGesture'
import { OPEN_FLOATING_LAYER_SELECTOR } from '../../hooks/useSidebarHoverDock'
import { useOverscrollExit } from '../../hooks/useOverscrollExit'
import { MinimalRestoreButton } from './MinimalRestoreButton'
import { PinnedFilesCard, type PinnedFilesReserve } from '../chat/PinnedFilesCard'

/** Why the new-chat composer holds sends while a picked agent is being drafted. */
const DRAFTING_SEND_HOLD = "Drafting this agent's prompts — send when it finishes."

export function ChatWorkspace({
  agentId,
  embedded = false,
  chatId: hostedChatId,
  composerTop,
  onNewChatLike
}: {
  agentId?: string
  embedded?: boolean
  /**
   * Show this chat instead of the chat store's selection: the dashboard's chat
   * panel (README D12). The host keeps the store's `activeChatId` on it while
   * shown, since the live run watch and the streamed projection follow that;
   * the one-shot "land on the new-chat screen" requests are left to the main
   * view.
   */
  chatId?: string
  /** Above the composer, inside its bottom-anchored wrapper (the panel's starters and context chip). */
  composerTop?: React.ReactNode
  /** Replaces the prompt-cache notice's New chat (the panel starts its own). */
  onNewChatLike?: () => void
}): React.JSX.Element {
  const { activeView, pendingAgentId, setPendingAgentId } = useUIStore()
  const agentStatusOpen = useUIStore((s) => s.agentStatusOpen)
  const pendingModeId = useUIStore((s) => s.pendingModeId)
  // The active profile's brand (not a lock screen's override): its logo for the mode
  // showing (the resolved Dark/Light, System included) and its heading.
  const colorMode = useUIStore((s) => s.theme)
  const brandLogo = useBrandThemeStore((s) => s.active?.logo?.[colorMode] ?? null)
  const brandHeading = useBrandThemeStore((s) => s.active?.copy?.newChatHeading ?? null)
  const setPendingModeId = useUIStore((s) => s.setPendingModeId)
  const storedChatId = useChatStore((s) => s.activeChatId)
  const hosted = hostedChatId !== undefined
  const activeChatId = hosted ? hostedChatId : embedded ? null : storedChatId
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
  const [conductorPick, setConductorPick] = useComposerDraftField(newChatDraftKey, 'conductorId')
  // Who routes several agents: the draft's own pick (New chat from a `human`
  // chat) until the agent set is edited, else the Settings default.
  const [routingPick, setRoutingPick] = useComposerDraftField(newChatDraftKey, 'multiAgentRouting')
  const multiAgentRouting = routingPick ?? appSettings?.defaultMultiAgentRouting
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
    setRoutingPick(null)
  }, [initialAgentIds, setPendingAgentIds, setRoutingPick])

  const removePendingAgent = useCallback((agentId: string) => {
    setPendingAgentIds((curr) => (curr ?? initialAgentIds).filter((id) => id !== agentId))
    setRoutingPick(null)
  }, [initialAgentIds, setPendingAgentIds, setRoutingPick])
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

  // Minimal view: the main chat view's open chat only — never the agent page's
  // or the dashboard panel's workspace.
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const composerAreaRef = useRef<HTMLDivElement>(null)
  const minimal = useMinimalView({
    enabled: !embedded && !hosted,
    chatId: activeChatId,
    inputHeight,
    chatInputRef,
    areaRef: chatAreaRef
  })
  const cloud = minimal.phase === 'cloud' || minimal.phase === 'returning'
  // How far the composer's drawn content (its notice panel, the rows above
  // the box, the box) reaches up from the bottom of the chat area: chat search
  // sits just above it, following the notice panel as it comes and goes.
  const [composerReach, setComposerReach] = useState<number | undefined>(undefined)
  useEffect(() => {
    const area = chatAreaRef.current
    const composer = composerAreaRef.current
    if (!area || !composer || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const reach = area.getBoundingClientRect().bottom - composer.getBoundingClientRect().top
      setComposerReach(reach > 0 ? Math.round(reach) : undefined)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(composer)
    ro.observe(area)
    // Minimal view slides the dock by transform, which no ResizeObserver
    // sees: measure again once a slide has ended.
    const dockEl = inputWrapperRef.current
    dockEl?.addEventListener('transitionend', measure)
    return () => {
      ro.disconnect()
      dockEl?.removeEventListener('transitionend', measure)
    }
  }, [activeChatId, activeView, minimal.phase])
  // Whether the cloud shows (its draft has content): Jump to latest then sits above it.
  const [cloudShown, setCloudShown] = useState(false)
  // Scrolling down twice more at the bottom of the transcript leaves minimal view.
  useOverscrollExit(chatAreaRef, { enabled: minimal.phase === 'cloud', onExit: minimal.restore })
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

  // A freshly created local agent's one-shot draft is still writing its
  // prompts: hold the send, so the first turn does not run on the kit's
  // templates. Here rather than on the agent page, because the same agent can
  // be picked on the main New chat screen, by `@` or by a shortcut.
  const draftingAgentIds = useUIStore((s) => s.draftingAgentIds)
  const sendHold = combinedAgentIds.some((id) => draftingAgentIds.includes(id))
    ? DRAFTING_SEND_HOLD
    : null

  // Who conducts if this chat is coordinated: the agent the user set as
  // coordinator on its chip while it is still picked, else the first agent
  // picked when it can conduct, else the hidden Default runtime (null).
  const conductorAgent = useMemo(() => {
    const picked = conductorPick && combinedAgentIds.includes(conductorPick)
      ? (agentList ?? []).find((a) => a.id === conductorPick) ?? null
      : null
    if (picked && canConduct(picked)) return picked
    return selectedAgent && canConduct(selectedAgent) ? selectedAgent : null
  }, [conductorPick, combinedAgentIds, agentList, selectedAgent])

  // Every picked agent but the conductor would be a participant; with none
  // there is nothing to coordinate.
  const canCoordinate = combinedAgentIds.some((id) => id !== conductorAgent?.id)

  // "Coordinate by…" is one-way inside a chat, but nothing exists yet: a draft
  // left with nothing to coordinate — its agents all removed, or only the
  // conductor left — starts over, or it would be coordinated with no control
  // on screen that says why or undoes it.
  useEffect(() => {
    if (canCoordinate) return
    if (coordinate) setCoordinate(false)
    if (conductorPick) setConductorPick(null)
  }, [canCoordinate, coordinate, conductorPick, setCoordinate, setConductorPick])

  /** A pending chip's "Set as Coordinator": coordinate, with that agent conducting. */
  const setPendingCoordinator = useCallback((agentId: string) => {
    setConductorPick(agentId)
    setCoordinate(true)
  }, [setConductorPick, setCoordinate])

  // The router this selection would create — the same call `startNewChat`
  // makes, so the badge cannot promise a shape the send does not build.
  const newRouter = useMemo(
    () => newChatRouter({ agentIds: combinedAgentIds, mcpIds: [...activeModeMcpIds, ...pendingMcpIds], defaultMultiAgentRouting: multiAgentRouting, coordinate }),
    [combinedAgentIds, pendingMcpIds, activeModeMcpIds, multiAgentRouting, coordinate]
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
      coordinateAction: newRouter !== 'coordinator' && canCoordinate ? { conductorName: conductorAgent?.name ?? 'Default runtime', onCoordinate: () => setCoordinate(true) } : undefined,
      // One agent has nobody to coordinate: no chip offers it.
      onSetCoordinator: combinedAgentIds.length > 1 ? setPendingCoordinator : undefined,
      conductorId: conductorAgent?.id ?? null,
      conductorName: conductorAgent?.name ?? 'Default runtime',
      agentName: nameOf(combinedAgentIds[0]),
      // The first agent picked is who `startNewChat` sends the first message to.
      answererName: nameOf(combinedAgentIds[0]),
      modelName
    }
  }, [newRouter, setCoordinate, setPendingCoordinator, conductorAgent, canCoordinate, combinedAgentIds, pendingMcpIds, agentList, activeMode, effectiveProviderId, providers, allModels])

  // The refusal an example prompt would meet: the same rule the composer
  // applies to the agent a message goes straight to. Example prompts are never
  // `/run:`, and a chat the model coordinates refuses nothing here — an
  // agent's failure comes back to it as a tool result.
  const exampleRefusal = newRouter !== 'coordinator' ? readinessRefusal(selectedAgent) : null

  // Guided first build: one picked agent, a blank kit agent, a chat it answers
  // directly, and the setting on. The example prompts are not shown — each is
  // a task the agent cannot do yet, and a click sends it — their row is drawn
  // empty, and the composer's own notice row offers the guidance.
  // The folder is looked up by id in the folder list, which the create
  // mutation writes a new agent into before its page opens, so on the New
  // agent path the answer is there at first paint. When it is not — the folder
  // list or the settings still loading for an agent that may be blank — the
  // slot is undetermined: neither prompts nor the guidance, and a blank
  // placeholder, so the screen never paints one state and then the other.
  const guidedPickId = combinedAgentIds.length === 1 && newRouter === 'direct' ? combinedAgentIds[0] : null
  const { folder: pickedFolder, pending: guidedCandidatePending } = usePickedFolder(
    guidedPickId,
    (agentList ?? []).some((a) => a.id === guidedPickId)
  )
  // Only ever true for a kit agent: a bare folder is never unbuilt. Pending,
  // it may be one — or, while the folder list first loads, any agent at all.
  const guidedCandidate = pickedFolder ? pickedFolder.unbuilt : guidedCandidatePending
  const guidedInvite = guidedCandidate && pickedFolder !== null && appSettings?.guidedFirstBuild === true
  const guidedUndetermined = guidedCandidate && (pickedFolder === null || appSettings === undefined)

  const handleSelectMode = useCallback((mode: ChatModeData | null) => {
    setModeSelection(mode ? { id: mode.id } : 'none')
    setSendError(null)
  }, [setModeSelection, setSendError])

  // The `~` sole-character shortcut opens a chat-modes popup above the textarea
  // (rendered by ChatInput). The `[+]` button's own chat-mode sub-menu manages
  // its open state internally, so only the tilde popup needs coordinating here.
  const [tildeModePopupOpen, setTildeModePopupOpen] = useState(false)
  // How far the new-chat composer's notice panel reaches above it (reserved above the box).
  const [noticeReach, setNoticeReach] = useState(0)
  useEffect(() => setTildeModePopupOpen(false), [activeChatId, newChatDraftKey])

  // The wipe across the composer's input that starts minimal view. It starts
  // over while a composer popup is open or voice is recording.
  useWipeGesture({
    enabled: !embedded && !hosted && activeChatId !== null && minimal.phase === 'full',
    // The input card (the textarea's box, chips included): every counted stroke crosses it.
    getInput: () => {
      const card = composerAreaRef.current?.querySelector('textarea[data-chat-composer]')?.parentElement
      if (!card) return null
      const { x, y, width, height } = card.getBoundingClientRect()
      return { x, y, width, height }
    },
    isBlocked: () =>
      tildeModePopupOpen ||
      !!composerAreaRef.current?.querySelector('[data-composer-popup], [data-voice-recording]') ||
      // A wipe made over a menu or a modal is not aimed at the composer behind it.
      !!document.querySelector(`${OPEN_FLOATING_LAYER_SELECTOR}, .app-modal-panel`),
    onWipe: () => { requestMinimalView(minimal.handoffPending) }
  })

  // Minimal view's transcript-wide drop target: files go through the
  // composer's own drop path (`ChatInputHandle.dropFiles`).
  const [minimalDropDepth, setMinimalDropDepth] = useState(0)
  useEffect(() => { if (!minimal.on) setMinimalDropDepth(0) }, [minimal.on])
  const takesMinimalDrop = (event: React.DragEvent): boolean =>
    minimal.on && event.dataTransfer.types.includes('Files') && !!chatInputRef.current?.acceptsFileDrop()

  const handleTildeOpenRequest = useCallback(() => {
    setTildeModePopupOpen(true)
  }, [])

  const handleTildeCancel = useCallback(() => {
    setTildeModePopupOpen(false)
  }, [])

  // Pending-agent selection from AgentStatusOverlay: land on new-chat screen,
  // preselect the agent, and focus the input. One-shot; cleared after handling.
  useEffect(() => {
    if (embedded || hosted || !pendingAgentId || !agentList) return
    const agent = agentList.find((a) => a.id === pendingAgentId)
    if (!agent) {
      setPendingAgentId(null)
      return
    }
    setActiveChatId(null)
    setPendingAgentIds([agent.id])
    setRoutingPick(null)
    setPendingAgentId(null)
    // Focus after the new-chat screen mounts the input.
    requestAnimationFrame(() => chatInputRef.current?.focus())
  }, [embedded, hosted, pendingAgentId, agentList, setActiveChatId, setPendingAgentId, setPendingAgentIds, setRoutingPick])

  // The same, for a chat mode (a Chats-list mode group's start button): the
  // new-chat screen in that mode, with no agents. `NO_CHAT_MODE` is a plain
  // chat with no mode at all. A mode that no longer exists is dropped. An agent
  // pick still pending wins and this request is dropped: yielding alone would
  // run it one render later and clear the agents the pick just set.
  useEffect(() => {
    if (embedded || hosted || pendingModeId === null) return
    if (pendingAgentId) {
      setPendingModeId(null)
      return
    }
    if (pendingModeId !== NO_CHAT_MODE) {
      if (!chatModes) return
      if (!chatModes.some((m) => m.id === pendingModeId)) {
        setPendingModeId(null)
        return
      }
    }
    setActiveChatId(null)
    setPendingAgentIds([])
    setRoutingPick(null)
    setModeSelection(pendingModeId === NO_CHAT_MODE ? 'none' : { id: pendingModeId })
    setPendingModeId(null)
    requestAnimationFrame(() => chatInputRef.current?.focus())
  }, [embedded, hosted, pendingModeId, pendingAgentId, chatModes, setActiveChatId, setPendingModeId, setPendingAgentIds, setModeSelection, setRoutingPick])

  // When the agent-status overlay closes and we're on the chat view (new-chat
  // form or active chat), return focus to the chat input so the user can keep
  // typing without another click.
  const prevStatusOpen = useRef(agentStatusOpen)
  useEffect(() => {
    if (prevStatusOpen.current && !agentStatusOpen && activeView === 'chat' && !hosted) {
      requestAnimationFrame(() => chatInputRef.current?.focus())
    }
    prevStatusOpen.current = agentStatusOpen
  }, [agentStatusOpen, activeView, hosted])

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
        defaultMultiAgentRouting: multiAgentRouting,
        coordinate,
        conductorId: conductorAgent?.id ?? null,
        mode: activeMode,
        providerId: effectiveProviderId,
        providers,
        allModels,
        mcpIds: effectiveMcpIds,
        onDemandMcpIds: pendingMcpIds,
        attachments,
        noteIds,
        // A request: main stores it only if the agent still qualifies.
        ...(guidedInvite ? { guidedBuild: true } : {})
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
        ...(draft.conductorId === conductorPick ? { conductorId: null } : {}),
        ...(draft.multiAgentRouting === routingPick ? { multiAgentRouting: null } : {}),
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
      multiAgentRouting,
      routingPick,
      coordinate,
      conductorAgent,
      conductorPick,
      activeMode,
      effectiveProviderId,
      providers,
      allModels,
      effectiveMcpIds,
      pendingMcpIds,
      newChatDraftKey,
      modeSelection,
      storedPendingAgentIds,
      guidedInvite
    ]
  )

  // Active chat: resolve current mode from chatData.modeId
  const { data: activeChatData } = useChatDetail(activeChatId)

  // The Pinned files card: the main chat view only, for a chat whose root
  // agent is a folder agent (a coordinator's other agents' pins are not shown).
  const rootAgentId = activeChatData?.agentId ?? null
  const pinnedFilesAgentId =
    !embedded && !hosted && rootAgentId !== null &&
    agentList?.find((agent) => agent.id === rootAgentId)?.capabilities?.cwd === true
      ? rootAgentId
      : null
  // The room the transcript keeps for that block where no gutter holds it.
  const [pinnedFilesReserve, setPinnedFilesReserve] = useState<PinnedFilesReserve>(null)

  const activeChatMode = activeChatData?.modeId
    ? (chatModes ?? []).find((m) => m.id === activeChatData.modeId) ?? null
    : null

  // The prompt-cache notice's New chat: the new-chat screen set up like the
  // open chat, its composer focused once it mounts. Nothing is sent.
  const newChatLike = useNewChatLike(activeChatId, embedded ? agentId : undefined)
  const handleNewChatLike = useCallback(() => {
    void newChatLike()
      .then(() => requestAnimationFrame(() => chatInputRef.current?.focus()))
      .catch((error: unknown) => setSendError(unwrapIpcError(error, 'Could not set up a new chat like this one.')))
  }, [newChatLike, setSendError])

  // Multi-agent routing lives entirely inside ChatInput (via useChatComposer).
  // MainArea no longer needs to thread active-agent / catchup / rewrite state
  // through props — the composer reads fresh React Query state at submit time.

  const handleActiveChatModeChange = useCallback(
    async (mode: ChatModeData | null) => {
      if (!activeChatId) return
      // Main can refuse a mode (a chat shared across profiles takes no
      // account mode); nothing above this catches it.
      await applyChatMode(activeChatId, mode).catch((error) =>
        setSendError(unwrapIpcError(error, 'The chat mode could not be changed.')))
    },
    [activeChatId, applyChatMode, setSendError]
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
  const renderModeIcon = (mode: ChatModeData): React.ReactNode => <ChatModeGlyph mode={mode} dot={10} />
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
  // Runtime modes come first (the Runtimes group), and only while their
  // runtime can start a chat; one that is not set up is fixed in Settings.
  const availableModes = composerModes(chatModes ?? [])

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
        className={`relative flex-1 flex flex-col items-center px-4 ${embedded ? 'min-h-64 py-8' : 'pt-[var(--topbar-h)]'} ${
          // Reserve the strip the absolutely-positioned HintBar overlays, so a
          // tall composer on a short window can't grow underneath it.
          hintsEnabled ? 'pb-8' : ''
        }`}
      >
        {/* Absolute at the top (like the HintBar at the bottom), so the offer
            appearing or going away never moves the composition. */}
        {!embedded && <DesktopAppsBanner />}
        {/* The composer is held at the column's middle by two equal halves,
            and everything above it stacks upward from it: the heading, the
            prompt slot, a send error and the room the composer's notice panel
            reaches up into. A notice row coming or going (picking an agent by
            "@", Skip guidance, a readiness fix) moves what is above, never the
            box being typed in (ux_rules rule 1), and covers nothing. On a
            window too short for it the upper half takes what it needs. */}
        <div data-testid="new-chat-above-composer" className="flex w-full flex-1 flex-col items-center justify-end">
        {/* One box whose text changes: the guided first build's question
            takes the generic heading's place at the same margin, so picking a
            blank agent by "@" or Skip guidance changes only text. Undetermined,
            the heading line is blank. */}
        {!embedded && <div className="text-center mb-8">
          {brandLogo ? (
            // The server's logo in CinnaLogoDraw's box: the same 62 px height
            // and mb-3 (both block, per preflight), so the heading and all
            // below sit where they do with the stock mark (ux_rules rule 1).
            // Shown at once; no click-to-reveal, no draw or sweep.
            <img
              data-testid="brand-logo"
              src={brandLogo}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="mx-auto mb-3 h-[62px] w-auto max-w-[240px] object-contain"
            />
          ) : (
            <CinnaLogoDraw className="mx-auto mb-3" />
          )}
          <h1 className="splash-block splash-block-fill mx-auto w-fit text-lg font-semibold text-[var(--color-text)]">
            {guidedInvite && pickedFolder ? GUIDED_BUILD_HEADING : guidedUndetermined ? '\u00a0' : brandHeading || 'What can I help with?'}
          </h1>
        </div>}
        <div data-testid="new-chat-prompt-slot" className="flex w-full flex-col items-center justify-end">
        {(guidedInvite && pickedFolder) || guidedUndetermined ? (
          // The example-prompt row's footprint, empty: guided, undetermined and
          // the prompts never change the slot's height.
          <div data-testid={guidedUndetermined ? 'guided-build-undetermined' : 'guided-build-slot'} className="mb-3 min-h-10 w-full" />
        ) : (
          <RefusableExamplePrompts refusal={exampleRefusal} hold={sendHold}>
            <ExamplePromptTags
              prompts={examplePrompts}
              animationKey={selectedAgent?.id ?? 'none'}
              // An example prompt sends past the composer, so its refusal is
              // applied here, where it is clicked (the tags are also inert).
              onSelect={(p) => {
                if (!exampleRefusal && !sendHold) void handleNewChat(p.full)
              }}
            />
          </RefusableExamplePrompts>
        )}
        </div>
        {sendErrorBanner}
        {/* The notice panel's reach above the composer (it is drawn out of the flow). */}
        <div aria-hidden="true" className="w-full shrink-0" style={{ height: noticeReach }} />
        </div>
        <ChatInput
          ref={chatInputRef}
          chatId={null}
          draftKey={newChatDraftKey}
          onNewChat={handleNewChat}
          sendHold={sendHold}
          placeholder={guidedInvite && pickedFolder ? guidedBuildPlaceholder(pickedFolder.name) : guidedUndetermined ? '' : undefined}
          guidedBuildAgentId={guidedInvite && pickedFolder ? pickedFolder.id : null}
          onNoticePanelHeight={setNoticeReach}
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
        <div aria-hidden="true" className="flex-1" />
        {/* Sits outside the centered stack (absolute, bottom-anchored) so a
            hint appearing or changing never shifts the composition above it. */}
        {!embedded && <HintBar selectedAgent={selectedAgent} pendingAgentCount={pendingAgentIds.length} />}
      </div>
    )
  }

  // Active chat
  const activeChatModeColor = activeChatMode ? getPreset(activeChatMode.colorPreset) : null

  return (
    <div
      ref={chatAreaRef}
      className="flex-1 flex flex-col min-w-0 relative overflow-hidden"
      onDragEnter={(event) => {
        if (!takesMinimalDrop(event)) return
        event.preventDefault()
        setMinimalDropDepth((depth) => depth + 1)
      }}
      onDragOver={(event) => {
        if (!takesMinimalDrop(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!minimal.on || !event.dataTransfer.types.includes('Files')) return
        setMinimalDropDepth((depth) => Math.max(0, depth - 1))
      }}
      onDrop={(event) => {
        if (!minimal.on) return
        setMinimalDropDepth(0)
        // A drop on the cloud itself was taken by its own target already.
        if (event.defaultPrevented || !takesMinimalDrop(event)) return
        event.preventDefault()
        chatInputRef.current?.dropFiles(event.dataTransfer)
      }}
    >
      <MessageStream
        chatId={activeChatId}
        searchable={!embedded && !hosted}
        bottomPadding={minimal.bottomPadding}
        searchBottom={composerReach !== undefined && minimal.phase === 'full' ? composerReach + 8 : undefined}
        // Minimal view: Jump to latest sits at the bottom edge, where the composer
        // was, or above the cloud while it shows (the wrapper's measured height).
        pillBottom={minimal.phase === 'cloud' ? (cloudShown ? Math.max(12, inputHeight - 8) : 12) : undefined}
        reserve={pinnedFilesReserve}
      />
      {/* Never over a message: where it has no gutter, the transcript makes room for it. */}
      <PinnedFilesCard chatId={activeChatId} agentId={pinnedFilesAgentId} onReserveChange={setPinnedFilesReserve} />
      <div
        ref={inputWrapperRef}
        data-minimal-phase={minimal.phase}
        className="composer-dock absolute bottom-0 left-0 right-0 pt-6 pb-3 pointer-events-none"
      >
        {/* Backdrop-blur + top fade rendered as a sibling so it never clips the
            command / mention popups that overflow above the textarea. */}
        <div
          aria-hidden
          className={`absolute inset-0 pointer-events-none ${cloud ? 'hidden' : ''}`}
          style={{
            WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 24px)',
            maskImage: 'linear-gradient(to bottom, transparent, black 24px)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            // A card around the chat (the dashboard's panel) rounds it to its own corners.
            borderBottomLeftRadius: 'var(--composer-dock-corner, 0px)',
            borderBottomRightRadius: 'var(--composer-dock-corner, 0px)'
          }}
        />
        <div
          ref={composerAreaRef}
          // Not clickable while it slides out or back, nor as the cloud's
          // full-width strip (the cloud takes clicks itself only while it
          // shows, main.css); never `inert`, so the textarea keeps focus.
          className={`relative ${minimal.phase === 'full' || minimal.phase === 'entering' ? 'pointer-events-auto' : 'pointer-events-none'}`}
        >
          <div className={cloud ? 'hidden' : undefined}>
            {composerTop}
            {sendErrorBanner}
          </div>
          <ChatInput
            ref={chatInputRef}
            chatId={activeChatId}
            minimal={cloud}
            onCloudShownChange={setCloudShown}
            onNewChatLike={onNewChatLike ?? handleNewChatLike}
            modeColor={activeChatModeColor}
            // A runtime mode's chat: the runtime chip carries the mode's glyph, not the generic bot.
            conductorIcon={activeChatMode?.builtinEngine ? <ChatModeGlyph mode={activeChatMode} dot={10} /> : undefined}
            // The chat's captured policy, from main — not its mode's current Tools.
            onOpenChatFolder={activeChatData?.workspace ? () => {
              const chatId = activeChatId
              void window.api.chat.openFolder(chatId)
                .then((result) => { if (!result.success) setSendError(result.error) })
                .catch((error: unknown) => setSendError(unwrapIpcError(error, 'Could not open the chat folder.')))
            } : undefined}
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
      {minimal.on && minimalDropDepth > 0 && (
        <div
          data-testid="minimal-drop-overlay"
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl
            border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent)]/10 backdrop-blur-sm
            text-sm font-medium text-[var(--color-accent)]"
        >
          Drop to attach
        </div>
      )}
      {minimal.phase !== 'full' && <MinimalRestoreButton shown={minimal.phase === 'cloud'} onRestore={minimal.restore} />}
    </div>
  )
}
