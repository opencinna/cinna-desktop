import { useContext } from 'react'
import { ChevronRight } from 'lucide-react'
import { TranscriptVisibleContext, useTranscriptDisclosure } from './transcriptExpansion'

export type CollapsibleStatus = 'pending' | 'done' | 'error'
/**
 * Only tool-ish steps fold into a dots group. Thinking is a standalone block
 * in every mode: folded in, a long agent turn read as one row of dots.
 */
export type CollapsibleKind = 'tool_narration' | 'tool_call' | 'tool_result'

export interface CollapsibleGroupItem {
  key: string
  /** A combined call/result still represents a compact step when alone. */
  groupWhenAlone?: boolean
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
  return 'bg-[var(--color-text-muted)]/50'
}

export function CollapsibleGroup({ items }: CollapsibleGroupProps): React.JSX.Element {
  const [expanded, setExpanded] = useTranscriptDisclosure(false)
  const visible = useContext(TranscriptVisibleContext)

  return (
    <div className="rounded-lg">
      <button
        type="button"
        data-group-header
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${items.length} ${items.length === 1 ? 'step' : 'steps'}`}
        className="inline-flex items-start gap-1.5 px-2 py-1 rounded-md max-w-full
          text-[var(--color-text-muted)]
          hover:text-[var(--color-text-secondary)]
          hover:bg-[var(--color-bg-secondary)]/60
          transition-colors"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        {/* Dots wrap within the transcript width rather than scrolling it
            sideways. The 1.5px vertical padding makes each 8px row as tall as
            the 11px chevron, so the chevron sits level with the first row and
            a single row keeps its old height. */}
        <span className="flex flex-wrap items-center gap-1 min-w-0 py-[1.5px]">
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
            <TranscriptVisibleContext.Provider value={visible && expanded}>
              {items.map((it) => (
                <div key={it.key}>{it.node}</div>
              ))}
            </TranscriptVisibleContext.Provider>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A render slot: either a standalone block (`plain`) or a collapsible block
 * (`collapsible`) that {@link groupConsecutiveCollapsibles} may fold into a
 * dots group. Shared by the main transcript ({@link MessageStream}) and the
 * agent sub-thread ({@link AgentContribution}) so both collapse consecutive
 * auxiliary steps identically.
 */
export type RenderNode =
  | { slot: 'plain'; key: string; node: React.ReactNode }
  | { slot: 'collapsible'; item: CollapsibleGroupItem }

/** Group consecutive auxiliary nodes, plus combined steps that request grouping alone. */
export function groupConsecutiveCollapsibles(nodes: RenderNode[]): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let i = 0
  while (i < nodes.length) {
    const n = nodes[i]
    if (n.slot !== 'collapsible') {
      out.push(<div key={n.key}>{n.node}</div>)
      i++
      continue
    }
    let j = i
    while (j < nodes.length && nodes[j].slot === 'collapsible') j++
    const run = nodes.slice(i, j) as Extract<RenderNode, { slot: 'collapsible' }>[]
    if (run.length >= 2 || run[0].item.groupWhenAlone) {
      out.push(
        <CollapsibleGroup key={`group-${run[0].item.key}`} items={run.map((r) => r.item)} />
      )
    } else {
      out.push(<div key={run[0].item.key}>{run[0].item.node}</div>)
    }
    i = j
  }
  return out
}
