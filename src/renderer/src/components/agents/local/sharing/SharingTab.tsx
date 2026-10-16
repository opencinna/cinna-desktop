import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { AgentShareStatus, LibraryAgentDto } from '../../../../../../shared/agentSharing'
import {
  useSetSharePeople,
  useShareHistory,
  useSharePeople,
  useTeamLibrary,
  useUnshare
} from '../../../../hooks/useSharing'
import { useOpenExternal } from '../../../../hooks/useSystem'
import { useChatStore } from '../../../../stores/chat.store'
import { useUIStore } from '../../../../stores/ui.store'
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
  SettingsInfoTip,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusRow
} from '../../../settings/SettingsLayout'
import { useAgentShareStatus } from './useAgentShareStatus'
import { RemoveSharingDialog } from './ShareDialogs'
import { PeopleSection, usePeopleEditor } from './PeopleSection'
import { canShareChanges, canUpdate, isAdopting, type ShareActions } from './useShareActions'

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
  /** The page's Update / Share changes / Finish / Discard, owned there (their dialogs too). */
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
      {onActiveLibrary(status) && <AgentPeopleSection agentId={agent.id} entry={entry} />}
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
  const adopting = isAdopting(status)
  const sessionBusy = actions.finishPending || actions.discardPending
  const sessionChatId = status.adoption?.chatId ?? null
  /** The session's chat, where the agent is reconciling the two sides. */
  const openSession = (): void => {
    if (!sessionChatId) return
    useChatStore.getState().setActiveChatId(sessionChatId)
    useUIStore.getState().setActiveView('chat')
    useUIStore.getState().setSidebarTab('chats')
  }
  const latest = entry?.latest ?? null
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
  // The session's chat as a fact, not a third button beside Finish… and
  // Discard: the status row keeps two actions and its label fits (rules 7, 12).
  if (adopting && sessionChatId) {
    facts.push({
      label: SHARE_UI_TEXT.sessionLabel,
      value: (
        <button
          type="button"
          onClick={openSession}
          disabled={sessionBusy}
          className="font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)] disabled:opacity-60"
        >
          {SHARE_UI_TEXT.openSession}
        </button>
      )
    })
  }
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
  // The team's latest version, one fact each, never a dotted line under the status.
  if (latest) {
    facts.push({ label: SHARE_UI_TEXT.versionLabel, value: String(latest.number) })
    if (latest.publishedBy) facts.push({ label: SHARE_UI_TEXT.sharedByLabel, value: latest.publishedBy })
    const when = latest.publishedAt ? formatDate(latest.publishedAt) : null
    if (when) facts.push({ label: SHARE_UI_TEXT.sharedOnLabel, value: when })
  }
  // Said once, only when the catalog narrows who can get it: unlisted, core
  // counts neither Everyone nor a Can use grant; private, no Can use grant.
  if (entry && (!entry.isListed || entry.visibility === 'private')) {
    facts.push({
      label: SHARE_UI_TEXT.whoCanGetLabel,
      value: entry.isListed ? SHARE_UI_TEXT.privateItem : SHARE_UI_TEXT.notListed
    })
  }
  // What this machine recorded when it shared or got the agent, else the listing's.
  const catalogId = cinna ? (status.bundleId ?? entry?.bundleId ?? null) : null
  if (catalogId) {
    facts.push({
      label: SHARE_UI_TEXT.catalogIdLabel,
      value: (
        <code className="block truncate text-[12px]" title={catalogId}>
          {catalogId}
        </code>
      )
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
            action={
              adopting ? (
                <div className="flex items-center gap-2">
                  <SettingsButton onClick={actions.finish} disabled={sessionBusy} aria-busy={actions.finishPending}>
                    {actions.finishPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                    {actions.finishPending ? SHARE_UI_TEXT.finishing : SHARE_UI_TEXT.finish}
                  </SettingsButton>
                  <SettingsButton onClick={actions.discard} disabled={sessionBusy}>
                    {SHARE_UI_TEXT.discard}
                  </SettingsButton>
                </div>
              ) : canUpdate(status) || canShareChanges(status) ? (
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

/** The agent's People: the shared list, over its catalog entry's grants. */
function AgentPeopleSection({ agentId, entry }: { agentId: string; entry: LibraryAgentDto | null }): React.JSX.Element {
  const people = useSharePeople(agentId, true)
  const editor = usePeopleEditor(SHARE_UI_TEXT.peopleNoAccess)
  const set = useSetSharePeople({ onResult: editor.onResult })
  return (
    <PeopleSection
      people={people}
      maintainers={entry?.maintainers ?? []}
      visibility={entry?.visibility ?? null}
      editor={editor}
      pending={set.isPending}
      onSave={(next) => set.mutate({ agentId, people: next }, { onError: editor.onError })}
      info={<SettingsInfoTip label={`About ${SHARE_UI_TEXT.peopleSection}`}>{SHARE_UI_TEXT.peopleInfo}</SettingsInfoTip>}
    />
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
          // A refusal belongs to the choice it answered: a new choice clears it.
          onChoiceChange={() => setError(null)}
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
