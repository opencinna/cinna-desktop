import { useRuntimeModelCatalog } from '../../hooks/useRuntimeModelCatalog'
import { useId, useState, type ReactNode } from 'react'
import { RUNTIME_MODE_ENGINES, RUNTIME_MODE_NAMES, supportsWorkspacePolicy, type ChatModeRuntime, type ChatToolPolicy } from '../../../../shared/chatModeRuntime'
import type { AgentEngine } from '../../../../shared/engine'
import type { WorkComplexity } from '../../../../shared/modelFamilies'
import { SettingsLabel, settingsInputClass } from './SettingsLayout'

export type ChatModeRuntimeValue = ChatModeRuntime & { modelId?: string | null; providerId?: string | null }

/** Effort is the stored work tier under the names the user picks from. */
export const EFFORT_OPTIONS: readonly { value: WorkComplexity; label: string }[] = [
  { value: 'simple', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'complex', label: 'High' }
]

/** Runtime and permission profile shared by new and existing chat modes. */
export function ChatModeRuntimeFields({ value, onChange, section = 'all', resolvedEngine, runtimeMode = false, afterModel }: {
  value: ChatModeRuntimeValue
  section?: 'all' | 'runtime' | 'options'
  resolvedEngine?: AgentEngine | null
  /**
   * A runtime mode: Effort always names a tier (no "No preference"), the
   * model is an override of it, and empty instructions mean the default ones.
   */
  runtimeMode?: boolean
  /** Rendered after the model field, before Tools (OpenCode's credential and model). */
  afterModel?: ReactNode
  onChange: (patch: Partial<ChatModeRuntimeValue>) => void
}): React.JSX.Element {
  const id = useId()
  const [prompt, setPrompt] = useState(value.systemPrompt ?? '')
  const [customModel, setCustomModel] = useState(false)
  const engine = value.engine ?? resolvedEngine
  const workspace = supportsWorkspacePolicy(value.engine)
  /** Why Workspace is unavailable, on the option itself so it is seen where it is missed. */
  const workspaceReason = workspace ? null : value.engine ? `not available for ${RUNTIME_MODE_NAMES[value.engine]} yet` : 'choose a runtime first'
  /** An empty model follows the tier when there is one. */
  const noModelLabel = value.complexity ? 'From effort' : 'Runtime default'
  const { data: catalog } = useRuntimeModelCatalog(engine)
  const choices = catalog?.source === 'session' ? catalog.models : engine === 'claude'
    ? [{ id: 'haiku', name: 'Haiku' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }] : []
  return <>
    {section !== 'options' && <div>
      <SettingsLabel htmlFor={`${id}-runtime`} info="Claude and Codex use your installed CLI login, Antigravity your Google login; OpenCode uses AI credentials. Runtime support is checked when the chat starts.">Runtime</SettingsLabel>
      <select id={`${id}-runtime`} value={value.engine ?? ''} className={settingsInputClass}
        onChange={(event) => { setCustomModel(false); onChange({ engine: (event.target.value || null) as AgentEngine | null, modelId: null, providerId: null }) }}>
        <option value="">Default runtime</option>
        {/* The runtime cards' own names, in their order. */}
        {RUNTIME_MODE_ENGINES.map((engine) => <option key={engine} value={engine}>{RUNTIME_MODE_NAMES[engine]}</option>)}
      </select>
    </div>}
    {section !== 'runtime' && <fieldset className="space-y-3">
    <div>
      <SettingsLabel htmlFor={`${id}-effort`} info="How much effort the runtime puts into each answer: Low is quick, High takes the time to think. Sets the runtime's model or reasoning level, unless a model is chosen below.">Effort</SettingsLabel>
      <select id={`${id}-effort`} value={value.complexity ?? ''} className={settingsInputClass}
        onChange={(event) => onChange({ complexity: (event.target.value || null) as WorkComplexity | null })}>
        {!runtimeMode && <option value="">No preference</option>}
        {EFFORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
    {(engine === 'claude' || engine === 'codex' || engine === 'antigravity') && <div>
      <SettingsLabel htmlFor={`${id}-model`} info={catalog?.source === 'session'
        ? 'Models last advertised by this runtime in this profile. Runtime default follows its configuration; Other model accepts an explicit model ID.'
        : 'No session catalog yet. Claude aliases are fallback choices; an explicit model ID can be entered. Runtime default follows the CLI configuration.'}>{runtimeMode ? 'Model override' : 'Model'}</SettingsLabel>
      {choices.length > 0 && !customModel ? <select id={`${id}-model`} value={value.modelId ?? ''} className={settingsInputClass}
        onChange={(event) => { if (event.target.value === '__custom__') setCustomModel(true); else onChange({ modelId: event.target.value || null }) }}>
        <option value="">{noModelLabel}</option>
        {choices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        {value.modelId && !choices.some(model => model.id === value.modelId) && <option value={value.modelId}>{value.modelId}</option>}
        <option value="__custom__">Other model…</option>
      </select> : <div className="flex items-center gap-2">
        <input key={`${value.engine}-model`} id={`${id}-model`} className={`${settingsInputClass} min-w-0 flex-1`} defaultValue={value.modelId ?? ''}
          placeholder={noModelLabel}
          // Enter would submit the form before blur commits the id: commit instead.
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
          onBlur={(event) => { if (event.target.value !== (value.modelId ?? '')) onChange({ modelId: event.target.value.trim() || null }) }} />
        {customModel && choices.length > 0 && <button type="button" className="shrink-0 text-[13px] font-medium text-[var(--color-accent)] underline"
          onClick={() => setCustomModel(false)}>Listed models</button>}
      </div>}

    </div>}
    {afterModel}
    <div>
      <SettingsLabel htmlFor={`${id}-tools`} info="Workspace adds the runtime's own file and shell tools, working in a folder of the chat's own, and asks before each action. Connected tools allows the agents and MCP servers you attach; No tools disables them too.">Tools</SettingsLabel>
      <select id={`${id}-tools`} value={value.toolPolicy ?? 'connectors'} className={settingsInputClass}
        onChange={(event) => onChange({ toolPolicy: event.target.value as ChatToolPolicy })}>
        <option value="workspace" disabled={!workspace}>{workspaceReason ? `Workspace (${workspaceReason})` : 'Workspace'}</option>
        <option value="connectors">Connected tools</option>
        <option value="none">No tools</option>
      </select>
    </div>
    <div>
      <SettingsLabel htmlFor={`${id}-prompt`} info="Instructions included when the chat's runtime session starts.">Instructions</SettingsLabel>
      <textarea id={`${id}-prompt`} value={prompt} rows={4} className={`${settingsInputClass} resize-y`}
        placeholder={runtimeMode ? 'Empty uses the default instructions' : undefined}
        onChange={(event) => setPrompt(event.target.value)} onBlur={() => { if (prompt !== (value.systemPrompt ?? '')) onChange({ systemPrompt: prompt }) }} />
    </div>
    </fieldset>}
  </>
}
