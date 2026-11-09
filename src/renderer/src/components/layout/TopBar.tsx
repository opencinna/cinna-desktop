import { Plus, PanelLeft, PanelLeftClose } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUIStore, selectSidebarVisible } from '../../stores/ui.store'
import { usePopover } from '../ui/usePopover'
import { MENU_SURFACE } from '../agents/local/OpenInMenu'
import { MenuSwitchItem } from '../ui/MenuSwitchItem'
import { useStartNewChat } from '../../hooks/useStartNewChat'
import { JobOriginBanner } from '../chat/JobOriginBanner'
import { DashboardOriginPill } from '../chat/DashboardOriginPill'
import { InboxButton } from '../inbox/InboxButton'
import { TasksButton } from '../tasks/TasksButton'
import { AgentStatusButton } from '../agents/AgentStatusButton'
import { UpdateStatusButton } from '../updater/UpdateStatusButton'

// macOS traffic lights at x=15, y=10 (~58 px cluster). 76 px clears them.
export const TRAFFIC_LIGHT_GUTTER = 'pl-[76px]'

// Slight-tint background at rest, solid background + subtle border on hover
// so the icons stay legible over the main-area background.
const TOPBAR_BTN =
  'ambient-header-button p-1.5 rounded-md border border-transparent transition-colors ' +
  'bg-[var(--color-bg-secondary)]/60 text-[var(--color-text-muted)] ' +
  'hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-border)]'

/**
 * The sidebar button. Fixed docking: opens and closes the sidebar. Hover
 * docking: docks it (back to fixed, open). Right-click opens a menu whose
 * "Show sidebar on hover" switch flips the docking mode.
 */
function SidebarButton(): React.JSX.Element {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const docking = useUIStore((s) => s.sidebarDocking)
  const setSidebarDocking = useUIStore((s) => s.setSidebarDocking)
  const menu = usePopover<HTMLButtonElement>('below-left')
  const { open, setOpen, popoverRef, triggerRef } = menu
  const hover = docking === 'hover'

  // Keyboard, as a menu: the switch row takes focus once the menu is placed
  // (as GroupChatsMenu does), and Escape closes it and gives focus back.
  const positioned = menu.style !== null
  useEffect(() => {
    if (!open || !positioned) return
    popoverRef.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus()
  }, [open, positioned, popoverRef])
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open, setOpen, triggerRef])

  return (
    <>
      <button
        ref={menu.triggerRef}
        onClick={() => (hover ? setSidebarDocking('fixed') : toggleSidebar())}
        onContextMenu={(event) => {
          event.preventDefault()
          setOpen(!open)
        }}
        title={hover ? 'Dock sidebar' : sidebarOpen ? 'Collapse sidebar' : 'Open sidebar'}
        className={TOPBAR_BTN}
      >
        {!hover && sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeft size={15} />}
      </button>
      {open && menu.style && createPortal(
        <div
          ref={menu.popoverRef}
          role="menu"
          aria-label="Sidebar docking"
          style={menu.style}
          className={MENU_SURFACE.replace('w-56', 'w-52')}
        >
          {/* One switch, not a Fixed / On Hover radio pair. The menu stays
              open so the switch is seen to move; Escape or a click outside closes it. */}
          <MenuSwitchItem
            label="Show sidebar on hover"
            checked={hover}
            onToggle={() => setSidebarDocking(hover ? 'fixed' : 'hover')}
          />
        </div>,
        document.body
      )}
    </>
  )
}

export function TopBar(): React.JSX.Element {
  const startNewChat = useStartNewChat()
  const extraUIAnimation = useUIStore((s) => s.extraUIAnimation)
  // The sidebar footer carries the update badge; with the sidebar out of view
  // the ready badge moves here, so a downloaded update is never invisible.
  const sidebarVisible = useUIStore(selectSidebarVisible)
  // Minimal view: the buttons slide up and fade, out of reach; the strip stays
  // so the window can still be dragged by it.
  const minimal = useUIStore((s) => s.minimalView)
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
      className={`app-drag-strip absolute top-2 left-2 h-[var(--topbar-h)] z-30 flex items-center ${TRAFFIC_LIGHT_GUTTER} pr-3`}
      // Stops short of a dashboard's chat card, which reaches the top of the window (DashboardChatPanel).
      style={{ right: 'calc(0.5rem + var(--dashboard-panel-inset, 0px))' }}
    >
      {/* The wave staggers by `nth-child`, so the buttons stay this box's direct children. */}
      <div
        data-header-wave={extraUIAnimation && wave || undefined}
        inert={minimal || undefined}
        className="app-topbar-controls flex-1 min-w-0 h-full flex items-center gap-1"
      >
      <SidebarButton />
      <TasksButton className={TOPBAR_BTN} />
      <AgentStatusButton className={TOPBAR_BTN} />
      <InboxButton className={TOPBAR_BTN} />
      <button onClick={startNewChat} title="New Chat" className={TOPBAR_BTN}>
        <Plus size={15} />
      </button>
      {/* Right-aligned on every view, whether or not the job pill is there;
          the badge goes before the pill so its coming and going never moves it. */}
      <div className="ml-auto flex items-center gap-1 min-w-0">
        {!sidebarVisible && <UpdateStatusButton readyOnly className={TOPBAR_BTN} />}
        <JobOriginBanner />
        <DashboardOriginPill />
      </div>
      </div>
    </div>
  )
}
