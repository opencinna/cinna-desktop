import { useId, useState } from 'react'
import { Check, X } from 'lucide-react'
import { ChatModeRuntimeFields, type ChatModeRuntimeValue } from './ChatModeRuntimeFields'
import { SettingsLabel, settingsInputClass } from './SettingsLayout'
import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders } from '../../hooks/useMcp'
import { useUpsertChatMode } from '../../hooks/useChatModes'
import { useDefaultRuntime } from '../../hooks/useEngine'
import { COLOR_PRESETS } from '../../constants/chatModeColors'
import { isCredentialActive } from '../../../../shared/credentials'
import { unwrapIpcError } from '../../utils/ipcError'

interface ChatModeFormProps { onClose: () => void }

export function ChatModeForm({ onClose }: ChatModeFormProps): React.JSX.Element {
  const [runtime, setRuntime] = useState<ChatModeRuntimeValue>({ engine: null, systemPrompt: '', toolPolicy: 'connectors' })
  const [name, setName] = useState('')
  const [mcpIds, setMcpIds] = useState<Set<string>>(new Set())
  const [colorPreset, setColorPreset] = useState('indigo')
  const fieldId = useId()
  const { data: providers } = useProviders()
  const { data: allModels } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const { data: defaultRuntime } = useDefaultRuntime()
  const upsert = useUpsertChatMode()
  const engine = runtime.engine ?? defaultRuntime?.engine
  const credentialMode = engine === 'opencode'
  const enabledProviders = (providers ?? []).filter(isCredentialActive)
  const models = (allModels ?? []).filter((model) => model.providerId === runtime.providerId)
  const changeRuntime = (patch: Partial<ChatModeRuntimeValue>): void => setRuntime(previous => ({ ...previous, ...patch }))

  const handleCreate = (): void => {
    if (!name.trim() || upsert.isPending) return
    upsert.mutate({ ...runtime, name: name.trim(), providerId: runtime.providerId || null,
      modelId: runtime.modelId || null, mcpProviderIds: Array.from(mcpIds), colorPreset }, { onSuccess: onClose })
  }

  return (
    <form aria-label="New chat mode" onSubmit={(event) => { event.preventDefault(); handleCreate() }}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="font-medium text-[14px] text-[var(--color-text)]">New Chat Mode</span>
        <button type="button" aria-label="Cancel new chat mode" disabled={upsert.isPending} onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] transition-colors"><X size={12} /></button>
      </div>
      <fieldset disabled={upsert.isPending} className="border-t border-[var(--color-border)] px-4 py-3 space-y-3">
        <div>
          <SettingsLabel htmlFor={`${fieldId}-name`}>Name</SettingsLabel>
          <input id={`${fieldId}-name`} value={name} onChange={event => setName(event.target.value)}
            className={settingsInputClass} placeholder="e.g. Development, Writing, Research..." autoFocus />
        </div>
        <ChatModeRuntimeFields section="runtime" value={runtime} resolvedEngine={defaultRuntime?.engine} onChange={changeRuntime} />
        {credentialMode && <div>
          <SettingsLabel htmlFor={`${fieldId}-credential`}>AI Credentials</SettingsLabel>
          <select id={`${fieldId}-credential`} value={runtime.providerId ?? ''} className={settingsInputClass}
            onChange={event => changeRuntime({ providerId: event.target.value || null, modelId: null })}>
            <option value="">None (use default)</option>
            {enabledProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
        </div>}
        <details>
          <summary className="cursor-pointer text-[13px] font-medium text-[var(--color-accent)]">More options</summary>
          <div className="mt-3 space-y-3">
            <div>
              <SettingsLabel>Color</SettingsLabel>
              <div className="flex flex-wrap gap-1.5">{COLOR_PRESETS.map(preset => <button key={preset.id} type="button"
                onClick={() => setColorPreset(preset.id)} title={preset.name}
                className="w-6 h-6 rounded-full flex items-center justify-center transition-transform hover:scale-110"
                style={{ backgroundColor: preset.border }}>{colorPreset === preset.id && <Check size={12} className="text-white" />}</button>)}</div>
            </div>
            <ChatModeRuntimeFields section="options" value={runtime} resolvedEngine={defaultRuntime?.engine} onChange={changeRuntime} />
            {credentialMode && runtime.providerId && <div>
              <SettingsLabel htmlFor={`${fieldId}-model`}>Model</SettingsLabel>
              <select id={`${fieldId}-model`} value={runtime.modelId ?? ''} className={settingsInputClass}
                onChange={event => changeRuntime({ modelId: event.target.value || null })}>
                <option value="">First available</option>
                {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </div>}
            {(mcpProviders ?? []).length > 0 && <div>
              <SettingsLabel>MCP Providers</SettingsLabel>
              <div className="space-y-1">{mcpProviders!.map(mcp => <button key={mcp.id} type="button" aria-pressed={mcpIds.has(mcp.id)}
                onClick={() => setMcpIds(previous => { const next = new Set(previous); if (next.has(mcp.id)) next.delete(mcp.id); else next.add(mcp.id); return next })}
                className="w-full text-left px-2.5 py-1.5 rounded-md text-[14px] hover:bg-[var(--color-bg-hover)] transition-colors flex items-center gap-2">
                <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${mcpIds.has(mcp.id) ? 'bg-[var(--color-accent)] border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
                  {mcpIds.has(mcp.id) && <Check size={9} className="text-white" />}</span><span>{mcp.name}</span>
              </button>)}</div>
            </div>}
          </div>
        </details>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-[14px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors">Cancel</button>
          <button type="submit" disabled={!name.trim() || upsert.isPending}
            className="px-3 py-1.5 rounded-md text-[14px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors">{upsert.isPending ? 'Creating…' : 'Create Mode'}</button>
        </div>
        {upsert.error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{unwrapIpcError(upsert.error, 'Could not create chat mode')}</p>}
      </fieldset>
    </form>
  )
}
