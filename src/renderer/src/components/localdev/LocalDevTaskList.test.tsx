import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LocalDevTaskList } from './LocalDevTaskList'
import type { LocalDevTask } from '../../../../shared/localDevState'

/**
 * The list's whole job is answering "what else is coming" while one thing
 * downloads. So the assertions are about what is on screen *at once* — every
 * component, including the ones not started — and about the bar appearing on
 * exactly the row that is moving.
 */
const MID_INSTALL: LocalDevTask[] = [
  { id: 'uv', label: 'uv', status: 'done', percent: 100 },
  {
    id: 'mutagen',
    label: 'Mutagen',
    status: 'active',
    detail: 'Downloading Mutagen — 12.4 of 47.1 MB',
    percent: 26
  },
  { id: 'cinna-cli', label: 'cinna-cli', status: 'pending' },
  { id: 'workspace', label: 'Account workspace', status: 'pending' },
  { id: 'token', label: 'Account token', status: 'pending' }
]

describe('LocalDevTaskList', () => {
  it('shows every component at once, including the ones not started', () => {
    render(<LocalDevTaskList tasks={MID_INSTALL} />)
    for (const label of ['uv', 'Mutagen', 'cinna-cli', 'Account workspace', 'Account token']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('puts the percentage on the row that is moving, and only there', () => {
    render(<LocalDevTaskList tasks={MID_INSTALL} />)
    // One percentage on screen: Mutagen's. A finished row shows a tick, not
    // "100%", and a pending row shows nothing — otherwise the eye cannot find
    // the number that is actually changing.
    expect(screen.getByText('26%')).toBeTruthy()
    expect(screen.queryByText('100%')).toBeNull()
  })

  it('shows no bar for a component with nothing honest to measure', () => {
    const { container } = render(
      <LocalDevTaskList
        tasks={[{ id: 'token', label: 'Account token', status: 'active', detail: 'Checking…' }]}
      />
    )
    // A bar that never moves is exactly what this list exists to remove.
    expect(container.querySelectorAll('[style*="width"]')).toHaveLength(0)
    expect(screen.getByText('Checking…')).toBeTruthy()
  })

  it('renders a failure on its own row, in the danger colour', () => {
    render(
      <LocalDevTaskList
        tasks={[
          { id: 'uv', label: 'uv', status: 'done', percent: 100 },
          {
            id: 'mutagen',
            label: 'Mutagen',
            status: 'failed',
            detail: 'Mutagen 0.18.1 could not be verified.'
          },
          { id: 'cinna-cli', label: 'cinna-cli', status: 'pending' }
        ]}
      />
    )
    const detail = screen.getByText('Mutagen 0.18.1 could not be verified.')
    expect(detail.className).toContain('--color-danger')
    // The steps after a failure stay pending rather than being marked done —
    // they genuinely did not run.
    expect(screen.getByText('cinna-cli')).toBeTruthy()
  })
})
