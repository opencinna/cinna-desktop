import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useDialogChrome } from '../../../settings/SettingsLayout'
import { CANCEL, DANGER, PRIMARY, DIALOG_LABEL, DIALOG_TEXT, DialogFooter, FIELD_BASE } from '../sharing/ShareDialogs'

/**
 * A glass modal at the Settings scale (UI guidelines "Surface Materials"):
 * the scrim a sibling of the panel, Escape and an outside click ignored while
 * `pending`, Tab kept inside. Its top is pinned at 12vh, so a refusal that
 * lengthens it grows it downward and moves nothing above (ux_rules rule 1).
 */
export function VaultDialog({
  title,
  danger = false,
  pending,
  onDismiss,
  initialFocusRef,
  width = 'max-w-md',
  children
}: {
  title: string
  danger?: boolean
  pending: boolean
  onDismiss: () => void
  initialFocusRef: React.RefObject<HTMLElement | null>
  width?: string
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useDialogChrome({ modalRef: ref, initialFocusRef, pending, onDismiss })
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <div aria-hidden className="app-modal-scrim absolute inset-0" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative max-h-[84vh] w-full ${width} space-y-3 overflow-y-auto rounded-xl border app-modal-panel p-5`}
      >
        {danger ? (
          <div className="flex items-center gap-2 text-base font-semibold text-[var(--color-danger)]">
            <AlertTriangle size={18} aria-hidden="true" />
            {title}
          </div>
        ) : (
          <div className="text-base font-semibold text-[var(--color-text)]">{title}</div>
        )}
        {children}
      </div>
    </div>,
    document.body
  )
}

/**
 * An irreversible confirm that asks for the agent's name (README "Moving an
 * existing agent", step 7): the consequence first, then the field, then the
 * danger button, enabled only once the name matches exactly.
 */
export function TypeNameConfirmDialog({
  title,
  agentName,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onCancel,
  onConfirm,
  children
}: {
  title: string
  agentName: string
  confirmLabel: string
  pendingLabel: string
  pending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (typedName: string) => void
  /** What is lost and what is not, in the dialog's words. */
  children: ReactNode
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState('')
  const matches = typed === agentName
  return (
    <VaultDialog title={title} danger pending={pending} onDismiss={onCancel} initialFocusRef={inputRef}>
      <div className={`space-y-2 ${DIALOG_TEXT}`}>{children}</div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (matches && !pending) onConfirm(typed)
        }}
        className="space-y-3"
      >
        <label className="block space-y-1">
          <span className={DIALOG_LABEL}>
            Type <span className="font-medium text-[var(--color-text)]">{agentName}</span> to confirm
          </span>
          <input
            ref={inputRef}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={pending}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Type ${agentName} to confirm`}
            className={`w-full ${FIELD_BASE}`}
          />
        </label>
        <DialogFooter error={error}>
          <button type="button" className={CANCEL} disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={`${DANGER} min-w-[8rem]`} disabled={!matches || pending} aria-busy={pending}>
            {pending ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" />{pendingLabel}</> : confirmLabel}
          </button>
        </DialogFooter>
      </form>
    </VaultDialog>
  )
}

/** A plain confirm (Move out of vault…): no typing, since it loses nothing. */
export function VaultConfirmDialog({
  title,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onCancel,
  onConfirm,
  children
}: {
  title: string
  confirmLabel: string
  pendingLabel: string
  pending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
  children: ReactNode
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <VaultDialog title={title} pending={pending} onDismiss={onCancel} initialFocusRef={cancelRef}>
      <div className={`space-y-2 ${DIALOG_TEXT}`}>{children}</div>
      <DialogFooter error={error}>
        <button ref={cancelRef} type="button" className={CANCEL} disabled={pending} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={pending}
          aria-busy={pending}
          onClick={onConfirm}
        >
          {pending ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" />{pendingLabel}</> : confirmLabel}
        </button>
      </DialogFooter>
    </VaultDialog>
  )
}
