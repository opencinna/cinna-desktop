import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

export type CollapsibleStatus = 'pending' | 'done' | 'error'
export type CollapsibleKind = 'thinking' | 'tool_narration' | 'tool_call' | 'tool_result'

export interface CollapsibleGroupItem {
  key: string
  kind: CollapsibleKind
  status?: CollapsibleStatus
  isLive?: boolean
  node: React.ReactNode
}

interface CollapsibleGroupProps {
  items: CollapsibleGroupItem[]
}

function dotClass(item: CollapsibleGroupItem): string {
  if (item.status === 'pending') return 'bg-[var(--color-warning)]/45'
  if (item.status === 'error') return 'bg-[var(--color-danger)]/45'
  if (item.status === 'done') return 'bg-[var(--color-success)]/45'
  if (item.kind === 'thinking') return 'bg-[var(--color-accent)]/40'
  return 'bg-[var(--color-text-muted)]/50'
}

export function CollapsibleGroup({ items }: CollapsibleGroupProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-lg">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${items.length} steps`}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md
          text-[var(--color-text-muted)]
          hover:text-[var(--color-text-secondary)]
          hover:bg-[var(--color-bg-secondary)]/60
          transition-colors"
      >
        <ChevronRight
          size={11}
          className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="flex items-center gap-1">
          {items.map((it) => {
            const animate = it.status === 'pending' || it.isLive
            return (
              <span key={it.key} className="relative inline-flex w-2 h-2">
                {animate && (
                  <span
                    className={`absolute inset-0 rounded-full opacity-60 animate-ping ${dotClass(it)}`}
                  />
                )}
                <span className={`relative inline-block w-2 h-2 rounded-full ${dotClass(it)}`} />
              </span>
            )
          })}
        </span>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
        aria-hidden={!expanded}
      >
        <div className="overflow-hidden">
          <div
            className={`space-y-2 mt-1.5 transition-opacity duration-200 ${
              expanded ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {items.map((it) => (
              <div key={it.key}>{it.node}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
