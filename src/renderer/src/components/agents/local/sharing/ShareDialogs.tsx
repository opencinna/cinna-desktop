import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useDialogChrome } from '../../../settings/SettingsLayout'
import { unwrapIpcError } from '../../../../utils/ipcError'
import { unwrapCatalogOutcome } from '../../../../../../shared/catalog'
import type {
  LibraryAccess,
  PersonSearchResult,
  ShareWithTeamInput,
  ShareWithTeamPerson
} from '../../../../../../shared/agentSharing'
import { SHARE_ACCESS_TEXT, SHARE_UI_TEXT } from '../../../../utils/shareText'

/**
 * The sharing dialogs: Share changes, the two-button conflict (plan S8),
 * Share with the team, Share with a person and Remove sharing.
 *
 * None of them owns its action. The mutation lives in the component that opens
 * the dialog and outlives it — the status line, the ⋯ menu — so a result that
 * closes this dialog or opens the next one is a hook-level callback, which
 * TanStack runs even after the dialog has gone (ux_rules rule 5). Each closes
 * on success only and cannot be dismissed while its action runs; a refusal
 * renders under the field, last in the dialog, moving nothing above it.
 */

export const PRIMARY =
  'inline-flex min-w-[6rem] items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50'
export const SECONDARY =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50'
export const CANCEL =
  'rounded-md px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)] disabled:opacity-50'
// Without a width, so a field can set its own: `w-full` beside a second
// width class wins or loses on stylesheet order, not on the class string.
export const FIELD_BASE =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-xs text-[var(--color-text)] ' +
  'placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60'
const FIELD = `w-full ${FIELD_BASE}`

export function DialogShell({
  title,
  pending,
  onDismiss,
  initialFocusRef,
  danger = false,
  width = 'w-[28rem]',
  align = 'center',
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
  children: ReactNode
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  useDialogChrome({ modalRef, initialFocusRef, pending, onDismiss })
  return createPortal(
    <div className={`fixed inset-0 z-50 flex justify-center bg-black/25 ${align === 'top' ? 'items-start pt-16' : 'items-center'}`}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        // The accessible name is the visible heading (ux_rules rule 10).
        aria-label={title}
        // `top`: 4rem above (`pt-16`) and 1rem below fit the window.
        className={`app-popover-surface ${width} ${align === 'top' ? 'flex max-h-[calc(100vh-5rem)] flex-col' : ''} space-y-3 rounded-lg border border-[var(--color-border)] p-5 shadow-xl`}
      >
        {danger ? (
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-danger)]">
            <AlertTriangle size={16} aria-hidden="true" />
            {title}
          </div>
        ) : (
          <div className="text-sm font-medium text-[var(--color-text)]">{title}</div>
        )}
        {children}
      </div>
    </div>,
    document.body
  )
}

export function ErrorLine({ error }: { error: string | null }): React.JSX.Element | null {
  if (!error) return null
  return (
    <p role="alert" className="text-[11px] leading-relaxed text-[var(--color-danger)]">
      {error}
    </p>
  )
}

/**
 * Share changes: one field for what changed, pre-filled by an AI summary.
 *
 * The field is there and editable from the first frame, with "Writing a
 * summary…" as its placeholder; the draft fills it only if the user has not
 * typed, so a slow summary never overwrites their words.
 */
export function ShareChangesDialog({
  agentId,
  pending,
  error,
  onShare,
  onCancel
}: {
  agentId: string
  pending: boolean
  error: string | null
  onShare: (message: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const [message, setMessage] = useState('')
  const [drafting, setDrafting] = useState(true)
  const touched = useRef(false)

  useEffect(() => {
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
  }, [agentId])

  const submit = (): void => {
    if (pending) return
    onShare(message.trim())
  }

  return (
    <DialogShell
      title={SHARE_UI_TEXT.shareChangesTitle}
      pending={pending}
      onDismiss={onCancel}
      initialFocusRef={fieldRef}
    >
      <label className="block space-y-1">
        <span className="block text-[11px] text-[var(--color-text-muted)]">{SHARE_UI_TEXT.shareChangesLabel}</span>
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
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SHARE_UI_TEXT.cancel}
        </button>
        <button type="button" onClick={submit} disabled={pending} aria-busy={pending} className={PRIMARY}>
          {pending ? (
            <>
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.sharing}
            </>
          ) : (
            SHARE_UI_TEXT.share
          )}
        </button>
      </div>
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
    <DialogShell title={SHARE_UI_TEXT.conflictTitle} pending={pending} onDismiss={onKeepMine} initialFocusRef={keepRef}>
      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{SHARE_UI_TEXT.conflictBody}</p>
      <ErrorLine error={error} />
      <div className="flex flex-col items-stretch gap-2">
        <button type="button" onClick={onUseTeamVersion} disabled={pending} aria-busy={pending} className={PRIMARY}>
          {pending ? (
            <>
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.usingTeamVersion}
            </>
          ) : (
            SHARE_UI_TEXT.useTeamVersion
          )}
        </button>
        <button ref={keepRef} type="button" onClick={onKeepMine} disabled={pending} className={SECONDARY}>
          {SHARE_UI_TEXT.keepMine}
        </button>
      </div>
    </DialogShell>
  )
}

const ACCESS_CHOICES: LibraryAccess[] = ['use', 'edit', 'maintain']

/** The access select every people list uses: Can use / Can edit / Maintainer. */
export function AccessSelect({
  value,
  label,
  disabled,
  onChange,
  className = ''
}: {
  value: LibraryAccess
  /** The accessible name — "Access for Bob". */
  label: string
  disabled?: boolean
  onChange: (access: LibraryAccess) => void
  className?: string
}): React.JSX.Element {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as LibraryAccess)}
      className={`${FIELD_BASE} w-auto ${className}`}
    >
      {ACCESS_CHOICES.map((access) => (
        <option key={access} value={access}>
          {SHARE_ACCESS_TEXT[access]}
        </option>
      ))}
    </select>
  )
}

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

/**
 * A search field over the server's people, with its answers in a dropdown.
 *
 * **The dropdown floats over what is below it**, so opening, narrowing and
 * closing it while the user types moves nothing in the dialog (ux_rules rule
 * 1). It opens once two letters are typed and closes on a pick, on Escape
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
      <span className="block text-[11px] text-[var(--color-text-muted)]">{SHARE_UI_TEXT.peopleSearchLabel}</span>
      <div className="relative">
        <input
          ref={inputRef}
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
          className={FIELD}
        />
        {shown && (
          <div
            id="share-people-results"
            role="listbox"
            aria-label={SHARE_UI_TEXT.peopleSearchLabel}
            data-people-results
            // Before the input's blur, so a click on an answer lands.
            onMouseDown={(event) => event.preventDefault()}
            className="absolute inset-x-0 top-full z-10 mt-1 max-h-[7.5rem] overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-0.5 shadow-lg"
          >
            {message !== null ? (
              <p className="px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)]">{message}</p>
            ) : (
              results.map((person, index) => (
                <button
                  key={person.userId}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === highlighted}
                  onClick={() => pick(person)}
                  onMouseEnter={() => setActive(index)}
                  className={`block w-full truncate px-2.5 py-1.5 text-left text-xs text-[var(--color-text)] ${
                    index === highlighted ? 'bg-[var(--color-bg-hover)]' : ''
                  }`}
                >
                  {personLabel(person)}
                </button>
              ))
            )}
          </div>
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
 */
export function ChosenPeopleList({
  people,
  disabled,
  onChange,
  emptyText = SHARE_UI_TEXT.peopleOnlyMe,
  unsent
}: {
  people: ChosenPerson[]
  disabled: boolean
  onChange: (update: (list: ChosenPerson[]) => ChosenPerson[]) => void
  emptyText?: string
  /**
   * People listed but not sent as they stand (a share to everyone already
   * covers Can use): `title` is the person's sentence, `note` the one line
   * beside the list's label. Each such name is struck through in place, so
   * the list never shows what will not happen and nothing moves (rule 1).
   */
  unsent?: { is: (person: ChosenPerson) => boolean; title: (person: ChosenPerson) => string; note: string }
}): React.JSX.Element {
  const anyUnsent = unsent !== undefined && people.some((person) => unsent.is(person))
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="shrink-0 text-[var(--color-text-muted)]">{SHARE_UI_TEXT.peopleLabel}</span>
        {anyUnsent && (
          <span data-people-note title={unsent.note} className="min-w-0 truncate text-[var(--color-text-muted)]">
            {unsent.note}
          </span>
        )}
      </div>
      <ul
        aria-label={SHARE_UI_TEXT.peopleLabel}
        data-chosen-people
        className="h-[5.5rem] space-y-1 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-1.5"
      >
        {people.length === 0 ? (
          <li className="px-1 py-0.5 text-[11px] text-[var(--color-text-muted)]">{emptyText}</li>
        ) : (
          people.map((person) => (
            <li key={person.userId} className="flex items-center gap-2 px-1">
              {unsent?.is(person) ? (
                <span
                  data-unsent
                  className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)] line-through"
                  title={unsent.title(person)}
                >
                  {person.label}
                </span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text)]" title={person.label}>
                  {person.label}
                </span>
              )}
              <AccessSelect
                value={person.access}
                label={SHARE_UI_TEXT.accessFor(person.label)}
                disabled={disabled}
                onChange={(access) =>
                  onChange((list) => list.map((p) => (p.userId === person.userId ? { ...p, access } : p)))
                }
              />
              <button
                type="button"
                aria-label={SHARE_UI_TEXT.removePerson(person.label)}
                title={SHARE_UI_TEXT.removePerson(person.label)}
                disabled={disabled}
                onClick={() => onChange((list) => list.filter((p) => p.userId !== person.userId))}
                className="shrink-0 rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

/**
 * Share with the team: a name, and who may get it.
 *
 * No description: main sends the manifest's. The name is there from the first
 * frame and the draft fills it unless the user has typed. People are picked
 * from a search; each starts as "Can use", and an empty list means only the
 * sharer — never everyone. The chosen list has a fixed height, filled in
 * every state, so a pick moves nothing below it (ux_rules rule 1).
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
    onShare({ name: name.trim(), people: people.map(({ userId, access }) => ({ userId, access })) })
  }

  return (
    <DialogShell title={SHARE_UI_TEXT.shareWithTeamTitle} pending={pending} onDismiss={onCancel} initialFocusRef={nameRef}>
      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{SHARE_UI_TEXT.shareWithTeamBody}</p>
      <label className="block space-y-1">
        <span className="block text-[11px] text-[var(--color-text-muted)]">{SHARE_UI_TEXT.nameLabel}</span>
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
      <PeopleSearch
        disabled={pending}
        exclude={new Set(people.map((person) => person.userId))}
        onPick={(person) =>
          setPeople((list) => [...list, { userId: person.userId, access: 'use', label: personLabel(person) }])
        }
      />
      <ChosenPeopleList people={people} disabled={pending} onChange={setPeople} />
      <ErrorLine error={error ?? draftError} />
      <div className="flex justify-end gap-2">
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
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.sharing}
            </>
          ) : (
            SHARE_UI_TEXT.share
          )}
        </button>
      </div>
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
  onCancel
}: {
  /** Who already has access, left out of the answers. */
  exclude: ReadonlySet<string>
  pending: boolean
  error: string | null
  onAdd: (person: PersonSearchResult, access: LibraryAccess) => void
  onCancel: () => void
}): React.JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null)
  const [person, setPerson] = useState<PersonSearchResult | null>(null)
  const [access, setAccess] = useState<LibraryAccess>('use')
  return (
    <DialogShell title={SHARE_UI_TEXT.shareWithPersonTitle} pending={pending} onDismiss={onCancel} initialFocusRef={searchRef}>
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
        <AccessSelect value={access} label={SHARE_UI_TEXT.accessLabel} disabled={pending} onChange={setAccess} />
      </div>
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
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
          {pending && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
          {SHARE_UI_TEXT.addPerson}
        </button>
      </div>
    </DialogShell>
  )
}

/**
 * Remove sharing: confirm before this folder is disconnected from the team,
 * in the ⋯ menu's "Remove from this computer…" style. The recoverable part is
 * said first — the folder and its history stay. `offerDelete` adds an
 * unchecked "also delete it from the team library", for a maintainer of an
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
  /** The delete box was ticked or unticked: the caller clears a refusal that answered the old choice. */
  onChoiceChange?: () => void
  onConfirm: (deleteFromLibrary: boolean) => void
  onCancel: () => void
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [alsoDelete, setAlsoDelete] = useState(false)
  const deleting = offerDelete && alsoDelete
  return (
    <DialogShell
      title={SHARE_UI_TEXT.removeSharingTitle}
      pending={pending}
      onDismiss={onCancel}
      initialFocusRef={cancelRef}
      danger
    >
      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
        {SHARE_UI_TEXT.removeSharingBody(agentName)}
      </p>
      {offerDelete && (
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--color-border)] p-2.5 text-xs text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]">
          <input
            type="checkbox"
            className="mt-0.5 accent-[var(--color-danger)]"
            checked={alsoDelete}
            disabled={pending}
            onChange={(event) => {
              setAlsoDelete(event.target.checked)
              onChoiceChange?.()
            }}
          />
          <span className="min-w-0">{SHARE_UI_TEXT.alsoDeleteFromLibrary}</span>
        </label>
      )}
      <ErrorLine error={error} />
      {/* A refused delete ("2 people use this…") still leaves the way out:
          removing sharing here alone needs no one's say. */}
      {error && deleting && (
        <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">{SHARE_UI_TEXT.removeSharingOnlyHint}</p>
      )}
      <div className="flex justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SHARE_UI_TEXT.cancel}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(deleting)}
          disabled={pending}
          aria-busy={pending}
          // A fixed width, so the shorter "Removing…" does not pull Cancel sideways.
          className="inline-flex min-w-[7.5rem] items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {pending && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
          {pending ? SHARE_UI_TEXT.removingSharing : SHARE_UI_TEXT.removeSharingConfirm}
        </button>
      </div>
    </DialogShell>
  )
}
