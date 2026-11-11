import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CANCEL, DIALOG_LABEL, DialogFooter, DialogShell, FIELD_BASE, PRIMARY } from '../agents/local/sharing/ShareDialogs'
import { VisibilitySegments } from './VisibilitySegments'
import { ManagedList, ManagedListMessage, ManagedListPicker, ManagedListRow } from '../ui/ManagedList'
import { useArtifactPublishStore, type PublishRequest } from '../../stores/artifactPublish.store'
import { useArtifactsSupport } from '../../hooks/useArtifacts'
import { unwrapIpcError } from '../../utils/ipcError'
import {
  artifactKindLine,
  formatArtifactBytes,
  type ArtifactInspection,
  type ArtifactOverLimits,
  type PublishVisibility
} from '../../../../shared/artifacts'
import { agentFileName } from '../../../../shared/agentFiles'

/**
 * The total line over a limit, with the size it reached. The walk stops
 * counting once a limit is passed, so a total is "at least" what it counted.
 */
function overLimitsText(over: ArtifactOverLimits, inspection: ArtifactInspection): string {
  const { limits } = inspection
  if (over.files) return `More than ${limits.maxRevisionFiles.toLocaleString('en-US')} files — over the ${limits.maxRevisionFiles.toLocaleString('en-US')}-file limit`
  if (over.size) return `At least ${formatArtifactBytes(inspection.size)} — over the ${formatArtifactBytes(limits.maxRevisionBytes)} limit`
  const name = over.perFile[0]
  const size = inspection.files.find((file) => file.path === name)?.size
  return `${name ?? 'A file'}${size !== undefined ? ` is ${formatArtifactBytes(size)}` : ''} — over the ${formatArtifactBytes(limits.maxFileBytes)} per-file limit`
}

/** The title a file or folder starts with: its name, a file's without the extension. */
export function defaultArtifactTitle(path: string, kind: 'file' | 'dir'): string {
  const name = agentFileName(path)
  if (kind === 'dir') return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

const PHASE_LABEL = { packing: 'Packing…', uploading: 'Uploading…', sharing: 'Sharing…' } as const

type Inspected = { status: 'loading' } | { status: 'ready'; inspection: ArtifactInspection } | { status: 'failed'; message: string }

/**
 * A choice of a few, as the Theme pills in Settings › Features: one bordered
 * group of buttons, the pressed one in the active-nav tint.
 */
const SEGMENTS = 'flex min-w-0 max-w-full shrink-0 rounded-md border border-[var(--color-border)] p-0.5'
function segment(pressed: boolean): string {
  return `rounded px-2.5 py-1 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    pressed ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'
  }`
}

/** Who can see it: short labels, the server named in the line under the group. */
const VISIBILITY_OPTIONS: Array<{ value: PublishVisibility; label: string }> = [
  { value: 'private', label: 'Only me' },
  { value: 'instance', label: 'Everyone' },
  { value: 'link', label: 'Anyone with a link' }
]

/** What a visibility means, naming the server: the line under the group. */
export function publishVisibilityLine(visibility: PublishVisibility, instanceName: string): string {
  if (visibility === 'instance') return `Everyone on ${instanceName} can open it`
  if (visibility === 'link') return 'A public link is made — anyone with it can open it'
  return `Only you can open it on ${instanceName}`
}

/**
 * The Publish dialog: one global instance, opened from a file reference's
 * menu or the file preview, driven by {@link useArtifactPublishStore}.
 *
 * **Fixed layout.** Every row is there from the first frame with the same
 * height in every state — the kind line, the file list (sharing one fixed
 * block with the start-page picker's own row when the folder needs one, so
 * the picker's arrival only shortens the list), the total line, the Update /
 * Publish-as-new line, Who can see it — so nothing moves while the user types
 * or the inspection lands. The two choices are segmented groups, the start
 * page the managed list's field picker and the files a managed list.
 * Top-anchored, the fields scrolling between the heading and the buttons at a
 * small window: a refusal renders in the footer beside the buttons, in a
 * height reserved for it, and closes nothing; while publishing the dialog cannot be
 * dismissed and the button says the phase.
 */
export function PublishArtifactDialog(): React.JSX.Element | null {
  const request = useArtifactPublishStore((s) => s.request)
  const openSeq = useArtifactPublishStore((s) => s.openSeq)
  if (!request) return null
  return <PublishArtifactDialogBody key={openSeq} request={request} />
}

function PublishArtifactDialogBody({ request }: { request: PublishRequest }): React.JSX.Element {
  const { publishing, phase, error, goneArtifactId, close, publish } = useArtifactPublishStore()
  const support = useArtifactsSupport()
  const titleRef = useRef<HTMLInputElement>(null)
  // Edit… on an agent's request starts from what the agent asked for.
  const [title, setTitle] = useState(() => request.approval?.title ?? defaultArtifactTitle(request.path, request.kind))
  const [description, setDescription] = useState(request.approval?.description ?? '')
  const [visibility, setVisibility] = useState<PublishVisibility>('private')
  const [entry, setEntry] = useState<string>(request.approval?.entry ?? '')
  /** Update the known artifact (its id), or publish as new (null). */
  const [target, setTarget] = useState<string | null>(null)
  const touched = useRef({ title: request.approval !== undefined, visibility: false })
  const [inspected, setInspected] = useState<Inspected>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    window.api.artifacts
      .inspect({ agentId: request.agentId, path: request.path })
      .then((outcome) => {
        if (cancelled) return
        if (!outcome.ok) {
          setInspected({ status: 'failed', message: outcome.message })
          return
        }
        const { inspection } = outcome
        setInspected({ status: 'ready', inspection })
        const previous = inspection.previous
        if (previous) {
          // Update is the default for a path published before.
          setTarget(previous.artifactId)
          if (!touched.current.title) setTitle(previous.title)
          if (!touched.current.visibility) setVisibility(previous.visibility)
        }
      })
      .catch((err) => {
        if (!cancelled) setInspected({ status: 'failed', message: unwrapIpcError(err, 'Could not read this file or folder.') })
      })
    return () => {
      cancelled = true
    }
  }, [request.agentId, request.path])

  // A refusal saying the artifact is gone switches to New artifact.
  useEffect(() => {
    if (goneArtifactId && target === goneArtifactId) setTarget(null)
  }, [goneArtifactId, target])

  const inspection = inspected.status === 'ready' ? inspected.inspection : null
  const instanceName = inspection?.instanceName ?? support.instanceName ?? 'the instance'
  const chosenEntry = inspection && inspection.entryCandidates.length > 0 ? entry : ''
  const kind = inspection ? (inspection.kind === 'site' || chosenEntry ? 'site' : 'files') : null
  const picker = inspection !== null && inspection.entryCandidates.length > 0
  // With the picker shown, it names the start page; the kind line does not repeat it.
  const kindLine = inspection
    ? picker && chosenEntry
      ? 'Mini-site'
      : artifactKindLine({
          isFolder: inspection.isFolder,
          kind: kind ?? 'files',
          entry: chosenEntry || inspection.entry,
          fileCount: inspection.files.length,
          name: inspection.name
        })
    : inspected.status === 'failed'
      ? '—'
      : '\u00a0'
  const previous = inspection?.previous ?? null
  const updating = previous !== null && target === previous.artifactId
  const blocked =
    !inspection || inspection.files.length === 0 || inspection.overLimits !== null || title.trim() === ''

  const rows = useMemo(() => {
    if (!inspection) return []
    const kept = inspection.files.map((file) => ({ path: file.path, size: file.size as number | null, reason: null as string | null }))
    const dropped = inspection.excluded.map((item) => ({ path: item.path, size: null, reason: item.reason as string }))
    return [...kept, ...dropped].sort((a, b) => a.path.localeCompare(b.path))
  }, [inspection])

  const totalLine = !inspection
    ? '\u00a0'
    : inspection.overLimits
      ? overLimitsText(inspection.overLimits, inspection)
      : inspection.files.length === 0
        ? 'Nothing to publish — every file here is left out'
        : title.trim() === ''
          ? 'Add a title to publish'
          : `${formatArtifactBytes(inspection.size)} of ${formatArtifactBytes(inspection.limits.maxRevisionBytes)}`

  const submit = (): void => {
    if (publishing || blocked) return
    void publish({
      title: title.trim(),
      description: description.trim() || undefined,
      entry: chosenEntry || null,
      artifactId: updating ? previous.artifactId : null,
      visibility
    })
  }

  const label = `${DIALOG_LABEL} mb-1`
  // The segment says the revision; its tooltip the whole title too (rule 10: named by what it shows).
  const updateText = previous ? `Update rev ${previous.revision}` : ''
  const updateTitle = previous ? `Update “${previous.title}” (rev ${previous.revision})` : ''
  return (
    <DialogShell
      title={request.approval?.agentName ? `Publish for ${request.approval.agentName}` : 'Publish to Cinna'}
      pending={publishing}
      onDismiss={close}
      initialFocusRef={titleRef}
      width="w-[36rem]"
      align="top"
    >
      <form
        className="flex min-h-0 flex-1 flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-0.5">
          <div>
            <label htmlFor="artifact-title" className={label}>Title</label>
            <input
              id="artifact-title"
              ref={titleRef}
              value={title}
              maxLength={200}
              disabled={publishing}
              onChange={(event) => {
                touched.current.title = true
                setTitle(event.target.value)
              }}
              className={`w-full ${FIELD_BASE}`}
            />
          </div>
          <div>
            <label htmlFor="artifact-description" className={label}>Description</label>
            <textarea
              id="artifact-description"
              value={description}
              rows={2}
              maxLength={2000}
              disabled={publishing}
              placeholder="Optional"
              onChange={(event) => setDescription(event.target.value)}
              className={`w-full resize-none ${FIELD_BASE}`}
            />
          </div>

          {/* The kind line: one line in every state. */}
          <div className="flex h-[1lh] items-center gap-2 text-[13px] text-[var(--color-text-secondary)]" data-artifact-kind>
            <span className="truncate">{kindLine}</span>
          </div>

          {/* Reserved: the start page (its label above the picker) and the list
              share one fixed block, so the picker's arrival only shortens the
              list. At 13px, so 1lh is a line of the label and of the field:
              the label (1lh + mb-1 0.25rem), the field (1lh + py-1.5 0.75rem +
              2px border), the gap (0.5rem), then three settings rows
              (3 × --ml-row-h 40px) and the surface's padding (2 × 3px). */}
          <div className="flex h-[calc(2lh+1.5rem+128px)] flex-col gap-2 text-[13px]" data-artifact-files-block>
            {picker && (
              <div className="flex shrink-0 flex-col">
                <span aria-hidden="true" className={label}>Start page</span>
                <ManagedListPicker
                  variant="field"
                  value={entry}
                  options={[
                    { value: '', label: 'None — browse the files' },
                    ...inspection.entryCandidates.map((candidate) => ({ value: candidate, label: candidate }))
                  ]}
                  label="Start page"
                  menuLabel="Start page"
                  title={entry || 'None — browse the files'}
                  disabled={publishing}
                  onChange={setEntry}
                  className="w-full"
                />
              </div>
            )}
            <div className="min-h-0 flex-1 [&>div]:h-full">
              <ManagedList
                aria-label="Files to publish"
                aria-busy={inspected.status === 'loading'}
                surfaceClassName="h-full overflow-y-auto"
                message={
                  inspected.status === 'loading' ? (
                    <ManagedListMessage role="status">
                      <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
                      Reading…
                    </ManagedListMessage>
                  ) : inspected.status === 'failed' ? (
                    <ManagedListMessage role="alert" tone="danger">
                      {inspected.message}
                    </ManagedListMessage>
                  ) : undefined
                }
              >
                {rows.map((row) => (
                  <ManagedListRow
                    key={row.path}
                    title={
                      <span className={row.reason ? 'text-[var(--color-text-muted)] line-through' : undefined}>{row.path}</span>
                    }
                    titleMono
                    titleClassName="font-normal"
                    titleTooltip={row.reason ? `${row.path} — left out: ${row.reason}` : row.path}
                    meta={row.reason ?? formatArtifactBytes(row.size ?? 0)}
                  />
                ))}
              </ManagedList>
            </div>
          </div>
          <div
            data-artifact-total
            className={`h-[1lh] truncate text-[13px] ${inspection?.overLimits || inspection?.files.length === 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}
          >
            {totalLine}
          </div>

          {/* Update or new: one row in every state, the segmented group's height, so its arrival moves nothing. */}
          <div>
            <span id="artifact-target-label" className={label}>Artifact</span>
            <div className="flex h-[2.125rem] items-center">
              {previous ? (
                <div role="group" aria-labelledby="artifact-target-label" className={SEGMENTS}>
                  <button
                    type="button"
                    aria-pressed={updating}
                    disabled={publishing}
                    title={updateTitle}
                    onClick={() => setTarget(previous.artifactId)}
                    className={`shrink-0 whitespace-nowrap ${segment(updating)}`}
                  >
                    {updateText}
                  </button>
                  <button
                    type="button"
                    aria-pressed={!updating}
                    disabled={publishing}
                    onClick={() => setTarget(null)}
                    className={`shrink-0 whitespace-nowrap ${segment(!updating)}`}
                  >
                    New artifact
                  </button>
                </div>
              ) : (
                <span className="text-[13px] text-[var(--color-text-muted)]">
                  {inspection ? `A new artifact on ${instanceName}` : '\u00a0'}
                </span>
              )}
            </div>
          </div>

          <div>
            <span id="artifact-visibility-label" className={label}>Who can see it</span>
            <VisibilitySegments
              options={VISIBILITY_OPTIONS}
              value={visibility}
              labelledBy="artifact-visibility-label"
              line={publishVisibilityLine(visibility, instanceName)}
              disabled={publishing}
              // Called for a new value only: picking the pressed one again is not a choice,
              // so the previous artifact's audience is still adopted while the files load.
              onPick={(value) => {
                touched.current.visibility = true
                setVisibility(value)
              }}
            />
          </div>
        </div>

        <DialogFooter error={error}>
          <button type="button" className={CANCEL} disabled={publishing} onClick={close}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={publishing || blocked} aria-busy={publishing || undefined}>
            {publishing && <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {publishing ? (phase ? PHASE_LABEL[phase] : 'Publishing…') : 'Publish'}
          </button>
        </DialogFooter>
      </form>
    </DialogShell>
  )
}
