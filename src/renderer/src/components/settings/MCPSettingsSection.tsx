import { useState } from 'react'
import { Plus, Library, Terminal } from 'lucide-react'
import { MCPProviderCard } from './MCPProviderCard'
import { MCPRegistryPicker } from './MCPRegistryPicker'
import { AddLocalMcpForm } from './AddLocalMcpForm'
import { AddCustomMcpForm } from './AddCustomMcpForm'
import { useMcpProviders } from '../../hooks/useMcp'

type AddPanel = 'registry' | 'custom' | 'local' | null

export function MCPSettingsSection(): React.JSX.Element {
  const { data: mcpProviders } = useMcpProviders()
  const [panel, setPanel] = useState<AddPanel>(null)

  const buttonClass =
    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg ' +
    'border border-dashed border-[var(--color-border)] text-xs ' +
    'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] ' +
    'hover:border-[var(--color-text-muted)] transition-colors'

  return (
    <div className="space-y-3">
      {(mcpProviders ?? []).map((mcp) => (
        <MCPProviderCard key={mcp.id} provider={mcp} />
      ))}

      {panel === 'custom' ? (
        <AddCustomMcpForm onClose={() => setPanel(null)} />
      ) : panel === 'registry' ? (
        <MCPRegistryPicker onClose={() => setPanel(null)} />
      ) : panel === 'local' ? (
        <AddLocalMcpForm onClose={() => setPanel(null)} />
      ) : (
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setPanel('registry')} className={buttonClass}>
            <Library size={14} />
            Add from Registry
          </button>
          <button onClick={() => setPanel('custom')} className={buttonClass}>
            <Plus size={14} />
            Add Custom MCP
          </button>
          <button onClick={() => setPanel('local')} className={buttonClass}>
            <Terminal size={14} />
            Add Local MCP
          </button>
        </div>
      )}
    </div>
  )
}
