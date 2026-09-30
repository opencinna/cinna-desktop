import { Check, Plus, PanelLeft, PanelLeftClose } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUIStore, type SidebarDocking } from '../../stores/ui.store'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'
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

const DOCKING_OPTIONS: { value: SidebarDocking; label: string }[] = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'hover', label: 'On Hover' }
]

/**
 * The sidebar button. Fixed docking: opens and closes the sidebar. Hover
 * docking: docks it (back to fixed, open). Right-click picks the docking mode.
 */
function SidebarButton(): React.JSX.Element {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const docking = useUIStore((s) => s.sidebarDocking)
  const setSidebarDocking = useUIStore((s) => s.setSidebarDocking)
  const menu = usePopover<HTMLButtonElement>('below-left')
  const { open, setOpen } = menu
  const hover = docking === 'hover'

  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open, setOpen])

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
          className={MENU_SURFACE.replace('w-56', 'w-36')}
        >
          {DOCKING_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={docking === option.value}
              className={MENU_ITEM}
              onClick={() => {
                setSidebarDocking(option.value)
                setOpen(false)
              }}
            >
              <span className="flex-1">{option.label}</span>
              {docking === option.value && <Check size={12} className="text-[var(--color-accent)]" aria-hidden="true" />}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

export function TopBar(): React.JSX.Element {
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
      <SidebarButton />
      <AgentStatusButton className={TOPBAR_BTN} />
      <InboxButton className={TOPBAR_BTN} />
      <button onClick={startNewChat} title="New Chat" className={TOPBAR_BTN}>
        <Plus size={15} />
      </button>
      <JobOriginBanner />
    </div>
  )
}
