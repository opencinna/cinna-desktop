import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Pencil } from 'lucide-react'
import type { useDeleteLocalAgent, useRenameKitAgent, useRenameLocalAgent } from '../../../hooks/useLocalAgents'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import {
  isBlockedWriteError,
  isStaleWriteError,
  slugifyAgentName,
  type LocalAgentDto
} from '../../../../../shared/localAgents'
import { unwrapIpcError } from '../../../utils/ipcError'
import { SHARE_UI_TEXT } from '../../../utils/shareText'

/**
 * The agent dialogs both the ⋯ menu on the agent page and the sidebar row's
 * right-click menu open. Neither owns its mutation: the opener does, with
 * hook-level success callbacks, so a dialog dismissed or unmounted mid-write
 * still has its close and selection handled (see {@link AgentActionsMenu}).
 */

interface DeleteAgentDialogProps {
  agent: LocalAgentDto
  /** The mutation, owned by whoever opened the dialog — see {@link AgentActionsMenu}. */
  remove: ReturnType<typeof useDeleteLocalAgent>
  /**
   * The agent has a team version. Removing it trashes this machine's folder
   * only, so the dialog says "Remove from this computer" in every place it
   * names itself, and main refuses while changes are unshared — naming them.
   */
  shared: boolean
  onCancel: () => void
}

/**
 * Confirm before the folder goes to the Trash.
 *
 * The folder is recoverable from the Trash. What is not: the engine sessions
 * behind its chats (`a2a_sessions`), its on-demand attachments to other chats
 * (`chat_on_demand_agents`), its job bindings (`job_agents`) and its MCP
 * addon links (`agent_mcp_providers`) all cascade
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
export function DeleteAgentDialog({ agent, remove, shared, onCancel }: DeleteAgentDialogProps): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  // Only a bare agent has a choice to make. A kit agent's row is a derived
  // index over its folder, so "remove from the list" would be undone by the
  // very next scan; there the folder *is* the removal, and main refuses the
  // other value rather than pretending it means something.
  // A shared folder is a copy of the team's version, so trashing it is the
  // whole of "remove from this computer"; there is nothing to keep it listed for.
  const [trashFolder, setTrashFolder] = useState(shared || agent.kind !== 'bare')
  const title = shared
    ? SHARE_UI_TEXT.removeFromComputer
    : agent.kind === 'bare'
      ? 'Remove agent'
      : 'Delete agent'
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
        aria-label={title}
        className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-danger)]">
          <AlertTriangle size={16} />
          {title}
        </div>
        {shared ? (
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
            {SHARE_UI_TEXT.removeFromComputerBody(agent.name)}
          </p>
        ) : agent.kind === 'bare' ? (
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
              to run — and will need it selected again even if you put the agent back. Its MCP
              connectors are detached; they stay in Settings → MCP.
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
                  hint: 'The folder stays exactly where it is. Add the agent back by picking the folder again in + → Add a folder, or from Settings → Agents.'
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
            reach this agent, and any job that uses it will refuse to run. Its MCP connectors are
            detached; they stay in Settings → MCP.
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
            className="min-w-[7.5rem] whitespace-nowrap rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {remove.isPending
              ? 'Removing…'
              : shared
                ? SHARE_UI_TEXT.removeFromComputer
                : trashFolder
                  ? 'Move to Trash'
                  : 'Remove'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * Whether an agent has a team version. Only a kit folder can (main's rule:
 * directly under a workshop root's `Local/`), so a bare agent never takes the
 * shared branches even while the statuses list is stale.
 */
export function hasTeamVersion(listed: unknown, agent: LocalAgentDto): boolean {
  return listed != null && agent.kind === 'kit'
}

/** The delete item's label, the same in the ⋯ menu and the row's right-click menu. */
export function deleteActionLabel(agent: LocalAgentDto, shared: boolean): string {
  if (shared) return SHARE_UI_TEXT.removeFromComputerMenu
  return agent.kind === 'bare' ? 'Remove agent…' : 'Delete agent…'
}

/** The warning under "Rename folder too" when the folder can move. */
export const RENAME_FOLDER_WARNING =
  "Anything that points at this agent by its folder path — scripts, shortcuts, other tools, a terminal open in it — stops finding it, and the agent's previous sessions could lose their context. Rename the folder only if you need to."

/**
 * Why the folder cannot move with the name, or null when it can. Main applies
 * the same rules and refuses on its own; these say it before the click.
 */
export function renameFolderBlockedReason(agent: LocalAgentDto, shared: boolean): string | null {
  if (agent.kind === 'bare') return 'This is your own folder; Cinna keeps its name without touching it.'
  if (agent.identity !== 'manifest') {
    return "This agent is identified by its folder's name. Stamp identity first, or its chats would lose it."
  }
  if (shared) return 'The folder name is part of the team version, so it stays.'
  return null
}

/** `path`'s parent and last segment, on either separator. */
function splitPath(path: string): { parent: string; name: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? { parent: '', name: path } : { parent: path.slice(0, at), name: path.slice(at + 1) }
}

interface RenameAgentDialogProps {
  agent: LocalAgentDto
  /** Same as the delete dialog's: a team version keeps the folder name. */
  shared: boolean
  /** A bare agent's rename — the name only, kept outside its folder. */
  renameBare: ReturnType<typeof useRenameLocalAgent>
  /** A kit agent's rename — manifest name, and the folder when ticked. */
  renameKit: ReturnType<typeof useRenameKitAgent>
  onCancel: () => void
}

/**
 * Rename an agent, and — only when asked — its folder.
 *
 * The folder box starts unticked: the name is what the user sees everywhere,
 * while the folder path is what scripts, terminals and other tools hold on
 * to. The box's hint and the path line under it are always there, in every
 * state, so ticking it or typing never moves anything (ux_rules rule 1). Like
 * the delete dialog, it cannot be dismissed while the write is in flight, and
 * it closes only when the opener's hook-level success handler says so.
 */
export function RenameAgentDialog({
  agent,
  shared,
  renameBare,
  renameKit,
  onCancel
}: RenameAgentDialogProps): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(agent.name)
  const [renameFolder, setRenameFolder] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = renameBare.isPending || renameKit.isPending
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const blocked = renameFolderBlockedReason(agent, shared)
  const moving = renameFolder && blocked === null
  const trimmed = name.trim()
  const slug = slugifyAgentName(trimmed)
  const { parent, name: folderName } = splitPath(agent.path)
  const canSave =
    !pending && trimmed !== '' && (trimmed !== agent.name || moving) && (!moving || slug !== '')

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

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

  const onError = (err: unknown): void =>
    setError(
      isBlockedWriteError(err)
        ? 'This agent is in the middle of a turn. Wait for it to finish, then try again — nothing was renamed.'
        : isStaleWriteError(err)
          ? 'The manifest changed on disk since this page read it. Reload the agent, then try again — nothing was renamed.'
          : unwrapIpcError(err, 'The agent could not be renamed.')
    )

  const save = (): void => {
    if (!canSave) return
    setError(null)
    if (agent.kind === 'bare') {
      renameBare.mutate({ agentId: agent.id, name: trimmed }, { onError })
      return
    }
    // The stamp this render read, not one taken now (Invariant 3).
    const expectedStamp = agent.stamps[MANIFEST_FILE]
    if (!expectedStamp) {
      setError("This agent's manifest could not be read. Rescan the folder, then try again.")
      return
    }
    renameKit.mutate(
      { agentId: agent.id, name: trimmed, renameFolder: moving, expectedStamp },
      { onError }
    )
  }

  const pathLine = moving
    ? slug === ''
      ? 'Folder becomes: — this name has no Latin letters or digits to name a folder with.'
      : `Folder becomes: ${parent}/${slug}`
    : `Folder stays: ${parent}/${folderName}`

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        role="dialog"
        aria-label="Rename agent"
        className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
          <Pencil size={16} />
          Rename agent
        </div>
        <label className="block space-y-1">
          <span className="block text-xs text-[var(--color-text-secondary)]">Name</span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            maxLength={255}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              }
            }}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
          />
        </label>
        <label
          className={`flex items-start gap-2 text-xs ${blocked ? 'cursor-default' : 'cursor-pointer'}`}
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-[var(--color-accent)]"
            checked={moving}
            disabled={pending || blocked !== null}
            onChange={(e) => setRenameFolder(e.target.checked)}
          />
          <span className="min-w-0">
            <span
              className={`block ${blocked ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text)]'}`}
            >
              Rename folder too
            </span>
            <span className="block text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              {blocked ?? RENAME_FOLDER_WARNING}
            </span>
            {/* Two lines reserved and never more, so ticking the box or typing
                a longer name never moves the buttons (UX rule 1). */}
            <span
              data-testid="rename-folder-path"
              title={pathLine}
              className="mt-1 line-clamp-2 block min-h-7 break-all text-[10px] leading-snug text-[var(--color-text-secondary)]"
            >
              {pathLine}
            </span>
          </span>
        </label>
        {/* Reserved, so a refusal does not push the buttons down (UX rule 1). */}
        <div role="alert" className="min-h-8 text-[10px] text-[var(--color-danger)]">
          {error}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            // A fixed width, so "Saving…" does not pull Cancel sideways.
            className="min-w-[7.5rem] whitespace-nowrap rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
