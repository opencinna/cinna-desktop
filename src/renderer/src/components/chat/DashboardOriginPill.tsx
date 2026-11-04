import { LayoutDashboard } from 'lucide-react'
import { useChatDetail } from '../../hooks/useChat'
import { useDashboardName } from '../../hooks/useDashboards'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { useCapabilities } from '../../hooks/useCapabilities'

/** Open a dashboard from a chat it started: the Dashboards tab, that dashboard. */
export function openDashboard(dashboardId: string): void {
  const ui = useUIStore.getState()
  ui.setActiveDashboardId(dashboardId)
  ui.setSidebarTab('dashboards')
  ui.setActiveView('dashboard')
}

/**
 * "From dashboard <name>" in the title-bar band, beside the job-origin pill
 * and drawn like it: on the chat view of a chat a dashboard's panel started
 * (README D12). Hidden when that dashboard no longer exists, or while
 * Dashboards is turned off — there is no view to open then, and a click that
 * lands back on the chat would be a silent failure. Clicking it opens the
 * dashboard.
 */
export function DashboardOriginPill(): React.JSX.Element | null {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const activeView = useUIStore((s) => s.activeView)
  const dashboardsOn = useCapabilities().dashboardsEnabled
  const onChatView = activeView === 'chat' && !!activeChatId
  const { data: chat } = useChatDetail(onChatView ? activeChatId : null)
  const dashboardId = onChatView && dashboardsOn ? (chat?.originDashboardId ?? null) : null
  const name = useDashboardName(dashboardId)

  if (!dashboardId || name === null) return null

  return (
    <button
      type="button"
      onClick={() => openDashboard(dashboardId)}
      title="Open the dashboard this chat started on"
      className="ml-auto inline-flex items-center gap-1.5 min-w-0 max-w-[40vw] px-3 py-1 rounded-full text-xs
        text-[var(--color-text-secondary)] hover:text-[var(--color-text)]
        bg-[var(--color-bg-secondary)]/70 hover:bg-[var(--color-bg-secondary)]/90
        border border-[var(--color-border)] shadow-sm backdrop-blur transition-colors"
    >
      <LayoutDashboard size={12} className="shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0 opacity-70">From dashboard</span>
      <span className="truncate font-medium">{name}</span>
    </button>
  )
}

/**
 * The same, on the chat's row in Chats: an icon in the row, named and
 * titled "From dashboard <name>"; clicking it opens the dashboard rather than
 * the chat. Hidden when the dashboard no longer exists, or Dashboards is off.
 */
export function DashboardOriginRowMark({ dashboardId: origin }: { dashboardId: string | null | undefined }): React.JSX.Element | null {
  const dashboardsOn = useCapabilities().dashboardsEnabled
  const dashboardId = dashboardsOn ? origin : null
  const name = useDashboardName(dashboardId)
  if (!dashboardId || name === null) return null
  const label = `From dashboard ${name}`
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        openDashboard(dashboardId)
      }}
      className="shrink-0 rounded p-0.5 text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"
    >
      <LayoutDashboard size={11} />
    </button>
  )
}
