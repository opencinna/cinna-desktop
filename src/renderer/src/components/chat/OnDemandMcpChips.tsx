import { useMemo } from 'react'
import { Wrench, X } from 'lucide-react'
import {
  useChatOnDemandMcps,
  useMcpProviders,
  useRemoveOnDemandMcp
} from '../../hooks/useMcp'

interface OnDemandMcpChipsProps {
  chatId: string
}

/**
 * Renders the user-engaged MCP set for a chat as a strip of removable chips
 * next to the active-agent chip below the composer. Reads directly from the
 * caches rather than taking props so the strip stays in sync no matter which
 * path mutated the on-demand set (popup pick, follow-up @-mention, dedupe).
 */
export function OnDemandMcpChips({ chatId }: OnDemandMcpChipsProps): React.JSX.Element | null {
  const { data: onDemand } = useChatOnDemandMcps(chatId)
  const { data: mcps } = useMcpProviders()
  const remove = useRemoveOnDemandMcp()

  const rows = useMemo(() => {
    const byId = new Map((mcps ?? []).map((m) => [m.id, m]))
    return (onDemand ?? [])
      .map((r) => {
        const mcp = byId.get(r.mcpProviderId)
        if (!mcp) return null
        return { id: mcp.id, name: mcp.name, status: mcp.status }
      })
      .filter((x): x is { id: string; name: string; status: string } => x !== null)
  }, [onDemand, mcps])

  if (rows.length === 0) return null

  return (
    <>
      {rows.map((m) => {
        const isConnected = m.status === 'connected'
        // Keep the warning subtle — `awaiting-auth` / `error` mean the user
        // still sees their engagement, but the chip surfaces that the tool
        // won't actually be callable yet.
        const tone = isConnected
          ? 'text-[var(--color-success)] border-[var(--color-success)]/40 bg-[var(--color-success)]/10'
          : 'text-[var(--color-warning)] border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10'
        return (
          <div
            key={m.id}
            className={`flex items-center gap-1 pl-1.5 pr-1 py-1 rounded-lg border ${tone}`}
            title={
              isConnected
                ? `MCP "${m.name}" engaged for this chat`
                : `MCP "${m.name}" engaged but not connected (${m.status})`
            }
          >
            <Wrench size={12} className="shrink-0" />
            <span className="text-[11px] font-medium whitespace-nowrap">{m.name}</span>
            <button
              type="button"
              onClick={() =>
                void remove.mutateAsync({ chatId, mcpProviderId: m.id })
              }
              className="ml-0.5 p-0.5 rounded hover:bg-black/10 [[data-theme=light]_&]:hover:bg-black/5 transition-colors"
              aria-label={`Remove MCP ${m.name} from this chat`}
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
    </>
  )
}
