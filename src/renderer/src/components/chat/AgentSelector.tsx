import { useState, useRef, useEffect } from 'react'
import { Bot, X } from 'lucide-react'
import { useAgents } from '../../hooks/useAgents'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

interface AgentSelectorProps {
  selectedAgent: AgentData | null
  onSelectAgent: (agent: AgentData | null) => void
  onCollapsed?: () => void
}

export function AgentSelector({
  selectedAgent,
  onSelectAgent,
  onCollapsed
}: AgentSelectorProps): React.JSX.Element {
  const { data: agents } = useAgents()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Track the displayed agent separately so we can animate out before unmounting
  const [displayedAgent, setDisplayedAgent] = useState<AgentData | null>(null)
  const [animState, setAnimState] = useState<'idle' | 'expanding' | 'collapsing'>('idle')

  useEffect(() => {
    if (selectedAgent) {
      // Agent selected — show and expand
      setDisplayedAgent(selectedAgent)
      setAnimState('expanding')
    } else if (displayedAgent) {
      // Agent deselected — start collapsing, keep displayedAgent for the animation
      setAnimState('collapsing')
    }
  }, [selectedAgent]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAnimationEnd = (): void => {
    if (animState === 'collapsing') {
      setDisplayedAgent(null)
      setAnimState('idle')
      onCollapsed?.()
    } else if (animState === 'expanding') {
      setAnimState('idle')
    }
  }

  const enabledAgents = (agents ?? []).filter((a) => a.enabled)

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

  if (enabledAgents.length === 0) return <></>

  const handleSelect = (agent: AgentData): void => {
    onSelectAgent(selectedAgent?.id === agent.id ? null : agent)
    setOpen(false)
  }

  const handleDeselect = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onSelectAgent(null)
  }

  const isExpanded = displayedAgent !== null

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-lg border transition-all duration-300 ease-in-out overflow-hidden ${
          isExpanded
            ? 'pl-1.5 pr-1 py-1 text-[var(--color-accent)] border-[var(--color-accent)] bg-[var(--color-accent)]/10'
            : 'p-1.5 text-[var(--color-text-muted)] border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'
        }`}
        title={selectedAgent ? `Agent: ${selectedAgent.name}` : 'Select agent'}
      >
        <Bot size={14} className="shrink-0" />
        {displayedAgent && (
          <span
            className={`flex items-center gap-1.5 overflow-hidden ${
              animState === 'collapsing'
                ? 'animate-[shrink-out_200ms_ease-in_forwards]'
                : 'animate-[expand-in_200ms_ease-out]'
            }`}
            onAnimationEnd={handleAnimationEnd}
          >
            <span className="text-[11px] font-medium whitespace-nowrap">
              {displayedAgent.name}
            </span>
            <span
              role="button"
              tabIndex={-1}
              onClick={handleDeselect}
              className="shrink-0 p-0.5 rounded hover:bg-[var(--color-accent)]/20 transition-colors"
            >
              <X size={10} />
            </span>
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-1 left-0 w-72 bg-[var(--color-bg-secondary)]
            border border-[var(--color-border)] rounded-lg shadow-xl z-50 overflow-hidden"
        >
          <div className="px-2.5 pt-2 pb-1">
            <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
              Agents
            </div>
          </div>

          <div className="px-1.5 pb-1.5 space-y-0.5 max-h-72 overflow-y-auto">
            {enabledAgents.map((agent) => {
              const isActive = selectedAgent?.id === agent.id

              return (
                <button
                  key={agent.id}
                  onClick={() => handleSelect(agent)}
                  className={`w-full text-left px-2.5 py-2 rounded-md transition-all cursor-pointer ${
                    isActive
                      ? 'bg-[var(--color-accent)]/10 border-l-2 border-[var(--color-accent)]'
                      : 'hover:bg-[var(--color-bg-hover)] border-l-2 border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Bot size={12} className={isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'} />
                    <span className={`text-xs font-medium ${isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
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
      )}
    </div>
  )
}
