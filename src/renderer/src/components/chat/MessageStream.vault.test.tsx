vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

/**
 * A chat with an agent in an Agent Vault keeps its transcript inside the vault
 * (D5). While the agent's readiness says `vault_locked` the transcript shows
 * nothing, and the empty state says why instead of "Start a conversation".
 */

const data = vi.hoisted(() => ({
  messages: [] as unknown[],
  readiness: null as null | { state: string; reason: string },
  vaultId: 'vault-1' as string | null
}))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { agentId: 'folder:v', vaultId: data.vaultId, messages: data.messages }, refetch: () => {} }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [{ id: 'folder:v', name: 'Vault', readiness: data.readiness }] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
vi.mock('./transcriptAnchor', () => ({ holdCollapseAnchor: () => () => {} }))
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

const USER = { id: 'm1', role: 'user', content: 'The secret plan', createdAt: 1 }

beforeEach(() => {
  data.messages = [USER]
  data.readiness = null
  data.vaultId = 'vault-1'
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe('a vault chat', () => {
  it('shows nothing of the transcript while the vault is locked, and says where it is', () => {
    data.readiness = { state: 'vault_locked', reason: 'Vault locked.' }
    render(<MessageStream chatId="chat" />)
    expect(screen.queryByText('The secret plan')).toBeNull()
    expect(screen.getByText('This chat is kept in the vault. Unlock it to see the conversation.')).toBeTruthy()
    expect(screen.queryByText('Start a conversation')).toBeNull()
  })

  it('shows a chat from before the agent moved in, whose history stays on this computer, while the vault is locked', () => {
    data.vaultId = null
    data.readiness = { state: 'vault_locked', reason: 'Vault locked.' }
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('The secret plan')).toBeTruthy()
    expect(screen.queryByText('This chat is kept in the vault. Unlock it to see the conversation.')).toBeNull()
  })

  it('shows the transcript once unlocked', () => {
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('The secret plan')).toBeTruthy()
  })
})
