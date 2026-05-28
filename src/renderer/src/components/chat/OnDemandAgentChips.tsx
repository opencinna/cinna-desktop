import { useMemo } from 'react'
import { Bot, X } from 'lucide-react'
import { useAgents, useChatOnDemandAgents, useRemoveOnDemandAgent } from '../../hooks/useAgents'
import { presetForAgentId } from '../../utils/agentColors'

type OnDemandAgentChipsProps =
  | { chatId: string; pendingIds?: never; onRemovePending?: never }
  | { chatId?: null; pendingIds: string[]; onRemovePending: (id: string) => void }

/**
 * Renders the on-demand agent set as a strip of removable chips next to the
 * on-demand-MCP chips below the composer. Each chip is an agent the local
 * model calls as an emulated MCP tool in orchestrated mode. Two modes,
 * mirroring [[OnDemandMcpChips]]:
 *
 *  - **Active chat** (`chatId` set): reads `chat_on_demand_agents` via React
 *    Query; removal hits the DB through `chat:on-demand-agent-remove`.
 *  - **New chat** (`pendingIds` set): reads the parent's in-memory buffer;
 *    removal mutates the buffer via `onRemovePending`. `useNewChatFlow`
 *    flushes the buffer onto the chat row after creation.
 */
export function OnDemandAgentChips(
  props: OnDemandAgentChipsProps
): React.JSX.Element | null {
  const { data: agents } = useAgents()
  const dbOnDemand = useChatOnDemandAgents(props.chatId ?? null)
  const removeFromChat = useRemoveOnDemandAgent()

  const ids = useMemo(() => {
    if (props.chatId) return (dbOnDemand.data ?? []).map((r) => r.agentId)
    return props.pendingIds ?? []
  }, [props.chatId, props.pendingIds, dbOnDemand.data])

  const rows = useMemo(() => {
    const byId = new Map((agents ?? []).map((a) => [a.id, a]))
    return ids
      .map((id) => {
        const agent = byId.get(id)
        return agent ? { id: agent.id, name: agent.name } : null
      })
      .filter((x): x is { id: string; name: string } => x !== null)
  }, [ids, agents])

  if (rows.length === 0) return null

  const handleRemove = (id: string): void => {
    if (props.chatId) {
      void removeFromChat.mutateAsync({ chatId: props.chatId, agentId: id })
    } else {
      props.onRemovePending?.(id)
    }
  }

  return (
    <>
      {rows.map((a) => {
        // Per-agent hash color — the same identity color the agent uses in the
        // chat window (sub-thread header, bubbles), so the footer chip and the
        // in-transcript rendering match.
        const color = presetForAgentId(a.id)
        return (
          <div
            key={a.id}
            className="flex items-center gap-1 pl-1.5 pr-1 py-1 rounded-lg border"
            style={{ color: color.border, borderColor: color.border, backgroundColor: color.bg }}
            title={`Agent "${a.name}" attached — the local model will call it as a tool`}
          >
            <Bot size={12} className="shrink-0" />
            <span className="text-[11px] font-medium whitespace-nowrap">{a.name}</span>
            <button
              type="button"
              onClick={() => handleRemove(a.id)}
              className="ml-0.5 p-0.5 rounded hover:bg-black/10 [[data-theme=light]_&]:hover:bg-black/5 transition-colors"
              aria-label={`Remove agent ${a.name}`}
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
    </>
  )
}
