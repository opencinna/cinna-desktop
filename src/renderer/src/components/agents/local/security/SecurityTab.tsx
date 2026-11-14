import { useState } from 'react'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import { SettingsInfoTip, SettingsSection } from '../../../settings/SettingsLayout'
import { PermissionsCard } from '../PermissionsCard'
import { AgentVaultSection } from './AgentVaultSection'
import { MoveToVaultDialog } from './MoveToVaultDialog'

/**
 * The agent page's Security tab (D9, once Permissions): **Agent Vault** first,
 * then the permissions this agent runs under. Titled sections like the tabs
 * beside it (ux_rules rule 12).
 *
 * Move to vault… is owned here rather than by the section's card, so the
 * dialog — and the move it follows — does not depend on which state the
 * section is drawing.
 */
export function SecurityTab({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const [moving, setMoving] = useState(false)
  return (
    <div className="space-y-6">
      <AgentVaultSection agent={agent} onMove={() => setMoving(true)} />
      <SettingsSection
        title="Permissions"
        info={
          <SettingsInfoTip label="About permissions">
            <p>
              What this agent may do without asking you: who approves its engine’s actions, what it was always
              allowed, and whether other agents may send it work.
            </p>
            {agent.vault && (
              <p className="mt-2" data-vault-delegation-off>
                Delegation, handovers and cloud delegation are off in a vault: no other agent can send it work,
                and it sends none out.
              </p>
            )}
          </SettingsInfoTip>
        }
      >
        <PermissionsCard agent={agent} />
      </SettingsSection>
      {moving && <MoveToVaultDialog agentId={agent.id} agentName={agent.name} onClose={() => setMoving(false)} />}
    </div>
  )
}
