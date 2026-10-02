import { Ban, Check } from 'lucide-react'
import { AGENT_SHORTCUT_SLOTS } from '../../../../shared/appShortcuts'
import { AGENT_COLOR_PRESETS } from '../../../../shared/agentColors'
import {
  useAgentColors,
  useAgents,
  useAgentShortcuts,
  useSetAgentColor,
  useSetAgentShortcut
} from '../../hooks/useAgents'
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
 * keyboard, and the color that picks it out in the sidebar. Shared by folder
 * agents and every other agent page.
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
    <div className="space-y-6">
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
    <AgentColorSection agentId={agent.id} />
    </div>
  )
}

const SWATCH =
  'w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-transform hover:scale-110 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]'
// A ring, not a border: it is drawn outside the box, so choosing moves nothing.
const SWATCH_SELECTED = 'ring-2 ring-offset-2 ring-[var(--color-text-secondary)] ring-offset-[var(--color-bg)]'

/**
 * The agent's color preset: a row of swatches, None first. Saves on click; the
 * check is drawn inside the swatch, so nothing moves when one is chosen.
 */
function AgentColorSection({ agentId }: { agentId: string }): React.JSX.Element {
  const { data: colors } = useAgentColors()
  const setColor = useSetAgentColor()
  const saved = colors?.find((c) => c.agentId === agentId)?.preset ?? null
  // As with the shortcut: the choice in flight, not the value it replaces.
  const current = setColor.isPending ? (setColor.variables?.preset ?? null) : saved
  const choose = (preset: string | null): void => {
    if (preset !== current) setColor.mutate({ agentId, preset })
  }

  return (
    <SettingsSection title="Color">
      <SettingsCard>
        <SettingsLabel info="Tints this agent's icon in the sidebar Agents list and its group in the Chats list, puts a dot before its chats elsewhere in that list, and colors its chips and labels in the chat. None leaves the sidebar uncolored.">
          Color preset
        </SettingsLabel>
        <div role="group" aria-label="Color preset" className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            aria-label="None"
            title="None"
            aria-pressed={current === null}
            onClick={() => choose(null)}
            className={`${SWATCH} border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] ${current === null ? SWATCH_SELECTED : ''}`}
          >
            <Ban size={12} aria-hidden="true" />
          </button>
          {AGENT_COLOR_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-label={preset.name}
              title={preset.name}
              aria-pressed={current === preset.id}
              onClick={() => choose(preset.id)}
              className={`${SWATCH} ${current === preset.id ? SWATCH_SELECTED : ''}`}
              style={{ backgroundColor: preset.color }}
            >
              {current === preset.id && <Check size={12} aria-hidden="true" className="text-black/70" />}
            </button>
          ))}
        </div>
        {setColor.error && (
          <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
            {unwrapIpcError(setColor.error, 'Could not save the color.')}
          </p>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
