import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import type { UseMutationResult } from '@tanstack/react-query'
import type { AgentRootDto } from '../../../../shared/localAgents'
import { unwrapIpcError } from '../../utils/ipcError'
import { useDialogChrome } from './SettingsLayout'

interface ForgetAgentRootDialogProps {
  root: AgentRootDto
  /**
   * Owned by the settings section, which outlives this dialog. The success
   * handler that closes the dialog lives on the hook, not on this `mutate`
   * call — a `mutate`-level callback is dropped when its caller unmounts, and
   * closing the dialog *is* the unmount.
   */
  remove: UseMutationResult<{ pruned: number }, Error, string>
  onCancel: () => void
}

/**
 * The confirm in front of Forget.
 *
 * Forget used to run on one click of an unlabelled X. What it does is not
 * obviously recoverable — `removeRoot` drops the `agents` row of every folder
 * agent under the root, and `job_agents`, `a2a_sessions` and
 * `chat_on_demand_agents` all cascade from that row — so a destructive action
 * with no confirmation was the wrong shape for it (ux_rules rule 5).
 *
 * **The copy leads with what is recoverable and then owns the half that is
 * not.** The folder on disk is never touched, so the obvious mental model is
 * "this is undoable". It is not, and *how* it is not depends on the kind:
 *
 *   - A kit agent's id is its manifest uuid (`folder:<uuid>`), so re-adding
 *     the folder mints the same id and its chats re-bind. Its **jobs** do not:
 *     the `job_agents` row is gone, and once the folder is back the job stops
 *     reporting `incompleteSetup` and simply runs without the agent.
 *   - A bare or legacy agent's id embeds the **root id**
 *     (`externalFolderAgentId` / `legacyFolderAgentId`), and `agentRootRepo`
 *     mints a fresh `nanoid()` per add — so re-adding produces *different*
 *     agents, and the old chats, whose `chats.agent_id` is a plain string with
 *     no FK, never reconnect at all.
 *
 * So the copy promises only what is true of both: the folder comes back, the
 * listing comes back, the connections do not. An earlier draft said "adding
 * the folder again brings the agents back", which read as "the harm is undone"
 * and was measurably false for the adopted folders that are the only ones this
 * dialog is ever shown for.
 */
export function ForgetAgentRootDialog({
  root,
  remove,
  onCancel
}: ForgetAgentRootDialogProps): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * Focus lands on the recoverable choice, and goes back where it came from.
   *
   * Without this, focus stayed on the row's Forget button behind an
   * `aria-modal` overlay: a screen-reader user was never told the confirm had
   * opened, and Tab walked the settings controls underneath it. Cancel rather
   * than the destructive button, so Enter on arrival cancels.
   */

  // Undismissable while the removal runs: Escape and an outside click would
  // cancel nothing and only hide what is happening (ux_rules rule 5).

  useDialogChrome({ modalRef, initialFocusRef: cancelRef, pending: remove.isPending, onDismiss: onCancel })

  const confirm = (): void => {
    setError(null)
    remove.mutate(root.id, {
      // The dialog stays open on failure and says why, beside the button that
      // was pressed (ux_rules rule 6). Only the hook-level `onSuccess` closes
      // it.
      onError: (err) => setError(unwrapIpcError(err, 'That folder could not be forgotten.'))
    })
  }

  /**
   * `agentCount` only — **not** plus `hiddenAgentCount`.
   *
   * A hidden agent is one the user removed from the list or never ticked when
   * adopting the folder, so it has no `agents` row to drop and nothing
   * cascading off it. Counting it here would promise consequences for agents
   * that are not in the list and have none.
   */
  const agentCount = root.agentCount

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        // The accessible name is the visible name, by construction rather than
        // by a hardcoded string that can drift from the heading beside it
        // (ux_rules rule 10).
        aria-labelledby="forget-agent-root-title"
        className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div
          id="forget-agent-root-title"
          className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-danger)]"
        >
          <AlertTriangle size={16} />
          Forget agents folder
        </div>

        <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          Forget <strong className="text-[var(--color-text)]">{root.label}</strong>? The folder and
          everything in it stays on disk — Cinna only stops listing it.
        </p>

        {agentCount > 0 && (
          <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
            Its {agentCount} agent{agentCount === 1 ? '' : 's'}{' '}
            {agentCount === 1 ? 'leaves' : 'leave'} the list. Existing chats stay, but they can no
            longer reach {agentCount === 1 ? 'it' : 'them'}, and any job set up with{' '}
            {agentCount === 1 ? 'it' : 'one'} loses that agent. Adding the folder again lists{' '}
            {agentCount === 1 ? 'the agent' : 'the agents'} again — it does not put{' '}
            {agentCount === 1 ? 'it' : 'them'} back into those jobs, and a job left that way runs
            without the agent rather than asking.
          </p>
        )}

        {/*
          Two lines of the 13px leading, reserved. One line held every refusal
          reachable today, but a two-line message grew the dialog 5px and moved
          both buttons — making the guarantee the length of the copy rather
          than the shape of the box, which is the thing the row-summary line in
          this same section deliberately rejected (ux_rules rule 1).
        */}
        <div
          role="alert"
          className="min-h-[3.25rem] text-[13px] leading-relaxed text-[var(--color-danger)]"
        >
          {error}
        </div>

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
            // A fixed width, so the longer "Forgetting…" does not pull Cancel
            // sideways when the action starts (ux_rules rule 1).
            className="min-w-[7.5rem] rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-[13px]
              font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {remove.isPending ? 'Forgetting…' : 'Forget folder'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
