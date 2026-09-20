import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, MoreHorizontal, Power, Trash2 } from 'lucide-react'
import { useDeleteAgent } from '../../hooks/useAgents'
import { useAgentDesktopVisibility } from '../../hooks/useAgentDesktopVisibility'
import { useOpenExternal } from '../../hooks/useSystem'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM, MENU_SURFACE } from './local/OpenInMenu'
import { unwrapIpcError } from '../../utils/ipcError'

type Agent = Awaited<ReturnType<typeof window.api.agents.list>>[number]

/**
 * The … menu on the agent page.
 *
 * **Nothing hosted on a Cinna server is destroyed from here.** An agent that
 * lives on the server is the server's to delete — by its owner, on the page
 * that knows what else is attached to it — so the menu offers **Open on the
 * server** and nothing destructive. The desktop keeps only the decisions that
 * are actually the desktop's: whether this machine shows the agent at all.
 *
 * That leaves `Delete agent…` for the connections this app really does own —
 * a hand-added A2A endpoint, where deleting removes the connection and leaves
 * the agent wherever it runs. Uninstalling a catalog bundle stayed with the
 * install it undoes, in Settings → Catalog, rather than being a second
 * destructive verb here with a different meaning from the one beside it.
 */
export function ExternalAgentActionsMenu({ agent, onError }: {
  agent: Agent
  onError: (message: string | null) => void
}): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const enabled = useAgentDesktopVisibility()
  const remove = useDeleteAgent()
  const openExternal = useOpenExternal()
  const serverUrl = useAuthStore((s) => s.currentUser?.cinnaServerUrl)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remote = agent.source === 'remote'
  // Previously disabled direct connections remain recoverable, but cannot be disabled again.
  const showVisibility = remote || !agent.enabled
  const canRemove = !remote
  /**
   * The agent's page in the browser — the same `/agent/<install id>` the
   * Catalog card's "Open Agent" uses. A shared route or an identity contact
   * has no such page, so they get no item rather than a link to a 404.
   */
  const serverHref = remote && agent.remoteTargetType === 'agent' && agent.remoteTargetId && serverUrl
    ? `${serverUrl.replace(/\/+$/, '')}/agent/${agent.remoteTargetId}`
    : null

  const confirm = async (): Promise<void> => {
    setError(null)
    const profileId = useAuthStore.getState().currentUser?.id
    try {
      await remove.mutateAsync(agent.id)
      setConfirming(false)
      if (useAuthStore.getState().currentUser?.id === profileId && useUIStore.getState().activeExternalAgentId === agent.id) useUIStore.getState().setActiveExternalAgentId(null)
    } catch (err) { setError(unwrapIpcError(err, 'Could not remove this agent.')) }
  }

  const openOnServer = (): void => {
    if (!serverHref) return
    menu.setOpen(false)
    onError(null)
    void openExternal(serverHref)
      .then((result) => { if (!result.success) onError(result.error ?? 'Could not open this agent on the Cinna server.') })
      .catch((err) => onError(unwrapIpcError(err, 'Could not open this agent on the Cinna server.')))
  }

  return <>
    <button ref={menu.triggerRef} type="button" aria-label="More actions" title="More actions"
      aria-haspopup="menu" aria-expanded={menu.open} onClick={() => menu.setOpen(!menu.open)}
      className="flex items-center rounded-md border border-[var(--color-border)] px-1.5 py-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
      <MoreHorizontal size={14} />
    </button>
    {menu.open && menu.style && createPortal(
      <div ref={menu.popoverRef} style={menu.style} role="menu" aria-label="Agent actions" className={MENU_SURFACE}>
        {/* First, as the same-named item is in the task menu. `ExternalLink`
            rather than a cloud, because the task menu's cloud navigates inside
            the app and this leaves it — the Catalog footer's button to this
            very URL draws the same arrow. */}
        {serverHref && <button type="button" role="menuitem" className={MENU_ITEM} onClick={openOnServer}>
          <ExternalLink size={12} />Open on the server
        </button>}
        {showVisibility && <>
          {serverHref && <div className="my-1 border-t border-[var(--color-border)]" />}
          <button type="button" role="menuitem" className={MENU_ITEM} disabled={enabled.isPending}
            onClick={() => {
              menu.setOpen(false)
              onError(null)
              enabled.setVisible(agent, !agent.enabled, (err) => onError(unwrapIpcError(err, 'Could not update this agent.')))
            }}>
            <Power size={12} />{agent.enabled ? 'Disable in Desktop App' : 'Enable in Desktop App'}
          </button>
        </>}
        {canRemove && <>
          {showVisibility && <div className="my-1 border-t border-[var(--color-border)]" />}
          <button type="button" role="menuitem" className={`${MENU_ITEM} text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
            onClick={() => { menu.setOpen(false); setError(null); setConfirming(true) }}>
            <Trash2 size={12} />Delete agent…
          </button>
        </>}
      </div>, document.body
    )}
    {confirming && createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25" onClick={() => { if (!remove.isPending) setConfirming(false) }}>
        <div role="dialog" aria-modal="true" aria-label="Delete agent" onClick={(event) => event.stopPropagation()}
          className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl">
          <h2 className="text-sm font-medium">Delete {agent.name}?</h2>
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">This removes the agent connection from Desktop. Existing chats stay, but can no longer reach this agent. The agent itself stays on its server or in its workspace.</p>
          {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={remove.isPending} onClick={() => setConfirming(false)} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-50">Cancel</button>
            <button type="button" disabled={remove.isPending} onClick={() => void confirm()} className="rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-xs text-white disabled:opacity-50">{remove.isPending ? 'Deleting…' : 'Delete agent'}</button>
          </div>
        </div>
      </div>, document.body)}
  </>
}
