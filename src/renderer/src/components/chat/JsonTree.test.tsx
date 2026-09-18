import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CHILD_PAGE, EXPAND_ALL_LIMIT, JsonTree, parseJsonForTree, type JsonValue } from './JsonTree'

const DOC: JsonValue = {
  name: 'forecast',
  count: 3,
  ok: true,
  none: null,
  link: 'https://example.com/x',
  tags: ['a', 'b'],
  owner: { team: { lead: 'Ann' } },
  empty: {}
}

const text = (): string => screen.getByTestId('json-tree').textContent ?? ''

describe('JsonTree', () => {
  it('colours each token with the code-block palette', () => {
    const { container } = render(<JsonTree value={DOC} />)
    expect(container.querySelector('.hljs-name')?.textContent).toBe('"name"')
    expect(container.querySelector('.hljs-string')?.textContent).toBe('"forecast"')
    expect(container.querySelector('.hljs-number')?.textContent).toBe('3')
    expect([...container.querySelectorAll('.hljs-literal')].map((n) => n.textContent)).toEqual(['true', 'null'])
    expect(screen.getByRole('link', { name: 'https://example.com/x' }).getAttribute('target')).toBe('_blank')
    expect(text()).toContain('"empty": {}')
  })

  it('folds a node on its chevron, with a count in its place, and unfolds it again', () => {
    render(<JsonTree value={DOC} />)
    expect(text()).toContain('"lead": "Ann"')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse owner' }))
    expect(text()).not.toContain('Ann')
    expect(text()).toContain('"owner": { … },1 key')
    fireEvent.click(screen.getByRole('button', { name: 'Expand owner' }))
    expect(text()).toContain('"lead": "Ann"')
  })

  it('folds and unfolds a whole branch on Alt-click', () => {
    render(<JsonTree value={DOC} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse owner' }), { altKey: true })
    // Unfolding only the top leaves the nested object folded too.
    fireEvent.click(screen.getByRole('button', { name: 'Expand owner' }))
    expect(screen.getByRole('button', { name: 'Expand team' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse owner' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand owner' }), { altKey: true })
    expect(text()).toContain('"lead": "Ann"')
  })

  it('opens a large document with only its top level unfolded', () => {
    const rows = Array.from({ length: EXPAND_ALL_LIMIT }, (_, i) => ({ id: i }))
    render(<JsonTree value={{ rows, meta: { v: 1 } }} />)
    expect(screen.getByRole('button', { name: 'Expand rows' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand meta' })).toBeTruthy()
  })

  it('names array items by index and keeps the folded braces out of the tab order', () => {
    render(<JsonTree value={{ targets: [{ a: 1 }, { b: 2 }] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse item 1' }))
    expect(screen.getByRole('button', { name: 'Expand item 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Collapse item 0' })).toBeTruthy()
    // Only the chevron is reachable; the `{ … }` shortcut is pointer-only.
    expect(screen.queryByRole('button', { name: '{ … }' })).toBeNull()
  })

  it('keeps the clicked row where it was when a fold shortens the scrolled content', () => {
    // jsdom has no layout, so drive the geometry: the row sits at y=400
    // before the fold and would land at y=416 after the browser clamps.
    render(
      <div style={{ overflowY: 'auto' }} data-testid="scroller">
        <JsonTree value={DOC} />
      </div>
    )
    const scroller = screen.getByTestId('scroller')
    scroller.scrollTop = 100
    const row = screen.getByRole('button', { name: 'Collapse owner' }).closest('[data-json-row]') as HTMLElement
    // First read is before the fold, every later one after it.
    const tops = [400]
    row.getBoundingClientRect = () => ({ top: tops.shift() ?? 416 }) as DOMRect
    fireEvent.click(screen.getByRole('button', { name: 'Collapse owner' }))
    expect(scroller.scrollTop).toBe(116)
  })

  it('holds a floor under the tree so the browser cannot clamp the scroll back', () => {
    // Scrolled to the very end (no slack below the viewport): a 1000px tree
    // folding to 300px must keep its 1000px, or the scroll position is lost.
    render(
      <div style={{ overflowY: 'auto' }} data-testid="scroller">
        <JsonTree value={DOC} />
      </div>
    )
    const scroller = screen.getByTestId('scroller')
    const tree = screen.getByTestId('json-tree')
    Object.defineProperty(scroller, 'scrollHeight', { value: 1100 })
    Object.defineProperty(scroller, 'clientHeight', { value: 500 })
    scroller.scrollTop = 600
    const heights = [1000]
    Object.defineProperty(tree, 'offsetHeight', { get: () => heights.shift() ?? 300 })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse owner' }))
    expect(tree.style.minHeight).toBe('1000px')
  })

  it('shows a huge container a page at a time', () => {
    const numbers = Array.from({ length: CHILD_PAGE * 2 + 5 }, (_, i) => i)
    render(<JsonTree value={numbers} />)
    expect(document.querySelectorAll('.hljs-number')).toHaveLength(CHILD_PAGE)
    fireEvent.click(screen.getByRole('button', { name: `Show ${CHILD_PAGE} more of ${CHILD_PAGE + 5}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more of 5' }))
    expect(document.querySelectorAll('.hljs-number')).toHaveLength(numbers.length)
    expect(screen.queryByRole('button', { name: /^Show / })).toBeNull()
    // The last shown item before a page break keeps its comma; the true last does not.
    expect(text().endsWith(`${numbers.length - 1}]`)).toBe(true)
  })

  it('survives nesting deeper than a recursive walk does, starting deep levels folded', () => {
    const deep = parseJsonForTree('['.repeat(5000) + '1' + ']'.repeat(5000))!.value
    // Over the value limit, so it opens folded from the first level down.
    render(<JsonTree value={deep} />)
    expect(screen.getByRole('button', { name: 'Expand item 0' })).toBeTruthy()
  })

  it('opens a small but deep document folded below a fixed depth', () => {
    const deep = parseJsonForTree('['.repeat(40) + '1' + ']'.repeat(40))!.value
    render(<JsonTree value={deep} />)
    expect(screen.getAllByRole('button', { name: /^Collapse/ })).toHaveLength(32)
    expect(screen.getAllByRole('button', { name: /^Expand/ })).toHaveLength(1)
  })

  it('opens fully unfolded at exactly the value limit, and folded one past it', () => {
    // An object with n-1 scalar members is n values, the object included.
    const sized = (n: number): JsonValue => ({
      data: Object.fromEntries(Array.from({ length: n - 2 }, (_, i) => [`k${i}`, i]))
    })
    const { unmount } = render(<JsonTree value={sized(EXPAND_ALL_LIMIT)} />)
    expect(screen.getByRole('button', { name: 'Collapse data' })).toBeTruthy()
    unmount()
    render(<JsonTree value={sized(EXPAND_ALL_LIMIT + 1)} />)
    expect(screen.getByRole('button', { name: 'Expand data' })).toBeTruthy()
  })

  it('declines text that is not JSON', () => {
    expect(parseJsonForTree('{"a": 1')).toBeNull()
    expect(parseJsonForTree('[1]')).toEqual({ value: [1] })
  })
})
