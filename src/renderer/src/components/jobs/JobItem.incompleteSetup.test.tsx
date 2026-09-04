import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { JobData } from '../../../../shared/jobs'

/**
 * The sidebar row's trailing slot, and the one thing that must never be hidden
 * in it.
 *
 * The slot is shared on purpose: warning, run-now button and run spinner all
 * live in the same 16px box so the row height never changes between states,
 * and the warning is suppressed on hover precisely so a resting row stays
 * clean. That rule was written for a warning that meant "a dependency still
 * needs configuring" — advisory, and the run was fine either way.
 *
 * It is wrong for a job that *cannot run on this device*. Hovering is when the
 * run-now button appears, so the old gate hid the reason not to click at the
 * exact moment the user was reaching for the button — and the click then went
 * to a main process that had no gate at all, spawned an agentless chat, and
 * recorded success.
 *
 * So the two warnings are separated here rather than merged: the advisory one
 * keeps its hover suppression (that is what the comment above the slot is
 * protecting, and the test below holds it in place), and the blocking one does
 * not get it.
 */

const executeMutate = vi.hoisted(() => vi.fn())

vi.mock('../../hooks/useJobs', () => ({
  useExecuteJob: () => ({ mutate: executeMutate, isPending: false })
}))
vi.mock('../../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeJobId: null,
      activeView: 'jobs',
      setActiveJobId: () => undefined,
      setActiveView: () => undefined
    })
}))

const { JobItem } = await import('./JobItem')

function job(over: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    userId: 'u',
    type: 'local',
    title: 'Nightly check',
    description: null,
    prompt: 'Check the invoices',
    agentId: null,
    modeId: null,
    cinnaAgentId: null,
    cinnaPriority: null,
    colorPreset: null,
    iconName: null,
    folderId: null,
    position: 0,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    inProgressRunsCount: 0,
    needsSetup: false,
    incompleteSetup: false,
    ...over
  }
}

function row(): HTMLElement {
  return screen.getByText('Nightly check').parentElement as HTMLElement
}

beforeEach(() => {
  executeMutate.mockClear()
})

describe('a job the device cannot run', () => {
  it('keeps its warning visible while the row is hovered', () => {
    // The whole defect, in one assertion. Hover is when the user is about to
    // click Run; it is the last moment the warning may disappear.
    render(<JobItem job={job({ incompleteSetup: true })} />)
    fireEvent.mouseEnter(row())
    expect(screen.getByLabelText('Incomplete setup')).toBeTruthy()
  })

  it('shows the warning at rest too', () => {
    render(<JobItem job={job({ incompleteSetup: true })} />)
    expect(screen.getByLabelText('Incomplete setup')).toBeTruthy()
  })

  it('offers no run-now button to click', () => {
    render(<JobItem job={job({ incompleteSetup: true })} />)
    fireEvent.mouseEnter(row())
    expect(screen.queryByLabelText('Run this job')).toBeNull()
    expect(executeMutate).not.toHaveBeenCalled()
  })

  it('says it cannot run here, not that something needs configuring', () => {
    // The two states have different repairs — one is a click inside the app,
    // the other is copying a directory onto the machine — so they must not
    // read the same.
    render(<JobItem job={job({ incompleteSetup: true })} />)
    expect(screen.getByLabelText('Incomplete setup').getAttribute('title')).toBe(
      "Incomplete setup — this job can't run on this device"
    )
  })

  it('yields the slot to the run spinner while a run is in progress', () => {
    // A run already under way is the one case where the warning has nothing
    // left to prevent, and the spinner is the more useful thing to show.
    render(<JobItem job={job({ incompleteSetup: true, inProgressRunsCount: 1 })} />)
    expect(screen.queryByLabelText('Incomplete setup')).toBeNull()
    expect(screen.getByLabelText('Running')).toBeTruthy()
  })
})

/**
 * The behaviour the fix must NOT take with it. `needsSetup` is true for a
 * disabled MCP shell and other finish-in-app cases; those jobs run fine, and
 * the hover suppression is what keeps a sidebar full of them from looking
 * alarming at rest.
 */
describe('a job that merely needs configuring', () => {
  it('still hides its amber warning on hover, and offers the run button', () => {
    render(<JobItem job={job({ needsSetup: true })} />)
    expect(screen.getByLabelText('Needs setup')).toBeTruthy()
    fireEvent.mouseEnter(row())
    expect(screen.queryByLabelText('Needs setup')).toBeNull()
    expect(screen.getByLabelText('Run this job')).toBeTruthy()
  })

  it('runs when the button is clicked', () => {
    render(<JobItem job={job({ needsSetup: true })} />)
    fireEvent.mouseEnter(row())
    fireEvent.click(screen.getByLabelText('Run this job'))
    expect(executeMutate).toHaveBeenCalledWith({ jobId: 'job-1', navigate: false })
  })
})

describe('an ordinary job', () => {
  it('shows no warning at all, and runs on click', () => {
    render(<JobItem job={job()} />)
    expect(screen.queryByLabelText('Incomplete setup')).toBeNull()
    expect(screen.queryByLabelText('Needs setup')).toBeNull()
    fireEvent.mouseEnter(row())
    fireEvent.click(screen.getByLabelText('Run this job'))
    expect(executeMutate).toHaveBeenCalledTimes(1)
  })
})
