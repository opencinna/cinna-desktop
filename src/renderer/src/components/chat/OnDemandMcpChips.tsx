import { useMemo, useState } from 'react'
import { Plug, X } from 'lucide-react'
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
    return props.pendingIds ?? []
  }, [props.chatId, props.pendingIds, dbOnDemand.data])

  const rows = useMemo(() => {
    const byId = new Map((mcps ?? []).map((m) => [m.id, m]))
    return ids
      .map((id) => {
        const mcp = byId.get(id)
        if (!mcp) return null
        return { id: mcp.id, name: mcp.name, status: mcp.status, error: mcp.error }
      })
      .filter(
        (x): x is { id: string; name: string; status: string; error: string | undefined } =>
          x !== null
      )
  }, [ids, mcps])

  if (rows.length === 0) return null

  const handleRemove = (id: string): void => {
    if (props.chatId) {
      void removeFromChat.mutateAsync({ chatId: props.chatId, mcpProviderId: id })
    } else {
      props.onRemovePending?.(id)
    }
  }

  return (
    <>
      {rows.map((m) => {
        // Fixed MCP color (matches the in-transcript tool badge). Connection
        // health is signalled separately by a red dot — shown only when the
        // tool is offline / errored — so the chip color stays consistent.
        const isConnected = m.status === 'connected'
        const statusDetail = m.error
          ? `${m.name}: ${m.error}`
          : `MCP "${m.name}" is not connected (${m.status}) — its tools won't be callable until it reconnects.`
        return (
          <div
            key={m.id}
            className="flex items-center gap-1 pl-1.5 pr-1 py-1 rounded-lg border
              text-[var(--color-accent)] border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10"
            title={`MCP "${m.name}" engaged for this chat`}
          >
            <Plug size={12} className="shrink-0" />
            <span className="text-[11px] font-medium whitespace-nowrap">{m.name}</span>
            {!isConnected && <McpStatusDot detail={statusDetail} />}
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

/**
 * Red connection-health dot shown after an offline/errored MCP's name. On
 * hover it reveals a small card with the specifics — same hover-card pattern
 * as `CommPatternBadge`, so the detail appears instantly (vs a native title).
 */
function McpStatusDot({ detail }: { detail: string }): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <span
      className="relative ml-0.5 flex items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        className="w-1.5 h-1.5 rounded-full bg-[var(--color-danger)] shrink-0 cursor-help"
        aria-label={detail}
      />
      {hovered && (
        <span
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 w-56 rounded-lg
            border border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl
            shadow-xl px-2.5 py-1.5 text-[11px] font-normal leading-relaxed text-left
            whitespace-normal text-[var(--color-text-secondary)]"
        >
          {detail}
        </span>
      )}
    </span>
  )
}
