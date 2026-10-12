import { FolderOpen, Paperclip, Pencil, TerminalSquare, Trash2 } from 'lucide-react'
import { CONTEXT_MENU_ITEM as ITEM, ContextMenu, useContextMenuAction } from '../../ui/ContextMenu'
import { useOpenAgentUploads } from '../../../hooks/useLocalAgents'
import { useOpenIn } from '../../../hooks/useLocalTools'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { deleteActionLabel } from './AgentDialogs'

interface AgentRowMenuProps {
  /** The pointer, where the menu opens; clamped to the viewport. */
  x: number
  y: number
  /** The row: a scroll of anything containing it closes the menu. */
  anchor: HTMLElement | null
  agent: LocalAgentDto
  /** The agent has a team version: Delete reads "Remove from this computer". */
  shared: boolean
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}

/**
 * A sidebar folder-agent row's right-click menu, on the shared
 * {@link ContextMenu} shell: the same occasional actions as the agent page's
 * ⋯ menu, without opening the page first. The folder picks can fail and say
 * why in the menu; Rename and Delete open their dialogs, which the list hosts.
 */
export function AgentRowMenu({
  x, y, anchor, agent, shared, onRename, onDelete, onClose
}: AgentRowMenuProps): React.JSX.Element {
  const { busy, error, run } = useContextMenuAction(onClose)
  const openIn = useOpenIn()
  const uploads = useOpenAgentUploads()
  return (
    <ContextMenu x={x} y={y} anchor={anchor} label={`Agent ${agent.name}`} error={error} onClose={onClose}>
      <button type="button" role="menuitem" className={ITEM} disabled={busy}
        onClick={() => void run(() => openIn.mutateAsync({ folder: agent.path, action: 'reveal' }), 'Could not reveal the folder.')}>
        <FolderOpen size={12} aria-hidden="true" />Reveal folder
      </button>
      <button type="button" role="menuitem" className={ITEM} disabled={busy}
        onClick={() => void run(() => uploads.mutateAsync(agent.id), 'Could not open the uploads folder.')}>
        <Paperclip size={12} aria-hidden="true" />Open uploads folder
      </button>
      <button type="button" role="menuitem" className={ITEM} disabled={busy}
        onClick={() => void run(() => openIn.mutateAsync({ folder: agent.path, action: 'terminal' }), 'Could not open a terminal.')}>
        <TerminalSquare size={12} aria-hidden="true" />Open terminal here
      </button>
      <div role="separator" className="my-1 border-t border-[var(--color-border)]" />
      <button type="button" role="menuitem" className={ITEM} disabled={busy}
        onClick={() => { onRename(); onClose() }}>
        <Pencil size={12} aria-hidden="true" />Rename agent…
      </button>
      <button type="button" role="menuitem"
        className={`${ITEM} text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
        disabled={busy}
        onClick={() => { onDelete(); onClose() }}>
        <Trash2 size={12} aria-hidden="true" />
        {deleteActionLabel(agent, shared)}
      </button>
    </ContextMenu>
  )
}
