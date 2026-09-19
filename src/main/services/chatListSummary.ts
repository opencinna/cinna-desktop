import { agentRepo, type AgentRow } from '../db/agents'
import { chatRepo, type ChatRow } from '../db/chats'
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
  chats: ChatRow[]
): Map<string, ChatListSummary> {
  const out = new Map<string, ChatListSummary>()
  if (chats.length === 0) return out

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

  const stats = new Map(chatRepo.listMessageStats(profileUserId).map((row) => [row.chatId, row]))
  const participants = new Map<string, string[]>()
  const note = (chatId: string, agentId: string | null): void => {
    if (!agentId) return
    const ids = participants.get(chatId) ?? []
    if (!ids.includes(agentId)) ids.push(agentId)
    participants.set(chatId, ids)
  }
  // Attached agents first, in the order they were attached: that order is what
  // decides the primary of a `human` chat with nothing bound.
  for (const row of chatRepo.listOnDemandAgentIds(profileUserId)) note(row.chatId, row.agentId)
  for (const row of chatRepo.listMessageAgentIds(profileUserId)) {
    note(row.chatId, row.sourceAgentId)
    note(row.chatId, row.toolAgentId)
  }

  const modes = new Map<string, ReturnType<typeof chatModeService.findMerged>>()
  const modeOf = (id: string): ReturnType<typeof chatModeService.findMerged> => {
    if (!modes.has(id)) modes.set(id, chatModeService.findMerged(id))
    return modes.get(id) ?? null
  }

  for (const chat of chats) {
    const ids = participants.get(chat.id) ?? []
    let primary = realAgent(chat.agentId)
    if (!primary && !chat.agentId && chat.router === 'human') {
      primary = ids.map(realAgent).find((row) => row !== null) ?? null
    }

    let who: ChatListSummary['with']
    if (primary) {
      const acpTransport = acpTransportOf(primary)
      who = {
        kind: 'agent', name: primary.name, color: null, agentId: primary.id,
        // What `AgentTypeIcon` reads, derived as the agent DTO derives it.
        source: primary.source, driver: primary.driver, protocol: primary.protocol,
        ...(acpTransport ? { acpTransport } : {})
      }
    } else {
      // No fallback to the default mode: the chat page resolves a chat's mode
      // from its own `modeId` and shows none when that is null, and the row
      // must not name a mode the page it opens does not.
      const mode = chat.modeId ? modeOf(chat.modeId) : null
      // Neither: the model is the only thing left that tells this chat from
      // the next, and an empty name tells the tooltip to show no first line.
      who = mode
        ? { kind: 'mode', name: mode.name, color: mode.colorPreset }
        : { kind: 'none', name: chat.modelId ?? '', color: null }
    }

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
