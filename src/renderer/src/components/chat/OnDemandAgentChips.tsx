import { useMemo } from 'react'
import { Bot, X } from 'lucide-react'
import { useAgents, useChatOnDemandAgents, useRemoveOnDemandAgent } from '../../hooks/useAgents'
import { presetForAgentId } from '../../utils/agentColors'

/**
 * Turns the chips into the chat's address book: clicking one says who the next
 * message is for. Supplied only in a `human`-routed chat, where that is a
 * decision the user makes; absent everywhere else, where the chips are only a
 * list of what is attached.
 */
export interface ChipAddressing {
  /** The agent the next message is addressed to. */
  addressedId: string | null
  onAddress: (agentId: string) => void
}

/**
 * The width range of a chip under the composer (agent and MCP chips alike).
 * At most 12rem, a longer name truncated and whole in its `title`; when the
 * row is short of room the chips shrink, down to 4.5rem — the icon, a few
 * characters and the remove button — and past that the chip strip scrolls
 * (`ChatInput`). The composer's chip row never wraps.
 */
export const agentChipClass = 'shrink min-w-[4.5rem] max-w-[12rem]'

type OnDemandAgentChipsProps = (
  | { chatId: string; pendingIds?: never; onRemovePending?: never }
  | { chatId?: null; pendingIds: string[]; onRemovePending: (id: string) => void }
) & { addressing?: ChipAddressing }

/**
 * Renders the attached agent set as a strip of removable chips next to the
 * on-demand-MCP chips below the composer. What a chip *is* depends on the
 * chat's router: an agent the local model calls as a tool (`coordinator`), or
 * one of the counterparties the user addresses by clicking it (`human`, via
 * {@link ChipAddressing}). Two data modes, mirroring [[ActiveMcpChips]]:
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
        const addressed = props.addressing?.addressedId === a.id
        const label = props.addressing
          ? addressed
            ? `Agent “${a.name}” answers your next message`
            : `Address your next message to “${a.name}”`
          : `Agent "${a.name}" attached — the local model will call it as a tool`
        return (
          <div
            key={a.id}
            // A ring, not a border or a weight change: the addressed chip has to
            // read differently without occupying a different amount of space, or
            // every chip beside it would slide when the user picks another one.
            //
            // **The ring is the foreground colour, not the agent's.** Two agents
            // can hash to the same preset — measured, twice in one screen — and
            // a ring in the chip's own colour then reads as nothing but a
            // slightly thicker border. The theme's text colour is the one colour
            // guaranteed to contrast with every chip.
            className={`flex items-center gap-1 pl-1.5 pr-1 py-1 rounded-lg border ${agentChipClass} transition-shadow${
              addressed ? ' ring-2 ring-[var(--color-text)]' : ''
            }`}
            style={{
              color: color.border,
              borderColor: color.border,
              backgroundColor: color.bg
            }}
            title={label}
          >
            {props.addressing ? (
              <button
                type="button"
                onClick={() => props.addressing?.onAddress(a.id)}
                aria-pressed={addressed}
                aria-label={label}
                // `cursor-pointer` explicitly: preflight gives every `button` a
                // default cursor, so a chip that is a control looked exactly as
                // inert as one that is not.
                className="flex items-center gap-1 min-w-0 rounded cursor-pointer
                  hover:bg-black/10 [[data-theme=light]_&]:hover:bg-black/5 transition-colors"
              >
                <Bot size={12} className="shrink-0" />
                <span className="min-w-0 truncate text-[11px] font-medium whitespace-nowrap" title={a.name}>{a.name}</span>
              </button>
            ) : (
              <>
                <Bot size={12} className="shrink-0" />
                <span className="min-w-0 truncate text-[11px] font-medium whitespace-nowrap" title={a.name}>{a.name}</span>
              </>
            )}
            <button
              type="button"
              onClick={() => handleRemove(a.id)}
              className="shrink-0 ml-0.5 p-0.5 rounded hover:bg-black/10 [[data-theme=light]_&]:hover:bg-black/5 transition-colors"
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
