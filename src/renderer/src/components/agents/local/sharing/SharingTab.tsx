import { useEffect, useRef, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import type {
  AgentShareStatus,
  LibraryAgentDto,
  LibraryGrantInput,
  LibraryPerson,
  LibraryPrincipal
} from '../../../../../../shared/agentSharing'
import {
  useSetSharePeople,
  useShareHistory,
  useSharePeople,
  useTeamLibrary,
  useUnshare
} from '../../../../hooks/useSharing'
import { useOpenExternal } from '../../../../hooks/useSystem'
import { unwrapIpcError } from '../../../../utils/ipcError'
import {
  SHARE_ACCESS_TEXT,
  SHARE_UI_TEXT,
  libraryRefusalSentence,
  shareStatusSentence,
  shareStatusWarns
} from '../../../../utils/shareText'
import {
  SettingsBadge,
  SettingsButton,
  SettingsCard,
  SettingsHint,
  SettingsIconButton,
  SettingsInfoTip,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusRow,
  settingsInputClass
} from '../../../settings/SettingsLayout'
import { useAgentShareStatus } from './AgentShareBadge'
import { RemoveSharingDialog, ShareWithPersonDialog } from './ShareDialogs'
import { canShareChanges, canUpdate, type ShareActions } from './useShareActions'

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function formatDate(iso: string): string | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : DATE.format(date)
}

/** The host of an origin, for a server line; the origin itself when it does not parse. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** A Cinna team version on the active account, whose library entry the tab can talk about. */
function onActiveLibrary(status: AgentShareStatus): boolean {
  return status.remote.kind === 'cinna' && status.state !== 'other_account' && status.state !== 'removed'
}

function samePrincipal(a: LibraryPrincipal, b: LibraryPrincipal): boolean {
  if (a.kind === 'user' && b.kind === 'user') return a.userId === b.userId
  if (a.kind === 'role' && b.kind === 'role') return a.role === b.role
  return a.kind === b.kind
}

function principalKey(p: LibraryPrincipal): string {
  return p.kind === 'user' ? `user:${p.userId}` : p.kind === 'role' ? `role:${p.role}` : 'everyone'
}

/**
 * A folder agent's Sharing tab — present only for a shared agent (the page
 * decides that from the statuses list, at first paint). Four titled sections
 * built like the tabs beside it (ux_rules rule 12): where it is shared, with
 * Update / Share changes beside the state they change; who has access; the
 * folder's versions; and, last, Remove sharing.
 *
 * Library facts — name, access, maintainers, who shared last — come from the
 * team library's listing, re-read when the tab opens.
 */
export function SharingTab({
  agent,
  actions,
  bindActionErrors,
  onNote
}: {
  agent: { id: string; name: string }
  /** The page's Update / Share changes, owned there (their dialogs too). */
  actions: ShareActions
  /** Route those actions' refusals to this tab's line while it is open; null hands them back. */
  bindActionErrors: (sink: ((message: string | null) => void) | null) => void
  /** The page's quiet note slot. */
  onNote: (message: string | null) => void
}): React.JSX.Element | null {
  const status = useAgentShareStatus(agent.id)
  const library = useTeamLibrary({ refresh: true })
  if (!status) return null
  const entry =
    status.remote.kind === 'cinna'
      ? (library.data?.agents.find((candidate) => candidate.repoId === status.remote.repoId) ?? null)
      : null
  return (
    <div className="space-y-6">
      <WhereSection status={status} entry={entry} actions={actions} bindActionErrors={bindActionErrors} />
      {onActiveLibrary(status) && <PeopleSection agentId={agent.id} entry={entry} />}
      <HistorySection agentId={agent.id} />
      <RemoveSection agent={agent} status={status} entry={entry} onNote={onNote} />
    </div>
  )
}

function WhereSection({
  status,
  entry,
  actions,
  bindActionErrors
}: {
  status: AgentShareStatus
  entry: LibraryAgentDto | null
  actions: ShareActions
  bindActionErrors: (sink: ((message: string | null) => void) | null) => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    bindActionErrors(setError)
    return () => bindActionErrors(null)
  }, [bindActionErrors])
  const openExternal = useOpenExternal()
  const warn = shareStatusWarns(status)
  const when = entry?.updatedAt ? formatDate(entry.updatedAt) : null
  const lastShared = when
    ? entry?.pushedBy
      ? SHARE_UI_TEXT.lastSharedBy(when, entry.pushedBy)
      : SHARE_UI_TEXT.lastShared(when)
    : null
  const cinna = status.remote.kind === 'cinna'
  const access = entry?.access ?? status.remote.access

  const facts: { label: string; value: React.ReactNode }[] = [
    {
      label: SHARE_UI_TEXT.serverLabel,
      value:
        cinna && status.remote.host ? (
          <button
            type="button"
            title={status.remote.host}
            onClick={() =>
              void openExternal(status.remote.host as string).then((r) => {
                if (!r.success) setError(r.error)
              })
            }
            className="truncate font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]"
          >
            {hostOf(status.remote.host)}
          </button>
        ) : (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0">{SHARE_UI_TEXT.ownServer}</span>
            <code className="truncate text-[12px] text-[var(--color-text-muted)]" title={status.remote.url}>
              {status.remote.url}
            </code>
          </span>
        )
    }
  ]
  if (entry) {
    facts.push(
      { label: SHARE_UI_TEXT.libraryNameLabel, value: entry.name },
      { label: SHARE_UI_TEXT.libraryFolderLabel, value: <code className="text-[12px]">{entry.slug}</code> }
    )
  }
  if (cinna && access) facts.push({ label: SHARE_UI_TEXT.yourAccessLabel, value: SHARE_ACCESS_TEXT[access] })
  if (entry && entry.maintainers.length > 0) {
    facts.push({
      label: SHARE_UI_TEXT.maintainersLabel,
      value: entry.maintainers.map((m) => m.displayName).join(', ')
    })
  }

  return (
    <SettingsSection
      title={SHARE_UI_TEXT.whereShared}
      info={<SettingsInfoTip label={`About ${SHARE_UI_TEXT.whereShared}`}>{SHARE_UI_TEXT.whereSharedInfo}</SettingsInfoTip>}
    >
      <SettingsCard>
        <div data-sharing-status>
          <SettingsStatusRow
            tone={warn ? 'warning' : status.state === 'up_to_date' ? 'ok' : 'neutral'}
            label={shareStatusSentence(status)}
            detail={lastShared ? `${SHARE_UI_TEXT.lastSharedLabel} ${lastShared}` : undefined}
            action={
              canUpdate(status) || canShareChanges(status) ? (
                <div className="flex items-center gap-2">
                  {canUpdate(status) && (
                    <SettingsButton
                      onClick={actions.update}
                      disabled={actions.updatePending}
                      aria-busy={actions.updatePending}
                    >
                      {actions.updatePending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                      {actions.updatePending ? SHARE_UI_TEXT.updating : SHARE_UI_TEXT.update}
                    </SettingsButton>
                  )}
                  {canShareChanges(status) && (
                    <SettingsButton onClick={actions.openShareChanges} disabled={actions.updatePending}>
                      {SHARE_UI_TEXT.shareChanges}
                    </SettingsButton>
                  )}
                </div>
              ) : undefined
            }
          />
        </div>
        <dl className="mt-3 grid grid-cols-[10rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-[var(--color-border)] pt-3 text-[13px]">
          {facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-[var(--color-text-muted)]">{fact.label}</dt>
              <dd className="min-w-0 truncate text-[var(--color-text)]">{fact.value}</dd>
            </div>
          ))}
        </dl>
        {/* Last in the card, only when there is one: it moves nothing above it (§1, §6). */}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

function personName(person: LibraryPerson, entry: LibraryAgentDto | null): string {
  const { principal } = person
  if (principal.kind === 'everyone') return SHARE_UI_TEXT.everyone
  if (principal.kind === 'role') return person.displayName || SHARE_UI_TEXT.roleMembers(principal.role)
  return (
    person.displayName ||
    entry?.maintainers.find((m) => m.userId === principal.userId)?.displayName ||
    principal.userId
  )
}

function PeopleSection({ agentId, entry }: { agentId: string; entry: LibraryAgentDto | null }): React.JSX.Element {
  const people = useSharePeople(agentId, true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  /** The row asking "Remove … access?", by principal. */
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  // Which surface the change came from, so its refusal lands beside it: the
  // dialog for an Add, the list for a select or a remove.
  const fromDialogRef = useRef(false)
  const set = useSetSharePeople({
    onResult: (result) => {
      const message = result.done ? null : libraryRefusalSentence(result, SHARE_UI_TEXT.peopleNoAccess)
      if (fromDialogRef.current) {
        if (result.done) setAdding(false)
        else setAddError(message)
      } else {
        setError(message)
        if (result.done) setConfirmingKey(null)
      }
    }
  })
  const editable = people.data?.visible === true
  const list = editable ? people.data!.people : []

  const save = (next: LibraryGrantInput[], fromDialog = false): void => {
    fromDialogRef.current = fromDialog
    if (fromDialog) setAddError(null)
    else setError(null)
    set.mutate(
      { agentId, people: next },
      {
        onError: (err) => (fromDialog ? setAddError(unwrapIpcError(err)) : setError(unwrapIpcError(err)))
      }
    )
  }
  const asInput = (rows: LibraryPerson[]): LibraryGrantInput[] =>
    rows.map(({ principal, access }) => ({ principal, access }))

  return (
    <SettingsSection
      title={SHARE_UI_TEXT.peopleSection}
      info={<SettingsInfoTip label={`About ${SHARE_UI_TEXT.peopleSection}`}>{SHARE_UI_TEXT.peopleInfo}</SettingsInfoTip>}
      action={
        editable ? (
          <SettingsButton
            onClick={() => {
              setAddError(null)
              setAdding(true)
            }}
            disabled={set.isPending}
          >
            {SHARE_UI_TEXT.shareWithPerson}
          </SettingsButton>
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
            list.map((person) => {
              const key = principalKey(person.principal)
              const self =
                person.principal.kind === 'user' && person.principal.userId === people.data?.selfUserId
              const name = self ? SHARE_UI_TEXT.you : personName(person, entry)
              const confirming = confirmingKey === key
              return (
                <SettingsRow key={key} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--color-text)]" title={name}>
                    {confirming ? SHARE_UI_TEXT.removePersonConfirm(name) : name}
                  </span>
                  {confirming ? (
                    <>
                      <SettingsButton onClick={() => setConfirmingKey(null)} disabled={set.isPending}>
                        {SHARE_UI_TEXT.cancel}
                      </SettingsButton>
                      <button
                        type="button"
                        disabled={set.isPending}
                        aria-busy={set.isPending}
                        onClick={() =>
                          save(asInput(list.filter((p) => !samePrincipal(p.principal, person.principal))))
                        }
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-danger)] px-2.5 py-1 text-[13px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
                      >
                        {set.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                        {SHARE_UI_TEXT.removePersonAction}
                      </button>
                    </>
                  ) : (
                    <>
                      <select
                        aria-label={SHARE_UI_TEXT.accessFor(name)}
                        value={person.access}
                        disabled={set.isPending}
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
                        className={`${settingsInputClass} w-36 shrink-0 disabled:opacity-50`}
                      >
                        {(['read', 'write', 'maintain'] as const).map((access) => (
                          <option key={access} value={access}>
                            {SHARE_ACCESS_TEXT[access]}
                          </option>
                        ))}
                      </select>
                      {/* Your own row has no remove: taking yourself off is not
                          a click away. The slot keeps the column aligned. */}
                      {self ? (
                        <span className="w-[28px] shrink-0" aria-hidden="true" />
                      ) : (
                        <SettingsIconButton
                          title={SHARE_UI_TEXT.removePerson(name)}
                          aria-label={SHARE_UI_TEXT.removePerson(name)}
                          danger
                          disabled={set.isPending}
                          onClick={() => {
                            setError(null)
                            setConfirmingKey(key)
                          }}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </SettingsIconButton>
                      )}
                    </>
                  )}
                </SettingsRow>
              )
            })
          ) : (
            <>
              {(entry?.maintainers ?? []).map((m) => (
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
      </div>
      {adding && (
        <ShareWithPersonDialog
          exclude={
            new Set(list.flatMap((p) => (p.principal.kind === 'user' ? [p.principal.userId] : [])))
          }
          pending={set.isPending}
          error={addError}
          onAdd={(person, access) =>
            save([...asInput(list), { principal: { kind: 'user', userId: person.userId }, access }], true)
          }
          onCancel={() => setAdding(false)}
        />
      )}
    </SettingsSection>
  )
}

function HistorySection({ agentId }: { agentId: string }): React.JSX.Element {
  const history = useShareHistory(agentId)
  return (
    <SettingsSection
      title={SHARE_UI_TEXT.historySection}
      info={<SettingsInfoTip label={`About ${SHARE_UI_TEXT.historySection}`}>{SHARE_UI_TEXT.historyInfo}</SettingsInfoTip>}
    >
      <div data-sharing-history>
        <SettingsRows>
          {history.isPending ? (
            <SettingsRow>
              <SettingsHint>{SHARE_UI_TEXT.historyLoading}</SettingsHint>
            </SettingsRow>
          ) : history.isError ? (
            <SettingsRow>
              <p role="alert" className="text-[13px] text-[var(--color-danger)]">
                {unwrapIpcError(history.error, SHARE_UI_TEXT.historyFailed)}
              </p>
            </SettingsRow>
          ) : history.data.length === 0 ? (
            <SettingsRow>
              <SettingsHint>{SHARE_UI_TEXT.historyEmpty}</SettingsHint>
            </SettingsRow>
          ) : (
            history.data.map((version, index) => {
              const when = formatDate(version.date)
              return (
                <SettingsRow key={`${index}:${version.date}`} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-[var(--color-text)]" title={version.note}>
                      {version.note}
                    </div>
                    <div className="truncate text-[12px] text-[var(--color-text-muted)]">
                      {[version.author, when].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {version.unsent && <SettingsBadge>{SHARE_UI_TEXT.notSharedYet}</SettingsBadge>}
                </SettingsRow>
              )
            })
          )}
        </SettingsRows>
      </div>
    </SettingsSection>
  )
}

function RemoveSection({
  agent,
  status,
  entry,
  onNote
}: {
  agent: { id: string; name: string }
  status: AgentShareStatus
  entry: LibraryAgentDto | null
  onNote: (message: string | null) => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Hook-level: it runs after this tab is gone — which success makes it.
  const unshare = useUnshare({
    onResult: (result) => {
      if (result.done) {
        setConfirming(false)
        onNote(SHARE_UI_TEXT.noLongerSharedNote(agent.name))
      } else {
        setError(libraryRefusalSentence(result, SHARE_UI_TEXT.deleteNoAccess))
      }
    }
  })
  const offerDelete = onActiveLibrary(status) && entry !== null && entry.access === 'maintain'
  return (
    <SettingsSection title={SHARE_UI_TEXT.removeSharingSection}>
      <SettingsCard className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-[var(--color-text-muted)]">{SHARE_UI_TEXT.removeSharingHint}</p>
        <button
          type="button"
          onClick={() => {
            setError(null)
            setConfirming(true)
          }}
          className="shrink-0 rounded-md border border-[var(--color-danger)]/40 px-2.5 py-1 text-[13px] font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10"
        >
          {SHARE_UI_TEXT.removeSharingMenu}
        </button>
      </SettingsCard>
      {confirming && (
        <RemoveSharingDialog
          agentName={agent.name}
          offerDelete={offerDelete}
          pending={unshare.isPending}
          error={error}
          onConfirm={(deleteFromLibrary) => {
            setError(null)
            unshare.mutate(
              { agentId: agent.id, deleteFromLibrary },
              { onError: (err) => setError(unwrapIpcError(err)) }
            )
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </SettingsSection>
  )
}
