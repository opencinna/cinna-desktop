import { sessionActivityHub } from './sessionActivityHub'

/**
 * Stop listening between turns to a chat's agent sessions (only the named
 * agent's, when one is given). Drivers that listen install one; the chat
 * service calls it without knowing any driver.
 */
export type ChatSessionForgetter = (chatId: string, agentId?: string) => void

const forgetters = new Set<ChatSessionForgetter>()

export function installChatSessionForgetter(forgetter: ChatSessionForgetter): () => void {
  forgetters.add(forgetter)
  return () => { forgetters.delete(forgetter) }
}

/** Every installed driver stops listening to the chat's sessions. */
export function forgetChatSessions(chatId: string, agentId?: string): void {
  for (const forget of [...forgetters]) forget(chatId, agentId)
}

/**
 * The chat no longer answers to the agent (or to any of its agents): what the
 * old session says from now on must not land in it, and what it was running is
 * no longer this chat's to show — written off as `lost`.
 */
export function releaseChatSessions(chatId: string, agentId?: string): void {
  forgetChatSessions(chatId, agentId)
  sessionActivityHub.endAll(agentId === undefined ? { chatId } : { chatId, agentId }, 'lost')
}
