import { vaultErrorText } from '../../../../hooks/useVault'
import { vaultOtherBuildDeleteText, vaultOtherBuildMoveOutText, type HelperFlavor } from '../../../../../../shared/vault/types'
import { TypeNameConfirmDialog, VaultConfirmDialog } from './VaultDialog'

/** What a gated call's pending button says while the helper's own prompt is up. */
const APPROVAL = 'Waiting for approval…'

/**
 * The two ways out of a vault, each behind its own confirm (ux_rules rule 5):
 * one implementation for the Security tab's buttons and the sidebar row's
 * menu. The caller owns the mutation, so it decides what happens on success.
 */
interface LeaveVaultDialogProps {
  agentName: string
  pending: boolean
  /** The mutation's error, said with {@link vaultErrorText}. */
  error: unknown
  onCancel: () => void
  onConfirm: () => void
}

/** Move out of vault: back to a normal folder; nothing is lost, so no typing. */
export function MoveOutVaultDialog({ agentName, pending, error, onCancel, onConfirm }: LeaveVaultDialogProps): React.JSX.Element {
  return (
    <VaultConfirmDialog
      title="Move out of vault"
      confirmLabel="Move out"
      pendingLabel={APPROVAL}
      pending={pending}
      error={error ? vaultErrorText(error) : null}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>
        {agentName} goes back to a normal folder in your agents folder, and its vault is deleted. Everything
        inside — files, chats, secrets, the engine login — becomes readable by other apps and agents on this
        Mac again.
      </p>
      <p>The vault helper asks for your approval before anything leaves.</p>
    </VaultConfirmDialog>
  )
}

/**
 * Delete vault: irreversible, so the agent's name is typed to confirm. For a
 * vault another build made (`otherBuild`), it says that build can still open it.
 */
export function DeleteVaultDialog({ agentName, otherBuild = null, pending, error, onCancel, onConfirm }: LeaveVaultDialogProps & {
  otherBuild?: HelperFlavor | null
}): React.JSX.Element {
  return (
    <TypeNameConfirmDialog
      title="Delete vault"
      agentName={agentName}
      confirmLabel="Delete vault"
      pendingLabel={APPROVAL}
      pending={pending}
      error={error ? vaultErrorText(error) : null}
      onCancel={onCancel}
      onConfirm={() => onConfirm()}
    >
      <p>
        Nothing can be recovered. {agentName}, its files, its chats, its secrets and its engine login are
        deleted with the vault. There is no backup, and nothing goes to the Trash.
      </p>
      {otherBuild && <p>{vaultOtherBuildDeleteText(otherBuild)}</p>}
      <p>Files you exported earlier stay where you saved them.</p>
    </TypeNameConfirmDialog>
  )
}

/** Why Move out of vault is off for a vault its helper can't open (it would have to read the vault). */
export const MOVE_OUT_TAMPERED_TITLE = "This vault can't be opened, so nothing can be moved out of it."

/** Why Move out of vault is off for a tampered vault: from the build that made it, else not at all. */
export function moveOutDisabledReason(otherBuild: HelperFlavor | null | undefined): string {
  return otherBuild ? vaultOtherBuildMoveOutText(otherBuild) : MOVE_OUT_TAMPERED_TITLE
}
