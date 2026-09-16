import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/**
 * The recent tasks, on the Inbox screen's second half.
 *
 * What is worth testing here is the paging — ten rows, then ten more — and the
 * two states a list read can end in, because this block replaced a sidebar
 * section that had both and the screen it moved to has no other way to say a
 * task list could not be read.
 */

;(window as unknown as { api: unknown }).api = { app: { setTheme: async () => undefined } }

const listTasks = vi.fn<() => Promise<unknown[]>>()
const { RecentTasks } = await import('./RecentTasks')
const { useUIStore } = await import('../../stores/ui.store')

function task(n: number) {
  return {
    id: `t${n}`,
    title: `Task ${n}`,
    status: n === 0 ? 'blocked' : 'completed',
    updatedAt: new Date('2026-09-11T09:00:00Z')
  }
}

let client: QueryClient

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

function renderTasks(): ReturnType<typeof render> {
  return render(createElement(RecentTasks), { wrapper })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, refetchInterval: false } } })
  listTasks.mockReset()
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    tasks: { list: () => listTasks() }
  }
})

afterEach(cleanup)

it('shows ten tasks and adds ten more on Show more', async () => {
  // Mutation: raise the initial page to twenty (the sidebar list's size) and
  // this fails on the first count — half the Inbox screen would be one list
  // scrolling past the block it shares the page with.
  listTasks.mockResolvedValue(Array.from({ length: 25 }, (_v, i) => task(i)))
  const { container } = renderTasks()
  await screen.findByRole('button', { name: /^Task 0 —/ })
  expect(container.querySelectorAll('li')).toHaveLength(10)
  fireEvent.click(screen.getByRole('button', { name: 'Show more tasks' }))
  expect(container.querySelectorAll('li')).toHaveLength(20)
  fireEvent.click(screen.getByRole('button', { name: 'Show more tasks' }))
  expect(container.querySelectorAll('li')).toHaveLength(25)
  expect(screen.queryByRole('button', { name: 'Show more tasks' })).toBeNull()
})

it('reads the root list, not one task’s children', async () => {
  listTasks.mockResolvedValue([task(0)])
  renderTasks()
  await screen.findByRole('button', { name: /^Task 0 —/ })
  expect(listTasks).toHaveBeenCalledTimes(1)
})

it('opens the task page for the row that was clicked', async () => {
  listTasks.mockResolvedValue([task(0), task(1)])
  renderTasks()
  fireEvent.click(await screen.findByRole('button', { name: /^Task 1 —/ }))
  expect(useUIStore.getState().activeTaskId).toBe('t1')
  expect(useUIStore.getState().activeView).toBe('task')
})

it('names the region and its heading with the same words', async () => {
  // `ux_rules.md` §10 — the visible name is the accessible one.
  listTasks.mockResolvedValue([])
  renderTasks()
  expect(await screen.findByRole('region', { name: 'Recent tasks' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Recent tasks' })).toBeTruthy()
})

it('says where tasks come from rather than only that there are none', async () => {
  listTasks.mockResolvedValue([])
  renderTasks()
  expect(await screen.findByText('No tasks yet.')).toBeTruthy()
  expect(
    screen.getByText('One arrives when a job runs, or when an agent stops to ask you something.')
  ).toBeTruthy()
})

it('says the list could not be read, under the rows, with a way to retry', async () => {
  // Mutation: drop the failure block and this fails — a failed read renders as
  // the empty state, which says there is no work where there may be plenty
  // (`ux_rules.md` §6).
  listTasks.mockRejectedValue(new Error('database is locked'))
  renderTasks()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be read'))
  expect(screen.queryByText('No tasks yet.')).toBeNull()
  listTasks.mockResolvedValue([task(0)])
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByRole('button', { name: /^Task 0 —/ })).toBeTruthy()
})

it('holds the order a row first appeared in, however the next read is sorted', async () => {
  // Mutation: render `rows` instead of `ordered` and this fails — the query is
  // `ORDER BY updated_at DESC` on a five-second poll, so a task changing
  // anywhere in the app (an agent writing progress, a peer's row arriving over
  // sync) jumps to the top and pushes every row under the pointer down by one
  // (`ux_rules.md` §1). Measured at 34 px in the review that found it.
  listTasks.mockResolvedValue([task(0), task(1), task(2)])
  const { container } = renderTasks()
  await screen.findByRole('button', { name: /^Task 0 —/ })
  // The title span rather than the accessible name: the name carries the
  // status too, and this test is about where a row sits, not what it says.
  // `first-of-type`, not `first-child`: the status icon leads the row now, so
  // the title is the first *span* rather than the first child of anything.
  const titles = (): string[] =>
    [...container.querySelectorAll('li button > span:first-of-type')].map(
      (title) => title.textContent ?? ''
    )
  expect(titles()).toEqual(['Task 0', 'Task 1', 'Task 2'])

  // Task 2 was just touched, so the server sorts it first.
  listTasks.mockResolvedValue([task(2), task(0), task(1)])
  await act(async () => {
    await client.refetchQueries({ queryKey: ['tasks', 'roots'] })
  })
  expect(titles()).toEqual(['Task 0', 'Task 1', 'Task 2'])

  // A task that was not there before has no place to hold, so it joins at the
  // end where it can move nothing — the rule the ask list above it follows.
  listTasks.mockResolvedValue([task(3), task(2), task(0), task(1)])
  await act(async () => {
    await client.refetchQueries({ queryKey: ['tasks', 'roots'] })
  })
  expect(titles()).toEqual(['Task 0', 'Task 1', 'Task 2', 'Task 3'])
})

it('keeps the rows it has when a later read fails', async () => {
  listTasks.mockResolvedValueOnce([task(0)]).mockRejectedValue(new Error('offline'))
  renderTasks()
  await screen.findByRole('button', { name: /^Task 0 —/ })
  await act(async () => {
    await client.refetchQueries({ queryKey: ['tasks', 'roots'] })
  })
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(screen.getByRole('button', { name: /^Task 0 —/ })).toBeTruthy()
})
