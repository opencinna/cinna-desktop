import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Activity, Cog, Network } from 'lucide-react'
import type {
  SessionActivityItem,
  SessionActivityKind,
  SessionActivityState
} from '../../../../shared/sessionActivity'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useHoverPopover } from '../ui/useHoverPopover'

/**
 * The Agents and Background badges under the composer: one shape, two kinds.
 *
 * A badge exists only while at least one item of its kind is running — the
 * face is an icon and the running count, nothing else, so its arrival adds a
 * pill of known width to the left of the cluster and moves nothing to its right
 * (`ux_rules.md` §1). The ended items the hub still retains are listed in the
 * popover, muted, under the running ones, but never keep the badge up.
 */

const FACE: Record<SessionActivityKind, { icon: typeof Cog; heading: string; one: string; many: string }> = {
  subagent: { icon: Network, heading: 'Subagents', one: 'subagent', many: 'subagents' },
  background: { icon: Cog, heading: 'Background processes', one: 'background process', many: 'background processes' }
}

const STATE_LABEL: Record<SessionActivityState, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  lost: 'Lost'
}

const STATE_TONE: Record<SessionActivityState, string> = {
  running: 'text-[var(--color-accent)]',
  completed: 'text-[var(--color-success)]',
  failed: 'text-[var(--color-danger)]',
  stopped: 'text-[var(--color-text-muted)]',
  lost: 'text-[var(--color-warning)]'
}

/** Which items a badge stands for: one kind, or both (the collapsed Activity badge). */
export type ActivityBadgeKind = SessionActivityKind | 'all'

const KINDS: readonly SessionActivityKind[] = ['subagent', 'background']

function countOf(kind: SessionActivityKind, n: number): string {
  return `${n} ${n === 1 ? FACE[kind].one : FACE[kind].many}`
}

/**
 * The badge's accessible name: the words its icon and count stand for (§10).
 * The collapsed badge names both kinds it is counting, and only those running.
 */
export function activityLabel(items: readonly SessionActivityItem[], kind: ActivityBadgeKind): string {
  const running = (k: SessionActivityKind): number =>
    items.filter((item) => item.kind === k && item.state === 'running').length
  const parts = (kind === 'all' ? KINDS : [kind]).filter((k) => running(k) > 0).map((k) => countOf(k, running(k)))
  return `${parts.join(' and ')} running`
}

/** How long an item ran, or has been running: `<1m`, `4m`, `2h 5m`. */
export function formatActivityDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/**
 * A badge's count: tabular digits in a two-digit minimum, so 9 → 10 does not
 * widen the badge and shove every badge to its left.
 */
export const metaCountClass = 'min-w-[2ch] text-center text-[11px] font-semibold tabular-nums'

/** The pill every session meta badge wears — `RouterBadge`'s shape, neutral tone. */
export const metaBadgeClass = `flex items-center gap-1 px-1.5 py-1 rounded-lg border
  border-[var(--color-border)] text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)]
  hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors
  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`

/** The portaled panel every session meta popover sits in. */
export const metaPopoverClass = `z-50 w-80 max-w-[calc(100vw-16px)] rounded-lg border
  border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl shadow-xl
  py-2 text-[11px] leading-4 text-[var(--color-text-secondary)]`

export function SessionActivityBadge({
  kind,
  items,
  className = ''
}: {
  kind: ActivityBadgeKind
  /** The chat's whole snapshot, in the hub's order; this badge takes its kind. */
  items: readonly SessionActivityItem[]
  /** Layout only (the container-query visibility the strip decides). */
  className?: string
}): React.JSX.Element | null {
  const popover = useHoverPopover<HTMLButtonElement, HTMLDivElement>('above-right')
  const mine = kind === 'all' ? items : items.filter((item) => item.kind === kind)
  const running = mine.filter((item) => item.state === 'running').length
  // The badge leaves with its last running item; so does an open popover, and
  // it must not come back already open with the next one.
  const { open, setOpen } = popover
  useEffect(() => {
    if (running === 0 && open) setOpen(false)
  }, [running, open, setOpen])
  if (running === 0) return null
  const Icon = kind === 'all' ? Activity : FACE[kind].icon
  const heading = kind === 'all' ? 'Session activity' : FACE[kind].heading
  const label = activityLabel(items, kind)
  const ended = mine.length - running
  // The collapsed badge lists each kind under its own heading, in the same order.
  const groups = kind === 'all'
    ? KINDS.map((k) => ({ kind: k, rows: mine.filter((item) => item.kind === k) })).filter((g) => g.rows.length > 0)
    : [{ kind, rows: mine }]

  return (
    <>
      <button
        ref={popover.triggerRef}
        type="button"
        aria-label={label}
        data-badge={kind}
        className={`relative ${metaBadgeClass} ${className}`}
        {...popover.triggerProps}
      >
        <Icon size={12} className="shrink-0" />
        <span className={metaCountClass}>{running}</span>
        {/*
          Reads as live without moving anything: a dot on the pill's corner,
          out of the flow so it costs the row no width, that only fades.
        */}
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse"
        />
      </button>
      {popover.open &&
        createPortal(
          <div
            ref={popover.popoverRef}
            aria-label={heading}
            style={popover.style ?? { position: 'fixed', visibility: 'hidden' }}
            className={metaPopoverClass}
            {...popover.popoverProps}
          >
            <p className="px-3 pb-1.5 flex items-baseline gap-1.5">
              <span className="font-semibold text-[var(--color-text)]">{heading}</span>
              <span className="text-[var(--color-text-muted)]">
                {running} running{ended > 0 ? ` · ${ended} ended` : ''}
              </span>
            </p>
            {/*
              Focusable, so a keyboard can scroll a long list: pinning with
              Enter moves focus here (`useHoverPopover`).
            */}
            <div
              tabIndex={0}
              aria-label={`${heading} list`}
              className="max-h-80 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
            >
              {groups.map((group) => (
                <section key={group.kind} aria-label={kind === 'all' ? FACE[group.kind].heading : undefined}>
                  {kind === 'all' && (
                    <p className="px-3 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      {FACE[group.kind].heading}
                    </p>
                  )}
                  <ul className="list-none m-0 p-0">
                    {group.rows.map((item) => (
                      <li key={item.id}>
                        <ActivityRow item={item} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

function ActivityRow({ item }: { item: SessionActivityItem }): React.JSX.Element {
  const now = useRelativeNow()
  const ended = item.state !== 'running'
  const ranFor = (item.endedAt ?? now).getTime() - item.startedAt.getTime()
  return (
    <div
      data-state={item.state}
      className={`px-3 py-1.5 space-y-0.5 ${ended ? 'opacity-70' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)]" title={item.title}>
          {item.title}
        </span>
        {/*
          Phase 6 puts the per-item Stop here (when `item.canStop`), before the
          state and time, so the elastic time stays last.
        */}
        {/* Last: the only part that rewrites itself while the popover is open. */}
        <span className="shrink-0 tabular-nums">
          <span className={STATE_TONE[item.state]}>{STATE_LABEL[item.state]}</span>
          <span className="text-[var(--color-text-muted)]"> · {formatActivityDuration(ranFor)}</span>
        </span>
      </div>
      {item.detail && (
        <p className="line-clamp-2 break-words text-[var(--color-text-secondary)]" title={item.detail}>
          {item.detail}
        </p>
      )}
      {item.outputPath && (
        <p className="truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={item.outputPath}>
          {item.outputPath}
        </p>
      )}
      {item.state === 'lost' && (
        <p className="text-[var(--color-text-muted)]">The agent&apos;s process ended before this finished.</p>
      )}
    </div>
  )
}
