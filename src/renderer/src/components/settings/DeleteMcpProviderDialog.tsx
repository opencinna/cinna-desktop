import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import type { UseMutationResult } from '@tanstack/react-query'
import { unwrapIpcError } from '../../utils/ipcError'
import { useMcpAgentsUsing } from '../../hooks/useMcp'
import { useDialogChrome } from './SettingsLayout'

interface DeleteMcpProviderDialogProps {
  provider: { id: string; name: string }
  /**
   * Owned by the card, which outlives this dialog: the card itself goes once
   * the list refetches without the connector, and that is what closes this.
   */
  remove: UseMutationResult<{ success: boolean }, Error, string>
  onCancel: () => void
}

/**
 * The confirm in front of deleting an MCP connector (ux_rules rule 5).
 *
 * The copy follows the schema: `chat_mcp_providers`, `chat_on_demand_mcps` and
 * `agent_mcp_providers` cascade from the connector row, and chat modes have the
 * id stripped (`mcpService.delete`). So every chat, chat mode and folder agent
 * using it loses it, and nothing brings those links back — adding the server
 * again creates a different connector. The agents are named because an addon
 * is configured on a page the user is not looking at.
 *
 * Shown only once the "used by" lookup has settled, so the agent line does
 * not appear under the user's cursor after the buttons (rule 1).
 */
export function DeleteMcpProviderDialog(props: DeleteMcpProviderDialogProps): React.JSX.Element | null {
  const users = useMcpAgentsUsing(props.provider.id)
  // Mounted only once settled, so the dialog's focus-on-mount lands on Cancel.
  if (users.isPending) return null
  return <DialogBody {...props} agents={users.data ?? []} lookupFailed={users.isError} />
}

function DialogBody({
  provider,
  remove,
  onCancel,
  agents,
  lookupFailed
}: DeleteMcpProviderDialogProps & {
  agents: { id: string; name: string }[]
  lookupFailed: boolean
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)

  useDialogChrome({ modalRef, initialFocusRef: cancelRef, pending: remove.isPending, onDismiss: onCancel })

  const confirm = (): void => {
    setError(null)
    remove.mutate(provider.id, {
      onError: (err) => setError(unwrapIpcError(err, 'That connector could not be deleted.'))
    })
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-mcp-provider-title"
        className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div
          id="delete-mcp-provider-title"
          className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-danger)]"
        >
          <AlertTriangle size={16} />
          Delete MCP connector
        </div>

        <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          Delete <strong className="text-[var(--color-text)]">{provider.name}</strong>? Chats and
          chat modes using it lose it, and its saved sign-in is removed. This cannot be undone.
        </p>

        {agents.length > 0 && (
          <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
            Used by{' '}
            <strong className="text-[var(--color-text)]">
              {agents.map((agent) => agent.name).join(', ')}
            </strong>{' '}
            — it will be removed from {agents.length === 1 ? 'it' : 'them'}.
          </p>
        )}
        {lookupFailed && (
          <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
            Any agent it is attached to loses it too.
          </p>
        )}

        {error && (
          <div role="alert" className="text-[13px] leading-relaxed text-[var(--color-danger)]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={remove.isPending}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium
              text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]
              disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={remove.isPending}
            className="min-w-[7.5rem] rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-[13px]
              font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
