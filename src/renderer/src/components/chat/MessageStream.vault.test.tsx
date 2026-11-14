const vaultApi = vi.hoisted(() => ({ unlock: vi.fn(async (_agentId: string): Promise<unknown> => ({ ok: true, data: {} })) }))
vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} }, vault: vaultApi } }) })
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

/**
 * A chat with an agent in an Agent Vault keeps its transcript inside the vault
 * (D5). While the agent's readiness says `vault_locked` the transcript shows
 * nothing, and the empty state says why instead of "Start a conversation",
 * with an Unlock of its own.
 */

function render(ui: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

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
  vaultApi.unlock.mockReset()
  vaultApi.unlock.mockResolvedValue({ ok: true, data: {} })
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe('a vault chat', () => {
  it('shows nothing of the transcript while the vault is locked, and says where it is', () => {
    data.readiness = { state: 'vault_locked', reason: 'Vault locked.' }
    render(<MessageStream chatId="chat" />)
    expect(screen.queryByText('The secret plan')).toBeNull()
    expect(screen.getByText('This chat is in a locked vault')).toBeTruthy()
    expect(screen.getByText('Unlock it to see the conversation.')).toBeTruthy()
    expect(screen.queryByText('Start a conversation')).toBeNull()
  })

  it('unlocks the chat’s agent from the card, saying so while the prompt is up', async () => {
    data.readiness = { state: 'vault_locked', reason: 'Vault locked.' }
    let answer!: (value: unknown) => void
    vaultApi.unlock.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    render(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByRole('button', { name: 'Unlocking…' })).toBeTruthy()
    expect(vaultApi.unlock).toHaveBeenCalledWith('folder:v')
    await act(async () => { answer({ ok: true, data: {} }) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a refused prompt in the card, which stays', async () => {
    data.readiness = { state: 'vault_locked', reason: 'Vault locked.' }
    vaultApi.unlock.mockResolvedValueOnce({ ok: false, code: 'denied', message: 'the user did not approve' })
    render(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Unlock was cancelled at the prompt.')
    expect(screen.getByTestId('vault-locked-chat').contains(screen.getByRole('alert'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy()
  })

  it('shows a chat from before the agent moved in, whose history stays on this computer, while the vault is locked', () => {
    data.vaultId = null
    data.readiness = { state: 'vault_locked', reason: 'Vault locked.' }
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('The secret plan')).toBeTruthy()
    expect(screen.queryByText('This chat is in a locked vault')).toBeNull()
  })

  it('shows the transcript once unlocked', () => {
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('The secret plan')).toBeTruthy()
  })
})
