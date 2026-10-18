import { visibleChat } from '../auth/chatScope'
import { publishEvent } from '../host/events'
import { activeRunsByChat, onRunClosed, onRunOpened } from './runExecutionState'
import { onTaskRunnerWorkingChanged, taskRunnersByChat } from './taskRunnerState'
import { AGENT_SESSIONS_CHANGED_CHANNEL, type AgentActiveSession } from '../../shared/agentSessions'

/**
 * The agents working in a session right now, whoever started the turn: a
 * typed message, a task (dispatched or not), a schedule. Hub core: reads the
 * process-local turn ownership maps, no window and no Electron.
 *
 * Sessions on one agent run side by side; the dispatcher does not wait for
 * them. The surfaces that start one more read {@link activeAgentSessions} and
 * only warn.
 */

/** When each main-owned turn took its chat, by chat id: the "most recent" session. */
const openedAt = new Map<string, number>()

/** A chat held now, with the agent answering in it (null for the local model) and the chat row the profile sees. */
interface HeldChat {
  chatId: string
  agentId: string | null
  chat: ReturnType<typeof visibleChat>
}

/**
 * Every chat a turn holds now: a main-owned run, or a task runner working in
 * it. The agent is the run's own once it resolved, else the chat's bound one.
 */
function heldChats(profileUserId: string): HeldChat[] {
  const chats = new Set<string>([...activeRunsByChat.keys()])
  for (const [chatId, runner] of taskRunnersByChat) if (runner.working) chats.add(chatId)
  const held: HeldChat[] = []
  for (const chatId of chats) {
    const chat = visibleChat(profileUserId, chatId)
    held.push({ chatId, agentId: activeRunsByChat.get(chatId)?.agentId ?? chat?.agentId ?? null, chat })
  }
  return held
}

/** The agents of every turn running now, whoever started it (one entry per chat). */
export function liveAgentIds(profileUserId: string): string[] {
  return heldChats(profileUserId).flatMap((held) => held.agentId ? [held.agentId] : [])
}

function titleOf(title: string | null | undefined): string | null {
  const trimmed = title?.trim()
  return trimmed && trimmed !== 'New Chat' ? trimmed : null
}

/**
 * The profile's running sessions on an agent, newest first: only chats this
 * profile sees, and only turns an agent answers (the local model has none).
 */
export function activeAgentSessions(profileUserId: string): AgentActiveSession[] {
  const sessions: AgentActiveSession[] = []
  for (const held of heldChats(profileUserId)) {
    if (!held.agentId || !held.chat || held.chat.deletedAt) continue
    const startedAt = openedAt.get(held.chatId)
    sessions.push({
      agentId: held.agentId,
      chatId: held.chatId,
      title: titleOf(held.chat.title),
      ...(startedAt !== undefined ? { startedAt } : {})
    })
  }
  return sessions.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

onRunOpened((chatId) => {
  openedAt.set(chatId, Date.now())
  publishEvent(AGENT_SESSIONS_CHANGED_CHANNEL, { chatId })
})
onRunClosed((chatId) => {
  openedAt.delete(chatId)
  publishEvent(AGENT_SESSIONS_CHANGED_CHANNEL, { chatId })
})
/**
 * A task runner starting or stopping work in a chat (an autonomous task
 * queued, cancelled, finished) holds or frees it with no main-owned run
 * opening or closing: the windows re-read on this too.
 */
onTaskRunnerWorkingChanged((chatId) => {
  publishEvent(AGENT_SESSIONS_CHANGED_CHANNEL, { chatId })
})
