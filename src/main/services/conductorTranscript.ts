import { chatRepo } from '../db/chats'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { AcpConnection } from '../agents/drivers/acp/types'
import { buildAcpPrompt } from './acpAttachments'

/** A replacement session needs the transcript, including its own answers, not the 4K catch-up gap. */
export async function replayTranscript(chatId: string, currentMessageId: string | undefined, connection: AcpConnection, userId: string): Promise<ContentBlock[]> {
  const messages = chatRepo.listMessages(chatId)
  const index = currentMessageId ? messages.findIndex((message) => message.id === currentMessageId) : -1
  const history = index < 0 ? messages.slice(0, -1) : messages.slice(0, index)
  const blocks: ContentBlock[] = []
  for (const message of history.filter((message) => message.role !== 'error' && message.role !== 'agent_transition')) {
    const attribution = message.sourceAgentId ? ` agent=${message.sourceAgentId}` : ''
    const tool = message.toolCallId ? ` tool_call=${message.toolCallId} tool=${message.toolName}` : ''
    blocks.push(...await buildAcpPrompt(userId, { wireContent: `[${message.role}${attribution}${tool}]\n${message.content}`, attachments: message.attachments ?? [] }, connection))
  }
  return blocks.length ? [{ type: 'text', text: '<prior_chat_transcript>' }, ...blocks, { type: 'text', text: '</prior_chat_transcript>\nContinue this chat from the transcript above. The current message follows.' }] : []
}
