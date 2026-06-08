import { useCallback, useMemo } from 'react'
import {
  useChatOnDemandAgents,
  useAttachAgentToChat,
  useRemoveOnDemandAgent
} from './useAgents'
import {
  useChatOnDemandMcps,
  useAddOnDemandMcp,
  useRemoveOnDemandMcp
} from './useMcp'
import type { AgentPickerItem } from '../components/agents/AgentPickerModal'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]
type McpData = Awaited<ReturnType<typeof window.api.mcp.list>>[number]

interface UseCapabilityPickerArgs {
  chatId: string | null
  /** Settings-enabled agents — the owner already filters these. */
  enabledAgents: AgentData[]
  /** Settings-enabled MCPs — the owner already filters these. */
  enabledMcps: McpData[]
  /** The chat's bound root agent (active chat only); shown selected + locked. */
  boundAgent: AgentData | null
  /** New-chat pending buffers (owned by MainArea). Ignored when `chatId` is set. */
  pendingAgentIds?: string[]
  pendingMcpIds?: string[]
  onTogglePendingAgent?: (agentId: string) => void
  onTogglePendingMcp?: (mcpProviderId: string) => void
}

export interface CapabilityPicker {
  /** Agent + MCP cards for the picker modal. */
  items: AgentPickerItem[]
  /** Currently-engaged ids (drives the card checkmarks). */
  selectedIds: Set<string>
  /** Engage / detach a capability by id. */
  toggle: (id: string) => void
  hasCapabilities: boolean
}

/**
 * Backs the `[+]` "Add agents / MCP" capability picker. Builds the agent+MCP
 * cards, the current selection set, and a `toggle` that mirrors the
 * `@`-mention routing exactly:
 *
 *  - **New chat**: picks buffer in the parent's pending lists (flushed onto the
 *    chat row at creation by `useNewChatFlow`).
 *  - **Active chat**: picks hit the on-demand DB tables — adding an agent
 *    promotes the chat to orchestrated; the bound root agent stays selected and
 *    non-removable from the composer (same as `@`).
 *
 * Lives in a hook so the routing rules stay testable and out of the composer
 * view. Uses its own on-demand mutation instances (React Query dedupes the
 * underlying queries/invalidations), independent of the `@`-popup path.
 */
export function useCapabilityPicker({
  chatId,
  enabledAgents,
  enabledMcps,
  boundAgent,
  pendingAgentIds,
  pendingMcpIds,
  onTogglePendingAgent,
  onTogglePendingMcp
}: UseCapabilityPickerArgs): CapabilityPicker {
  const addOnDemandMcp = useAddOnDemandMcp()
  const removeOnDemandMcp = useRemoveOnDemandMcp()
  const removeOnDemandAgent = useRemoveOnDemandAgent()
  const attachAgent = useAttachAgentToChat(chatId)
  const onDemandAgents = useChatOnDemandAgents(chatId)
  const onDemandMcps = useChatOnDemandMcps(chatId)

  const mcpIdSet = useMemo(() => new Set(enabledMcps.map((m) => m.id)), [enabledMcps])

  const items = useMemo<AgentPickerItem[]>(() => {
    const agentCards: AgentPickerItem[] = enabledAgents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      meta: a.protocol.toUpperCase(),
      group: 'Agents',
      iconKind: 'agent'
    }))
    const mcpCards: AgentPickerItem[] = enabledMcps.map((m) => ({
      id: m.id,
      name: m.name,
      description: null,
      meta: 'MCP',
      group: 'Connectors',
      iconKind: 'connector'
    }))
    return [...agentCards, ...mcpCards]
  }, [enabledAgents, enabledMcps])

  const onDemandAgentIds = useMemo(
    () => (onDemandAgents.data ?? []).map((r) => r.agentId),
    [onDemandAgents.data]
  )
  const onDemandMcpIds = useMemo(
    () => (onDemandMcps.data ?? []).map((r) => r.mcpProviderId),
    [onDemandMcps.data]
  )

  const selectedIds = useMemo(() => {
    if (chatId) {
      const ids = [...onDemandAgentIds, ...onDemandMcpIds]
      if (boundAgent) ids.push(boundAgent.id)
      return new Set(ids)
    }
    return new Set([...(pendingAgentIds ?? []), ...(pendingMcpIds ?? [])])
  }, [chatId, onDemandAgentIds, onDemandMcpIds, boundAgent, pendingAgentIds, pendingMcpIds])

  const toggle = useCallback(
    (id: string): void => {
      const isMcp = mcpIdSet.has(id)
      if (chatId) {
        if (isMcp) {
          if (onDemandMcpIds.includes(id)) {
            void removeOnDemandMcp.mutateAsync({ chatId, mcpProviderId: id })
          } else {
            void addOnDemandMcp.mutateAsync({ chatId, mcpProviderId: id })
          }
          return
        }
        if (onDemandAgentIds.includes(id)) {
          void removeOnDemandAgent.mutateAsync({ chatId, agentId: id })
        } else if (boundAgent?.id !== id) {
          // The bound root agent stays selected and non-removable — same as `@`.
          void attachAgent(id)
        }
        return
      }
      // New chat — both pending toggles add-or-remove.
      if (isMcp) onTogglePendingMcp?.(id)
      else onTogglePendingAgent?.(id)
    },
    [
      chatId,
      mcpIdSet,
      onDemandMcpIds,
      onDemandAgentIds,
      boundAgent,
      removeOnDemandMcp,
      addOnDemandMcp,
      removeOnDemandAgent,
      attachAgent,
      onTogglePendingMcp,
      onTogglePendingAgent
    ]
  )

  return { items, selectedIds, toggle, hasCapabilities: items.length > 0 }
}
