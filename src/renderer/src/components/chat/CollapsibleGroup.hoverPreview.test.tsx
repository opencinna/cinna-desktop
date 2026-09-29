import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '../../../../shared/messageParts'
import { useUIStore } from '../../stores/ui.store'
import { AgentContribution } from './AgentContribution'
import { CollapsibleGroup, DOT_PREVIEW_OPEN_DELAY_MS, DOT_PREVIEW_SWITCH_DELAY_MS, type CollapsibleGroupItem } from './CollapsibleGroup'
import { HOVER_CLOSE_DELAY_MS } from '../ui/useHoverPopover'

/** Two steps, each a call and its output: four dots in one group. */
const parts: MessagePart[] = [
  { kind: 'tool', toolId: 't1', toolName: 'Bash', toolInput: { command: 'npm test' }, text: 'Run the tests' },
  { kind: 'tool_result', toolId: 't1', toolStream: 'stdout', text: '42 passed' },
  { kind: 'tool', toolId: 't2', toolName: 'Read', toolInput: { file_path: '/src/app.ts' }, text: '' },
  { kind: 'tool_result', toolId: 't2', toolStream: 'stderr', text: 'ENOENT' }
]

const dots = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-step-dot]'))
const previewed = (): number[] => dots().flatMap((d, i) => (d.hasAttribute('data-previewed') ? [i] : []))
const tooltip = (): HTMLElement | null => screen.queryByRole('tooltip')
const header = (): HTMLElement => screen.getByRole('button', { name: 'Expand 4 steps' })

function hover(dot: HTMLElement): void {
  fireEvent.mouseEnter(dot)
  act(() => {
    vi.advanceTimersByTime(DOT_PREVIEW_OPEN_DELAY_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  useUIStore.setState({ verboseMode: false })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('compact dots: hover preview', () => {
  it('waits before opening, then shows the call with its paired output and marks both dots', () => {
    render(<AgentContribution parts={parts} />)
    fireEvent.mouseEnter(dots()[0])
    act(() => {
      vi.advanceTimersByTime(DOT_PREVIEW_OPEN_DELAY_MS - 50)
    })
    expect(tooltip()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(50)
    })
    const tip = tooltip()!
    expect(tip.textContent).toContain('Bash')
    expect(tip.textContent).toContain('npm test')
    expect(tip.textContent).toContain('Run the tests')
    expect(tip.textContent).toContain('42 passed')
    expect(previewed()).toEqual([0, 1])
    // The call half is the hovered one; its output is context.
    expect(tip.querySelector('[data-preview-section="call"]')!.hasAttribute('data-dimmed')).toBe(false)
    expect(tip.querySelector('[data-preview-section="output"]')!.hasAttribute('data-dimmed')).toBe(true)
    expect(header().getAttribute('aria-describedby')).toBe(tip.id)
    expect(header().getAttribute('aria-label')).toBe('Expand 4 steps')
  })

  it('hovering the output dot shows the call too', () => {
    render(<AgentContribution parts={parts} />)
    hover(dots()[1])
    const tip = tooltip()!
    expect(tip.textContent).toContain('npm test')
    expect(tip.textContent).toContain('42 passed')
    expect(previewed()).toEqual([0, 1])
    expect(tip.querySelector('[data-preview-section="call"]')!.hasAttribute('data-dimmed')).toBe(true)
  })

  it('switches after a short rest when the pointer moves to another dot', () => {
    render(<AgentContribution parts={parts} />)
    hover(dots()[0])
    fireEvent.mouseLeave(dots()[0])
    fireEvent.mouseEnter(dots()[3])
    // Not the open delay the second time: only the short switch rest.
    act(() => {
      vi.advanceTimersByTime(DOT_PREVIEW_SWITCH_DELAY_MS)
    })
    const tip = tooltip()!
    expect(tip.textContent).toContain('/src/app.ts')
    expect(tip.textContent).toContain('ENOENT')
    expect(tip.textContent).not.toContain('npm test')
    expect(previewed()).toEqual([2, 3])
    // And it stays past the close delay while the pointer is on a dot.
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2)
    })
    expect(tooltip()).not.toBeNull()
  })

  it('closes after the delay once the pointer has left the dots, and stays while it is inside the tooltip', () => {
    render(<AgentContribution parts={parts} />)
    hover(dots()[0])
    fireEvent.mouseLeave(dots()[0])
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 10)
    })
    // Crossed onto the tooltip in time.
    fireEvent.pointerMove(tooltip()!)
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2)
    })
    expect(tooltip()).not.toBeNull()
    fireEvent.mouseLeave(tooltip()!)
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 10)
    })
    expect(tooltip()).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(tooltip()).toBeNull()
    expect(previewed()).toEqual([])
  })

  it('a pointer that passes over a dot without resting opens nothing', () => {
    render(<AgentContribution parts={parts} />)
    fireEvent.mouseEnter(dots()[0])
    fireEvent.mouseLeave(dots()[0])
    act(() => {
      vi.advanceTimersByTime(DOT_PREVIEW_OPEN_DELAY_MS * 2)
    })
    expect(tooltip()).toBeNull()
  })

  it('arrow keys on the focused header move the preview; Escape and blur close it', () => {
    render(<AgentContribution parts={parts} />)
    const button = header()
    button.focus()
    fireEvent.keyDown(button, { key: 'ArrowRight' })
    expect(tooltip()!.textContent).toContain('npm test')
    expect(previewed()).toEqual([0, 1])
    fireEvent.keyDown(button, { key: 'ArrowRight' })
    fireEvent.keyDown(button, { key: 'ArrowRight' })
    expect(tooltip()!.textContent).toContain('/src/app.ts')
    expect(previewed()).toEqual([2, 3])
    fireEvent.keyDown(button, { key: 'ArrowLeft' })
    expect(tooltip()!.textContent).toContain('npm test')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(tooltip()).toBeNull()

    fireEvent.keyDown(button, { key: 'ArrowLeft' })
    expect(tooltip()!.textContent).toContain('ENOENT')
    fireEvent.blur(button)
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS)
    })
    expect(tooltip()).toBeNull()
  })

  it('expanding the group closes the preview, and clicking a dot still expands it', () => {
    render(<AgentContribution parts={parts} />)
    hover(dots()[0])
    expect(tooltip()).not.toBeNull()
    fireEvent.click(dots()[0])
    expect(screen.getByRole('button', { name: 'Collapse 4 steps' }).getAttribute('aria-expanded')).toBe('true')
    expect(tooltip()).toBeNull()
    fireEvent.mouseEnter(dots()[1])
    act(() => {
      vi.advanceTimersByTime(DOT_PREVIEW_OPEN_DELAY_MS)
    })
    expect(tooltip()).toBeNull()
  })

  it('a live call with no output yet reads Running…; a finished empty result reads No output', () => {
    const live: MessagePart[] = [
      { kind: 'tool', toolId: 'e', toolName: 'Bash', toolInput: { command: 'true' }, text: '' },
      { kind: 'tool_result', toolId: 'e', toolStream: 'stdout', text: '' },
      { kind: 'tool', toolId: 'r', toolName: 'Bash', toolInput: { command: 'sleep 9' }, text: '' }
    ]
    render(<AgentContribution parts={live} isStreaming />)
    hover(dots()[2])
    expect(tooltip()!.textContent).toContain('Running…')
    fireEvent.mouseLeave(dots()[2])
    fireEvent.mouseEnter(dots()[0])
    act(() => {
      vi.advanceTimersByTime(DOT_PREVIEW_SWITCH_DELAY_MS)
    })
    expect(tooltip()!.textContent).toContain('No output')
  })

  it('cuts a long output to its head and says how much is left', () => {
    const long = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n')
    render(
      <AgentContribution
        parts={[
          { kind: 'tool', toolId: 'l', toolName: 'Bash', toolInput: { command: 'seq 100' }, text: '' },
          { kind: 'tool_result', toolId: 'l', toolStream: 'stdout', text: long }
        ]}
      />
    )
    hover(dots()[1])
    const text = tooltip()!.textContent!
    expect(text).toContain('row 14')
    expect(text).not.toContain('row 15')
    expect(text).toContain('85 more lines')
  })

  it('closes when the previewed step goes away under the pointer, and stops taking Escape', () => {
    const item = (key: string, text: string): CollapsibleGroupItem => ({
      key, kind: 'tool_result', status: 'done', node: <span />,
      preview: () => ({ hasCall: false, status: 'done', output: text })
    })
    const { rerender } = render(<CollapsibleGroup items={[item('a', 'first'), item('stream-1', 'second')]} />)
    hover(dots()[1])
    expect(tooltip()!.textContent).toContain('second')
    // The turn is saved: the live key becomes the message's, with no mouseleave.
    rerender(<CollapsibleGroup items={[item('a', 'first'), item('m-1', 'second')]} />)
    expect(tooltip()).toBeNull()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
  })

  it('crossing a dot on the way into the preview leaves it on the step it showed', () => {
    render(<AgentContribution parts={parts} />)
    hover(dots()[0])
    fireEvent.mouseLeave(dots()[0])
    fireEvent.mouseEnter(dots()[2])
    act(() => {
      vi.advanceTimersByTime(DOT_PREVIEW_SWITCH_DELAY_MS - 30)
    })
    fireEvent.mouseLeave(dots()[2])
    fireEvent.pointerMove(tooltip()!)
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2)
    })
    expect(tooltip()!.textContent).toContain('npm test')
    expect(previewed()).toEqual([0, 1])
  })
})
