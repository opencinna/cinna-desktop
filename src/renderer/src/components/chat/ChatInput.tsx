import { PendingHandoffControl } from '../tasks/PendingHandoffControl'
import { AmbientGrid } from '../ui/AmbientGrid'
import { AutonomousTaskDialog } from '../tasks/AutonomousTaskDialog'
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useImperativeHandle, useId, forwardRef } from 'react'
import { SendHorizontal, Square, Bot, Check } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { RunQueueView } from '../../../../shared/ipcPayloads'
import { useChatDetail, useSetChatRouter } from '../../hooks/useChat'
import { useModels } from '../../hooks/useModels'
import { useChatStream } from '../../hooks/useChatStream'
import { useChatStore } from '../../stores/chat.store'
import { useAuthStore } from '../../stores/auth.store'
import { useHintsStore } from '../../stores/hints.store'
import { ChatControls } from './ChatControls'
import { AgentMentionPopup } from './AgentMentionPopup'
import { AgentMcpMentionPopup, type AgentMcpItem } from './AgentMcpMentionPopup'
import { ExamplePromptPopup } from './ExamplePromptPopup'
import { CliCommandPopup } from './CliCommandPopup'
import { NoteMentionPopup } from './NoteMentionPopup'
import { useAgents, useAttachAgentToChat, useChatOnDemandAgents } from '../../hooks/useAgents'
import { useHasAttachDestination } from '../../hooks/useAttachDestination'
import { useCliCommands, type CliCommand } from '../../hooks/useCliCommands'
import { useMcpProviders, useAddOnDemandMcp, useChatMcpProviders } from '../../hooks/useMcp'
import { useCapabilityPicker } from '../../hooks/useCapabilityPicker'
import { useCatalogPicker } from '../../hooks/useCatalogPicker'
import { useChatAttachments } from '../../hooks/useChatAttachments'
import { useModelCapability } from '../../hooks/useModelCapability'
import { useNoteList, useAttachNotesAsFiles, useFetchNote } from '../../hooks/useNotes'
import { useChatNotes } from '../../hooks/useChatNotes'
import { extractExamplePrompts, type ExamplePrompt } from '../../utils/examplePrompts'
import type { ColorPreset, ChatModeData } from '../../constants/chatModeColors'
import { MentionPopup } from './MentionPopup'
import { useChatComposer } from '../../hooks/useChatComposer'
import { ActiveMcpChips } from './ActiveMcpChips'
import { OnDemandAgentChips } from './OnDemandAgentChips'
import { RouterBadge, type RouterBadgeInfo } from './RouterBadge'
import { routingOf } from '../../../../shared/chatRouting'
import { unwrapIpcError } from '../../utils/ipcError'
import { AttachmentList } from './AttachmentBadge'
import { NoteBadgeList } from './NoteBadge'
import { ComposerPlusMenu, type PlusModeMenu } from './ComposerPlusMenu'
import { AgentPickerModal } from '../agents/AgentPickerModal'
import { NotePreviewModal } from '../notes/NotePreviewModal'
import { ComposerReadinessWarning, useComposerReadiness } from './ComposerReadiness'
import type { ComposerAttachment, MessageAttachment } from '../../../../shared/attachments'
import type { NoteData } from '../../../../shared/notes'
import { useComposerDraftField, useComposerDraftKey } from '../../hooks/useComposerDraft'
import { useComposerDraftStore } from '../../stores/composerDraft.store'
import { useRunQueue } from '../../hooks/useRunQueue'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]
type TriggerChar = '@' | '#' | '/' | '?'

interface ChatInputProps {
  chatId: string | null
  /** Stable, profile-scoped identity for an entry-page composer. */
  draftKey?: string
  onNewChat?: (
    message: string,
    attachments?: ComposerAttachment[],
    noteIds?: string[]
  ) => void | boolean | Promise<void | boolean>
  /**
   * Chat-mode sub-menu for the `[+]` button. Omitted when mode selection
   * doesn't apply (e.g. an active chat that wasn't created with a mode).
   */
  chatModeMenu?: PlusModeMenu
  modeColor?: ColorPreset | null
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
  /**
   * New-chat screen only: the selected chat mode's MCP list. These become the
   * chat's baseline on send, so they're surfaced now — locked — alongside the
   * user's own picks, and count as selected in the `[+]` picker. Active chats
   * read the equivalent set from `chat_mcp_providers` instead.
   */
  baselineMcpIds?: string[]
  /**
   * New-chat agent engagement buffer — symmetric to `pendingMcpIds`. The `@`
   * popup routes *every* agent pick here. The buffer is flushed onto
   * `chat_on_demand_agents` (or bound as the chat's root when it's the sole
   * selection with no MCPs) inside `startNewChat`.
   */
  pendingAgentIds?: string[]
  onTogglePendingAgent?: (agentId: string) => void
  onRemovePendingAgent?: (agentId: string) => void
  /**
   * Who would answer, for the **new-chat** composer — the router the current
   * selection resolves to. Rendered at the right end of the controls row, left
   * of Send. Absent ⇒ no badge (nothing selected yet). An active chat needs no
   * prop: the composer reads its router off the chat row itself.
   */
  routerInfo?: RouterBadgeInfo
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
// Stop takes the place of the Send that was just clicked; a click this soon
// after is the second half of a double-click, not a request to stop.
const STOP_CLICK_GRACE_MS = 500

/**
 * Shown when main sent a queued message being edited before the edit was saved.
 * Not for a cancel from its bubble or a stop: the user did those themselves.
 */
export const QUEUED_EDIT_TOO_LATE = 'Sent before your edit was saved — your edit is still here.'

/**
 * A message recalled into the composer with ArrowUp/ArrowDown: the chat it was
 * recalled in, which history entry, its text as recalled (cycling continues
 * only while the input still holds exactly that), and the queue id when it is
 * a queued message being edited.
 */
interface Recall {
  chatId: string
  index: number
  text: string
  queuedId?: string
}

/**
 * Whether the caret is on the input's first line (ArrowUp, -1) or its last
 * (ArrowDown, 1), by line breaks. Anywhere else the arrow moves the caret.
 */
function caretOnEdgeLine(el: HTMLTextAreaElement, direction: -1 | 1): boolean {
  return direction < 0
    ? !el.value.slice(0, el.selectionStart).includes('\n')
    : !el.value.slice(el.selectionEnd).includes('\n')
}

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
    draftKey: suppliedDraftKey,
    onNewChat,
    chatModeMenu,
    modeColor,
    selectedAgent,
    pendingMcpIds,
    onTogglePendingMcp,
    onRemovePendingMcp,
    baselineMcpIds,
    pendingAgentIds,
    onTogglePendingAgent,
    onRemovePendingAgent,
    routerInfo,
    onDoubleEscape,
    tildeModePopup
  },
  ref
) {
  const defaultDraftKey = useComposerDraftKey(chatId)
  const draftKey = suppliedDraftKey ?? defaultDraftKey
  const [input, setInput] = useComposerDraftField(draftKey, 'text')
  const [sending] = useComposerDraftField(draftKey, 'sending')
  const [autonomousGoal, setAutonomousGoal] = useState<string | null>(null)
  // Component state on purpose: navigating away drops edit mode and leaves the
  // text as an ordinary draft.
  const [recall, setRecall] = useState<Recall | null>(null)
  // Read against this chat only: on the first render after a chat switch the
  // state still holds the last chat's recall, until the reset effect below.
  const activeRecall = recall && recall.chatId === chatId ? recall : null
  const activeRecallRef = useRef(activeRecall)
  activeRecallRef.current = activeRecall
  const [capabilityPickerOpen, setCapabilityPickerOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastEscapeAt = useRef(0)
  // Synchronous re-entrancy guard for the active-chat send. `isStreaming` only
  // flips true once the stream's `request-id` arrives, so it can't block a
  // second Enter fired during the `attachNotesAsync` await — this ref does.
  const { data: chatData } = useChatDetail(chatId)
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  // Hint bar telemetry. Every call is "the user just did X" — the store decides
  // whether that retires a hint, fires a contextual one, or neither. Emitting
  // from active chats too is intentional: the gestures are the same, so using
  // one in a live chat still retires the tip shown on the dashboard.
  const observeHint = useHintsStore((s) => s.observe)
  const setHintsBusy = useHintsStore((s) => s.setBusy)
  // Used only to gate the new-chat attach button: showing `[+]` for a
  // user with no Cinna account *and* no configured LLM provider would
  // lead them to attach files they have nowhere to send. Shared with the
  // hint bar so it can't advertise drag-drop while this button is hidden.
  const hasAnyDestination = useHasAttachDestination()
  const listboxId = useId()

  // Who answers in this chat, and who answers *next* — the one routing read the
  // composer makes, from the shared helper main's send path uses. Everything
  // downstream (the upload scope, the readiness refusal, the badge, the chips)
  // reads this rather than asking about `agentId` and `orchestrated` again.
  const chatRouting = useMemo(() => routingOf(chatData ?? {}), [chatData])
  const { data: onDemandAgentRows } = useChatOnDemandAgents(chatId)
  const attachedAgentIds = useMemo(
    () => (onDemandAgentRows ?? []).map((row) => row.agentId),
    [onDemandAgentRows]
  )
  // The sticky default: whoever the last user message was addressed to. Read
  // from the transcript, which is what main reads too.
  const lastAddressedAgentId = useMemo(() => {
    for (let i = (chatData?.messages ?? []).length - 1; i >= 0; i--) {
      const message = chatData!.messages[i]
      if (message.role === 'user' && message.addressedAgentId) return message.addressedAgentId
    }
    return null
  }, [chatData])
  const addressedAgentId = useChatStore((state) =>
    chatId ? state.addressedAgentByChat[chatId] : undefined
  )
  const setAddressedAgent = useChatStore((state) => state.setAddressedAgent)
  const setSendError = useChatStore((state) => state.setSendError)
  // Drops the too-late notice, and only that one, once the text it speaks of is
  // sent or cleared.
  const clearEditTooLate = useCallback(() => {
    if (useChatStore.getState().sendError === QUEUED_EDIT_TOO_LATE) setSendError(null)
  }, [setSendError])
  const queryClient = useQueryClient()
  const { data: models } = useModels()
  const answerTarget = useMemo(
    () =>
      chatRouting.answerer({
        addressed: addressedAgentId,
        lastAddressed: lastAddressedAgentId,
        attached: attachedAgentIds
      }),
    [chatRouting, addressedAgentId, lastAddressedAgentId, attachedAgentIds]
  )

  // Model capability drives both gating (show/hide the [+]) and scope
  // selection for the local-vs-cinna upload split below. Read off the chat
  // detail so a model swap mid-chat re-evaluates immediately.
  const modelCapability = useModelCapability(
    chatData?.providerId ?? null,
    chatData?.modelId ?? null
  )
  const modelSupportsMedia = modelCapability.acceptedMimeTypes.length > 0

  // Files belong to this draft. Uploads completing after navigation still
  // populate their originating composer, never the newly visible one.
  //
  // The scope: a message an agent answers uploads to the Cinna backend, one the
  // local model answers uses the local store. Asked of the chat's router rather
  // than re-derived here — see `src/shared/chatRouting.ts`. Whether an attach
  // button is offered at all is a separate question, asked of the target
  // agent's `capabilities.attachments` further down.
  const attachScope: 'cinna' | 'local' = chatId ? chatRouting.attachmentTarget : 'cinna'
  const {
    attachments: pendingAttachments,
    isUploading,
    error: attachError,
    pick: pickAttachments,
    pickFromPaths: pickAttachmentsFromPaths,
    remove: handleRemoveAttachment,
    setError: setAttachError
  } = useChatAttachments(chatId, attachScope, draftKey)
  // The send. Who answers is main's decision, from `chats.router`; the composer
  // only says which agent the user addressed.
  const composer = useChatComposer(chatId)

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

  // Single source for "return focus to the composer". Used by the imperative
  // handle and by every attach path (menu pick + drag-drop) so focus restoration
  // stays consistent across call sites instead of duplicating inline closures.
  const focusComposer = useCallback(() => textareaRef.current?.focus(), [])

  useImperativeHandle(ref, () => ({
    focus: focusComposer,
    clearInput: () => {
      setInput('')
      const el = textareaRef.current
      if (el) el.style.height = 'auto'
    }
  }))

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.scrollTop = el.scrollHeight
  }, [draftKey])
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [input, draftKey])
  const { cancel: cancelStream } = useChatStream()
  const { isStreaming: hasPortStream, activeRequestId, activeChatId: storeChatId, streamingBlocks } = useChatStore()
  const isStreaming = hasPortStream || !!chatData?.activeRunId

  // A turn that ended without finishing (stopped, failed) leaves what was
  // queued behind it held rather than sending it into a conversation that just
  // stopped. It comes back here, after anything typed since, for the user to
  // send or drop.
  const { data: runQueue } = useRunQueue(chatId)
  const heldQueueCount = runQueue?.held ? runQueue.items?.length ?? 0 : 0
  const restoringQueueRef = useRef(false)
  // The queued message being edited when it left the queue and ended edit mode,
  // kept while the composer still holds that edit: sending it or emptying the
  // input forgets it. `gone` once the composer's queue has shown it missing.
  const vanishedEditRef = useRef<{ chatId: string; id: string; gone: boolean } | null>(null)
  const draftKeyRef = useRef(draftKey)
  draftKeyRef.current = draftKey
  useEffect(() => {
    if (!chatId || !heldQueueCount || restoringQueueRef.current) return
    restoringQueueRef.current = true
    const key = draftKey
    // A queued message being edited is held with the rest. Edit mode ends now,
    // before the take empties the queue and that reads as main having sent it;
    // the input holds the edit, which takes the original's place in the queue.
    const heldItems = queryClient.getQueryData<RunQueueView>(['run-queue', chatId])?.items ?? []
    const recalledId = activeRecallRef.current?.queuedId
    // A drained start main refused: the edited message left the queue, which
    // ended edit mode as though main had sent it, and is back, held, under the
    // same id. It was never sent, so the edit still takes its place.
    const vanished = vanishedEditRef.current
    vanishedEditRef.current = null
    const returnedId = !recalledId && vanished?.chatId === chatId ? vanished.id : undefined
    const editedId = recalledId ?? returnedId
    const editedIndex = editedId ? heldItems.findIndex((item) => item.id === editedId) : -1
    if (editedIndex >= 0) {
      setRecall(null)
      if (editedId === returnedId) clearEditTooLate()
    }
    void window.api.run.queueTake(chatId)
      .then((texts) => {
        if (!texts.length) return
        useComposerDraftStore.getState().update(key, (draft) => {
          const kept = draft.text.replace(/\n+$/, '')
          const index = editedIndex < 0
            ? -1
            : texts.length === heldItems.length ? editedIndex : texts.indexOf(heldItems[editedIndex].content)
          if (index >= 0) {
            // An emptied edit was never savable; the original stands.
            return { text: texts.map((text, at) => (at === index && kept.trim() ? kept : text)).join('\n\n') }
          }
          const joined = texts.join('\n\n')
          return { text: kept ? `${kept}\n\n${joined}` : joined }
        })
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (!el || draftKeyRef.current !== key) return
          el.style.height = 'auto'
          el.style.height = Math.min(el.scrollHeight, 180) + 'px'
          if (document.activeElement === document.body) el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
          el.scrollTop = el.scrollHeight
        })
      })
      .catch((error) => setSendError(unwrapIpcError(error, 'Queued messages could not be restored.')))
      .finally(() => { restoringQueueRef.current = false })
  }, [chatId, draftKey, heldQueueCount, queryClient, setSendError, clearEditTooLate])

  // Message history for ArrowUp/ArrowDown: the user's own saved messages in
  // this chat, oldest first, then those the running turn took in (saved only
  // when the turn ends), then what is queued (non-held), which is newest.
  const historyEntries = useMemo((): { text: string; queuedId?: string }[] => {
    if (!chatId) return []
    const delivered = (chatData?.messages ?? [])
      .filter((message) => message.role === 'user' && typeof message.content === 'string' && message.content.trim())
      .map((message) => ({ text: message.content }))
    const steered = storeChatId === chatId
      ? streamingBlocks.flatMap((block) => (block.type === 'user' && block.content.trim() ? [{ text: block.content }] : []))
      : []
    const queued = runQueue && !runQueue.held
      ? (runQueue.items ?? []).map((item) => ({ text: item.content, queuedId: item.id }))
      : []
    return [...delivered, ...steered, ...queued]
  }, [chatId, chatData?.messages, storeChatId, streamingBlocks, runQueue])

  // Editing a recalled queued message. The bubble shows it. If the message
  // leaves the queue first, edit mode ends and the text stays here as an
  // ordinary draft: silently when the user cancelled it from its bubble, with a
  // sentence when main sent it first (ux_rules §6). A queue held by a stop is
  // the held-take effect's, above, which folds the edit into the held texts —
  // also when the edited message comes back held after leaving, a drained start
  // main refused: that effect takes the sentence back. Back in a queue that is
  // not held, a hand-over the running turn refused, it is the effect after
  // this one's.
  const editingId = chatId ? activeRecall?.queuedId : undefined
  const setEditingQueued = useChatStore((state) => state.setEditingQueued)
  useEffect(() => {
    setEditingQueued(chatId && editingId ? { chatId, id: editingId } : null)
  }, [chatId, editingId, setEditingQueued])
  useEffect(() => () => setEditingQueued(null), [setEditingQueued])
  useEffect(() => {
    if (!editingId || !runQueue) return
    if ((runQueue.items ?? []).some((item) => item.id === editingId)) return
    setRecall(null)
    if (chatId) vanishedEditRef.current = { chatId, id: editingId, gone: true }
    if (!useChatStore.getState().cancelledQueuedIds.includes(editingId)) setSendError(QUEUED_EDIT_TOO_LATE)
  }, [chatId, editingId, runQueue, setSendError])
  // Main hands queued messages to the running turn, and puts them back, under
  // the same ids, when the turn would not take them. An edited message that
  // comes back so was never sent: while the composer still holds the edit,
  // edit mode returns on it and the sentence goes. Left an ordinary draft, the
  // edit would be sent as a message of its own, and the original with it.
  // Not while a send of that text is under way: it is no longer the edit.
  useEffect(() => {
    const vanished = vanishedEditRef.current
    if (!chatId || !vanished || vanished.chatId !== chatId || !runQueue || runQueue.held || activeRecall || sending) return
    const index = historyEntries.findIndex((entry) => entry.queuedId === vanished.id)
    if (index < 0) {
      vanished.gone = true
      return
    }
    // Still listed: the queue has not shown it leaving yet, so it has not come back.
    if (!vanished.gone || !input.trim()) return
    vanishedEditRef.current = null
    setRecall({ chatId, index, text: historyEntries[index].text, queuedId: vanished.id })
    clearEditTooLate()
  }, [chatId, runQueue, historyEntries, activeRecall, sending, input, clearEditTooLate])

  const saveQueuedEdit = useCallback(async (targetChatId: string, id: string): Promise<void> => {
    const text = input
    if (!text.trim() || !useComposerDraftStore.getState().beginSend(draftKey)) return
    try {
      if (await window.api.run.queueEdit(targetChatId, id, text)) {
        useComposerDraftStore.getState().update(draftKey, (draft) => ({ text: draft.text === text ? '' : draft.text }))
        clearEditTooLate()
        setRecall(null)
      } else {
        // Gone from main's queue, perhaps only handed to the running turn,
        // which can refuse it and put it back. Main's queue changes reach the
        // cache before this answer, and the composer's render a tick after, so
        // the cache says where it is.
        const view = queryClient.getQueryData<RunQueueView>(['run-queue', targetChatId])
        const listed = (view?.items ?? []).some((item) => item.id === id)
        if (view && !view.held && listed) {
          // Put back already, never sent: the edit stands. Edit mode stays on
          // it, or — when a render in between showed it leaving and ended edit
          // mode — returns on it as the save ends.
          if (activeRecallRef.current?.queuedId !== id) vanishedEditRef.current = { chatId: targetChatId, id, gone: true }
        } else {
          setSendError(QUEUED_EDIT_TOO_LATE)
          vanishedEditRef.current = { chatId: targetChatId, id, gone: !!view && !listed }
          setRecall(null)
        }
      }
    } catch (error) {
      setSendError(unwrapIpcError(error, 'The queued message could not be saved.'))
    } finally {
      useComposerDraftStore.getState().endSend(draftKey)
    }
  }, [input, draftKey, setSendError, clearEditTooLate, queryClient])

  /**
   * Step through the history (-1 older, +1 newer). Active only while the input
   * is empty or still holds the recalled entry unchanged; past the newest the
   * input empties. Returns whether the key was used.
   */
  const recallHistory = (direction: -1 | 1): boolean => {
    if (!chatId) return false
    const current = activeRecall && input === activeRecall.text ? activeRecall.index : input === '' ? historyEntries.length : null
    if (current === null || !historyEntries.length) return false
    const index = current + direction
    if (index < 0) return true
    if (index >= historyEntries.length) {
      if (current >= historyEntries.length) return false
      setRecall(null)
      setInput('')
      return true
    }
    const entry = historyEntries[index]
    setRecall({ chatId, index, text: entry.text, queuedId: entry.queuedId })
    setInput(entry.text)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 180) + 'px'
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return true
  }

  // Trigger popup state — shared between @ (agents/MCP), # (example prompts),
  // / (CLI commands), and ? (notes).
  const [triggerChar, setTriggerChar] = useState<TriggerChar | null>(null)
  const [triggerFilter, setTriggerFilter] = useState('')
  const [triggerStart, setTriggerStart] = useState(0)
  const [triggerIndex, setTriggerIndex] = useState(0)

  // Notes attached via the `?` mention popup stay with the draft. Body is fetched on the main side
  // at send time, so late edits to a note are reflected in the attached `.md`.
  const {
    notes: pendingNotes,
    add: addPendingNote,
    remove: removePendingNote
  } = useChatNotes(chatId, draftKey)
  const clearComposer = useCallback(() => {
    // The send may finish after switching away or editing another draft.
    // Consume only the submitted values that are still unchanged.
    useComposerDraftStore.getState().update(draftKey, (draft) => ({
      text: draft.text === input ? '' : draft.text,
      notes: draft.notes === pendingNotes ? [] : draft.notes,
      files: draft.files.attachments === pendingAttachments
        ? { ...draft.files, attachments: [], error: null }
        : draft.files
    }))
  }, [draftKey, input, pendingNotes, pendingAttachments])
  const { mutateAsync: attachNotesAsync } = useAttachNotesAsFiles()
  const fetchNote = useFetchNote()
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null)
  const previewNote = useMemo(
    () => pendingNotes.find((n) => n.id === previewNoteId) ?? null,
    [pendingNotes, previewNoteId]
  )
  // Double-Enter expansion target. Set the moment a note is picked via the
  // `?` popup; the very next Enter on an empty composer replaces the badge
  // with the note's live body (prompt-template shortcut). Any typing,
  // removing the targeted badge, or a chat switch cancels the gesture.
  const [pendingExpansionNoteId, setPendingExpansionNoteId] = useState<string | null>(
    null
  )
  // Preview is UI-only; reset whenever the chat row swaps so a modal
  // doesn't bleed into a different chat's composer. The expansion target
  // is also chat-local; navigation restores the draft without reopening popups.
  useEffect(() => {
    setPreviewNoteId(null)
    setPendingExpansionNoteId(null)
    setTriggerChar(null)
    setTriggerFilter('')
    setCapabilityPickerOpen(false)
    setAutonomousGoal(null)
    setRecall(null)
  }, [draftKey])

  // Hold the hint rotation while the composer has something open — changing the
  // tip under a user who's mid-selection competes for the attention they're
  // already spending. Cleared on unmount so a stale flag can't freeze the bar.
  const composerBusy =
    triggerChar !== null || tildeActive || capabilityPickerOpen || previewNoteId !== null
  useEffect(() => {
    setHintsBusy(composerBusy)
  }, [composerBusy, setHintsBusy])
  useEffect(() => () => setHintsBusy(false), [setHintsBusy])

  const { data: agents } = useAgents()
  const enabledAgents = useMemo(
    // `enabled` and nothing else: it is the user's own toggle for this agent.
    // The folder-agent exclusion that used to sit beside it was a capability
    // gap — no local runner — and it is gone with the runner that closed it.
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
  // In-chat `@`-agent gesture: bring another agent into the chat, moving it
  // onto the router that shape needs. Owns the switch→add→error sequence so the
  // view stays declarative.
  const attachAgent = useAttachAgentToChat(chatId)

  const boundAgent = useMemo(
    () => (chatData?.agentId ? (agents ?? []).find((a) => a.id === chatData.agentId) ?? null : null),
    [chatData?.agentId, agents]
  )

  // The agent that would take this message, resolved to a row.
  const answeringAgent: AgentData | null = useMemo(
    () =>
      answerTarget.kind === 'agent'
        ? (agents ?? []).find((a) => a.id === answerTarget.agentId) ?? null
        : null,
    [answerTarget, agents]
  )

  /**
   * What the badge says. An active chat reads its own row; the new-chat screen
   * is told by `MainArea`, which is where the pending selection lives.
   *
   * A `direct` chat with no agent — a plain chat with the local model — shows
   * no badge at all, which is what it has always done: there is no routing
   * decision to report, and a pill saying so would be chrome for the most
   * common chat in the app.
   */
  /**
   * In a chat the user routes, a chip is also the address: clicking one says
   * who the next message is for. Absent everywhere else, where a chip is only a
   * record of what is attached.
   *
   * The ring follows the *resolved* answerer, not the raw click — so before the
   * user has picked anybody, the chip that would actually answer is the one
   * marked, rather than none of them.
   */
  const chipAddressing = useMemo(
    () =>
      chatId && chatRouting.router === 'human'
        ? {
            addressedId: answerTarget.kind === 'agent' ? answerTarget.agentId : null,
            onAddress: (agentId: string) => setAddressedAgent(chatId, agentId)
          }
        : undefined,
    [chatId, chatRouting.router, answerTarget, setAddressedAgent]
  )

  /**
   * Handing the chat to the local model, and taking it back. Offered only where
   * there is something to coordinate — a chat with at least one agent in it —
   * because in a plain chat with the model it would be a toggle between two
   * states that behave identically.
   */
  const setChatRouter = useSetChatRouter()
  const coordinateToggle = useMemo(() => {
    if (!chatId) return undefined
    const coordinating = chatRouting.router === 'coordinator'
    const hasAgents = attachedAgentIds.length > 0 || !!chatRouting.rootAgentId
    if (!coordinating && !hasAgents) return undefined
    return {
      coordinating,
      pending: setChatRouter.isPending,
      onToggle: (next: boolean) => {
        // Off lands on `human` when agents remain and `direct` when none do —
        // a chat with nothing but the model is `direct` to it, not a chat the
        // user routes between nobody.
        const router = next ? 'coordinator' : attachedAgentIds.length > 0 ? 'human' : 'direct'
        // `mutateAsync` with the failure handled here rather than a `mutate`
        // callback: turning coordination on is the one transition main can
        // refuse (no model), and a mutate-level `onError` is dropped if the
        // caller has unmounted — which would swallow the only explanation.
        // `setSendError` is a store action, so it lands either way.
        void setChatRouter
          .mutateAsync({ chatId, router })
          .catch((err) => setSendError(unwrapIpcError(err, 'Could not change who answers')))
      }
    }
  }, [chatId, chatRouting.router, chatRouting.rootAgentId, attachedAgentIds, setChatRouter, setSendError])

  const badgeInfo: RouterBadgeInfo | null = useMemo(() => {
    if (!chatId) return routerInfo ?? null
    if (chatRouting.router === 'direct' && !chatRouting.rootAgentId) return null
    return {
      router: chatRouting.router,
      agentName: boundAgent?.name,
      answererName: answeringAgent?.name,
      // The model's **name**, not its id: the new-chat badge resolves one and a
      // tooltip that bolds `claude-opus-5` beside one that bolds `Opus 5` is
      // two surfaces describing the same model two ways. Falls back to the id,
      // and the badge to "your local model", rather than inventing either.
      modelName: chatData?.modelId
        ? ((models ?? []).find((m) => m.id === chatData.modelId)?.name ?? chatData.modelId)
        : undefined
    }
  }, [chatId, routerInfo, chatRouting, boundAgent, answeringAgent, chatData?.modelId, models])

  // `ChatControls` (model picker + baseline MCP toggle pills) is offered only
  // on a mode-less chat **the local model answers** — that's the chat whose
  // baseline the user manages by hand. Everywhere else the baseline is
  // mode-owned, and this strip is the only place it can be seen.
  //
  // `needsModel`, not `!boundAgent`: a chat the user routes between agents has
  // no bound root either, and offering it a model picker beside a badge saying
  // no model is involved is two surfaces disagreeing about the same chat.
  const showsChatControls = chatRouting.needsModel && !chatData?.modeId
  const { data: chatBaselineLinks } = useChatMcpProviders(chatId)
  const baselineIds = useMemo(() => {
    if (chatId) {
      // Skip when ChatControls is on screen: its pills already list the
      // baseline, and chips would double it up.
      if (showsChatControls) return []
      return (chatBaselineLinks ?? []).map((l) => l.mcpProviderId)
    }
    return baselineMcpIds ?? []
  }, [chatId, showsChatControls, chatBaselineLinks, baselineMcpIds])

  // The `[+]` "Add agents / MCP" picker — cards, selection set, and toggle that
  // mirrors the `@`-mention routing. Logic lives in the hook (testable, out of
  // the view); see `useCapabilityPicker`.
  const {
    items: capabilityItems,
    selectedIds: selectedCapabilityIds,
    toggle: toggleCapability,
    hasCapabilities
  } = useCapabilityPicker({
    chatId,
    enabledAgents,
    enabledMcps,
    boundAgent,
    baselineMcpIds: baselineIds,
    pendingAgentIds,
    pendingMcpIds,
    onTogglePendingAgent,
    onTogglePendingMcp
  })

  // Catalog section of the picker — not-yet-installed bundles the user can
  // quick-install inline. On success the new agent is selected via the same
  // `toggleCapability` routing (it's freshly synced and unselected, so toggle
  // engages it: pending buffer for a new chat, on-demand attach for active).
  const {
    catalogItems,
    installingBundleId,
    install: installCatalogBundle,
    error: catalogInstallError
  } = useCatalogPicker(toggleCapability)

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
    ? boundAgent ?? null
    : selectedAgent ?? null
  // Asked of the agent's driver, not its kind: only an agent whose files go to
  // the Cinna backend takes one.
  const targetTakesCinnaFiles = attachmentTargetAgent?.capabilities.attachments === 'cinna'

  // Active-chat gates: split by destination so the wrong scope never queues.
  const canAttachToRemoteAgent = isCinnaUser && targetTakesCinnaFiles
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

  // The agent this message goes straight to, if it goes straight to one — the
  // router's own answer, in an active chat, and the first agent picked on the
  // new-chat screen (which is who `startNewChat` sends the first message to).
  // The composer refuses a send only to that agent. One attached as a tool of
  // the local model is not refused here: its failure comes back as a tool call
  // the model can read.
  const directTarget: AgentData | null = chatId
    ? answeringAgent
    : routerInfo && routerInfo.router !== 'coordinator'
      ? selectedAgent ?? null
      : null
  const readiness = useComposerReadiness(directTarget, input)
  // While a turn runs the row's one button is Stop on an empty input, and Send
  // once there is text or a queued message is being edited — unless readiness
  // refuses the target, whose Send would leave no way to stop but the keyboard.
  // The refusal, not `blocksSend`: that one follows the typed text (a catalog
  // command gets through), and the button must not flip while typing. A new
  // chat has no Send to offer mid-stream, so it keeps Stop.
  const showStop = isStreaming && (!chatId || (!editingId && (!input.trim() || readiness.refusal !== null)))
  const sendClickedAt = useRef(0)
  // Read by `handleSend` at call time, so Enter cannot slip past a refusal that
  // arrived after the callback was built.
  const blocksSendRef = useRef(readiness.blocksSend)
  blocksSendRef.current = readiness.blocksSend
  const readinessReasonId = useId()
  // Check again removes itself when its check clears the refusal, and the focus
  // it held falls to the page body; hand it to the message box, where the user
  // goes next. Only from the body: a refusal cleared in the background never
  // takes focus from wherever the user is.
  const refused = readiness.refusal !== null
  const wasRefusedRef = useRef(refused)
  useEffect(() => {
    if (wasRefusedRef.current && !refused && document.activeElement === document.body) {
      focusComposer()
    }
    wasRefusedRef.current = refused
  }, [refused, focusComposer])

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
      observeHint('files-dropped')
      void pickAttachmentsFromPaths(paths).finally(focusComposer)
    },
    [canAcceptDrop, pickAttachmentsFromPaths, setAttachError, focusComposer, observeHint]
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
    (!!onTogglePendingAgent && enabledAgents.length > 0) ||
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
    [input, triggerStart, triggerFilter, closeTrigger, setInput]
  )

  const selectAgent = useCallback(
    (agent: AgentData) => {
      replaceTriggerToken('')
      observeHint('mention-used')
      if (chatId) {
        // Active chat. Two things, and the order matters: an agent already in a
        // chat the user routes is simply *addressed* — that is what `@` means
        // once a chat is on `human`, and re-attaching it would be a no-op that
        // also re-armed its announce flag. An agent that is not in the chat yet
        // is brought in (the hook owns the router switch, the sole-bound-agent
        // no-op and the error handling), and addressed, so the message the user
        // is about to type goes to the agent they just named.
        // **The router this pick lands on, not the one it started from.** A
        // `direct` chat with an agent becomes `human` the moment a second one
        // arrives — and the message the user is about to type is for the agent
        // they just named, not for whoever the transcript says answered last.
        // Reading the *current* router here meant the address was never set on
        // exactly that transition, and every earlier user row carries the old
        // root, so the sticky default sent it back to the wrong agent.
        const willRoute =
          chatRouting.router === 'human' ||
          (chatRouting.router === 'direct' && !!chatRouting.rootAgentId)
        if (willRoute) setAddressedAgent(chatId, agent.id)
        if (!attachedAgentIds.includes(agent.id)) void attachAgent(agent.id)
        return
      }
      // New-chat agent picker: every pick adds to the buffer (mirror of the MCP
      // buffer). The router is decided at send time from the whole selection.
      onTogglePendingAgent?.(agent.id)
    },
    [
      replaceTriggerToken,
      onTogglePendingAgent,
      chatId,
      attachAgent,
      observeHint,
      chatRouting.router,
      chatRouting.rootAgentId,
      attachedAgentIds,
      setAddressedAgent
    ]
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
      observeHint('mention-used')
      if (chatId) {
        void addOnDemandMcp.mutateAsync({ chatId, mcpProviderId: mcp.id })
        return
      }
      onTogglePendingMcp?.(mcp.id)
    },
    [replaceTriggerToken, addOnDemandMcp, chatId, onTogglePendingMcp, observeHint]
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
      observeHint('prompt-picked')
    },
    [replaceTriggerToken, observeHint]
  )

  const selectCommand = useCallback(
    (command: CliCommand) => {
      replaceTriggerToken(command.command)
      observeHint('command-picked')
    },
    [replaceTriggerToken, observeHint]
  )

  const selectNote = useCallback(
    (note: NoteData) => {
      // Drop the `?token` from the textarea — the badge stands in for it.
      replaceTriggerToken('')
      addPendingNote({ id: note.id, title: note.title || 'Untitled note' })
      // Arm the double-Enter expansion: the next Enter on an empty composer
      // swaps this note's badge for its body inline. Any typing clears it
      // (see `handleInput`).
      setPendingExpansionNoteId(note.id)
      // The one beat where the double-Enter tip is actionable — the hint bar
      // surfaces it now or never.
      observeHint('note-attached')
    },
    [replaceTriggerToken, addPendingNote, observeHint]
  )

  const handlePreviewNote = useCallback(
    (id: string) => {
      setPreviewNoteId(id)
      observeHint('note-previewed')
    },
    [observeHint]
  )

  const handleRemovePendingNote = useCallback(
    (id: string) => {
      if (pendingExpansionNoteId === id) setPendingExpansionNoteId(null)
      removePendingNote(id)
    },
    [pendingExpansionNoteId, removePendingNote]
  )

  /**
   * `[+]`-menu equivalents of the keyboard triggers. Each mouse-driven pick is
   * a teachable moment for the shortcut that does the same thing, so the menu
   * callbacks are wrapped rather than passed through.
   */
  const handleToggleCapability = useCallback(
    (id: string) => {
      observeHint('capability-picked-via-menu')
      toggleCapability(id)
    },
    [toggleCapability, observeHint]
  )

  const hintedModeMenu = useMemo<PlusModeMenu | undefined>(() => {
    if (!chatModeMenu) return undefined
    return {
      ...chatModeMenu,
      onSelectMode: (mode) => {
        if (mode) observeHint('mode-picked-via-menu')
        chatModeMenu.onSelectMode(mode)
      }
    }
  }, [chatModeMenu, observeHint])

  const handleTildeSelect = useCallback(
    (mode: ChatModeData) => {
      observeHint('mode-picked-via-tilde')
      tildeModePopup?.onSelect(mode)
    },
    [tildeModePopup, observeHint]
  )

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if (isStreaming && !chatId) return

    // A recalled queued message: Enter saves the edit, it does not send anew.
    if (chatId && editingId) {
      await saveQueuedEdit(chatId, editingId)
      return
    }

    // Double-Enter note expansion: right after the user picked a note via
    // the `?` popup, an Enter on an empty composer means "drop the note's
    // body into the input as text" — a prompt-template paste, not a send.
    // Bypassed when the user has already typed text alongside the badges.
    if (pendingExpansionNoteId && trimmed.length === 0) {
      const expandId = pendingExpansionNoteId
      // Disarm AND detach the note synchronously before awaiting the fetch.
      // A rapid second Enter that lands during the await must not fall
      // through to the "attachment-only send" branch and dispatch the note
      // as a `.md` — clearing the pending list now makes `hasContent` false
      // for that re-entry. If the fetch fails the user can re-attach via `?`.
      setPendingExpansionNoteId(null)
      removePendingNote(expandId)
      try {
        const note = await fetchNote(expandId)
        observeHint('note-expanded-inline')
        setInput(note.body)
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (!el) return
          el.focus()
          el.style.height = 'auto'
          el.style.height = Math.min(el.scrollHeight, 180) + 'px'
          el.setSelectionRange(note.body.length, note.body.length)
        })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        setAttachError(`Note: ${detail}`)
      }
      return
    }

    // Refused: the agent is not ready, and the reason and its action are
    // already beside the disabled Send. Enter does nothing further — nothing
    // is cleared, so the message is still there when the agent is. Below the
    // note paste above on purpose: that sends nothing, so a refusal must not
    // stop it.
    if (blocksSendRef.current) return

    // A turn is running here: the text goes to main, which takes it into the
    // turn or holds it until the turn ends. Files and notes stay in the draft
    // for a turn of their own.
    if (chatId && isStreaming) {
      if (!trimmed || !useComposerDraftStore.getState().beginSend(draftKey)) return
      try {
        if (await composer.submit(trimmed)) {
          useComposerDraftStore.getState().update(draftKey, (draft) => ({
            text: draft.text === input ? '' : draft.text
          }))
          clearEditTooLate()
          vanishedEditRef.current = null
        }
      } finally {
        useComposerDraftStore.getState().endSend(draftKey)
      }
      return
    }

    // Allow attachment-only sends (no text) so users can drop a file in and
    // hit send with a quick "look at this" — only for active chats where the
    // composer handles attachments; new chats still require text for title.
    const hasContent =
      trimmed.length > 0 ||
      (chatId !== null && (pendingAttachments.length > 0 || pendingNotes.length > 0))
    if (!hasContent) return
    // A restored draft can render before destination queries finish. Keep its
    // files, and validate on send instead of deleting them during loading.
    if (pendingAttachments.length > 0 && !targetSupportsAttachments) {
      setAttachError('Choose a destination that supports these files, or remove them before sending.')
      return
    }
    if (chatId && pendingAttachments.some((file) => (file.source ?? 'cinna') !== attachScope)) {
      setAttachError('These files were attached for a different destination. Remove and reattach them before sending.')
      return
    }
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
      if (!onNewChat || !useComposerDraftStore.getState().beginSend(draftKey)) return
      const noteIds = pendingNotes.map((n) => n.id)
      try {
        const sent = await onNewChat(trimmed, attachmentsToSend, noteIds.length > 0 ? noteIds : undefined)
        if (sent !== false) clearComposer()
      } catch (error) {
        setSendError(unwrapIpcError(error, 'Could not start new chat'))
      } finally {
        useComposerDraftStore.getState().endSend(draftKey)
      }
      return
    }

    // Guard against a second Enter landing during the note-ingest await below
    // (which would double-send the same turn) — `isStreaming` can't yet, since
    // it only flips once the stream's `request-id` arrives.
    if (!useComposerDraftStore.getState().beginSend(draftKey)) return
    try {
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

      // Hand off to the composer hook, which sends on the one channel and lets
      // main resolve who answers from `chats.router`. The active-chat
      // composer only ever holds already-ingested attachments — `pending` is
      // gated to the new-chat path by `useChatAttachments` — so the type narrow
      // below is safe.
      const persistedAttachments = attachmentsToSend?.filter(
        (a): a is MessageAttachment => a.source !== 'pending'
      )
      const mergedAttachments =
        noteAttachments.length > 0
          ? [...(persistedAttachments ?? []), ...noteAttachments]
          : persistedAttachments
      const dispatched = await composer.submit(trimmed, mergedAttachments)
      // Consume submitted values from the source draft, even after navigation.
      if (dispatched) {
        clearComposer()
        clearEditTooLate()
        vanishedEditRef.current = null
      }
    } finally {
      useComposerDraftStore.getState().endSend(draftKey)
    }
  }, [
    input,
    draftKey,
    isStreaming,
    chatId,
    onNewChat,
    composer,
    pendingNotes,
    attachScope,
    attachNotesAsync,
    setAttachError,
    clearComposer,
    targetSupportsAttachments,
    pendingAttachments,
    setInput,
    setSendError,
    pendingExpansionNoteId,
    removePendingNote,
    fetchNote,
    observeHint,
    editingId,
    saveQueuedEdit,
    clearEditTooLate
  ])

  const handleCancel = useCallback(() => {
    if (chatId && (hasPortStream || chatData?.activeRunId)) {
      void window.api.run.cancelChat(chatId).catch((error) => {
        setSendError(unwrapIpcError(error, 'This turn could not be stopped.'))
      })
      return
    }
    if (activeRequestId) cancelStream(activeRequestId)
  }, [chatId, hasPortStream, chatData?.activeRunId, activeRequestId, cancelStream, setSendError])

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
        if (mode) handleTildeSelect(mode)
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

    // Esc while editing a queued message leaves the edit and empties the input.
    // It is its own gesture: it does not arm the Esc Esc stop.
    if (e.key === 'Escape' && chatId && editingId) {
      e.preventDefault()
      lastEscapeAt.current = 0
      setRecall(null)
      setInput('')
      clearEditTooLate()
      return
    }

    // Within a multi-line entry the arrows move the caret; only past its first
    // or last line do they step through the history.
    if (
      chatId &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey &&
      caretOnEdgeLine(e.currentTarget, e.key === 'ArrowUp' ? -1 : 1) &&
      recallHistory(e.key === 'ArrowUp' ? -1 : 1)
    ) {
      e.preventDefault()
      return
    }

    if (e.key === 'Escape' && onDoubleEscape) {
      e.preventDefault()
      const now = Date.now()
      if (now - lastEscapeAt.current <= DOUBLE_ESC_WINDOW_MS) {
        lastEscapeAt.current = 0
        observeHint('double-escape')
        onDoubleEscape()
      } else {
        lastEscapeAt.current = now
        // A lone ESC is the half-gesture — the hint that completes it is only
        // useful in the 400 ms before the chord window lapses.
        observeHint('escape-pressed-once')
      }
      return
    }

    // The same chord stops a running turn in an active chat, exactly as the
    // Stop button does. A lone Esc only arms it. No hints here: those belong to
    // the new-chat screen above.
    if (e.key === 'Escape' && chatId && isStreaming) {
      e.preventDefault()
      const now = Date.now()
      if (now - lastEscapeAt.current <= DOUBLE_ESC_WINDOW_MS) {
        lastEscapeAt.current = 0
        handleCancel()
      } else {
        lastEscapeAt.current = now
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    const prevValue = input
    setInput(value)
    if (!value) {
      clearEditTooLate()
      vanishedEditRef.current = null
    }

    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'

    // User is typing — they're no longer in the "just picked a note" beat,
    // so the next Enter should send normally with the note as a `.md`
    // attachment instead of expanding inline.
    if (pendingExpansionNoteId) setPendingExpansionNoteId(null)

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
    // `@` opens the combined agent + MCP picker in both new-chat (agent picks
    // buffer in `pendingAgentIds`, MCP picks in `pendingMcpIds`) and active
    // chats (in-chat agent mention + DB-backed MCP attach).
    const agentGate = token.char === '@' && (newChatHasContent || activeChatHasContent)
    const promptGate = token.char === '#' && examplePrompts.length > 0
    const commandGate = token.char === '/' && commands.length > 0
    const noteGate = token.char === '?' && (notes ?? []).length > 0
    if (!agentGate && !promptGate && !commandGate && !noteGate) {
      if (triggerChar) closeTrigger()
      return
    }

    // Opening (not merely filtering) the note picker — fire once on the
    // transition, not on every keystroke that narrows the list.
    if (token.char === '?' && triggerChar !== '?') observeHint('note-picker-opened')

    setTriggerChar(token.char)
    setTriggerFilter(token.filter)
    setTriggerStart(token.start)
    setTriggerIndex(0)
  }

  const inputBorderColor = isDraggingOver
    ? 'var(--color-accent)'
    : modeColor ? modeColor.border : 'var(--color-border)'

  return (
    <div className="w-full max-w-3xl mx-auto px-4 relative">
      <div className="absolute bottom-full right-4 mb-2"><PendingHandoffControl chatId={chatId} /></div>
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
          onSelect={handleTildeSelect}
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

      <ComposerReadinessWarning readiness={readiness} reasonId={readinessReasonId} />

      <div
        className="ambient-grid-surface relative rounded-2xl bg-[var(--color-bg-input)] border overflow-hidden transition-colors duration-200"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          borderColor: inputBorderColor,
          backgroundColor: modeColor ? modeColor.bg : undefined
        }}
      >
        <AmbientGrid inputRef={textareaRef} borderColor={inputBorderColor} />
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={chatId && isStreaming ? 'Send a follow-up · Esc Esc to stop' : 'Type a message...'}
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
              onRemove={handleRemovePendingNote}
              onPreview={handlePreviewNote}
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

      {previewNote && (
        <NotePreviewModal
          noteId={previewNote.id}
          fallbackTitle={previewNote.title}
          onClose={() => setPreviewNoteId(null)}
        />
      )}

      {chatId && autonomousGoal !== null && <AutonomousTaskDialog key={chatId} chatId={chatId} initialGoal={autonomousGoal}
        onClose={() => setAutonomousGoal(null)} onStarted={() => setInput((current) => current === autonomousGoal ? '' : current)} />}
      <AgentPickerModal
        open={capabilityPickerOpen}
        title="Add agents & tools"
        multiSelect
        activeFirst
        items={capabilityItems}
        selectedIds={selectedCapabilityIds}
        onToggle={handleToggleCapability}
        catalogItems={catalogItems}
        installingBundleId={installingBundleId}
        onInstallCatalog={installCatalogBundle}
        catalogError={catalogInstallError}
        onClose={() => setCapabilityPickerOpen(false)}
        searchPlaceholder="Search agents and MCP servers…"
        emptyLabel="No agents or MCP servers available"
      />

      <div className="flex items-center justify-between px-1 pt-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <ComposerPlusMenu
            canAttachFiles={canShowAttachButton && !isStreaming}
            uploading={isUploading}
            onAttachFiles={() => {
              observeHint('files-picked-via-menu')
              // Return focus to the composer after the file dialog closes so the
              // user can keep typing without re-clicking the input.
              void pickAttachments().finally(focusComposer)
            }}
            hasCapabilities={hasCapabilities || catalogItems.length > 0}
            onOpenCapabilityPicker={() => setCapabilityPickerOpen(true)}
            modeMenu={hintedModeMenu}
            coordinateToggle={coordinateToggle}
            autonomousRun={chatId && chatRouting.router === 'coordinator'
              ? { disabled: isStreaming, onStart: () => setAutonomousGoal(input) } : undefined}
            activeModeColor={modeColor ? { border: modeColor.border } : null}
          />
          {chatId && boundAgent ? (
            <div
              className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg border
                text-[var(--color-accent)] border-[var(--color-accent)] bg-[var(--color-accent)]/10"
            >
              <Bot size={14} className="shrink-0" />
              <span className="text-[11px] font-medium whitespace-nowrap">
                {boundAgent.name}
              </span>
            </div>
          ) : chatId && showsChatControls ? (
            // Mode-less active LLM chats keep their manual model + baseline-MCP
            // controls; moded chats configure those through the chat mode.
            <ChatControls chatId={chatId} inline />
          ) : null}
          {chatId ? (
            <OnDemandAgentChips chatId={chatId} addressing={chipAddressing} />
          ) : pendingAgentIds && onRemovePendingAgent ? (
            <OnDemandAgentChips
              pendingIds={pendingAgentIds}
              onRemovePending={onRemovePendingAgent}
            />
          ) : null}
          {chatId ? (
            <ActiveMcpChips chatId={chatId} baselineIds={baselineIds} />
          ) : pendingMcpIds && onRemovePendingMcp ? (
            <ActiveMcpChips
              pendingIds={pendingMcpIds}
              onRemovePending={onRemovePendingMcp}
              baselineIds={baselineIds}
            />
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {badgeInfo && (badgeInfo.router !== 'direct' || (chatId ? boundAgent : selectedAgent)) && (
            <RouterBadge
              router={badgeInfo.router}
              connectionAgent={chatId ? boundAgent : selectedAgent}
              agentName={badgeInfo.agentName}
              answererName={badgeInfo.answererName}
              modelName={badgeInfo.modelName}
            />
          )}
          {/* One button, always the rightmost, the same size in every state, so
              swapping it moves nothing (ux_rules §1). Idle: green Send. While a
              turn runs: Stop on an empty input, a blue Send (into the turn or
              its queue) while there is text. Esc Esc stops the turn in either,
              except while a queued message is edited, where Esc leaves the edit. */}
          {/* Separate keys, so focus never passes from Send to Stop on one node;
              a click on Send hands focus back to the input instead. */}
          {showStop ? (
            <button
              key="stop"
              onClick={() => { if (Date.now() - sendClickedAt.current >= STOP_CLICK_GRACE_MS) handleCancel() }}
              aria-label="Stop"
              title="Stop (Esc Esc)"
              className="p-1.5 rounded-lg bg-[var(--color-danger)] hover:opacity-80 text-white transition-opacity"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              key="send"
              onClick={() => {
                sendClickedAt.current = Date.now()
                textareaRef.current?.focus()
                void handleSend()
              }}
              aria-label={editingId ? 'Save' : 'Send'}
              aria-describedby={!editingId && readiness.text ? readinessReasonId : undefined}
              title={editingId ? 'Save queued message' : readiness.title ?? (isStreaming ? 'Send a follow-up · Esc Esc to stop' : undefined)}
              disabled={
                sending ||
                (editingId
                  ? !input.trim()
                  : readiness.blocksSend ||
                    (isStreaming
                      ? !input.trim()
                      : !input.trim() &&
                        !(
                          chatId !== null &&
                          ((targetSupportsAttachments && pendingAttachments.length > 0) ||
                            pendingNotes.length > 0)
                        )))
              }
              className={`p-1.5 rounded-lg ${isStreaming ? 'bg-[var(--color-send-queued)]' : 'bg-[var(--color-success)]'} hover:opacity-80 text-white
                disabled:opacity-20 disabled:cursor-not-allowed transition-opacity`}
            >
              {editingId ? <Check size={16} /> : <SendHorizontal size={16} />}
            </button>
          )}
        </div>
      </div>

    </div>
  )
})
