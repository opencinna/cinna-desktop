import { useState } from 'react'
import { Plus, Library, Terminal } from 'lucide-react'
import { MCPProviderCard } from './MCPProviderCard'
import { MCPRegistryPicker } from './MCPRegistryPicker'
import { AddLocalMcpForm } from './AddLocalMcpForm'
import { AddCustomMcpForm } from './AddCustomMcpForm'
import { useMcpProviders } from '../../hooks/useMcp'
import { useAddonPolicy } from '../../hooks/useAddonDirectory'
import { DEFAULT_ADDON_POLICY } from '../../../../shared/addons/directory'

type AddPanel = 'registry' | 'custom' | 'local' | null

export const MCP_SETTINGS_TEXT = {
  adminOff: 'Turned off by your admin'
} as const

export function MCPSettingsSection(): React.JSX.Element {
  const { data: mcpProviders } = useMcpProviders()
  // Main refuses what the admin turns off; these only stop offering it. Until the read answers, the defaults (everything offered).
  const policy = useAddonPolicy().data ?? DEFAULT_ADDON_POLICY
  const [openPanel, setPanel] = useState<AddPanel>(null)
  const allowed: Record<Exclude<AddPanel, null>, boolean> = {
    // Every registry the picker searches is a public one (`mcp-registry:*`).
    registry: policy.externalDirectories,
    custom: policy.customMcp,
    // A local server is the user's own command: it needs both.
    local: policy.customMcp && policy.stdioMcp
  }
  const panel = openPanel !== null && allowed[openPanel] ? openPanel : null

  const buttonClass =
    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg ' +
    'border border-dashed border-[var(--color-border)] text-[14px] ' +
    'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] ' +
    'hover:border-[var(--color-text-muted)] transition-colors'
  const options: Array<{ id: Exclude<AddPanel, null>; icon: React.JSX.Element; label: string }> = [
    { id: 'registry', icon: <Library size={14} />, label: 'Add from Registry' },
    { id: 'custom', icon: <Plus size={14} />, label: 'Add Custom MCP' },
    { id: 'local', icon: <Terminal size={14} />, label: 'Add Local MCP' }
  ]
  // A hidden option leaves the row; the policy is said once, in a muted line under it.
  const off = options.filter((option) => !allowed[option.id])

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
        <div className="space-y-1.5">
          {off.length < options.length && (
            <div className="flex gap-2 flex-wrap">
              {options
                .filter((option) => allowed[option.id])
                .map((option) => (
                  <button key={option.id} onClick={() => setPanel(option.id)} className={buttonClass}>
                    {option.icon}
                    {option.label}
                  </button>
                ))}
            </div>
          )}
          {off.length > 0 && (
            <p className="text-[12px] text-[var(--color-text-muted)]" data-testid="mcp-add-off">
              {MCP_SETTINGS_TEXT.adminOff}:{' '}
              {off.map((option, index) => (
                <span key={option.id} data-testid={`mcp-add-${option.id}-off`}>
                  {index > 0 ? ', ' : ''}
                  {option.label}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
