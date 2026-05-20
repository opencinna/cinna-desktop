import { FolderPlus, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  useCreateJob,
  useCreateJobFolder,
  useJobFolders,
  useJobList,
  useReorderJobFolders,
  useReorderJobs
} from '../../hooks/useJobs'
import { useAuthStore } from '../../stores/auth.store'
import type { JobData, JobFolderData } from '../../../../shared/jobs'
import { JobItem } from './JobItem'
import { JobFolderRow } from './JobFolderRow'
import { JobFolderEditModal } from './JobFolderEditModal'
import { JobTypePicker } from './JobTypePicker'
import { JobsDragContext, type JobsDrag } from './dragContext'

export function JobsList(): React.JSX.Element {
  const { data: jobs, isLoading } = useJobList()
  const { data: folders } = useJobFolders()
  const createJob = useCreateJob()
  const createFolder = useCreateJobFolder()
  const reorderJobs = useReorderJobs()
  const reorderFolders = useReorderJobFolders()
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const [pickingType, setPickingType] = useState(false)
  const [drag, setDrag] = useState<JobsDrag>(null)
  const [rootAccepting, setRootAccepting] = useState(false)
  // Folder fresh after creation — opens the edit modal immediately so the
  // user can name it right away instead of being stuck with "New folder".
  const [renamingFolder, setRenamingFolder] = useState<JobFolderData | null>(null)

  const handlePlusClick = (): void => {
    if (createJob.isPending) return
    if (isCinnaUser) {
      setPickingType(true)
      return
    }
    createJob.mutate({ type: 'local' })
  }

  const handleAddFolder = (): void => {
    if (createFolder.isPending) return
    createFolder.mutate(
      { name: 'New folder' },
      {
        // Pop the rename modal right after creation so the user lands on the
        // naming step instead of being left with a placeholder "New folder".
        onSuccess: (folder) => setRenamingFolder(folder)
      }
    )
  }

  // Group jobs by their folderId. `null` is the root group. Order inside
  // each group is preserved from the server (which sorted by position ASC).
  const groups = useMemo(() => {
    const root: JobData[] = []
    const byFolder = new Map<string, JobData[]>()
    for (const job of jobs ?? []) {
      if (job.folderId) {
        const arr = byFolder.get(job.folderId) ?? []
        arr.push(job)
        byFolder.set(job.folderId, arr)
      } else {
        root.push(job)
      }
    }
    return { root, byFolder }
  }, [jobs])

  // ---- Reorder helpers ---------------------------------------------------

  /**
   * Reorder a single group: take the current list of job ids in that group,
   * remove the dragged id from anywhere it currently is, then insert it at
   * the target index. Send the new ordering for the group to the server.
   */
  const reorderWithinGroup = (
    targetFolderId: string | null,
    draggedJobId: string,
    beforeJobId: string | null
  ): void => {
    const existing =
      targetFolderId === null
        ? groups.root
        : (groups.byFolder.get(targetFolderId) ?? [])
    const filtered = existing.filter((j) => j.id !== draggedJobId)
    const insertAt = beforeJobId
      ? filtered.findIndex((j) => j.id === beforeJobId)
      : filtered.length
    const idx = insertAt < 0 ? filtered.length : insertAt
    const newOrder = [
      ...filtered.slice(0, idx).map((j) => j.id),
      draggedJobId,
      ...filtered.slice(idx).map((j) => j.id)
    ]
    reorderJobs.mutate({ targetFolderId, orderedJobIds: newOrder })
  }

  /**
   * Move a job into a folder (or root), appended to the bottom. Used when
   * the job is dropped on the folder header itself or its empty body.
   */
  const moveJobToFolder = (
    targetFolderId: string | null,
    draggedJobId: string
  ): void => {
    reorderWithinGroup(targetFolderId, draggedJobId, null)
  }

  /**
   * Reorder folders: drop folder A on folder B → A is inserted right before
   * B in the folder list.
   */
  const reorderFolderList = (
    draggedFolderId: string,
    beforeFolderId: string | null
  ): void => {
    const order = (folders ?? []).map((f) => f.id)
    const filtered = order.filter((id) => id !== draggedFolderId)
    const insertAt = beforeFolderId
      ? filtered.findIndex((id) => id === beforeFolderId)
      : filtered.length
    const idx = insertAt < 0 ? filtered.length : insertAt
    const newOrder = [
      ...filtered.slice(0, idx),
      draggedFolderId,
      ...filtered.slice(idx)
    ]
    reorderFolders.mutate(newOrder)
  }

  // Root area accepts a job drop (move OUT of any folder) — only when a
  // job is being dragged and it doesn't already live at the root.
  const handleRootDragOver = (e: React.DragEvent): void => {
    if (drag?.kind !== 'job') return
    const draggedJob = (jobs ?? []).find((j) => j.id === drag.id)
    if (draggedJob && draggedJob.folderId === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!rootAccepting) setRootAccepting(true)
  }
  const handleRootDragLeave = (): void => {
    if (rootAccepting) setRootAccepting(false)
  }
  const handleRootDrop = (e: React.DragEvent): void => {
    if (drag?.kind !== 'job') return
    e.preventDefault()
    const draggedId = e.dataTransfer.getData('application/x-cinna-job')
    if (draggedId) moveJobToFolder(null, draggedId)
    setRootAccepting(false)
    setDrag(null)
  }

  return (
    <JobsDragContext.Provider value={{ drag, setDrag }}>
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 pt-1 pb-1">
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            Jobs
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleAddFolder}
              disabled={createFolder.isPending}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
              title="New folder"
            >
              <FolderPlus size={14} />
            </button>
            <button
              onClick={handlePlusClick}
              disabled={createJob.isPending}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
              title="New job"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
          ) : !jobs || (jobs.length === 0 && (folders ?? []).length === 0) ? (
            <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">
              No jobs yet — click + to create one
            </div>
          ) : (
            <div className="px-1.5 py-1 space-y-0.5">
              {/* Folders + their jobs */}
              {(folders ?? []).map((folder) => (
                <JobFolderRow
                  key={folder.id}
                  folder={folder}
                  jobs={groups.byFolder.get(folder.id) ?? []}
                  onDropJobInto={(draggedJobId) =>
                    moveJobToFolder(folder.id, draggedJobId)
                  }
                  onReorderInside={(draggedJobId, beforeJobId) =>
                    reorderWithinGroup(folder.id, draggedJobId, beforeJobId)
                  }
                  onReorderFolder={(draggedFolderId) =>
                    reorderFolderList(draggedFolderId, folder.id)
                  }
                />
              ))}

              {/* Ungrouped (root) jobs */}
              <div
                onDragOver={handleRootDragOver}
                onDragLeave={handleRootDragLeave}
                onDrop={handleRootDrop}
                className={`pt-0.5 space-y-px rounded-md ${
                  rootAccepting
                    ? 'ring-1 ring-inset ring-[var(--color-accent)] min-h-[1.5rem]'
                    : ''
                }`}
              >
                {groups.root.map((job) => (
                  <JobItem
                    key={job.id}
                    job={job}
                    onDropJob={(draggedJobId, beforeJobId) =>
                      reorderWithinGroup(null, draggedJobId, beforeJobId)
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {pickingType && <JobTypePicker onClose={() => setPickingType(false)} />}
        {renamingFolder && (
          <JobFolderEditModal
            folder={renamingFolder}
            onClose={() => setRenamingFolder(null)}
          />
        )}
      </div>
    </JobsDragContext.Provider>
  )
}
