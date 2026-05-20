import { useState, useRef, useEffect, useCallback, useMemo, useImperativeHandle, useId, forwardRef, type ReactNode } from 'react'
import { SendHorizontal, Square, Bot, Plus, Loader2, Paperclip } from 'lucide-react'
import { useChatDetail } from '../../hooks/useChat'
import { useChatStream } from '../../hooks/useChatStream'
import { useChatStore } from '../../stores/chat.store'
import { useAuthStore } from '../../stores/auth.store'
import { ChatControls } from './ChatControls'
import { AgentMentionPopup } from './AgentMentionPopup'
import { AgentMcpMentionPopup, type AgentMcpItem } from './AgentMcpMentionPopup'
import { ExamplePromptPopup } from './ExamplePromptPopup'
import { CliCommandPopup } from './CliCommandPopup'
import { NoteMentionPopup } from './NoteMentionPopup'
import { useAgents } from '../../hooks/useAgents'
import { useProviders } from '../../hooks/useProviders'
import { useCliCommands, type CliCommand } from '../../hooks/useCliCommands'
import { useMcpProviders, useAddOnDemandMcp } from '../../hooks/useMcp'
import { useChatAttachments } from '../../hooks/useChatAttachments'
import { useModelCapability } from '../../hooks/useModelCapability'
import { useNoteList, useAttachNotesAsFiles } from '../../hooks/useNotes'
import { useChatNotes } from '../../hooks/useChatNotes'
import { extractExamplePrompts, type ExamplePrompt } from '../../utils/examplePrompts'
import type { ColorPreset, ChatModeData } from '../../constants/chatModeColors'
import { MentionPopup } from './MentionPopup'
import { useChatComposer } from '../../hooks/useChatComposer'
import { useRewriteUX } from '../../hooks/useRewriteUX'
import { RewriteHintBar } from './RewriteHintBar'
import { RewriteFailureModal } from './RewriteFailureModal'
import { ActiveAgentChip } from './ActiveAgentChip'
import { OnDemandMcpChips } from './OnDemandMcpChips'
import { AttachmentList } from './AttachmentBadge'
import { NoteBadgeList } from './NoteBadge'
import { AttachMenuPopup, type AttachMenuItem } from './AttachMenuPopup'
import { NotePreviewModal } from '../notes/NotePreviewModal'
import type { ComposerAttachment, MessageAttachment } from '../../../../shared/attachments'
import type { NoteData } from '../../../../shared/notes'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]
type TriggerChar = '@' | '#' | '/' | '?'

interface ChatInputProps {
  chatId: string | null
  onNewChat?: (
    message: string,
    attachments?: ComposerAttachment[],
    noteIds?: string[]
  ) => void
  leftSlot?: ReactNode
  modeColor?: ColorPreset | null
  onSelectAgent?: (agent: AgentData | null) => void
  /** Agent currently selected on the new-chat screen — used to source example prompts for `#`. */
  selectedAgent?: AgentData | null
  /**
   * New-chat MCP engagement buffer. When `chatId` is null, the on-demand MCP
   * popup picks add to / remove from this list (owned by MainArea) instead of
   * hitting the DB. The buffer is flushed onto the chat row after creation
   * inside `useNewChatFlow.startNewChat`.
   */
  pendingMcpIds?: string[]
  onTogglePendingMcp?: (mcpProviderId: string) => void
  onRemovePendingMcp?: (mcpProviderId: string) => void
  /** Fired when the user presses ESC twice in quick succession with no popup open. */
  onDoubleEscape?: () => void
  /**
   * Optional `~` sole-character shortcut that opens a chat-mode picker above
   * the textarea (mirroring the @ / # / / popup positioning). When supplied,
   * ChatInput owns the popup rendering, keyboard navigation, and Enter-to-send
   * suppression — the parent only orchestrates open/close state and selection.
   */
  tildeModePopup?: {
    open: boolean
    modes: ChatModeData[]
    activeId: string | null
    onOpenRequest: () => void
    onCancel: () => void
    onSelect: (mode: ChatModeData) => void
    renderIcon: (mode: ChatModeData) => React.ReactNode
    composeSecondary?: (mode: ChatModeData) => string | null | undefined
  }
}

const DOUBLE_ESC_WINDOW_MS = 400

/** Find a trigger token (@, #, /, or ?) at the cursor position. */
function findTriggerToken(
  value: string,
  cursorPos: number
): { char: TriggerChar; start: number; filter: string } | null {
  let i = cursorPos - 1
  while (i >= 0) {
    const ch = value[i]
    if (ch === '@' || ch === '#' || ch === '/' || ch === '?') {
      if (i === 0 || /\s/.test(value[i - 1])) {
        return { char: ch, start: i, filter: value.slice(i + 1, cursorPos) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

export interface ChatInputHandle {
  focus: () => void
  clearInput: () => void
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    chatId,
    onNewChat,
    leftSlot,
    modeColor,
    onSelectAgent,
    selectedAgent,
    pendingMcpIds,
    onTogglePendingMcp,
    onRemovePendingMcp,
    onDoubleEscape,
    tildeModePopup
  },
  ref
) {
  const [input, setInput] = useState('')
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const attachButtonRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastEscapeAt = useRef(0)
  const { data: chatData } = useChatDetail(chatId)
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  // Used only to gate the new-chat attach button: showing `[+]` for a
  // user with no Cinna account *and* no configured LLM provider would
  // lead them to attach files they have nowhere to send.
  const { data: providers } = useProviders()
  const hasAnyDestination =
    isCinnaUser || (providers ?? []).some((p) => p.enabled && p.hasApiKey)
  const listboxId = useId()

  // Model capability drives both gating (show/hide the [+]) and scope
  // selection for the local-vs-cinna upload split below. Read off the chat
  // detail so a model swap mid-chat re-evaluates immediately.
  const modelCapability = useModelCapability(
    chatData?.providerId ?? null,
    chatData?.modelId ?? null
  )
  const modelSupportsMedia = modelCapability.acceptedMimeTypes.length > 0

  // Composer-local attachment buffer + IPC wiring. Hook owns staleness so
  // switching chats mid-upload (or after a clear) won't repopulate state
  // when the upload eventually resolves. See `useChatAttachments` for the
  // generation-ref trick. `scope` is decided below — Cinna for remote-agent
  // targets, local for raw LLM chats.
  const attachScope: 'cinna' | 'local' = useMemo(() => {
    if (!chatId) return 'cinna'
    if (chatData?.agentId || chatData?.activeAgentId) return 'cinna'
    return 'local'
  }, [chatId, chatData?.agentId, chatData?.activeAgentId])
  const {
    attachments: pendingAttachments,
    isUploading,
    error: attachError,
    pick: pickAttachments,
    pickFromPaths: pickAttachmentsFromPaths,
    remove: handleRemoveAttachment,
    clear: clearPendingAttachments,
    setError: setAttachError
  } = useChatAttachments(chatId, attachScope)
  // Single source of truth for everything multi-agent: routing decisions,
  // active-agent switching, Smart Rewrite, dispatch. Read fresh snapshots
  // internally at every action so there is no closure-staleness window.
  const composer = useChatComposer(chatId)

  const clearComposer = useCallback(() => {
    setInput('')
    clearPendingAttachments()
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [clearPendingAttachments])

  // Hook owns rewrite state machine + textarea side-effects (resize, focus,
  // selection). ChatInput just calls into it from key/change/submit handlers.
  const rewriteUX = useRewriteUX({ textareaRef, setInput, clearComposer })

  // Local kbd-nav index for the `~` chat-mode popup. Reset to the active mode
  // (or the first row) whenever the popup is freshly opened so navigation
  // starts from a sensible spot.
  const [tildeIndex, setTildeIndex] = useState(0)
  const tildeOpen = tildeModePopup?.open ?? false
  // `tildeActive` distinguishes a popup actually being driven by `~` (textarea
  // still holds the lone "~") from any other reason the open prop is true.
  const tildeActive = tildeOpen && input === '~'

  useEffect(() => {
    if (!tildeOpen || !tildeModePopup) return
    const idx = tildeModePopup.activeId
      ? tildeModePopup.modes.findIndex((m) => m.id === tildeModePopup.activeId)
      : -1
    setTildeIndex(idx >= 0 ? idx : 0)
  }, [tildeOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    clearInput: () => {
      setInput('')
      const el = textareaRef.current
      if (el) el.style.height = 'auto'
    }
  }))

  useEffect(() => {
    textareaRef.current?.focus()
  }, [chatId])
  const { cancel: cancelStream } = useChatStream()
  const { isStreaming, activeRequestId } = useChatStore()

  // Trigger popup state — shared between @ (agents/MCP), # (example prompts),
  // / (CLI commands), and ? (notes).
  const [triggerChar, setTriggerChar] = useState<TriggerChar | null>(null)
  const [triggerFilter, setTriggerFilter] = useState('')
  const [triggerStart, setTriggerStart] = useState(0)
  const [triggerIndex, setTriggerIndex] = useState(0)

  // Notes attached via the `?` mention popup. Composer-local buffer keyed
  // by chatId — switching chats wipes it. Body is fetched on the main side
  // at send time, so late edits to a note are reflected in the attached `.md`.
  const {
    notes: pendingNotes,
    add: addPendingNote,
    remove: removePendingNote,
    clear: clearPendingNotes
  } = useChatNotes(chatId)
  const { mutateAsync: attachNotesAsync } = useAttachNotesAsFiles()
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null)
  const previewNote = useMemo(
    () => pendingNotes.find((n) => n.id === previewNoteId) ?? null,
    [pendingNotes, previewNoteId]
  )
  // Preview is UI-only; reset whenever the chat row swaps so a modal
  // doesn't bleed into a different chat's composer.
  useEffect(() => {
    setPreviewNoteId(null)
  }, [chatId])

  const { data: agents } = useAgents()
  const enabledAgents = useMemo(
    () => (agents ?? []).filter((a) => a.enabled),
    [agents]
  )

  // MCP servers available for on-demand engagement in this chat. Only the
  // settings-enabled providers — disabled ones can't connect anyway. Only
  // surfaced inside an active chat (`chatId != null`).
  const { data: allMcps } = useMcpProviders()
  const enabledMcps = useMemo(
    () => (allMcps ?? []).filter((m) => m.enabled),
    [allMcps]
  )
  const addOnDemandMcp = useAddOnDemandMcp()

  const boundAgent = useMemo(
    () => (chatData?.agentId ? (agents ?? []).find((a) => a.id === chatData.agentId) ?? null : null),
    [chatData?.agentId, agents]
  )

  /**
   * Two backing flows feed the [+] button:
   *
   *  - Remote-agent target: Cinna-scoped upload (bytes go to the Cinna
   *    backend, A2A metadata carries the file id). Cinna users only.
   *
   *  - Raw LLM target: local-scoped upload (bytes copied into per-user
   *    `userData/files/`, resolved into provider-native image blocks at
   *    send time). Gated by the active model's capability — empty
   *    capability ⇒ hide the button.
   *
   * `canShowAttachButton` collapses both flows into one render gate; the
   * `attachScope` memo upstream picks which IPC route the picker calls.
   * `targetSupportsAttachments` mirrors the gate so pending uploads clear
   * the moment the user pivots to an incompatible target.
   */
  const attachmentTargetAgent: AgentData | null = chatId
    ? composer.activeAgent ?? boundAgent ?? null
    : selectedAgent ?? null
  const targetIsRemote = attachmentTargetAgent?.source === 'remote'

  // Active-chat gates: split by destination so the wrong scope never queues.
  const canAttachToRemoteAgent = isCinnaUser && targetIsRemote
  const canAttachToLlmModel =
    chatId !== null && !attachmentTargetAgent && modelSupportsMedia

  // New-chat: attachments are deferred until chat creation, so we don't
  // know yet whether the user is going to an LLM or a remote agent.
  // Accept files when *any* destination is plausible — Cinna account or
  // a configured LLM provider — so the button doesn't appear for users
  // who have no way to send a message yet.
  const canShowAttachButton = chatId
    ? canAttachToRemoteAgent || canAttachToLlmModel
    : hasAnyDestination

  const targetSupportsAttachments = chatId
    ? canAttachToRemoteAgent || canAttachToLlmModel
    : hasAnyDestination

  useEffect(() => {
    if (!targetSupportsAttachments && pendingAttachments.length > 0) {
      clearPendingAttachments()
    }
  }, [targetSupportsAttachments, pendingAttachments.length, clearPendingAttachments])

  // Pivoting between scopes (e.g. switching active agent from remote to LLM
  // root) makes already-queued attachments wrong-scope. Drop them so the
  // user re-picks under the new destination's rules.
  const lastScopeRef = useRef(attachScope)
  useEffect(() => {
    if (lastScopeRef.current !== attachScope) {
      lastScopeRef.current = attachScope
      if (pendingAttachments.length > 0) clearPendingAttachments()
    }
  }, [attachScope, pendingAttachments.length, clearPendingAttachments])

  // Drag-drop wiring. `dragOverDepth` is a counter (not a boolean) because
  // dragenter/dragleave fire on every child during a drag — we'd flicker
  // off the moment the pointer crosses an inner element. Counting nested
  // enters keeps the overlay stable until the user truly leaves.
  const [dragOverDepth, setDragOverDepth] = useState(0)
  const isDraggingOver = dragOverDepth > 0
  const canAcceptDrop = canShowAttachButton && !isStreaming
  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!canAcceptDrop) return
      // Only react to file drags — `Files` is in the types list when the OS
      // is dragging real files, vs. text/HTML selections from inside the app.
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragOverDepth((d) => d + 1)
    },
    [canAcceptDrop]
  )
  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!canAcceptDrop) return
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      // Hint at the action — "+" icon on the cursor — so the user knows
      // the drop will attach, not navigate.
      e.dataTransfer.dropEffect = 'copy'
    },
    [canAcceptDrop]
  )
  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!canAcceptDrop) return
      if (!e.dataTransfer.types.includes('Files')) return
      setDragOverDepth((d) => Math.max(0, d - 1))
    },
    [canAcceptDrop]
  )
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!canAcceptDrop) return
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragOverDepth(0)
      const dropped = Array.from(e.dataTransfer.files ?? [])
      if (dropped.length === 0) return
      // Renderer can't read file paths off `File` objects directly under
      // contextIsolation + sandbox — webUtils.getPathForFile is the
      // sanctioned bridge. Filter empty results so a folder drop (which
      // returns '') doesn't reach the main process.
      const paths = dropped
        .map((f) => window.api.files.getPathForFile(f))
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
      if (paths.length === 0) {
        setAttachError('Folders and unresolved files cannot be attached')
        return
      }
      void pickAttachmentsFromPaths(paths)
    },
    [canAcceptDrop, pickAttachmentsFromPaths, setAttachError]
  )

  /** Agent whose example_prompts `#` should surface. Bound agent wins in an active chat, else the selected agent on the new-chat screen. */
  const promptSourceAgent = boundAgent ?? selectedAgent ?? null
  const examplePrompts = useMemo(
    () => extractExamplePrompts(promptSourceAgent),
    [promptSourceAgent]
  )

  // CLI commands (`cinna.run.*`) fetched on demand from the prompt-source
  // agent's card. Same gating rule as '#'.
  const { data: cliCommands } = useCliCommands(promptSourceAgent?.id)
  const commands = useMemo(() => cliCommands ?? [], [cliCommands])

  const filteredAgents = useMemo(
    () =>
      enabledAgents.filter(
        (a) =>
          a.name.toLowerCase().includes(triggerFilter.toLowerCase()) ||
          a.protocol.toLowerCase().includes(triggerFilter.toLowerCase())
      ),
    [enabledAgents, triggerFilter]
  )

  // MCP @-mention candidates: all settings-enabled MCPs, filtered by the
  // typed token. Available in both active chats (DB-backed engagement) and
  // the new-chat screen (buffered in `pendingMcpIds` until creation flushes
  // it onto the chat row).
  const inMcpMentionContext = !!chatId || onTogglePendingMcp !== undefined
  const filteredMcps = useMemo(() => {
    if (!inMcpMentionContext) return []
    const q = triggerFilter.toLowerCase()
    return enabledMcps.filter(
      (m) => m.name.toLowerCase().includes(q) || m.transportType.toLowerCase().includes(q)
    )
  }, [enabledMcps, triggerFilter, inMcpMentionContext])

  const filteredPrompts = useMemo(() => {
    const q = triggerFilter.toLowerCase()
    return examplePrompts.filter(
      (p) => p.label.toLowerCase().includes(q) || p.full.toLowerCase().includes(q)
    )
  }, [examplePrompts, triggerFilter])

  const filteredCommands = useMemo(() => {
    const q = triggerFilter.toLowerCase()
    return commands.filter(
      (c) => c.slug.toLowerCase().includes(q) || c.command.toLowerCase().includes(q)
    )
  }, [commands, triggerFilter])

  // Notes available for `?` attachment. Profile-scoped via `useNoteList`;
  // filter by title only — the user explicitly asked to search titles, and
  // matching body text would make typing a common word balloon the list.
  const { data: notes } = useNoteList()
  const filteredNotes = useMemo(() => {
    const all = notes ?? []
    const q = triggerFilter.toLowerCase()
    if (!q) return all
    return all.filter((n) => n.title.toLowerCase().includes(q))
  }, [notes, triggerFilter])

  // `@` is available on new-chat (agent picker + MCP buffer) AND inside an
  // active chat (in-chat agent mention + DB-backed MCP attach). The popup
  // surfaces both an "Agents" and an "MCP" section in either context — the
  // distinction is just where selections are routed.
  const newChatHasContent = !chatId && (
    (!!onSelectAgent && enabledAgents.length > 0) ||
    (!!onTogglePendingMcp && enabledMcps.length > 0)
  )
  const activeChatHasContent = !!chatId && (enabledAgents.length > 0 || enabledMcps.length > 0)
  const agentPopupOpen =
    triggerChar === '@' && (newChatHasContent || activeChatHasContent)
  const promptPopupOpen = triggerChar === '#' && examplePrompts.length > 0
  const commandPopupOpen = triggerChar === '/' && commands.length > 0
  const notePopupOpen = triggerChar === '?' && (notes ?? []).length > 0

  const closeTrigger = useCallback(() => {
    setTriggerChar(null)
    setTriggerFilter('')
    setTriggerIndex(0)
  }, [])

  const replaceTriggerToken = useCallback(
    (replacement: string): void => {
      const before = input.slice(0, triggerStart)
      const afterCursor = input.slice(triggerStart + 1 + triggerFilter.length)
      setInput(before + replacement + afterCursor)
      closeTrigger()
      setTimeout(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.style.height = 'auto'
        el.style.height = Math.min(el.scrollHeight, 180) + 'px'
      }, 0)
    },
    [input, triggerStart, triggerFilter, closeTrigger]
  )

  const selectAgent = useCallback(
    (agent: AgentData) => {
      if (chatId) {
        // In-chat mention: selecting from the popup is the *switch* action.
        // Drop the `@token` from the composer and flip the chat's active
        // agent. The chip below the input updates via the composer hook's
        // reactive subscription. The next Enter routes via the same hook —
        // there's no separate "active agent" state to keep in sync.
        replaceTriggerToken('')
        void composer.switchActiveAgent(agent.id)
        return
      }
      // New-chat agent picker: drop the @token; agent binding happens via callback.
      replaceTriggerToken('')
      onSelectAgent?.(agent)
    },
    [replaceTriggerToken, onSelectAgent, chatId, composer]
  )

  /**
   * MCP `@-mention` selection. Routes two ways depending on context:
   *  - Active chat: persists immediately via `chat:on-demand-mcp-add`. The
   *    stream loop unions it with the chat-mode baseline on the next send
   *    and silently prepends a "user just enabled MCP X" announcement.
   *  - New chat: stashes the id in the parent's `pendingMcpIds` buffer.
   *    `useNewChatFlow.startNewChat` flushes the buffer onto the freshly
   *    created chat row before the first send.
   */
  const selectMcp = useCallback(
    (mcp: { id: string }) => {
      replaceTriggerToken('')
      if (chatId) {
        void addOnDemandMcp.mutateAsync({ chatId, mcpProviderId: mcp.id })
        return
      }
      onTogglePendingMcp?.(mcp.id)
    },
    [replaceTriggerToken, addOnDemandMcp, chatId, onTogglePendingMcp]
  )

  const selectAgentOrMcp = useCallback(
    (item: AgentMcpItem) => {
      if (item.kind === 'agent') selectAgent(item.agent)
      else selectMcp(item.mcp)
    },
    [selectAgent, selectMcp]
  )

  const selectPrompt = useCallback(
    (prompt: ExamplePrompt) => {
      replaceTriggerToken(prompt.full)
    },
    [replaceTriggerToken]
  )

  const selectCommand = useCallback(
    (command: CliCommand) => {
      replaceTriggerToken(command.command)
    },
    [replaceTriggerToken]
  )

  const selectNote = useCallback(
    (note: NoteData) => {
      // Drop the `?token` from the textarea — the badge stands in for it.
      replaceTriggerToken('')
      addPendingNote({ id: note.id, title: note.title || 'Untitled note' })
    },
    [replaceTriggerToken, addPendingNote]
  )

  // Menu actions. Today the menu has one entry ("Add files"); the array is
  // here so future additions (clipboard import, drag-zone toggle, browse
  // workspace, …) only need to push a new item.
  const attachMenuItems = useMemo<AttachMenuItem[]>(
    () => [
      {
        id: 'add-files',
        label: 'Add files',
        icon: Paperclip,
        onSelect: () => void pickAttachments()
      }
    ],
    [pickAttachments]
  )

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    // Allow attachment-only sends (no text) so users can drop a file in and
    // hit send with a quick "look at this" — only for active chats where the
    // composer handles attachments; new chats still require text for title.
    const hasContent =
      trimmed.length > 0 ||
      (chatId !== null && (pendingAttachments.length > 0 || pendingNotes.length > 0))
    if (!hasContent || isStreaming) return
    const attachmentsToSend =
      targetSupportsAttachments && pendingAttachments.length > 0
        ? [...pendingAttachments]
        : undefined

    // New chat path — attachments are held as `pending` on the renderer
    // until the chat row exists. `useNewChatFlow.startNewChat` ingests
    // them post-creation under the right scope (Cinna for remote agents,
    // local for raw LLM destinations), so there's no scope mismatch to
    // refuse here. Notes ride the same deferral — startNewChat will
    // materialize each into a `.md` attachment once the scope is known.
    if (!chatId) {
      const noteIds = pendingNotes.map((n) => n.id)
      clearComposer()
      clearPendingNotes()
      onNewChat?.(trimmed, attachmentsToSend, noteIds.length > 0 ? noteIds : undefined)
      return
    }

    // Second Enter while confirming a rewrite — fire the (possibly edited)
    // rewritten text via the composer.
    const confirm = rewriteUX.beginConfirmDispatch()
    if (confirm) {
      await composer.confirmRewrite(confirm.text, confirm.pending)
      clearPendingAttachments()
      clearPendingNotes()
      return
    }

    // Convert any pending notes into real .md attachments via the IPC
    // ingest path so they ride the same code-path as user-attached files
    // for the rest of the send. Scope mirrors the file pipeline: Cinna
    // when the destination is a remote agent (or unknown), local for raw
    // LLM chats.
    let noteAttachments: MessageAttachment[] = []
    if (pendingNotes.length > 0) {
      try {
        noteAttachments = await attachNotesAsync({
          chatId,
          scope: attachScope,
          noteIds: pendingNotes.map((n) => n.id)
        })
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : String(err))
        return
      }
    }

    // Hand off to the composer hook, which decides everything from a fresh
    // cache snapshot: parse mentions, resolve target, build catch-up,
    // optionally rewrite, dispatch on the right channel. The active-chat
    // composer only ever holds already-ingested attachments — `pending`
    // is gated to the new-chat path by `useChatAttachments` — so the
    // type narrow below is safe.
    rewriteUX.beginRewriting()
    const persistedAttachments = attachmentsToSend?.filter(
      (a): a is MessageAttachment => a.source !== 'pending'
    )
    const mergedAttachments =
      noteAttachments.length > 0
        ? [...(persistedAttachments ?? []), ...noteAttachments]
        : persistedAttachments
    const result = await composer.submit(trimmed, mergedAttachments)
    rewriteUX.handleSubmitResult(result)
    if (result.kind === 'sent' || result.kind === 'rewrite-pending') {
      // Sent: drop the attachments now that they live on the message row.
      // Rewrite-pending: pending.attachments owns them; clear the composer's
      // copy so a second send (after rewrite confirmation) doesn't double-attach.
      clearPendingAttachments()
      clearPendingNotes()
    }
  }, [
    input,
    isStreaming,
    chatId,
    onNewChat,
    composer,
    rewriteUX,
    pendingNotes,
    attachScope,
    attachNotesAsync,
    setAttachError,
    clearComposer,
    targetSupportsAttachments,
    pendingAttachments,
    clearPendingAttachments,
    clearPendingNotes
  ])

  const handleCancel = useCallback(() => {
    if (activeRequestId) cancelStream(activeRequestId)
  }, [activeRequestId, cancelStream])

  // The @ popup is the combined agent+MCP picker whenever we're in an MCP
  // mention context (active chat OR new-chat with the buffer wired up), so
  // the length used for keyboard nav is the sum across both sections.
  const useCombinedPopup = inMcpMentionContext
  const agentPopupItemCount = useCombinedPopup
    ? filteredAgents.length + filteredMcps.length
    : filteredAgents.length
  const activeListLength = agentPopupOpen
    ? agentPopupItemCount
    : promptPopupOpen
      ? filteredPrompts.length
      : commandPopupOpen
        ? filteredCommands.length
        : notePopupOpen
          ? filteredNotes.length
          : 0

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Tilde-shortcut popup is in progress (open AND textarea still holds the
    // lone "~"): route arrow/enter/tab/esc into the mode popup, identical to
    // the @ / # / / popups.
    if (tildeActive && tildeModePopup) {
      const count = tildeModePopup.modes.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (count > 0) setTildeIndex((i) => (i + 1) % count)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (count > 0) setTildeIndex((i) => (i - 1 + count) % count)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const mode = tildeModePopup.modes[tildeIndex]
        if (mode) tildeModePopup.onSelect(mode)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        tildeModePopup.onCancel()
        return
      }
    }

    if (triggerChar && activeListLength > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setTriggerIndex((prev) => (prev + 1) % activeListLength)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setTriggerIndex((prev) => (prev - 1 + activeListLength) % activeListLength)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (agentPopupOpen) {
          // The combined picker flattens agents then MCPs (matching the
          // render order in `AgentMcpMentionPopup`); single-section popup
          // is agents-only.
          if (useCombinedPopup) {
            if (triggerIndex < filteredAgents.length) {
              selectAgent(filteredAgents[triggerIndex])
            } else {
              const mcp = filteredMcps[triggerIndex - filteredAgents.length]
              if (mcp) selectMcp(mcp)
            }
          } else {
            selectAgent(filteredAgents[triggerIndex])
          }
        } else if (promptPopupOpen) selectPrompt(filteredPrompts[triggerIndex])
        else if (commandPopupOpen) selectCommand(filteredCommands[triggerIndex])
        else if (notePopupOpen) selectNote(filteredNotes[triggerIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeTrigger()
        lastEscapeAt.current = 0
        return
      }
    }

    // Esc during rewrite confirmation: revert to the user's original text.
    if (e.key === 'Escape' && rewriteUX.handleEscape()) {
      e.preventDefault()
      return
    }

    if (e.key === 'Escape' && onDoubleEscape) {
      e.preventDefault()
      const now = Date.now()
      if (now - lastEscapeAt.current <= DOUBLE_ESC_WINDOW_MS) {
        lastEscapeAt.current = 0
        onDoubleEscape()
      } else {
        lastEscapeAt.current = now
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // Block Enter while a rewrite call is in flight to prevent double-send.
      if (rewriteUX.state === 'rewriting') {
        e.preventDefault()
        return
      }
      e.preventDefault()
      void handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    const prevValue = input
    setInput(value)

    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'

    // Clearing the composer mid-confirm abandons the pending rewrite (so the
    // next typed message starts fresh and re-triggers a rewrite if applicable).
    rewriteUX.handleComposerCleared(value)

    // `~` shortcut — opens the mode popup only when it's the first and only
    // character typed. Continuing to type closes the popup and leaves the `~`
    // in place (the user meant to type it).
    if (tildeModePopup) {
      if (prevValue === '' && value === '~') {
        tildeModePopup.onOpenRequest()
      } else if (tildeOpen && prevValue === '~' && value !== '~') {
        tildeModePopup.onCancel()
      }
    }

    const cursorPos = el.selectionStart
    const token = findTriggerToken(value, cursorPos)

    if (!token) {
      if (triggerChar) closeTrigger()
      return
    }

    // Gate each trigger by context.
    // `@` opens the combined agent + MCP picker in both new-chat (agent picker
    // routes via `onSelectAgent`, MCP picks buffer in `pendingMcpIds`) and
    // active chats (in-chat agent mention + DB-backed MCP attach).
    const agentGate = token.char === '@' && (newChatHasContent || activeChatHasContent)
    const promptGate = token.char === '#' && examplePrompts.length > 0
    const commandGate = token.char === '/' && commands.length > 0
    const noteGate = token.char === '?' && (notes ?? []).length > 0
    if (!agentGate && !promptGate && !commandGate && !noteGate) {
      if (triggerChar) closeTrigger()
      return
    }

    setTriggerChar(token.char)
    setTriggerFilter(token.filter)
    setTriggerStart(token.start)
    setTriggerIndex(0)
  }

  const handleSendAnyway = useCallback((): void => {
    const pending = rewriteUX.consumePendingForSendAnyway()
    if (pending) {
      void composer.sendRaw(pending)
      // pending.attachments already carries the materialized notes — drop
      // the composer's badges so the next send doesn't re-ingest them.
      clearPendingAttachments()
      clearPendingNotes()
    }
  }, [composer, rewriteUX, clearPendingAttachments, clearPendingNotes])

  const handleDisableRewrite = useCallback((): void => {
    rewriteUX.dismissError()
    void composer.disableSmartAssist()
  }, [composer, rewriteUX])

  return (
    <div className="w-full max-w-3xl mx-auto px-4 relative">
      {agentPopupOpen &&
        (useCombinedPopup ? (
          <AgentMcpMentionPopup
            agents={filteredAgents}
            mcps={filteredMcps}
            selectedIndex={triggerIndex}
            onSelect={selectAgentOrMcp}
            onClose={closeTrigger}
            listboxId={listboxId}
            anchorRef={textareaRef}
          />
        ) : (
          <AgentMentionPopup
            items={filteredAgents}
            selectedIndex={triggerIndex}
            onSelect={selectAgent}
            onClose={closeTrigger}
            listboxId={listboxId}
            anchorRef={textareaRef}
          />
        ))}

      {promptPopupOpen && (
        <ExamplePromptPopup
          items={filteredPrompts}
          selectedIndex={triggerIndex}
          onSelect={selectPrompt}
          onClose={closeTrigger}
          listboxId={listboxId}
          anchorRef={textareaRef}
        />
      )}

      {commandPopupOpen && (
        <CliCommandPopup
          items={filteredCommands}
          selectedIndex={triggerIndex}
          onSelect={selectCommand}
          onClose={closeTrigger}
          listboxId={listboxId}
          anchorRef={textareaRef}
        />
      )}

      {notePopupOpen && (
        <NoteMentionPopup
          items={filteredNotes}
          selectedIndex={triggerIndex}
          onSelect={selectNote}
          onClose={closeTrigger}
          listboxId={listboxId}
          anchorRef={textareaRef}
        />
      )}

      {tildeActive && tildeModePopup && (
        <MentionPopup<ChatModeData>
          items={tildeModePopup.modes}
          selectedIndex={tildeIndex}
          onSelect={tildeModePopup.onSelect}
          onClose={tildeModePopup.onCancel}
          listboxId={`${listboxId}-tilde-modes`}
          anchorRef={textareaRef}
          header="Chat Modes"
          ariaLabel="Chat modes"
          width="w-72"
          renderIcon={tildeModePopup.renderIcon}
          getKey={(m) => m.id}
          getPrimary={(m) => m.name}
          getSecondary={tildeModePopup.composeSecondary}
        />
      )}

      <RewriteHintBar state={rewriteUX.state} />

      <div
        className="relative rounded-2xl bg-[var(--color-bg-input)] border overflow-hidden transition-colors duration-200"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          borderColor: isDraggingOver
            ? 'var(--color-accent)'
            : modeColor
              ? modeColor.border
              : 'var(--color-border)',
          backgroundColor: modeColor ? modeColor.bg : undefined
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={agentPopupOpen || promptPopupOpen || commandPopupOpen || notePopupOpen}
          aria-controls={
            agentPopupOpen || promptPopupOpen || commandPopupOpen || notePopupOpen
              ? listboxId
              : undefined
          }
          aria-activedescendant={
            (agentPopupOpen && agentPopupItemCount > 0) ||
            (promptPopupOpen && filteredPrompts.length > 0) ||
            (commandPopupOpen && filteredCommands.length > 0) ||
            (notePopupOpen && filteredNotes.length > 0)
              ? `${listboxId}-opt-${triggerIndex}`
              : undefined
          }
          className="w-full bg-transparent text-[var(--color-text)] placeholder-[var(--color-text-muted)]
            px-4 pt-3 pb-3 resize-none text-sm leading-relaxed focus:outline-none"
        />
        {(pendingAttachments.length > 0 || pendingNotes.length > 0) && (
          <div className="px-3 pb-2 pt-1 flex flex-wrap gap-1 justify-end">
            <AttachmentList
              attachments={pendingAttachments}
              variant="input"
              onRemove={(id) => {
                const att = pendingAttachments.find((a) => a.id === id)
                if (att) handleRemoveAttachment(att)
              }}
              align="right"
            />
            <NoteBadgeList
              notes={pendingNotes}
              onRemove={removePendingNote}
              onPreview={setPreviewNoteId}
              align="right"
            />
          </div>
        )}
        {isDraggingOver && (
          // Pointer-events off so the overlay never eats the underlying
          // drop event — the container's own handler does the work.
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center
              rounded-2xl bg-[var(--color-accent)]/10 border-2 border-dashed
              border-[var(--color-accent)] text-[var(--color-accent)] text-xs font-medium"
          >
            Drop to attach
          </div>
        )}
      </div>

      {attachError && (
        <div className="mt-1 text-[11px] text-[var(--color-danger)] text-right px-1">
          {attachError}
        </div>
      )}

      {rewriteUX.error && rewriteUX.pending && (
        <RewriteFailureModal
          error={rewriteUX.error}
          pending={rewriteUX.pending}
          onCancel={rewriteUX.dismissError}
          onDisable={handleDisableRewrite}
          onSendAnyway={handleSendAnyway}
        />
      )}

      {previewNote && (
        <NotePreviewModal
          noteId={previewNote.id}
          fallbackTitle={previewNote.title}
          onClose={() => setPreviewNoteId(null)}
        />
      )}

      <div className="flex items-center justify-between px-1 pt-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {leftSlot}
          {chatId && composer.activeAgent ? (
            <ActiveAgentChip
              activeAgent={composer.activeAgent}
              rootAgent={composer.rootAgent}
              rootLabel={composer.rootLabel}
              onSwitchBack={(target) => void composer.switchActiveAgent(target)}
            />
          ) : chatId && boundAgent ? (
            <div
              className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg border
                text-[var(--color-accent)] border-[var(--color-accent)] bg-[var(--color-accent)]/10"
            >
              <Bot size={14} className="shrink-0" />
              <span className="text-[11px] font-medium whitespace-nowrap">
                {boundAgent.name}
              </span>
            </div>
          ) : chatId && !leftSlot ? (
            <ChatControls chatId={chatId} inline />
          ) : null}
          {chatId ? (
            <OnDemandMcpChips chatId={chatId} />
          ) : pendingMcpIds && onRemovePendingMcp ? (
            <OnDemandMcpChips
              pendingIds={pendingMcpIds}
              onRemovePending={onRemovePendingMcp}
            />
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {canShowAttachButton && !isStreaming && (
            <div className="relative">
              <button
                ref={attachButtonRef}
                type="button"
                onClick={() => setAttachMenuOpen((v) => !v)}
                disabled={isUploading}
                title={isUploading ? 'Uploading…' : 'Attach'}
                aria-label="Attach"
                aria-haspopup="menu"
                aria-expanded={attachMenuOpen}
                className="p-1.5 rounded-lg border border-[var(--color-border)]
                  text-[var(--color-text-secondary)] hover:text-[var(--color-text)]
                  hover:bg-[var(--color-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed
                  transition-colors"
              >
                {isUploading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Plus size={16} />
                )}
              </button>
              {attachMenuOpen && (
                <AttachMenuPopup
                  items={attachMenuItems}
                  onClose={() => setAttachMenuOpen(false)}
                  anchorRef={attachButtonRef}
                />
              )}
            </div>
          )}
          {isStreaming ? (
            <button
              onClick={handleCancel}
              className="p-1.5 rounded-lg bg-[var(--color-danger)] hover:opacity-80 text-white transition-opacity"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={
                !input.trim() &&
                !(
                  chatId !== null &&
                  ((targetSupportsAttachments && pendingAttachments.length > 0) ||
                    pendingNotes.length > 0)
                )
              }
              className="p-1.5 rounded-lg bg-[var(--color-success)] hover:opacity-80 text-white
                disabled:opacity-20 disabled:cursor-not-allowed transition-opacity"
            >
              <SendHorizontal size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})
