import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collapseAnchor, holdAnchor, holdCollapseAnchor } from './transcriptAnchor'

/** jsdom has no layout: give elements the geometry a test needs. */
function place(el: Element, top: () => number, height = 100): void {
  el.getBoundingClientRect = () => ({ top: top(), bottom: top() + height, left: 0, right: 0, width: 0, height, x: 0, y: top(), toJSON: () => ({}) })
}

function scroller(): HTMLElement {
  const container = document.createElement('div')
  let scrollTop = 1000
  Object.defineProperty(container, 'scrollTop', { get: () => scrollTop, set: (value: number) => { scrollTop = value }, configurable: true })
  Object.defineProperty(container, 'scrollHeight', { value: 5000, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true })
  place(container, () => 0, 600)
  document.body.appendChild(container)
  return container
}

let frames: FrameRequestCallback[] = []
let now = 0
const runFrame = (): void => { const pending = frames; frames = []; pending.forEach((callback) => callback(now)) }

beforeEach(() => {
  frames = []
  now = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => { frames = [] })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('collapseAnchor', () => {
  it('is the first top-level node reaching the viewport top, or the header of a group about to close', () => {
    const container = scroller()
    const content = document.createElement('div')
    container.appendChild(content)
    const above = document.createElement('div')
    const group = document.createElement('div')
    const header = document.createElement('button')
    header.setAttribute('data-group-header', '')
    header.setAttribute('aria-expanded', 'true')
    group.appendChild(header)
    content.append(above, group)
    place(above, () => -300, 200)
    place(group, () => -100, 4000)
    expect(collapseAnchor(container, content)).toBe(header)
    header.setAttribute('aria-expanded', 'false')
    expect(collapseAnchor(container, content)).toBe(group)
  })
})

describe('holdAnchor', () => {
  it('keeps the anchor at its offset from the top while the content above it shrinks', () => {
    const container = scroller()
    const anchor = document.createElement('div')
    container.appendChild(anchor)
    let anchorTop = 40
    place(anchor, () => anchorTop)
    holdAnchor(container, anchor)

    // The group collapses: the anchor (its header) moves up with the content.
    anchorTop = -800
    now = 16
    runFrame()
    expect(container.scrollTop).toBe(1000 - 840)
    // The browser moved the scroll position, and with it the anchor.
    anchorTop = 40
    now = 32
    runFrame()
    expect(container.scrollTop).toBe(160)
  })

  it('brings a group header that starts above the view to the top instead of holding it out of sight', () => {
    const container = scroller()
    const header = document.createElement('button')
    container.appendChild(header)
    let headerTop = -1500
    place(header, () => headerTop, 24)
    holdAnchor(container, header, undefined, 0)
    // First frame of the collapse: the steps below the header begin to close.
    now = 16
    runFrame()
    expect(container.scrollTop).toBe(1000 - 1500)
    headerTop = 0
    now = 32
    runFrame()
    expect(container.scrollTop).toBe(-500)
  })

  it('lands a group header collapsed from inside below the scroll area’s top padding, where it can be clicked', () => {
    const container = scroller()
    // The transcript's `pt-[calc(var(--topbar-h)+12px)]`, as the browser resolves it.
    container.style.paddingTop = '48px'
    const content = document.createElement('div')
    const group = document.createElement('div')
    const header = document.createElement('button')
    header.setAttribute('data-group-header', '')
    header.setAttribute('aria-expanded', 'true')
    group.appendChild(header)
    content.appendChild(group)
    container.appendChild(content)
    let headerTop = -1500
    place(group, () => headerTop, 4000)
    place(header, () => headerTop, 24)

    holdCollapseAnchor(container, content)
    now = 16
    runFrame()
    expect(container.scrollTop).toBe(1000 - 1500 - 48)
    headerTop = 48
    now = 32
    runFrame()
    expect(container.scrollTop).toBe(-548)
  })

  it('does not pick an open group that ends under the top padding, so the node the reader is on stays put', () => {
    const container = scroller()
    container.style.paddingTop = '48px'
    const content = document.createElement('div')
    const group = document.createElement('div')
    const header = document.createElement('button')
    header.setAttribute('data-group-header', '')
    header.setAttribute('aria-expanded', 'true')
    group.appendChild(header)
    const next = document.createElement('div')
    content.append(group, next)
    container.appendChild(content)
    // A stacked layout: everything moves with scrollTop, and the group's height
    // is what the collapse changes. It ends at 30, under the top bar; the next
    // node starts at 42, 12px of transcript gap below it.
    let groupHeight = 1530
    const groupTop = (): number => -1500 + (1000 - container.scrollTop)
    group.getBoundingClientRect = () => ({ top: groupTop(), bottom: groupTop() + groupHeight, left: 0, right: 0, width: 0, height: groupHeight, x: 0, y: groupTop(), toJSON: () => ({}) })
    place(header, groupTop, 24)
    place(next, () => groupTop() + groupHeight + 12, 400)
    expect(next.getBoundingClientRect().top).toBe(42)

    holdCollapseAnchor(container, content)
    groupHeight = 24
    for (let frame = 1; frame <= 3; frame++) {
      now = frame * 16
      runFrame()
    }
    expect(Math.abs(next.getBoundingClientRect().top - 42)).toBeLessThanOrEqual(2)
  })

  it('keeps an anchor that is not a group header where it was, top padding or not', () => {
    const container = scroller()
    container.style.paddingTop = '48px'
    const content = document.createElement('div')
    const block = document.createElement('div')
    content.appendChild(block)
    container.appendChild(content)
    let blockTop = 10
    place(block, () => blockTop, 400)

    holdCollapseAnchor(container, content)
    blockTop = -200
    now = 16
    runFrame()
    expect(container.scrollTop).toBe(1000 - 210)
  })

  it('lets go when the time is up, or when the user wheels', () => {
    const container = scroller()
    const anchor = document.createElement('div')
    container.appendChild(anchor)
    let anchorTop = 40
    place(anchor, () => anchorTop)
    holdAnchor(container, anchor, 100)
    now = 120
    runFrame()
    expect(frames).toEqual([])

    const release = holdAnchor(container, anchor)
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }))
    anchorTop = -500
    runFrame()
    expect(container.scrollTop).toBe(1000)
    release()
  })
})
