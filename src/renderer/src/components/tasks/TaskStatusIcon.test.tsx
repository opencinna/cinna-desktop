import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskStatusIcon } from './TaskStatusIcon'

/**
 * The status icon at the head of a Recent tasks row.
 *
 * The mapping is the whole component, and until this file it was covered only
 * sideways, through the row names in `RecentTasks.test.tsx` — which carry the
 * status *word* and would pass with every icon drawn the same grey circle. What
 * is asserted here is the component's own contract: the pill's severity
 * colours, one spinning state, a distinct shape per decided status, nothing
 * dropped for a word this build does not know, and silence to a screen reader.
 *
 * Shapes are compared by markup rather than by lucide's class names, which
 * change between releases of the icon set and are not this component's to
 * promise.
 */

afterEach(cleanup)

function iconFor(status: string): SVGElement {
  const { container } = render(createElement(TaskStatusIcon, { status }))
  const svg = container.querySelector('svg')
  if (!svg) throw new Error(`no icon rendered for "${status}"`)
  return svg
}

/** `className` on an SVG element is an `SVGAnimatedString`, not a string. */
function classesOf(svg: SVGElement): string {
  return svg.getAttribute('class') ?? ''
}

describe('TaskStatusIcon', () => {
  it('colours a status by its outcome, with the pill’s own severity variables', () => {
    // Mutation: swap any two tones in `describe` and one of these fails — a
    // failed task drawn in the colour of a finished one, in the one list whose
    // point is telling them apart at a glance.
    const cases: [string, string][] = [
      ['completed', 'text-[var(--color-severity-ok-text)]'],
      ['succeeded', 'text-[var(--color-severity-ok-text)]'],
      ['error', 'text-[var(--color-severity-error-text)]'],
      ['failed', 'text-[var(--color-severity-error-text)]'],
      ['blocked', 'text-[var(--color-severity-warning-text)]'],
      ['in_progress', 'text-[var(--color-severity-info-text)]'],
      ['cancelled', 'text-[var(--color-text-muted)]'],
      ['archived', 'text-[var(--color-text-muted)]']
    ]
    for (const [status, tone] of cases) {
      expect(classesOf(iconFor(status)), status).toContain(tone)
    }
  })

  it('spins only while the task is running', () => {
    // A spinner is the one icon that draws the eye on its own; on a finished
    // row it would claim work is still happening.
    expect(classesOf(iconFor('in_progress'))).toContain('animate-spin')
    for (const status of ['completed', 'error', 'blocked', 'cancelled', 'archived', 'new']) {
      expect(classesOf(iconFor(status)), status).not.toContain('animate-spin')
    }
  })

  it('gives each decided status a shape of its own', () => {
    // Mutation: collapse two statuses onto one icon and the set shrinks —
    // colour alone would then carry the difference, which is the weakness the
    // shape exists to cover.
    const decided = ['completed', 'error', 'blocked', 'in_progress', 'cancelled', 'archived', 'new']
    const shapes = new Set(decided.map((status) => iconFor(status).innerHTML))
    expect(shapes.size).toBe(decided.length)
  })

  it('never drops a status this build does not know', () => {
    // A replica of a remote task can carry a status newer than this build. It
    // gets the neutral "nothing has happened yet" outline — the same honest
    // answer as `new` — rather than no icon, or the nearest tone that happens
    // to look decided.
    const unknown = iconFor('awaiting_review')
    expect(classesOf(unknown)).toContain('text-[var(--color-severity-info-text)]')
    expect(unknown.innerHTML).toBe(iconFor('new').innerHTML)
  })

  it('reads the status case-insensitively, as the pill does', () => {
    expect(classesOf(iconFor('COMPLETED'))).toContain('text-[var(--color-severity-ok-text)]')
    expect(classesOf(iconFor('In_Progress'))).toContain('animate-spin')
  })

  it('says nothing to a screen reader, because the row’s name already does', () => {
    // Mutation: drop `aria-hidden` and the status is announced twice — once in
    // the row's name (`<title> — <status>`), once by the icon.
    for (const status of ['completed', 'error', 'blocked', 'in_progress', 'cancelled', 'archived', 'new', 'awaiting_review']) {
      expect(iconFor(status).getAttribute('aria-hidden'), status).toBe('true')
    }
  })
})
