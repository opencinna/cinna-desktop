import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'

/**
 * `accent` is an offer, not a problem (a skill link's Add to agent): a panel
 * holding only accent rows is tinted with the accent, never the warning colour.
 */
export type ComposerNoticeTone = 'warning' | 'danger' | 'accent'

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
  /**
   * At the end of the line, after the text. A label that changes width while
   * it runs is drawn in a {@link StableLabel}, so it never moves the text
   * (ux_rules rule 1).
   */
  action?: ReactNode
  /**
   * The action on its own line under the text instead, only for one that grows
   * far past any width worth reserving while it runs (a login: "Waiting for
   * sign-in in your browser…", then Cancel). At the line's end it would take
   * that width from the text and move it (ux_rules rule 1); below, it widens
   * into free space.
   */
  actionBelow?: boolean
  /**
   * The text on one line, truncated, instead of wrapping to two: for a row
   * whose sentence or actions swap as it settles (a skill link answering), so
   * it never grows a line (ux_rules rule 1). Put the whole sentence in `title`.
   */
  singleLine?: boolean
  /** A × at the end of the line, for a row the person may put away (an offer). */
  onDismiss?: () => void
  dismissLabel?: string
  /**
   * What a panel holding only offers (accent rows) is called, when this row is
   * not a skill link: "Guidance" for the guided first build. Rows without one
   * read as "Skill link"; offers of two kinds together as "Agent status".
   */
  panelLabel?: string
  /** Behind a toggle, opened in place: more findings, the rest of a long story. */
  details?: ReactNode
  detailsLabel?: string
}

/** A composer notice's ×, shared by the panel's rows and the cache-expiry strip. */
export const NOTICE_DISMISS_BUTTON =
  'shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] transition-colors'

const TONE_TEXT: Record<ComposerNoticeTone, string> = {
  warning: 'text-[var(--color-warning)]',
  danger: 'text-[var(--color-danger)]',
  accent: 'text-[var(--color-accent)]'
}

/**
 * The one place the composer says what is wrong with the agent it would send
 * to — the engine is not installed, not logged in, the folder fails its check
 * — tucked behind the top edge of the message box rather than stacked above it
 * as a banner. Nothing here blocks by itself: whether Send works is decided by
 * the readiness rules, and a notice that does not refuse sits beside a live
 * Send. Renders nothing when there is nothing to say (ux_rules rule 2).
 */
/** A row whose notice has gone, kept on screen while it folds up. */
interface LeavingRow { notice: ComposerNotice; index: number }

/** Longest a leaving row is kept if its animationend never comes (a hidden window). */
const LEAVE_FALLBACK_MS = 600

/** Whether rows animate at all: not under reduced motion, nor where no animation ever ends (jsdom). */
function rowsAnimate(): boolean {
  return typeof window.matchMedia === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The notices a {@link ComposerNoticePanel} draws: the live ones, or — once
 * they are all gone — the last of them, held while the panel sinks back under
 * the message box (`leaving`), until it calls `onLeft`. The caller keeps the
 * panel mounted while `notices` is non-empty. Under reduced motion, and where
 * no animation ever ends (jsdom), nothing is held. A change of `resetKey` (the
 * composer's chat) drops what is held: one chat's notices never sink in
 * another's composer.
 */
export function useNoticePanelPresence(notices: ComposerNotice[], resetKey?: string | null): {
  notices: ComposerNotice[]
  leaving: boolean
  onLeft: () => void
} {
  // Compared by emptiness, never by identity: ChatInput builds a new array
  // on every render. The last notices shown come from a committed ref.
  const lastRef = useRef(notices)
  useEffect(() => { if (notices.length > 0) lastRef.current = notices })
  const empty = notices.length === 0
  const [wasEmpty, setWasEmpty] = useState(empty)
  const [held, setHeld] = useState<ComposerNotice[] | null>(null)
  const [prevResetKey, setPrevResetKey] = useState(resetKey)
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey)
    setWasEmpty(empty)
    if (held) setHeld(null)
  } else if (wasEmpty !== empty) {
    setWasEmpty(empty)
    if (empty && rowsAnimate()) setHeld(lastRef.current.map((n) => ({ ...n, textId: undefined })))
    else if (!empty && held) setHeld(null)
  }
  useEffect(() => {
    if (!held) return
    const timer = setTimeout(() => setHeld(null), LEAVE_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [held])
  const onLeft = useCallback(() => setHeld(null), [])
  const leaving = notices.length === 0 && held !== null
  return { notices: leaving ? held : notices, leaving, onLeft }
}

export function ComposerNoticePanel({ notices, leaving: panelLeaving = false, onLeft: onPanelLeft }: {
  notices: ComposerNotice[]
  /** Its notices are gone: it sinks back under the box, inert (see {@link useNoticePanelPresence}). */
  leaving?: boolean
  onLeft?: () => void
}): React.JSX.Element | null {
  // Whether the panel was already showing before this render: its first rows
  // ride in with the panel's own rise, only rows added later unfold.
  const shownRef = useRef(false)
  useEffect(() => { shownRef.current = notices.length > 0 }, [notices.length])
  // A removed row stays where it was, inert, until it has folded up; a key
  // that comes back takes its row back. The panel itself still goes at once
  // with its last notice.
  // Compared by keys, never by identity: ChatInput builds a new array on
  // every render. A gone row is drawn as last committed.
  const latestRef = useRef(notices)
  useEffect(() => { latestRef.current = notices })
  const keySignature = notices.map((n) => n.key).join('\n')
  const [prevSignature, setPrevSignature] = useState(keySignature)
  const [leaving, setLeaving] = useState<LeavingRow[]>([])
  if (prevSignature !== keySignature) {
    const keys = new Set(notices.map((n) => n.key))
    const gone = rowsAnimate() && notices.length > 0
      ? latestRef.current.flatMap((notice, index) => keys.has(notice.key) ? [] : [{ notice: { ...notice, textId: undefined }, index }])
      : []
    setPrevSignature(keySignature)
    if (gone.length > 0 || leaving.some((r) => keys.has(r.notice.key))) {
      setLeaving((rows) => [...rows.filter((r) => !keys.has(r.notice.key) && !gone.some((g) => g.notice.key === r.notice.key)), ...gone])
    }
  }
  useEffect(() => {
    if (leaving.length === 0) return
    const timer = setTimeout(() => setLeaving([]), LEAVE_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [leaving])
  if (notices.length === 0) return null
  const rows: Array<{ notice: ComposerNotice; leaving: boolean }> = notices.map((notice) => ({ notice, leaving: false }))
  for (const row of [...leaving].sort((a, b) => a.index - b.index)) {
    rows.splice(Math.min(row.index, rows.length), 0, { notice: row.notice, leaving: true })
  }
  const onLeft = (key: string): void => setLeaving((list) => list.filter((r) => r.notice.key !== key))
  const tone: ComposerNoticeTone = notices.some((n) => n.tone === 'danger') ? 'danger'
    : notices.some((n) => n.tone === 'warning') ? 'warning'
    : 'accent'
  // An offer alone (every row accent) is not the agent's status; it is named for what it is.
  const offerLabels = new Set(notices.map((n) => n.panelLabel ?? 'Skill link'))
  const label = notices.every((n) => n.tone === 'accent') && offerLabels.size === 1 ? [...offerLabels][0] : 'Agent status'
  return (
    <div role="status" aria-label={label} data-tone={tone} inert={panelLeaving || undefined}
      className={`composer-notice-panel relative mx-3 -mb-3 rounded-t-xl pb-3 ${panelLeaving ? 'composer-notice-panel-leave' : ''}`}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget && e.animationName === 'composer-notice-sink') onPanelLeft?.() }}>
      <span aria-hidden="true" className="composer-notice-border" />
      <ul className="relative divide-y divide-[var(--color-border)]/50">
        {rows.map(({ notice, leaving: isLeaving }) => (
          <NoticeRow key={notice.key} notice={notice} unfold={shownRef.current} leaving={isLeaving} onLeft={onLeft} />
        ))}
      </ul>
    </div>
  )
}

function NoticeRow({ notice, unfold, leaving, onLeft }: {
  notice: ComposerNotice
  unfold: boolean
  /** Its notice has gone: it folds up, inert, then the panel drops it. */
  leaving: boolean
  onLeft: (key: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Read once, at the row's mount: a row keeps its key while its text changes.
  const [entering, setEntering] = useState(unfold)
  const Icon = notice.icon
  const motion = leaving ? 'composer-notice-row-leave' : entering ? 'composer-notice-row-enter' : ''
  return (
    <li className={`px-3 py-2 ${motion}`} inert={leaving || undefined} aria-hidden={leaving || undefined}
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.animationName === 'composer-notice-fold') onLeft(notice.key)
        else setEntering(false)
      }}>
      <div className="flex items-center gap-2">
        {/* A zero-width button as the line's strut: every row is at least one
            button tall, so a row whose buttons come and go as it settles (a
            skill link answering, then checking its credentials) never changes
            height, and two single-line rows swapped in one render match. */}
        <NoticeButton aria-hidden="true" tabIndex={-1} className="invisible w-0 !px-0 !border-x-0 overflow-hidden">{'\u00a0'}</NoticeButton>
        <Icon size={13} aria-hidden="true" className={`-ml-2 shrink-0 ${TONE_TEXT[notice.tone]}`} />
        <p id={notice.textId} title={notice.title} className={`min-w-0 flex-1 text-xs leading-snug text-[var(--color-text)] ${notice.singleLine ? 'truncate' : 'line-clamp-2 break-words'}`}>
          {notice.text}
        </p>
        {notice.details && notice.detailsLabel && (
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
            className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors">
            {notice.detailsLabel}
            <ChevronDown size={11} aria-hidden="true" className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
        {notice.action && !notice.actionBelow && <div className="flex shrink-0 items-center gap-2">{notice.action}</div>}
        {notice.onDismiss && (
          <button type="button" onClick={notice.onDismiss} aria-label={notice.dismissLabel ?? 'Dismiss'} title={notice.dismissLabel ?? 'Dismiss'}
            className={NOTICE_DISMISS_BUTTON}>
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {notice.action && notice.actionBelow && (
        <div className="flex items-center pl-[21px] pt-1.5">{notice.action}</div>
      )}
      {notice.details && (
        <AnimatedCollapse open={open}>
          <div className="pl-[21px] pt-1.5">{notice.details}</div>
        </AnimatedCollapse>
      )}
    </li>
  )
}

/**
 * A button label that swaps for its pending one at a fixed width: both are
 * laid out in one grid cell and the hidden one keeps the width, so `Adding…`
 * or `Checking…` never moves the text or the button beside it. Either may
 * carry its 12 px icon.
 */
export function StableLabel({ label, pending, pendingLabel }: { label: ReactNode; pending: boolean; pendingLabel: ReactNode }): React.JSX.Element {
  return (
    <span className="grid">
      <span aria-hidden={pending} className={`col-start-1 row-start-1 flex items-center gap-1 ${pending ? 'invisible' : ''}`}>{label}</span>
      <span aria-hidden={!pending} className={`col-start-1 row-start-1 flex items-center gap-1 ${pending ? '' : 'invisible'}`}>{pendingLabel}</span>
    </span>
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
