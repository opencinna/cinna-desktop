import { FolderOutput, Loader2, Lock, LockOpen, Settings, SquareTerminal, Trash2 } from 'lucide-react'
import { CONTEXT_MENU_ITEM as ITEM, ContextMenu } from '../../ui/ContextMenu'
import { useId } from 'react'
import { useVaultLocking, useVaultStatus, useVaultUnlocking } from '../../../hooks/useVault'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { vaultOtherBuildShortText } from '../../../../../shared/vault/types'
import { moveOutDisabledReason } from './security/LeaveVaultDialogs'

/** What the row menu can ask its list for; each closes the menu first. */
export type VaultRowAction = 'unlock' | 'lock' | 'terminal' | 'settings' | 'move-out' | 'destroy'

interface VaultAgentRowMenuProps {
  /** The pointer, where the menu opens; clamped to the viewport. */
  x: number
  y: number
  /** The row: a scroll of anything containing it closes the menu. */
  anchor: HTMLElement | null
  /** A vault agent (`agent.vault` set). */
  agent: LocalAgentDto
  onAction: (action: VaultRowAction) => void
  onClose: () => void
}

/**
 * A sidebar vault-agent row's right-click menu, on the shared
 * {@link ContextMenu} shell. Every item of the folder agent's menu acts on a
 * host folder a vault agent does not have, so it gets its own: the vault's
 * state action, its terminal, its settings, and the two ways out of the
 * vault. Nothing runs in the menu: Unlock raises Touch ID, which blurs the
 * window and so would close it anyway, so every item closes the menu and the
 * list runs the action or opens the dialog.
 */
export function VaultAgentRowMenu({
  x, y, anchor, agent, onAction, onClose
}: VaultAgentRowMenuProps): React.JSX.Element {
  // Fresher than the list's copy: the status poll is what learns `tampered`.
  const status = useVaultStatus(agent.id).data
  const state = status?.state ?? agent.vault?.state ?? 'locked'
  const tampered = state === 'tampered'
  // Another build made it: the list's copy first, the status once it has it.
  const otherBuild = tampered ? (agent.vault?.otherBuild ?? status?.otherBuild ?? null) : null
  // An unlock or lock of this agent from any surface (Touch ID, or the guest image downloading).
  const unlocking = useVaultUnlocking(agent.id)
  const locking = useVaultLocking(agent.id)
  const moveOutReasonId = useId()
  const pick = (action: VaultRowAction): void => {
    onClose()
    onAction(action)
  }
  return (
    <ContextMenu x={x} y={y} anchor={anchor} label={`Agent ${agent.name}`} onClose={onClose}>
      {otherBuild && (
        // Not an action: why this vault has none of the state ones.
        <div className="px-2 py-1.5 text-xs text-[var(--color-text-muted)]">{vaultOtherBuildShortText(otherBuild)}</div>
      )}
      {otherBuild && <div role="separator" className="my-1 border-t border-[var(--color-border)]" />}
      {!tampered && (
        state === 'locking' || (locking && state !== 'locked' && state !== 'stopped') || (unlocking && state !== 'unlocked' && state !== 'booting') ? (
          <button type="button" role="menuitem" className={ITEM} disabled>
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {state === 'locking' || locking ? 'Locking…' : 'Unlocking…'}
          </button>
        ) : state === 'unlocked' || state === 'booting' ? (
          <button type="button" role="menuitem" className={ITEM} onClick={() => pick('lock')}>
            <Lock size={12} aria-hidden="true" />Lock now
          </button>
        ) : (
          <button type="button" role="menuitem" className={ITEM} onClick={() => pick('unlock')}>
            <LockOpen size={12} aria-hidden="true" />Unlock
          </button>
        )
      )}
      {state === 'unlocked' && (
        <button type="button" role="menuitem" className={ITEM} onClick={() => pick('terminal')}>
          <SquareTerminal size={12} aria-hidden="true" />Open terminal
        </button>
      )}
      {!tampered && <div role="separator" className="my-1 border-t border-[var(--color-border)]" />}
      <button type="button" role="menuitem" className={ITEM} onClick={() => pick('settings')}>
        <Settings size={12} aria-hidden="true" />Vault settings
      </button>
      <div role="separator" className="my-1 border-t border-[var(--color-border)]" />
      {/*
        Off for a vault its helper can't open, yet focusable: aria-disabled
        (not `disabled`) keeps it in the arrow-key order, with its reason.
      */}
      <button type="button" role="menuitem" className={`${ITEM} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
        aria-disabled={tampered || undefined}
        aria-describedby={tampered ? moveOutReasonId : undefined}
        title={tampered ? moveOutDisabledReason(otherBuild) : undefined}
        onClick={() => { if (!tampered) pick('move-out') }}>
        <FolderOutput size={12} aria-hidden="true" />Move out of vault
      </button>
      {tampered && <span id={moveOutReasonId} className="sr-only">{moveOutDisabledReason(otherBuild)}</span>}
      <button type="button" role="menuitem"
        className={`${ITEM} text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
        onClick={() => pick('destroy')}>
        <Trash2 size={12} aria-hidden="true" />Delete vault
      </button>
    </ContextMenu>
  )
}
