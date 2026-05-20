import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useJobList, useCreateJob } from '../../hooks/useJobs'
import { useAuthStore } from '../../stores/auth.store'
import { JobItem } from './JobItem'
import { JobTypePicker } from './JobTypePicker'

export function JobsList(): React.JSX.Element {
  const { data: jobs, isLoading } = useJobList()
  const createJob = useCreateJob()
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const [pickingType, setPickingType] = useState(false)

  const handlePlusClick = (): void => {
    if (createJob.isPending) return
    if (isCinnaUser) {
      setPickingType(true)
      return
    }
    createJob.mutate({ type: 'local' })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 pt-1 pb-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          Jobs
        </span>
        <button
          onClick={handlePlusClick}
          disabled={createJob.isPending}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
          title="New job"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
        ) : !jobs || jobs.length === 0 ? (
          <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">
            No jobs yet — click + to create one
          </div>
        ) : (
          <div className="px-1.5 py-1 space-y-px">
            {jobs.map((job) => (
              <JobItem key={job.id} job={job} />
            ))}
          </div>
        )}
      </div>

      {pickingType && <JobTypePicker onClose={() => setPickingType(false)} />}
    </div>
  )
}
