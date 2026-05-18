import { Bot, RotateCcw } from 'lucide-react'

type AgentLike = { id: string; name: string }

interface ActiveAgentChipProps {
  activeAgent: AgentLike
  rootAgent: AgentLike | null
  rootLabel: string
  onSwitchBack: (rootId: string | null) => void
}

/**
 * Below-the-textarea routing chip: shows the active agent the next message
 * routes to, plus an inline "Switch back to <root>" button when the active
 * agent isn't the chat's bound root. Pure props in.
 */
export function ActiveAgentChip({
  activeAgent,
  rootAgent,
  rootLabel,
  onSwitchBack
}: ActiveAgentChipProps): React.JSX.Element {
  // In LLM chats (no root agent), any non-null active agent is non-root and
  // qualifies for switch-back. Otherwise compare id-wise.
  const showSwitchBack = rootAgent ? activeAgent.id !== rootAgent.id : true
  const switchBackTarget = rootAgent?.id ?? null

  return (
    <>
      <div
        className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg border
          text-[var(--color-accent)] border-[var(--color-accent)] bg-[var(--color-accent)]/10"
      >
        <Bot size={14} className="shrink-0" />
        <span className="text-[11px] font-medium whitespace-nowrap">
          {activeAgent.name}
        </span>
      </div>
      {showSwitchBack && (
        <button
          type="button"
          onClick={() => onSwitchBack(switchBackTarget)}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px]
            text-[var(--color-text-muted)] hover:text-[var(--color-text)]
            hover:bg-[var(--color-bg-hover)] transition-colors whitespace-nowrap"
        >
          <RotateCcw size={11} className="shrink-0" />
          <span>Switch back to {rootLabel}</span>
        </button>
      )}
    </>
  )
}
