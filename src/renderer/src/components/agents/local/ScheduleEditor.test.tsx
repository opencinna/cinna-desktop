import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ScheduleDaysHours, ScheduleEditor } from './ScheduleEditor'
import type { LocalScheduleItem } from '../../../../../shared/localSchedules'

const save = vi.fn()
const preview = vi.fn()
const stamp = { mtimeMs: 1, size: 1, hash: 'manifest-stamp' }
const saved = vi.fn()
const close = vi.fn()
const item = (overrides: Partial<LocalScheduleItem> = {}): LocalScheduleItem => ({
  profileUserId: 'profile', name: 'Morning', cron: '15 */2 1,15 2-11 1-5', timezone: 'Europe/Berlin',
  executionType: 'static_prompt', prompt: 'Check everything', revision: 'review-token', problem: null, binding: null, ...overrides
})
function editor(existing?: LocalScheduleItem) {
  return render(<ScheduleEditor agentId="agent" profileUserId="profile" stamp={stamp} item={existing} onSaved={saved} onClose={close} />)
}
function fillNew() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Daily check' } })
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Check the reports' } })
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', '') } })
  Object.defineProperty(window, 'api', { configurable: true, value: { localSchedules: { save, preview } } })
  preview.mockResolvedValue({ nextDueAt: Date.UTC(2026, 8, 23, 6) })
  save.mockResolvedValue({ items: [], stamp })
})

describe('custom timing', () => {
  it('shows weekdays Monday through Sunday and exactly 24 accessible hours in a fixed twelve-column grid', () => {
    render(<ScheduleDaysHours rule={{ weekdays: [1], hours: [8] }} onChange={vi.fn()} />)
    const days = within(screen.getByRole('group', { name: 'Days' })).getAllByRole('checkbox')
    expect(days.map((day) => day.parentElement?.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    const hours = within(screen.getByRole('group', { name: 'Hours' })).getAllByRole('checkbox')
    expect(hours).toHaveLength(24)
    expect(hours.map((hour) => hour.getAttribute('aria-label'))).toEqual(Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`))
    const grid = screen.getByTestId('schedule-hour-grid')
    expect(grid.style.gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))')
    expect(grid.children).toHaveLength(24)
    expect(grid.parentElement?.className).toContain('overflow-x-auto')
  })

  it('allows every fieldset to shrink so only the hour grid scrolls on narrow screens', () => {
    editor()
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'custom' } })
    const dialog = screen.getByRole('dialog', { name: 'New schedule' })
    // Fieldset defaults to min-inline-size:min-content in Chromium. Every
    // enclosing fieldset must opt out, or the 12-column grid widens the form.
    for (const fieldset of dialog.querySelectorAll('fieldset')) expect(fieldset.classList.contains('min-w-0')).toBe(true)
    const scroller = screen.getByTestId('schedule-hour-grid').parentElement!
    expect(scroller.classList.contains('w-full')).toBe(true)
    expect(scroller.classList.contains('max-w-full')).toBe(true)
    expect(scroller.classList.contains('overflow-x-auto')).toBe(true)
  })

  it('copies every hour of the workday-hourly template including 18:00 into custom', () => {
    editor()
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'workday-hourly' } })
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'custom' } })
    expect((screen.getByLabelText('09:00') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('18:00') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('19:00') as HTMLInputElement).checked).toBe(false)
    expect(within(screen.getByRole('group', { name: 'Hours' })).getAllByRole('checkbox').filter((entry) => (entry as HTMLInputElement).checked)).toHaveLength(10)
  })

  it('refuses empty custom hours and retains the selections', () => {
    editor(); fillNew()
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'custom' } })
    fireEvent.click(screen.getByLabelText('08:00'))
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/hour/i)
    expect((screen.getByLabelText('08:00') as HTMLInputElement).checked).toBe(false)
  })
})

describe('advanced rules and reviewed saves', () => {
  it('round trips an existing advanced expression exactly, preserving minutes, dates, months, and steps', async () => {
    editor(item())
    expect((screen.getByLabelText('Schedule') as HTMLSelectElement).value).toBe('advanced')
    expect((screen.getByLabelText('Execution type') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0][0]).toMatchObject({ originalName: 'Morning', revision: 'review-token', expectedStamp: stamp, cron: '15 */2 1,15 2-11 1-5', editorMetadata: { mode: 'advanced' }, enabled: false })
  })

  it('requires an explicit replacement and restores the unsaved advanced draft when returning', () => {
    editor(item())
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '37 */3 2,20 3-10 0' } })
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'workday-morning' } })
    expect((screen.getByLabelText('Schedule') as HTMLSelectElement).value).toBe('advanced')
    fireEvent.click(screen.getByRole('button', { name: 'Keep advanced' }))
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('37 */3 2,20 3-10 0')
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'workday-morning' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace timing' }))
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'advanced' } })
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('37 */3 2,20 3-10 0')
  })

  it('falls back to the actual advanced rule when stored checkbox metadata is stale', () => {
    editor(item({ editorMetadata: { mode: 'custom', weekdays: [1], hours: [8] } }))
    expect((screen.getByLabelText('Schedule') as HTMLSelectElement).value).toBe('advanced')
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('15 */2 1,15 2-11 1-5')
  })

  it('keeps copied template values when a different template version changes its defaults', () => {
    editor(item({ cron: '0 7 * * 1-5', editorMetadata: { mode: 'template', templateId: 'workday-morning', templateVersion: 1, weekdays: [1, 2, 3, 4, 5], hours: [7] } }))
    expect((screen.getByLabelText('Schedule') as HTMLSelectElement).value).toBe('custom')
    expect((screen.getByLabelText('07:00') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('08:00') as HTMLInputElement).checked).toBe(false)
  })

  it('keeps values and the dialog open after a conflicting save', async () => {
    save.mockRejectedValue(new Error("Error invoking remote method 'local-schedule:save': Error: The manifest changed; reload before saving."))
    editor(); fillNew()
    fireEvent.click(screen.getByLabelText('Enable on this device'))
    fireEvent.click(screen.getByRole('button', { name: 'Save and enable' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The manifest changed'))
    expect(screen.getByRole('dialog', { name: 'New schedule' })).toBeTruthy()
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Check the reports')
    expect(save.mock.calls[0][0]).toMatchObject({ enabled: true, cron: '0 8 * * 1,2,3,4,5' })
    expect(close).not.toHaveBeenCalled()
  })

  it('reviews resolved catalog commands and sends the command revision with the enabled save', async () => {
    preview.mockResolvedValue({ nextDueAt: Date.UTC(2026, 8, 23, 6), resolvedCommand: 'node scripts/check.js', commandRevision: 'resolved-revision' })
    editor()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Check inbox' } })
    fireEvent.change(screen.getByLabelText('Execution type'), { target: { value: 'script_trigger' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/run:check' } })
    fireEvent.click(screen.getByLabelText('Enable on this device'))
    await screen.findByText('node scripts/check.js')
    fireEvent.click(screen.getByRole('button', { name: 'Save and enable' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0][0]).toMatchObject({ command: '/run:check', commandRevision: 'resolved-revision', executionType: 'script_trigger', enabled: true })
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: 'agent', profileUserId: 'profile', command: '/run:check' }))
  })
})
