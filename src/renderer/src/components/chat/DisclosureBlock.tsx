import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * Shared collapsible-disclosure shell for the chat transcript's auxiliary
 * blocks (thinking, tool narration, tool results, command frames, apply_patch).
 * Owns the one thing every one of them duplicated by hand: the card chrome that
 * is transparent when collapsed and tinted when expanded, the chevron + icon +
 * header button, the expand/collapse state, the streaming pulse dot, and the
 * reveal animation. Callers supply the icon, header, and body.
 *
 * Keeping this single means the collapsed-vs-expanded styling (and the class of
 * "background leaks while collapsed" bug) lives in exactly one place.
 */

export type DisclosureTone = 'default' | 'error'

interface DisclosureBlockProps {
  /** Leading icon — caller sizes it and adds `shrink-0`. */
  icon?: ReactNode
  /** Header label content, right of the icon. Truncates when narrow. */
  header: ReactNode
  /** Body, rendered only while expanded. Caller owns its padding. */
  children?: ReactNode
  /** Card chrome tint when expanded. */
  tone?: DisclosureTone
  /**
   * Logical-grouping wrapper: stays transparent in both states (no border/fill)
   * so inner blocks that carry their own chrome aren't double-framed.
   */
  frameless?: boolean
  /** Trailing pulse dot while content streams in. */
  isStreaming?: boolean
  /** Initial expand state; defaults to expanded while streaming, else collapsed. */
  defaultExpanded?: boolean
  animate?: boolean
  animateDelay?: number
}

function wrapperClass(tone: DisclosureTone, frameless: boolean, expanded: boolean): string {
  if (frameless) return ''
  const base = 'rounded-lg border transition-colors duration-200'
  if (!expanded) return `${base} border-transparent bg-transparent`
  return tone === 'error'
    ? `${base} border-[var(--color-danger)]/40 bg-[var(--color-danger)]/8`
    : `${base} border-[var(--color-border)]/60 bg-[var(--color-bg-secondary)]/40`
}

export function DisclosureBlock({
  icon,
  header,
  children,
  tone = 'default',
  frameless = false,
  isStreaming,
  defaultExpanded,
  animate,
  animateDelay
}: DisclosureBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded ?? !!isStreaming)

  const headerColor =
    tone === 'error'
      ? 'text-[var(--color-danger)] hover:text-[var(--color-text-secondary)]'
      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'

  return (
    <div
      className={`${wrapperClass(tone, frameless, expanded)} ${animate ? 'anim-assistant-bubble' : ''}`}
      style={animate && animateDelay ? { animationDelay: `${animateDelay}ms` } : undefined}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]
          ${headerColor} transition-colors min-w-0 text-left`}
      >
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        {icon}
        <span className="flex-1 min-w-0 truncate">{header}</span>
        {isStreaming && (
          <span className="ml-1 inline-block w-1 h-1 rounded-full bg-[var(--color-accent)] animate-pulse shrink-0" />
        )}
      </button>
      {expanded && children}
    </div>
  )
}
