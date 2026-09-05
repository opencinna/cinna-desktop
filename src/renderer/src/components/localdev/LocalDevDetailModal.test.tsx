import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { LocalDevState } from '../../../../shared/localDevState'

/**
 * The modal exists to answer two questions a spinner cannot: *how far along*
 * and *which part broke*. Both are asserted here, because both are the kind of
 * thing a refactor quietly drops — a checklist that renders but never marks
 * anything failed still looks perfectly fine in a screenshot.
 */
const repair = vi.fn()
const openWorkspace = vi.fn()

;(window as unknown as { api: Record<string, unknown> }).api = {
  localDev: {
    getState: async () => ({ phase: 'idle' }),
    onState: () => () => undefined
  }
}

const { LocalDevDetailModal } = await import('./LocalDevDetailModal')
const { useLocalDevStore } = await import('../../stores/localDev.store')

function withState(state: LocalDevState): void {
  useLocalDevStore.setState({ state, subscribed: true, repair, openWorkspace } as never)
}

beforeEach(() => {
  repair.mockReset()
  openWorkspace.mockReset()
})

describe('LocalDevDetailModal', () => {
  it('lists every task with its state, and shows the percentage while installing', () => {
    withState({
      phase: 'installing',
      step: 'Downloading Mutagen — 12.4 of 47.1 MB',
      percent: 31,
      tasks: [
        { id: 'uv', label: 'uv', status: 'done' },
        {
          id: 'mutagen',
          label: 'Mutagen',
          status: 'active',
          detail: 'Downloading Mutagen — 12.4 of 47.1 MB'
        },
        { id: 'cinna-cli', label: 'cinna-cli', status: 'pending' },
        { id: 'workspace', label: 'Account workspace', status: 'pending' },
        { id: 'token', label: 'Account token', status: 'pending' }
      ]
    })
    render(<LocalDevDetailModal onClose={() => undefined} />)

    expect(screen.getByText('uv')).toBeTruthy()
    expect(screen.getByText('Account workspace')).toBeTruthy()
    // The number, not just the bar: a bar moving a pixel a second is
    // indistinguishable from a stuck one.
    expect(screen.getByText('31%')).toBeTruthy()
    expect(screen.getAllByText('Downloading Mutagen — 12.4 of 47.1 MB').length).toBeGreaterThan(0)
  })

  it('names the step that failed rather than only the overall complaint', () => {
    withState({
      phase: 'attention',
      reason: 'toolchain',
      detail: 'Mutagen 0.18.1 could not be verified.',
      tasks: [
        { id: 'uv', label: 'uv', status: 'done' },
        {
          id: 'mutagen',
          label: 'Mutagen',
          status: 'failed',
          detail: 'Mutagen 0.18.1 could not be verified.'
        },
        { id: 'cinna-cli', label: 'cinna-cli', status: 'pending' },
        { id: 'workspace', label: 'Account workspace', status: 'pending' },
        { id: 'token', label: 'Account token', status: 'pending' }
      ]
    })
    render(<LocalDevDetailModal onClose={() => undefined} />)

    expect(screen.getByText('Mutagen')).toBeTruthy()
    // Once in the header, once on the failing row — the row is what says
    // *which* of the five steps stopped the run.
    expect(screen.getAllByText('Mutagen 0.18.1 could not be verified.')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /repair/i })).toBeTruthy()
  })

  it('offers no Repair mid-install, so a click cannot restart a running job', () => {
    withState({ phase: 'installing', step: 'Installing cinna-cli', percent: 60, tasks: [] })
    render(<LocalDevDetailModal onClose={() => undefined} />)
    expect(screen.queryByRole('button', { name: /repair/i })).toBeNull()
  })

  it('says plainly that nothing has been set up rather than showing empty rows', () => {
    withState({ phase: 'idle' })
    render(<LocalDevDetailModal onClose={() => undefined} />)
    expect(screen.getByText('Nothing has been set up yet.')).toBeTruthy()
  })
})
