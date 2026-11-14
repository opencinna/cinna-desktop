import { useState } from 'react'
import { ChevronDown, Lock } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import { useVaultAvailability } from '../../../../hooks/useVault'
import { AnimatedCollapse } from '../../../ui/AnimatedCollapse'
import {
  SettingsBadge,
  SettingsButton,
  SettingsCard,
  SettingsInfoTip,
  SettingsSection,
  SettingsStatusRow
} from '../../../settings/SettingsLayout'
import { unavailableText } from './vaultText'
import { BACKEND_NAME, VaultOnPanel } from './VaultOnPanel'

/**
 * Security → Agent Vault (D9). The section never disappears: an agent that
 * can move says so with **Move to vault…**, a Mac that cannot hold a vault
 * says why in words and offers no button, and an agent in a vault gets its
 * controls (`VaultOnPanel`).
 */
export function AgentVaultSection({
  agent,
  onMove
}: {
  agent: LocalAgentDto
  /** Opens Move to vault… — owned by the tab, so the move outlives nothing it needs. */
  onMove: () => void
}): React.JSX.Element {
  const availability = useVaultAvailability()
  const flavor = availability.data?.flavor ?? null
  const backend = availability.data?.backend ?? null
  return (
    <SettingsSection
      title="Agent Vault"
      info={
        <>
          <SettingsInfoTip label="About Agent Vault">
            <p>
              A vault moves this agent into its own isolated Linux machine on this Mac. Its files,
              credentials, chats and engine login live only inside, sealed with a key in this Mac’s
              Secure Enclave.
            </p>
            <p className="mt-2">
              Unlocking asks for Touch ID or your password in the vault helper’s own prompt, not in
              Cinna, and lasts one minute after the last turn. Locking the Mac locks every vault.
            </p>
          </SettingsInfoTip>
          {/* Anything but the signed release helper: a build that must not hold real secrets. */}
          {flavor && flavor !== 'release' && (
            <SettingsBadge
              tone="danger"
              title={`This build runs the ${flavor} vault helper${
                backend ? ` on the ${BACKEND_NAME[backend] ?? backend}` : ''
              }, which does not protect what it holds.`}
            >
              Test helper
            </SettingsBadge>
          )}
        </>
      }
    >
      {agent.vault ? (
        <VaultOnPanel agent={agent} vault={agent.vault} />
      ) : (
        <VaultOffCard availability={availability} onMove={onMove} />
      )}
    </SettingsSection>
  )
}

function VaultOffCard({
  availability,
  onMove
}: {
  availability: ReturnType<typeof useVaultAvailability>
  onMove: () => void
}): React.JSX.Element {
  const reason = availability.data
    ? unavailableText(availability.data.availability)
    : availability.error
      ? 'Agent Vault could not be checked on this Mac.'
      : null
  const [open, setOpen] = useState(false)
  return (
    <SettingsCard>
      {/*
        One row in every state, the same height: the label and its one line
        change, the button is there (disabled while this Mac is checked) or,
        when this Mac cannot hold a vault, absent — the reason is the answer.
      */}
      {reason ? (
        <SettingsStatusRow tone="neutral" label="Not available on this Mac" detail={reason} />
      ) : (
        <SettingsStatusRow
          tone="neutral"
          label="Not in a vault"
          detail="Isolates this agent so no other app or agent on this Mac can read or prompt it."
          action={
            <SettingsButton
              onClick={onMove}
              disabled={!availability.data}
              title={availability.data ? undefined : 'Checking this Mac…'}
            >
              <Lock size={14} aria-hidden="true" />
              Move to vault…
            </SettingsButton>
          }
        />
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="mt-3 flex items-center gap-1 text-[13px] font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]"
      >
        What a vault protects against
        <ChevronDown size={14} aria-hidden="true" className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatedCollapse open={open}>
        <ThreatModel />
      </AnimatedCollapse>
    </SettingsCard>
  )
}

/** The threat model in plain words (README "Threat model"), both halves. */
export function ThreatModel(): React.JSX.Element {
  return (
    <div className="mt-2 grid grid-cols-2 gap-4 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
      <div>
        <div className="mb-1 text-[14px] font-medium text-[var(--color-text)]">It protects</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>What is inside — files, credentials, chats, the engine login — from every other app and agent on this Mac.</li>
          <li>The way in: messages, files and installs need your Touch ID or password.</li>
          <li>The way out: each export asks, and the network reaches only the hosts you allow.</li>
        </ul>
      </div>
      <div>
        <div className="mb-1 text-[14px] font-medium text-[var(--color-text)]">It does not protect</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>Against deletion. Another program can delete the vault’s disk image, and there is no backup yet, so the agent would be lost.</li>
          <li>The clipboard. Anything you copy out of a vault chat can be read by other apps.</li>
          <li>Anything exposed before the move. Rotate credentials other agents could already read.</li>
          <li>An unlocked vault from someone with administrator (root) control of this Mac.</li>
          <li>Screen recording or Accessibility access you gave to other apps.</li>
        </ul>
      </div>
    </div>
  )
}

