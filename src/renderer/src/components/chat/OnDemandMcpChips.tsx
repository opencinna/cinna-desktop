import { useMemo } from 'react'
import { Wrench, X } from 'lucide-react'
import {
  useChatOnDemandMcps,
  useMcpProviders,
  useRemoveOnDemandMcp
} from '../../hooks/useMcp'

type OnDemandMcpChipsProps =
  | { chatId: string; pendingIds?: never; onRemovePending?: never }
  | { chatId?: null; pendingIds: string[]; onRemovePending: (id: string) => void }

/**
 * Renders the user-engaged MCP set as a strip of removable chips next to the
 * active-agent chip below the composer. Two modes:
 *
 *  - **Active chat** (`chatId` set): reads `chat_on_demand_mcps` via React
 *    Query; removal hits the DB through `chat:on-demand-mcp-remove`.
 *  - **New chat** (`pendingIds` set): reads the parent's in-memory buffer;
 *    removal mutates the buffer via `onRemovePending`. `useNewChatFlow`
 *    flushes the buffer onto the chat row after creation.
 */
export function OnDemandMcpChips(
  props: OnDemandMcpChipsProps
): React.JSX.Element | null {
  const { data: mcps } = useMcpProviders()
  const dbOnDemand = useChatOnDemandMcps(props.chatId ?? null)
  const removeFromChat = useRemoveOnDemandMcp()

  const ids = useMemo(() => {
    if (props.chatId) return (dbOnDemand.data ?? []).map((r) => r.mcpProviderId)
    return props.pendingIds
  }, [props.chatId, props.pendingIds, dbOnDemand.data])

  const rows = useMemo(() => {
    const byId = new Map((mcps ?? []).map((m) => [m.id, m]))
    return ids
      .map((id) => {
        const mcp = byId.get(id)
        if (!mcp) return null
        return { id: mcp.id, name: mcp.name, status: mcp.status }
      })
      .filter((x): x is { id: string; name: string; status: string } => x !== null)
  }, [ids, mcps])

  if (rows.length === 0) return null

  const handleRemove = (id: string): void => {
    if (props.chatId) {
      void removeFromChat.mutateAsync({ chatId: props.chatId, mcpProviderId: id })
    } else {
      props.onRemovePending(id)
    }
  }

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
              onClick={() => handleRemove(m.id)}
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
