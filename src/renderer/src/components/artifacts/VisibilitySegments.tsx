import { useId, type KeyboardEvent } from 'react'
import { Loader2 } from 'lucide-react'

/**
 * Who can see an artifact, as a segmented group: one bordered group of
 * buttons, the pressed one in the active-nav tint (the Theme pills in
 * Settings › Features), each named by its short visible label (ux_rules rule
 * 10), and one muted line under it saying what the current choice means —
 * where the server's name goes, since a long one would not fit a segment. The
 * line is filled in every state, one line tall, truncated with its whole text
 * in the tooltip, so nothing below moves (rule 1).
 *
 * Used by the Publish dialog (settings scale) and the card's Share popover
 * (chrome scale, in chat). A pick of the value already pressed does nothing.
 * The arrow keys move the choice, as in a radio group.
 */

export interface VisibilitySegment<V extends string> {
  value: V
  label: string
}

const SCALE = {
  settings: { segment: 'px-2.5 py-1 text-[13px]', line: 'text-[13px]', spinner: 13 },
  chrome: { segment: 'px-2 py-0.5 text-[11px]', line: 'text-[11px]', spinner: 11 }
} as const

export function VisibilitySegments<V extends string>({
  options,
  value,
  onPick,
  labelledBy,
  line,
  scale = 'settings',
  disabled = false,
  inert = false,
  busy = false
}: {
  options: Array<VisibilitySegment<V>>
  value: V
  /** Called only for a value other than the pressed one. */
  onPick: (value: V) => void
  /** The id of the visible label naming the group. */
  labelledBy: string
  /** What the current choice means, naming the server. */
  line: string
  scale?: 'settings' | 'chrome'
  /** Not usable at all (`disabled`): nothing to choose yet. */
  disabled?: boolean
  /**
   * Usable later, inert now (`aria-disabled`): a change is running. A
   * disabled button would drop the keyboard focus the user has on it.
   */
  inert?: boolean
  /** A change is running: a spinner leads the line. */
  busy?: boolean
}): React.JSX.Element {
  const s = SCALE[scale]
  const lineId = useId()
  const pick = (next: V): void => {
    if (disabled || inert || next === value) return
    onPick(next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const at = buttons.indexOf(event.target as HTMLButtonElement)
    if (at < 0) return
    event.preventDefault()
    const next = buttons[(at + step + buttons.length) % buttons.length]
    next.focus()
    const option = options.find((candidate) => candidate.value === next.dataset.value)
    if (option) pick(option.value)
  }
  return (
    <div className="min-w-0">
      <div
        role="group"
        aria-labelledby={labelledBy}
        aria-describedby={lineId}
        onKeyDown={onKeyDown}
        className="flex w-fit max-w-full rounded-md border border-[var(--color-border)] p-0.5"
      >
        {options.map((option) => {
          const pressed = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              data-value={option.value}
              aria-pressed={pressed}
              disabled={disabled}
              aria-disabled={inert || undefined}
              onClick={() => pick(option.value)}
              className={`shrink-0 whitespace-nowrap rounded ${s.segment} transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed ${
                pressed ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <div
        id={lineId}
        data-visibility-line
        title={line}
        className={`mt-1 flex h-[1lh] min-w-0 items-center gap-1.5 ${s.line} text-[var(--color-text-muted)]`}
      >
        {busy && <Loader2 size={s.spinner} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
        <span className="min-w-0 truncate">{line}</span>
      </div>
    </div>
  )
}
