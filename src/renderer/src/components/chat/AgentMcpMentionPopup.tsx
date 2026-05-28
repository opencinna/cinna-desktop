import { useEffect, useRef, type RefObject } from 'react'
import { Bot, Plug } from 'lucide-react'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]
type McpData = Awaited<ReturnType<typeof window.api.mcp.list>>[number]

export type AgentMcpItem =
  | { kind: 'agent'; agent: AgentData }
  | { kind: 'mcp'; mcp: McpData }

interface AgentMcpMentionPopupProps {
  /** Already-filtered agents — owner does the filtering. */
  agents: AgentData[]
  /** Already-filtered MCPs. Hidden when empty (popup may still render agents). */
  mcps: McpData[]
  /**
   * Unified selection index across the flattened list (agents then MCPs).
   * The owner mirrors this against the same ordering used here.
   */
  selectedIndex: number
  onSelect: (item: AgentMcpItem) => void
  onClose: () => void
  listboxId: string
  /** Textarea that owns the popup — clicks inside it are treated as "inside". */
  anchorRef?: RefObject<HTMLElement | null>
}

// Same surface/accent treatment as MentionPopup. Inlined rather than reused
// because this popup renders TWO subgroups, which doesn't fit the single-list
// shape of the shared primitive.
const CONTAINER_CLS =
  'absolute bottom-full mb-1 left-0 ' +
  'bg-[var(--color-accent)]/10 [[data-theme=light]_&]:bg-[var(--color-accent)]/4 ' +
  'backdrop-blur-xl ' +
  'border border-[var(--color-accent)]/25 [[data-theme=light]_&]:border-[var(--color-accent)]/12 ' +
  'rounded-lg shadow-xl z-50 overflow-hidden'

const ACTIVE_BG =
  'bg-gradient-to-r from-[var(--color-accent)]/65 to-[var(--color-accent)]/40 ' +
  '[[data-theme=light]_&]:from-[var(--color-accent)]/40 [[data-theme=light]_&]:to-[var(--color-accent)]/22'
const ACTIVE_TEXT = 'text-[var(--color-on-accent)]'
const ACTIVE_TEXT_70 = 'text-[var(--color-on-accent)]/70'
const ACTIVE_TEXT_80 = 'text-[var(--color-on-accent)]/80'

export function AgentMcpMentionPopup({
  agents,
  mcps,
  selectedIndex,
  onSelect,
  onClose,
  listboxId,
  anchorRef
}: AgentMcpMentionPopupProps): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (anchorRef?.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const totalCount = agents.length + mcps.length
  if (totalCount === 0) return null

  // Renders an option row. Rows live inside `role="group"` containers so
  // screen readers (and ARIA's strict listbox→option child requirement)
  // never see the section heading masquerading as a list item.
  const renderRow = (
    flatIndex: number,
    Icon: typeof Bot,
    primary: string,
    secondary: string | undefined,
    meta: string | undefined,
    onClick: () => void
  ): React.JSX.Element => {
    const isActive = flatIndex === selectedIndex
    const optionId = `${listboxId}-opt-${flatIndex}`
    return (
      <button
        key={optionId}
        id={optionId}
        role="option"
        aria-selected={isActive}
        type="button"
        ref={(el) => {
          itemRefs.current[flatIndex] = el
        }}
        onClick={onClick}
        className={`w-full text-left px-2.5 py-2 rounded-md transition-all cursor-pointer ${
          isActive ? `${ACTIVE_BG} ${ACTIVE_TEXT}` : 'hover:bg-[var(--color-bg-hover)]'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <Icon
            size={12}
            className={isActive ? ACTIVE_TEXT : 'text-[var(--color-text-muted)]'}
          />
          <span
            className={`text-xs font-medium ${isActive ? ACTIVE_TEXT : 'text-[var(--color-text)]'}`}
          >
            {primary}
          </span>
          {meta && (
            <span
              className={`text-[10px] ml-auto ${isActive ? ACTIVE_TEXT_70 : 'text-[var(--color-text-muted)]'}`}
            >
              {meta}
            </span>
          )}
        </div>
        {secondary && (
          <div
            className={`mt-0.5 pl-[18px] text-[10px] truncate ${isActive ? ACTIVE_TEXT_80 : 'text-[var(--color-text-muted)]'}`}
          >
            {secondary}
          </div>
        )}
      </button>
    )
  }

  const agentsHeadingId = `${listboxId}-agents-heading`
  const mcpHeadingId = `${listboxId}-mcp-heading`
  const headingCls =
    'px-1 pt-2 pb-1 text-[10px] font-semibold text-[var(--color-text-muted)] ' +
    'uppercase tracking-wider'

  return (
    <div ref={ref} className={`w-72 ${CONTAINER_CLS}`}>
      <div
        id={listboxId}
        role="listbox"
        aria-label="Agents and MCP servers"
        className="px-1.5 pb-1.5 max-h-72 overflow-y-auto"
      >
        {agents.length > 0 && (
          <div role="group" aria-labelledby={agentsHeadingId} className="space-y-0.5">
            <div id={agentsHeadingId} className={headingCls}>
              Agents
            </div>
            {agents.map((a, i) =>
              renderRow(
                i,
                Bot,
                a.name,
                a.description ?? undefined,
                a.protocol.toUpperCase(),
                () => onSelect({ kind: 'agent', agent: a })
              )
            )}
          </div>
        )}

        {mcps.length > 0 && (
          <div role="group" aria-labelledby={mcpHeadingId} className="space-y-0.5">
            <div id={mcpHeadingId} className={headingCls}>
              MCP
            </div>
            {mcps.map((m, i) => {
              const flatIndex = agents.length + i
              const toolCount = m.tools?.length ?? 0
              const status = m.status
              const secondary =
                status === 'connected'
                  ? `${toolCount} tool${toolCount === 1 ? '' : 's'}`
                  : status === 'awaiting-auth'
                    ? 'authorizing…'
                    : status === 'error'
                      ? 'connection error'
                      : 'disconnected'
              return renderRow(
                flatIndex,
                Plug,
                m.name,
                secondary,
                m.transportType,
                () => onSelect({ kind: 'mcp', mcp: m })
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
