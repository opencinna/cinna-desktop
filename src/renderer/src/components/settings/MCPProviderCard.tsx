import { useState } from 'react'
import { Trash2, ChevronDown, Wrench, Circle, Shield } from 'lucide-react'
import { useUpsertMcpProvider, useDeleteMcpProvider, useConnectMcp, useDisconnectMcp } from '../../hooks/useMcp'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'

interface MCPProviderCardProps {
  provider: {
    id: string
    name: string
    transportType: string
    command?: string
    args?: string[]
    url?: string
    env?: Record<string, string>
    enabled: boolean
    hasAuth: boolean
    status: string
    tools: Array<{ name: string; description: string }>
    error?: string
  }
}

export function MCPProviderCard({ provider }: MCPProviderCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState(provider.name)
  const [transportType, setTransportType] = useState(provider.transportType)
  const [command, setCommand] = useState(provider.command ?? '')
  const [args, setArgs] = useState((provider.args ?? []).join(' '))
  const [url, setUrl] = useState(provider.url ?? '')
  const [envStr, setEnvStr] = useState(
    Object.entries(provider.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  )

  const upsert = useUpsertMcpProvider()
  const deleteMcp = useDeleteMcpProvider()
  const connectMcp = useConnectMcp()
  const disconnectMcp = useDisconnectMcp()

  const statusColor =
    provider.status === 'connected'
      ? 'text-[var(--color-success)]'
      : provider.status === 'error'
        ? 'text-[var(--color-danger)]'
        : provider.status === 'awaiting-auth'
          ? 'text-[var(--color-warning)]'
          : 'text-[var(--color-text-muted)]'

  const statusLabel =
    provider.status === 'awaiting-auth'
      ? 'Waiting for authorization...'
      : provider.status === 'error'
        ? provider.error ?? 'Error'
        : undefined

  const handleSave = (): void => {
    const envObj: Record<string, string> = {}
    envStr.split('\n').forEach((line) => {
      const eqIdx = line.indexOf('=')
      if (eqIdx > 0) {
        envObj[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
      }
    })

    upsert.mutate({
      id: provider.id,
      name,
      transportType,
      command: transportType === 'stdio' ? command : undefined,
      args: transportType === 'stdio' ? args.split(/\s+/).filter(Boolean) : undefined,
      url: transportType !== 'stdio' ? url : undefined,
      env: Object.keys(envObj).length > 0 ? envObj : undefined,
      enabled: provider.enabled
    })
  }

  const handleToggle = (): void => {
    upsert.mutate({
      id: provider.id,
      name: provider.name,
      transportType: provider.transportType,
      command: provider.command,
      args: provider.args,
      url: provider.url,
      env: provider.env,
      enabled: !provider.enabled
    })
  }

  const handleReconnect = (): void => {
    connectMcp.mutate(provider.id)
  }

  const handleDisconnect = (): void => {
    disconnectMcp.mutate(provider.id)
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Circle size={6} className={`fill-current ${statusColor}`} />
        <span className="flex-1 font-medium text-xs">{provider.name}</span>

        {provider.hasAuth && (
          <Shield size={12} className="text-[var(--color-accent)]" aria-label="OAuth authenticated" />
        )}

        <button
          onClick={(e) => { e.stopPropagation(); handleToggle() }}
          className={`relative w-9 h-5 rounded-full transition-colors ${
            provider.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
          }`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              provider.enabled ? 'left-[18px]' : 'left-0.5'
            }`}
          />
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); deleteMcp.mutate(provider.id) }}
          className="p-1 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
        >
          <Trash2 size={12} />
        </button>

        <div className={`p-1 text-[var(--color-text-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <ChevronDown size={12} />
        </div>
      </div>

      <AnimatedCollapse open={expanded}>
        <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-2.5">
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </div>

          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Transport</label>
            <select value={transportType} onChange={(e) => setTransportType(e.target.value)} className={inputClass}>
              <option value="stdio">stdio</option>
              <option value="sse">SSE</option>
              <option value="streamable-http">Streamable HTTP</option>
            </select>
          </div>

          {transportType === 'stdio' ? (
            <>
              <div>
                <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Command</label>
                <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="e.g., npx" className={inputClass} />
              </div>
              <div>
                <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Arguments</label>
                <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="space separated" className={inputClass} />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">URL</label>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com" className={inputClass} />
            </div>
          )}

          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Env Vars (KEY=VALUE per line)</label>
            <textarea
              value={envStr}
              onChange={(e) => setEnvStr(e.target.value)}
              rows={2}
              placeholder="API_KEY=xxx"
              className={`${inputClass} resize-none font-mono`}
            />
          </div>

          <div className="flex justify-end gap-2">
            {provider.status === 'connected' ? (
              <button
                onClick={handleDisconnect}
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              >
                Disconnect
              </button>
            ) : provider.status !== 'awaiting-auth' ? (
              <button
                onClick={handleReconnect}
                disabled={connectMcp.isPending}
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
              >
                {connectMcp.isPending ? 'Connecting...' : 'Reconnect'}
              </button>
            ) : null}

            <button
              onClick={handleSave}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors"
            >
              Save
            </button>
          </div>

          {statusLabel && (
            <p className={`text-[10px] ${
              provider.status === 'awaiting-auth' ? 'text-[var(--color-warning)]' : 'text-[var(--color-danger)]'
            }`}>
              {statusLabel}
            </p>
          )}

          {provider.tools.length > 0 && (
            <div>
              <p className="text-[10px] text-[var(--color-text-muted)] mb-1 flex items-center gap-1">
                <Wrench size={10} /> {provider.tools.length} tools
              </p>
              <div className="space-y-0.5">
                {provider.tools.map((tool) => (
                  <div key={tool.name} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-[var(--color-bg)] text-[10px]">
                    <span className="font-mono text-[var(--color-accent)]">{tool.name}</span>
                    <span className="text-[var(--color-text-muted)] truncate">{tool.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}
