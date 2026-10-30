import { useEffect, useId, useRef } from 'react'
import { Sparkles } from 'lucide-react'
import { useUIStore, type AddAgentDialogStep } from '../../../stores/ui.store'
import {
  useAgentsHomeQuestion,
  useAgentsHomeSettling,
  useCreateAgentsHomeOnOpen,
  useLocalAgents
} from '../../../hooks/useLocalAgents'
import { useSidebarExternalAgents } from './useSidebarExternalAgents'

/**
 * The agent pane with nothing selected.
 *
 * With no agent of any kind it is the way in: one card that opens Add an agent
 * at its name step, and a quiet link to the rest of what that dialog offers.
 * With agents, a line pointing at the sidebar. With no usable agents folder,
 * the folder message — the card's New agent could not finish there, and the
 * sidebar carries the button that resolves it (ux_rules rule 9) — and the
 * link to the other types, which need no folder.
 *
 * Renders nothing while that is still being settled — the list not loaded, or
 * a missing home on its way to being created — so the card never appears and
 * then gives way to the folder message (ux_rules rule 1). A list that failed
 * is settled: the pane falls back to the sidebar line, and the sidebar says
 * what went wrong.
 */
export function AgentsEmptyPane(): React.JSX.Element {
  // This pane is the Agents page, so it creates a missing home as the sidebar
  // tab does, in case the page is open without that tab. Latched once per window.
  useCreateAgentsHomeOnOpen()
  const { data, isError: localFailed } = useLocalAgents()
  const homeAccess = useAgentsHomeQuestion()
  const settling = useAgentsHomeSettling()
  const external = useSidebarExternalAgents()
  const sidebarTab = useUIStore((s) => s.sidebarTab)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  const setAddAgentDialog = useUIStore((s) => s.setAddAgentDialog)
  const addAgentDialog = useUIStore((s) => s.addAgentDialog)
  const titleId = useId()
  const subId = useId()
  /** The card or link that opened the dialog; focus goes back to it on close. */
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (addAgentDialog !== null) {
      wasOpen.current = true
      return
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    if (opener.current?.isConnected) opener.current.focus()
    opener.current = null
  }, [addAgentDialog])

  const shell = 'flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]'

  const selectLine = <div className={shell}>Select an agent from the sidebar, or add one with +.</div>

  if (localFailed || external.failed) return selectLine

  if (settling || !external.loaded) return <div className={shell} />

  /** The dialog is rendered by the sidebar list, so the sidebar shows Agents. */
  const open = (step: AddAgentDialogStep, from: HTMLElement): void => {
    opener.current = from
    if (sidebarTab !== 'agents') setSidebarTab('agents')
    setAddAgentDialog(step)
  }

  const otherTypes = (
    <button
      type="button"
      onClick={(event) => open('advanced', event.currentTarget)}
      className="text-xs font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]"
    >
      Other types of agents
    </button>
  )

  if (homeAccess && homeAccess !== 'ready') {
    // Only local agents need the folder; the other types are still a click away.
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
        <div className="text-sm text-[var(--color-text-muted)]">Local agents need a folder before you can add one.</div>
        {otherTypes}
      </div>
    )
  }

  if ((data?.agents.length ?? 0) > 0 || external.count > 0) return selectLine

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
      <button
        type="button"
        onClick={(event) => open('name', event.currentTarget)}
        aria-labelledby={titleId}
        aria-describedby={subId}
        className="flex w-full max-w-xs flex-col items-center gap-3 rounded-xl border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] px-6 py-7 text-center transition-colors hover:bg-[var(--color-bg-hover)]
          focus-visible:outline-none focus-visible:border-[var(--color-accent)]"
      >
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-accent)]/10">
          <Sparkles size={28} className="text-[var(--color-accent)]" />
        </span>
        <span id={titleId} className="text-base font-semibold text-[var(--color-text)]">
          Create a local agent
        </span>
        <span id={subId} className="text-xs text-[var(--color-text-muted)]">
          A folder of its own to chat with and shape as you go.
        </span>
      </button>
      {otherTypes}
    </div>
  )
}
