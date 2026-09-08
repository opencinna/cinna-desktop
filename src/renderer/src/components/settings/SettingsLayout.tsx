import { useEffect, type ReactNode, type RefObject } from 'react'
import { AlertTriangle, CheckCircle2, Circle } from 'lucide-react'

/**
 * The shell a Settings tab is built from.
 *
 * Local Agents is the first caller; the older tabs (Features, Local
 * Development, AI Credentials) match the scale and the shapes with their own
 * markup and should move over as they are next touched.
 *
 * A settings tab is a **stack of titled sections**, not a stack of cards. The
 * section title is what a user scans for ("where do I set the engine path?");
 * a card is one setting or one list inside the answer. Local Agents was four
 * unlabelled cards and a loose button, at a type scale two steps smaller than
 * the tab beside it, and the only way to find anything in it was to read all
 * of it.
 *
 * The type scale is the one the rest of Settings settled on — 14px for a
 * title, 13px for the sentence under it, 12px for monospace paths and 11px for
 * badges. `text-xs` / `text-[10px]` / `text-[9px]` are the *app-chrome* scale,
 * correct on the agent page and in chat and wrong here: they render a settings
 * tab two steps smaller than the one beside it, which is what made Local
 * Agents read as a different application (ux_rules rule 12).
 */

/**
 * One titled group of settings.
 *
 * `action` is the section-wide verb (Rescan, Refresh) — it belongs beside the
 * title rather than inside the first card, because it acts on everything in
 * the section. It is a labelled button, not a bare icon: an icon alone next to
 * a muted uppercase title is not discoverable before it is hovered
 * (ux_rules rule 11).
 */
export function SettingsSection({
  title,
  action,
  children
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section>
      <div className="mb-2 flex min-h-[26px] items-center gap-3">
        <h2 className="text-[14px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          {title}
        </h2>
        {action ? (
          <>
            <div className="flex-1" />
            {action}
          </>
        ) : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

/** One setting, or one paragraph about one setting. */
export function SettingsCard({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * A card holding a list of like things (folders, status lines), divided rather
 * than spaced: the divider is what says "these are the same kind of thing",
 * where a gap says "these are unrelated".
 */
export function SettingsRows({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      {children}
    </div>
  )
}

/** One row of a {@link SettingsRows} list. Padding matches {@link SettingsCard}. */
export function SettingsRow({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={`px-4 py-3 ${className}`}>{children}</div>
}

/** The label above a control, and the sentence that says what it does. */
export function SettingsLabel({
  htmlFor,
  children
}: {
  htmlFor?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <label htmlFor={htmlFor} className="text-[14px] font-medium text-[var(--color-text)]">
      {children}
    </label>
  )
}

/**
 * The hint under a label.
 *
 * It sits **above** the control, so a message that arrives after the user acts
 * (a save error, a "takes effect on restart" note) can be rendered last and
 * move nothing the user is about to click (ux_rules rule 1).
 */
export function SettingsHint({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <p className={`text-[13px] leading-relaxed text-[var(--color-text-muted)] ${className}`}>
      {children}
    </p>
  )
}

/**
 * A prerequisite, stated where the control that fixes it lives.
 *
 * A dot and a line, never a coloured strip: a healthy state is not an
 * announcement (ux_rules rule 2). `action` is the one button that changes the
 * state being reported.
 *
 * **Three tones, because "not ok" is two different things.** `warning` is for a
 * state the user has to do something about; `neutral` is for one that is merely
 * not true yet and resolves itself. An amber triangle over "the engine is not
 * running" — which the next chat starts on its own — is the healthy state
 * wearing an alarm, and teaches the user to ignore the triangle for the case
 * where it means something.
 */
export function SettingsStatusRow({
  tone,
  label,
  detail,
  action
}: {
  tone: 'ok' | 'warning' | 'neutral'
  label: string
  detail: ReactNode
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      {tone === 'ok' ? (
        <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[var(--color-success)]" />
      ) : tone === 'warning' ? (
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
      ) : (
        /*
          A small **filled** dot, not a 15px hollow ring. Stacked under two
          green ticks of the same size, an empty circle reads as an unticked
          checkbox — an item not done yet, which is a quieter version of the
          "you must act" the neutral tone exists to stop saying. The guidelines'
          Status Indicator Pattern is a filled dot, and rule 2 asks for a dot.
          The wrapper holds the icon column's width so the three tones align.
        */
        <span className="mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center">
          <Circle size={7} className="fill-current text-[var(--color-text-muted)]" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-[var(--color-text)]">{label}</div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          {detail}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

/** A bordered secondary button — section actions, and the verb inside a row. */
export function SettingsButton({
  onClick,
  disabled,
  title,
  'aria-label': ariaLabel,
  children
}: {
  onClick: () => void
  disabled?: boolean
  title?: string
  'aria-label'?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)]
        bg-[var(--color-bg-secondary)] px-2.5 py-1 text-[13px] font-medium text-[var(--color-text)]
        transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/** The dashed "Add …" button that closes a list. */
export function SettingsAddButton({
  onClick,
  disabled,
  children
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed
        border-[var(--color-border)] px-3 py-2.5 text-[13px] font-medium text-[var(--color-text-muted)]
        transition-colors hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
        disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/**
 * An icon-only row action (Reveal, Forget, Check for updates).
 *
 * It carries the same border and raised background as {@link SettingsButton},
 * because without them a muted glyph beside a muted sub-line is the same colour
 * as the prose and is not discoverable until it is hovered (ux_rules rule 11).
 * Dropping the label is a space decision; dropping the affordance is not.
 */
export function SettingsIconButton({
  onClick,
  disabled,
  title,
  'aria-label': ariaLabel,
  danger = false,
  children
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  'aria-label': string
  danger?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)]
        p-1.5 text-[var(--color-text-secondary)] transition-colors disabled:opacity-40 ${
          danger
            ? 'hover:border-[var(--color-danger)]/40 hover:bg-[var(--color-danger)]/20 hover:text-[var(--color-danger)]'
            : 'hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
        }`}
    >
      {children}
    </button>
  )
}

/** A small non-interactive tag beside a title (Home, Added folder). */
export function SettingsBadge({
  children,
  title
}: {
  children: ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px text-[11px] text-[var(--color-text-secondary)]"
    >
      {children}
    </span>
  )
}

/** The shared text-input shell — same metrics as every other settings input. */
export const settingsInputClass =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 ' +
  'text-[13px] text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none'

/**
 * The dismissal and focus rules every settings dialog keeps, in one place.
 *
 * Escape and an outside click are ignored while `pending` — dismissing would
 * cancel nothing and only hide what is happening (ux_rules rule 5) — Tab is
 * confined to the dialog, and focus enters on mount and returns to the trigger
 * on close.
 *
 * Shared because it was written three times and only got all four rules right
 * once: the two dialogs that skipped the Tab trap left the row's own destructive
 * **Forget** button reachable behind an `aria-modal` overlay, and a screen-reader
 * user was never told the dialog had opened.
 */
export function useDialogChrome({
  modalRef,
  initialFocusRef,
  pending,
  onDismiss
}: {
  modalRef: RefObject<HTMLElement | null>
  /** Focused on mount. The recoverable choice, so Enter on arrival cancels. */
  initialFocusRef: RefObject<HTMLElement | null>
  pending: boolean
  onDismiss: () => void
}): void {
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null
    initialFocusRef.current?.focus()
    return () => returnTo?.focus?.()
    // Once, on mount: re-focusing whenever the ref identity changed would drag
    // focus back to Cancel while the user was tabbing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) onDismiss()
      if (event.key !== 'Tab' || !modalRef.current) return
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const inside = modalRef.current.contains(active)
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault()
        first.focus()
      }
    }
    const onClick = (event: MouseEvent): void => {
      if (pending) return
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) onDismiss()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [modalRef, pending, onDismiss])
}
