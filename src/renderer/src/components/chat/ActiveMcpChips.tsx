import { useMemo, useState } from 'react'
import { Plug, X } from 'lucide-react'
import {
  useChatOnDemandMcps,
  useMcpProviders,
  useRemoveOnDemandMcp
} from '../../hooks/useMcp'

type ActiveMcpChipsProps = {
  /**
   * Mode-owned baseline MCPs (`chat_mcp_providers`, or the selected mode's
   * list before the chat exists), resolved by the composer. Rendered first and
   * **locked** — the chat mode owns them, so they carry no `×`. Empty whenever
   * `ChatControls` is on screen, since its toggle pills already show the
   * baseline and would duplicate these chips.
   */
  baselineIds: string[]
} & (
  | { chatId: string; pendingIds?: never; onRemovePending?: never }
  | { chatId?: null; pendingIds: string[]; onRemovePending: (id: string) => void }
)

/**
 * Renders the MCP servers actually active for a chat as a strip of chips next
 * to the active-agent chip below the composer — the mode-owned baseline plus
 * the user's own engagements, exactly the union `chatStreamingService` hands
 * to the LLM. Two modes for the on-demand half:
 *
 *  - **Active chat** (`chatId` set): reads `chat_on_demand_mcps` via React
 *    Query; removal hits the DB through `chat:on-demand-mcp-remove`.
 *  - **New chat** (`pendingIds` set): reads the parent's in-memory buffer;
 *    removal mutates the buffer via `onRemovePending`. `useNewChatFlow`
 *    flushes the buffer onto the chat row after creation.
 *
 * A server present in both sets is drawn once, locked — detaching the
 * on-demand row wouldn't remove it from the chat, so offering an `×` would
 * lie.
 */
export function ActiveMcpChips(props: ActiveMcpChipsProps): React.JSX.Element | null {
  const { data: mcps } = useMcpProviders()
  const dbOnDemand = useChatOnDemandMcps(props.chatId ?? null)
  const removeFromChat = useRemoveOnDemandMcp()

  const onDemandIds = useMemo(() => {
    if (props.chatId) return (dbOnDemand.data ?? []).map((r) => r.mcpProviderId)
    return props.pendingIds ?? []
  }, [props.chatId, props.pendingIds, dbOnDemand.data])

  const rows = useMemo(() => {
    const byId = new Map((mcps ?? []).map((m) => [m.id, m]))
    const locked = new Set(props.baselineIds)
    const seen = new Set<string>()
    const out: Array<{
      id: string
      name: string
      status: string
      error: string | undefined
      locked: boolean
    }> = []
    for (const id of [...props.baselineIds, ...onDemandIds]) {
      if (seen.has(id)) continue
      seen.add(id)
      const mcp = byId.get(id)
      // Unknown id — a provider deleted from settings while still referenced
      // by the chat mode or an on-demand row. Nothing to name, so skip it.
      if (!mcp) continue
      out.push({
        id: mcp.id,
        name: mcp.name,
        status: mcp.status,
        error: mcp.error,
        locked: locked.has(id)
      })
    }
    return out
  }, [props.baselineIds, onDemandIds, mcps])

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
            className={`flex items-center gap-1 pl-1.5 py-1 rounded-lg border
              text-[var(--color-accent)] border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10
              ${m.locked ? 'pr-2' : 'pr-1'}`}
            title={
              m.locked
                ? `MCP "${m.name}" comes with this chat mode — change it in Settings → Chats`
                : `MCP "${m.name}" engaged for this chat`
            }
          >
            <Plug size={12} className="shrink-0" />
            <span className="text-[11px] font-medium whitespace-nowrap">{m.name}</span>
            {!isConnected && <McpStatusDot detail={statusDetail} />}
            {!m.locked && (
              <button
                type="button"
                onClick={() => handleRemove(m.id)}
                className="ml-0.5 p-0.5 rounded hover:bg-black/10 [[data-theme=light]_&]:hover:bg-black/5 transition-colors"
                aria-label={`Remove MCP ${m.name} from this chat`}
              >
                <X size={11} />
              </button>
            )}
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
