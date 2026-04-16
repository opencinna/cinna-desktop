import { useState } from 'react'
import { Plus } from 'lucide-react'
import { AgentCard } from './AgentCard'
import { A2AAgentForm } from './A2AAgentForm'
import { useAgents } from '../../hooks/useAgents'

export function AgentsSettingsSection(): React.JSX.Element {
  const { data: agents } = useAgents()
  const [showAdd, setShowAdd] = useState(false)

  const a2aAgents = (agents ?? []).filter((a) => a.protocol === 'a2a')

  return (
    <div className="space-y-4">
      {/* A2A Agents section */}
      <div>
        <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
          A2A Agents
        </h2>
        <div className="space-y-3">
          {a2aAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}

          {showAdd ? (
            <A2AAgentForm onClose={() => setShowAdd(false)} />
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg
                border border-dashed border-[var(--color-border)] text-xs
                text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
                hover:border-[var(--color-text-muted)] transition-colors"
            >
              <Plus size={14} />
              Add A2A Agent
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
