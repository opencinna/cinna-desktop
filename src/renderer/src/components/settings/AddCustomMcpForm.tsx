import { useState } from 'react'
import { useUpsertMcpProvider } from '../../hooks/useMcp'

const inputClass =
  'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

export function AddCustomMcpForm({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const upsertMcp = useUpsertMcpProvider()

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
      <p className="text-[14px] font-medium">Add Custom MCP Server</p>
      <div>
        <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., My MCP Server"
          className={inputClass}
          autoFocus
        />
      </div>
      <div>
        <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.example.com"
          className={inputClass}
        />
      </div>
      <p className="text-[12px] text-[var(--color-text-muted)]">
        If the server requires authentication, you will be redirected to authorize in your browser.
      </p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-md text-[14px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleConnect}
          disabled={!name.trim() || !url.trim() || upsertMcp.isPending}
          className="px-3 py-1.5 rounded-md text-[14px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
        >
          {upsertMcp.isPending ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
