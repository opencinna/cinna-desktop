import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Fingerprint,
  FolderOpen,
  MoreHorizontal,
  RefreshCw,
  TerminalSquare,
  Trash2
} from 'lucide-react'
import { usePopover } from '../../ui/usePopover'
import { useUIStore } from '../../../stores/ui.store'
import {
  useDeleteLocalAgent,
  useRescanLocalAgents,
  useStampAgentIdentity
} from '../../../hooks/useLocalAgents'
import { useOpenIn } from '../../../hooks/useLocalTools'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import { isBlockedWriteError, type LocalAgentDto } from '../../../../../shared/localAgents'
import { unwrapIpcError } from '../../../utils/ipcError'
import { MENU_ITEM, MENU_SURFACE } from './OpenInMenu'

interface DeleteAgentDialogProps {
  agent: LocalAgentDto
  /** The mutation, owned by the menu — see {@link AgentActionsMenu}. */
  remove: ReturnType<typeof useDeleteLocalAgent>
  onCancel: () => void
}

/**
 * Confirm before the folder goes to the Trash.
 *
 * The folder is recoverable from the Trash. What is not: the engine sessions
 * behind its chats (`a2a_sessions`), its on-demand attachments to other chats
 * (`chat_on_demand_agents`) and its job bindings (`job_agents`) all cascade
 * from the agent row the rescan prunes. The chats themselves stay —
 * `chats.agent_id` has no foreign key — with a binding that no longer
 * resolves, so the dialog says exactly that. A refusal because the agent is
 * mid-turn is explained in those words rather than as a failure: nothing was
 * removed.
 *
 * While the delete is in flight the dialog cannot be dismissed. It does not
 * own the mutation, so unmounting it would not cancel anything — it would
 * only leave the user looking at a page whose folder is being trashed with no
 * sign that it is.
 */
function DeleteAgentDialog({ agent, remove, onCancel }: DeleteAgentDialogProps): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  // Only a bare agent has a choice to make. A kit agent's row is a derived
  // index over its folder, so "remove from the list" would be undone by the
  // very next scan; there the folder *is* the removal, and main refuses the
  // other value rather than pretending it means something.
  const [trashFolder, setTrashFolder] = useState(agent.kind !== 'bare')
  const pendingRef = useRef(remove.isPending)
  pendingRef.current = remove.isPending

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !pendingRef.current) onCancel()
    }
    const onClick = (e: MouseEvent): void => {
      if (pendingRef.current) return
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onCancel])

  const confirm = (): void => {
    setError(null)
    remove.mutate(
      { agentId: agent.id, trashFolder },
      {
        onError: (err) =>
          setError(
            isBlockedWriteError(err)
              ? 'This agent is in the middle of a turn. Wait for it to finish, then try again — nothing was removed.'
              : err instanceof Error
                ? err.message
                : trashFolder
                  ? 'The folder could not be moved to the Trash.'
                  : 'This agent could not be removed from the list.'
          )
      }
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        role="dialog"
        // The accessible name *is* the visible name. Hardcoded, it announced
        // "Delete agent" over a dialog whose heading, menu item and primary
        // button all said Remove — and announced the more alarming of the two
        // words for the branch whose default deletes nothing (ux_rules rule 8).
        aria-label={agent.kind === 'bare' ? 'Remove agent' : 'Delete agent'}
        className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-danger)]">
          <AlertTriangle size={16} />
          {agent.kind === 'bare' ? 'Remove agent' : 'Delete agent'}
        </div>
        {agent.kind === 'bare' ? (
          <>
            {/*
              The copy owns the half that cannot be undone. Removing the agent
              drops its `agents` row — which *is* the mechanism, since that row
              is what the pickers and `@`-mentions read — and `job_agents`
              cascades away with it. Putting the agent back re-creates the row
              under the same positional id, so its chats re-bind and look
              intact, but the job's link to it does not come back. Saying "the
              folder is untouched" and stopping there would leave a user
              undoing a removal ten seconds later and finding a job that has
              silently lost its agent (ux_rules rule 5: copy must match the
              schema).
            */}
            <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
              Remove <strong className="text-[var(--color-text)]">{agent.name}</strong>? Existing
              chats stay but can no longer reach this agent, and any job that uses it will refuse
              to run — and will need it selected again even if you put the agent back.
            </p>
            {/* The recoverable option first, and selected — UX rule 5. This is
                the user's own folder, very often a repository they share with
                other people, so deleting it is the deliberate second choice. */}
            <div className="space-y-2">
              {[
                {
                  value: false,
                  label: 'Remove from the list only',
                  // Both routes named, because both work and they are not the
                  // same gesture: re-picking the folder in **+ → Add a folder**
                  // reopens its agent list with this one unticked, and Settings
                  // puts back everything that was removed from that root at
                  // once. Naming a route that does not work would send the user
                  // down a dead end for the choice offered as the recoverable
                  // one (ux_rules rule 5) — which is what this hint did while
                  // re-picking a registered folder was refused.
                  hint: 'The folder stays exactly where it is. Add the agent back by picking the folder again in + → Add a folder, or from Settings → Local Agents.'
                },
                {
                  value: true,
                  label: 'Remove and move the folder to the Trash',
                  hint: 'The whole folder and everything in it goes to the Trash. It can be put back from there.'
                }
              ].map((option) => (
                <label
                  key={String(option.value)}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--color-border)] p-2.5 text-xs transition-colors hover:bg-[var(--color-bg-hover)]"
                >
                  <input
                    type="radio"
                    name="delete-scope"
                    className="mt-0.5 accent-[var(--color-accent)]"
                    checked={trashFolder === option.value}
                    disabled={remove.isPending}
                    onChange={() => setTrashFolder(option.value)}
                  />
                  <span className="min-w-0">
                    <span className="block text-[var(--color-text)]">{option.label}</span>
                    <span className="block text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                      {option.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
            Move <strong className="text-[var(--color-text)]">{agent.name}</strong> to the Trash?
            The folder can be put back from there. Existing chats stay, but they can no longer
            reach this agent, and any job that uses it will refuse to run.
          </p>
        )}
        {/* Reserved, so a refusal does not push the buttons down (UX rule 1). */}
        <div role="alert" className="min-h-8 text-[10px] text-[var(--color-danger)]">
          {error}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={remove.isPending}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={remove.isPending}
            // A fixed width, so the shorter "Deleting…" does not pull Cancel sideways.
            className="min-w-[7.5rem] rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {remove.isPending ? 'Removing…' : trashFolder ? 'Move to Trash' : 'Remove'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * The ⋯ menu: everything a user does to an agent *occasionally*.
 *
 * Rescan, reveal and a bare terminal used to be header buttons; they earned
 * their space poorly against Start chat and Open in, which are what the page is
 * for. Stamp identity only appears for a legacy folder — it is the one write
 * here, and the banner above the tabs still explains why it is offered.
 * Delete is last and separated, and always confirms.
 *
 * The delete mutation lives here, not in the dialog, and its success handler
 * is the hook-level one. TanStack drops a *mutate-level* callback once the
 * component that called `mutate` has unmounted — so a dialog that owned the
 * mutation and was dismissed while "Deleting…" would have its folder trashed
 * and its row pruned, and never clear the selection: the page would sit on
 * the deleted agent until a refetch declared it "not indexed", which is wrong
 * in every particular for a folder the user just removed. This component
 * lives exactly as long as the page does, which is as long as the selection.
 */
interface AgentActionsMenuProps {
  agent: LocalAgentDto
  /** The page's single error slot — shared with `OpenInMenu`. */
  onError: (message: string | null) => void
}

export function AgentActionsMenu({ agent, onError }: AgentActionsMenuProps): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const rescan = useRescanLocalAgents()
  const openIn = useOpenIn()
  const stamp = useStampAgentIdentity()
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteLocalAgent({
    onSuccess: () => {
      // The row is gone; a page still asking for it would only get
      // `not_found` and tell the user their folder is "not indexed".
      setActiveLocalAgentId(null)
      setConfirming(false)
    }
  })

  const run = (fn: () => void): void => {
    onError(null)
    menu.setOpen(false)
    fn()
  }
  const report = (err: unknown, fallback: string): void => onError(unwrapIpcError(err, fallback))

  // Invariant 3 applies to stamping like every other write: the stamp handed
  // back is the one this render read, not one taken at click time.
  const manifestStamp = agent.stamps[MANIFEST_FILE] ?? null

  return (
    <div>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={() => menu.setOpen(!menu.open)}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label="More actions"
        title="More actions"
        className="flex items-center rounded-md border border-[var(--color-border)] px-1.5 py-1.5
          text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
      >
        <MoreHorizontal size={14} />
      </button>
      {menu.open &&
        menu.style &&
        createPortal(
          <div
            ref={menu.popoverRef}
            role="menu"
            aria-label="Agent actions"
            style={menu.style}
            className={MENU_SURFACE}
          >
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              disabled={rescan.isPending}
              onClick={() =>
                run(() =>
                  rescan.mutate(agent.rootId, {
                    onError: (err) => report(err, 'Could not rescan.')
                  })
                )
              }
            >
              <RefreshCw size={12} />
              Rescan folder
            </button>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() =>
                run(() =>
                  openIn.mutate(
                    { folder: agent.path, action: 'reveal' },
                    { onError: (err) => report(err, 'Could not reveal the folder.') }
                  )
                )
              }
            >
              <FolderOpen size={12} />
              Reveal folder
            </button>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() =>
                run(() =>
                  openIn.mutate(
                    { folder: agent.path, action: 'terminal' },
                    { onError: (err) => report(err, 'Could not open a terminal.') }
                  )
                )
              }
            >
              <TerminalSquare size={12} />
              Open terminal here
            </button>
            {agent.identity === 'legacy' && manifestStamp && (
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                disabled={stamp.isPending}
                title="Write a fresh id into cinna-agent.json"
                onClick={() =>
                  run(() =>
                    stamp.mutate(
                      { agentId: agent.id, expectedStamp: manifestStamp },
                      {
                        // Stamping re-keys the row, so the selection has to
                        // follow the agent to its new id.
                        onSuccess: (next) => setActiveLocalAgentId(next.id),
                        onError: (err) => report(err, 'Could not stamp an id.')
                      }
                    )
                  )
                }
              >
                <Fingerprint size={12} />
                {stamp.isPending ? 'Stamping…' : 'Stamp identity'}
              </button>
            )}
            <div className="my-1 border-t border-[var(--color-border)]" />
            <button
              type="button"
              role="menuitem"
              className={`${MENU_ITEM} text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
              onClick={() => run(() => setConfirming(true))}
            >
              <Trash2 size={12} />
              {agent.kind === 'bare' ? 'Remove agent…' : 'Delete agent…'}
            </button>
          </div>,
          document.body
        )}
      {confirming && (
        <DeleteAgentDialog agent={agent} remove={remove} onCancel={() => setConfirming(false)} />
      )}
    </div>
  )
}
