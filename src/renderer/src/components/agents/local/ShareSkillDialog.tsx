import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { LocalAgentSkill } from '../../../../../shared/localAgents'
import type { SkillGetLatestOutcome, SkillPublishInput, SkillPublishPreviewDto, SkillPublishRefused } from '../../../../../shared/skillPublish'
import { unwrapIpcError } from '../../../utils/ipcError'
import { SKILL_SHARE_TEXT, catalogVersionLabel } from '../../../utils/catalogItems'
import {
  CANCEL,
  ChosenPeopleList,
  DIALOG_CODE,
  DIALOG_HEADING,
  DIALOG_LABEL,
  DIALOG_NOTE,
  DIALOG_TEXT,
  DialogFooter,
  DialogShell,
  FIELD_BASE,
  PeopleSearch,
  PRIMARY,
  SECONDARY,
  WhoCanUseHeading,
  personLabel,
  useEveryoneFocusHandOff,
  type ChosenPerson
} from './sharing/ShareDialogs'
import { ManagedList, ManagedListPicker, ManagedListRow, type ManagedListPickerOption } from '../../ui/ManagedList'

/** The preview, as the dialog waits for it. */
type PreviewState = { kind: 'loading' } | { kind: 'ready'; preview: SkillPublishPreviewDto } | { kind: 'failed'; message: string }

/** The picker's value for "each person connects their own". */
const OWN = ''

/** "Share as" picking a separate skill rather than one of the editable packages. */
const SEPARATE = 'separate'

/**
 * The Share as row's lead: a radio circle in both states, an empty muted ring
 * unpicked and the accent ring with its dot picked, one size, so every row
 * reads as a choice and picking one moves nothing (ux_rules rules 1 and 11).
 */
function RadioMark({ checked }: { checked: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-radio-mark={checked ? 'checked' : 'unchecked'}
      className={`flex h-4 w-4 items-center justify-center rounded-full border-[1.5px] ${
        checked ? 'border-[var(--color-accent)]' : 'border-[var(--color-text-muted)]'
      }`}
    >
      {checked && <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" />}
    </span>
  )
}

/**
 * Share an agent's own skill to the catalog, or a new version of it.
 *
 * Drawn in the sharing dialogs' shell (ux_rules rule 13). Every row is there
 * from the first frame, so the preview landing changes words, not the
 * footprint (rule 1): the version and the catalog id read "Loading…" until it
 * answers, and the credential slots come from the skill's own `SKILL.md` and
 * are only enabled once the preview names the credentials that could fill
 * them. On a first share nothing is picked — each person connects their own
 * unless the sharer provides one (catalog C5); on a later version each slot
 * starts at what the latest version had (core keeps only the slots a publish
 * names), a line says when that could not be carried over, and someone who
 * did not first share the skill is offered no credential of theirs (core
 * refuses it).
 *
 * On a first share the sharer also chooses who can use it: Everyone on this
 * server, and named people at Can use / Can edit / Maintainer, with the
 * team-sharing picker. Whether it is a first share is the preview's word
 * (`isRepublish`), not only the row's: a skill shared before from another
 * folder, or whose record was lost, is a later version of that package. Until
 * the preview answers, those controls are disabled, so no pick is lost. A later
 * version leaves access as it is and says so in one line.
 *
 * A first share while packages of this name exist that someone else shares
 * and the person may edit (the preview's `editablePackages`, S6) starts with
 * **Share as**: the next version of one of them (the default) or a separate
 * skill. The next version leaves who can use it and the credentials as that
 * package has them, so those controls give way to a line saying so. They sit
 * below the note, so switching changes only what is under the choice and the
 * note (rule 1): the row under the pointer and the note never move. Share as
 * is a managed list of choices with radio semantics, the chosen row checked
 * in its lead column; the credentials are a list too, a row per slot with
 * its picker, as People picks access. With Share as there is no intro
 * sentence: it would only repeat the rows and the line under the note, and
 * without it Who can use it shows at 800×600. Version and catalog id share
 * one meta line.
 *
 * Share as arrives with the preview, above the note, so the note is disabled
 * (as every other control) until the preview answers and is focused then: a
 * section arriving never pushes a field the user is typing in.
 *
 * A share whose copy is behind the package (the preview's `stale`, or the
 * share refused as `stale`, S5) says who shared which version since, last
 * before the buttons, with Get Version N when the folder has no unshared
 * changes, and otherwise a sentence pointing at Replace on the skill's row
 * (which keeps the changes in a backup); Share stays disabled until a Get
 * and a fresh preview. A share
 * refused because an editable package appeared meanwhile previews again.
 *
 * Top-aligned, and the fields scroll between the heading and the buttons, so
 * neither leaves an 800×600 window and a refusal moves nothing above it.
 *
 * It does not own the share: `onShare` is the caller's, whose mutation
 * outlives the dialog, and the dialog closes on success only. A refusal
 * renders beside the buttons, in the footer's reserved height, moving nothing.
 */
export function ShareSkillDialog({
  agentId,
  skill,
  pending,
  error,
  refusal = null,
  onShare,
  onGetLatest,
  onCancel
}: {
  agentId: string
  skill: LocalAgentSkill
  pending: boolean
  error: string | null
  /** The share's last refusal, for what the dialog does with it: `stale`, `editable_package_exists`. */
  refusal?: SkillPublishRefused | null
  onShare: (input: SkillPublishInput) => void
  /** Get Version N, owned by the caller (it outlives the dialog); the dialog previews again on success. */
  onGetLatest?: () => Promise<SkillGetLatestOutcome>
  onCancel: () => void
}): React.JSX.Element {
  const noteRef = useRef<HTMLTextAreaElement>(null)
  // Fixed for this opening: the share itself records the skill, and the rescan
  // that follows must not turn the dialog into a later version under the user.
  const [sharedAtOpen] = useState(() => skill.shared !== null && skill.shared !== undefined)
  const [state, setState] = useState<PreviewState>({ kind: 'loading' })
  const [note, setNote] = useState('')
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [people, setPeople] = useState<ChosenPerson[]>([])
  const [everyone, setEveryone] = useState(false)
  const { makePublicRef, removeEveryoneRef } = useEveryoneFocusHandOff(everyone)
  // A package uuid of the preview's `editablePackages`, or SEPARATE; null is the first candidate.
  const [shareAs, setShareAs] = useState<string | null>(null)
  // Asked again after a Get, or when the share found an editable package the preview did not list.
  const [previewRound, setPreviewRound] = useState(0)
  const seeded = useRef(false)
  const [getting, setGetting] = useState(false)
  const [getError, setGetError] = useState<string | null>(null)
  const previewReady = state.kind === 'ready'

  // The note waits for the preview (disabled until then), and takes focus once it answers.
  useEffect(() => {
    if (previewReady) noteRef.current?.focus()
  }, [previewReady])

  useEffect(() => {
    let cancelled = false
    void window.api.skillPublish
      .preview(agentId, skill.name)
      .then((outcome) => {
        if (cancelled) return
        if (outcome.ok && !seeded.current) {
          // A later version starts from what the latest version provided; the
          // selects were disabled until now, so nothing the user chose is replaced.
          // Seeded once: a later preview never overwrites a pick.
          seeded.current = true
          setChoices(Object.fromEntries(outcome.preview.credentials.flatMap((slot) => (slot.current ? [[slot.slot, slot.current]] : []))))
        }
        setState(outcome.ok ? { kind: 'ready', preview: outcome.preview } : { kind: 'failed', message: outcome.message })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'failed', message: unwrapIpcError(err, SKILL_SHARE_TEXT.previewFailed) })
      })
    return () => {
      cancelled = true
    }
  }, [agentId, skill.name, previewRound])

  // An editable package appeared between the preview and the share: ask again, so Share as shows it.
  useEffect(() => {
    if (refusal?.code === 'editable_package_exists') setPreviewRound((round) => round + 1)
  }, [refusal])

  const preview = state.kind === 'ready' ? state.preview : null
  const firstShare = !sharedAtOpen && !preview?.isRepublish
  const candidates = firstShare ? (preview?.editablePackages ?? []) : []
  // The package this share becomes the next version of; null for a skill of the person's own.
  const chosen = candidates.length === 0 || shareAs === SEPARATE ? null : (candidates.find((c) => c.packageUuid === shareAs) ?? candidates[0])
  const shown = chosen ?? candidates[0] ?? null
  const stale = refusal?.code === 'stale' && refusal.stale ? refusal.stale : (preview?.stale ?? null)
  // Get brings the newer version in only over a folder with no unshared changes; over one with
  // changes, a sentence points at Replace on the row instead.
  const hasUnshared = skill.sync === 'changed' || skill.sync === 'diverged'
  const canGet = !!onGetLatest && !hasUnshared
  const getLatest = (): void => {
    if (!onGetLatest || getting) return
    setGetError(null)
    setGetting(true)
    onGetLatest()
      .then((result) => {
        if (result.ok) setPreviewRound((round) => round + 1)
        else setGetError(result.message || SKILL_SHARE_TEXT.getFailed)
      })
      .catch((err: unknown) => setGetError(unwrapIpcError(err, SKILL_SHARE_TEXT.getFailed)))
      .finally(() => setGetting(false))
  }
  const canProvide = preview?.canProvide !== false
  const candidatesFor = (slot: string): NonNullable<typeof preview>['credentials'][number]['candidates'] =>
    canProvide ? (preview?.credentials.find((entry) => entry.slot === slot)?.candidates ?? []) : []
  const providersLine =
    preview && !firstShare && skill.credentials.length > 0 && !preview.providersCarried
      ? canProvide
        ? SKILL_SHARE_TEXT.providersNotKept
        : SKILL_SHARE_TEXT.publisherProvidersNotKept
      : null
  // Everyone already covers Can use; such a person is struck, not sent (`publishMeta`).
  const coveredByEveryone = (person: ChosenPerson): boolean => everyone && person.access === 'use'

  const blocked = pending || !preview || stale !== null || getting
  const submit = (): void => {
    if (blocked) return
    onShare({
      agentId,
      name: skill.name,
      releaseNotes: note.trim(),
      ...(chosen
        ? { packageUuid: chosen.packageUuid, ...(chosen.latestRevisionNumber !== null ? { baseRevisionNumber: chosen.latestRevisionNumber } : {}) }
        : firstShare
          ? { people: people.map(({ userId, access }) => ({ userId, access })), everyone, ...(candidates.length > 0 ? { newPackage: true } : {}) }
          : {}),
      // The next version of someone else's package provides nothing of the person's own.
      publisherCredentials: chosen
        ? []
        : Object.entries(choices)
            .filter(([slot, id]) => id !== OWN && candidatesFor(slot).some((candidate) => candidate.id === id))
            .map(([slot, credentialId]) => ({ slot, credentialId }))
    })
  }

  const chosenName = (slot: string): string =>
    candidatesFor(slot).find((candidate) => candidate.id === choices[slot])?.name ?? SKILL_SHARE_TEXT.eachPersonOwn

  const credentialOptions = (slot: string): ManagedListPickerOption<string>[] => [
    { value: OWN, label: SKILL_SHARE_TEXT.eachPersonOwn },
    ...candidatesFor(slot).map((candidate) => ({ value: candidate.id, label: candidate.name }))
  ]
  const credentialsBlock = (
    <div className="space-y-1.5">
      <span className={`block ${DIALOG_HEADING}`}>{SKILL_SHARE_TEXT.needsLabel}</span>
      {/* A row per slot, its choice in the row's picker, as People picks access. */}
      <ManagedList aria-label={SKILL_SHARE_TEXT.needsLabel}>
        {skill.credentials.map((credential) => (
          <ManagedListRow
            key={credential.slot}
            title={credential.slot}
            titleMono
            titleTooltip={
              credential.description
                ? `${credential.slot} (${credential.type}) — ${credential.description}`
                : `${credential.slot} (${credential.type})`
            }
            trailing={
              <ManagedListPicker
                value={choices[credential.slot] ?? OWN}
                options={credentialOptions(credential.slot)}
                label={SKILL_SHARE_TEXT.needsFor(credential.slot)}
                menuLabel={SKILL_SHARE_TEXT.needsFor(credential.slot)}
                title={chosenName(credential.slot)}
                disabled={pending || !preview}
                onChange={(id) => setChoices((current) => ({ ...current, [credential.slot]: id }))}
                className="max-w-[16rem]"
              />
            }
          />
        ))}
      </ManagedList>
      {providersLine && (
        <p data-providers-line className={DIALOG_NOTE}>
          {providersLine}
        </p>
      )}
    </div>
  )
  const whoCanUseBlock = (
    <div className="space-y-1.5">
      {/* People's model: Make public beside the heading puts Everyone at the top of the list. */}
      <WhoCanUseHeading
        title={SKILL_SHARE_TEXT.whoCanUse}
        everyone={everyone}
        disabled={pending || !preview}
        onMakePublic={() => setEveryone(true)}
        makePublicRef={makePublicRef}
      />
      <PeopleSearch
        disabled={pending || !preview}
        exclude={new Set(people.map((person) => person.userId))}
        onPick={(person) => setPeople((list) => [...list, { userId: person.userId, access: 'use', label: personLabel(person) }])}
      />
      <ChosenPeopleList
        people={people}
        disabled={pending || !preview}
        onChange={setPeople}
        emptyText={everyone ? SKILL_SHARE_TEXT.noOneNamed : undefined}
        everyone={{ on: everyone, onRemove: () => setEveryone(false), removeRef: removeEveryoneRef }}
        unsent={{
          is: coveredByEveryone,
          title: (person) => SKILL_SHARE_TEXT.coveredByEveryone(person.label),
          note: SKILL_SHARE_TEXT.everyoneCoversUse
        }}
      />
    </div>
  )

  const title = firstShare ? SKILL_SHARE_TEXT.title(skill.name) : SKILL_SHARE_TEXT.titleNewVersion(skill.name)
  return (
    <DialogShell title={title} pending={pending} onDismiss={onCancel} initialFocusRef={noteRef} align="top">
      <div data-share-skill-body className="-mx-1 min-h-0 flex-1 space-y-2 overflow-y-auto px-1 pb-0.5">
        {candidates.length > 0 && (
          <div data-share-as className="space-y-1.5">
            <span className={`block ${DIALOG_HEADING}`}>{SKILL_SHARE_TEXT.shareAs}</span>
            {/* A choice of one, as rows: the chosen one carries the check. */}
            <ManagedList role="radiogroup" aria-label={SKILL_SHARE_TEXT.shareAs}>
              {[...candidates.map((candidate) => ({
                key: candidate.packageUuid,
                label: SKILL_SHARE_TEXT.newVersionOf(candidate.publisher, skill.name),
                tooltip: candidate.packageId,
                checked: chosen?.packageUuid === candidate.packageUuid,
                pick: () => setShareAs(candidate.packageUuid)
              })), {
                key: SEPARATE,
                label: SKILL_SHARE_TEXT.separateSkill,
                tooltip: undefined,
                checked: chosen === null,
                pick: () => setShareAs(SEPARATE)
              }].map((choice) => (
                <ManagedListRow
                  key={choice.key}
                  lead={<RadioMark checked={choice.checked} />}
                  title={choice.label}
                  titleTooltip={choice.tooltip}
                  radio={{ checked: choice.checked, disabled: pending, onSelect: choice.pick }}
                />
              ))}
            </ManagedList>
          </div>
        )}
        {/* No intro under Share as: its rows say what is published, and the line
            under the note (or Who can use it) says who gets it — the sentence
            would only repeat them, and the room is what lets Who can use it
            show at 800×600. */}
        {candidates.length === 0 && (
          <p className={DIALOG_TEXT}>
            {firstShare ? SKILL_SHARE_TEXT.firstBody : SKILL_SHARE_TEXT.laterBody}
          </p>
        )}
        {/* One meta line: the version, then the catalog id, which gives way first. */}
        <div data-share-meta className="flex min-w-0 items-baseline gap-x-2 text-[13px]">
          <span className="shrink-0 text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.versionLabel}</span>
          <span data-share-version className="shrink-0 text-[var(--color-text)]">
            {chosen
              ? catalogVersionLabel((chosen.latestRevisionNumber ?? 0) + 1, null)
              : preview
                ? catalogVersionLabel(preview.nextRevisionNumber, preview.version)
                : SKILL_SHARE_TEXT.loading}
          </span>
          <span aria-hidden="true" className="shrink-0 text-[var(--color-text-muted)]">·</span>
          <span className="shrink-0 text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.catalogIdLabel}</span>
          <span className="min-w-0 truncate">
            {preview ? (
              <code title={chosen?.packageId ?? preview.packageId} className={DIALOG_CODE}>
                {chosen?.packageId ?? preview.packageId}
              </code>
            ) : (
              <span className="text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.loading}</span>
            )}
          </span>
        </div>
        <label className="block space-y-1">
          <span className={DIALOG_LABEL}>{SKILL_SHARE_TEXT.noteLabel}</span>
          <textarea
            ref={noteRef}
            rows={2}
            value={note}
            disabled={pending || !preview}
            placeholder={SKILL_SHARE_TEXT.notePlaceholder}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submit()
              }
            }}
            // A block, so no line-box gap under it.
            className={`block w-full resize-none ${FIELD_BASE}`}
          />
        </label>
        {/* What the Share as choice decides, below the note: it appears and goes with the radio. */}
        {firstShare &&
          (chosen !== null ? (
            <p data-share-keeps-access className={DIALOG_NOTE}>
              {SKILL_SHARE_TEXT.candidateKeepsAccess(shown?.publisher ?? null)}
            </p>
          ) : (
            whoCanUseBlock
          ))}
        {skill.credentials.length > 0 &&
          (chosen !== null ? (
            <p data-share-keeps-providers className={DIALOG_NOTE}>
              {SKILL_SHARE_TEXT.publisherProvidersNotKept}
            </p>
          ) : (
            credentialsBlock
          ))}
      </div>
      {stale && (
        <div role="alert" data-share-stale className="flex items-center gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[13px] leading-relaxed text-[var(--color-danger)]">{SKILL_SHARE_TEXT.stale(stale.publishedBy, stale.latestRevision)}</p>
            {hasUnshared && (
              <p data-share-stale-changes className={DIALOG_TEXT}>
                {SKILL_SHARE_TEXT.staleHasChanges(stale.latestRevision)}
              </p>
            )}
          </div>
          {canGet && (
            <button type="button" onClick={getLatest} disabled={getting || pending} aria-busy={getting} className={`${SECONDARY} shrink-0`}>
              {getting ? (
                <>
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  {SKILL_SHARE_TEXT.getting}
                </>
              ) : (
                SKILL_SHARE_TEXT.getVersionButton(stale.latestRevision)
              )}
            </button>
          )}
        </div>
      )}
      <DialogFooter
        error={getError ?? (refusal?.code === 'stale' ? null : error) ?? (state.kind === 'failed' ? state.message : null)}
      >
        <button type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SKILL_SHARE_TEXT.cancel}
        </button>
        <button type="button" onClick={submit} disabled={blocked} aria-busy={pending} className={PRIMARY}>
          {pending ? (
            <>
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              {SKILL_SHARE_TEXT.sharing}
            </>
          ) : (
            SKILL_SHARE_TEXT.shareButton
          )}
        </button>
      </DialogFooter>
    </DialogShell>
  )
}
