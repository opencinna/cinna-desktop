import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Fingerprint,
  FolderOpen,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RefreshCw,
  TerminalSquare,
  Trash2,
  Users
} from 'lucide-react'
import { usePopover } from '../../ui/usePopover'
import { useUIStore } from '../../../stores/ui.store'
import {
  useDeleteLocalAgent,
  useOpenAgentUploads,
  useRenameKitAgent,
  useRenameLocalAgent,
  useRescanLocalAgents,
  useStampAgentIdentity
} from '../../../hooks/useLocalAgents'
import { useOpenIn } from '../../../hooks/useLocalTools'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { unwrapIpcError } from '../../../utils/ipcError'
import { MENU_ITEM, MENU_SURFACE } from './OpenInMenu'
import { useListedShareStatus, useShareWithTeam, useTeamLibrary } from '../../../hooks/useSharing'
import { useAuthStore } from '../../../stores/auth.store'
import { SHARE_UI_TEXT, shareRefusalSentence } from '../../../utils/shareText'
import { ShareWithTeamDialog } from './sharing/ShareDialogs'
import { DeleteAgentDialog, RenameAgentDialog, deleteActionLabel, hasTeamVersion } from './AgentDialogs'

/**
 * The ⋯ menu: everything a user does to an agent *occasionally*.
 *
 * Rescan, reveal and a bare terminal used to be header buttons; they earned
 * their space poorly against Start chat and Open in, which are what the page is
 * for. Stamp identity only appears for a legacy folder — it is the one write
 * here, and the banner above the tabs still explains why it is offered.
 * Rename and Delete come last, after a separator, and both open a dialog.
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
  const uploads = useOpenAgentUploads()
  const stamp = useStampAgentIdentity()
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const [confirming, setConfirming] = useState(false)
  const listed = useListedShareStatus(agent.id)
  // Only a kit folder can have a team version (main's rule: directly under a
  // workshop root's `Local/`); said here too, so a bare agent never takes the
  // shared branches below.
  const isKit = agent.kind === 'kit'
  const shared = hasTeamVersion(listed, agent)
  const isCinna = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const library = useTeamLibrary()
  // Offered only where it can work: a kit folder known not to be shared — or
  // whose team version the library no longer has, which starts it over — on
  // a Cinna profile whose Team library answered. Main refuses anything else
  // (a folder outside `Local/`, one with a live team version), and the
  // dialog shows why.
  const canShareWithTeam =
    isKit && (listed === null || listed?.state === 'removed') && isCinna && library.data != null
  const [sharingWithTeam, setSharingWithTeam] = useState(false)
  const [shareTeamError, setShareTeamError] = useState<string | null>(null)
  // Owned here, not in the dialog, for the same reason as the delete: the
  // close on success is a hook-level callback that survives the dialog.
  const shareWithTeam = useShareWithTeam({
    onResult: (result) => {
      if (result.done) setSharingWithTeam(false)
      else setShareTeamError(shareRefusalSentence(result.refusal ?? 'failed', result.detail))
    }
  })
  const remove = useDeleteLocalAgent({
    onSuccess: () => {
      // The row is gone; a page still asking for it would only get
      // `not_found` and tell the user their folder is "not indexed".
      setActiveLocalAgentId(null)
      setConfirming(false)
    }
  })
  // Owned here like the delete, so the close survives the dialog. A rename
  // keeps the id (main refuses a folder move that would change it), but the
  // selection follows the returned agent all the same.
  const [renaming, setRenaming] = useState(false)
  const onRenamed = (next: LocalAgentDto): void => {
    setRenaming(false)
    if (next.id !== agent.id) setActiveLocalAgentId(next.id)
  }
  const renameBare = useRenameLocalAgent({ onSuccess: onRenamed })
  const renameKit = useRenameKitAgent({ onSuccess: onRenamed })

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
                  uploads.mutate(agent.id, {
                    onError: (err) => report(err, 'Could not open the uploads folder.')
                  })
                )
              }
            >
              <Paperclip size={12} />
              Open uploads folder
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
            {canShareWithTeam && (
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() =>
                  run(() => {
                    setShareTeamError(null)
                    setSharingWithTeam(true)
                  })
                }
              >
                <Users size={12} />
                {SHARE_UI_TEXT.shareWithTeam}
              </button>
            )}
            <div className="my-1 border-t border-[var(--color-border)]" />
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => run(() => setRenaming(true))}
            >
              <Pencil size={12} />
              Rename agent…
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${MENU_ITEM} text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
              onClick={() => run(() => setConfirming(true))}
            >
              <Trash2 size={12} />
              {deleteActionLabel(agent, shared)}
            </button>
          </div>,
          document.body
        )}
      {confirming && (
        <DeleteAgentDialog
          agent={agent}
          remove={remove}
          shared={shared}
          onCancel={() => setConfirming(false)}
        />
      )}
      {renaming && (
        <RenameAgentDialog
          agent={agent}
          shared={shared}
          renameBare={renameBare}
          renameKit={renameKit}
          onCancel={() => setRenaming(false)}
        />
      )}
      {sharingWithTeam && (
        <ShareWithTeamDialog
          agentId={agent.id}
          pending={shareWithTeam.isPending}
          error={shareTeamError}
          onShare={(input) => {
            setShareTeamError(null)
            shareWithTeam.mutate(
              { agentId: agent.id, input },
              { onError: (err) => setShareTeamError(unwrapIpcError(err)) }
            )
          }}
          onCancel={() => setSharingWithTeam(false)}
        />
      )}
    </div>
  )
}
