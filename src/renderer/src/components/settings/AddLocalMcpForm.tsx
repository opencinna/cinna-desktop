import { useState } from 'react'
import { useUpsertMcpProvider } from '../../hooks/useMcp'
import { parseEnvVars } from '../../utils/envVars'

const inputClass =
  'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

export function AddLocalMcpForm({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsStr, setArgsStr] = useState('')
  const [envStr, setEnvStr] = useState('')
  const upsertMcp = useUpsertMcpProvider()

  const handleConnect = (): void => {
    if (!name.trim() || !command.trim()) return
    const envObj = parseEnvVars(envStr)
    upsertMcp.mutate(
      {
        name: name.trim(),
        transportType: 'stdio',
        command: command.trim(),
        args: argsStr.split(/\s+/).filter(Boolean),
        env: Object.keys(envObj).length > 0 ? envObj : undefined,
        enabled: true
      },
      { onSuccess: () => onClose() }
    )
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-2.5">
      <p className="text-[14px] font-medium">Add Local MCP Server</p>
      <div>
        <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Filesystem"
          className={inputClass}
          autoFocus
        />
      </div>
      <div>
        <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Command</label>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="e.g., npx"
          className={inputClass}
        />
      </div>
      <div>
        <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Arguments</label>
        <input
          value={argsStr}
          onChange={(e) => setArgsStr(e.target.value)}
          placeholder="space separated, e.g., -y @modelcontextprotocol/server-filesystem /tmp"
          className={inputClass}
        />
        <p className="text-[12px] text-[var(--color-text-muted)] mt-0.5">
          Split on whitespace — quoting isn&apos;t supported, so paths with spaces won&apos;t work.
        </p>
      </div>
      <div>
        <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Env Vars (KEY=VALUE per line)</label>
        <textarea
          value={envStr}
          onChange={(e) => setEnvStr(e.target.value)}
          rows={2}
          placeholder="API_KEY=xxx"
          className={`${inputClass} resize-none font-mono`}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-md text-[14px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleConnect}
          disabled={!name.trim() || !command.trim() || upsertMcp.isPending}
          className="px-3 py-1.5 rounded-md text-[14px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
        >
          {upsertMcp.isPending ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
