import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { LocalJobScheduleSnapshot } from '../../../../shared/localJobSchedules'
import type { LocalScheduleItem } from '../../../../shared/localSchedules'
import { JobSchedules } from './JobSchedules'

const profile = vi.hoisted(() => ({ id: 'profile' }))
const openTask = vi.hoisted(() => vi.fn())
vi.mock('../../stores/auth.store', () => ({ useAuthStore: (selector: (state: unknown) => unknown) => selector({ currentUser: { id: profile.id } }) }))
vi.mock('../../hooks/useTasks', () => ({ useOpenTask: () => openTask }))
const list = vi.fn(), save = vi.fn(), enable = vi.fn(), disable = vi.fn(), remove = vi.fn(), history = vi.fn(), stop = vi.fn()
const localSave = vi.fn(), localHistory = vi.fn(), preview = vi.fn()
const item: LocalScheduleItem = { name: 'Morning check', profileUserId: 'profile', cron: '17 */3 1,15 2-11 1-5', timezone: 'UTC', prompt: '', revision: 'schedule-revision', problem: null,
  binding: { id: 'schedule-id', enabled: false, reason: null, jobId: 'job-id', nextDueAt: null, last: null } }
const snapshot: LocalJobScheduleSnapshot = { profileUserId: 'profile', jobId: 'job-id', jobTitle: 'Check the ledger', jobPrompt: 'Review the accounts', jobSummary: 'Script runtime · 12 turns · 45 minutes', jobRevision: 'job-revision', items: [item] }
function view(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}><JobSchedules jobId="job-id" /></QueryClientProvider>)
}
beforeEach(() => {
  vi.clearAllMocks(); profile.id = 'profile'
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', '') } })
  Object.defineProperty(window, 'api', { configurable: true, value: {
    jobSchedules: { list, save, enable, disable, delete: remove, history, stop },
    localSchedules: { save: localSave, history: localHistory, preview }
  } })
  list.mockResolvedValue(snapshot); save.mockResolvedValue(snapshot); enable.mockResolvedValue(snapshot); remove.mockResolvedValue(undefined)
  preview.mockResolvedValue({ nextDueAt: Date.UTC(2026, 8, 24, 8) })
  history.mockResolvedValue({ items: [], nextCursor: null })
})

it('refreshes the ordinary Job history when polling discovers a scheduled task', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  view(client)
  await screen.findByRole('article', { name: 'Morning check' })
  invalidate.mockClear()
  act(() => client.setQueryData(['job-schedules', 'profile', 'job-id'], { ...snapshot, items: [{ ...item, binding: { ...item.binding, last: { id: 'new-occurrence', status: 'dispatched', taskId: 'new-task' } } }] }))
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['jobs', 'job-id'] }))
})
it('creates a schedule for the existing reviewed Job without exposing agent execution fields or creating a second Job', async () => {
  view()
  await screen.findByRole('article', { name: 'Morning check' })
  fireEvent.click(screen.getByRole('button', { name: 'New schedule' }))
  const dialog = screen.getByRole('dialog', { name: 'New schedule' })
  expect(within(dialog).queryByLabelText('Execution type')).toBeNull()
  expect(within(dialog).queryByLabelText('Command')).toBeNull()
  const prompt = within(dialog).getByLabelText('Job prompt') as HTMLTextAreaElement
  expect(prompt.readOnly).toBe(true)
  expect(prompt.value).toBe('Review the accounts')
  expect(dialog.textContent).toContain('Script runtime · 12 turns · 45 minutes')
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Evening review' } })
  fireEvent.click(within(dialog).getByLabelText('Enable on this device'))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save and enable' }))
  await waitFor(() => expect(save).toHaveBeenCalled())
  expect(save.mock.calls[0][0]).toMatchObject({ profileUserId: 'profile', jobId: 'job-id', jobRevision: 'job-revision', name: 'Evening review', enabled: true })
  expect(save.mock.calls[0][0]).not.toHaveProperty('prompt')
  expect(localSave).not.toHaveBeenCalled()
})
it('round trips advanced rules and preserves edits when the Job changes before saving', async () => {
  save.mockRejectedValue(new Error("Error invoking remote method 'job-schedule:save': Error: The Job changed. Review it again."))
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for Morning check' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit schedule' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit schedule' })
  expect((within(dialog).getByLabelText('Cron expression') as HTMLInputElement).value).toBe('17 */3 1,15 2-11 1-5')
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Renamed check' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }))
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('The Job changed.'))
  expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Renamed check')
  expect(save.mock.calls[0][0]).toMatchObject({ id: 'schedule-id', revision: 'schedule-revision', jobRevision: 'job-revision', cron: item.cron })
})
it('reviews the captured Job definition and sends both definition and schedule review tokens when enabling', async () => {
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Review and enable' }))
  const dialog = screen.getByRole('dialog', { name: 'Enable schedule' })
  expect((within(dialog).getByLabelText('Job prompt') as HTMLTextAreaElement).value).toBe(snapshot.jobPrompt)
  expect(dialog.textContent).toContain('it runs once when Cinna is available again')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Enable on this device' }))
  await waitFor(() => expect(enable).toHaveBeenCalledWith({ profileUserId: 'profile', jobId: 'job-id', id: 'schedule-id', revision: 'schedule-revision', jobRevision: 'job-revision' }))
})
it('opens existing Job tasks from schedule history through the Job scheduling namespace', async () => {
  history.mockResolvedValue({ items: [{ id: 'occurrence', utcMinute: 5, civilKey: 'key', status: 'completed', taskId: 'task-id', runId: 'run', chatId: null, reason: null, resultKind: 'agent_started' }], nextCursor: null })
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for Morning check' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Execution history' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Open task' }))
  expect(openTask).toHaveBeenCalledWith('task-id')
  expect(history).toHaveBeenCalledWith({ profileUserId: 'profile', bindingId: 'schedule-id', cursor: undefined })
  expect(localHistory).not.toHaveBeenCalled()
})
it('confirms deleting only the schedule and retains the form after a stale revision refusal', async () => {
  remove.mockRejectedValue(new Error('The schedule changed.'))
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for Morning check' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete schedule…' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete schedule' })
  expect(dialog.textContent).toContain('The Job and its existing tasks are kept.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete schedule' }))
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('The schedule changed.'))
  expect(remove).toHaveBeenCalledWith({ profileUserId: 'profile', jobId: 'job-id', id: 'schedule-id', revision: 'schedule-revision' })
})

it('reviews every captured script step, agent name, dependency, and question before enabling', async () => {
  list.mockResolvedValue({ ...snapshot, jobScript: { version: 1, agents: { accountant: { kind: 'agent', source: 'folder', manifestId: 'manifest', name: 'Ledger accountant' } }, steps: [
    { id: 'inspect', agent: 'accountant', prompt: 'Inspect the revised ledger and include every discrepancy.' },
    { id: 'approve', after: ['inspect'], ask_user: 'Approve publication of this report?' }
  ] } })
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Review and enable' }))
  const dialog = screen.getByRole('dialog', { name: 'Enable schedule' })
  expect(dialog.textContent).toContain('Ledger accountant')
  expect(dialog.textContent).toContain('Runs after: inspect')
  expect(within(dialog).getByLabelText('Instructions for inspect').textContent).toBe('Inspect the revised ledger and include every discrepancy.')
  expect(within(dialog).getByLabelText('Instructions for approve').textContent).toBe('Approve publication of this report?')
})

it('allows review and re-enabling after the Job changes, showing current instructions and next time in the saved zone', async () => {
  const changed = { ...snapshot, jobPrompt: 'Review the revised accounts', jobRevision: 'new-job-revision', items: [{ ...item, timezone: 'Asia/Tokyo', problem: 'The Job’s instructions or configuration changed. Review this schedule before enabling it again.' }] }
  list.mockResolvedValue(changed)
  view()
  const button = await screen.findByRole('button', { name: 'Review and enable' })
  expect((button as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(button)
  const dialog = screen.getByRole('dialog', { name: 'Enable schedule' })
  expect((within(dialog).getByLabelText('Job prompt') as HTMLTextAreaElement).value).toBe('Review the revised accounts')
  await waitFor(() => expect(within(dialog).getByRole('status').textContent).toBe(`Next scheduled time: ${new Date(Date.UTC(2026, 8, 24, 8)).toLocaleString(undefined, { timeZone: 'Asia/Tokyo' })} (Asia/Tokyo)`))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Enable on this device' }))
  await waitFor(() => expect(enable).toHaveBeenCalledWith({ profileUserId: 'profile', jobId: 'job-id', id: 'schedule-id', revision: 'schedule-revision', jobRevision: 'new-job-revision' }))
})
