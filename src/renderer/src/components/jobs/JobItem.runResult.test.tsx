import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { JobData } from '../../../../shared/jobs'
import type { ChatRunResult } from '../../../../shared/chatRunResult'

/**
 * The job row's unread-result icon: the latest run's result, drawn like a chat
 * row's, in the row's one 16px trailing slot. Precedence in that slot:
 * spinner > red incomplete-setup marker > run-now (hover) > result > amber.
 */

vi.mock('../../hooks/useJobs', () => ({
  useExecuteJob: () => ({ mutate: vi.fn(), isPending: false })
}))
vi.mock('../../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ activeJobId: null, activeView: 'jobs', setActiveJobId: () => undefined, setActiveView: () => undefined })
}))

const { JobItem } = await import('./JobItem')

const unread = (status: ChatRunResult['status']): ChatRunResult => ({ runId: 'turn-1', status, unread: true })

function job(over: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1', userId: 'u', type: 'local', title: 'Nightly check', description: null, prompt: 'p',
    agentId: null, modeId: null, cinnaAgentId: null, cinnaPriority: null, colorPreset: null, iconName: null,
    folderId: null, position: 0, deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    inProgressRunsCount: 0, needsSetup: false, incompleteSetup: false, lastRunResult: null,
    ...over
  }
}

const row = (): HTMLElement => screen.getByText('Nightly check').parentElement as HTMLElement
/** Everything after the title: the trailing slot, which must hold at most one element. */
const trailing = (): Element[] => Array.from(row().children).slice(1)

describe('a job whose latest result is unread', () => {
  it.each([
    ['completed', 'Completed — unread results', '--color-success'],
    ['needs_input', 'Needs input — unread results', '--color-warning'],
    ['failed', 'Failed — unread results', '--color-danger']
  ] as const)('shows the chat rows\' %s icon', (status, label, colour) => {
    render(<JobItem job={job({ lastRunResult: unread(status) })} />)
    const icon = screen.getByRole('img', { name: label })
    expect(icon.parentElement!.className).toContain(colour)
    expect(trailing()).toHaveLength(1)
  })

  it('shows nothing for a canceled result', () => {
    render(<JobItem job={job({ lastRunResult: { runId: 'r', status: 'canceled', unread: true } })} />)
    expect(trailing()).toHaveLength(0)
  })

  it('shows nothing once read', () => {
    render(<JobItem job={job({ lastRunResult: { runId: 'r', status: 'completed', unread: false } })} />)
    expect(trailing()).toHaveLength(0)
  })

  it('yields to the spinner while a run is in progress', () => {
    render(<JobItem job={job({ lastRunResult: unread('completed'), inProgressRunsCount: 1 })} />)
    expect(screen.queryByRole('img', { name: 'Completed — unread results' })).toBeNull()
    expect(screen.getByLabelText('Running')).toBeTruthy()
    expect(trailing()).toHaveLength(1)
  })

  it('yields to the run-now button on hover, and comes back after', () => {
    render(<JobItem job={job({ lastRunResult: unread('failed') })} />)
    fireEvent.mouseEnter(row())
    expect(screen.queryByRole('img', { name: 'Failed — unread results' })).toBeNull()
    // The icon's label moves to the button's tooltip, as on chat rows.
    expect(screen.getByLabelText('Run this job').getAttribute('title')).toBe('Failed — unread results · Run this job')
    expect(trailing()).toHaveLength(1)
    fireEvent.mouseLeave(row())
    expect(screen.getByRole('img', { name: 'Failed — unread results' })).toBeTruthy()
  })

  it('yields to the red incomplete-setup marker, hovered or not', () => {
    render(<JobItem job={job({ lastRunResult: unread('completed'), incompleteSetup: true })} />)
    expect(screen.getByLabelText('Incomplete setup')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Completed — unread results' })).toBeNull()
    fireEvent.mouseEnter(row())
    expect(screen.getByLabelText('Incomplete setup')).toBeTruthy()
    expect(trailing()).toHaveLength(1)
  })

  it('takes the slot from the amber needs-setup marker', () => {
    render(<JobItem job={job({ lastRunResult: unread('needs_input'), needsSetup: true })} />)
    expect(screen.getByRole('img', { name: 'Needs input — unread results' })).toBeTruthy()
    expect(screen.queryByLabelText('Needs setup')).toBeNull()
    expect(trailing()).toHaveLength(1)
  })
})
