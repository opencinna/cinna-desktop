import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ListFilter, Plus, Zap } from 'lucide-react'
import { useChatList, useChatSummaries, useMoveChat } from '../../hooks/useChat'
import { useAgents } from '../../hooks/useAgents'
import { useChatModes } from '../../hooks/useChatModes'
import { useLocalAgents } from '../../hooks/useLocalAgents'
import { useStartNewChat } from '../../hooks/useStartNewChat'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM } from '../agents/local/OpenInMenu'
import { ChatItem } from './ChatItem'
import { ChatGroupHeader } from './ChatGroupHeader'
import { unwrapIpcError } from '../../utils/ipcError'
import {
  canStartChat, chatGroupCollapsedByDefault, dayRank, dropRank, groupChats, groupKeysOf, isActiveChat, listRank, pinnedChats,
  pinnedRank, PINNED_GROUP, settleActiveIds, type DateBucket, type DateGroup
} from './chatGroups'
import { ChatsDragContext, type ChatsDrag } from './chatDragContext'

type ChatRow = NonNullable<ReturnType<typeof useChatList>['data']>[number]

/** The drag group of the ungrouped list; no group or day key takes this form. */
const FLAT_GROUP = 'flat'

/** How long a failed drop's notice stays. */
const MOVE_NOTICE_MS = 4_000
const NO_ROOM = "Couldn't place the chat there — try another spot"

export function ChatList(): React.JSX.Element {
  const { data: chats, isLoading } = useChatList()
  // Its own unpolled query: a row whose summary has not loaded has no tooltip.
  const { data: summaries } = useChatSummaries()
  const queryClient = useQueryClient()

  // Only the open chat's turn end invalidates `['chats']` (useLiveRunWatch). A
  // background turn ends silently, so the polled list is what notices: a row
  // that was running in the previous result and is not in this one has new
  // messages to count. Once per result however many rows ended; never on the
  // first result, which has nothing to compare against.
  const running = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!chats) return
    const now = new Set(chats.filter((chat) => chat.activeRunId).map((chat) => chat.id))
    const before = running.current
    running.current = now
    if (before && [...before].some((id) => !now.has(id))) {
      void queryClient.invalidateQueries({ queryKey: ['chats', 'summaries'] })
    }
  }, [chats, queryClient])
  const startNewChat = useStartNewChat()

  // Drag reordering, inside the innermost group only: each row carries its
  // group's key, and a row takes a drop only from a row with the same key.
  const [drag, setDrag] = useState<ChatsDrag>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const dragValue = useMemo(
    () => ({ drag, setDrag, menuOpen, setMenuOpen, renaming, setRenaming }),
    [drag, menuOpen, renaming]
  )

  // The Active block: running chats and unread results, above Pinned, each
  // taken out of its place below while it is there. Its rows change only
  // while the pointer is off the list (and no row menu is open): opening an
  // unread chat reads it at once, and the row must not leave from under the
  // click, nor a new one push the list down under the pointer. A row being
  // renamed holds it too: moving the row would remount it and drop the input.
  const showActive = useUIStore((s) => s.chatShowActive)
  const streamingChatId = useChatStore((s) => (s.isStreaming ? s.activeChatId : null))
  const selectedChatId = useChatStore((s) => s.activeChatId)
  // The chat on screen does not join the block: its own turn is in front of
  // the user already, and would move its row out and back on every message.
  // One already in the block (opened from it) stays until it leaves.
  const onChatView = useUIStore((s) => s.activeView === 'chat')
  const viewingChatId = onChatView ? selectedChatId : null
  const pointerIn = usePointerOnList()
  const [activeIds, setActiveIds] = useState<string[]>([])
  if (!pointerIn.inside && !menuOpen && !renaming) {
    const active = showActive
      ? (chats ?? []).filter((chat) =>
          isActiveChat(chat, streamingChatId) && (chat.id !== viewingChatId || activeIds.includes(chat.id)))
      : []
    const next = settleActiveIds(activeIds, active)
    if (next.length !== activeIds.length || next.some((id, i) => id !== activeIds[i])) setActiveIds(next)
  }
  const activeRows = useMemo(() => {
    const byId = new Map((chats ?? []).map((chat) => [chat.id, chat]))
    return activeIds.flatMap((id) => byId.get(id) ?? [])
  }, [chats, activeIds])
  const listed = useMemo(() => {
    if (activeRows.length === 0) return chats ?? []
    const inActive = new Set(activeRows.map((chat) => chat.id))
    return (chats ?? []).filter((chat) => !inActive.has(chat.id))
  }, [chats, activeRows])
  // A chat opened from the block is shown where it goes when it leaves: its
  // groups open and its row scrolls into view, still selected, so it does not
  // vanish. Only one opened from there — the open chat also passes through
  // the block on every turn it runs, and that must not open a group the user
  // closed.
  // Set by a click on an Active row; any other open (another row, a task
  // page, the list mounting over an open chat) is not one, and clears it.
  const openedFromActive = useRef<string | null>(null)
  useEffect(() => {
    if (openedFromActive.current !== selectedChatId) openedFromActive.current = null
  }, [selectedChatId])
  const activeBefore = useRef<string[]>([])
  useEffect(() => {
    const before = activeBefore.current
    activeBefore.current = activeIds
    const open = openedFromActive.current
    if (!open || open !== useChatStore.getState().activeChatId) return
    if (!before.includes(open) || activeIds.includes(open)) return
    openedFromActive.current = null
    if (chats?.some((chat) => chat.id === open)) useUIStore.getState().setRevealChatId(open)
  }, [activeIds, chats])

  const byAgent = useUIStore((s) => s.chatGroupByAgent)
  const byDate = useUIStore((s) => s.chatGroupByDate)
  const collapsedState = useUIStore((s) => s.chatGroupCollapsed)
  const setCollapsed = useUIStore((s) => s.setChatGroupCollapsed)
  /** The user's choice, else the group's default. */
  const isCollapsed = (group: { key: string; bucket?: DateBucket }, siblings: number): boolean =>
    collapsedState[group.key] ?? chatGroupCollapsedByDefault(group, siblings)
  const revealChatId = useUIStore((s) => s.revealChatId)
  // Only for a row whose summary has not loaded yet: see `chatWho`.
  const { data: agents } = useAgents()
  const { data: modes } = useChatModes()
  // Which agent groups may offer a new chat — see `canStartChat`.
  const { data: folderAgents } = useLocalAgents()
  // Today and Yesterday move at midnight. The time is taken whenever `chats`
  // changes, and that is every second: each poll's rows carry `Date` fields,
  // which TanStack's structural sharing cannot match, so every poll yields a
  // new array.
  const grouping = useMemo(
    () => groupChats(listed, summaries, { agents: agents ?? [], modes: modes ?? [] }, { byAgent, byDate }, new Date()),
    [listed, summaries, agents, modes, byAgent, byDate]
  )
  // Above everything, and never grouped.
  const pinned = useMemo(() => pinnedChats(listed), [listed])
  const pinnedClosed = collapsedState[PINNED_GROUP] ?? false

  // "Show in the Chats list" must find its row: open the groups around it. The
  // row itself clears the request once it has shown itself, and a chat not
  // listed yet is found when the list is read again.
  useEffect(() => {
    if (!revealChatId) return
    const keys = pinned.some((chat) => chat.id === revealChatId) ? [PINNED_GROUP] : groupKeysOf(grouping, revealChatId)
    if (keys.length > 0) useUIStore.getState().expandChatGroups(keys)
  }, [revealChatId, grouping, pinned])

  // A row that changes group mid-drag remounts, and its `dragend` goes with
  // the old element: the document still hears the drag end.
  useEffect(() => {
    if (!drag) return
    const end = (): void => setDrag(null)
    document.addEventListener('dragend', end)
    document.addEventListener('drop', end)
    return () => {
      document.removeEventListener('dragend', end)
      document.removeEventListener('drop', end)
    }
  }, [drag])
  const move = useMoveChat()
  // A drop that could not be written says so for a few seconds, over the list
  // rather than in it, so no row moves when it appears or goes.
  const [moveNotice, setMoveNotice] = useState<string | null>(null)
  useEffect(() => {
    if (move.error) setMoveNotice(unwrapIpcError(move.error, 'The chat could not be moved.'))
  }, [move.error])
  useEffect(() => {
    if (!moveNotice) return
    const timer = setTimeout(() => setMoveNotice(null), MOVE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [moveNotice])
  /**
   * The drop handler of one group as drawn: the new rank comes from the
   * neighbours the user sees, by the rank that group is sorted by.
   */
  const dropInto = (list: 'pinned' | 'chats', shown: ChatRow[], rank: (chat: ChatRow) => number) =>
    (draggedId: string, targetId: string, place: 'before' | 'after'): void => {
      const next = dropRank(shown, rank, draggedId, targetId, place)
      if (next === 'unchanged') return
      if (next === 'no-room') {
        setMoveNotice(NO_ROOM)
        return
      }
      setMoveNotice(null)
      move.mutate({ chatId: draggedId, list, rank: next })
    }

  // Open Folder: the chat's primary agent, when it is a folder agent.
  const folderAgentIds = useMemo(() => new Set((folderAgents?.agents ?? []).map((agent) => agent.id)), [folderAgents])
  const folderAgentOf = (chat: ChatRow): string | undefined => {
    const id = summaries?.[chat.id]?.with.agentId ?? chat.agentId
    return id && folderAgentIds.has(id) ? id : undefined
  }

  // Each row's place in the list as drawn: it moves when a group above it
  // opens or closes, which is when an open tooltip must close.
  let position = 0
  const rows = (group: string, list: ChatRow[], onDrop: ReturnType<typeof dropInto>): React.JSX.Element[] =>
    list.map((chat) => (
      <ChatItem
        key={chat.id}
        chat={chat}
        summary={summaries?.[chat.id]}
        index={position++}
        folderAgentId={folderAgentOf(chat)}
        dragGroup={group}
        onDropChat={onDrop}
      />
    ))
  const byList = (group: string, list: ChatRow[]): React.JSX.Element[] => rows(group, list, dropInto('chats', list, listRank))
  const days = (groups: DateGroup<ChatRow>[]): React.JSX.Element[] =>
    groups.map((group) => {
      const closed = isCollapsed(group, groups.length)
      return (
        <div key={group.key} className="space-y-px">
          <ChatGroupHeader
            label={group.label}
            collapsed={closed}
            onToggle={() => setCollapsed(group.key, !closed)}
          />
          {!closed && (
            <div className="pl-3 space-y-px">
              {rows(group.key, group.chats, dropInto('chats', group.chats, (chat) => dayRank(chat, summaries?.[chat.id])))}
            </div>
          )}
        </div>
      )
    })

  return (
    <div className="flex flex-col h-full">
      <div className="group/chats-header flex items-center justify-between px-3 pt-1 pb-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          Chats
        </span>
        <div className="flex items-center">
          <GroupChatsMenu />
          <button
            onClick={startNewChat}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="New chat"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 flex flex-col">
      {moveNotice && (
        <div
          role="alert"
          className="app-popover-surface pointer-events-none absolute inset-x-2 bottom-2 z-10 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-danger)] shadow-lg"
        >
          {moveNotice}
        </div>
      )}
      <div
        className="flex-1 overflow-y-auto"
        onMouseMove={pointerIn.onMouseMove}
      >
        {isLoading ? (
          <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
        ) : !chats || chats.length === 0 ? (
          <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">
            No chats yet — click + to start one
          </div>
        ) : (
          <ChatsDragContext.Provider value={dragValue}>
          <div className="px-1.5 py-1 space-y-px">
            {activeRows.length > 0 && (
              // Never collapsed and never reordered: it exists to be seen, and
              // the menu's switch is how it goes away.
              <div role="group" aria-label="Active" className="space-y-px pb-1 mb-1 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-1 px-1.5 py-0.5 text-[var(--color-text-muted)]">
                  <Zap size={12} className="shrink-0" aria-hidden="true" />
                  <span className="text-[10px]">Active</span>
                </div>
                <div className="pl-3 space-y-px">
                  {activeRows.map((chat) => (
                    <ChatItem
                      key={chat.id}
                      chat={chat}
                      summary={summaries?.[chat.id]}
                      index={position++}
                      folderAgentId={folderAgentOf(chat)}
                      onOpen={() => { openedFromActive.current = chat.id }}
                    />
                  ))}
                </div>
              </div>
            )}
            {pinned.length > 0 && (
              <div className="space-y-px">
                <ChatGroupHeader
                  label="Pinned"
                  collapsed={pinnedClosed}
                  onToggle={() => setCollapsed(PINNED_GROUP, !pinnedClosed)}
                />
                {!pinnedClosed && (
                  <div className="pl-3 space-y-px">{rows(PINNED_GROUP, pinned, dropInto('pinned', pinned, pinnedRank))}</div>
                )}
              </div>
            )}
            {grouping.kind === 'flat' && byList(FLAT_GROUP, grouping.chats)}
            {grouping.kind === 'date' && days(grouping.groups)}
            {grouping.kind === 'who' &&
              grouping.groups.map((group) => {
                const closed = isCollapsed(group, grouping.groups.length)
                return (
                  <div key={group.key} className="space-y-px">
                    <ChatGroupHeader
                      label={group.who.name}
                      collapsed={closed}
                      onToggle={() => setCollapsed(group.key, !closed)}
                      who={group.who}
                      available={canStartChat(group.who, agents, folderAgents?.agents)}
                    />
                    {!closed && (
                      <div className="pl-3 space-y-px">
                        {group.dates ? days(group.dates) : byList(group.key, group.chats)}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
          </ChatsDragContext.Provider>
        )}
      </div>
      </div>
    </div>
  )
}

/**
 * Whether the pointer is on the Chats list, for the Active block's hold. Read
 * from every `mousemove` in the document rather than enter/leave on the list:
 * a portaled menu or tooltip that unmounts under a still pointer produces no
 * leave at all (as in `useSidebarHoverDock`). A move counts as on the list when
 * it passed through the list's React handler, so a popover portaled from a row
 * counts while the pointer is on it. Leaving the window or its focus is off.
 */
function usePointerOnList(): { inside: boolean; onMouseMove: (event: React.MouseEvent) => void } {
  const [inside, setInside] = useState(false)
  const lastInsideMove = useRef<Event | null>(null)
  useEffect(() => {
    const onMove = (event: MouseEvent): void => setInside(lastInsideMove.current === event)
    const onOut = (event: MouseEvent): void => {
      if (!event.relatedTarget) setInside(false)
    }
    const onBlur = (): void => setInside(false)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseout', onOut)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseout', onOut)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  const onMouseMove = useCallback((event: React.MouseEvent): void => {
    lastInsideMove.current = event.nativeEvent
  }, [])
  return { inside, onMouseMove }
}

/**
 * The header's grouping menu: independent switches, each checked while on —
 * the two groupings, then the Active block.
 * A pick keeps the menu open, so both can be set in one visit.
 */
function GroupChatsMenu(): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('right')
  const { open, setOpen } = menu
  const byAgent = useUIStore((s) => s.chatGroupByAgent)
  const byDate = useUIStore((s) => s.chatGroupByDate)
  const toggleByAgent = useUIStore((s) => s.toggleChatGroupByAgent)
  const toggleByDate = useUIStore((s) => s.toggleChatGroupByDate)
  const showActive = useUIStore((s) => s.chatShowActive)
  const toggleShowActive = useUIStore((s) => s.toggleChatShowActive)

  // Keyboard, as a menu: the first item takes focus on opening, the arrows
  // move between the items, and Escape closes and gives focus back.
  const { popoverRef, triggerRef } = menu
  const positioned = menu.style !== null
  useEffect(() => {
    if (!open || !positioned) return
    popoverRef.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus()
  }, [open, positioned, popoverRef])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(popoverRef.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [])]
      if (items.length === 0) return
      e.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLElement)
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length].focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen, popoverRef, triggerRef])

  const item = (label: string, checked: boolean, toggle: () => void): React.JSX.Element => (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} className={MENU_ITEM} onClick={toggle}>
      <span className="inline-flex w-3 shrink-0">{checked && <Check size={12} aria-hidden="true" />}</span>
      {label}
    </button>
  )

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        // Out of sight until the pointer is on the header, as a keyboard focus
        // or its own open menu also shows it. Opacity only: nothing moves.
        className={`p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-[color,background-color,opacity] focus-visible:opacity-100 group-hover/chats-header:opacity-100 ${open ? 'opacity-100' : 'opacity-0'}`}
        title="Chats list options"
        aria-label="Chats list options"
      >
        <ListFilter size={14} />
      </button>
      {open &&
        menu.style &&
        createPortal(
          <div
            ref={menu.popoverRef}
            role="menu"
            aria-label="Chats list options"
            style={menu.style}
            className="z-50 w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl p-1 shadow-xl"
          >
            {item('Group by Agent', byAgent, toggleByAgent)}
            {item('Group by Date', byDate, toggleByDate)}
            <div role="separator" className="my-1 border-t border-[var(--color-border)]" />
            {item('Show Active group', showActive, toggleShowActive)}
          </div>,
          document.body
        )}
    </>
  )
}
