import { useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  Activity,
  ArrowLeft,
  Bot,
  ExternalLink,
  Loader2,
  Paperclip,
  RefreshCw,
  User,
  X
} from 'lucide-react'
import { useTaskAttachmentDownload } from '../../hooks/useTaskAttachmentDownload'
import { useUIStore } from '../../stores/ui.store'
import { useJob, useJobRuns } from '../../hooks/useJobs'
import { useCinnaServerUrl } from '../../hooks/useCinna'
import {
  useCinnaTaskView,
  useInvalidateCinnaTaskView
} from '../../hooks/useCinnaTaskView'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { markdownComponents } from '../../utils/markdownComponents'
import { formatRelativeFromServer } from '../../utils/cinnaTime'
import { AttachmentList } from '../chat/AttachmentBadge'
import { isContentComment } from '../../../../shared/cinnaTaskView'
import type {
  CinnaTaskAttachmentDto,
  CinnaTaskCommentDto
} from '../../../../shared/cinnaTaskView'

/**
 * Read-only view of a cinna task: fetches `InputTaskDetailPublic` from
 * cinna-core and renders comments + attachments so the user can see results
 * without leaving the desktop. Reachable by clicking a cinna_task row in a
 * job's run history.
 */
export function CinnaTaskRunView(): React.JSX.Element {
  const activeJobId = useUIStore((s) => s.activeJobId)
  const activeCinnaRunId = useUIStore((s) => s.activeCinnaRunId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setActiveCinnaRunId = useUIStore((s) => s.setActiveCinnaRunId)

  const { data: job } = useJob(activeJobId)
  const { data: runs } = useJobRuns(activeJobId)

  const run = useMemo(
    () => (runs ?? []).find((r) => r.id === activeCinnaRunId) ?? null,
    [runs, activeCinnaRunId]
  )

  const cinnaTaskId = run?.type === 'cinna_task' ? run.cinnaTaskId : null
  const taskView = useCinnaTaskView(cinnaTaskId)
  const invalidateTaskView = useInvalidateCinnaTaskView()
  const cinnaServerQuery = useCinnaServerUrl()

  const [showActivity, setShowActivity] = useState(true)

  const handleBack = (): void => {
    setActiveCinnaRunId(null)
    setActiveView('job-detail')
  }

  const handleRefresh = (): void => {
    if (cinnaTaskId) invalidateTaskView(cinnaTaskId)
  }

  const cinnaUrl =
    cinnaServerQuery.data && run?.type === 'cinna_task' && run.cinnaShortCode
      ? `${cinnaServerQuery.data.replace(/\/$/, '')}/tasks/${encodeURIComponent(run.cinnaShortCode)}`
      : null

  const handleOpenExternal = async (): Promise<void> => {
    if (!cinnaUrl) return
    await window.api.system.openExternal(cinnaUrl)
  }

  // ----- Loading / empty states -----

  if (!activeCinnaRunId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        No task selected.
      </div>
    )
  }

  if (!run || run.type !== 'cinna_task') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pt-[var(--topbar-h)]">
        <div className="text-sm text-[var(--color-text-muted)]">
          This run is not available.
        </div>
        <button
          type="button"
          onClick={handleBack}
          className="text-xs text-[var(--color-accent)] hover:underline"
        >
          ← Back to job
        </button>
      </div>
    )
  }

  if (!cinnaTaskId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pt-[var(--topbar-h)]">
        <div className="text-sm text-[var(--color-text-muted)]">
          This run has no Cinna task id — there's nothing to load.
        </div>
        <button
          type="button"
          onClick={handleBack}
          className="text-xs text-[var(--color-accent)] hover:underline"
        >
          ← Back to job
        </button>
      </div>
    )
  }

  const loading = taskView.isLoading
  const fetchError = taskView.error
    ? taskView.error instanceof Error
      ? taskView.error.message
      : String(taskView.error)
    : null
  const data = taskView.data

  const contentComments = (data?.comments ?? []).filter(isContentComment)
  const systemComments = (data?.comments ?? []).filter((c) => !isContentComment(c))

  return (
    <div className="flex-1 overflow-y-auto pt-[var(--topbar-h)]">
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors mb-1.5"
            >
              <ArrowLeft size={11} />
              Back to {job?.title ?? 'job'}
            </button>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-[var(--color-text)] truncate">
                {data?.task.title || job?.title || 'Cinna task'}
              </h1>
              {data?.task.status && <StatusPill status={data.task.status} />}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 font-mono">
              {run.cinnaShortCode ? `#${run.cinnaShortCode}` : run.cinnaTaskId}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={taskView.isFetching}
              className="p-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw
                size={12}
                className={taskView.isFetching ? 'animate-spin' : undefined}
              />
            </button>
            <button
              type="button"
              onClick={() => void handleOpenExternal()}
              disabled={!cinnaUrl}
              className="p-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={cinnaUrl ? 'Open on Cinna' : 'Cinna URL unavailable'}
              aria-label="Open on Cinna"
            >
              <ExternalLink size={12} />
            </button>
          </div>
        </header>

        {fetchError && (
          <div
            role="alert"
            className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded-md px-3 py-2"
          >
            {fetchError}
          </div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-12 text-xs text-[var(--color-text-muted)]">
            <Loader2 size={14} className="animate-spin mr-2" />
            Loading task…
          </div>
        )}

        {data && (
          <>
            {data.attachments.length > 0 && (
              <section>
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-secondary)] mb-2">
                  <Paperclip size={11} />
                  Attachments
                  <CountBadge count={data.attachments.length} />
                </h2>
                <TaskAttachmentList taskId={cinnaTaskId} attachments={data.attachments} />
              </section>
            )}

            <section>
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-secondary)] mb-2">
                Comments
                <CountBadge count={contentComments.length} />
              </h2>
              {contentComments.length === 0 ? (
                <div className="text-xs text-[var(--color-text-muted)] italic">
                  No comments yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {contentComments.map((c) => (
                    <CommentCard key={c.id} taskId={cinnaTaskId} comment={c} />
                  ))}
                </div>
              )}
            </section>

            {systemComments.length > 0 && (
              <section>
                <button
                  type="button"
                  onClick={() => setShowActivity((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
                >
                  <Activity size={11} />
                  Activity
                  <CountBadge count={systemComments.length} />
                  <span className="text-[var(--color-text-muted)] font-normal">
                    {showActivity ? '▾' : '▸'}
                  </span>
                </button>
                {showActivity && (
                  <ul className="mt-2 space-y-1 list-none m-0 p-0">
                    {systemComments.map((c) => (
                      <ActivityRow key={c.id} comment={c} />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function CountBadge({ count }: { count: number }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full
        text-[10px] font-semibold leading-none
        bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]
        border border-[var(--color-border)]"
    >
      {count}
    </span>
  )
}

function StatusPill({ status }: { status: string }): React.JSX.Element {
  const lc = status.toLowerCase()
  const tone =
    lc === 'completed' || lc === 'succeeded' || lc === 'archived'
      ? 'bg-[var(--color-severity-ok)]/15 text-[var(--color-severity-ok-text)]'
      : lc === 'error' || lc === 'failed'
        ? 'bg-[var(--color-severity-error)]/15 text-[var(--color-severity-error-text)]'
        : lc === 'cancelled'
          ? 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'
          : 'bg-[var(--color-severity-info)]/15 text-[var(--color-severity-info-text)]'
  return (
    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${tone}`}>
      {status}
    </span>
  )
}

function CommentCard({
  taskId,
  comment
}: {
  taskId: string
  comment: CinnaTaskCommentDto
}): React.JSX.Element {
  const now = useRelativeNow()
  const when = formatRelativeFromServer(comment.createdAt, now)
  const authorName = comment.authorName ?? 'Unknown'
  // Heuristic + author_role hint: agents have role like "agent"/role name;
  // user comments typically don't. The `comment_type === 'result'` is always
  // an agent posting. Otherwise fall back to a regex on the author label.
  const isAgentLike =
    comment.commentType === 'result' ||
    (comment.authorRole?.toLowerCase().includes('agent') ?? false) ||
    /agent|assistant|bot/i.test(authorName)
  return (
    <article className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <header className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {isAgentLike ? (
            <Bot size={12} className="shrink-0 text-[var(--color-accent)]" />
          ) : (
            <User size={12} className="shrink-0 text-[var(--color-text-muted)]" />
          )}
          <span className="text-xs font-medium text-[var(--color-text)] truncate">
            {authorName}
          </span>
          {comment.authorRole && (
            <span className="text-[10px] text-[var(--color-text-muted)] truncate">
              · {comment.authorRole}
            </span>
          )}
          {comment.commentType === 'result' && (
            <span className="shrink-0 px-1 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider bg-[var(--color-severity-ok)]/15 text-[var(--color-severity-ok-text)]">
              Result
            </span>
          )}
        </div>
        {when && (
          <time
            className="text-[10px] text-[var(--color-text-muted)] shrink-0"
            title={comment.createdAt ?? ''}
          >
            {when}
          </time>
        )}
      </header>
      {comment.content && (
        <div className="text-xs text-[var(--color-text)] leading-relaxed markdown-body">
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {comment.content}
          </Markdown>
        </div>
      )}
      {comment.attachments.length > 0 && (
        <div className="mt-2">
          <TaskAttachmentList taskId={taskId} attachments={comment.attachments} />
        </div>
      )}
    </article>
  )
}

function ActivityRow({ comment }: { comment: CinnaTaskCommentDto }): React.JSX.Element {
  const now = useRelativeNow()
  const when = formatRelativeFromServer(comment.createdAt, now)
  const text = comment.content || comment.commentType
  return (
    <li className="flex items-baseline justify-between gap-2 text-[11px] text-[var(--color-text-muted)] py-0.5">
      {/* Activity strings can carry inline markdown (e.g. "Status changed
          from **new** to **in_progress**"). Render inline-only — the wrapper
          strips paragraph margins so it stays on one line. */}
      <span className="min-w-0 markdown-body markdown-inline">
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {text}
        </Markdown>
      </span>
      {when && <span className="shrink-0">{when}</span>}
    </li>
  )
}

/**
 * Task attachments use cinna-core's task-scoped download endpoint
 * (`/api/v1/tasks/{taskId}/attachments/{id}/download`), distinct from the
 * `FileUpload` rows handled by `useFileDownload`. State is held in
 * `taskAttachmentDownload.store` so multiple lists on screen share spinner
 * + error state.
 */
function TaskAttachmentList({
  taskId,
  attachments
}: {
  taskId: string
  attachments: CinnaTaskAttachmentDto[]
}): React.JSX.Element {
  const { download, isDownloading, error, errorAttachmentId, dismissError } =
    useTaskAttachmentDownload()
  const adapted = attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    size: a.size ?? 0,
    mimeType: a.mimeType ?? 'application/octet-stream'
  }))
  // Only show the error label when one of *this list's* attachments owns it.
  const errorForThisList =
    error && attachments.some((a) => a.id === errorAttachmentId) ? error : null
  return (
    <div className="space-y-1">
      <AttachmentList
        attachments={adapted}
        variant="message"
        onClick={(att) =>
          void download({ taskId, attachmentId: att.id, filename: att.filename })
        }
        isLoading={isDownloading}
      />
      {errorForThisList && (
        <div className="flex items-center gap-1 text-[10px] text-[var(--color-danger)]">
          <span className="truncate">{errorForThisList}</span>
          <button
            type="button"
            onClick={dismissError}
            className="p-0.5 rounded hover:bg-[var(--color-bg-hover)] shrink-0"
            aria-label="Dismiss download error"
          >
            <X size={10} />
          </button>
        </div>
      )}
    </div>
  )
}
