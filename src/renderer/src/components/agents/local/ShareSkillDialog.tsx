import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { LocalAgentSkill } from '../../../../../shared/localAgents'
import type { SkillPublishInput, SkillPublishPreviewDto } from '../../../../../shared/skillPublish'
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
  personLabel,
  type ChosenPerson
} from './sharing/ShareDialogs'

/** The preview, as the dialog waits for it. */
type PreviewState = { kind: 'loading' } | { kind: 'ready'; preview: SkillPublishPreviewDto } | { kind: 'failed'; message: string }

/** The select's value for "each person connects their own". */
const OWN = ''

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
  onShare,
  onCancel
}: {
  agentId: string
  skill: LocalAgentSkill
  pending: boolean
  error: string | null
  onShare: (input: SkillPublishInput) => void
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

  useEffect(() => {
    let cancelled = false
    void window.api.skillPublish
      .preview(agentId, skill.name)
      .then((outcome) => {
        if (cancelled) return
        if (outcome.ok) {
          // A later version starts from what the latest version provided; the
          // selects were disabled until now, so nothing the user chose is replaced.
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
  }, [agentId, skill.name])

  const preview = state.kind === 'ready' ? state.preview : null
  const firstShare = !sharedAtOpen && !preview?.isRepublish
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

  const submit = (): void => {
    if (pending || !preview) return
    onShare({
      agentId,
      name: skill.name,
      releaseNotes: note.trim(),
      ...(firstShare ? { people: people.map(({ userId, access }) => ({ userId, access })), everyone } : {}),
      publisherCredentials: Object.entries(choices)
        .filter(([slot, id]) => id !== OWN && candidatesFor(slot).some((candidate) => candidate.id === id))
        .map(([slot, credentialId]) => ({ slot, credentialId }))
    })
  }

  const chosenName = (slot: string): string =>
    candidatesFor(slot).find((candidate) => candidate.id === choices[slot])?.name ?? SKILL_SHARE_TEXT.eachPersonOwn

  const title = firstShare ? SKILL_SHARE_TEXT.title(skill.name) : SKILL_SHARE_TEXT.titleNewVersion(skill.name)
  return (
    <DialogShell title={title} pending={pending} onDismiss={onCancel} initialFocusRef={noteRef} align="top">
      <div data-share-skill-body className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-0.5">
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          {firstShare ? SKILL_SHARE_TEXT.firstBody : SKILL_SHARE_TEXT.laterBody}
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs">
          <dt className="text-[11px] text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.versionLabel}</dt>
          <dd data-share-version className="truncate text-[var(--color-text)]">
            {preview ? catalogVersionLabel(preview.nextRevisionNumber, preview.version) : SKILL_SHARE_TEXT.loading}
          </dd>
          <dt className="text-[11px] text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.catalogIdLabel}</dt>
          <dd className="min-w-0 truncate">
            {preview ? (
              <code title={preview.packageId} className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[11px] text-[var(--color-text-secondary)]">
                {preview.packageId}
              </code>
            ) : (
              <span className="text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.loading}</span>
            )}
          </dd>
        </dl>
        {skill.credentials.length > 0 && (
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
        )}
        <label className="block space-y-1">
          <span className="block text-[11px] text-[var(--color-text-muted)]">{SKILL_SHARE_TEXT.noteLabel}</span>
          <textarea
            ref={noteRef}
            rows={2}
            value={note}
            disabled={pending}
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
        {firstShare && (
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
        )}
      </div>
      <ErrorLine error={error ?? (state.kind === 'failed' ? state.message : null)} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SKILL_SHARE_TEXT.cancel}
        </button>
        <button type="button" onClick={submit} disabled={pending || !preview} aria-busy={pending} className={PRIMARY}>
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
