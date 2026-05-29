import { Briefcase } from 'lucide-react'
import { useChatDetail } from '../../hooks/useChat'
import { useJobRunOrigin } from '../../hooks/useJobs'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'

/**
 * Pill pinned to the right of the title-bar band, shown only on the chat view
 * when the open chat was spawned by a local job run. Links back to the
 * originating job's detail page.
 *
 * Rendered as a child of the TopBar's `.app-drag-strip` on purpose: a button
 * nested in the drag strip inherits `-webkit-app-region: no-drag` (see
 * main.css), so it stays clickable. An element that merely overlaps the strip
 * from another DOM subtree has its clicks eaten by the OS window-drag region.
 *
 * Right-aligned (via `ml-auto`) rather than window-centered so it sits over the
 * chat area regardless of the sidebar's width / collapsed state.
 *
 * Self-contained: reads the active chat + view from the stores, resolves the
 * run id to the job, and renders nothing unless we're on the chat view of a
 * job-spawned chat whose job still exists.
 */
export function JobOriginBanner(): React.JSX.Element | null {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  const setActiveView = useUIStore((s) => s.setActiveView)

  const onChatView = activeView === 'chat' && !!activeChatId
  const { data: chat } = useChatDetail(onChatView ? activeChatId : null)
  const runId = chat?.originatingJobRunId ?? null
  const { data: origin } = useJobRunOrigin(runId)

  if (!onChatView || !origin) return null

  const openJob = (): void => {
    setActiveJobId(origin.jobId)
    setActiveView('job-detail')
  }

  return (
    <button
      type="button"
      onClick={openJob}
      title="Open the job that created this chat"
      className="ml-auto inline-flex items-center gap-1.5 min-w-0 max-w-[40vw] px-3 py-1 rounded-full text-xs
        text-[var(--color-text-secondary)] hover:text-[var(--color-text)]
        bg-[var(--color-bg-secondary)]/70 hover:bg-[var(--color-bg-secondary)]/90
        border border-[var(--color-border)] shadow-sm backdrop-blur transition-colors"
    >
      <Briefcase size={12} className="shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0 opacity-70">From job</span>
      <span className="truncate font-medium">{origin.jobTitle}</span>
    </button>
  )
}
