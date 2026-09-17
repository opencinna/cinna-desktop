import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

;(window as unknown as { api: unknown }).api = { app: { setTheme: async () => undefined } }
const { TaskList } = await import('./TaskList')
const { useUIStore } = await import('../../stores/ui.store')

const rows = [{ id: 'child', title: 'Verify result', status: 'completed', updatedAt: new Date() }]
afterEach(cleanup)

it('opens a child from the scoped list and preserves it with a visible refresh failure', async () => {
  const list = vi.fn().mockResolvedValue({ tasks: rows, refreshed: true })
  ;(window as unknown as { api: unknown }).api = { tasks: { children: list } }
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  render(<QueryClientProvider client={client}><TaskList parentTaskId="parent" expected /></QueryClientProvider>)
  const child = await screen.findByRole('button', { name: 'Verify result — completed' })
  expect(list).toHaveBeenCalledWith('parent')
  fireEvent.click(child)
  expect(useUIStore.getState().activeTaskId).toBe('child')
  expect(useUIStore.getState().activeView).toBe('task')
  list.mockRejectedValue(new Error('offline'))
  await act(async () => { await client.invalidateQueries({ queryKey: ['tasks', 'parent'] }) })
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be refreshed'))
  expect(screen.getByRole('button', { name: 'Verify result — completed' })).toBeTruthy()
  list.mockResolvedValue({ tasks: rows, refreshed: true })
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  client.clear()
})

it('shows no section for a task with no subtasks, but still asks for them', async () => {
  const list = vi.fn().mockResolvedValue({ tasks: [], refreshed: true })
  ;(window as unknown as { api: unknown }).api = { tasks: { children: list } }
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  render(<QueryClientProvider client={client}><TaskList parentTaskId="lonely" expected={false} /></QueryClientProvider>)
  await waitFor(() => expect(list).toHaveBeenCalledWith('lonely'))
  expect(screen.queryByRole('region', { name: 'Subtasks' })).toBeNull()
  // A child the refresh discovers brings the section with it, count or not.
  list.mockResolvedValue({ tasks: rows, refreshed: true })
  await act(async () => { await client.invalidateQueries({ queryKey: ['tasks', 'lonely'] }) })
  await screen.findByRole('region', { name: 'Subtasks' })
  client.clear()
})

it('keeps a stale count honest: says there are none once the refresh confirms it', async () => {
  const list = vi.fn().mockResolvedValue({ tasks: [], refreshed: true })
  ;(window as unknown as { api: unknown }).api = { tasks: { children: list } }
  const client = new QueryClient()
  render(<QueryClientProvider client={client}><TaskList parentTaskId="stale" expected /></QueryClientProvider>)
  await screen.findByText('No subtasks.')
  client.clear()
})

it('shows a failed refresh even for a task whose count says it has none', async () => {
  const list = vi.fn().mockRejectedValue(new Error('offline'))
  ;(window as unknown as { api: unknown }).api = { tasks: { children: list } }
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  render(<QueryClientProvider client={client}><TaskList parentTaskId="unread" expected={false} /></QueryClientProvider>)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be refreshed'))
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  client.clear()
})
