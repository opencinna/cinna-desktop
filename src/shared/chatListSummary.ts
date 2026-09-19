/**
 * What the sidebar's chat-row tooltip shows. Resolved in main, because the
 * renderer cannot tell a hidden chat-owned runtime from a real agent, and read
 * whole through `chat:list-summaries` (keyed by chat id) rather than on the
 * polled `chat:list` rows: building it scans the messages table. A row shows no
 * tooltip until its summary is there, so the tooltip always opens complete —
 * content arriving in an open tooltip would move it under the pointer.
 */
export interface ChatListSummary {
  /**
   * Who the chat is with. `agent` = a real bound or addressed agent; `mode` = a
   * chat mode (a plain chat); `none` = neither resolvable, in which case `name`
   * is the chat's model id, or empty when it has none — the tooltip then shows
   * no first line at all.
   *
   * `color` is a chat mode's colour preset id, and null otherwise: an agent's
   * line leads with its type icon, not a colour.
   *
   * `source`, `driver`, `protocol` and `acpTransport` are an agent's type as the
   * agent DTO carries it — what `AgentTypeIcon` draws from. Agents only.
   */
  with: {
    kind: 'agent' | 'mode' | 'none'
    name: string
    color: string | null
    agentId?: string
    source?: string
    driver?: string | null
    protocol?: string
    acpTransport?: 'stdio' | 'websocket'
  }
  /** Names of the other agents that took part: primary excluded, deduped, stable order. */
  others: string[]
  firstMessageAt: Date | null
  lastMessageAt: Date | null
  /** `user` and `assistant` rows only. */
  messageCount: number
}
