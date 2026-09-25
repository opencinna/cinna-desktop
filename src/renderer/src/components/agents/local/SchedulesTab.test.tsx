import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { LocalScheduleItem } from '../../../../../shared/localSchedules'
import { SchedulesTab } from './SchedulesTab'

vi.mock('../../../stores/auth.store', () => ({ useAuthStore: (selector: (state: unknown) => unknown) => selector({ currentUser: { id: 'profile' } }) }))
vi.mock('../../../hooks/useTasks', () => ({ useOpenTask: () => vi.fn() }))
const stamp = { mtimeMs: 1, size: 10, hash: 'stamp' }
const editor = vi.fn()
const remove = vi.fn()
const save = vi.fn()
const enable = vi.fn()
const preview = vi.fn()
const item: LocalScheduleItem = { profileUserId: 'profile', name: 'Check reports', prompt: 'Review the reports', cron: '0 8 * * 1-5', timezone: 'UTC', revision: 'revision', problem: null, binding: null }
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><SchedulesTab agentId="agent" /></QueryClientProvider>)
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', '') } })
  Object.defineProperty(window, 'api', { configurable: true, value: { localSchedules: { editor, delete: remove, save, enable, preview } } })
  editor.mockResolvedValue({ items: [item], stamp })
  preview.mockResolvedValue({ nextDueAt: 100000 })
})
it('opens editing through row actions and preserves the stamped review snapshot', async () => {
  save.mockResolvedValue({ items: [item], stamp, warning: 'Saved; enablement needs review' })
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for Check reports' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit schedule' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit schedule' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Renamed report' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toBe('Saved; enablement needs review')
  expect(save.mock.calls[0][0]).toMatchObject({ expectedStamp: stamp, originalName: 'Check reports', name: 'Renamed report', revision: 'revision', profileUserId: 'profile' })
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('keeps a failed deletion confirmation open and reports the failure beside its action', async () => {
  remove.mockRejectedValue(new Error('The manifest changed.'))
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for Check reports' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete schedule…' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete schedule' })
  expect(dialog.textContent).toContain('Existing tasks and execution records are kept.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete schedule' }))
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('The manifest changed.'))
  expect(screen.getByRole('dialog', { name: 'Delete schedule' })).toBeTruthy()
  expect(remove).toHaveBeenCalledWith({ expectedStamp: stamp, name: 'Check reports', revision: 'revision', agentId: 'agent', profileUserId: 'profile' })
})
it('reviews imported prompts with the single catch-up behavior before enabling', async () => {
  enable.mockResolvedValue([])
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Review and enable' }))
  const dialog = screen.getByRole('dialog', { name: 'Enable schedule' })
  expect(dialog.textContent).toContain('it runs once when Cinna is available again')
  expect((within(dialog).getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Review the reports')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Enable on this device' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(enable).toHaveBeenCalledWith({ agentId: 'agent', profileUserId: 'profile', name: 'Check reports', revision: 'revision', timezone: 'UTC' })
})
