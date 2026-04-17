import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders } from '../../hooks/useMcp'
import { useUpsertChatMode } from '../../hooks/useChatModes'
import { COLOR_PRESETS } from '../../constants/chatModeColors'

interface ChatModeFormProps {
  onClose: () => void
}

export function ChatModeForm({ onClose }: ChatModeFormProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [mcpIds, setMcpIds] = useState<Set<string>>(new Set())
  const [colorPreset, setColorPreset] = useState('indigo')

  const { data: providers } = useProviders()
  const { data: allModels } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const upsert = useUpsertChatMode()

  const enabledProviders = (providers ?? []).filter((p) => p.enabled && p.hasApiKey)
  const modelsForProvider = (allModels ?? []).filter((m) => m.providerId === providerId)

  const toggleMcp = (id: string): void => {
    setMcpIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreate = (): void => {
    if (!name.trim()) return
    upsert.mutate(
      {
        name: name.trim(),
        providerId: providerId || null,
        modelId: modelId || null,
        mcpProviderIds: Array.from(mcpIds),
        colorPreset
      },
      { onSuccess: onClose }
    )
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="font-medium text-xs text-[var(--color-text)]">New Chat Mode</span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-3">
        {/* Name */}
        <div>
          <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="e.g. Development, Writing, Research..."
            autoFocus
          />
        </div>

        {/* Color preset */}
        <div>
          <label className="block text-[10px] text-[var(--color-text-muted)] mb-1">Color</label>
          <div className="flex flex-wrap gap-1.5">
            {COLOR_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setColorPreset(p.id)}
                className="w-6 h-6 rounded-full flex items-center justify-center transition-transform hover:scale-110"
                style={{ backgroundColor: p.border }}
                title={p.name}
              >
                {colorPreset === p.id && <Check size={12} className="text-white" />}
              </button>
            ))}
          </div>
        </div>

        {/* LLM Provider */}
        <div>
          <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
            LLM Provider
          </label>
          <select
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value)
              setModelId('')
            }}
            className={`${inputClass} cursor-pointer`}
          >
            <option value="">None (use default)</option>
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* Model */}
        {providerId && (
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
              Model
            </label>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className={`${inputClass} cursor-pointer`}
            >
              <option value="">First available</option>
              {modelsForProvider.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* MCP Providers */}
        {(mcpProviders ?? []).length > 0 && (
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-1">
              MCP Providers
            </label>
            <div className="space-y-1">
              {(mcpProviders ?? []).map((mcp) => (
                <button
                  key={mcp.id}
                  type="button"
                  onClick={() => toggleMcp(mcp.id)}
                  className="w-full text-left px-2.5 py-1.5 rounded-md text-xs
                    hover:bg-[var(--color-bg-hover)] transition-colors flex items-center gap-2"
                >
                  <div
                    className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                      mcpIds.has(mcp.id)
                        ? 'bg-[var(--color-accent)] border-[var(--color-accent)]'
                        : 'border-[var(--color-border)]'
                    }`}
                  >
                    {mcpIds.has(mcp.id) && <Check size={9} className="text-white" />}
                  </div>
                  <span className="text-[var(--color-text)]">{mcp.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Buttons */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--color-text-muted)]
              hover:text-[var(--color-text-secondary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!name.trim() || upsert.isPending}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]
              text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Create Mode
          </button>
        </div>
      </div>
    </div>
  )
}
