import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, AppWindow, Check, CircleX, Cog, Loader2, Network, Paperclip, SquareTerminal, Trash2 } from 'lucide-react'
import type {
  SessionActivityItem,
  SessionActivityKind,
  SessionActivityState
} from '../../../../shared/sessionActivity'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import type { SessionActivityStopControl } from '../../hooks/useSessionActivityStop'
import { useHoverPopover } from '../ui/useHoverPopover'
import { useRunScriptStore } from '../../stores/runScript.store'
import { addCommandOutputToComposer } from '../../utils/userCommands'

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
  background: { icon: Cog, heading: 'Background processes', one: 'background process', many: 'background processes' },
  command: { icon: SquareTerminal, heading: 'Commands', one: 'command', many: 'commands' }
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

/** Which items a badge stands for: one of the agent's kinds, or both (the collapsed Activity badge). */
export type ActivityBadgeKind = Exclude<SessionActivityKind, 'command'> | 'all'

/** The agent's own kinds; commands the user ran have a badge of their own ({@link CommandsBadge}). */
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
  const kinds = kind === 'all' ? KINDS : [kind]
  const parts = kinds.filter((k) => running(k) > 0).map((k) => countOf(k, running(k)))
  // Nothing left, while the popover that keeps the badge up is open.
  if (parts.length === 0) return `No ${kinds.map((k) => FACE[k].many).join(' or ')} running`
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
 * How long a command the user ran took, or has been running — the one format
 * the Commands popover and the Run Script window's header share: `4s`, `2m 05s`,
 * `1h 03m`.
 */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Now, every second while `active` (a running command's seconds); still otherwise. */
export function useSecondsNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
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
  stop,
  className = ''
}: {
  kind: ActivityBadgeKind
  /** The chat's whole snapshot, in the hub's order; this badge takes its kind. */
  items: readonly SessionActivityItem[]
  /** Stop per item, owned by the strip so it outlives the popover. None: no Stop. */
  stop?: SessionActivityStopControl
  /** Layout only (the container-query visibility the strip decides). */
  className?: string
}): React.JSX.Element | null {
  const popover = useHoverPopover<HTMLButtonElement, HTMLDivElement>('above-right')
  const mine = kind === 'all' ? items.filter((item) => KINDS.includes(item.kind)) : items.filter((item) => item.kind === kind)
  const running = mine.filter((item) => item.state === 'running').length
  // The badge leaves with its last running item — but not while its popover
  // is open: the user may be watching the row they just stopped. It leaves
  // once the popover closes.
  if (running === 0 && !popover.open) return null
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
        {running > 0 && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse"
          />
        )}
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
                        <ActivityRow item={item} stop={stop} />
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

/** Bordered, in the danger tone: an action, not one more word of the row (§11). */
const stopButtonClass = `shrink-0 grid px-1.5 rounded border leading-4 font-medium
  border-[var(--color-danger)]/50 text-[var(--color-danger)]
  hover:bg-[var(--color-danger)]/10 aria-disabled:cursor-default aria-disabled:hover:bg-transparent
  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`

function StopButton({ item, stop }: { item: SessionActivityItem; stop: SessionActivityStopControl }): React.JSX.Element {
  const pending = stop.pending(item.id)
  // Both labels share one grid cell, so "Stop" → "Stopping…" keeps the width (§1).
  // Not `disabled` while pending: that would drop focus out of the popover.
  return (
    <button
      type="button"
      aria-label={`${pending ? 'Stopping' : 'Stop'} ${item.title}`}
      aria-disabled={pending || undefined}
      onClick={() => { if (!pending) stop.stop(item.id) }}
      className={stopButtonClass}
    >
      <span aria-hidden className={`[grid-area:1/1] text-center ${pending ? 'invisible' : ''}`}>Stop</span>
      <span aria-hidden className={`[grid-area:1/1] text-center ${pending ? '' : 'invisible'}`}>Stopping…</span>
    </button>
  )
}

function ActivityRow({ item, stop }: { item: SessionActivityItem; stop?: SessionActivityStopControl }): React.JSX.Element {
  const now = useRelativeNow()
  const ended = item.state !== 'running'
  const stoppable = !!stop && item.kind === 'background' && item.state === 'running' && item.canStop
  const refusal = stop?.refusal(item.id) ?? null
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
        {/* Before the state and time, so the elastic time stays last. */}
        {stoppable && <StopButton item={item} stop={stop} />}
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
      {/* Only when a stop was refused, last in the row: it moves nothing above it (§1, §6). */}
      {refusal && (
        <p role="alert" className="text-[var(--color-danger)]">{refusal}</p>
      )}
    </div>
  )
}

/** A row's icon action: named by its `title` and a row-specific `aria-label`. */
const rowIconClass = `shrink-0 grid place-items-center w-5 h-5 rounded text-[var(--color-text-secondary)]
  hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]
  aria-disabled:opacity-50 aria-disabled:cursor-default aria-disabled:hover:bg-transparent
  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`

/** The badge's accessible name: what runs, or how the last one ended (§10). */
export function commandsLabel(items: readonly SessionActivityItem[]): string {
  const commands = items.filter((item) => item.kind === 'command')
  const running = commands.filter((item) => item.state === 'running').length
  if (running > 0) return `${countOf('command', running)} running`
  const last = commands.find((item) => item.state !== 'running')
  return last ? `Commands: the last one ${STATE_LABEL[last.state].toLowerCase()}` : 'No commands'
}

/**
 * Adding a run's output to the composer, per item, owned by the badge so a
 * row that unmounts with its popover does not lose the answer.
 */
export interface CommandOutputAdder {
  add(itemId: string): void
  pending(itemId: string): boolean
  error(itemId: string): string | null
}

export function useCommandOutputAdder(chatId: string): CommandOutputAdder {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  return {
    add: (itemId) => {
      if (pending.has(itemId)) return
      setPending((prev) => new Set(prev).add(itemId))
      setErrors((prev) => { const next = new Map(prev); next.delete(itemId); return next })
      void addCommandOutputToComposer(chatId, itemId).then((error) => {
        setPending((prev) => { const next = new Set(prev); next.delete(itemId); return next })
        if (error) setErrors((prev) => new Map(prev).set(itemId, error))
      })
    },
    pending: (itemId) => pending.has(itemId),
    error: (itemId) => errors.get(itemId) ?? null
  }
}

/**
 * The Commands badge: commands the user ran from the chat's messages.
 *
 * Unlike Agents and Background it stays while the chat **has any** command,
 * running or ended, so an ended run's output can still be opened or added to
 * the message. Its face is the icon and the running count; with nothing
 * running, the count's place holds a check (completed) or a crossed circle
 * (failed) for the last result, in one fixed-size cell; after a Stop the
 * cell goes and the badge is the icon alone.
 */
export function CommandsBadge({
  chatId,
  items,
  stop,
  className = ''
}: {
  chatId: string
  items: readonly SessionActivityItem[]
  stop?: SessionActivityStopControl
  className?: string
}): React.JSX.Element | null {
  const popover = useHoverPopover<HTMLButtonElement, HTMLDivElement>('above-right')
  const adder = useCommandOutputAdder(chatId)
  const commands = items.filter((item) => item.kind === 'command')
  if (commands.length === 0) return null
  const running = commands.filter((item) => item.state === 'running').length
  const last = commands.find((item) => item.state !== 'running')
  const ended = commands.length - running
  const label = commandsLabel(items)
  return (
    <>
      <button
        ref={popover.triggerRef}
        type="button"
        aria-label={label}
        data-badge="command"
        data-chat-id={chatId}
        className={`relative ${metaBadgeClass} ${className}`}
        {...popover.triggerProps}
      >
        <SquareTerminal size={12} className="shrink-0" />
        {/* One line box tall whatever it holds, a digit or a glyph; after a Stop there is nothing to say, so no cell. */}
        {(running > 0 || last?.state === 'completed' || last?.state === 'failed' || last?.state === 'lost') && (
          <span data-count className={`${metaCountClass} grid h-[1lh] place-items-center`}>
            {running > 0 ? running
              : last?.state === 'completed'
                ? <Check size={11} aria-hidden className="text-[var(--color-success)]" />
                : <CircleX size={11} aria-hidden className={last?.state === 'lost' ? 'text-[var(--color-warning)]' : 'text-[var(--color-danger)]'} />}
          </span>
        )}
        {running > 0 && (
          <span aria-hidden className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
        )}
      </button>
      {popover.open &&
        createPortal(
          <div
            ref={popover.popoverRef}
            aria-label="Commands"
            style={popover.style ?? { position: 'fixed', visibility: 'hidden' }}
            className={metaPopoverClass}
            {...popover.popoverProps}
          >
            <p className="px-3 pb-1.5 flex items-baseline gap-1.5">
              <span className="font-semibold text-[var(--color-text)]">Commands</span>
              <span className="text-[var(--color-text-muted)]">
                {running} running{ended > 0 ? ` · ${ended} ended` : ''}
              </span>
            </p>
            <div
              tabIndex={0}
              aria-label="Commands list"
              className="max-h-80 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
            >
              <ul className="list-none m-0 p-0">
                {commands.map((item) => (
                  <li key={item.id}>
                    <CommandRow chatId={chatId} item={item} stop={stop} adder={adder} onOpenOutput={popover.close} />
                  </li>
                ))}
              </ul>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

/**
 * One run in the Commands popover. Stop sits where the Background row puts
 * its own, before the state; once the run ends its slot holds the state as
 * text, and the end-state actions sit on the line below, where Stop never was,
 * so a second click on Stop lands on nothing (§1).
 */
function CommandRow({ chatId, item, stop, adder, onOpenOutput }: {
  chatId: string
  item: SessionActivityItem
  stop?: SessionActivityStopControl
  adder: CommandOutputAdder
  /** The popover shuts behind the window it opens, or Escape would close it first. */
  onOpenOutput?: () => void
}): React.JSX.Element {
  const ended = item.state !== 'running'
  const now = useSecondsNow(!ended)
  const ranFor = (item.endedAt?.getTime() ?? now) - item.startedAt.getTime()
  const refusal = stop?.refusal(item.id) ?? null
  const [removeError, setRemoveError] = useState<string | null>(null)
  const adding = adder.pending(item.id)
  const error = adder.error(item.id) ?? removeError ?? refusal
  const remove = (): void => {
    setRemoveError(null)
    void window.api.userCommands.dismiss(chatId, item.id)
      .then((result) => {
        if (!result.ok) { setRemoveError(result.reason); return }
        useRunScriptStore.getState().runRemoved(chatId, item.id)
      })
      .catch(() => setRemoveError('This run could not be removed.'))
  }
  return (
    <div data-state={item.state} className="px-3 py-1.5 space-y-1">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text)]" title={item.title}>
          {item.title.split('\n')[0]}
        </span>
        <span data-slot="stop" className="shrink-0 tabular-nums">
          {!ended && item.canStop && stop ? <StopButton item={item} stop={stop} />
            : ended ? <span className={STATE_TONE[item.state]}>{STATE_LABEL[item.state]}</span> : null}
        </span>
        {/* Last: the only part that rewrites itself while the popover is open. */}
        <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
          {!ended && <span className={STATE_TONE.running}>{STATE_LABEL.running} </span>}
          · {formatRunDuration(ranFor)}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]" title={item.detail ?? undefined}>{item.detail}</p>
        {ended && (
          <>
            <button type="button" className={rowIconClass} aria-disabled={adding || undefined}
              title="Add output to message" aria-label={`Add output of ${item.title} to message`}
              onClick={() => { if (!adding) adder.add(item.id) }}>
              {adding ? <Loader2 size={12} aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Paperclip size={12} aria-hidden />}
            </button>
            <button type="button" className={rowIconClass} title="Remove" aria-label={`Remove ${item.title}`} onClick={remove}>
              <Trash2 size={12} aria-hidden />
            </button>
          </>
        )}
        {/* Last, so it keeps its place when the run ends and the others arrive. */}
        <button type="button" className={rowIconClass} title="Open output" aria-label={`Open output of ${item.title}`}
          onClick={(event) => {
            useRunScriptStore.getState().openForRun(
              chatId, { id: item.id, title: item.title, agentId: item.agentId, detail: item.detail },
              event.detail > 0 ? { x: event.clientX, y: event.clientY } : null
            )
            onOpenOutput?.()
          }}>
          <AppWindow size={12} aria-hidden />
        </button>
      </div>
      {/* Only when something was refused, last in the row: it moves nothing above it (§1, §6). */}
      {error && <p role="alert" className="text-[var(--color-danger)]">{error}</p>}
    </div>
  )
}
