import { chatRepo } from '../db/chats'
import { visibleChat } from '../auth/chatScope'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { AcpConnection } from '../agents/drivers/acp/types'
import { buildAcpPrompt } from './acpAttachments'
import { dashboardContextTracker } from './dashboards/dashboardContext'

/**
 * A replacement session needs the transcript, including its own answers, not the 4K catch-up gap.
 *
 * Called for every new engine session of the chat's answerer, so it is also
 * where the dashboard context forgets what the old session was sent: this
 * turn's section, when it was left out as unchanged, follows the transcript.
 */
export async function replayTranscript(chatId: string, currentMessageId: string | undefined, connection: AcpConnection, userId: string, agentId: string, uploadsDir: string | null): Promise<ContentBlock[]> {
  // Only the chat's answerer owns the whole conversation. A participant the
  // user addresses gets the catch-up packet, not every past turn on top of it.
  if (visibleChat(userId, chatId)?.agentId !== agentId) return []
  const dashboardSection = dashboardContextTracker.sessionReset(chatId)
  const messages = chatRepo.listMessages(chatId)
  const index = currentMessageId ? messages.findIndex((message) => message.id === currentMessageId) : -1
  const history = index < 0 ? messages.slice(0, -1) : messages.slice(0, index)
  const blocks: ContentBlock[] = []
  for (const message of history.filter((message) => message.role !== 'error' && message.role !== 'agent_transition')) {
    const attribution = message.sourceAgentId ? ` agent=${message.sourceAgentId}` : ''
    const tool = message.toolCallId ? ` tool_call=${message.toolCallId} tool=${message.toolName}` : ''
    blocks.push(...await buildAcpPrompt(userId, { wireContent: `[${message.role}${attribution}${tool}]\n${message.content}`, attachments: message.attachments ?? [] }, connection, uploadsDir))
  }
  const replay: ContentBlock[] = blocks.length ? [{ type: 'text', text: '<prior_chat_transcript>' }, ...blocks, { type: 'text', text: '</prior_chat_transcript>\nContinue this chat from the transcript above. The current message follows.' }] : []
  return dashboardSection ? [...replay, { type: 'text', text: dashboardSection }] : replay
}
