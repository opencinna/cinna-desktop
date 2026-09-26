import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react'
import type { ChatListSummary } from '../../../../shared/chatListSummary'
import { NO_CHAT_MODE, useUIStore } from '../../stores/ui.store'
import { WhoIcon } from './ChatItemTooltip'

interface ChatGroupHeaderProps {
  label: string
  collapsed: boolean
  onToggle: () => void
  /**
   * A "who" group (agent, chat mode or plain chat): the header leads with its
   * icon, and a start-chat button shows under the pointer. Absent for a day
   * group, which is a lighter label with no action.
   */
  who?: ChatListSummary['with']
  /** An agent that cannot take a chat (`canStartChat`): no button. */
  available?: boolean
}

/**
 * A Chats-list group header. A day group is drawn like a Jobs folder:
 * chevron and name. A "who" group has no chevron — its icon sits at the left
 * edge, and a collapsed group is dimmed instead. A click anywhere on it
 * toggles the group; the inner button carries the expanded state for the
 * keyboard and a screen reader.
 */
export function ChatGroupHeader({ label, collapsed, onToggle, who, available = true }: ChatGroupHeaderProps): React.JSX.Element {
  const Chevron = collapsed ? ChevronRight : ChevronDown
  const dimmed = !!who && collapsed
  const canStart = !!who && available
  return (
    <div
      onClick={onToggle}
      className={`group/header flex items-center gap-1 px-1.5 rounded-md cursor-pointer
        text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]
        transition-colors ${who ? 'py-1' : 'py-0.5'}`}
    >
      {/* Its click bubbles to the row, which toggles: one toggle either way. */}
      <button
        type="button"
        aria-expanded={!collapsed}
        data-chat-group
        className={`flex flex-1 min-w-0 items-center gap-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] rounded
          transition-opacity ${dimmed ? 'opacity-50 group-hover/header:opacity-100 focus-visible:opacity-100' : ''}`}
      >
        {!who && <Chevron size={12} className="shrink-0" />}
        {who && <WhoIcon who={who} className="" />}
        <span
          className={`flex-1 truncate ${
            who ? 'text-xs text-[var(--color-text-secondary)]' : 'text-[10px] text-[var(--color-text-muted)]'
          }`}
        >
          {label}
        </span>
      </button>

      {/*
        Trailing slot for a "who" group, fixed size so nothing shifts: the
        start-chat button, shown on hover or focus but always rendered, so Tab
        reaches it.
      */}
      {who && (
        <div className="relative w-4 h-4 shrink-0">
          {canStart && <StartChatButton who={who} label={label} />}
        </div>
      )}
    </div>
  )
}

/**
 * What the Agents list's chat shortcut does, for an agent; for a chat mode,
 * the new-chat screen in that mode; for the plain "Chat" group, one in none.
 */
function StartChatButton({ who, label }: { who: ChatListSummary['with']; label: string }): React.JSX.Element {
  const name = who.kind === 'agent'
    ? `Start a new chat with ${label}`
    : who.kind === 'mode' ? `Start a new chat in ${label}` : 'Start a new chat without a mode'
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        const ui = useUIStore.getState()
        ui.setActiveView('chat')
        if (who.kind === 'agent' && who.agentId) ui.setPendingAgentId(who.agentId)
        else ui.setPendingModeId(who.kind === 'mode' && who.modeId ? who.modeId : NO_CHAT_MODE)
        ui.setSidebarTab('chats')
        ui.setActiveJobId(null)
      }}
      className="absolute inset-0 inline-flex items-center justify-center rounded
        opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100
        bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-opacity"
      title={name}
      aria-label={name}
    >
      <MessageSquare size={10} />
    </button>
  )
}
