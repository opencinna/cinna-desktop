import { MessageSquare, Briefcase, X, Sparkles } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useCreateJob } from '../../hooks/useJobs'

interface JobTypePickerProps {
  onClose: () => void
}

/**
 * One-time job-type picker. Modal popup styled like the onboarding welcome
 * card: centered card with icon header, description, and two card buttons.
 * ESC + click-outside dismiss. After a pick, useCreateJob navigates to the
 * new job's detail view.
 */
export function JobTypePicker({ onClose }: JobTypePickerProps): React.JSX.Element {
  const createJob = useCreateJob()
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onClick = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onClose])

  const handlePick = (type: 'local' | 'cinna_task'): void => {
    if (createJob.isPending) return
    createJob.mutate(
      { type },
      {
        onSuccess: () => onClose(),
        onError: () => onClose()
      }
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
      <div
        ref={cardRef}
        className="w-full max-w-[28rem] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg p-6"
      >
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Cancel"
          >
            <X size={14} />
          </button>
        </div>

        <div className="text-center space-y-2 -mt-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-accent)]/10">
            <Sparkles size={28} className="text-[var(--color-accent)]" />
          </div>
          <div className="text-lg font-semibold text-[var(--color-text)]">New job</div>
          <div className="text-xs text-[var(--color-text-muted)]">
            Pick how this job runs
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-6">
          <button
            type="button"
            onClick={() => handlePick('local')}
            disabled={createJob.isPending}
            className="flex flex-col items-center text-center gap-2 p-4 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-muted)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MessageSquare size={22} className="text-[var(--color-text-muted)]" />
            <div>
              <div className="text-sm font-medium text-[var(--color-text)]">Local</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                Spawns a new chat with your agent / mode / MCPs
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => handlePick('cinna_task')}
            disabled={createJob.isPending}
            className="flex flex-col items-center text-center gap-2 p-4 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-muted)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Briefcase size={22} className="text-[var(--color-text-muted)]" />
            <div>
              <div className="text-sm font-medium text-[var(--color-text)]">Cinna Task</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                Creates a remote task on Cinna-Server
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
