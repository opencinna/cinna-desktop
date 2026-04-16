import { Plus } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { useChatModes } from '../../hooks/useChatModes'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders } from '../../hooks/useMcp'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'

interface ChatConfigMenuProps {
  activeMode: ChatModeData | null
  onSelectMode: (mode: ChatModeData | null) => void
}

export function ChatConfigMenu({
  activeMode,
  onSelectMode
}: ChatConfigMenuProps): React.JSX.Element {
  const { data: chatModes } = useChatModes()
  const { data: allModels } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const [open, setOpen] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const modes = chatModes ?? []

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (modes.length === 0) return <></>

  const handleSelectMode = (mode: ChatModeData): void => {
    onSelectMode(activeMode?.id === mode.id ? null : mode)
    setOpen(false)
  }

  const activeModePreset = activeMode ? getPreset(activeMode.colorPreset) : null

  // Helpers to resolve names
  const modelName = (modelId: string | null): string | null => {
    if (!modelId) return null
    const m = (allModels ?? []).find((m) => m.id === modelId)
    return m?.name ?? modelId
  }

  const mcpNames = (ids: string[]): string[] => {
    if (!ids.length) return []
    const all = mcpProviders ?? []
    return ids.map((id) => all.find((p) => p.id === id)?.name ?? id)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]
          border transition-colors"
        style={{
          borderColor: activeModePreset ? activeModePreset.border : 'var(--color-border)'
        }}
        title={activeMode ? `Mode: ${activeMode.name}` : 'Select chat mode'}
      >
        <Plus size={14} style={activeModePreset ? { color: activeModePreset.border } : undefined} />
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-1 left-0 w-72 bg-[var(--color-bg-secondary)]
            border border-[var(--color-border)] rounded-lg shadow-xl z-50 overflow-hidden"
        >
          <div className="px-2.5 pt-2 pb-1">
            <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
              Chat Modes
            </div>
          </div>

          <div className="px-1.5 pb-1.5 space-y-1 max-h-72 overflow-y-auto">
            {modes.map((mode) => {
              const preset = getPreset(mode.colorPreset)
              const isActive = activeMode?.id === mode.id
              const model = modelName(mode.modelId)
              const mcps = mcpNames(mode.mcpProviderIds ?? [])

              const isHovered = hoveredId === mode.id

              return (
                <button
                  key={mode.id}
                  onClick={() => handleSelectMode(mode)}
                  onMouseEnter={() => setHoveredId(mode.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className="w-full text-left px-2.5 py-2 rounded-md transition-all cursor-pointer"
                  style={{
                    backgroundColor: isActive ? preset.card : isHovered ? preset.bg : 'transparent',
                    borderLeft: isHovered && !isActive ? `2px solid ${preset.border}` : '2px solid transparent',
                    opacity: activeMode && !isActive && !isHovered ? 0.55 : 1
                  }}
                >
                  {/* Mode name with color dot */}
                  <div className="flex items-center gap-1.5">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: preset.border }}
                    />
                    <span
                      className="text-xs font-medium"
                      style={{ color: isActive ? preset.text : 'var(--color-text)' }}
                    >
                      {mode.name}
                    </span>
                  </div>

                  {/* Model + MCP summary */}
                  {(model || mcps.length > 0) && (
                    <div
                      className="mt-0.5 pl-4 text-[10px] leading-snug truncate"
                      style={{ color: isActive ? preset.text : 'var(--color-text-muted)', opacity: isActive ? 0.75 : 1 }}
                    >
                      {model && <span>{model}</span>}
                      {model && mcps.length > 0 && <span> · </span>}
                      {mcps.length > 0 && <span>{mcps.join(', ')}</span>}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
