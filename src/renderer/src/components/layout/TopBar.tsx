import { Plus, PanelLeft, PanelLeftClose } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useStartNewChat } from '../../hooks/useStartNewChat'

// macOS traffic lights at x=15, y=10 (~58 px cluster). 76 px clears them.
const TRAFFIC_LIGHT_GUTTER = 'pl-[76px]'

// Slight-tint background at rest, solid background + subtle border on hover
// so the icons stay legible over the main-area background.
const TOPBAR_BTN =
  'p-1.5 rounded-md border border-transparent transition-colors ' +
  'bg-[var(--color-bg-secondary)]/60 text-[var(--color-text-muted)] ' +
  'hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-border)]'

export function TopBar(): React.JSX.Element {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const startNewChat = useStartNewChat()

  return (
    <div
      className={`app-drag-strip absolute top-2 left-2 right-2 h-[var(--topbar-h)] z-30 flex items-center gap-1 ${TRAFFIC_LIGHT_GUTTER} pr-3`}
    >
      <button
        onClick={toggleSidebar}
        title={sidebarOpen ? 'Collapse sidebar' : 'Open sidebar'}
        className={TOPBAR_BTN}
      >
        {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeft size={15} />}
      </button>
      <button onClick={startNewChat} title="New Chat" className={TOPBAR_BTN}>
        <Plus size={15} />
      </button>
    </div>
  )
}
