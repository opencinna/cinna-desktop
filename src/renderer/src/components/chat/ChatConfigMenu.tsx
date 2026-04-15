import { Plus, Check, ChevronRight } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { useProviders } from '../../hooks/useProviders'
import { useMcpProviders } from '../../hooks/useMcp'

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini'
}

interface ChatConfigMenuProps {
  selectedProviderId: string | null
  onSelectProvider: (providerId: string) => void
  activeMcpIds: Set<string>
  onToggleMcp: (mcpId: string) => void
}

export function ChatConfigMenu({
  selectedProviderId,
  onSelectProvider,
  activeMcpIds,
  onToggleMcp
}: ChatConfigMenuProps): React.JSX.Element {
  const { data: providers } = useProviders()
  const { data: mcpProviders } = useMcpProviders()
  const [open, setOpen] = useState(false)
  const [expandedSection, setExpandedSection] = useState<'llm' | 'mcp' | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const enabledProviders = (providers ?? []).filter((p) => p.enabled && p.hasApiKey)
  const enabledMcpProviders = (mcpProviders ?? []).filter((p) => p.enabled)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setExpandedSection(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const hasAnything = enabledProviders.length > 0 || enabledMcpProviders.length > 0
  if (!hasAnything) return <></>

  const toggleSection = (section: 'llm' | 'mcp'): void => {
    setExpandedSection((prev) => (prev === section ? null : section))
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          setOpen(!open)
          if (open) setExpandedSection(null)
        }}
        className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]
          border border-[var(--color-border)] transition-colors"
        title="Configure providers"
      >
        <Plus size={14} />
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-1 left-0 w-60 bg-[var(--color-bg-secondary)]
            border border-[var(--color-border)] rounded-lg shadow-xl z-50 overflow-hidden"
        >
          {/* LLM Providers section */}
          {enabledProviders.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('llm')}
                className="w-full flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-semibold
                  text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <ChevronRight
                  size={12}
                  className={`transition-transform ${expandedSection === 'llm' ? 'rotate-90' : ''}`}
                />
                LLM Providers
                {selectedProviderId && (
                  <span className="ml-auto text-[10px] font-normal text-[var(--color-text-muted)] truncate max-w-[100px]">
                    {enabledProviders.find((p) => p.id === selectedProviderId)?.name}
                  </span>
                )}
              </button>

              {expandedSection === 'llm' && (
                <div className="border-t border-[var(--color-border)]">
                  {enabledProviders.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => onSelectProvider(p.id)}
                      className="w-full text-left pl-7 pr-2.5 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]
                        transition-colors flex items-center gap-2"
                    >
                      <div
                        className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                          selectedProviderId === p.id
                            ? 'border-[var(--color-accent)]'
                            : 'border-[var(--color-border)]'
                        }`}
                      >
                        {selectedProviderId === p.id && (
                          <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
                        )}
                      </div>
                      <span
                        className={`font-medium ${
                          selectedProviderId === p.id
                            ? 'text-[var(--color-accent)]'
                            : 'text-[var(--color-text)]'
                        }`}
                      >
                        {p.name}
                      </span>
                      <span className="text-[var(--color-text-muted)] text-[10px]">
                        {PROVIDER_LABELS[p.type] ?? p.type}
                      </span>
                      {p.isDefault && (
                        <span className="ml-auto text-[10px] text-[var(--color-warning)]">default</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MCP Providers section */}
          {enabledMcpProviders.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('mcp')}
                className={`w-full flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-semibold
                  text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors
                  ${enabledProviders.length > 0 ? 'border-t border-[var(--color-border)]' : ''}`}
              >
                <ChevronRight
                  size={12}
                  className={`transition-transform ${expandedSection === 'mcp' ? 'rotate-90' : ''}`}
                />
                MCP Providers
                {activeMcpIds.size > 0 && (
                  <span className="ml-auto text-[10px] font-normal text-[var(--color-text-muted)]">
                    {activeMcpIds.size} active
                  </span>
                )}
              </button>

              {expandedSection === 'mcp' && (
                <div className="border-t border-[var(--color-border)]">
                  {enabledMcpProviders.map((mcp) => (
                    <button
                      key={mcp.id}
                      onClick={() => onToggleMcp(mcp.id)}
                      className="w-full text-left pl-7 pr-2.5 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]
                        transition-colors flex items-center gap-2"
                    >
                      <div
                        className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                          activeMcpIds.has(mcp.id)
                            ? 'bg-[var(--color-accent)] border-[var(--color-accent)]'
                            : 'border-[var(--color-border)]'
                        }`}
                      >
                        {activeMcpIds.has(mcp.id) && <Check size={9} className="text-white" />}
                      </div>
                      <span
                        className={`font-medium ${
                          activeMcpIds.has(mcp.id)
                            ? 'text-[var(--color-accent)]'
                            : 'text-[var(--color-text)]'
                        }`}
                      >
                        {mcp.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
