import { createContext, useContext } from 'react'

/**
 * What's currently being dragged in the Jobs sidebar. Set by the drag-source
 * (JobItem / JobFolderRow) on `onDragStart`; cleared on `onDragEnd`. The
 * value drives drop-target highlighting — e.g. a folder row should only
 * accept a job drag, not a folder drag.
 */
export type JobsDrag =
  | { kind: 'job'; id: string }
  | { kind: 'folder'; id: string }
  | null

export interface JobsDragContextValue {
  drag: JobsDrag
  setDrag: (drag: JobsDrag) => void
}

export const JobsDragContext = createContext<JobsDragContextValue>({
  drag: null,
  setDrag: () => {}
})

export function useJobsDrag(): JobsDragContextValue {
  return useContext(JobsDragContext)
}
