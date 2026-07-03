import { useState } from 'react'
import { useUpsertMcpProvider } from '../../hooks/useMcp'

const inputClass =
  'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

type AuthType = 'oauth' | 'bearer'

export function AddCustomMcpForm({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [authType, setAuthType] = useState<AuthType>('oauth')
  const [bearerToken, setBearerToken] = useState('')
  const upsertMcp = useUpsertMcpProvider()

  const needsToken = authType === 'bearer'
  const canConnect = !!(name.trim() && url.trim() && (!needsToken || bearerToken.trim()))

  const handleConnect = (): void => {
    if (!canConnect) return
    upsertMcp.mutate(
      {
        name: name.trim(),
        transportType: 'streamable-http',
        url: url.trim(),
        enabled: true,
        authType,
        bearerToken: needsToken ? bearerToken.trim() : undefined
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
      <div>
        <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">
          Authentication
        </label>
        <div className="flex gap-1 rounded-md border border-[var(--color-border)] p-0.5">
          {(['oauth', 'bearer'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setAuthType(t)}
              className={`flex-1 px-2 py-1 rounded text-[13px] font-medium transition-colors ${
                authType === t
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              }`}
            >
              {t === 'oauth' ? 'OAuth' : 'Bearer Token'}
            </button>
          ))}
        </div>
      </div>
      {needsToken ? (
        <div>
          <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">
            Bearer Token
          </label>
          <input
            type="password"
            value={bearerToken}
            onChange={(e) => setBearerToken(e.target.value)}
            placeholder="Paste the server's access token"
            className={inputClass}
          />
        </div>
      ) : (
        <p className="text-[12px] text-[var(--color-text-muted)]">
          If the server requires authentication, you will be redirected to authorize in your
          browser.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-md text-[14px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleConnect}
          disabled={!canConnect || upsertMcp.isPending}
          className="px-3 py-1.5 rounded-md text-[14px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
        >
          {upsertMcp.isPending ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
