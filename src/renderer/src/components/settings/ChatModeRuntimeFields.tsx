import { useRuntimeModelCatalog } from '../../hooks/useRuntimeModelCatalog'
import { useId, useState } from 'react'
import type { ChatModeRuntime } from '../../../../shared/chatModeRuntime'
import type { AgentEngine } from '../../../../shared/engine'
import { SettingsLabel, settingsInputClass } from './SettingsLayout'

export const CODEX_CHAT_MODE_WARNING = 'Codex unavailable. Choose Claude or OpenCode.'

export type ChatModeRuntimeValue = ChatModeRuntime & { modelId?: string | null; providerId?: string | null }

/** Runtime and permission profile shared by new and existing chat modes. */
export function ChatModeRuntimeFields({ value, onChange, section = 'all', resolvedEngine }: {
  value: ChatModeRuntimeValue
  section?: 'all' | 'runtime' | 'options'
  resolvedEngine?: AgentEngine | null
  onChange: (patch: Partial<ChatModeRuntimeValue>) => void
}): React.JSX.Element {
  const id = useId()
  const [prompt, setPrompt] = useState(value.systemPrompt ?? '')
  const [customModel, setCustomModel] = useState(false)
  const engine = value.engine ?? resolvedEngine
  const { data: catalog } = useRuntimeModelCatalog(engine)
  const choices = catalog?.source === 'session' ? catalog.models : engine === 'claude'
    ? [{ id: 'haiku', name: 'Haiku' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }] : []
  return <>
    {section !== 'options' && <div>
      <SettingsLabel htmlFor={`${id}-runtime`} info="The runtime that answers this mode's chats. Claude uses your CLI login; OpenCode uses AI credentials. Codex is unavailable for chat modes because it cannot disable native file and shell tools.">Runtime</SettingsLabel>
      <select id={`${id}-runtime`} value={value.engine ?? ''} className={settingsInputClass}
        onChange={(event) => { setCustomModel(false); onChange({ engine: (event.target.value || null) as AgentEngine | null, modelId: null, providerId: null }) }}>
        <option value="">Default runtime</option>
        <option value="claude">Claude</option>
        <option value="codex" disabled>Codex (unavailable for chat modes)</option>
        <option value="opencode">OpenCode</option>
      </select>
      {engine === 'codex' && <p role="status" className="mt-2 text-[13px] text-[var(--color-warning)]">{CODEX_CHAT_MODE_WARNING}</p>}
    </div>}
    {section !== 'runtime' && <fieldset disabled={engine === 'codex'} className="space-y-3 disabled:opacity-60">
    {(engine === 'claude' || engine === 'codex') && <div>
      <SettingsLabel htmlFor={`${id}-model`} info={catalog?.source === 'session'
        ? 'Models last advertised by this runtime in this profile. Runtime default follows its configuration; Other model accepts an explicit model ID.'
        : 'No session catalog yet. Claude aliases are fallback choices; an explicit model ID can be entered. Runtime default follows the CLI configuration.'}>Model</SettingsLabel>
      {choices.length > 0 && !customModel ? <select id={`${id}-model`} value={value.modelId ?? ''} className={settingsInputClass}
        onChange={(event) => { if (event.target.value === '__custom__') setCustomModel(true); else onChange({ modelId: event.target.value || null }) }}>
        <option value="">Runtime default</option>
        {choices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        {value.modelId && !choices.some(model => model.id === value.modelId) && <option value={value.modelId}>{value.modelId}</option>}
        <option value="__custom__">Other model…</option>
      </select> : <div className="flex items-center gap-2">
        <input key={`${value.engine}-model`} id={`${id}-model`} className={`${settingsInputClass} min-w-0 flex-1`} defaultValue={value.modelId ?? ''}
          placeholder="Runtime default" onBlur={(event) => { if (event.target.value !== (value.modelId ?? '')) onChange({ modelId: event.target.value.trim() || null }) }} />
        {customModel && choices.length > 0 && <button type="button" className="shrink-0 text-[13px] font-medium text-[var(--color-accent)] underline"
          onClick={() => setCustomModel(false)}>Listed models</button>}
      </div>}

    </div>}
    <div>
      <SettingsLabel htmlFor={`${id}-tools`} info="Chat modes cannot use filesystem or shell tools. Connected tools allows the agents and MCP servers you attach; No tools disables them too.">Tools</SettingsLabel>
      <select id={`${id}-tools`} value={value.toolPolicy ?? 'connectors'} className={settingsInputClass}
        onChange={(event) => onChange({ toolPolicy: event.target.value as 'none' | 'connectors' })}>
        <option value="none">No tools</option><option value="connectors">Connected tools</option>
      </select>
    </div>
    <div>
      <SettingsLabel htmlFor={`${id}-prompt`} info="Instructions included when the chat's runtime session starts.">Instructions</SettingsLabel>
      <textarea id={`${id}-prompt`} value={prompt} rows={4} className={`${settingsInputClass} resize-y`}
        onChange={(event) => setPrompt(event.target.value)} onBlur={() => { if (prompt !== (value.systemPrompt ?? '')) onChange({ systemPrompt: prompt }) }} />
    </div>
    </fieldset>}
  </>
}
