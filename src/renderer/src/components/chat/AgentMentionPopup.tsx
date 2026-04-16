import { useEffect, useRef } from 'react'
import { Bot } from 'lucide-react'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

interface AgentMentionPopupProps {
  agents: AgentData[]
  filter: string
  selectedIndex: number
  onSelect: (agent: AgentData) => void
  onClose: () => void
}

export function AgentMentionPopup({
  agents,
  filter,
  selectedIndex,
  onSelect,
  onClose
}: AgentMentionPopupProps): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const filtered = agents.filter(
    (a) =>
      a.name.toLowerCase().includes(filter.toLowerCase()) ||
      a.protocol.toLowerCase().includes(filter.toLowerCase())
  )

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Scroll active item into view
  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (filtered.length === 0) return null

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-1 left-0 w-72 bg-[var(--color-bg-secondary)]
        border border-[var(--color-border)] rounded-lg shadow-xl z-50 overflow-hidden"
    >
      <div className="px-2.5 pt-2 pb-1">
        <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
          Agents
        </div>
      </div>

      <div className="px-1.5 pb-1.5 space-y-0.5 max-h-72 overflow-y-auto">
        {filtered.map((agent, i) => {
          const isActive = i === selectedIndex

          return (
            <button
              key={agent.id}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              onClick={() => onSelect(agent)}
              className={`w-full text-left px-2.5 py-2 rounded-md transition-all cursor-pointer ${
                isActive
                  ? 'bg-[var(--color-accent)]/10 border-l-2 border-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-bg-hover)] border-l-2 border-transparent'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Bot
                  size={12}
                  className={
                    isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
                  }
                />
                <span
                  className={`text-xs font-medium ${isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}
                >
                  {agent.name}
                </span>
                <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">
                  {agent.protocol.toUpperCase()}
                </span>
              </div>
              {agent.description && (
                <div className="mt-0.5 pl-[18px] text-[10px] text-[var(--color-text-muted)] truncate">
                  {agent.description}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
