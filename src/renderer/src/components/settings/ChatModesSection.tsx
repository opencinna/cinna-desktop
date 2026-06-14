import { useState } from 'react'
import { Plus } from 'lucide-react'
import { ChatModeCard } from './ChatModeCard'
import { ChatModeForm } from './ChatModeForm'
import { useChatModes } from '../../hooks/useChatModes'

export function ChatModesSection(): React.JSX.Element {
  const { data: modes } = useChatModes()
  const [showAdd, setShowAdd] = useState(false)

  // Account-provisioned (managed) modes live in the Profile group's "Chats"
  // section — keep this Default-scope section to user-created ones.
  const own = (modes ?? []).filter((m) => !m.managed)

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
        Chat modes let you define presets for different workflows — choose an LLM provider, model,
        and MCP tools for each mode, then start new chats in one click.
      </p>

      {own.map((m) => (
        <ChatModeCard key={m.id} mode={m} />
      ))}

      {showAdd ? (
        <ChatModeForm onClose={() => setShowAdd(false)} />
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg
            border border-dashed border-[var(--color-border)] text-[14px]
            text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
            hover:border-[var(--color-text-muted)] transition-colors"
        >
          <Plus size={14} />
          Add Chat Mode
        </button>
      )}
    </div>
  )
}
