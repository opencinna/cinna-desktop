import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatListSummary } from '../../../../shared/chatListSummary'

/**
 * The tooltip's data reaches the rows through its own query, not the list's:
 * `chat:list` is polled every second and must stay cheap.
 */

const list = vi.fn()
const listSummaries = vi.fn()
;(window as unknown as { api: unknown }).api = {
  app: { setTheme: vi.fn().mockResolvedValue(undefined) },
  run: { cancelChat: vi.fn() },
  chat: { list, listSummaries, delete: vi.fn(), onTitleUpdated: () => () => {} }
}
vi.mock('../../hooks/useStartNewChat', () => ({ useStartNewChat: () => () => {} }))

const { ChatList } = await import('./ChatList')

const chats = [
  { id: 'c-1', title: 'First chat', updatedAt: new Date(), createdAt: new Date() },
  { id: 'c-2', title: 'Second chat', updatedAt: new Date(), createdAt: new Date() }
]
const summary: ChatListSummary = {
  with: { kind: 'agent', name: 'Research Agent', color: null, agentId: 'a-research' },
  others: [],
  firstMessageAt: new Date(2026, 8, 12, 14, 0),
  lastMessageAt: new Date(2026, 8, 12, 14, 25),
  messageCount: 14
}
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  list.mockReset().mockResolvedValue(chats)
  listSummaries.mockReset().mockResolvedValue({ 'c-1': summary })
})
afterEach(() => client.clear())

function view() {
  return <QueryClientProvider client={client}><ChatList /></QueryClientProvider>
}

it('hands each row its own summary, and a row without one gets no tooltip', async () => {
  render(view())
  await waitFor(() => expect(screen.getByText('First chat')).toBeTruthy())
  await waitFor(() => expect(listSummaries).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(client.getQueryData(['chats', 'summaries'])).toBeTruthy())

  fireEvent.mouseEnter(screen.getByText('First chat').parentElement!)
  expect(screen.getByRole('tooltip').textContent).toContain('Research Agent')
  fireEvent.mouseLeave(screen.getByText('First chat').parentElement!)

  fireEvent.mouseEnter(screen.getByText('Second chat').parentElement!)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('shows the rows before the summaries arrive, without tooltips', async () => {
  listSummaries.mockReturnValue(new Promise(() => {}))
  render(view())
  await waitFor(() => expect(screen.getByText('First chat')).toBeTruthy())
  fireEvent.mouseEnter(screen.getByText('First chat').parentElement!)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('is never polled, refreshes with every invalidation of the list, and is left alone by the list\'s exact-key writes', async () => {
  render(view())
  await waitFor(() => expect(listSummaries).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(client.getQueryData(['chats', 'summaries'])).toBeTruthy())

  const query = client.getQueryCache().find({ queryKey: ['chats', 'summaries'] })!
  expect(query.observers.length).toBe(1)
  expect(query.observers[0].options.refetchInterval).toBeUndefined()
  // The list beside it is the polled one.
  expect(client.getQueryCache().find({ queryKey: ['chats'], exact: true })!.observers[0].options.refetchInterval).toBe(1_000)

  // What useLiveRunWatch and useReadChatResult do to the list.
  await act(async () => {
    await client.cancelQueries({ queryKey: ['chats'], exact: true })
    client.setQueryData(['chats'], (rows: typeof chats | undefined) => rows?.map((row) => ({ ...row, activeRunId: 'run-1' })))
  })
  expect(client.getQueryData(['chats', 'summaries'])).toEqual({ 'c-1': summary })
  expect(listSummaries).toHaveBeenCalledTimes(1)

  // What every create/delete/turn-end does.
  await act(async () => { await client.invalidateQueries({ queryKey: ['chats'] }) })
  expect(listSummaries).toHaveBeenCalledTimes(2)
})

it('refreshes the summaries once when background turns end, and not on first load or while they run', async () => {
  const withRuns = (a: string | null, b: string | null) => [{ ...chats[0], activeRunId: a }, { ...chats[1], activeRunId: b }]
  list.mockResolvedValue(withRuns('run-1', 'run-2'))
  render(view())
  await waitFor(() => expect(screen.getByText('First chat')).toBeTruthy())
  await waitFor(() => expect(client.getQueryData(['chats', 'summaries'])).toBeTruthy())
  expect(listSummaries).toHaveBeenCalledTimes(1)

  // Still running: a new poll result changes nothing.
  await act(async () => { client.setQueryData(['chats'], withRuns('run-1', 'run-2')) })
  expect(listSummaries).toHaveBeenCalledTimes(1)

  // Both end in the same result: one refresh, not one per row.
  await act(async () => { client.setQueryData(['chats'], withRuns(null, null)) })
  await waitFor(() => expect(listSummaries).toHaveBeenCalledTimes(2))

  // Idle results after that, and a run starting, refresh nothing.
  await act(async () => { client.setQueryData(['chats'], withRuns(null, null)) })
  await act(async () => { client.setQueryData(['chats'], withRuns('run-3', null)) })
  expect(listSummaries).toHaveBeenCalledTimes(2)
})
