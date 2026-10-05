import { useEffect, useId, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { ALL_AGENTS, TASK_PERIODS, UNASSIGNED, taskPeriodLabel, type TaskAgentFilter, type TaskPeriod } from './tasksViewModel'

const CONTROL =
  'h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-xs text-[var(--color-text)] ' +
  'focus:border-[var(--color-accent)] focus:outline-none'

const SURFACE = 'app-popover-surface z-50 w-72 space-y-3 rounded-lg border border-[var(--color-border)] p-3 shadow-xl'

export interface TasksFilterState {
  agent: TaskAgentFilter
  setAgent: (agent: TaskAgentFilter) => void
  search: string
  setSearch: (search: string) => void
  period: TaskPeriod
  setPeriod: (period: TaskPeriod) => void
  /** The agent filter's options: every agent with a task, A→Z (`agentFilterOptions`). */
  agentOptions: readonly { value: TaskAgentFilter; label: string }[]
  agentName: (agentId: string) => string | undefined
}

/**
 * The Tasks view's filters as one field, left of New task: what is applied,
 * as pills, and the **Filters** button that opens the form, inside one bordered
 * block. The period's pill is there from the start (Last week); its × makes
 * it All time. With nothing applied, the block is the Filters button alone.
 *
 * Every pill is always mounted and collapses to no width when its filter is
 * off (`FilterPill`), so the block grows and shrinks by animation, alike for
 * an × and for a change made in the form. The block sits at the row's right
 * end, beside New task: it grows leftwards into the row's free space, so the
 * Filters button — and the form anchored under it — never moves, and typing a
 * search in the form moves nothing the user is looking at (`ux_rules.md` §1).
 *
 * The form is a portaled popover (`usePopover`). Every change applies at
 * once; there is no Apply. Escape closes it and gives focus back to the
 * button; an outside click or a scroll of the view closes it too. The search
 * takes focus on open, since finding a task is what the form is opened for most.
 */
export function TasksFilterButton({ filters }: { filters: TasksFilterState }): React.JSX.Element {
  const popover = usePopover<HTMLButtonElement>('below-right')
  const { open, setOpen, triggerRef, popoverRef } = popover
  const searchRef = useRef<HTMLInputElement>(null)
  const periodLabel = useId()
  const { agent, setAgent, search, setSearch, period, setPeriod, agentOptions, agentName } = filters
  const agentLabel = agent === ALL_AGENTS
    ? null
    : agent === UNASSIGNED
      ? 'No agent'
      : agentOptions.find((option) => option.value === agent)?.label ?? agentName(agent.slice('agent:'.length)) ?? 'Agent'
  const query = search.trim()
  // A cleared pill turns inert under the focus that pressed it; hand focus to
  // the Filters button rather than letting it fall to the page.
  const clear = (apply: () => void) => (): void => {
    apply()
    triggerRef.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (open && popover.style) searchRef.current?.focus({ preventScroll: true })
  }, [open, popover.style !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
    }
    // A scroll of the view carries the button away from a popover fixed in
    // place; close it, as `ContextMenu` does. A scroll inside the form (the
    // select's list) is not the view's.
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return
      if (event.target instanceof Node && triggerRef.current && !event.target.contains(triggerRef.current)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, setOpen, triggerRef, popoverRef])

  return (
    <div className="flex h-7 min-w-0 shrink items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div role="group" aria-label="Applied filters" className="flex min-w-0 items-center">
        <FilterPill present={period !== 'all'} label={period === 'all' ? null : taskPeriodLabel(period)}
          onClear={clear(() => setPeriod('all'))} clearLabel={(label) => `Remove ${label}`} />
        <FilterPill present={agentLabel !== null} label={agentLabel} maxWidth="10rem" shrink
          onClear={clear(() => setAgent(ALL_AGENTS))} clearLabel={(label) => `Remove the ${label} filter`} />
        <FilterPill present={query !== ''} label={query ? `“${query}”` : null} maxWidth="9rem" shrink
          onClear={clear(() => setSearch(''))} clearLabel={() => 'Clear the search'} />
      </div>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Filters"
        title="Filters"
        onClick={() => setOpen(!open)}
        className={`inline-flex h-full shrink-0 items-center gap-1.5 rounded-[5px] px-2 text-xs text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] ${open ? 'bg-[var(--color-bg-hover)]' : ''}`}
      >
        <SlidersHorizontal size={12} aria-hidden="true" />
        <span className="hidden @xl:inline">Filters</span>
      </button>
      {open && popover.style && createPortal(
        <div ref={popoverRef} role="dialog" aria-label="Filter tasks" style={popover.style} className={SURFACE}>
          <label className="relative flex items-center">
            <Search size={12} aria-hidden="true" className="pointer-events-none absolute left-2 text-[var(--color-text-muted)]" />
            <input ref={searchRef} type="search" aria-label="Search tasks" placeholder="Search titles" value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={`${CONTROL} w-full pl-7 pr-2 placeholder:text-[var(--color-text-muted)]`} />
          </label>
          <div className="space-y-1">
            <span className="block text-[11px] text-[var(--color-text-muted)]">Agent</span>
            <select aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value)}
              className={`${CONTROL} w-full truncate px-2`}>
              <option value={ALL_AGENTS}>All agents</option>
              {agentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              {agent !== ALL_AGENTS && agent !== UNASSIGNED && !agentOptions.some((option) => option.value === agent) && (
                <option value={agent}>{agentName(agent.slice('agent:'.length)) ?? 'Agent'}</option>
              )}
              <option value={UNASSIGNED}>No agent</option>
            </select>
          </div>
          <div className="space-y-1">
            <span id={periodLabel} className="block text-[11px] text-[var(--color-text-muted)]">Changed in</span>
            <div role="radiogroup" aria-labelledby={periodLabel} className="flex rounded-md border border-[var(--color-border)] p-0.5">
              {TASK_PERIODS.map(({ value, label }) => (
                <button key={value} type="button" role="radio" aria-checked={period === value}
                  onClick={() => setPeriod(value)}
                  className={`flex-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs transition-colors ${period === value ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-4 text-[var(--color-text-muted)]">Waiting, In progress and Ready always show.</p>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

/**
 * One applied filter as a pill inside the filters block, with an × that clears
 * it. **Always mounted:** off, it collapses to no width (a grid column going
 * from `1fr` to `0fr`) and keeps its last words while it does, so it shrinks
 * away rather than vanishing, and the block shrinks with it; on, it opens the
 * same way. Collapsed it is `inert` and hidden from the accessibility tree.
 */
function FilterPill({ present, label, onClear, clearLabel, maxWidth, shrink = false }: {
  present: boolean
  label: string | null
  onClear: () => void
  clearLabel: (label: string) => string
  /** A cap for a pill whose words are the user's (an agent name, a search). */
  maxWidth?: string
  /**
   * Gives up width first when the row is narrow. Every pill stops at a few
   * letters and its × (never a sliver); the period pill gives up least.
   */
  shrink?: boolean
}): React.JSX.Element {
  // The words it last committed, kept while it collapses.
  const last = useRef(label)
  useEffect(() => { if (label) last.current = label })
  const words = label ?? last.current ?? ''
  const style: CSSProperties | undefined = maxWidth ? { maxWidth } : undefined
  return (
    <div aria-hidden={!present} inert={!present}
      className={`grid transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none ${present ? 'min-w-16' : 'min-w-0'} ${shrink ? '' : '[flex-shrink:0.25]'} ${present ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0'}`}>
      <div className="min-w-0 overflow-hidden">
        <span style={style}
          className="ml-0.5 mr-1.5 flex h-[22px] min-w-0 items-center gap-0.5 whitespace-nowrap rounded-[4px] bg-[var(--color-bg-hover)] pl-2 pr-0.5 text-[11px] text-[var(--color-text)]">
          <span className="min-w-0 truncate" title={words}>{words}</span>
          <button type="button" aria-label={clearLabel(words)} title={clearLabel(words)} onClick={onClear}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-border)] hover:text-[var(--color-text)]">
            <X size={10} aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>
  )
}
