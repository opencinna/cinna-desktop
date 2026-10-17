import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CANCEL, DialogShell, ErrorLine, FIELD_BASE, PRIMARY } from '../agents/local/sharing/ShareDialogs'
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
 * The Publish dialog: one global instance, opened from a file reference's
 * menu or the file preview, driven by {@link useArtifactPublishStore}.
 *
 * **Fixed layout.** Every row is there from the first frame with the same
 * height in every state — the kind line, the file list (sharing one fixed
 * block with the start-page picker's own row when the folder needs one, so
 * the picker's arrival only shortens the list), the total line, the Update /
 * Publish-as-new line, Who can see it — so nothing moves while the user types
 * or the inspection lands. Top-anchored: a refusal renders last, under the
 * buttons, lengthens the dialog downward and closes nothing; while
 * publishing the dialog cannot be dismissed and the button says the phase.
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

  // A refusal saying the artifact is gone switches to Publish as new.
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

  const radioClass = 'flex items-center gap-2 text-xs text-[var(--color-text)]'
  const label = 'block text-[11px] text-[var(--color-text-muted)] mb-1'
  return (
    <DialogShell
      title={request.approval?.agentName ? `Publish for ${request.approval.agentName}` : 'Publish to Cinna'}
      pending={publishing}
      onDismiss={close}
      initialFocusRef={titleRef}
      width="w-[34rem]"
      align="top"
    >
      <form
        className="min-h-0 flex-1 space-y-3 overflow-y-auto"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
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

        {/* The kind line: one row in every state. */}
        <div className="flex h-7 items-center gap-2 text-xs text-[var(--color-text-secondary)]" data-artifact-kind>
          <span className="truncate">{kindLine}</span>
        </div>

        {/* Reserved: the picker's row and the list share one fixed block, so the picker's arrival only shortens the list. */}
        <div className="flex h-40 flex-col gap-2" data-artifact-files-block>
          {picker && (
            <label className="flex h-7 shrink-0 items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span className="shrink-0">Start page</span>
              <select
                value={entry}
                disabled={publishing}
                onChange={(event) => setEntry(event.target.value)}
                className={`min-w-0 flex-1 py-0.5 ${FIELD_BASE}`}
              >
                <option value="">None — browse the files</option>
                {inspection.entryCandidates.map((candidate) => (
                  <option key={candidate} value={candidate}>{candidate}</option>
                ))}
              </select>
            </label>
          )}
          <div
            role="list"
            aria-label="Files to publish"
            aria-busy={inspected.status === 'loading' || undefined}
            className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1"
          >
            {inspected.status === 'loading' && (
              <div className="flex h-full items-center justify-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
                Reading…
              </div>
            )}
            {inspected.status === 'failed' && (
              <p role="alert" className="flex h-full items-center justify-center px-3 text-center text-xs text-[var(--color-danger)]">
                {inspected.message}
              </p>
            )}
            {rows.map((row) => (
              <div
                key={row.path}
                role="listitem"
                className="flex items-center gap-2 px-2.5 py-0.5 font-mono text-[11px]"
                title={row.reason ? `${row.path} — left out: ${row.reason}` : row.path}
              >
                <span className={`min-w-0 flex-1 truncate ${row.reason ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-text)]'}`}>
                  {row.path}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {row.reason ?? formatArtifactBytes(row.size ?? 0)}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div
          data-artifact-total
          className={`h-4 text-[11px] ${inspection?.overLimits || inspection?.files.length === 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}
        >
          {totalLine}
        </div>

        {/* Update or new: a line in every state, so its arrival moves nothing. */}
        <div className="flex h-6 items-center gap-4" role="radiogroup" aria-label="Publish as">
          {previous ? (
            <>
              <label className={`${radioClass} min-w-0`} title={`Update “${previous.title}” (rev ${previous.revision})`}>
                <input type="radio" name="artifact-target" checked={updating} disabled={publishing} onChange={() => setTarget(previous.artifactId)} />
                <span className="truncate">Update “{previous.title}” (rev {previous.revision})</span>
              </label>
              <label className={`${radioClass} shrink-0`}>
                <input type="radio" name="artifact-target" checked={!updating} disabled={publishing} onChange={() => setTarget(null)} />
                Publish as new
              </label>
            </>
          ) : (
            <span className="text-xs text-[var(--color-text-muted)]">
              {inspection ? `A new artifact on ${instanceName}` : ' '}
            </span>
          )}
        </div>

        <fieldset className="space-y-1.5" disabled={publishing}>
          <legend className={label}>Who can see it</legend>
          {(
            [
              ['private', 'Only me'],
              ['instance', `Everyone on ${instanceName}`],
              ['link', 'Anyone with a link']
            ] as Array<[PublishVisibility, string]>
          ).map(([value, text]) => (
            <label key={value} className={radioClass}>
              <input
                type="radio"
                name="artifact-visibility"
                checked={visibility === value}
                onChange={() => {
                  touched.current.visibility = true
                  setVisibility(value)
                }}
              />
              {text}
            </label>
          ))}
        </fieldset>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={CANCEL} disabled={publishing} onClick={close}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={publishing || blocked} aria-busy={publishing || undefined}>
            {publishing && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {publishing ? (phase ? PHASE_LABEL[phase] : 'Publishing…') : 'Publish'}
          </button>
        </div>
        <ErrorLine error={error} />
      </form>
    </DialogShell>
  )
}
