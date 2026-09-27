import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ScheduleDaysHours, ScheduleEditor, scheduleTimingLabel } from './ScheduleEditor'
import { SCHEDULE_TEMPLATES, scheduleRuleSummary } from '../../../../../shared/scheduleTemplates'
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
/** A new agent schedule opens on the type chooser; `type` picks a card, `null` stays there. */
function editor(existing?: LocalScheduleItem, type: 'Prompt schedule' | 'Script schedule' | null = 'Prompt schedule') {
  const result = render(<ScheduleEditor agentId="agent" profileUserId="profile" stamp={stamp} item={existing} onSaved={saved} onClose={close} />)
  if (!existing && type) fireEvent.click(within(screen.getByRole('group', { name: 'Schedule type' })).getByRole('button', { name: new RegExp(`^${type}`) }))
  return result
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

const badges = (group: string) => within(screen.getByRole('group', { name: group })).getAllByRole('button').map((button) => button.getAttribute('aria-label')!.replace('Remove ', ''))

describe('custom timing', () => {
  it('shows each chosen day and hour as a removable badge, in Monday-to-Sunday and clock order', () => {
    render(<ScheduleDaysHours rule={{ weekdays: [0, 1, 5], hours: [18, 8] }} onChange={vi.fn()} />)
    expect(badges('Days')).toEqual(['Mon', 'Fri', 'Sun'])
    expect(badges('Hours')).toEqual(['08:00', '18:00'])
    expect(screen.queryByTestId('schedule-hour-grid')).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    const addHour = screen.getByRole('combobox', { name: 'Add hour' }) as HTMLSelectElement
    // Only the hours not chosen yet, after the placeholder.
    expect(addHour.options).toHaveLength(1 + 22)
    expect([...addHour.options].map((option) => option.value)).not.toContain('8')
  })

  it('adds a picked value in order, resets the picker, and removes a value from its badge', () => {
    function Harness() {
      const [rule, setRule] = useState({ weekdays: [3], hours: [18] })
      return <ScheduleDaysHours rule={rule} onChange={setRule} />
    }
    render(<Harness />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Add hour' }), { target: { value: '8' } })
    expect(badges('Hours')).toEqual(['08:00', '18:00'])
    expect((screen.getByRole('combobox', { name: 'Add hour' }) as HTMLSelectElement).value).toBe('')
    fireEvent.change(screen.getByRole('combobox', { name: 'Add day' }), { target: { value: '0' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Add day' }), { target: { value: '1' } })
    expect(badges('Days')).toEqual(['Mon', 'Wed', 'Sun'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove 18:00' }))
    expect(badges('Hours')).toEqual(['08:00'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove 08:00' }))
    expect(within(screen.getByRole('group', { name: 'Hours' })).queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByRole('group', { name: 'Hours' }).getAttribute('aria-invalid')).toBe('true')
  })

  it('ignores the second click of a double click, which lands on the × that slid under the pointer', () => {
    function Harness() {
      const [rule, setRule] = useState({ weekdays: [1], hours: [8, 9, 10] })
      return <ScheduleDaysHours rule={rule} onChange={setRule} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove 08:00' }), { detail: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Remove 09:00' }), { detail: 2 })
    expect(badges('Hours')).toEqual(['09:00', '10:00'])
  })

  it('moves focus to the × now in the removed badge’s place, then the one before, then the picker', () => {
    function Harness() {
      const [rule, setRule] = useState({ weekdays: [1], hours: [8, 9] })
      return <ScheduleDaysHours rule={rule} onChange={setRule} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove 08:00' }), { detail: 1 })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove 09:00' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Add hour' }), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove 10:00' }), { detail: 1 })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove 09:00' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove 09:00' }), { detail: 1 })
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Add hour' }))
  })

  it('allows every fieldset to shrink so nothing widens the dialog', () => {
    editor()
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'custom' } })
    const dialog = screen.getByRole('dialog', { name: 'New prompt schedule' })
    // Fieldset defaults to min-inline-size:min-content in Chromium.
    for (const fieldset of dialog.querySelectorAll('fieldset')) expect(fieldset.classList.contains('min-w-0')).toBe(true)
  })

  it('copies every hour of the workday-hourly template including 18:00 into custom', () => {
    editor()
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'workday-hourly' } })
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'custom' } })
    expect(badges('Hours')).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'])
  })

  it('refuses empty custom hours and retains the selections', () => {
    editor(); fillNew()
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'custom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove 08:00' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/hour/i)
    expect(badges('Days')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
  })
})

describe('the editor itself', () => {
  it('shows the next scheduled time with how far away it is', async () => {
    const soon = Date.now() + (8 * 60 + 32) * 60_000 + 20_000
    preview.mockResolvedValue({ nextDueAt: soon })
    editor()
    // Worded exactly as on the lists: no zone here, the summary line names it.
    await screen.findByText(`Next scheduled time: ${new Date(soon).toLocaleString(undefined, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })} · in 8 hours 32 minutes`)
  })

  it('shows a dash rather than a check that never ends while the rule is incomplete', () => {
    editor()
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'custom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove 08:00' }))
    expect(screen.getByText('Next scheduled time: —')).toBeTruthy()
    expect(screen.queryByText('Checking the next scheduled time…')).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Add hour' }), { target: { value: '9' } })
    expect(screen.getByText('Checking the next scheduled time…')).toBeTruthy()
  })

  it('pins the editor’s top edge so content growing below moves nothing above it', () => {
    editor()
    const dialog = screen.getByRole('dialog', { name: 'New prompt schedule' })
    expect(dialog.className).not.toContain('m-auto')
    expect(dialog.className).toContain('mb-auto')
  })

  it('keeps the standing explanation behind the (?) beside the title', () => {
    editor()
    const dialog = screen.getByRole('dialog', { name: 'New prompt schedule' })
    expect(dialog.textContent).not.toContain('runs once when Cinna is available again')
    expect(within(dialog).queryByLabelText('Enable on this device')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'How schedules run' }))
    // Inside the modal dialog, or it would render behind it.
    expect(within(dialog).getByRole('dialog', { name: 'How schedules run' }).textContent).toContain('runs once when Cinna is available again')
  })

  it('opens the cron cheatsheet over the editor, and Escape closes only the cheatsheet', () => {
    editor(item())
    fireEvent.click(screen.getByRole('button', { name: 'Cron expression help' }))
    const sheet = screen.getByRole('dialog', { name: 'Cron expression help' })
    expect(sheet.textContent).toContain('0 9-17/2 * * 1-5')
    expect(within(sheet).getAllByRole('table').length).toBeGreaterThan(0)
    fireEvent(sheet, new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog', { name: 'Cron expression help' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Edit prompt schedule' })).toBeTruthy()
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cron expression help' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Cron expression help' })).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Cron expression help' })).toBeNull()
    expect(close).not.toHaveBeenCalled()
  })

  it('saves the zone picked in the timezone picker, and Escape in the picker leaves the editor open', async () => {
    editor(); fillNew()
    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }))
    const search = screen.getByRole('textbox', { name: 'Search timezones' })
    // The list renders inside the modal editor, or it would sit behind it.
    expect(screen.getByRole('dialog', { name: 'New prompt schedule' }).contains(search)).toBe(true)
    expect(fireEvent.keyDown(search, { key: 'Escape' })).toBe(false)
    expect(screen.getByRole('dialog', { name: 'New prompt schedule' })).toBeTruthy()
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search timezones' }), { target: { value: 'tokyo' } })
    fireEvent.click(screen.getByRole('option', { name: /Tokyo/ }))
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ timezone: 'Asia/Tokyo' })))
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0][0]).toMatchObject({ timezone: 'Asia/Tokyo' })
  })

  it('creates a new schedule enabled', async () => {
    editor(); fillNew()
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0][0]).toMatchObject({ enabled: true, name: 'Daily check' })
  })

  it('keeps an enabled schedule enabled when it is edited', async () => {
    editor(item({ binding: { id: 'b', enabled: true, reason: null, jobId: null, last: null } }))
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0][0]).toMatchObject({ enabled: true })
  })
})

describe('advanced rules and reviewed saves', () => {
  it('round trips an existing advanced expression exactly, preserving minutes, dates, months, and steps', async () => {
    editor(item())
    expect((screen.getByLabelText('Schedule') as HTMLSelectElement).value).toBe('advanced')
    // The type is fixed once created: an edit names it in the title and offers no control for it.
    expect(screen.getByRole('dialog', { name: 'Edit prompt schedule' })).toBeTruthy()
    expect(screen.queryByLabelText('Execution type')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Schedule type' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
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
    expect(badges('Hours')).toEqual(['07:00'])
  })

  it('keeps values and the dialog open after a conflicting save', async () => {
    save.mockRejectedValue(new Error("Error invoking remote method 'local-schedule:save': Error: The manifest changed; reload before saving."))
    editor(); fillNew()
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The manifest changed'))
    expect(screen.getByRole('dialog', { name: 'New prompt schedule' })).toBeTruthy()
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Check the reports')
    expect(save.mock.calls[0][0]).toMatchObject({ enabled: true, cron: '0 8 * * 1,2,3,4,5' })
    expect(close).not.toHaveBeenCalled()
  })

  it('reviews resolved catalog commands and sends the command revision with the enabled save', async () => {
    preview.mockResolvedValue({ nextDueAt: Date.UTC(2026, 8, 23, 6), resolvedCommand: 'node scripts/check.js', commandRevision: 'resolved-revision' })
    editor(undefined, 'Script schedule')
    expect(screen.getByRole('dialog', { name: 'New script schedule' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Check inbox' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/run:check' } })
    await screen.findByText('node scripts/check.js')
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0][0]).toMatchObject({ command: '/run:check', commandRevision: 'resolved-revision', executionType: 'script_trigger', enabled: true })
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: 'agent', profileUserId: 'profile', command: '/run:check' }))
  })
})

describe('the schedule type chooser', () => {
  it('opens a new agent schedule on two cards, and a card opens the form with its title', () => {
    editor(undefined, null)
    const chooser = screen.getByRole('group', { name: 'Schedule type' })
    expect(within(chooser).getAllByRole('button').map((button) => button.textContent?.split(/Starts|Runs/)[0])).toEqual(['Prompt schedule', 'Script schedule'])
    expect(screen.queryByLabelText('Name')).toBeNull()
    fireEvent.click(within(chooser).getByRole('button', { name: /^Script schedule/ }))
    expect(screen.getByRole('dialog', { name: 'New script schedule' })).toBeTruthy()
    expect(screen.getByLabelText('Command')).toBeTruthy()
    expect(screen.queryByLabelText('Prompt')).toBeNull()
  })

  it('goes back to the chooser from the form, and Cancel on the chooser closes', () => {
    editor()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kept' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('group', { name: 'Schedule type' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'New schedule' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Script schedule/ }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Kept')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalled()
  })

  it('saves the type of the card that was picked', async () => {
    editor(undefined, 'Script schedule')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: /^Prompt schedule/ }))
    fillNew()
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0][0]).toMatchObject({ executionType: 'static_prompt', prompt: 'Check the reports' })
  })

  it('names a script schedule by its type when editing it', () => {
    editor(item({ executionType: 'script_trigger', command: 'check' }))
    expect(screen.getByRole('dialog', { name: 'Edit script schedule' })).toBeTruthy()
    expect(screen.getByLabelText('Command')).toBeTruthy()
  })

  it('has no chooser for a Job schedule, whose title names no type', () => {
    render(<ScheduleEditor target="job" snapshot={{ profileUserId: 'profile', jobId: 'job', jobTitle: 'Job', jobPrompt: 'p', jobSummary: 's', jobRevision: 'r', items: [] }} onSaved={saved} onClose={close} />)
    expect(screen.queryByRole('group', { name: 'Schedule type' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'New schedule' })).toBeTruthy()
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  })
})

describe('scheduleTimingLabel', () => {
  it('names the template a schedule was made from', () => {
    expect(scheduleTimingLabel(item({ cron: '0 8 * * 1-5', editorMetadata: { mode: 'template', templateId: 'workday-morning', templateVersion: 1, weekdays: [1, 2, 3, 4, 5], hours: [8] } })))
      .toEqual({ label: SCHEDULE_TEMPLATES.find((entry) => entry.id === 'workday-morning')!.label })
  })

  it('lists the days and hours of a custom schedule, and of a template whose rule no longer matches', () => {
    expect(scheduleTimingLabel(item({ cron: '0 8 * * 1,3', editorMetadata: { mode: 'custom', weekdays: [1, 3], hours: [8] } })))
      .toEqual({ label: 'Custom', detail: scheduleRuleSummary({ weekdays: [1, 3], hours: [8] }) })
    expect(scheduleTimingLabel(item({ cron: '0 7 * * 1-5', editorMetadata: { mode: 'template', templateId: 'workday-morning', templateVersion: 1, weekdays: [1, 2, 3, 4, 5], hours: [7] } })))
      .toEqual({ label: 'Custom', detail: scheduleRuleSummary({ weekdays: [1, 2, 3, 4, 5], hours: [7] }) })
  })

  it('shows the cron text of an advanced schedule, and of one whose stored days and hours are stale', () => {
    expect(scheduleTimingLabel(item())).toEqual({ label: 'Cron', detail: '15 */2 1,15 2-11 1-5', mono: true })
    expect(scheduleTimingLabel(item({ editorMetadata: { mode: 'custom', weekdays: [1], hours: [8] } }))).toEqual({ label: 'Cron', detail: '15 */2 1,15 2-11 1-5', mono: true })
  })
})
