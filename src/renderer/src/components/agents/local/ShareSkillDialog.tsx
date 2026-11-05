import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { LocalAgentSkill } from '../../../../../shared/localAgents'
import type { SkillGetLatestOutcome, SkillPublishInput, SkillPublishPreviewDto, SkillPublishRefused } from '../../../../../shared/skillPublish'
import { unwrapIpcError } from '../../../utils/ipcError'
import { SKILL_SHARE_TEXT, catalogVersionLabel } from '../../../utils/catalogItems'
import {
  CANCEL,
  ChosenPeopleList,
  DialogShell,
  ErrorLine,
  FIELD_BASE,
  PeopleSearch,
  PRIMARY,
  SECONDARY,
  personLabel,
  type ChosenPerson
} from './sharing/ShareDialogs'

/** The preview, as the dialog waits for it. */
type PreviewState = { kind: 'loading' } | { kind: 'ready'; preview: SkillPublishPreviewDto } | { kind: 'failed'; message: string }

/** The select's value for "each person connects their own". */
const OWN = ''

/** "Share as" picking a separate skill rather than one of the editable packages. */
const SEPARATE = 'separate'

/**
 * Two contents in one grid cell, one shown: the area is as tall as the taller
 * of the two, so switching between them moves nothing below (rule 1). The
 * other is kept laid out but invisible, hidden from assistive tech and inert.
 * Only for the one-sentence intro: a tall block in one cell reserves its
 * height as blank space when the short one is shown.
 */
function SwapArea({ second, first, alternate }: { second: boolean; first: React.ReactNode; alternate: React.ReactNode }): React.JSX.Element {
  const cell = 'col-start-1 row-start-1 min-w-0'
  return (
    <div data-share-swap className="grid">
      <div className={second ? `${cell} invisible` : cell} aria-hidden={second || undefined} inert={second || undefined}>
        {first}
      </div>
      <div className={second ? cell : `${cell} invisible`} aria-hidden={!second || undefined} inert={!second || undefined}>
        {alternate}
      </div>
    </div>
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
 * below the note, so switching changes only what is under the radios and the
 * note (rule 1): the radio under the pointer and the note never move. The
 * intro sentence above the note swaps in one grid cell ({@link SwapArea}).
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
 * renders under the fields, last before the buttons, moving nothing above it.
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

  const credentialsBlock = (
    <div className="space-y-1">
      <span className="block text-[11px] text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.needsLabel}</span>
      <ul aria-label={SKILL_SHARE_TEXT.needsLabel} className="space-y-1">
        {skill.credentials.map((credential) => (
          <li key={credential.slot} className="flex items-center gap-2">
            <code
              title={credential.description ? `${credential.slot} (${credential.type}) — ${credential.description}` : `${credential.slot} (${credential.type})`}
              className="min-w-0 flex-1 truncate rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[11px] text-[var(--color-text-secondary)]"
            >
              {credential.slot}
            </code>
            <select
              aria-label={SKILL_SHARE_TEXT.needsFor(credential.slot)}
              title={chosenName(credential.slot)}
              value={choices[credential.slot] ?? OWN}
              disabled={pending || !preview}
              onChange={(event) => setChoices((current) => ({ ...current, [credential.slot]: event.target.value }))}
              className={`${FIELD_BASE} w-[16rem] shrink-0 truncate`}
            >
              <option value={OWN}>{SKILL_SHARE_TEXT.eachPersonOwn}</option>
              {candidatesFor(credential.slot).map((candidate) => (
                <option key={candidate.id} value={candidate.id} title={candidate.name}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {providersLine && (
        <p data-providers-line className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          {providersLine}
        </p>
      )}
    </div>
  )
  const whoCanUseBlock = (
    <div className="space-y-2">
      <span className="block text-[11px] font-medium text-[var(--color-text-secondary)]">{SKILL_SHARE_TEXT.whoCanUse}</span>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text)]">
        <input
          type="checkbox"
          className="accent-[var(--color-accent)]"
          checked={everyone}
          disabled={pending || !preview}
          onChange={(event) => setEveryone(event.target.checked)}
        />
        {SKILL_SHARE_TEXT.everyone}
      </label>
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
      <div data-share-skill-body className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-0.5">
        {candidates.length > 0 && (
          <fieldset data-share-as className="space-y-1">
            <legend className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">{SKILL_SHARE_TEXT.shareAs}</legend>
            {candidates.map((candidate) => (
              <label key={candidate.packageUuid} title={candidate.packageId} className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text)]">
                <input
                  type="radio"
                  name="share-as"
                  className="accent-[var(--color-accent)]"
                  checked={chosen?.packageUuid === candidate.packageUuid}
                  disabled={pending}
                  onChange={() => setShareAs(candidate.packageUuid)}
                />
                <span className="min-w-0 truncate">{SKILL_SHARE_TEXT.newVersionOf(candidate.publisher, skill.name)}</span>
              </label>
            ))}
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text)]">
              <input
                type="radio"
                name="share-as"
                className="accent-[var(--color-accent)]"
                checked={chosen === null}
                disabled={pending}
                onChange={() => setShareAs(SEPARATE)}
              />
              {SKILL_SHARE_TEXT.separateSkill}
            </label>
          </fieldset>
        )}
        {candidates.length > 0 ? (
          <SwapArea
            second={chosen !== null}
            first={<p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{SKILL_SHARE_TEXT.firstBody}</p>}
            alternate={<p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{SKILL_SHARE_TEXT.laterBody}</p>}
          />
        ) : (
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
            {firstShare ? SKILL_SHARE_TEXT.firstBody : SKILL_SHARE_TEXT.laterBody}
          </p>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs">
          <dt className="text-[11px] text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.versionLabel}</dt>
          <dd data-share-version className="truncate text-[var(--color-text)]">
            {chosen
              ? catalogVersionLabel((chosen.latestRevisionNumber ?? 0) + 1, null)
              : preview
                ? catalogVersionLabel(preview.nextRevisionNumber, preview.version)
                : SKILL_SHARE_TEXT.loading}
          </dd>
          <dt className="text-[11px] text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.catalogIdLabel}</dt>
          <dd className="min-w-0 truncate">
            {preview ? (
              <code
                title={chosen?.packageId ?? preview.packageId}
                className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[11px] text-[var(--color-text-secondary)]"
              >
                {chosen?.packageId ?? preview.packageId}
              </code>
            ) : (
              <span className="text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.loading}</span>
            )}
          </dd>
        </dl>
        <label className="block space-y-1">
          <span className="block text-[11px] text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.noteLabel}</span>
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
            className={`w-full resize-none ${FIELD_BASE}`}
          />
        </label>
        {/* What the Share as choice decides, below the note: it appears and goes with the radio. */}
        {firstShare &&
          (chosen !== null ? (
            <p data-share-keeps-access className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {SKILL_SHARE_TEXT.candidateKeepsAccess(shown?.publisher ?? null)}
            </p>
          ) : (
            whoCanUseBlock
          ))}
        {skill.credentials.length > 0 &&
          (chosen !== null ? (
            <p data-share-keeps-providers className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {SKILL_SHARE_TEXT.publisherProvidersNotKept}
            </p>
          ) : (
            credentialsBlock
          ))}
      </div>
      {stale && (
        <div role="alert" data-share-stale className="flex items-center gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[11px] leading-relaxed text-[var(--color-danger)]">{SKILL_SHARE_TEXT.stale(stale.publishedBy, stale.latestRevision)}</p>
            {hasUnshared && (
              <p data-share-stale-changes className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                {SKILL_SHARE_TEXT.staleHasChanges(stale.latestRevision)}
              </p>
            )}
          </div>
          {canGet && (
            <button type="button" onClick={getLatest} disabled={getting || pending} aria-busy={getting} className={`${SECONDARY} shrink-0`}>
              {getting ? (
                <>
                  <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                  {SKILL_SHARE_TEXT.getting}
                </>
              ) : (
                SKILL_SHARE_TEXT.getVersionButton(stale.latestRevision)
              )}
            </button>
          )}
        </div>
      )}
      <ErrorLine
        error={getError ?? (refusal?.code === 'stale' ? null : error) ?? (state.kind === 'failed' ? state.message : null)}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SKILL_SHARE_TEXT.cancel}
        </button>
        <button type="button" onClick={submit} disabled={blocked} aria-busy={pending} className={PRIMARY}>
          {pending ? (
            <>
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {SKILL_SHARE_TEXT.sharing}
            </>
          ) : (
            SKILL_SHARE_TEXT.shareButton
          )}
        </button>
      </div>
    </DialogShell>
  )
}
