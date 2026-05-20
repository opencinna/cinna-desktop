import { useRef, useState } from 'react'
import { ChevronLeft, Loader2, Trash2 } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useJob, useDeleteJob } from '../../hooks/useJobs'
import { JobEditForm, type JobEditFormHandle } from './JobEditForm'
import { DeleteJobConfirm } from './JobItem'

/**
 * Full-page edit screen for a job. Wraps `JobEditForm` (which still auto-saves
 * on debounce) with a header carrying a primary "Save" button. Save flushes
 * any pending debounced change before navigating back to the read-only job
 * view, so the user sees the persisted state immediately.
 */
export function JobEditPage(): React.JSX.Element {
  const activeJobId = useUIStore((s) => s.activeJobId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { data: job, isLoading } = useJob(activeJobId)
  const deleteJob = useDeleteJob()
  const formRef = useRef<JobEditFormHandle>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  if (!activeJobId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        Select a job from the sidebar.
      </div>
    )
  }

  if (isLoading || !job) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    )
  }

  const handleSave = async (): Promise<void> => {
    if (!formRef.current || saving) return
    setSaving(true)
    setError(null)
    const result = await formRef.current.flush()
    setSaving(false)
    if (result.ok) {
      setActiveView('job-detail')
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto pt-[var(--topbar-h)]">
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
        <header className="flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setActiveView('job-detail')}
            className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)]
              hover:text-[var(--color-text)] transition-colors"
          >
            <ChevronLeft size={14} />
            Back
          </button>
          <h1 className="flex-1 text-base font-semibold text-[var(--color-text)] truncate">
            Edit job
          </h1>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="shrink-0 inline-flex items-center justify-center p-1.5 rounded-md
              border border-[var(--color-border)] text-[var(--color-text-muted)]
              hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 transition-colors"
            title="Delete job"
            aria-label="Delete job"
          >
            <Trash2 size={12} />
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
              bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white
              disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            Save
          </button>
        </header>

        {error && (
          <div
            role="alert"
            className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10
              border border-[var(--color-danger)]/30 rounded-md px-3 py-2"
          >
            {error}
          </div>
        )}

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3">
          <JobEditForm ref={formRef} job={job} />
        </div>
      </div>

      {confirmingDelete && (
        <DeleteJobConfirm
          jobTitle={job.title}
          pending={deleteJob.isPending}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            // useDeleteJob.onSuccess handles routing (clears activeJobId and
            // switches activeView back to 'chat' when this job was active),
            // so we just close the modal.
            deleteJob.mutate(job.id, {
              onSuccess: () => setConfirmingDelete(false),
              onError: () => setConfirmingDelete(false)
            })
          }}
        />
      )}
    </div>
  )
}
