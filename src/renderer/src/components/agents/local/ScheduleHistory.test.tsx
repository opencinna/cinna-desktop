import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { LocalScheduleItem, LocalScheduleOccurrence } from '../../../../../shared/localSchedules'
import { ScheduleHistory } from './ScheduleHistory'

const openTask = vi.hoisted(() => vi.fn())
vi.mock('../../../hooks/useTasks', () => ({ useOpenTask: () => openTask }))
const history = vi.fn()
const stop = vi.fn()
const changed = vi.fn()
const item: LocalScheduleItem = { profileUserId: 'profile', name: 'Inbox', prompt: '', executionType: 'script_trigger', command: 'check', cron: '0 8 * * 1-5', timezone: 'UTC', revision: 'r', problem: null, binding: { id: 'binding', enabled: true, jobId: null, reason: null, last: null } }
function occurrence(overrides: Partial<LocalScheduleOccurrence> = {}): LocalScheduleOccurrence {
  return { id: 'quiet', utcMinute: 1000, civilKey: '2026-09-21T08:00', status: 'completed', taskId: null, runId: null, chatId: null, reason: null, scheduledFor: Date.UTC(2026, 8, 21, 8), startedAt: Date.UTC(2026, 8, 22, 11), finishedAt: Date.UTC(2026, 8, 22, 11, 1), resultKind: 'quiet_ok', triggerKind: 'catch_up', coveredThrough: Date.UTC(2026, 8, 22, 11), ...overrides }
}
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ScheduleHistory item={item} onChanged={changed} /></QueryClientProvider>)
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', { configurable: true, value: { localSchedules: { history, stop } } })
  stop.mockResolvedValue(undefined)
})
it('shows intended and actual execution times separately for quiet catch-up checks, including stderr', async () => {
  history.mockResolvedValue({ items: [occurrence({ commandOutcome: { stdout: ' OK\n', stderr: 'warning', exitCode: 0, startedAt: 1, finishedAt: 2, timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false } })], nextCursor: null })
  view()
  await screen.findByText('Quiet success · Catch-up')
  expect(screen.getByText('Scheduled for').nextElementSibling?.textContent).not.toBe(screen.getByText('Actually started').nextElementSibling?.textContent)
  expect(screen.queryByRole('button', { name: 'Open task' })).toBeNull()
  fireEvent.click(screen.getByText('Command output · Exit 0'))
  expect(screen.getByText('warning')).toBeTruthy()
})
it('opens a follow-up task and paginates older executions', async () => {
  history.mockImplementation(({ cursor }) => Promise.resolve(cursor ? { items: [occurrence({ id: 'older' })], nextCursor: null } : { items: [occurrence({ id: 'task', taskId: 'task-id', resultKind: 'agent_started' })], nextCursor: '1' }))
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Open task' }))
  expect(openTask).toHaveBeenCalledWith('task-id')
  fireEvent.click(screen.getByRole('button', { name: 'Load older executions' }))
  await screen.findByRole('article', { name: 'Execution older' })
  expect(history).toHaveBeenCalledWith({ profileUserId: 'profile', bindingId: 'binding', cursor: '1' })
})
it('stops an active check without creating or opening a task', async () => {
  history.mockResolvedValue({ items: [occurrence({ status: 'dispatched', resultKind: null, finishedAt: null })], nextCursor: null })
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
  await waitFor(() => expect(stop).toHaveBeenCalledWith({ profileUserId: 'profile', bindingId: 'binding', occurrenceId: 'quiet' }))
  expect(openTask).not.toHaveBeenCalled()
})
it('requires explicit handling of an uncertain interrupted check', async () => {
  history.mockResolvedValue({ items: [occurrence({ status: 'interrupted', resultKind: null })], nextCursor: null })
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Resolve interruption' }))
  expect(stop).not.toHaveBeenCalled()
  expect(screen.getByText(/This does not repeat the command/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }))
  await waitFor(() => expect(stop).toHaveBeenCalled())
})
