import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'

export type ComposerNoticeTone = 'warning' | 'danger'

/** One thing about the composer's target the user should know: a line, and at most one way to act on it. */
export interface ComposerNotice {
  /** Stable per kind of notice, so a row keeps its state while its text changes. */
  key: string
  tone: ComposerNoticeTone
  icon: LucideIcon
  text: ReactNode
  /** Id of the line, for Send's `aria-describedby`. */
  textId?: string
  /** The full account, for the tooltip on the line. */
  title?: string
  action?: ReactNode
  /** Behind a toggle, opened in place: more findings, the rest of a long story. */
  details?: ReactNode
  detailsLabel?: string
}

const TONE_TEXT: Record<ComposerNoticeTone, string> = {
  warning: 'text-[var(--color-warning)]',
  danger: 'text-[var(--color-danger)]'
}

/**
 * The one place the composer says what is wrong with the agent it would send
 * to — the engine is not installed, not logged in, the folder fails its check
 * — tucked behind the top edge of the message box rather than stacked above it
 * as a banner. Nothing here blocks by itself: whether Send works is decided by
 * the readiness rules, and a notice that does not refuse sits beside a live
 * Send. Renders nothing when there is nothing to say (ux_rules rule 2).
 */
export function ComposerNoticePanel({ notices }: { notices: ComposerNotice[] }): React.JSX.Element | null {
  if (notices.length === 0) return null
  const tone: ComposerNoticeTone = notices.some((n) => n.tone === 'danger') ? 'danger' : 'warning'
  return (
    <div role="status" aria-label="Agent status" data-tone={tone} className="composer-notice-panel relative mx-3 -mb-3 rounded-t-xl pb-3">
      <span aria-hidden="true" className="composer-notice-border" />
      <ul className="relative divide-y divide-[var(--color-border)]/50">
        {notices.map((notice) => <NoticeRow key={notice.key} notice={notice} />)}
      </ul>
    </div>
  )
}

function NoticeRow({ notice }: { notice: ComposerNotice }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = notice.icon
  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon size={13} aria-hidden="true" className={`shrink-0 ${TONE_TEXT[notice.tone]}`} />
        <p id={notice.textId} title={notice.title} className="min-w-0 flex-1 text-xs leading-snug text-[var(--color-text)] line-clamp-2 break-words">
          {notice.text}
        </p>
        {notice.details && notice.detailsLabel && (
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
            className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors">
            {notice.detailsLabel}
            <ChevronDown size={11} aria-hidden="true" className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
        {notice.action && <div className="shrink-0">{notice.action}</div>}
      </div>
      {notice.details && (
        <AnimatedCollapse open={open}>
          <div className="pl-[21px] pt-1.5">{notice.details}</div>
        </AnimatedCollapse>
      )}
    </li>
  )
}

/**
 * A notice's one action, drawn at the size of the composer's badges (the
 * router's "Local" badge): the same padding, radius and type, so the panel
 * reads as part of the composer rather than as a settings form, but filled
 * (`.composer-notice-button`, per theme) so it stands out from the tinted
 * panel as something to click. Icons inside it are size 12, as the badge's are.
 */
export function NoticeButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button type="button" {...props}
    className={`composer-notice-button flex items-center gap-1 px-1.5 py-1 rounded-lg text-[11px] font-semibold tracking-wide whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] aria-disabled:cursor-default aria-disabled:opacity-70 transition-colors ${className}`} />
}

/** The validator's markdown-ish sentence, with its `code` spans drawn as code rather than backticks. */
export function FindingText({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/`([^`]+)`/)
  return <>{parts.map((part, i) => i % 2 === 1
    ? <code key={i} className="rounded bg-[var(--color-bg-tertiary)] px-1 font-mono text-[10.5px] text-[var(--color-text)]">{part}</code>
    : part)}</>
}
