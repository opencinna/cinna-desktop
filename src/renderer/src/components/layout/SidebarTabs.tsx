import { MessageSquare, ClipboardList, NotebookPen, Bot } from 'lucide-react'
import { useUIStore, type ActiveView, type SidebarTab } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { useChatList } from '../../hooks/useChat'

/**
 * The center each tab owns, for the one case that only realigns it: returning
 * from the Inbox to the tab that is already selected. A genuine tab change goes
 * through `handleSwitchTab`'s body, which also clears the old tab's selection.
 */
const VIEW_FOR_TAB: Record<SidebarTab, ActiveView> = {
  chats: 'chat',
  jobs: 'job-detail',
  notes: 'note-detail',
  agents: 'local-agent'
}

const TAB_ITEMS: { id: SidebarTab; label: string; Icon: typeof MessageSquare }[] = [
  { id: 'chats', label: 'Chats', Icon: MessageSquare },
  { id: 'jobs', label: 'Jobs', Icon: ClipboardList },
  { id: 'notes', label: 'Notes', Icon: NotebookPen },
  { id: 'agents', label: 'Agents', Icon: Bot }
]

/**
 * Diary-book tabs that stick out on the LEFT of the sidebar card. The
 * sidebar reads as a "page"; the active tab visually merges with the page
 * (same surface, no seam on the right), while inactive tabs sit as smaller
 * recessed blocks. Renders nothing in the settings view (Sidebar gates it).
 */
export function SidebarTabs(): React.JSX.Element {
  const sidebarTab = useUIStore((s) => s.sidebarTab)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  const setActiveCinnaRunId = useUIStore((s) => s.setActiveCinnaRunId)
  const setActiveNoteId = useUIStore((s) => s.setActiveNoteId)
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)

  const { data: chats } = useChatList()

  // Switching sidebar tabs should also realign the main area so the user
  // doesn't end up with (e.g.) Chats in the sidebar and a job still in the
  // center. For Chats we jump to the first chat (or the new-chat screen).
  // For Jobs we intentionally do NOT auto-select — jobs can live inside a
  // collapsed folder, so the "first job" is ambiguous from the user's POV
  // and would silently expand a folder. Instead we land on the empty
  // "Select a job from the sidebar" view.
  // The Inbox is the one view that belongs to no tab, so it is also the one the
  // already-selected tab has to be able to leave: pressing Chats while the
  // inbox fills the center must realign the center, not decide nothing changed.
  const handleSwitchTab = (target: SidebarTab): void => {
    const leavingInbox = activeView === 'inbox'
    if (target === sidebarTab && !leavingInbox) return
    setSidebarTab(target)
    // **Coming back from the inbox to the tab you were already on keeps your
    // place.** The resets below exist because a genuine tab change must not
    // leave a job in the center under the Notes list; nothing about pressing
    // Chats to leave the inbox asks for the open chat to be abandoned, and
    // dropping it would send a user who answered one ask back to a different
    // conversation than the one they left.
    if (target === sidebarTab) {
      setActiveView(VIEW_FOR_TAB[target])
      return
    }
    setActiveCinnaRunId(null)
    if (target === 'chats') {
      const firstChat = chats?.[0]
      setActiveView('chat')
      setActiveChatId(firstChat?.id ?? null)
    } else if (target === 'jobs') {
      setActiveJobId(null)
      setActiveView('job-detail')
    } else if (target === 'notes') {
      setActiveNoteId(null)
      setActiveView('note-detail')
    } else {
      // Agents: like Jobs, land on the empty page rather than auto-selecting.
      // The first agent is ambiguous when the list is grouped by root, and
      // opening one would start reading its folder without being asked to.
      setActiveLocalAgentId(null)
      setActiveView('local-agent')
    }
  }

  return (
    <div className="app-sidebar-tabs">
      {TAB_ITEMS.map(({ id, label, Icon }) => {
        const isActive = sidebarTab === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => handleSwitchTab(id)}
            title={label}
            aria-label={label}
            aria-pressed={isActive}
            className="sidebar-tab"
          >
            <Icon size={14} />
          </button>
        )
      })}
    </div>
  )
}
