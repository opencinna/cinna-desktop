import { useMemo } from 'react'
import { useAgents, useChatOnDemandAgents, useRemoveOnDemandAgent } from '../../hooks/useAgents'
import { presetForAgentId } from '../../utils/agentColors'
import { canConduct } from '../../../../shared/chatRouting'
import { ACCENT_CHIP, AgentChip, type ChipCoordinatorAction } from './AgentChip'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

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

/** "Set as Coordinator" on the chips: who conducts now, and what holds the change back. */
export interface ChipCoordinatorMenu {
  /** The current conductor; its chip offers no "Set as Coordinator". Null when nobody conducts yet. */
  conductorId: string | null
  /** Why no chip can take the role right now (a turn runs); null when one can. */
  blockedReason: string | null
  /** Rejects with a user-readable reason, which the chip's menu shows in place. */
  onSet: (agentId: string) => unknown
}

/** The disabled reason for an agent that cannot conduct at all. */
export const CANNOT_CONDUCT_REASON = 'Only a local agent can coordinate'

type OnDemandAgentChipsProps = (
  | { chatId: string; pendingIds?: never; onRemovePending?: never }
  | { chatId?: null; pendingIds: string[]; onRemovePending: (id: string) => void }
) & {
  addressing?: ChipAddressing
  /** New chat that will be coordinated: who conducts, a null id being the hidden Default runtime. */
  coordination?: { conductorId: string | null; conductorName: string }
  coordinatorMenu?: ChipCoordinatorMenu
}

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

  // The new chat's chosen conductor leads the row, where the chat's bound chip
  // will stand after the first send: the chips do not reorder when it is sent.
  const leadId = props.coordination?.conductorId ?? null
  const rows = useMemo(() => {
    const byId = new Map((agents ?? []).map((a) => [a.id, a]))
    const found = ids
      .map((id) => byId.get(id) ?? null)
      .filter((x): x is AgentData => x !== null)
    const lead = found.filter((a) => a.id === leadId)
    return [...lead, ...found.filter((a) => a.id !== leadId)]
  }, [ids, agents, leadId])

  if (rows.length === 0) return null

  const handleRemove = (id: string): void => {
    if (props.chatId) {
      void removeFromChat.mutateAsync({ chatId: props.chatId, agentId: id })
    } else {
      props.onRemovePending?.(id)
    }
  }

  const menuFor = props.coordinatorMenu
  const coordinatorAction = (agent: AgentData): ChipCoordinatorAction | undefined =>
    menuFor && agent.id !== menuFor.conductorId
      ? {
          disabledReason: !canConduct(agent) ? CANNOT_CONDUCT_REASON : menuFor.blockedReason,
          onSet: () => menuFor.onSet(agent.id)
        }
      : undefined

  return (
    <>
      {props.coordination && !props.coordination.conductorId && (
        // The hidden runtime: no page, no folder, nothing to hand the role to.
        <AgentChip
          name={props.coordination.conductorName}
          colors={ACCENT_CHIP}
          coordinator
          label={`${props.coordination.conductorName} — Coordinator`}
        />
      )}
      {rows.map((a) => {
        const coordinator = props.coordination?.conductorId === a.id
        const addressed = props.addressing?.addressedId === a.id
        const label = props.addressing
          ? addressed
            ? `Agent “${a.name}” answers your next message`
            : `Address your next message to “${a.name}”`
          : props.coordination ? `${a.name} — ${coordinator ? 'Coordinator' : 'Participant'}` : `Agent "${a.name}" attached as a participant`
        return (
          <AgentChip
            key={a.id}
            name={a.name}
            // Per-agent hash color — the same identity color the agent uses in
            // the chat window (sub-thread header, bubbles), so the footer chip
            // and the in-transcript rendering match.
            colors={presetForAgentId(a.id)}
            coordinator={coordinator}
            addressed={addressed}
            label={label}
            onAddress={props.addressing ? () => props.addressing?.onAddress(a.id) : undefined}
            onRemove={() => handleRemove(a.id)}
            menu={{ agent: a, setCoordinator: coordinatorAction(a) }}
          />
        )
      })}
    </>
  )
}
