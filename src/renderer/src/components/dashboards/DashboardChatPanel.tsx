import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayoutDashboard, MessageSquare, SquarePen, X } from 'lucide-react'
import type { ComponentPrompt, DashboardContext, DashboardsErrorCode } from '../../../../shared/dashboards'
import { useChatDetail } from '../../hooks/useChat'
import { useChatComposer } from '../../hooks/useChatComposer'
import { useReadChatResult } from '../../hooks/useReadChatResult'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { ComposerSendExtrasContext, type ComposerSendExtras } from '../chat/composerSendContext'
import { ChatWorkspace } from '../layout/ChatWorkspace'
import { fillChatComposer } from './ComponentCard'
import { CloudRefusal, useCinnaServerName } from './componentParts'
import { contextChipParts, contextChipTitle } from './dashboardContext'

/** The panel's narrowest and default widths, px; it never takes more than 60% of the window. */
export const PANEL_MIN_WIDTH = 300
const PANEL_MAX_FRACTION = 0.6
/** The narrowest the grid beside the panel gets, px. */
export const GRID_MIN_WIDTH = 360

/**
 * The panel's width for the space the dashboard has now (`rowWidth`: grid
 * plus panel), computed on every resize and never written back, so a window
 * made larger again gets the user's width back. Where the grid's minimum and
 * the panel's do not both fit, the panel lies over the grid instead of
 * squeezing it out of sight. `maxWidth` bounds a drag. An unmeasured row
 * (null) constrains nothing.
 */
export function panelLayout(
  rowWidth: number | null,
  stored: number,
  windowWidth: number
): { width: number; maxWidth: number; overlay: boolean } {
  if (!rowWidth) {
    const maxWidth = Math.max(PANEL_MIN_WIDTH, windowWidth * PANEL_MAX_FRACTION)
    return { width: Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(stored, maxWidth))), maxWidth, overlay: false }
  }
  if (rowWidth < GRID_MIN_WIDTH + PANEL_MIN_WIDTH) {
    return { width: Math.round(Math.min(Math.max(stored, PANEL_MIN_WIDTH), rowWidth)), maxWidth: rowWidth, overlay: true }
  }
  const maxWidth = Math.max(PANEL_MIN_WIDTH, Math.min(rowWidth - GRID_MIN_WIDTH, windowWidth * PANEL_MAX_FRACTION))
  return { width: Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(stored, maxWidth))), maxWidth, overlay: false }
}

const HEADER_ICON_BUTTON =
  'flex items-center rounded-md p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-50'

/**
 * A suggested question waiting for the panel's chat: sent once that chat is
 * on screen. With `fill` (a page's `cinna.ask`, D14) it is put in the
 * composer instead, and never sent.
 */
export interface PendingPrompt {
  agentId: string
  prompt: string
  seq: number
  fill?: boolean
}

/** The chip over the panel's composer: what goes with the next message (README D7). */
export type ContextChip =
  | { kind: 'context'; context: DashboardContext; onRemove: () => void }
  | { kind: 'removed'; title: string; onRestore: () => void }
  | { kind: 'none' }

/**
 * The dashboard's chat panel (README D12): the focused tile's agent's chat on
 * this dashboard, resumed or new, in the ordinary chat workspace. The chat is
 * the chat store's selection while the panel shows it — the live run watch
 * and the streamed turn follow that — and the Chats view's own selection is
 * put back when the panel closes or the dashboard is left, unless the user
 * moved the chat there with Open in Chats.
 */
export function DashboardChatPanel({
  dashboardId,
  agentId,
  agentName,
  chip,
  getContext,
  starters,
  onStarter,
  pendingPrompt,
  onPromptSent,
  onClose,
  onComposerFocus,
  rowWidth
}: {
  dashboardId: string
  /** The width of grid plus panel, px, measured by the dashboard; null before it is. */
  rowWidth: number | null
  /** The focused tile's agent; null until a tile is focused. */
  agentId: string | null
  agentName: string
  chip: ContextChip
  /** The context to send now, or null (removed, or no tile of this agent focused). */
  getContext: () => DashboardContext | null
  /** The focused tile's suggested questions, shown in an empty chat. */
  starters: ComponentPrompt[]
  onStarter: (prompt: ComponentPrompt) => void
  pendingPrompt: PendingPrompt | null
  onPromptSent: (seq: number) => void
  onClose: () => void
  /** The composer gained focus: the focused tile's page is asked what is selected there now (D5). */
  onComposerFocus?: () => void
}): React.JSX.Element {
  const storedWidth = useUIStore((s) => s.dashboardPanelWidth)
  const setWidth = useUIStore((s) => s.setDashboardPanelWidth)
  const { width, maxWidth, overlay } = panelLayout(rowWidth, storedWidth, window.innerWidth)
  const key = agentId ? `${dashboardId}\u0000${agentId}` : null
  const [resolved, setResolved] = useState<{ key: string; chatId: string } | { key: string; error: string; code: DashboardsErrorCode | null } | null>(null)
  // Bumped by Retry on a refusal: the chat for the same (dashboard, agent) is asked for again.
  const [attempt, setAttempt] = useState(0)
  const server = useCinnaServerName()
  const [starting, setStarting] = useState(false)
  // Chats this panel resolved, per (dashboard, agent): switching back is instant.
  const chatsByKey = useRef(new Map<string, string>())
  const ownChats = useRef(new Set<string>())

  useEffect(() => {
    if (!key || !agentId) return
    const known = chatsByKey.current.get(key)
    if (known) {
      setResolved({ key, chatId: known })
      return
    }
    let cancelled = false
    window.api.dashboards
      .panelChat({ dashboardId, agentId })
      .then((outcome) => {
        if (cancelled) return
        if (!outcome.ok) return setResolved({ key, error: outcome.message, code: outcome.code })
        chatsByKey.current.set(key, outcome.chatId)
        ownChats.current.add(outcome.chatId)
        setResolved({ key, chatId: outcome.chatId })
      })
      .catch((error: unknown) => {
        if (!cancelled) setResolved({ key, error: unwrapIpcError(error, 'The chat could not be opened.'), code: null })
      })
    return () => {
      cancelled = true
    }
  }, [key, dashboardId, agentId, attempt])
  const retryChat = (): void => {
    setResolved(null)
    setAttempt((n) => n + 1)
  }

  const current = resolved && resolved.key === key ? resolved : null
  const chatId = current && 'chatId' in current ? current.chatId : null

  // A question waiting for a chat that could not be opened is dropped with
  // the error, so it never sends itself when the panel opens again later.
  const failed = !!current && 'error' in current
  useEffect(() => {
    if (failed && pendingPrompt) onPromptSent(pendingPrompt.seq)
  }, [failed, pendingPrompt, onPromptSent])

  // The panel's chat is the chat on screen: the store follows it, and gives
  // the Chats view its own selection back afterwards.
  const stash = useRef<{ chatId: string | null } | null>(null)
  const handedOff = useRef(false)
  useEffect(() => {
    if (!chatId) return
    const state = useChatStore.getState()
    if (stash.current === null) {
      stash.current = { chatId: state.activeChatId }
      // The Chats tab opens this one, not the panel's chat (SidebarTabs).
      useUIStore.getState().setDashboardChatsStash(stash.current)
    }
    state.setActiveChatId(chatId)
  }, [chatId])
  useEffect(
    () => () => {
      const ui = useUIStore.getState()
      ui.setDashboardChatsStash(null)
      if (handedOff.current || !stash.current) return
      // The chat view is on screen: whoever put it there chose its chat — a
      // link to this very chat, or the Chats tab with the stash above. Leave it.
      if (ui.activeView === 'chat') return
      const state = useChatStore.getState()
      // Something else chose a chat meanwhile (New chat, a link): leave it.
      if (state.activeChatId && ownChats.current.has(state.activeChatId)) state.setActiveChatId(stash.current.chatId)
    },
    []
  )
  const storeChatId = useChatStore((s) => s.activeChatId)
  const onScreen = !!chatId && storeChatId === chatId
  useReadChatResult(onScreen ? chatId : null)

  // The key on screen now: a New chat answered after the focus moved to
  // another agent or dashboard must not take the panel back with it.
  const keyRef = useRef(key)
  keyRef.current = key
  const startFresh = useCallback(() => {
    if (!key || !agentId) return
    setStarting(true)
    window.api.dashboards
      .panelChat({ dashboardId, agentId, fresh: true })
      .then((outcome) => {
        if (!outcome.ok) {
          if (keyRef.current === key) setResolved({ key, error: outcome.message, code: outcome.code })
          return
        }
        // Remembered for its own key either way: coming back finds the new chat.
        chatsByKey.current.set(key, outcome.chatId)
        ownChats.current.add(outcome.chatId)
        if (keyRef.current === key) setResolved({ key, chatId: outcome.chatId })
      })
      .catch((error: unknown) => {
        if (keyRef.current === key) setResolved({ key, error: unwrapIpcError(error, 'A new chat could not be started.'), code: null })
      })
      .finally(() => setStarting(false))
  }, [key, dashboardId, agentId])

  const openInChats = (): void => {
    if (!chatId) return
    handedOff.current = true
    const ui = useUIStore.getState()
    useChatStore.getState().setActiveChatId(chatId)
    ui.setDashboardPanelOpen(false)
    ui.setSidebarTab('chats')
    ui.setActiveView('chat')
  }

  // The panel's sends carry the context the chip shows; nothing else's do.
  const getContextRef = useRef(getContext)
  getContextRef.current = getContext
  const extras = useMemo<ComposerSendExtras>(() => ({ dashboardContext: () => getContextRef.current() }), [])

  return (
    <aside
      aria-label="Dashboard chat"
      data-testid="dashboard-chat-panel"
      data-overlay={overlay || undefined}
      className={`flex shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] pt-[var(--topbar-h)] ${
        overlay ? 'absolute inset-y-0 right-0 z-30 shadow-xl' : 'relative'
      }`}
      style={{ width }}
      // The composer gaining focus, from a tile's page (where the owner selected text) or anywhere else.
      onFocus={(event) => { if (event.target instanceof HTMLTextAreaElement) onComposerFocus?.() }}
    >
      <ResizeHandle width={width} maxWidth={maxWidth} onResize={setWidth} />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-3">
        <MessageSquare size={13} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">{agentId ? agentName : 'Chat'}</span>
        <button type="button" className={HEADER_ICON_BUTTON} onClick={startFresh} disabled={!agentId || starting} title="New chat" aria-label="New chat">
          <SquarePen size={13} />
        </button>
        <button type="button" className={HEADER_ICON_BUTTON} onClick={openInChats} disabled={!chatId} title="Open in Chats" aria-label="Open in Chats">
          <span className="px-0.5 text-[11px] font-medium">Open in Chats</span>
        </button>
        <button type="button" className={HEADER_ICON_BUTTON} onClick={onClose} title="Close" aria-label="Close chat panel">
          <X size={13} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {!agentId ? (
          <p className="m-auto max-w-[16rem] px-4 text-center text-xs text-[var(--color-text-secondary)]">Click a tile to ask its agent about it.</p>
        ) : current && 'error' in current ? (
          // A cloud agent's chat can be refused (D6): our sentence, Retry where the server did not answer, Open settings for a sign-in.
          <CloudRefusal
            code={current.code}
            message={current.error}
            names={{ agent: agentName, server }}
            onRetry={retryChat}
            className="m-auto max-w-[18rem] px-4 text-center text-xs"
          />
        ) : !onScreen ? (
          <div className="flex-1" />
        ) : (
          <ComposerSendExtrasContext.Provider value={extras}>
            <PanelChat
              chatId={chatId!}
              agentId={agentId}
              chip={chip}
              starters={starters}
              onStarter={onStarter}
              pendingPrompt={pendingPrompt}
              onPromptSent={onPromptSent}
              onNewChat={startFresh}
            />
          </ComposerSendExtrasContext.Provider>
        )}
      </div>
    </aside>
  )
}

/** The chat itself, inside the panel's send extras: the workspace, its starters and chip, and a waiting question. */
function PanelChat({
  chatId,
  agentId,
  chip,
  starters,
  onStarter,
  pendingPrompt,
  onPromptSent,
  onNewChat
}: {
  chatId: string
  agentId: string
  chip: ContextChip
  starters: ComponentPrompt[]
  onStarter: (prompt: ComponentPrompt) => void
  pendingPrompt: PendingPrompt | null
  onPromptSent: (seq: number) => void
  onNewChat: () => void
}): React.JSX.Element {
  const { data: chat } = useChatDetail(chatId)
  const { submit } = useChatComposer(chatId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const pendingUser = useChatStore((s) => s.pendingUserMessage)
  const empty = !!chat && (chat.messages?.length ?? 0) === 0 && !isStreaming && !pendingUser && !chat.activeRunId

  // A question pressed on a tile: sent once this agent's chat is loaded, with the context; a page's ask only fills the composer.
  const sent = useRef<number | null>(null)
  useEffect(() => {
    if (!pendingPrompt || !chat || pendingPrompt.agentId !== agentId || sent.current === pendingPrompt.seq) return
    sent.current = pendingPrompt.seq
    if (pendingPrompt.fill) {
      fillChatComposer(chatId, pendingPrompt.prompt, { onlyIfEmpty: true })
      onPromptSent(pendingPrompt.seq)
      return
    }
    void submit(pendingPrompt.prompt).finally(() => onPromptSent(pendingPrompt.seq))
  }, [pendingPrompt, chat, chatId, agentId, submit, onPromptSent])

  const top = (
    <div className="mx-auto mb-1.5 w-full max-w-3xl px-4">
      {empty && starters.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid="dashboard-panel-starters">
          {starters.map((prompt, index) => (
            <button
              key={index}
              type="button"
              title={prompt.prompt}
              onClick={() => onStarter(prompt)}
              className="max-w-full truncate rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent-hover)]"
            >
              {prompt.label}
            </button>
          ))}
        </div>
      )}
      <ContextChipRow chip={chip} />
    </div>
  )

  return <ChatWorkspace chatId={chatId} composerTop={top} onNewChatLike={onNewChat} />
}

/** One row of fixed height in every state, so the composer never moves (ux rule 1). */
export function ContextChipRow({ chip }: { chip: ContextChip }): React.JSX.Element {
  return (
    <div className="flex h-6 items-center gap-1.5 text-[11px]" data-testid="dashboard-context-chip">
      {chip.kind === 'context' ? (
        <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-0.5 pl-2 pr-0.5 text-[var(--color-text)]">
          <LayoutDashboard size={11} className="shrink-0 text-[var(--color-accent)]" />
          {/* Only the title is cut short: "· 3 selected" changes as rows are picked, so it always shows. */}
          <span className="flex min-w-0 items-center whitespace-pre" title={contextChipTitle(chip.context)}>
            <span className="truncate" data-testid="dashboard-context-chip-title">{contextChipParts(chip.context).title}</span>
            <span className="shrink-0">{contextChipParts(chip.context).rest}</span>
          </span>
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`Don't send ${chip.context.focused.title}`}
            title="Send without it"
            className="shrink-0 rounded-full p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
          >
            <X size={11} />
          </button>
        </span>
      ) : chip.kind === 'removed' ? (
        <>
          <span className="truncate text-[var(--color-text-muted)]">Not sending {chip.title}</span>
          <button type="button" onClick={chip.onRestore} className="shrink-0 font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
            Send it
          </button>
        </>
      ) : (
        <span className="truncate text-[var(--color-text-muted)]">Click a tile to send what it shows.</span>
      )}
    </div>
  )
}

/** The panel's left edge: drag to resize, between the minimum and what leaves the grid its own minimum. */
function ResizeHandle({ width, maxWidth, onResize }: { width: number; maxWidth: number; onResize: (width: number) => void }): React.JSX.Element {
  const clamp = (value: number): number => Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(value, maxWidth)))
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the chat panel"
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') onResize(clamp(width + 24))
        else if (event.key === 'ArrowRight') onResize(clamp(width - 24))
      }}
      onPointerDown={(event) => {
        event.preventDefault()
        // Captured, so a drag over a tile's frame still reaches this window.
        event.currentTarget.setPointerCapture?.(event.pointerId)
        const startX = event.clientX
        const startWidth = width
        const move = (e: PointerEvent): void => onResize(clamp(startWidth + (startX - e.clientX)))
        const up = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          document.body.style.cursor = ''
        }
        document.body.style.cursor = 'col-resize'
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      }}
      className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none hover:bg-[var(--color-accent)]/20 focus-visible:bg-[var(--color-accent)]/20"
    />
  )
}
