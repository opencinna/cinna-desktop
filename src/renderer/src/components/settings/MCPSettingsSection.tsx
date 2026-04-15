import { useState } from 'react'
import { Plus } from 'lucide-react'
import { MCPProviderCard } from './MCPProviderCard'
import { useMcpProviders, useUpsertMcpProvider } from '../../hooks/useMcp'

function AddRemoteMcpForm({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const upsertMcp = useUpsertMcpProvider()

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  const handleConnect = (): void => {
    if (!name.trim() || !url.trim()) return
    upsertMcp.mutate(
      {
        name: name.trim(),
        transportType: 'streamable-http',
        url: url.trim(),
        enabled: true
      },
      { onSuccess: () => onClose() }
    )
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-2.5">
      <p className="text-xs font-medium">Add Remote MCP Server</p>
      <div>
        <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., My MCP Server"
          className={inputClass}
          autoFocus
        />
      </div>
      <div>
        <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.example.com"
          className={inputClass}
        />
      </div>
      <p className="text-[10px] text-[var(--color-text-muted)]">
        If the server requires authentication, you will be redirected to authorize in your browser.
      </p>
      <div className="flex gap-2">
        <button
          onClick={handleConnect}
          disabled={!name.trim() || !url.trim() || upsertMcp.isPending}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
        >
          {upsertMcp.isPending ? 'Connecting...' : 'Connect'}
        </button>
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export function MCPSettingsSection(): React.JSX.Element {
  const { data: mcpProviders } = useMcpProviders()
  const upsertMcp = useUpsertMcpProvider()
  const [showAddRemoteMcp, setShowAddRemoteMcp] = useState(false)

  const handleAddLocalMcp = (): void => {
    upsertMcp.mutate({
      name: 'New MCP Server',
      transportType: 'stdio',
      enabled: false
    })
  }

  return (
    <div className="space-y-3">
      {(mcpProviders ?? []).map((mcp) => (
        <MCPProviderCard key={mcp.id} provider={mcp} />
      ))}

      {showAddRemoteMcp ? (
        <AddRemoteMcpForm onClose={() => setShowAddRemoteMcp(false)} />
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => setShowAddRemoteMcp(true)}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg
              border border-dashed border-[var(--color-border)] text-xs
              text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
              hover:border-[var(--color-text-muted)] transition-colors"
          >
            <Plus size={14} />
            Add Remote MCP
          </button>
          <button
            onClick={handleAddLocalMcp}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg
              border border-dashed border-[var(--color-border)] text-xs
              text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
              hover:border-[var(--color-text-muted)] transition-colors"
          >
            <Plus size={14} />
            Add Local MCP
          </button>
        </div>
      )}
    </div>
  )
}
