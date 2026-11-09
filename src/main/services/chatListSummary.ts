import { agentRepo, type AgentRow } from '../db/agents'
import { chatRepo, type ChatOwners, type ChatRow } from '../db/chats'
import { chatModeService } from './chatModeService'
import { isChatConductor } from './chatConductorService'
import { acpTransportOf } from './agentTypeFields'
import type { ChatListSummary } from '../../shared/chatListSummary'

/**
 * Who each listed chat is with, and the few facts that tell two similar chats
 * apart. Built in main because only main can tell a hidden chat-owned runtime
 * (a conductor) from an agent the user chose: a conductor-bound chat is a plain
 * chat, and must name its chat mode, never the runtime row behind it.
 *
 * A fixed number of reads whatever the list length: three grouped queries over
 * the listed chats, one agent list per scope, one lookup per distinct mode.
 */
export function buildChatListSummaries(
  settingsUserId: string,
  profileUserId: string,
  chats: ChatRow[],
  /** Whose listed chats `chats` are: the profile, or every owner it sees. */
  owners: ChatOwners = profileUserId
): Map<string, ChatListSummary> {
  const out = new Map<string, ChatListSummary>()
  if (chats.length === 0) return out
  const { realAgent, whoOf } = whoResolver(settingsUserId, profileUserId)
  const stats = new Map(chatRepo.listMessageStats(owners).map((row) => [row.chatId, row]))
  const participants = listParticipants(owners)

  for (const chat of chats) {
    const ids = participants.get(chat.id) ?? []
    const { who, primary } = whoOf(chat, ids)

    const others: string[] = []
    for (const id of ids) {
      const row = realAgent(id)
      if (row && row.id !== primary?.id && !others.includes(row.name)) others.push(row.name)
    }

    const stat = stats.get(chat.id)
    out.set(chat.id, {
      with: who,
      others,
      firstMessageAt: stat?.firstAt ?? null,
      lastMessageAt: stat?.lastAt ?? null,
      messageCount: stat?.messageCount ?? 0
    })
  }
  return out
}

/**
 * Who each listed chat is with, alone: what `with` in
 * {@link buildChatListSummaries} says, without its message stats. All-chats
 * search filters by it; the messages are read for participants only when a
 * `human` chat with nothing bound needs them to find its primary.
 */
export function buildChatWhos(
  settingsUserId: string,
  profileUserId: string,
  chats: ChatRow[],
  owners: ChatOwners = profileUserId
): Map<string, ChatListSummary['with']> {
  const out = new Map<string, ChatListSummary['with']>()
  if (chats.length === 0) return out
  const { whoOf } = whoResolver(settingsUserId, profileUserId)
  const participants = chats.some((chat) => !chat.agentId && chat.router === 'human') ? listParticipants(owners) : null
  for (const chat of chats) out.set(chat.id, whoOf(chat, participants?.get(chat.id) ?? []).who)
  return out
}

/**
 * The agents each chat has heard from: attached ones first, in the order they
 * were attached (that order decides the primary of a `human` chat with nothing
 * bound), then those that wrote or were called in its messages.
 */
function listParticipants(owners: ChatOwners): Map<string, string[]> {
  const participants = new Map<string, string[]>()
  const note = (chatId: string, agentId: string | null): void => {
    if (!agentId) return
    const ids = participants.get(chatId) ?? []
    if (!ids.includes(agentId)) ids.push(agentId)
    participants.set(chatId, ids)
  }
  for (const row of chatRepo.listOnDemandAgentIds(owners)) note(row.chatId, row.agentId)
  for (const row of chatRepo.listMessageAgentIds(owners)) {
    note(row.chatId, row.sourceAgentId)
    note(row.chatId, row.toolAgentId)
  }
  return participants
}

/** Who a chat is with, from the agents of both scopes and the chat modes, read once per call. */
function whoResolver(settingsUserId: string, profileUserId: string): {
  realAgent: (id: string | null | undefined) => AgentRow | null
  whoOf: (chat: ChatRow, participantIds: readonly string[]) => { who: ChatListSummary['with']; primary: AgentRow | null }
} {
  // Hand-added and folder agents live in the default scope, remote agents and
  // conductors in the profile's — the same two scopes `agentService` lists.
  const agents = new Map<string, AgentRow>()
  for (const scope of new Set([settingsUserId, profileUserId])) {
    for (const row of agentRepo.list(scope)) if (!agents.has(row.id)) agents.set(row.id, row)
  }
  /** A real agent: still exists, and is not a chat's hidden runtime. */
  const realAgent = (id: string | null | undefined): AgentRow | null => {
    const row = id ? agents.get(id) : undefined
    return row && !isChatConductor(row) ? row : null
  }
  const modes = new Map<string, ReturnType<typeof chatModeService.findMerged>>()
  const modeOf = (id: string): ReturnType<typeof chatModeService.findMerged> => {
    if (!modes.has(id)) modes.set(id, chatModeService.findMerged(id))
    return modes.get(id) ?? null
  }
  const whoOf = (chat: ChatRow, ids: readonly string[]): { who: ChatListSummary['with']; primary: AgentRow | null } => {
    let primary = realAgent(chat.agentId)
    if (!primary && !chat.agentId && chat.router === 'human') {
      primary = ids.map(realAgent).find((row) => row !== null) ?? null
    }
    if (primary) {
      const acpTransport = acpTransportOf(primary)
      return {
        primary,
        who: {
          kind: 'agent', name: primary.name, color: null, agentId: primary.id,
          // What `AgentTypeIcon` reads, derived as the agent DTO derives it.
          source: primary.source, driver: primary.driver, protocol: primary.protocol,
          ...(acpTransport ? { acpTransport } : {})
        }
      }
    }
    // No fallback to the default mode: the chat page resolves a chat's mode
    // from its own `modeId` and shows none when that is null, and the row
    // must not name a mode the page it opens does not.
    const mode = chat.modeId ? modeOf(chat.modeId) : null
    // Neither: the model is the only thing left that tells this chat from
    // the next, and an empty name tells the tooltip to show no first line.
    return {
      primary: null,
      who: mode
        ? { kind: 'mode', name: mode.name, color: mode.colorPreset, modeId: mode.id }
        : { kind: 'none', name: chat.modelId ?? '', color: null }
    }
  }
  return { realAgent, whoOf }
}
