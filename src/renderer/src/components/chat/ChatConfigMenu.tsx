import { Plus } from 'lucide-react'
import { useState, useRef } from 'react'
import { useChatModes } from '../../hooks/useChatModes'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders } from '../../hooks/useMcp'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'
import { MentionPopup } from './MentionPopup'

interface ChatConfigMenuProps {
  activeMode: ChatModeData | null
  onSelectMode: (mode: ChatModeData | null) => void
  /** Controlled open state — when set, the parent owns open/close (used by the `~` shortcut). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ChatConfigMenu({
  activeMode,
  onSelectMode,
  open: openProp,
  onOpenChange
}: ChatConfigMenuProps): React.JSX.Element {
  const { data: chatModes } = useChatModes()
  const { data: allModels } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : internalOpen
  const setOpen = (next: boolean): void => {
    if (isControlled) onOpenChange?.(next)
    else setInternalOpen(next)
  }
  const triggerRef = useRef<HTMLButtonElement>(null)

  const modes = chatModes ?? []

  if (modes.length === 0) return <></>

  const handleSelectMode = (mode: ChatModeData): void => {
    onSelectMode(activeMode?.id === mode.id ? null : mode)
    setOpen(false)
  }

  const activeModePreset = activeMode ? getPreset(activeMode.colorPreset) : null

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

  const composeSecondary = (mode: ChatModeData): string | null => {
    const model = modelName(mode.modelId)
    const mcps = mcpNames(mode.mcpProviderIds ?? [])
    if (!model && !mcps.length) return null
    return [model, mcps.length ? mcps.join(', ') : null].filter(Boolean).join(' · ')
  }

  // selectedIndex tracks the active mode so the popup highlights it. -1 when
  // no mode is active (nothing visually selected, all rows are inactive).
  const selectedIndex = activeMode ? modes.findIndex((m) => m.id === activeMode.id) : -1

  return (
    <div className="relative">
      <button
        ref={triggerRef}
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
        <MentionPopup<ChatModeData>
          items={modes}
          selectedIndex={selectedIndex}
          onSelect={handleSelectMode}
          onClose={() => setOpen(false)}
          listboxId="chat-modes-listbox"
          anchorRef={triggerRef}
          header="Chat Modes"
          ariaLabel="Chat modes"
          width="w-72"
          renderIcon={(mode) => (
            <div
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: getPreset(mode.colorPreset).border }}
            />
          )}
          getKey={(mode) => mode.id}
          getPrimary={(mode) => mode.name}
          getSecondary={composeSecondary}
        />
      )}
    </div>
  )
}
