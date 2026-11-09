import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/** The Chats header's search button opens all-chats search, whatever chat is open. */

;(window as unknown as { api: unknown }).api = {
  app: { setTheme: vi.fn().mockResolvedValue(undefined) },
  chat: {
    list: vi.fn().mockResolvedValue([]),
    listSummaries: vi.fn().mockResolvedValue({}),
    onTitleUpdated: () => () => {}
  }
}
vi.mock('../../hooks/useStartNewChat', () => ({ useStartNewChat: () => () => {} }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }) }))
vi.mock('../../hooks/useLocalAgents', () => ({
  useLocalAgents: () => ({ data: { roots: [], agents: [] } }),
  useOpenAgentPath: () => ({ mutateAsync: vi.fn() })
}))

const { ChatList } = await import('./ChatList')
const { useChatSearchStore } = await import('../../stores/chatSearch.store')

let client: QueryClient
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useChatSearchStore.setState({ scope: null, searchableChatId: 'c-open' })
})
afterEach(() => client.clear())

it('opens all-chats search from the Chats header, beside the grouping menu', () => {
  render(<QueryClientProvider client={client}><ChatList /></QueryClientProvider>)
  const button = screen.getByRole('button', { name: 'Search chats' })
  expect(button.title).toMatch(/^Search chats \((⌘F|Ctrl\+F)\)$/)
  // Revealed on hover like the menu it sits before.
  expect(button.nextElementSibling).toBe(screen.getByRole('button', { name: 'Chats list options' }))
  expect(button.className).toContain('group-hover/chats-header:opacity-100')
  fireEvent.click(button)
  expect(useChatSearchStore.getState().scope).toBe('all')
})
