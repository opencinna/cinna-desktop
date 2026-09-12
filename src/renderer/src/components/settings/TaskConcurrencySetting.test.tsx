import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const HEALTHY = { data: { taskRunnerConcurrency: 2 }, isError: false }
let settings: { data?: { taskRunnerConcurrency: number }; isError: boolean } = HEALTHY
beforeEach(() => {
  settings = HEALTHY
})
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => settings,
  useSetAppSetting: () => ({ mutateAsync: vi.fn(async () => undefined), isPending: false })
}))

const { TaskConcurrencySetting } = await import('./TaskConcurrencySetting')

/**
 * The card is a label, a `(?)` and a select. The explanation is behind the tip,
 * and the read error is the only thing under the control — rendered only when
 * it exists, with nothing reserved for it (ux_rules rules 1 and 12).
 */
describe('TaskConcurrencySetting', () => {
  it('keeps the explanation behind the tip and shows no alert when healthy', () => {
    render(<TaskConcurrencySetting />)

    expect(screen.getByLabelText('Autonomous task concurrency').tagName).toBe('SELECT')
    expect(screen.queryByText(/Limit how many tasks/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'About Autonomous task concurrency' }))
    expect(screen.getByText(/Limit how many tasks and agent turns/)).toBeTruthy()
  })

  it('renders the read error as an alert only when the read failed', () => {
    settings = { data: undefined, isError: true }
    render(<TaskConcurrencySetting />)

    expect(screen.getByRole('alert').textContent).toBe('The current limit could not be read.')
  })
})
