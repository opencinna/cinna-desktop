import { useState, useMemo } from 'react'
import { ChevronDown } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders, useChatMcpProviders, useSetChatMcpProviders } from '../../hooks/useMcp'
import { useUpdateChat, useChatDetail } from '../../hooks/useChat'

interface ChatControlsProps {
  chatId: string
  inline?: boolean
}

export function ChatControls({ chatId }: ChatControlsProps): React.JSX.Element {
  const { data: models } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const { data: chatData } = useChatDetail(chatId)
  const { data: chatMcpLinks } = useChatMcpProviders(chatId)
  const setChatMcp = useSetChatMcpProviders()
  const updateChat = useUpdateChat()
  const [showModelPicker, setShowModelPicker] = useState(false)

  const activeMcpIds = useMemo(
    () => new Set((chatMcpLinks ?? []).map((l) => l.mcpProviderId)),
    [chatMcpLinks]
  )

  const selectedModel = models?.find(
    (m) => m.id === chatData?.modelId && m.providerId === chatData?.providerId
  )

  const handleSelectModel = (modelId: string, providerId: string): void => {
    updateChat.mutate({ chatId, updates: { modelId, providerId } })
    setShowModelPicker(false)
  }

  const toggleMcp = (mcpId: string): void => {
    const next = new Set(activeMcpIds)
    if (next.has(mcpId)) {
      next.delete(mcpId)
    } else {
      next.add(mcpId)
    }
    setChatMcp.mutate({ chatId, mcpProviderIds: Array.from(next) })
  }

  const modelsByProvider = (models ?? []).reduce(
    (acc, m) => {
      const key = m.providerType
      if (!acc[key]) acc[key] = []
      acc[key].push(m)
      return acc
    },
    {} as Record<string, typeof models>
  )

  const enabledMcpProviders = (mcpProviders ?? []).filter((p) => p.enabled)

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* Model selector */}
      <div className="relative">
        <button
          onClick={() => setShowModelPicker(!showModelPicker)}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
            hover:bg-[var(--color-bg-hover)]
            text-[var(--color-text-muted)] border border-[var(--color-border)]
            transition-colors"
        >
          {selectedModel ? selectedModel.name : 'Model'}
          <ChevronDown size={10} />
        </button>

        {showModelPicker && (
          <div className="absolute bottom-full mb-1 left-0 w-56 max-h-72 overflow-y-auto
            bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl z-50">
            {Object.entries(modelsByProvider).map(([providerType, providerModels]) => (
              <div key={providerType}>
                <div className="px-2.5 py-1 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider bg-[var(--color-bg)]">
                  {providerType}
                </div>
                {providerModels!.map((m) => (
                  <button
                    key={`${m.providerId}-${m.id}`}
                    onClick={() => handleSelectModel(m.id, m.providerId)}
                    className={`w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-bg-hover)] transition-colors ${
                      selectedModel?.id === m.id && selectedModel?.providerId === m.providerId
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--color-text)]'
                    }`}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            ))}
            {(!models || models.length === 0) && (
              <div className="px-2.5 py-3 text-xs text-[var(--color-text-muted)] text-center">
                No models. Add a provider in Settings.
              </div>
            )}
          </div>
        )}
      </div>

      {/* MCP toggles */}
      {enabledMcpProviders.map((mcp) => (
        <button
          key={mcp.id}
          onClick={() => toggleMcp(mcp.id)}
          className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
            activeMcpIds.has(mcp.id)
              ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)] border-[var(--color-accent)]/30'
              : 'text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-text-muted)]'
          }`}
        >
          {mcp.name}
        </button>
      ))}
    </div>
  )
}
