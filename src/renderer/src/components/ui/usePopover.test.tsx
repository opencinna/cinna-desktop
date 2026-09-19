import { act, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pinTopEdge, usePopover, type PopoverOptions, type PopoverPlacement } from './usePopover'
import { useHoverPopover } from './useHoverPopover'

/**
 * `keepTopWhileOpen`: an above-anchored popover whose content grows while it
 * is open grows downward, so the rows under the pointer stay put. jsdom lays
 * nothing out, so the rects are stubbed per element.
 */

const rects = new Map<string, Partial<DOMRect>>()
afterEach(() => {
  rects.clear()
  vi.restoreAllMocks()
})

function stubRects(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = rects.get(this.dataset.rect ?? '') ?? {}
    // A real rect includes the element's transform; the corrections are
    // computed from "measured minus applied", which only settles if it does.
    const moved = /translate\((-?\d+)px, (-?\d+)px\)/.exec(this.style.transform)
    const top = (r.top ?? 0) + (moved ? Number(moved[2]) : 0)
    const height = r.height ?? 0
    const left = (r.left ?? 0) + (moved ? Number(moved[1]) : 0)
    const width = r.width ?? 0
    return { top, height, left, width, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) } as DOMRect
  })
}

let latest: React.CSSProperties | null = null
let setOpen: (open: boolean) => void = () => {}

function Harness({ placement, options, rows }: { placement: PopoverPlacement; options?: PopoverOptions; rows: number }): React.JSX.Element {
  const popover = usePopover<HTMLButtonElement, HTMLDivElement>(placement, options)
  latest = popover.style
  setOpen = popover.setOpen
  return createElement('div', null,
    createElement('button', { ref: popover.triggerRef, 'data-rect': 'trigger' }),
    popover.open ? createElement('div', { ref: popover.popoverRef, 'data-rect': 'popover', 'data-rows': rows }) : null)
}

describe('pinTopEdge', () => {
  it('turns a bottom anchor into a top anchor on the same side', () => {
    expect(pinTopEdge({ right: 10, bottom: 50 }, 300)).toEqual({ right: 10, top: 300 })
    expect(pinTopEdge({ left: 4, bottom: 50 }, 120)).toEqual({ left: 4, top: 120 })
  })

  it('leaves a top-anchored position alone', () => {
    expect(pinTopEdge({ right: 10, top: 40 }, 300)).toEqual({ right: 10, top: 40 })
  })
})

describe('usePopover keepTopWhileOpen', () => {
  // Window 1000×800; trigger at y 700–720, right edge 900. Popover 200 tall,
  // laid out above the trigger with its bottom at 692 → top 492.
  function open(options: PopoverOptions | undefined, rows = 1): ReturnType<typeof render> {
    stubRects()
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    rects.set('trigger', { top: 700, height: 20, left: 870, width: 30 })
    rects.set('popover', { top: 492, height: 200, left: 580, width: 320 })
    const view = render(createElement(Harness, { placement: 'above-right', options, rows }))
    act(() => setOpen(true))
    return view
  }

  it('pins the top edge where the popover opened, and keeps it when the content grows', () => {
    const view = open({ keepTopWhileOpen: true })
    expect(latest).toEqual({ position: 'fixed', right: 100, top: 492 })

    // A refusal line: the popover is now 219 tall. Its top stays.
    rects.set('popover', { top: 492, height: 219, left: 580, width: 320 })
    view.rerender(createElement(Harness, { placement: 'above-right', options: { keepTopWhileOpen: true }, rows: 2 }))
    expect(latest).toEqual({ position: 'fixed', right: 100, top: 492 })
  })

  it('re-anchors above the trigger on the next open', () => {
    open({ keepTopWhileOpen: true })
    act(() => setOpen(false))
    expect(latest).toBeNull()
    rects.set('popover', { top: 400, height: 292, left: 580, width: 320 })
    act(() => setOpen(true))
    expect(latest).toEqual({ position: 'fixed', right: 100, top: 400 })
  })

  it('keeps the bottom anchor for every other popover', () => {
    const view = open(undefined)
    expect(latest).toEqual({ position: 'fixed', right: 100, bottom: 108 })
    view.rerender(createElement(Harness, { placement: 'above-right', rows: 2 }))
    expect(latest).toEqual({ position: 'fixed', right: 100, bottom: 108 })
  })
})

/** Spreads `style` onto the popover, as a caller does, so the stubbed rect moves with it. */
function StyledHarness(): React.JSX.Element {
  const popover = usePopover<HTMLButtonElement, HTMLDivElement>('right')
  latest = popover.style
  setOpen = popover.setOpen
  return createElement('div', null,
    createElement('button', { ref: popover.triggerRef, 'data-rect': 'trigger' }),
    popover.open && popover.style ? createElement('div', { ref: popover.popoverRef, 'data-rect': 'popover', style: popover.style }) : null)
}

describe('usePopover right placement', () => {
  // Window 1000×800; a sidebar row 240 wide whose right edge is at 250;
  // `right` stands 4 off it, close enough to cross onto.
  function open(triggerTop: number, popover: Partial<DOMRect>): void {
    stubRects()
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    rects.set('trigger', { top: triggerTop, height: 28, left: 10, width: 240 })
    rects.set('popover', popover)
    render(createElement(StyledHarness))
    act(() => setOpen(true))
  }

  it('sits beside the trigger, top edges level', () => {
    open(300, { top: 300, height: 90, left: 254, width: 200 })
    expect(latest).toEqual({ position: 'fixed', left: 254, top: 300 })
  })

  it('lifts a popover that would hang past the bottom of the window, and settles', () => {
    // Row at 760: a 90-tall popover would end at 850. 800 − 8 − 850 = −58.
    open(760, { top: 760, height: 90, left: 254, width: 200 })
    expect(latest).toEqual({ position: 'fixed', left: 254, top: 760, transform: 'translate(0px, -58px)' })
  })

  it('keeps the top edge inside when the popover is taller than the window', () => {
    open(100, { top: 100, height: 900, left: 254, width: 200 })
    expect(latest).toEqual({ position: 'fixed', left: 254, top: 100, transform: 'translate(0px, -92px)' })
  })

  it('does not clamp any other placement vertically', () => {
    stubRects()
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    rects.set('trigger', { top: 760, height: 28, left: 700, width: 240 })
    rects.set('popover', { top: 792, height: 90, left: 740, width: 200 })
    render(createElement(Harness, { placement: 'below-right', rows: 1 }))
    act(() => setOpen(true))
    expect(latest).toEqual({ position: 'fixed', right: 60, top: 792 })
  })
})

describe('useHoverPopover', () => {
  function HoverHarness(): React.JSX.Element {
    const popover = useHoverPopover<HTMLButtonElement, HTMLDivElement>('above-right')
    latest = popover.style
    setOpen = popover.setOpen
    return createElement('div', null,
      createElement('button', { ref: popover.triggerRef, 'data-rect': 'trigger' }),
      popover.open ? createElement('div', { ref: popover.popoverRef, 'data-rect': 'popover' }) : null)
  }

  it('keeps its top edge while open', () => {
    stubRects()
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    rects.set('trigger', { top: 700, height: 20, left: 870, width: 30 })
    rects.set('popover', { top: 492, height: 200, left: 580, width: 320 })
    render(createElement(HoverHarness))
    act(() => setOpen(true))
    expect(latest).toEqual({ position: 'fixed', right: 100, top: 492 })
  })
})
