import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ListFilter, Plus } from 'lucide-react'
import { useChatList, useChatSummaries } from '../../hooks/useChat'
import { useAgents } from '../../hooks/useAgents'
import { useChatModes } from '../../hooks/useChatModes'
import { useLocalAgents } from '../../hooks/useLocalAgents'
import { useStartNewChat } from '../../hooks/useStartNewChat'
import { useUIStore } from '../../stores/ui.store'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM } from '../agents/local/OpenInMenu'
import { ChatItem } from './ChatItem'
import { ChatGroupHeader } from './ChatGroupHeader'
import { canStartChat, chatGroupCollapsedByDefault, groupChats, groupKeysOf, type DateBucket, type DateGroup } from './chatGroups'

type ChatRow = NonNullable<ReturnType<typeof useChatList>['data']>[number]

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
    () => groupChats(chats ?? [], summaries, { agents: agents ?? [], modes: modes ?? [] }, { byAgent, byDate }, new Date()),
    [chats, summaries, agents, modes, byAgent, byDate]
  )

  // "Show in the Chats list" must find its row: open the groups around it. The
  // row itself clears the request once it has shown itself, and a chat not
  // listed yet is found when the list is read again.
  useEffect(() => {
    if (!revealChatId) return
    const keys = groupKeysOf(grouping, revealChatId)
    if (keys.length > 0) useUIStore.getState().expandChatGroups(keys)
  }, [revealChatId, grouping])

  // Each row's place in the list as drawn: it moves when a group above it
  // opens or closes, which is when an open tooltip must close.
  let position = 0
  const row = (chat: ChatRow): React.JSX.Element => (
    <ChatItem key={chat.id} chat={chat} summary={summaries?.[chat.id]} index={position++} />
  )
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
          {!closed && <div className="pl-3 space-y-px">{group.chats.map(row)}</div>}
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

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
        ) : !chats || chats.length === 0 ? (
          <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">
            No chats yet — click + to start one
          </div>
        ) : (
          <div className="px-1.5 py-1 space-y-px">
            {grouping.kind === 'flat' && grouping.chats.map(row)}
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
                        {group.dates ? days(group.dates) : group.chats.map(row)}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The header's grouping menu: two independent switches, each checked while on.
 * A pick keeps the menu open, so both can be set in one visit.
 */
function GroupChatsMenu(): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('right')
  const { open, setOpen } = menu
  const byAgent = useUIStore((s) => s.chatGroupByAgent)
  const byDate = useUIStore((s) => s.chatGroupByDate)
  const toggleByAgent = useUIStore((s) => s.toggleChatGroupByAgent)
  const toggleByDate = useUIStore((s) => s.toggleChatGroupByDate)

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
        title="Group chats"
        aria-label="Group chats"
      >
        <ListFilter size={14} />
      </button>
      {open &&
        menu.style &&
        createPortal(
          <div
            ref={menu.popoverRef}
            role="menu"
            aria-label="Group chats"
            style={menu.style}
            className="z-50 w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl p-1 shadow-xl"
          >
            {item('Group by Agent', byAgent, toggleByAgent)}
            {item('Group by Date', byDate, toggleByDate)}
          </div>,
          document.body
        )}
    </>
  )
}
