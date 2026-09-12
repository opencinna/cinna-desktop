import { useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal, PackageX, Power, Trash2 } from 'lucide-react'
import { useDeleteAgent, useDeleteRemoteAgent } from '../../hooks/useAgents'
import { useAgentDesktopVisibility } from '../../hooks/useAgentDesktopVisibility'
import { useUninstallBundle } from '../../hooks/useCatalog'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM, MENU_SURFACE } from './local/OpenInMenu'
import { CatalogUninstallModal } from '../settings/CatalogUninstallModal'
import { isBundleAgent } from '../../../../shared/agentPresentation'
import { canDevelopAgent } from '../../../../shared/agentDevelopment'
import { unwrapIpcError } from '../../utils/ipcError'

type Agent = Awaited<ReturnType<typeof window.api.agents.list>>[number]

export function ExternalAgentActionsMenu({ agent, onError }: {
  agent: Agent
  onError: (message: string | null) => void
}): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const enabled = useAgentDesktopVisibility()
  const remove = useDeleteAgent()
  const removeRemote = useDeleteRemoteAgent()
  const uninstall = useUninstallBundle()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bundle = isBundleAgent(agent)
  // Previously disabled direct connections remain recoverable, but cannot be disabled again.
  const showVisibility = agent.source === 'remote' || !agent.enabled
  const canRemove = agent.source !== 'remote' || bundle || canDevelopAgent(agent)
  const pending = remove.isPending || removeRemote.isPending || uninstall.isPending

  const confirm = async (): Promise<void> => {
    setError(null)
    const profileId = useAuthStore.getState().currentUser?.id
    try {
      if (bundle) await uninstall.mutateAsync(agent.remoteTargetId!)
      else if (agent.source === 'remote') await removeRemote.mutateAsync(agent.id)
      else await remove.mutateAsync(agent.id)
      setConfirming(false)
      if (useAuthStore.getState().currentUser?.id === profileId && useUIStore.getState().activeExternalAgentId === agent.id) useUIStore.getState().setActiveExternalAgentId(null)
    } catch (err) { setError(unwrapIpcError(err, 'Could not remove this agent.')) }
  }

  return <>
    <button ref={menu.triggerRef} type="button" aria-label="More actions" title="More actions"
      aria-haspopup="menu" aria-expanded={menu.open} onClick={() => menu.setOpen(!menu.open)}
      className="flex items-center rounded-md border border-[var(--color-border)] px-1.5 py-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
      <MoreHorizontal size={14} />
    </button>
    {menu.open && menu.style && createPortal(
      <div ref={menu.popoverRef} style={menu.style} role="menu" aria-label="Agent actions" className={MENU_SURFACE}>
        {showVisibility && <button type="button" role="menuitem" className={MENU_ITEM} disabled={enabled.isPending}
          onClick={() => {
            menu.setOpen(false)
            onError(null)
            enabled.setVisible(agent, !agent.enabled, (err) => onError(unwrapIpcError(err, 'Could not update this agent.')))
          }}>
          <Power size={12} />{agent.enabled ? 'Disable in Desktop App' : 'Enable in Desktop App'}
        </button>}
        {canRemove && <>
          {showVisibility && <div className="my-1 border-t border-[var(--color-border)]" />}
          <button type="button" role="menuitem" className={`${MENU_ITEM} text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
            onClick={() => { menu.setOpen(false); setError(null); setConfirming(true) }}>
            {bundle ? <PackageX size={12} /> : <Trash2 size={12} />}{bundle ? 'Uninstall agent…' : 'Delete agent…'}
          </button>
        </>}
      </div>, document.body
    )}
    {confirming && createPortal(bundle ? (
      <CatalogUninstallModal agentName={agent.name} pending={pending} errorMessage={error} onConfirm={() => void confirm()} onClose={() => setConfirming(false)} />
    ) : (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25" onClick={() => { if (!pending) setConfirming(false) }}>
        <div role="dialog" aria-modal="true" aria-label="Delete agent" onClick={(event) => event.stopPropagation()}
          className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl">
          <h2 className="text-sm font-medium">Delete {agent.name}?</h2>
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{agent.source === 'remote'
            ? 'This permanently deletes the agent and its environment on the Cinna server. Existing Desktop chats stay, but can no longer reach this agent.'
            : 'This removes the agent connection from Desktop. Existing chats stay, but can no longer reach this agent. The agent itself stays on its server or in its workspace.'}</p>
          {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={pending} onClick={() => setConfirming(false)} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-50">Cancel</button>
            <button type="button" disabled={pending} onClick={() => void confirm()} className="rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-xs text-white disabled:opacity-50">{pending ? 'Deleting…' : 'Delete agent'}</button>
          </div>
        </div>
      </div>
    ), document.body)}
  </>
}
