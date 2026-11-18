import { Loader2, Lock } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import type { VaultAgentDetailsDto } from '../../../../../../shared/vault/types'
import {
  useVaultAgentDetails,
  useVaultOpen,
  useVaultStatus,
  useVaultUnlock,
  useVaultUnlockPercent,
  vaultErrorText
} from '../../../../hooks/useVault'
import { vaultImageDownloadText } from '../../../../../../shared/vault/types'
import { SettingsButton, SettingsCard } from '../../../settings/SettingsLayout'
import { VaultUnlockLabel } from '../../../chat/VaultUnlockLabel'

const NOTE = 'text-[12px] text-[var(--color-text-muted)]'
/**
 * What a tab of a vault agent's page shows while its vault is locked: its
 * details are inside, so one card says so and offers Unlock, instead of each
 * card failing on its own. Unlock works as the Runs-with panel's
 * (`VaultEnginePanel`): a button on the right with the vault's own fixed-width
 * label, so it never widens while the unlock (or a boot already under way)
 * runs. The line under the sentence is always there and only its words change,
 * idle or unlocking (rule 1); a refusal is said in full under the row, wrapped,
 * as the vault panel says it.
 */
export function VaultLockedCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const state = useVaultStatus(agent.id).data?.state ?? agent.vault?.state
  const unlock = useVaultUnlock()
  const percent = useVaultUnlockPercent(agent.id)
  const unlocking = unlock.isPending || state === 'booting'
  const line = unlocking ? (percent === null ? 'Unlocking…' : vaultImageDownloadText(percent)) : 'Unlock it to read them here.'
  return (
    <SettingsCard>
      <div className="flex items-center gap-3" data-vault-locked-card>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
          <Lock size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            {agent.name}’s details are inside its locked vault.
          </p>
          <div className={`flex h-[1lh] min-w-0 items-center gap-1.5 ${NOTE}`}>
            {unlocking && <Loader2 size={10} className="shrink-0 animate-spin" aria-hidden="true" />}
            <span className="min-w-0 truncate" title={line}>{line}</span>
          </div>
        </div>
        <SettingsButton
          aria-disabled={unlocking || undefined}
          aria-busy={unlocking || undefined}
          onClick={() => { unlock.reset(); unlock.mutate(agent.id) }}
        >
          {/* Fixed width: Unlock, Unlocking… and the download percent swap in place. */}
          <VaultUnlockLabel pending={unlocking} percent={percent} />
        </SettingsButton>
      </div>
      {unlock.error && !unlocking && (
        <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
          {vaultErrorText(unlock.error, 'Unlock was cancelled at the prompt.')}
        </p>
      )}
    </SettingsCard>
  )
}

/**
 * A tab body built from what a vault agent's vault holds: the locked card
 * while it is locked, one line while it is read, the failure with Retry when
 * the read failed (a vault refusal is not retried on its own), and
 * `children` with the details once they are in (the last read stays shown
 * while it reads again).
 */
export function VaultDetailsGate({
  agent,
  children
}: {
  agent: LocalAgentDto
  children: (details: VaultAgentDetailsDto) => React.ReactNode
}): React.JSX.Element {
  const open = useVaultOpen(agent)
  const details = useVaultAgentDetails(agent.id, open)
  if (!open) return <VaultLockedCard agent={agent} />
  if (details.data) return <>{children(details.data)}</>
  if (details.error) {
    const retrying = details.isFetching
    return (
      <div className="flex items-start gap-3">
        <p role="alert" className="min-w-0 flex-1 text-[13px] text-[var(--color-danger)]">
          Couldn’t read from the vault. {vaultErrorText(details.error)}
        </p>
        <SettingsButton
          aria-disabled={retrying || undefined}
          aria-busy={retrying || undefined}
          onClick={() => void details.refetch()}
        >
          Retry
        </SettingsButton>
      </div>
    )
  }
  return <p className="text-[13px] italic text-[var(--color-text-muted)]">Reading from the vault…</p>
}
