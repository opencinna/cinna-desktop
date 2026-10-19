import { useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { ArtifactCard } from './ArtifactCard'
import { useArtifactApprovals, useArtifactsSupport, useLocalArtifact } from '../../hooks/useArtifacts'
import { useArtifactPublishStore } from '../../stores/artifactPublish.store'
import { unwrapIpcError } from '../../utils/ipcError'
import {
  ARTIFACT_REFUSAL_NOTE_PREFIX,
  ARTIFACT_SKIPPED_NOTE_PREFIX,
  artifactRefusalLine,
  formatArtifactBytes,
  type ArtifactApprovalSummary,
  type ArtifactPublishToolResult,
  type PublishedArtifact
} from '../../../../shared/artifacts'

const PRIMARY =
  'inline-flex min-w-[5.5rem] items-center justify-center gap-1 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50'
const SECONDARY =
  'inline-flex items-center justify-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50'
const CANCEL =
  'rounded-md px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50'

/**
 * An agent asks to publish: the same summary as the Publish dialog — title,
 * kind, the files with what is left out struck through, size, who would see
 * it — and Deny / Edit… / Publish. The call waits on this card (and on its
 * Inbox row). A busy answer spins inside its button; a failure is said in
 * the card, which stays.
 */
export function ArtifactApprovalCard({ summary }: { summary: ArtifactApprovalSummary }): React.JSX.Element {
  const [busy, setBusy] = useState<'publish' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rows = [
    ...summary.files.map((file) => ({ path: file.path, note: formatArtifactBytes(file.size), excluded: false })),
    ...summary.excluded.map((item) => ({ path: item.path, note: item.reason as string, excluded: true }))
  ].sort((a, b) => a.path.localeCompare(b.path))

  const answer = async (decision: 'publish' | 'deny'): Promise<void> => {
    if (busy) return
    setBusy(decision)
    setError(null)
    try {
      const result = await window.api.artifacts.answerApproval({ requestId: summary.requestId, decision })
      if (!result.ok) setError(result.message)
    } catch (err) {
      setError(unwrapIpcError(err, 'Could not answer the request.'))
    } finally {
      setBusy(null)
    }
  }

  const edit = (): void => {
    useArtifactPublishStore.getState().open({
      agentId: summary.agentId,
      path: summary.path,
      kind: summary.isFolder ? 'dir' : 'file',
      chatId: summary.chatId,
      messageId: null,
      approval: { requestId: summary.requestId, title: summary.title, description: summary.description, entry: summary.entry, agentName: summary.agentName }
    })
  }

  return (
    <div
      role="group"
      aria-label={`Publish request: ${summary.title}`}
      data-artifact-approval={summary.requestId}
      className="max-w-lg rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-overlay-panel)] px-3 py-2.5 backdrop-blur-xl"
    >
      <div className="flex items-center gap-2">
        <Upload size={14} className="shrink-0 text-[var(--color-accent)]" aria-hidden />
        <div className="min-w-0 flex-1 text-xs text-[var(--color-text)]">
          <span className="text-[var(--color-text-secondary)]">{summary.agentName} wants to publish </span>
          <span className="font-medium">“{summary.title}”</span>
        </div>
      </div>
      <div className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]">
        {summary.kindLine} · <span className="font-mono">{summary.relativePath}</span>
      </div>
      {summary.description && <div className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">{summary.description}</div>}
      <div role="list" aria-label="Files to publish" className="mt-2 max-h-28 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1">
        {rows.map((row) => (
          <div key={row.path} role="listitem" className="flex items-center gap-2 px-2 py-px font-mono text-[11px]">
            <span className={`min-w-0 flex-1 truncate ${row.excluded ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-text)]'}`}>{row.path}</span>
            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{row.note}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-[11px] text-[var(--color-text-secondary)]">
        {formatArtifactBytes(summary.size)} · {summary.update ? `updates “${summary.update.title}” (rev ${summary.update.revision})` : 'new artifact'} · visible to {summary.audience}
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <button type="button" className={CANCEL} disabled={busy !== null} onClick={() => void answer('deny')}>
          {busy === 'deny' ? 'Denying…' : 'Deny'}
        </button>
        <button type="button" className={SECONDARY} disabled={busy !== null} onClick={edit}>
          Edit…
        </button>
        <button type="button" className={PRIMARY} disabled={busy !== null} aria-busy={busy === 'publish' || undefined} onClick={() => void answer('publish')}>
          {busy === 'publish' && <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />}
          {busy === 'publish' ? 'Publishing…' : 'Publish'}
        </button>
      </div>
      {error && <p role="alert" className="mt-1.5 text-[11px] text-[var(--color-danger)]">{error}</p>}
    </div>
  )
}

/** The schema result persisted on the tool row, or null for anything else. */
export function parsePublishResult(content: unknown): ArtifactPublishToolResult | null {
  let value = content
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const result = value as Partial<ArtifactPublishToolResult>
  return typeof result.artifact_id === 'string' && typeof result.revision === 'number' && typeof result.url === 'string'
    ? (result as ArtifactPublishToolResult)
    : null
}

/**
 * `artifacts_publish` in the transcript, live and after a reload: the
 * approval card while it waits, the artifact's card once published (read
 * from the local memory, so Share… reflects later changes) — a republish that
 * needed no card says so above it — a line when it was declined or failed.
 */
export function ArtifactPublishToolBlock({
  chatId,
  toolCallId,
  input,
  status,
  result,
  error,
  parts
}: {
  chatId: string
  toolCallId: string
  input: Record<string, unknown> | null | undefined
  status: 'pending' | 'done' | 'error'
  result?: unknown
  error?: string
  parts?: ReadonlyArray<{ kind: string; text: string }> | null
}): React.JSX.Element {
  const approvals = useArtifactApprovals(status === 'pending' ? chatId : null)
  const parsed = status === 'done' ? parsePublishResult(result) : null
  const local = useLocalArtifact(parsed?.artifact_id ?? null)
  const { instanceName } = useArtifactsSupport()
  const title = typeof input?.title === 'string' ? input.title : 'artifact'
  const line = 'text-[11px] text-[var(--color-text-secondary)]'

  if (status === 'pending') {
    const approval = approvals.find((entry) => entry.toolCallId === toolCallId)
    if (approval) return <ArtifactApprovalCard summary={approval} />
    return (
      <div className={`flex items-center gap-1.5 ${line}`} data-artifact-tool="pending">
        <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />
        Publishing “{title}”…
      </div>
    )
  }
  if (status === 'error' || !parsed) {
    // The agent read its own sentence; the person reads the row's note, in their words.
    const message = error ?? (typeof result === 'string' ? result : '')
    const refusal = parts?.find((part) => part.kind === 'notice' && part.text.startsWith(ARTIFACT_REFUSAL_NOTE_PREFIX))?.text
    const text = artifactRefusalLine(refusal, message)
    return (
      <div className={line} data-artifact-tool={text === 'Not published — you declined' ? 'declined' : 'failed'}>
        {text}
      </div>
    )
  }
  const skipped = parts?.some((part) => part.kind === 'notice' && part.text.startsWith(ARTIFACT_SKIPPED_NOTE_PREFIX)) ?? false
  const artifact: PublishedArtifact = local.data ?? {
    id: parsed.artifact_id,
    title,
    kind: parsed.kind,
    revision: parsed.revision,
    visibility: 'private',
    liveLinkCount: 0,
    url: parsed.url
  }
  return (
    <div data-artifact-tool="published">
      {skipped && <div className={line}>Updated without asking</div>}
      <ArtifactCard artifact={artifact} instanceName={instanceName} canShare={local.data != null} />
    </div>
  )
}
