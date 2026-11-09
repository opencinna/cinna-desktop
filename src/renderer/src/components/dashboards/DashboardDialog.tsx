import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogChrome } from '../settings/SettingsLayout'

/** Footer and field classes shared by the dashboard dialogs (app-chrome scale). */
export const DIALOG_BUTTON =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50'
export const DIALOG_PRIMARY =
  'rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50'
export const DIALOG_DANGER =
  'rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50'
export const DIALOG_INPUT =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none'
export const DIALOG_LABEL = 'block text-[11px] font-medium text-[var(--color-text-secondary)]'

/**
 * A glass modal: Escape and an outside click close it unless `pending`, Tab
 * stays inside, focus enters on `initialFocusRef` and returns on close.
 */
export function DashboardDialog({
  label,
  pending = false,
  onClose,
  initialFocusRef,
  width = 'max-w-md',
  children
}: {
  label: string
  pending?: boolean
  onClose: () => void
  initialFocusRef: React.RefObject<HTMLElement | null>
  width?: string
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useDialogChrome({ modalRef: ref, initialFocusRef, pending, onDismiss: onClose })
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <div aria-hidden className="app-modal-scrim absolute inset-0" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} className={`relative max-h-[84vh] w-full ${width} overflow-y-auto rounded-xl border app-modal-panel p-5`}>
        {children}
      </div>
    </div>,
    document.body
  )
}

/** A destructive confirm: the object named, what survives first (ux rule 5). */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onConfirm,
  onClose
}: {
  title: string
  body: ReactNode
  confirmLabel: string
  pendingLabel: string
  pending: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <DashboardDialog label={title} pending={pending} onClose={onClose} initialFocusRef={cancelRef}>
      <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
      <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{body}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button ref={cancelRef} type="button" disabled={pending} onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] disabled:opacity-50">
          Cancel
        </button>
        <button type="button" disabled={pending} onClick={onConfirm} className={DIALOG_DANGER}>
          {pending ? pendingLabel : confirmLabel}
        </button>
      </div>
      {error && <p role="alert" className="mt-3 text-xs text-[var(--color-danger)]">{error}</p>}
    </DashboardDialog>
  )
}
