import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

;(window as unknown as { api: unknown }).api = { app: { setTheme: async () => undefined } }
const { TaskList } = await import('./TaskList')
const { useUIStore } = await import('../../stores/ui.store')

const rows = [{ id: 'child', title: 'Verify result', status: 'completed' }]
afterEach(cleanup)

it('opens a child from the scoped list and preserves it with a visible refresh failure', async () => {
  const list = vi.fn().mockResolvedValue({ tasks: rows, refreshed: true })
  ;(window as unknown as { api: unknown }).api = { tasks: { children: list } }
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  render(<QueryClientProvider client={client}><TaskList parentTaskId="parent" /></QueryClientProvider>)
  const child = await screen.findByRole('button', { name: 'Verify result' })
  expect(list).toHaveBeenCalledWith('parent')
  fireEvent.click(child)
  expect(useUIStore.getState().activeTaskId).toBe('child')
  expect(useUIStore.getState().activeView).toBe('task')
  list.mockRejectedValue(new Error('offline'))
  await act(async () => { await client.invalidateQueries({ queryKey: ['tasks', 'parent'] }) })
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be refreshed'))
  expect(screen.getByRole('button', { name: 'Verify result' })).toBeTruthy()
  list.mockResolvedValue({ tasks: rows, refreshed: true })
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  client.clear()
})
