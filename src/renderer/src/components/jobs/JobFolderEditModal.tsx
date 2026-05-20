import { Folder, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JobFolderData } from '../../../../shared/jobs'
import { useUpdateJobFolder } from '../../hooks/useJobs'

interface JobFolderEditModalProps {
  folder: JobFolderData
  onClose: () => void
}

/**
 * Modal popup for editing a job folder's name. Styled to match the other
 * sidebar modals (JobTypePicker, DeleteJobConfirm) — centered, frosted
 * surface, ESC + click-outside dismiss. Save flushes the rename and closes;
 * Enter inside the input triggers Save.
 */
export function JobFolderEditModal({
  folder,
  onClose
}: JobFolderEditModalProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(folder.name)
  const updateFolder = useUpdateJobFolder()

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onMouse = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse)
    }
  }, [onClose])

  const handleSave = (): void => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === folder.name || updateFolder.isPending) {
      if (!trimmed) return
      if (trimmed === folder.name) {
        onClose()
        return
      }
      return
    }
    updateFolder.mutate(
      { folderId: folder.id, patch: { name: trimmed } },
      {
        onSuccess: () => onClose()
      }
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
      <div
        ref={cardRef}
        className="w-full max-w-[24rem] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg p-5 space-y-4"
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
            <Folder size={16} className="text-[var(--color-text-muted)]" />
            Edit folder
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 -mt-1 -mr-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Cancel"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">
            Name
          </label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSave()
              }
            }}
            className="w-full px-2.5 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
            placeholder="Folder name"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={updateFolder.isPending || !name.trim()}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:brightness-110 text-white transition-colors disabled:opacity-50"
          >
            {updateFolder.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
