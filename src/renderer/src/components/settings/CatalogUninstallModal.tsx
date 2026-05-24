/**
 * Confirmation dialog for catalog-card uninstall. Mirrors cinna-server's
 * `UninstallAgent` component — same wording (app-data preserved across
 * reinstall) so the desktop and web UX read the same.
 *
 * Owner (CatalogCard) holds the modal state and the mutation; this component
 * is pure presentation + button wiring. Errors are rendered inline instead of
 * surfaced as a global toast so the user sees them in the same context as
 * the action that produced them.
 */
import { Loader2, PackageX, AlertTriangle, X } from 'lucide-react'

interface CatalogUninstallModalProps {
  agentName: string
  pending: boolean
  errorMessage: string | null
  onConfirm: () => void
  onClose: () => void
}

export function CatalogUninstallModal({
  agentName,
  pending,
  errorMessage,
  onConfirm,
  onClose
}: CatalogUninstallModalProps): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={pending ? undefined : onClose}
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-lg border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 px-4 py-3 border-b border-[var(--color-border)]">
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-semibold">Uninstall {agentName}?</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] disabled:opacity-50"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-2.5">
          <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed">
            This install will be removed and its environment stopped on the Cinna server. Your
            per-bundle App Data is preserved — it will reattach automatically if you reinstall the
            bundle later.
          </p>

          {errorMessage && (
            <div
              className="flex items-start gap-2 px-2.5 py-2 rounded-md
                border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10
                text-[12px] text-[var(--color-danger)]"
            >
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span className="break-words">{errorMessage}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--color-border)]">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="px-3 py-1.5 rounded-md text-[13px] font-medium
              border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]
              text-[var(--color-text-secondary)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium
              bg-[var(--color-danger)] hover:bg-[var(--color-danger)]/85 text-white
              disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Uninstalling…
              </>
            ) : (
              <>
                <PackageX size={12} />
                Uninstall
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
