import { MessageSquare, Briefcase } from 'lucide-react'
import { useUIStore, type SidebarTab } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { useChatList } from '../../hooks/useChat'
import { useJobList } from '../../hooks/useJobs'

const TAB_ITEMS: { id: SidebarTab; label: string; Icon: typeof MessageSquare }[] = [
  { id: 'chats', label: 'Chats', Icon: MessageSquare },
  { id: 'jobs', label: 'Jobs', Icon: Briefcase }
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
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  const setActiveCinnaRunId = useUIStore((s) => s.setActiveCinnaRunId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)

  const { data: chats } = useChatList()
  const { data: jobs } = useJobList()

  // Switching sidebar tabs should also realign the main area so the user
  // doesn't end up with (e.g.) Chats in the sidebar and a job still in the
  // center. We jump to the first item in the target list; if the list is
  // empty we fall back to that tab's natural empty-state view.
  const handleSwitchTab = (target: SidebarTab): void => {
    if (target === sidebarTab) return
    setSidebarTab(target)
    setActiveCinnaRunId(null)
    if (target === 'chats') {
      const firstChat = chats?.[0]
      setActiveView('chat')
      setActiveChatId(firstChat?.id ?? null)
    } else {
      const firstJob = jobs?.[0]
      setActiveJobId(firstJob?.id ?? null)
      setActiveView('job-detail')
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
