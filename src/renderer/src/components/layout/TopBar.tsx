import { Plus, PanelLeft, PanelLeftClose } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useStartNewChat } from '../../hooks/useStartNewChat'
import { JobOriginBanner } from '../chat/JobOriginBanner'
import { InboxButton } from '../inbox/InboxButton'
import { AgentStatusButton } from '../agents/AgentStatusButton'

// macOS traffic lights at x=15, y=10 (~58 px cluster). 76 px clears them.
const TRAFFIC_LIGHT_GUTTER = 'pl-[76px]'

// Slight-tint background at rest, solid background + subtle border on hover
// so the icons stay legible over the main-area background.
const TOPBAR_BTN =
  'ambient-header-button p-1.5 rounded-md border border-transparent transition-colors ' +
  'bg-[var(--color-bg-secondary)]/60 text-[var(--color-text-muted)] ' +
  'hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-border)]'

export function TopBar(): React.JSX.Element {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const startNewChat = useStartNewChat()
  const extraUIAnimation = useUIStore((s) => s.extraUIAnimation)
  const [wave, setWave] = useState(false)

  useEffect(() => {
    setWave(false)
    if (!extraUIAnimation || !window.matchMedia) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timer: ReturnType<typeof setTimeout>
    const play = (): void => {
      if (document.hidden || motion.matches) return
      setWave(true)
      timer = setTimeout(() => {
        setWave(false)
        timer = setTimeout(play, 28000 + Math.random() * 27000)
      }, 2000)
    }
    const restart = (): void => {
      clearTimeout(timer)
      setWave(false)
      if (!document.hidden && !motion.matches) timer = setTimeout(play, 8000 + Math.random() * 10000)
    }
    restart()
    document.addEventListener('visibilitychange', restart)
    motion.addEventListener('change', restart)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', restart)
      motion.removeEventListener('change', restart)
    }
  }, [extraUIAnimation])

  return (
    <div
      data-header-wave={extraUIAnimation && wave || undefined}
      className={`app-drag-strip absolute top-2 left-2 right-2 h-[var(--topbar-h)] z-30 flex items-center gap-1 ${TRAFFIC_LIGHT_GUTTER} pr-3`}
    >
      <button
        onClick={toggleSidebar}
        title={sidebarOpen ? 'Collapse sidebar' : 'Open sidebar'}
        className={TOPBAR_BTN}
      >
        {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeft size={15} />}
      </button>
      <AgentStatusButton className={TOPBAR_BTN} />
      <InboxButton className={TOPBAR_BTN} />
      <button onClick={startNewChat} title="New Chat" className={TOPBAR_BTN}>
        <Plus size={15} />
      </button>
      <JobOriginBanner />
    </div>
  )
}
