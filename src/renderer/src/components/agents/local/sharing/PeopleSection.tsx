import { useRef, useState, type ReactNode } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import type { UseQueryResult } from '@tanstack/react-query'
import type {
  AgentPeopleDto,
  AgentShareResult,
  LibraryGrantInput,
  LibraryMaintainer,
  LibraryPerson,
  LibraryPrincipal
} from '../../../../../../shared/agentSharing'
import type { CatalogVisibility } from '../../../../../../shared/catalogItems'
import { unwrapIpcError } from '../../../../utils/ipcError'
import { SHARE_ACCESS_TEXT, SHARE_UI_TEXT, libraryRefusalSentence } from '../../../../utils/shareText'
import {
  SettingsBadge,
  SettingsButton,
  SettingsHint,
  SettingsIconButton,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  settingsInputClass
} from '../../../settings/SettingsLayout'
import { ShareWithPersonDialog, ShareWithPersonForm } from './ShareDialogs'

/**
 * Who has access to a catalog item — a shared desktop agent's People
 * section, and a shared skill's Who can use dialog. One list for both
 * (ux_rules rule 13): a row per grant with its access select and a
 * remove-in-row confirm, an Everyone row, Share with a person… and Share
 * with everyone beside the title, and for someone who may not see the list,
 * the maintainers and "Only a maintainer can change who has access.".
 *
 * The list does not own its write. The caller owns the mutation, hook-level,
 * with {@link usePeopleEditor}'s `onResult` as its callback, so an answer
 * lands even after a re-render; the editor routes each refusal to the
 * surface the change came from.
 */

function samePrincipal(a: LibraryPrincipal, b: LibraryPrincipal): boolean {
  if (a.kind === 'user' && b.kind === 'user') return a.userId === b.userId
  if (a.kind === 'role' && b.kind === 'role') return a.role === b.role
  return a.kind === b.kind
}

function principalKey(p: LibraryPrincipal): string {
  return p.kind === 'user' ? `user:${p.userId}` : p.kind === 'role' ? `role:${p.role}` : 'everyone'
}

// The settings input without its `w-full`, which otherwise beats `w-36` and
// takes the whole row, leaving the person's name no width at all.
const ACCESS_SELECT = settingsInputClass.replace(/\bw-full\b\s*/, '')

function personName(person: LibraryPerson, maintainers: LibraryMaintainer[]): string {
  const { principal } = person
  if (principal.kind === 'everyone') return SHARE_UI_TEXT.everyone
  if (principal.kind === 'role') return person.displayName || SHARE_UI_TEXT.roleMembers(principal.role)
  return person.displayName || maintainers.find((m) => m.userId === principal.userId)?.displayName || principal.userId
}

/** Where a change came from, so its refusal lands beside it. */
type Origin = 'list' | 'dialog' | 'everyone'

export interface PeopleEditor {
  error: string | null
  setError: (message: string | null) => void
  adding: boolean
  setAdding: (adding: boolean) => void
  addError: string | null
  setAddError: (message: string | null) => void
  /** The row asking "Remove … access?", by principal. */
  confirmingKey: string | null
  setConfirmingKey: (key: string | null) => void
  /** Share with everyone is the change in flight: its button carries the spinner. */
  addingEveryone: boolean
  setAddingEveryone: (adding: boolean) => void
  /** Share with everyone's refusal, shown under the list (like `error`), so it pushes nothing down. */
  everyoneError: string | null
  setEveryoneError: (message: string | null) => void
  /** Mark where the next change comes from, clearing that surface's last refusal. */
  begin: (origin: Origin) => void
  /** The mutation's hook-level answer. */
  onResult: (result: Pick<AgentShareResult, 'done' | 'refusal' | 'detail'>) => void
  /** The mutation's thrown error (reauth aside, which the cache prompts for). */
  onError: (err: unknown) => void
}

/**
 * The People list's own state, held by whoever owns the mutation so it can
 * hand `onResult` to the hook. `noAccess` is the sentence for a `no_access`
 * refusal, in the item's words.
 */
export function usePeopleEditor(noAccess: string): PeopleEditor {
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  const [addingEveryone, setAddingEveryone] = useState(false)
  const [everyoneError, setEveryoneError] = useState<string | null>(null)
  // Which surface the change came from, so its refusal lands beside it: the
  // dialog for an Add, the list for a select, a remove or Share with everyone.
  const originRef = useRef<Origin>('list')
  return {
    error,
    setError,
    adding,
    setAdding,
    addError,
    setAddError,
    confirmingKey,
    setConfirmingKey,
    addingEveryone,
    setAddingEveryone,
    everyoneError,
    setEveryoneError,
    begin: (origin) => {
      originRef.current = origin
      setEveryoneError(null)
      if (origin === 'dialog') setAddError(null)
      else setError(null)
    },
    onResult: (result) => {
      setAddingEveryone(false)
      const message = result.done ? null : libraryRefusalSentence(result, noAccess)
      if (originRef.current === 'everyone') {
        setEveryoneError(message)
      } else if (originRef.current === 'dialog') {
        if (result.done) setAdding(false)
        else setAddError(message)
      } else {
        setError(message)
        if (result.done) setConfirmingKey(null)
      }
    },
    onError: (err) => {
      setAddingEveryone(false)
      const message = unwrapIpcError(err)
      if (originRef.current === 'everyone') setEveryoneError(message)
      else if (originRef.current === 'dialog') setAddError(message)
      else setError(message)
    }
  }
}

export function PeopleSection({
  people,
  maintainers,
  visibility,
  editor,
  pending,
  onSave,
  info,
  inlineAdd = false,
  maintainersShown = false
}: {
  people: UseQueryResult<AgentPeopleDto | null>
  /** The listing's maintainers: the names a non-maintainer sees, and a fallback for a grant's name. */
  maintainers: LibraryMaintainer[]
  /** The listing's visibility; Share with everyone is offered only while it is not public. */
  visibility: CatalogVisibility | null
  editor: PeopleEditor
  pending: boolean
  /** Send the whole desired list; the answer comes back through `editor.onResult` / `onError`. */
  onSave: (people: LibraryGrantInput[]) => void
  /** The section's (?) beside its title. */
  info?: ReactNode
  /**
   * Inside a dialog: Share with a person… replaces the section with its form
   * rather than opening a second dialog over the first.
   */
  inlineAdd?: boolean
  /**
   * The caller names the maintainers above the section (the Who can use
   * dialog's Maintainers line), so someone who may not see the list gets
   * only the hint, not the same names again.
   */
  maintainersShown?: boolean
}): React.JSX.Element {
  const {
    error,
    setError,
    adding,
    setAdding,
    addError,
    setAddError,
    confirmingKey,
    setConfirmingKey,
    addingEveryone,
    setAddingEveryone,
    everyoneError
  } = editor
  const editable = people.data?.visible === true
  // The whole list: every change is saved on it, your own grant included.
  const list = editable ? people.data!.people : []
  const selfId = people.data?.selfUserId ?? null
  const isSelf = (person: LibraryPerson): boolean =>
    selfId !== null && person.principal.kind === 'user' && person.principal.userId === selfId
  // Your own access is never edited here. As a maintainer you are already
  // named under Maintainers, so your row is left out; otherwise it is
  // shown, read-only.
  const selfIsMaintainer = selfId !== null && maintainers.some((m) => m.userId === selfId)
  const rows = list.filter((person) => !(isSelf(person) && selfIsMaintainer))
  // A co-maintainer has access without a grant row: "no one else" would be false.
  const otherMaintainers = maintainers.some((m) => m.userId !== selfId)
  // Offered only while it would change something: not public yet, by either
  // the list (a listed public item) or the catalog entry (an unlisted one).
  const offerEveryone =
    editable && visibility !== 'public' && !list.some((person) => person.principal.kind === 'everyone')

  const save = (next: LibraryGrantInput[], origin: Origin = 'list'): void => {
    editor.begin(origin)
    onSave(next)
  }
  const asInput = (rows: LibraryPerson[]): LibraryGrantInput[] =>
    rows.map(({ principal, access }) => ({ principal, access }))
  const exclude = new Set(list.flatMap((p) => (p.principal.kind === 'user' ? [p.principal.userId] : [])))
  const addForm = {
    exclude,
    pending,
    error: addError,
    onAdd: (person: { userId: string }, access: LibraryGrantInput['access']) =>
      save([...asInput(list), { principal: { kind: 'user', userId: person.userId }, access }], 'dialog'),
    onCancel: () => setAdding(false)
  }

  if (inlineAdd && adding) {
    return (
      <div data-sharing-add className="space-y-3">
        <ShareWithPersonForm {...addForm} focusOnMount />
      </div>
    )
  }

  return (
    <SettingsSection
      title={SHARE_UI_TEXT.peopleSection}
      info={info}
      action={
        editable ? (
          <div className="flex items-center gap-2">
            {offerEveryone && (
              <SettingsButton
                onClick={() => {
                  setConfirmingKey(null)
                  setAddingEveryone(true)
                  save([...asInput(list), { principal: { kind: 'everyone' }, access: 'use' }], 'everyone')
                }}
                disabled={pending}
                aria-busy={pending && addingEveryone}
              >
                {pending && addingEveryone && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                {SHARE_UI_TEXT.shareWithEveryone}
              </SettingsButton>
            )}
            <SettingsButton
              onClick={() => {
                setAddError(null)
                setAdding(true)
              }}
              disabled={pending}
            >
              {SHARE_UI_TEXT.shareWithPerson}
            </SettingsButton>
          </div>
        ) : undefined
      }
    >
      <div data-sharing-people>
        <SettingsRows>
          {people.isPending ? (
            <SettingsRow>
              <SettingsHint>{SHARE_UI_TEXT.peopleLoading}</SettingsHint>
            </SettingsRow>
          ) : people.isError ? (
            <SettingsRow>
              <p role="alert" className="text-[13px] text-[var(--color-danger)]">
                {unwrapIpcError(people.error, SHARE_UI_TEXT.peopleLoadFailed)}
              </p>
            </SettingsRow>
          ) : editable ? (
            rows.length === 0 ? (
              <SettingsRow>
                <SettingsHint>{otherMaintainers ? SHARE_UI_TEXT.peopleOnlyMaintainers : SHARE_UI_TEXT.peopleNoOneElse}</SettingsHint>
              </SettingsRow>
            ) : rows.map((person) => {
              const key = principalKey(person.principal)
              const self = isSelf(person)
              const name = self ? SHARE_UI_TEXT.you : personName(person, maintainers)
              const confirming = confirmingKey === key
              return (
                <SettingsRow key={key} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--color-text)]" title={name}>
                    {confirming ? SHARE_UI_TEXT.removePersonConfirm(name) : name}
                  </span>
                  {confirming ? (
                    <>
                      <SettingsButton onClick={() => setConfirmingKey(null)} disabled={pending}>
                        {SHARE_UI_TEXT.cancel}
                      </SettingsButton>
                      <button
                        type="button"
                        disabled={pending}
                        aria-busy={pending}
                        onClick={() =>
                          save(asInput(list.filter((p) => !samePrincipal(p.principal, person.principal))))
                        }
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-danger)] px-2.5 py-1 text-[13px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
                      >
                        {pending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                        {SHARE_UI_TEXT.removePersonAction}
                      </button>
                    </>
                  ) : self ? (
                    <>
                      {/* Your own access is not yours to change. The slot after
                          it keeps the column aligned with the rows that remove. */}
                      <SettingsBadge>{SHARE_ACCESS_TEXT[person.access]}</SettingsBadge>
                      <span className="w-[28px] shrink-0" aria-hidden="true" />
                    </>
                  ) : person.principal.kind === 'everyone' ? (
                    <>
                      {/* Everyone on the server can only use it: that is what
                          sharing with everyone means, so there is no choice. */}
                      <SettingsBadge>{SHARE_ACCESS_TEXT.use}</SettingsBadge>
                      <SettingsIconButton
                        title={SHARE_UI_TEXT.removePerson(name)}
                        aria-label={SHARE_UI_TEXT.removePerson(name)}
                        danger
                        disabled={pending}
                        onClick={() => {
                          setError(null)
                          setConfirmingKey(key)
                        }}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </SettingsIconButton>
                    </>
                  ) : (
                    <>
                      <select
                        aria-label={SHARE_UI_TEXT.accessFor(name)}
                        value={person.access}
                        disabled={pending}
                        onChange={(event) =>
                          save(
                            asInput(
                              list.map((p) =>
                                samePrincipal(p.principal, person.principal)
                                  ? { ...p, access: event.target.value as LibraryPerson['access'] }
                                  : p
                              )
                            )
                          )
                        }
                        className={`${ACCESS_SELECT} w-36 shrink-0 disabled:opacity-50`}
                      >
                        {(['use', 'edit', 'maintain'] as const).map((access) => (
                          <option key={access} value={access}>
                            {SHARE_ACCESS_TEXT[access]}
                          </option>
                        ))}
                      </select>
                      <SettingsIconButton
                        title={SHARE_UI_TEXT.removePerson(name)}
                        aria-label={SHARE_UI_TEXT.removePerson(name)}
                        danger
                        disabled={pending}
                        onClick={() => {
                          setError(null)
                          setConfirmingKey(key)
                        }}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </SettingsIconButton>
                    </>
                  )}
                </SettingsRow>
              )
            })
          ) : (
            <>
              {!maintainersShown && maintainers.map((m) => (
                <SettingsRow key={m.userId} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--color-text)]">
                    {m.displayName}
                  </span>
                  <SettingsBadge>{SHARE_ACCESS_TEXT.maintain}</SettingsBadge>
                </SettingsRow>
              ))}
              <SettingsRow>
                <SettingsHint>{SHARE_UI_TEXT.peopleOnlyMaintainer}</SettingsHint>
              </SettingsRow>
            </>
          )}
        </SettingsRows>
        {error && (
          <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
            {error}
          </p>
        )}
        {/* Under the list like `error`: a refusal arriving pushes nothing the user looks at down. */}
        {everyoneError && (
          <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
            {everyoneError}
          </p>
        )}
      </div>
      {adding && !inlineAdd && <ShareWithPersonDialog {...addForm} />}
    </SettingsSection>
  )
}
