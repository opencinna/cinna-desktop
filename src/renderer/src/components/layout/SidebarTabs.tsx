import { MessageSquare, Briefcase } from 'lucide-react'
import { useUIStore, type SidebarTab } from '../../stores/ui.store'

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

  return (
    <div className="app-sidebar-tabs">
      {TAB_ITEMS.map(({ id, label, Icon }) => {
        const isActive = sidebarTab === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => setSidebarTab(id)}
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
