import { useCallback } from 'react'
import { useState } from 'react'
import { Trash2, ChevronDown, Check } from 'lucide-react'
import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders } from '../../hooks/useMcp'
import { useUpsertChatMode, useDeleteChatMode } from '../../hooks/useChatModes'
import { COLOR_PRESETS, getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'

interface ChatModeCardProps {
  mode: ChatModeData
}

export function ChatModeCard({ mode }: ChatModeCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [nameDraft, setNameDraft] = useState(mode.name)

  const { data: providers } = useProviders()
  const { data: allModels } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const upsert = useUpsertChatMode()
  const deleteMutation = useDeleteChatMode()

  const enabledProviders = (providers ?? []).filter((p) => p.enabled && p.hasApiKey)
  const modelsForProvider = (allModels ?? []).filter((m) => m.providerId === mode.providerId)
  const preset = getPreset(mode.colorPreset)
  const mcpIds = new Set(mode.mcpProviderIds ?? [])

  const save = useCallback(
    (patch: Partial<{ name: string; providerId: string | null; modelId: string | null; mcpProviderIds: string[]; colorPreset: string }>) => {
      upsert.mutate({
        id: mode.id,
        name: patch.name ?? mode.name,
        providerId: patch.providerId !== undefined ? patch.providerId : (mode.providerId ?? null),
        modelId: patch.modelId !== undefined ? patch.modelId : (mode.modelId ?? null),
        mcpProviderIds: patch.mcpProviderIds ?? mode.mcpProviderIds ?? [],
        colorPreset: patch.colorPreset ?? mode.colorPreset
      })
    },
    [upsert, mode]
  )

  const toggleMcp = (id: string): void => {
    const next = new Set(mcpIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    save({ mcpProviderIds: Array.from(next) })
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: preset.border }}
        />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-xs">{mode.name}</span>
        </div>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(mode.id) }}
          className="p-1 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
        >
          <Trash2 size={12} />
        </button>

        <div className={`p-1 text-[var(--color-text-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <ChevronDown size={12} />
        </div>
      </div>

      <AnimatedCollapse open={expanded}>
        <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-3">
          {/* Name */}
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Name</label>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => { if (nameDraft.trim() && nameDraft !== mode.name) save({ name: nameDraft.trim() }) }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              className={inputClass}
              placeholder="e.g. Development, Writing, Research..."
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
                  onClick={() => save({ colorPreset: p.id })}
                  className="w-6 h-6 rounded-full flex items-center justify-center transition-transform hover:scale-110"
                  style={{ backgroundColor: p.border }}
                  title={p.name}
                >
                  {mode.colorPreset === p.id && <Check size={12} className="text-white" />}
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
              value={mode.providerId ?? ''}
              onChange={(e) => save({ providerId: e.target.value || null, modelId: null })}
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
          {mode.providerId && (
            <div>
              <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
                Model
              </label>
              <select
                value={mode.modelId ?? ''}
                onChange={(e) => save({ modelId: e.target.value || null })}
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
        </div>
      </AnimatedCollapse>
    </div>
  )
}
