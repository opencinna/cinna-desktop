import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/**
 * The filter is the cache identity: the Inbox's root list and a chat's Tasks
 * badge are both `rootOnly` lists, and if the key did not carry `chatId` the
 * badge would show every root task (or the Inbox only one chat's).
 */

;(window as unknown as { api: unknown }).api = {}
const { useTaskList, taskListKey } = await import('./useTaskList')

const list = vi.fn(async (query: { chatId?: string }) => [{ id: query.chatId ?? 'all' }])
const children = vi.fn(async () => ({ tasks: [], refreshed: true }))
let client: QueryClient

function wrapper({ children: kids }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, kids)
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  list.mockClear()
  children.mockClear()
  ;(window as unknown as { api: unknown }).api = { tasks: { list, children } }
})

afterEach(() => {
  cleanup()
  client.clear()
})

it('keys two lists with different filters apart', () => {
  expect(taskListKey({ rootOnly: true, chatId: 'c1' })).not.toEqual(taskListKey({ rootOnly: true }))
  expect(taskListKey({ rootOnly: true, chatId: 'c1' })).not.toEqual(taskListKey({ rootOnly: true, chatId: 'c2' }))
  expect(taskListKey({ rootOnly: true, chatId: 'c1' })).toContainEqual({ rootOnly: true, chatId: 'c1' })
})

it('keeps the prefixes the rest of the renderer refetches by', () => {
  expect(taskListKey({ rootOnly: true }).slice(0, 2)).toEqual(['tasks', 'roots'])
  expect(taskListKey({ parentTaskId: 'p1' })).toEqual(['tasks', 'p1'])
})

it('does not serve one chat’s list from the unfiltered root cache', async () => {
  const roots = renderHook(() => useTaskList(), { wrapper })
  await waitFor(() => expect(roots.result.current.data?.tasks).toEqual([{ id: 'all' }]))
  const chat = renderHook(() => useTaskList({ rootOnly: true, chatId: 'c1' }), { wrapper })
  await waitFor(() => expect(chat.result.current.data?.tasks).toEqual([{ id: 'c1' }]))
  // Sharing an entry, the chat's read would overwrite what the root list shows.
  expect(roots.result.current.data?.tasks).toEqual([{ id: 'all' }])
  expect(list).toHaveBeenNthCalledWith(1, { rootOnly: true })
  expect(list).toHaveBeenNthCalledWith(2, { rootOnly: true, chatId: 'c1' })
})

it('reads a parent’s children through the refreshing call', async () => {
  const hook = renderHook(() => useTaskList({ parentTaskId: 'p1' }), { wrapper })
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
  expect(children).toHaveBeenCalledWith('p1')
  expect(list).not.toHaveBeenCalled()
})
