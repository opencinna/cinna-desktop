import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import type {
  PendingRewrite,
  RewriteErrorCode
} from '../../hooks/useChatComposer'

interface RewriteFailureModalProps {
  error: { code: RewriteErrorCode; detail: string }
  pending: PendingRewrite
  onCancel: () => void
  onDisable: () => void
  onSendAnyway: () => void
}

function copyForCode(code: RewriteErrorCode): string {
  switch (code) {
    case 'no_rewrite_provider':
      return 'No chat mode with a configured LLM provider is available, so the rewrite can’t run. Add an LLM provider in Settings → Providers and mark a chat mode as default, then try again.'
    case 'rewrite_empty':
      return 'The rewrite LLM returned an empty response. This usually means the model refused the request or the prompt tripped a safety filter.'
    case 'rewrite_failed':
      return 'The rewrite LLM call failed. This is usually a network issue, an expired API key, or the model being temporarily unavailable.'
    default:
      return 'Something went wrong while preparing the message.'
  }
}

/**
 * Modal dialog shown when Smart Rewrite fails. Portaled to `document.body`
 * with a dimmed backdrop. Three actions: cancel (dismiss), disable
 * Smart Rewrite for this chat, or send the original text unchanged.
 */
export function RewriteFailureModal({
  error,
  pending,
  onCancel,
  onDisable,
  onSendAnyway
}: RewriteFailureModalProps): React.ReactPortal {
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rewrite-error-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        // Click on the backdrop dismisses without action.
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="app-popover-surface w-[26rem] rounded-lg border border-[var(--color-border)]
          shadow-xl p-5 space-y-3"
      >
        <div
          id="rewrite-error-title"
          className="flex items-center gap-2 text-sm font-medium text-[var(--color-danger)]"
        >
          <AlertTriangle size={16} />
          Couldn&apos;t introduce {pending.targetAgentName}
        </div>
        <p className="text-xs text-[var(--color-text)] leading-relaxed">
          When you bring a new agent into a chat, Cinna rewrites your message into a
          self-contained prompt so {pending.targetAgentName} has enough context to
          answer without seeing the prior conversation. That rewrite step uses an LLM.
        </p>
        <p className="text-xs text-[var(--color-text)] leading-relaxed">{copyForCode(error.code)}</p>
        <details className="text-[11px] text-[var(--color-text-secondary)]">
          <summary className="cursor-pointer select-none hover:text-[var(--color-text)]">
            Technical details
          </summary>
          <p className="mt-1 break-words font-mono text-[10px]">{error.detail}</p>
        </details>
        <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed pt-1">
          You can send your message as-is (no rewrite), turn off Smart Rewrite for this chat,
          or cancel and edit before retrying.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs font-medium border
              border-[var(--color-border)] text-[var(--color-text)]
              hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDisable}
            className="px-3 py-1.5 rounded-md text-xs font-medium border
              border-[var(--color-border)] text-[var(--color-text)]
              hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            Disable Smart Rewrite
          </button>
          <button
            type="button"
            onClick={onSendAnyway}
            className="px-3 py-1.5 rounded-md text-xs font-medium
              bg-[var(--color-accent)] hover:opacity-90 text-[var(--color-on-accent)] transition-opacity"
          >
            Send anyway
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
