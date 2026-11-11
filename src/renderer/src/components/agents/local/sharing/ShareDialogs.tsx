import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Globe, Loader2, X } from 'lucide-react'
import { DIALOG_POPOVER_ATTR, SettingsButton, SettingsSwitch, useDialogChrome } from '../../../settings/SettingsLayout'
import { unwrapIpcError } from '../../../../utils/ipcError'
import { unwrapCatalogOutcome } from '../../../../../../shared/catalog'
import type {
  LibraryAccess,
  PersonSearchResult,
  ShareWithTeamInput,
  ShareWithTeamPerson
} from '../../../../../../shared/agentSharing'
import { SHARE_ACCESS_DESCRIPTION, SHARE_ACCESS_TEXT, SHARE_UI_TEXT } from '../../../../utils/shareText'
import {
  ManagedList,
  ManagedListAvatar,
  ManagedListBadge,
  ManagedListIconButton,
  ManagedListMessage,
  ManagedListPicker,
  ManagedListRow,
  type ManagedListPickerOption
} from '../../../ui/ManagedList'

/**
 * The sharing dialogs: Share changes (with its Bring together step), the
 * two-button conflict (plan S8), Discard the session's changes, Share with
 * the team, Share with a person and Remove sharing.
 *
 * None of them owns its action. The mutation lives in the component that opens
 * the dialog and outlives it — the status line, the ⋯ menu — so a result that
 * closes this dialog or opens the next one is a hook-level callback, which
 * TanStack runs even after the dialog has gone (ux_rules rule 5). Each closes
 * on success only and cannot be dismissed while its action runs; a refusal
 * renders under the field, last in the dialog, moving nothing above it.
 *
 * **One type scale: the Settings scale** (ui_guidelines "Typography"), for
 * every dialog built on {@link DialogShell} — the title at `text-base`, body,
 * labels, fields and buttons at 13, a section heading inside a dialog at 14
 * medium, mono values and chips at 12, badges at 11. A dialog that embeds a
 * settings-scale list (People in Who can use) would otherwise be two scales
 * at once. The classes below are that scale; a dialog takes them rather than
 * spelling its own sizes.
 */

export const PRIMARY =
  'inline-flex min-w-[6rem] items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50'
export const SECONDARY =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50'
export const CANCEL =
  'rounded-md px-3 py-1.5 text-[13px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)] disabled:opacity-50'
/** The danger-filled confirm (Discard, Remove sharing); give it a `min-w-*` for its longer label. */
export const DANGER =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-[13px] font-medium text-white ' +
  'transition-colors hover:opacity-90 disabled:opacity-50'
// Without a width, so a field can set its own: `w-full` beside a second
// width class wins or loses on stylesheet order, not on the class string.
// `settingsInputClass`'s shape, on `--color-bg`: one step from the glass surface.
export const FIELD_BASE =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-text)] ' +
  'placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60'
const FIELD = `w-full ${FIELD_BASE}`
/** A paragraph of the dialog's body. */
export const DIALOG_TEXT = 'text-[13px] leading-relaxed text-[var(--color-text-secondary)]'
/** A muted line: a note under a control, what a choice leaves as it is. */
export const DIALOG_NOTE = 'text-[13px] leading-relaxed text-[var(--color-text-muted)]'
/** A field's label, above it. */
export const DIALOG_LABEL = 'block text-[13px] text-[var(--color-text-muted)]'
/** A section's heading inside a dialog (Who can use it, Publish as). */
export const DIALOG_HEADING = 'text-[14px] font-medium text-[var(--color-text)]'
/** An identifier shown as a chip (a catalog id, a slot). */
export const DIALOG_CODE = 'rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]'

/**
 * The app-chrome buttons, for a surface outside the dialogs that keeps the
 * denser scale (the agent page's Bring together banner).
 */
export const CHROME_PRIMARY = PRIMARY.replace('text-[13px]', 'text-xs')
export const CHROME_SECONDARY = SECONDARY.replace('text-[13px]', 'text-xs')

export function DialogShell({
  title,
  pending,
  onDismiss,
  initialFocusRef,
  danger = false,
  width = 'w-[28rem]',
  align = 'center',
  overlayAttrs,
  children
}: {
  title: string
  pending: boolean
  onDismiss: () => void
  initialFocusRef: React.RefObject<HTMLElement | null>
  /** A destructive dialog's heading: danger-toned, with the warning glyph. */
  danger?: boolean
  /** Width class; the sharing dialogs share one. */
  width?: string
  /**
   * `top` pins the dialog's top edge so a row that grows or shrinks moves only
   * what is below it; `center` (the default) suits a dialog of fixed height.
   * A `top` dialog is also a flex column no taller than the window below its
   * offset: give the child that may grow `min-h-0 flex-1 overflow-y-auto` and
   * it scrolls inside, keeping the heading and the footer on screen.
   */
  align?: 'center' | 'top'
  /**
   * Extra attributes on the backdrop: a dialog opened from inside another
   * surface that closes on an outside click (the catalog dialog) marks itself
   * as part of that surface with them.
   */
  overlayAttrs?: Record<string, string>
  children: ReactNode
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  useDialogChrome({ modalRef, initialFocusRef, pending, onDismiss })
  // `center`: centred once, then its top stays where it opened, so a refusal
  // that lengthens the dialog under its buttons grows it downward and moves
  // nothing above (ux_rules rule 1). Measured before the first paint; a
  // window resize centres it afresh.
  const [pinnedTop, setPinnedTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (align !== 'center' || pinnedTop !== null || !modalRef.current) return
    setPinnedTop(Math.max(0, Math.round(modalRef.current.getBoundingClientRect().top)))
  }, [align, pinnedTop])
  useEffect(() => {
    if (align !== 'center') return
    const recentre = (): void => setPinnedTop(null)
    window.addEventListener('resize', recentre)
    return () => window.removeEventListener('resize', recentre)
  }, [align])
  const pinned = align === 'center' && pinnedTop !== null
  return createPortal(
    <div
      {...overlayAttrs}
      data-dialog-pinned={pinned ? '' : undefined}
      className={`fixed inset-0 z-50 flex justify-center bg-black/25 ${align === 'top' ? 'items-start pt-16' : pinned ? 'items-start' : 'items-center'}`}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        // The accessible name is the visible heading (ux_rules rule 10).
        aria-label={title}
        // Pinned, it may not run past the window's bottom: a refusal too long
        // for the room left scrolls inside it instead of moving it up.
        style={pinned ? { marginTop: pinnedTop, maxHeight: `calc(100vh - ${pinnedTop}px - 0.5rem)`, overflowY: 'auto' } : undefined}
        // `top`: 4rem above (`pt-16`) and 1rem below fit the window.
        className={`app-popover-surface ${width} ${align === 'top' ? 'flex max-h-[calc(100vh-5rem)] flex-col' : ''} space-y-3 rounded-lg border border-[var(--color-border)] p-5 shadow-xl`}
      >
        {danger ? (
          <div className="flex items-center gap-2 text-base font-semibold text-[var(--color-danger)]">
            <AlertTriangle size={18} aria-hidden="true" />
            {title}
          </div>
        ) : (
          <div className="text-base font-semibold text-[var(--color-text)]">{title}</div>
        )}
        {children}
      </div>
    </div>,
    document.body
  )
}

/**
 * A dialog's last rows: the buttons on the right, then — only when there is
 * one — what went wrong (or a notice) under them, full width and whole, last
 * in the dialog. A message that exists only on failure lengthens the dialog
 * downward and moves neither the buttons nor anything above them (ux_rules
 * rules 1 and 5): {@link DialogShell} keeps its top where it opened, and in a
 * dialog with a max height the scrolling body gives up the room instead.
 * `hint` follows the error in the same paragraph: a way out that only a
 * refusal calls for.
 */
export function DialogFooter({
  error,
  hint,
  notice,
  children
}: {
  error: string | null
  /** Said after the error, in the same alert; ignored without one. */
  hint?: string | null
  /** A neutral line in the error's place, while there is none. */
  notice?: string | null
  /** The buttons, Cancel first. */
  children: ReactNode
}): React.JSX.Element {
  return (
    <div data-dialog-footer className="shrink-0 space-y-2">
      <div data-dialog-buttons className="flex items-center justify-end gap-2">
        {children}
      </div>
      {error ? (
        <p role="alert" data-dialog-message className="text-[13px] leading-5 text-[var(--color-danger)]">
          {error}
          {hint && <> {hint}</>}
        </p>
      ) : notice ? (
        <p role="status" data-dialog-message className="text-[13px] leading-5 text-[var(--color-text-secondary)]">
          {notice}
        </p>
      ) : null}
    </div>
  )
}

/** A refusal as a paragraph of its own, for a dialog that keeps one (Improvement request); the sharing dialogs use {@link DialogFooter}. */
export function ErrorLine({ error }: { error: string | null }): React.JSX.Element | null {
  if (!error) return null
  return (
    <p role="alert" className="text-[13px] leading-relaxed text-[var(--color-danger)]">
      {error}
    </p>
  )
}

/**
 * Share changes: one field for what changed, pre-filled by an AI summary.
 *
 * The field is there and editable from the first frame, with "Writing a
 * summary…" as its placeholder; the draft fills it only if the user has not
 * typed, so a slow summary never overwrites their words. After Finish the
 * field starts with the session's own summary (`initialMessage`) and no draft
 * is asked for.
 *
 * `combineFirst` is the step before the field, when both sides moved: the
 * one sentence and **Bring together** in place of Share — the silent combine
 * inside a send is what the session replaces. The same width as the field
 * step, so moving between them changes only the height (ux_rules rule 1).
 */
export function ShareChangesDialog({
  agentId,
  pending,
  error,
  combineFirst = false,
  onBringTogether,
  bringTogetherPending = false,
  initialMessage = null,
  onShare,
  onCancel
}: {
  agentId: string
  pending: boolean
  error: string | null
  /** Show the Bring together step instead of the field. */
  combineFirst?: boolean
  onBringTogether?: () => void
  bringTogetherPending?: boolean
  /** What the field starts with; null asks main for a draft. */
  initialMessage?: string | null
  onShare: (message: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const bringRef = useRef<HTMLButtonElement>(null)
  const [message, setMessage] = useState(initialMessage ?? '')
  const [drafting, setDrafting] = useState(initialMessage === null)
  const touched = useRef(false)

  useEffect(() => {
    // The session's summary is the field's text; a draft would say it twice.
    // On the Bring together step there is no field yet to fill.
    if (combineFirst || initialMessage !== null) return
    let cancelled = false
    void window.api.sharing
      .draftMessage(agentId)
      .then((outcome) => {
        if (cancelled) return
        const draft = unwrapCatalogOutcome(outcome)
        if (!touched.current && draft) setMessage(draft)
      })
      // No summary is no loss: the field is the user's either way.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDrafting(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId, combineFirst, initialMessage])

  const submit = (): void => {
    if (pending) return
    onShare(message.trim())
  }

  if (combineFirst) {
    return (
      <DialogShell
        title={SHARE_UI_TEXT.shareChangesTitle}
        pending={bringTogetherPending}
        onDismiss={onCancel}
        initialFocusRef={bringRef}
      >
        <p data-share-combine className={DIALOG_TEXT}>
          {SHARE_UI_TEXT.bringTogetherBanner}
        </p>
        <DialogFooter error={error}>
          <button type="button" onClick={onCancel} disabled={bringTogetherPending} className={CANCEL}>
            {SHARE_UI_TEXT.cancel}
          </button>
          <button
            ref={bringRef}
            type="button"
            onClick={onBringTogether}
            disabled={bringTogetherPending}
            aria-busy={bringTogetherPending}
            className={PRIMARY}
          >
            {bringTogetherPending ? (
              <>
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                {SHARE_UI_TEXT.bringingTogether}
              </>
            ) : (
              SHARE_UI_TEXT.bringTogether
            )}
          </button>
        </DialogFooter>
      </DialogShell>
    )
  }

  return (
    <DialogShell
      title={SHARE_UI_TEXT.shareChangesTitle}
      pending={pending}
      onDismiss={onCancel}
      initialFocusRef={fieldRef}
    >
      <label className="block space-y-1">
        <span className={DIALOG_LABEL}>{SHARE_UI_TEXT.shareChangesLabel}</span>
        <textarea
          ref={fieldRef}
          rows={4}
          value={message}
          disabled={pending}
          placeholder={drafting ? SHARE_UI_TEXT.shareChangesPlaceholder : SHARE_UI_TEXT.shareChangesEmptyPlaceholder}
          onChange={(event) => {
            touched.current = true
            setMessage(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submit()
            }
          }}
          className={`${FIELD} resize-none`}
        />
      </label>
      <DialogFooter error={error}>
        <button type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SHARE_UI_TEXT.cancel}
        </button>
        <button type="button" onClick={submit} disabled={pending} aria-busy={pending} className={PRIMARY}>
          {pending ? (
            <>
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.sharing}
            </>
          ) : (
            SHARE_UI_TEXT.share
          )}
        </button>
      </DialogFooter>
    </DialogShell>
  )
}

/**
 * Discard the session's changes (adoption plan D6): what is kept is said
 * first — the team's version and this machine's own recorded changes — then
 * what is dropped. Cancel takes focus; undismissable while it runs (ux_rules
 * rule 5), and a refusal stays here.
 */
export function DiscardAdoptionDialog({
  name,
  pending,
  error,
  onDiscard,
  onCancel
}: {
  name: string
  pending: boolean
  error: string | null
  onDiscard: () => void
  onCancel: () => void
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <DialogShell
      title={SHARE_UI_TEXT.discardTitle}
      pending={pending}
      onDismiss={onCancel}
      initialFocusRef={cancelRef}
      danger
    >
      <p className={DIALOG_TEXT}>{SHARE_UI_TEXT.discardBody(name)}</p>
      <DialogFooter error={error}>
        <button ref={cancelRef} type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SHARE_UI_TEXT.cancel}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={pending}
          aria-busy={pending}
          // A fixed width, so the shorter "Discarding…" does not pull Cancel sideways.
          className={`${DANGER} min-w-[9rem]`}
        >
          {pending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
          {pending ? SHARE_UI_TEXT.discarding : SHARE_UI_TEXT.discardConfirm}
        </button>
      </DialogFooter>
    </DialogShell>
  )
}

/**
 * The team changed this agent too (plan S8): two buttons, never a diff view.
 * The recoverable choice — keep working, share later — takes focus.
 */
export function ShareConflictDialog({
  pending,
  error,
  onUseTeamVersion,
  onKeepMine
}: {
  pending: boolean
  error: string | null
  onUseTeamVersion: () => void
  onKeepMine: () => void
}): React.JSX.Element {
  const keepRef = useRef<HTMLButtonElement>(null)
  return (
    <DialogShell
      title={SHARE_UI_TEXT.conflictTitle}
      pending={pending}
      onDismiss={onKeepMine}
      initialFocusRef={keepRef}
      // Wide enough for both long labels side by side on one line each.
      width="w-[40rem]"
    >
      <p className={DIALOG_TEXT}>{SHARE_UI_TEXT.conflictBody}</p>
      {/* The footer every dialog has: the recoverable choice first, the one
          that replaces work last and filled (ui_guidelines "Button Layout"). */}
      <DialogFooter error={error}>
        <button ref={keepRef} type="button" onClick={onKeepMine} disabled={pending} className={`${SECONDARY} whitespace-nowrap`}>
          {SHARE_UI_TEXT.keepMine}
        </button>
        <button type="button" onClick={onUseTeamVersion} disabled={pending} aria-busy={pending} className={`${PRIMARY} whitespace-nowrap`}>
          {pending ? (
            <>
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.usingTeamVersion}
            </>
          ) : (
            SHARE_UI_TEXT.useTeamVersion
          )}
        </button>
      </DialogFooter>
    </DialogShell>
  )
}

const ACCESS_CHOICES: LibraryAccess[] = ['use', 'edit', 'maintain']

/** Can use / Can edit / Maintainer, each with what it adds: the People list's own menu. */
const ACCESS_OPTIONS: ManagedListPickerOption<LibraryAccess>[] = ACCESS_CHOICES.map((access) => ({
  value: access,
  label: SHARE_ACCESS_TEXT[access],
  description: SHARE_ACCESS_DESCRIPTION[access]
}))

/**
 * Make public, the People list's header button (ux_rules rule 13): a globe
 * whose spinner takes its place while it runs, so the label never moves.
 */
export function MakePublicButton({
  busy = false,
  disabled,
  onClick
}: {
  busy?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <SettingsButton onClick={onClick} disabled={disabled} aria-busy={busy}>
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Globe size={13} aria-hidden="true" />}
      {SHARE_UI_TEXT.shareWithEveryone}
    </SettingsButton>
  )
}

/**
 * Focus across Make public and the Everyone row's X, which each take the
 * other's place: the control that was pressed is gone, so focus would fall to
 * the page. After Make public it goes to Everyone's X, after that X back to
 * Make public — unless the user has already moved it somewhere else.
 * The refs go to {@link WhoCanUseHeading} and {@link ChosenPeopleList}.
 */
export function useEveryoneFocusHandOff(everyone: boolean): {
  makePublicRef: React.RefObject<HTMLSpanElement | null>
  removeEveryoneRef: React.RefObject<HTMLButtonElement | null>
} {
  const makePublicRef = useRef<HTMLSpanElement>(null)
  const removeEveryoneRef = useRef<HTMLButtonElement>(null)
  const previous = useRef(everyone)
  useEffect(() => {
    if (previous.current === everyone) return
    previous.current = everyone
    const active = document.activeElement
    if (active && active !== document.body) return
    const target = everyone ? removeEveryoneRef.current : makePublicRef.current?.querySelector('button')
    // Into view if the scroll area hides it, so its focus ring is seen.
    target?.focus({ preventScroll: true })
    target?.scrollIntoView?.({ block: 'nearest' })
  }, [everyone])
  return { makePublicRef, removeEveryoneRef }
}

/**
 * "Who can use it" with Make public on its right while Everyone is off. The
 * row is one Make public tall in every state: a hidden copy of the button
 * holds the height in the same grid cell, so hiding it moves nothing below
 * (ux_rules rule 1) and the reserve cannot drift from the button's size.
 */
export function WhoCanUseHeading({
  title,
  everyone,
  disabled,
  onMakePublic,
  makePublicRef
}: {
  title: string
  everyone: boolean
  disabled: boolean
  onMakePublic: () => void
  /** From {@link useEveryoneFocusHandOff}. */
  makePublicRef: React.RefObject<HTMLSpanElement | null>
}): React.JSX.Element {
  return (
    <div data-who-can-use-heading className="flex items-center gap-2">
      <span className={DIALOG_HEADING}>{title}</span>
      <div className="flex-1" />
      <div className="grid">
        <span aria-hidden="true" inert className="invisible col-start-1 row-start-1">
          <MakePublicButton disabled onClick={() => {}} />
        </span>
        <span ref={makePublicRef} className="col-start-1 row-start-1 flex justify-end">
          {!everyone && <MakePublicButton disabled={disabled} onClick={onMakePublic} />}
        </span>
      </div>
    </div>
  )
}

/** A remove that lands this soon after the previous one is the same double click, not a new choice. */
export const REMOVE_REPEAT_MS = 500

/** How long typing settles before the server is asked. */
const SEARCH_DEBOUNCE_MS = 250

type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching'; results: PersonSearchResult[] }
  | { kind: 'done'; results: PersonSearchResult[] }
  | { kind: 'failed'; why: string | null }

/**
 * People on the server, by name or email, asked for once typing settles. A
 * slower answer to an older query never replaces a newer one.
 */
function usePeopleSearch(query: string): SearchState {
  const [state, setState] = useState<SearchState>({ kind: 'idle' })
  const latest = useRef(0)
  useEffect(() => {
    const q = query.trim()
    const ticket = ++latest.current
    if (q.length < 2) {
      setState({ kind: 'idle' })
      return
    }
    // The list on screen stays while the next answer is on its way.
    setState((prev) => ({ kind: 'searching', results: 'results' in prev ? prev.results : [] }))
    const timer = setTimeout(() => {
      void window.api.sharing
        .searchPeople(q)
        .then((outcome) => {
          if (ticket === latest.current) setState({ kind: 'done', results: unwrapCatalogOutcome(outcome) })
        })
        .catch((err: unknown) => {
          if (ticket === latest.current) setState({ kind: 'failed', why: err instanceof Error ? unwrapIpcError(err) : null })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
  return state
}

/** `Name <email>`, dropping the email when it would repeat the name (ux_rules rule 13). */
export function personLabel(person: Pick<PersonSearchResult, 'name' | 'email'>): string {
  if (!person.email || person.email === person.name) return person.name
  return `${person.name} <${person.email}>`
}

/** Gap between the field and its dropdown, and the least kept to the window's edge. */
const DROPDOWN_GAP = 4
const DROPDOWN_EDGE = 8

/**
 * Where a field's portaled dropdown goes: `position: fixed`, as wide as the
 * field, just below it, or just above it when it does not fit below and there
 * is more room above. Re-measured on resize, on any scroll (the dialog body
 * scrolls) and when the list or the dialog changes size, so it stays on the
 * field. Null until measured.
 */
function useFieldDropdownPosition(
  open: boolean,
  fieldRef: React.RefObject<HTMLElement | null>,
  listRef: React.RefObject<HTMLElement | null>
): React.CSSProperties | null {
  const [pos, setPos] = useState<React.CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const measure = (): void => {
      const field = fieldRef.current
      if (!field) return
      const r = field.getBoundingClientRect()
      const height = listRef.current?.getBoundingClientRect().height ?? 0
      const below = window.innerHeight - DROPDOWN_EDGE - (r.bottom + DROPDOWN_GAP)
      const above = r.top - DROPDOWN_GAP - DROPDOWN_EDGE
      const flip = height > below && above > below
      setPos(
        flip
          ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + DROPDOWN_GAP }
          : { left: r.left, width: r.width, top: r.bottom + DROPDOWN_GAP }
      )
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    // Answers arriving change the list's height (and so whether it fits below),
    // and a chip added above the field moves it without a scroll.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (listRef.current) observer?.observe(listRef.current)
    const dialog = fieldRef.current?.closest('[role="dialog"]')
    if (dialog) observer?.observe(dialog)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      observer?.disconnect()
    }
  }, [open, fieldRef, listRef])
  return pos
}

/**
 * A search field over the server's people, with its answers in a dropdown.
 *
 * **The dropdown floats over what is below it**, so opening, narrowing and
 * closing it while the user types moves nothing in the dialog (ux_rules rule
 * 1). It is portaled to the body and fixed to the field, so the dialog's
 * scrolling body never cuts it off. It opens once two letters are typed and closes on a pick, on Escape
 * (which then does not close the dialog) and when focus leaves the field.
 * Arrow keys move through the answers and Enter picks the highlighted one.
 *
 * `keepPick` leaves the picked person's name in the field, for a dialog that
 * adds one person; otherwise the field empties for the next one. Editing the
 * field after a pick calls `onEdit`, so the dialog can drop that pick.
 */
export function PeopleSearch({
  disabled,
  exclude,
  keepPick = false,
  onPick,
  onEdit,
  inputRef
}: {
  disabled?: boolean
  /** People already on the list, left out of the answers. */
  exclude: ReadonlySet<string>
  keepPick?: boolean
  onPick: (person: PersonSearchResult) => void
  onEdit?: () => void
  inputRef?: React.RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  // A pick puts its name in the field; that name is not a new search.
  const [picked, setPicked] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const search = usePeopleSearch(picked ? '' : query)
  const results = 'results' in search ? search.results.filter((person) => !exclude.has(person.userId)) : []
  let message: string | null = null
  if (search.kind === 'failed')
    message = search.why ? SHARE_UI_TEXT.peopleSearchFailedBecause(search.why) : SHARE_UI_TEXT.peopleSearchFailed
  else if (results.length === 0) message = search.kind === 'searching' ? SHARE_UI_TEXT.peopleSearching : SHARE_UI_TEXT.peopleNoneFound
  const shown = open && !picked && search.kind !== 'idle'
  const highlighted = Math.min(active, Math.max(results.length - 1, 0))
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const listPos = useFieldDropdownPosition(shown, fieldRef, listRef)

  const pick = (person: PersonSearchResult): void => {
    onPick(person)
    setOpen(false)
    setActive(0)
    if (keepPick) {
      setQuery(personLabel(person))
      setPicked(true)
    } else {
      setQuery('')
    }
  }

  return (
    <label className="block space-y-1">
      <span className={DIALOG_LABEL}>{SHARE_UI_TEXT.peopleSearchLabel}</span>
      <div className="relative">
        <input
          ref={(node) => {
            fieldRef.current = node
            if (inputRef) inputRef.current = node
          }}
          type="search"
          role="combobox"
          aria-expanded={shown}
          aria-controls="share-people-results"
          aria-autocomplete="list"
          value={query}
          disabled={disabled}
          placeholder={SHARE_UI_TEXT.peopleSearchPlaceholder}
          onChange={(event) => {
            if (picked) onEdit?.()
            setPicked(false)
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && shown) {
              // Closes the list, not the dialog.
              event.preventDefault()
              event.stopPropagation()
              event.nativeEvent.stopImmediatePropagation()
              setOpen(false)
            } else if (event.key === 'ArrowDown' && results.length > 0) {
              event.preventDefault()
              setOpen(true)
              setActive((i) => Math.min(i + 1, results.length - 1))
            } else if (event.key === 'ArrowUp' && results.length > 0) {
              event.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (event.key === 'Enter') {
              // Never submits the dialog; picks only what is highlighted.
              event.preventDefault()
              if (shown && results[highlighted]) pick(results[highlighted])
            }
          }}
          // Chromium's own clear ×, blue and off the palette, is hidden on this field only; Escape still clears.
          className={`${FIELD} [&::-webkit-search-cancel-button]:appearance-none`}
        />
        {shown && createPortal(
          <div
            ref={listRef}
            id="share-people-results"
            role="listbox"
            aria-label={SHARE_UI_TEXT.peopleSearchLabel}
            data-people-results
            {...{ [DIALOG_POPOVER_ATTR]: '' }}
            // Before the input's blur, so a click on an answer lands.
            onMouseDown={(event) => event.preventDefault()}
            // Portaled and fixed to the field: inside the dialog's scrolling
            // body an absolute list was cut off at the dialog's edge.
            style={listPos ?? { visibility: 'hidden' }}
            // Four rows and a half, so a longer list shows it scrolls.
            className="fixed z-[60] max-h-[calc(4.5*2.25rem+0.25rem)] overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-0.5 shadow-lg"
          >
            {message !== null ? (
              <p className="px-2.5 py-2 text-[13px] text-[var(--color-text-muted)]">{message}</p>
            ) : (
              results.map((person, index) => {
                // Drawn like the row it becomes in the list below (ux_rules rule 13).
                const email = person.email && person.email !== person.name ? person.email : null
                return (
                  <button
                    key={person.userId}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === highlighted}
                    // The name a screen reader hears, as one label: `Name <email>`.
                    aria-label={personLabel(person)}
                    title={personLabel(person)}
                    onClick={() => pick(person)}
                    onMouseEnter={() => setActive(index)}
                    className={`flex h-9 w-full items-center gap-2.5 px-2.5 text-left ${
                      index === highlighted ? 'bg-[var(--color-bg-hover)]' : ''
                    }`}
                  >
                    <ManagedListAvatar name={person.name} />
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="min-w-0 truncate text-[14px] font-medium text-[var(--color-text)]">{person.name}</span>
                      {email && (
                        <span className="min-w-0 shrink-[1000] truncate text-[12px] text-[var(--color-text-muted)]">{email}</span>
                      )}
                    </span>
                  </button>
                )
              })
            )}
          </div>,
          document.body
        )}
      </div>
    </label>
  )
}

/** A person chosen in Share with the team, with the name to show. */
export interface ChosenPerson extends ShareWithTeamPerson {
  label: string
}

/**
 * The people a first share gives access to, each with what they may do and a
 * remove. A fixed height, filled in every state ("Only you, for now." when
 * empty), so a pick or a removal moves nothing below it (ux_rules rule 1).
 *
 * `everyone` puts Everyone on this server at the top while it is on, drawn as
 * People draws it — the globe, Can use as a fixed badge — with an X that turns
 * it off at once, since nothing is sent yet. The height does not change with it.
 */
export function ChosenPeopleList({
  people,
  disabled,
  onChange,
  emptyText = SHARE_UI_TEXT.peopleOnlyMe,
  everyone,
  unsent
}: {
  people: ChosenPerson[]
  disabled: boolean
  onChange: (update: (list: ChosenPerson[]) => ChosenPerson[]) => void
  emptyText?: string
  /** Whether Everyone is on, and turning it off; `removeRef` from {@link useEveryoneFocusHandOff}. */
  everyone?: { on: boolean; onRemove: () => void; removeRef?: React.Ref<HTMLButtonElement> }
  /**
   * People listed but not sent as they stand (a share to everyone already
   * covers Can use): `title` is the person's sentence, `note` the one line
   * beside the list's label. Each such name is struck through in place, so
   * the list never shows what will not happen and nothing moves (rule 1).
   */
  unsent?: { is: (person: ChosenPerson) => boolean; title: (person: ChosenPerson) => string; note: string }
}): React.JSX.Element {
  const anyUnsent = unsent !== undefined && people.some((person) => unsent.is(person))
  // A removal brings the next row's X under the pointer: the second click of
  // a double click would take off someone the user never chose.
  const lastRemoval = useRef(Number.NEGATIVE_INFINITY)
  const remove = (action: () => void): void => {
    const now = Date.now()
    if (now - lastRemoval.current < REMOVE_REPEAT_MS) return
    lastRemoval.current = now
    action()
  }
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="shrink-0 text-[var(--color-text-muted)]">{SHARE_UI_TEXT.peopleLabel}</span>
        {anyUnsent && (
          <span data-people-note title={unsent.note} className="min-w-0 truncate text-[var(--color-text-muted)]">
            {unsent.note}
          </span>
        )}
      </div>
      {/* The People list's rows (ux_rules rule 13), in a surface of fixed
          height that scrolls: a pick, a removal or Everyone moves nothing
          below it. Two rows and a half (in the scale's row height, plus the
          surface's padding), so a third row shows the list scrolls. */}
      <div data-chosen-people>
        <ManagedList
          aria-label={SHARE_UI_TEXT.peopleLabel}
          surfaceClassName="h-[calc(2.5*var(--ml-row-h)+6px)] overflow-y-auto"
          message={people.length === 0 ? <ManagedListMessage>{emptyText}</ManagedListMessage> : undefined}
        >
          {everyone?.on && (
            <ManagedListRow
              key="everyone"
              lead={<Globe size={16} aria-hidden="true" />}
              title={SHARE_UI_TEXT.everyone}
              titleTooltip={SHARE_UI_TEXT.everyone}
              trailing={
                <>
                  {/* Everyone can only use it: that is what sharing with everyone means. */}
                  <ManagedListBadge>{SHARE_ACCESS_TEXT.use}</ManagedListBadge>
                  <ManagedListIconButton
                    title={SHARE_UI_TEXT.removeFromList(SHARE_UI_TEXT.everyone)}
                    aria-label={SHARE_UI_TEXT.removeFromList(SHARE_UI_TEXT.everyone)}
                    ref={everyone.removeRef}
                    disabled={disabled}
                    onClick={() => remove(everyone.onRemove)}
                  >
                    <X size={15} aria-hidden="true" />
                  </ManagedListIconButton>
                </>
              }
            />
          )}
          {people.map((person) => {
            const { name, email } = splitPersonLabel(person.label)
            const notSent = unsent?.is(person) === true
            return (
              <ManagedListRow
                key={person.userId}
                lead={<ManagedListAvatar name={name} />}
                title={
                  notSent ? (
                    <span data-unsent className="text-[var(--color-text-muted)] line-through" title={unsent!.title(person)}>
                      {name}
                    </span>
                  ) : (
                    name
                  )
                }
                titleTooltip={notSent ? undefined : person.label}
                meta={email ?? undefined}
                trailing={
                  <>
                    <ManagedListPicker
                      value={person.access}
                      options={ACCESS_OPTIONS}
                      menuLabel={SHARE_UI_TEXT.accessFor(person.label)}
                      disabled={disabled}
                      onChange={(access) =>
                        onChange((list) => list.map((p) => (p.userId === person.userId ? { ...p, access } : p)))
                      }
                    />
                    {/* Nothing is sent yet, so one click takes them off the list. */}
                    <ManagedListIconButton
                      title={SHARE_UI_TEXT.removeFromList(name)}
                      aria-label={SHARE_UI_TEXT.removeFromList(name)}
                      disabled={disabled}
                      onClick={() => remove(() => onChange((list) => list.filter((p) => p.userId !== person.userId)))}
                    >
                      <X size={15} aria-hidden="true" />
                    </ManagedListIconButton>
                  </>
                }
              />
            )
          })}
        </ManagedList>
      </div>
    </div>
  )
}

/** "Bob <bob@x.test>" → the name as the title, the email as the row's meta. */
function splitPersonLabel(label: string): { name: string; email: string | null } {
  const match = /^(.*\S)\s*<([^<>]+)>$/.exec(label.trim())
  return match ? { name: match[1], email: match[2] } : { name: label, email: null }
}

/**
 * Share with the team: a name, and who may get it.
 *
 * No description: main sends the manifest's. The name is there from the first
 * frame and the draft fills it unless the user has typed. Who can use it is
 * People's model, as in the skill Share dialog: **Make public** beside the
 * heading puts an Everyone row at the top of the chosen list, whose X takes it
 * off again; off by default. People are picked from a search; each starts
 * as "Can use", and an empty list with Everyone unticked means only the
 * sharer. Unlike a skill, a named person at Can use is sent beside Everyone
 * (core keeps an agent's grants under `public`), so removing Everyone later
 * in People leaves them their access. The chosen list has a fixed height,
 * filled in every state, so a pick moves nothing below it (ux_rules rule 1).
 */
export function ShareWithTeamDialog({
  agentId,
  pending,
  error,
  onShare,
  onCancel
}: {
  agentId: string
  pending: boolean
  error: string | null
  onShare: (input: ShareWithTeamInput) => void
  onCancel: () => void
}): React.JSX.Element {
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [people, setPeople] = useState<ChosenPerson[]>([])
  const [everyone, setEveryone] = useState(false)
  const { makePublicRef, removeEveryoneRef } = useEveryoneFocusHandOff(everyone)
  const [loading, setLoading] = useState(true)
  const [draftError, setDraftError] = useState<string | null>(null)
  const touched = useRef(false)

  useEffect(() => {
    let cancelled = false
    void window.api.sharing
      .shareWithTeamDraft(agentId)
      .then((outcome) => {
        if (cancelled) return
        const draft = unwrapCatalogOutcome(outcome)
        if (!touched.current) setName(draft.name)
      })
      .catch((err) => {
        if (!cancelled) setDraftError(unwrapIpcError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const submit = (): void => {
    if (pending || name.trim() === '') return
    onShare({ name: name.trim(), people: people.map(({ userId, access }) => ({ userId, access })), everyone })
  }

  return (
    <DialogShell title={SHARE_UI_TEXT.shareWithTeamTitle} pending={pending} onDismiss={onCancel} initialFocusRef={nameRef}>
      <p className={DIALOG_TEXT}>{SHARE_UI_TEXT.shareWithTeamBody}</p>
      <label className="block space-y-1">
        <span className={DIALOG_LABEL}>{SHARE_UI_TEXT.nameLabel}</span>
        <input
          ref={nameRef}
          type="text"
          value={name}
          disabled={pending}
          placeholder={loading ? SHARE_UI_TEXT.loadingDraft : undefined}
          onChange={(event) => {
            touched.current = true
            setName(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          className={FIELD}
        />
      </label>
      {/* As in People: Make public is offered while it would change something, so hidden once Everyone is on. */}
      <WhoCanUseHeading
        title={SHARE_UI_TEXT.whoCanUse}
        everyone={everyone}
        disabled={pending}
        onMakePublic={() => setEveryone(true)}
        makePublicRef={makePublicRef}
      />
      <PeopleSearch
        disabled={pending}
        exclude={new Set(people.map((person) => person.userId))}
        onPick={(person) =>
          setPeople((list) => [...list, { userId: person.userId, access: 'use', label: personLabel(person) }])
        }
      />
      <ChosenPeopleList
        people={people}
        disabled={pending}
        onChange={setPeople}
        emptyText={everyone ? SHARE_UI_TEXT.peopleNoOneNamed : undefined}
        everyone={{ on: everyone, onRemove: () => setEveryone(false), removeRef: removeEveryoneRef }}
      />
      <DialogFooter error={error ?? draftError}>
        <button type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SHARE_UI_TEXT.cancel}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending || name.trim() === ''}
          aria-busy={pending}
          className={PRIMARY}
        >
          {pending ? (
            <>
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.sharing}
            </>
          ) : (
            SHARE_UI_TEXT.share
          )}
        </button>
      </DialogFooter>
    </DialogShell>
  )
}

/**
 * Share with a person (Sharing tab → People): find someone, choose what they
 * may do — "Can use" unless changed — and Add. The picked person stays in the
 * search field, beside what they may do; editing the field drops the pick. A
 * refusal from the server stays here and closes nothing.
 */
export function ShareWithPersonDialog({
  exclude,
  pending,
  error,
  onAdd,
  onCancel,
  overlayAttrs
}: {
  /** Who already has access, left out of the answers. */
  exclude: ReadonlySet<string>
  pending: boolean
  error: string | null
  onAdd: (person: PersonSearchResult, access: LibraryAccess) => void
  onCancel: () => void
  /** The backdrop's marks when it opens over a dialog that itself marks its backdrop (Who can use over the catalog). */
  overlayAttrs?: Record<string, string>
}): React.JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null)
  return (
    <DialogShell title={SHARE_UI_TEXT.shareWithPersonTitle} pending={pending} onDismiss={onCancel} initialFocusRef={searchRef} overlayAttrs={overlayAttrs}>
      <ShareWithPersonForm exclude={exclude} pending={pending} error={error} onAdd={onAdd} onCancel={onCancel} inputRef={searchRef} />
    </DialogShell>
  )
}

/**
 * The body of {@link ShareWithPersonDialog} — the search, what they may do,
 * the refusal and Cancel / Add.
 */
export function ShareWithPersonForm({
  exclude,
  pending,
  error,
  onAdd,
  onCancel,
  inputRef
}: {
  exclude: ReadonlySet<string>
  pending: boolean
  error: string | null
  onAdd: (person: PersonSearchResult, access: LibraryAccess) => void
  onCancel: () => void
  inputRef?: React.RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const ownRef = useRef<HTMLInputElement>(null)
  const searchRef = inputRef ?? ownRef
  const [person, setPerson] = useState<PersonSearchResult | null>(null)
  const [access, setAccess] = useState<LibraryAccess>('use')
  return (
    <>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <PeopleSearch
            disabled={pending}
            exclude={exclude}
            keepPick
            onPick={setPerson}
            onEdit={() => setPerson(null)}
            inputRef={searchRef}
          />
        </div>
        {/* People's access menu, as a field beside the search: labelled above
            like it, the search's height, value and caret (ux_rules rule 11). */}
        <div className="shrink-0 space-y-1">
          <span aria-hidden="true" className={DIALOG_LABEL}>
            {SHARE_UI_TEXT.accessLabel}
          </span>
          <ManagedListPicker
            variant="field"
            value={access}
            options={ACCESS_OPTIONS}
            label={SHARE_UI_TEXT.accessLabel}
            menuLabel={SHARE_UI_TEXT.accessLabel}
            disabled={pending}
            onChange={setAccess}
            className="w-[8.5rem]"
          />
        </div>
      </div>
      <DialogFooter error={error}>
        <button type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SHARE_UI_TEXT.cancel}
        </button>
        <button
          type="button"
          onClick={() => person && onAdd(person, access)}
          disabled={pending || person === null}
          aria-busy={pending}
          className={PRIMARY}
        >
          {pending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
          {SHARE_UI_TEXT.addPerson}
        </button>
      </DialogFooter>
    </>
  )
}

/**
 * Remove sharing: confirm before this folder is disconnected from the team,
 * in the ⋯ menu's "Remove from this computer…" style. The recoverable part is
 * said first — the folder and its history stay. `offerDelete` adds a switch,
 * off, "also delete it from the team library", for a maintainer of an
 * entry the library still lists. Undismissable while it runs; a refusal stays
 * here and closes nothing.
 */
export function RemoveSharingDialog({
  agentName,
  offerDelete,
  pending,
  error,
  onChoiceChange,
  onConfirm,
  onCancel
}: {
  agentName: string
  offerDelete: boolean
  pending: boolean
  error: string | null
  /** The delete switch was turned on or off: the caller clears a refusal that answered the old choice. */
  onChoiceChange?: () => void
  onConfirm: (deleteFromLibrary: boolean) => void
  onCancel: () => void
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [alsoDelete, setAlsoDelete] = useState(false)
  const switchId = useId()
  const deleting = offerDelete && alsoDelete
  return (
    <DialogShell
      title={SHARE_UI_TEXT.removeSharingTitle}
      pending={pending}
      onDismiss={onCancel}
      initialFocusRef={cancelRef}
      danger
      // Wide enough for the switch's label on one line at the dialogs' 13px.
      width="w-[32rem]"
    >
      <p className={DIALOG_TEXT}>
        {SHARE_UI_TEXT.removeSharingBody(agentName)}
      </p>
      {/* One switch, named after the non-default state (ux_rules rule 14). */}
      {offerDelete && (
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={switchId} className="min-w-0 cursor-pointer text-[13px] text-[var(--color-text)]">
            {SHARE_UI_TEXT.alsoDeleteFromLibrary}
          </label>
          <SettingsSwitch
            id={switchId}
            checked={alsoDelete}
            disabled={pending}
            onToggle={() => {
              setAlsoDelete((on) => !on)
              onChoiceChange?.()
            }}
          />
        </div>
      )}
      {/* A refused delete ("2 people use this…") still leaves the way out:
          removing sharing here alone needs no one's say. */}
      <DialogFooter error={error} hint={error && deleting ? SHARE_UI_TEXT.removeSharingOnlyHint : null}>
        <button ref={cancelRef} type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SHARE_UI_TEXT.cancel}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(deleting)}
          disabled={pending}
          aria-busy={pending}
          // A fixed width, so the shorter "Removing…" does not pull Cancel sideways.
          className={`${DANGER} min-w-[8.5rem]`}
        >
          {pending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
          {pending ? SHARE_UI_TEXT.removingSharing : SHARE_UI_TEXT.removeSharingConfirm}
        </button>
      </DialogFooter>
    </DialogShell>
  )
}
