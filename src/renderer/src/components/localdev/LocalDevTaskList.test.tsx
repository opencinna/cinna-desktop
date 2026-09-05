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
  // A measurable component is pending *at zero* — the reconciler sends the
  // whole checklist with its tracks from the first frame. The account token is
  // the one row with nothing to measure, so it has no percentage at all.
  { id: 'cinna-cli', label: 'cinna-cli', status: 'pending', percent: 0 },
  { id: 'workspace', label: 'Account workspace', status: 'pending', percent: 0 },
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

  it('keeps a track under every measurable row, whatever it is doing', () => {
    // Four of the five rows can be measured, and each has its track from the
    // first frame: empty while pending, filling while active, full when done.
    // Bars that appear as each row starts make the list reflow under the user
    // precisely while they are reading how much is left.
    const { container } = render(<LocalDevTaskList tasks={MID_INSTALL} />)
    const widths = [...container.querySelectorAll<HTMLElement>('[style*="width"]')].map(
      (el) => el.style.width
    )
    expect(widths).toEqual(['100%', '26%', '0%', '0%'])
  })

  it('shows several components in flight at once', () => {
    // uv, Mutagen and cinna-cli install concurrently, so more than one row
    // spinning is the list working rather than a glitch.
    render(
      <LocalDevTaskList
        tasks={[
          { id: 'mutagen', label: 'Mutagen', status: 'active', percent: 26 },
          { id: 'cinna-cli', label: 'cinna-cli', status: 'active', percent: 8 }
        ]}
      />
    )
    expect(screen.getByText('26%')).toBeTruthy()
    expect(screen.getByText('8%')).toBeTruthy()
  })

  it('does not paint a stalled component as if it were still working', () => {
    // When one component fails the others stop, keeping whatever they had
    // actually downloaded. An accent bar there would say "this part is fine and
    // still going" next to a row saying the run stopped.
    const { container } = render(
      <LocalDevTaskList
        tasks={[
          { id: 'uv', label: 'uv', status: 'failed', detail: 'nope', percent: 10 },
          { id: 'mutagen', label: 'Mutagen', status: 'pending', percent: 42 }
        ]}
      />
    )
    const fills = [...container.querySelectorAll<HTMLElement>('[style*="width"]')]
    expect(fills[0]?.className).toContain('--color-danger')
    expect(fills[1]?.className).toContain('--color-text-muted')
    expect(fills[1]?.style.width).toBe('42%')
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
            detail: 'Mutagen 0.18.1 could not be verified.',
            percent: 42
          },
          { id: 'cinna-cli', label: 'cinna-cli', status: 'pending', percent: 0 }
        ]}
      />
    )
    const detail = screen.getByText('Mutagen 0.18.1 could not be verified.')
    expect(detail.className).toContain('--color-danger')
    // The steps after a failure stay pending rather than being marked done —
    // they genuinely did not run.
    expect(screen.getByText('cinna-cli')).toBeTruthy()
    // A failed row keeps its track, in the danger colour, rather than dropping
    // it and letting the list jump.
    expect(detail.parentElement?.querySelector('.bg-\\[var\\(--color-danger\\)\\]')).toBeTruthy()
  })
})
