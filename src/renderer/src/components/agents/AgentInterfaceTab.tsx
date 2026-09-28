import { AGENT_SHORTCUT_SLOTS } from '../../../../shared/appShortcuts'
import { useAgents, useAgentShortcuts, useSetAgentShortcut } from '../../hooks/useAgents'
import { agentShortcutLabel, truncateName } from '../../utils/appShortcuts'
import { unwrapIpcError } from '../../utils/ipcError'
import { MOD_KEY, resolveKey } from '../../constants/hints'
import {
  SettingsCard,
  SettingsLabel,
  SettingsSection,
  settingsDropdownRowClass,
  settingsInputClass
} from '../settings/SettingsLayout'

/**
 * An agent page's Interface tab: how the user reaches this agent from the
 * keyboard. Shared by folder agents and every other agent page.
 *
 * Saves on change. A digit another agent holds says whose it is, so choosing
 * it reads as moving it — which is what main does.
 */
export function AgentInterfaceTab({
  agent
}: {
  agent: { id: string; name: string }
}): React.JSX.Element {
  const { data: bindings } = useAgentShortcuts()
  const { data: agents } = useAgents()
  const setShortcut = useSetAgentShortcut()
  const saved = bindings?.find((b) => b.agentId === agent.id)?.slot ?? null
  // While the save is in flight the select shows the choice, not the value it
  // is replacing — otherwise it would snap back until the list re-reads.
  const current = setShortcut.isPending ? (setShortcut.variables?.slot ?? null) : saved
  const selectId = `agent-shortcut-${agent.id}`

  return (
    <SettingsSection title="Keyboard shortcut">
      <SettingsCard>
        <div className={settingsDropdownRowClass}>
          <SettingsLabel
            htmlFor={selectId}
            info={`Press ${resolveKey(MOD_KEY)} and the chosen digit from any screen to start a new chat with this agent.`}
          >
            Shortcut
          </SettingsLabel>
          <select
            id={selectId}
            className={settingsInputClass}
            value={current === null ? '' : String(current)}
            onChange={(event) => {
              const value = event.target.value
              setShortcut.mutate({ agentId: agent.id, slot: value === '' ? null : Number(value) })
            }}
          >
            <option value="">None</option>
            {AGENT_SHORTCUT_SLOTS.map((slot) => {
              const holder = bindings?.find((b) => b.slot === slot)
              // The chosen digit reads bare even before the list re-reads: the
              // closed select has no room for another agent's name.
              const other =
                holder && holder.agentId !== agent.id && slot !== current
                  ? agents?.find((a) => a.id === holder.agentId)
                  : undefined
              const label = agentShortcutLabel(slot)
              return (
                <option key={slot} value={String(slot)}>
                  {other ? `${label} · ${truncateName(other.name)}` : label}
                </option>
              )
            })}
          </select>
        </div>
        {setShortcut.error && (
          <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
            {unwrapIpcError(setShortcut.error, 'Could not save the shortcut.')}
          </p>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
