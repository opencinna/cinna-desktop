import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../stores/ui.store'
import { CARET_IDLE_PARK_MS, initCaretFade } from './caretFade'

/** jsdom has neither CSS animations nor `getAnimations`, so both are stood in for. */
class FakeCSSAnimation {
  currentTime: number | null = 500
  playState = 'running'
  constructor(public animationName: string) {}
  pause(): void {
    this.playState = 'paused'
  }
  play(): void {
    this.playState = 'running'
  }
}

describe('initCaretFade', () => {
  let field: HTMLTextAreaElement
  let fade: FakeCSSAnimation
  let other: FakeCSSAnimation

  beforeAll(() => {
    vi.stubGlobal('CSSAnimation', FakeCSSAnimation)
    initCaretFade()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<textarea></textarea><button>outside</button>'
    field = document.querySelector('textarea')!
    fade = new FakeCSSAnimation('caret-soft-fade')
    other = new FakeCSSAnimation('something-else')
    field.getAnimations = (() => [fade, other]) as never
    document.body.getAnimations = () => []
    field.focus()
    fade.currentTime = 500
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['keydown', 'input', 'pointerdown', 'focusin'])('rewinds the focused field on %s', (type) => {
    field.dispatchEvent(new Event(type, { bubbles: true }))
    expect(fade.currentTime).toBe(0)
  })

  it('leaves any other animation on the field alone', () => {
    field.dispatchEvent(new Event('keydown', { bubbles: true }))
    expect(other.currentTime).toBe(500)
    vi.advanceTimersByTime(CARET_IDLE_PARK_MS)
    expect(other.playState).toBe('running')
  })

  it('does not touch a field that lost focus', () => {
    field.blur()
    fade.currentTime = 500
    document.body.dispatchEvent(new Event('keydown', { bubbles: true }))
    expect(fade.currentTime).toBe(500)
  })

  it('parks the fade solid after the idle time, and not before', () => {
    field.dispatchEvent(new Event('keydown', { bubbles: true }))
    fade.currentTime = 500
    vi.advanceTimersByTime(CARET_IDLE_PARK_MS - 1)
    expect(fade.playState).toBe('running')
    vi.advanceTimersByTime(1)
    expect(fade.playState).toBe('paused')
    expect(fade.currentTime).toBe(0)
  })

  it('counts the idle time again from each keystroke', () => {
    field.dispatchEvent(new Event('keydown', { bubbles: true }))
    vi.advanceTimersByTime(CARET_IDLE_PARK_MS - 1)
    field.dispatchEvent(new Event('keydown', { bubbles: true }))
    vi.advanceTimersByTime(CARET_IDLE_PARK_MS - 1)
    expect(fade.playState).toBe('running')
  })

  it('marks the page while Extra UI animation is off, so the fade rule stops matching', () => {
    useUIStore.getState().setExtraUIAnimation(false)
    expect(document.documentElement.hasAttribute('data-extra-animation-off')).toBe(true)
    useUIStore.getState().setExtraUIAnimation(true)
    expect(document.documentElement.hasAttribute('data-extra-animation-off')).toBe(false)
  })

  it('starts a parked fade again on the next keystroke', () => {
    field.dispatchEvent(new Event('keydown', { bubbles: true }))
    vi.advanceTimersByTime(CARET_IDLE_PARK_MS)
    expect(fade.playState).toBe('paused')
    field.dispatchEvent(new Event('keydown', { bubbles: true }))
    expect(fade.playState).toBe('running')
    expect(fade.currentTime).toBe(0)
  })
})

/** jsdom does not paint: these read the stylesheet, as fileRef.css.test.ts does. */
describe('caret styles', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )
  const keyframes = css.match(/@keyframes caret-soft-fade \{([\s\S]*?)\n {2}\}/)?.[1] ?? ''

  it('takes the colour from the theme accent, so a brand follows', () => {
    expect(css).toMatch(/:focus \{\s*caret-color: var\(--color-accent\);\s*\}/)
    expect(keyframes).toMatch(/caret-color: var\(--color-accent\)/)
  })

  it('starts the fade opaque, since a rewind must show a solid caret', () => {
    expect(keyframes).toMatch(/0%, 30% \{ caret-color: var\(--color-accent\); \}/)
  })

  it('runs the fade only with motion allowed and Extra UI animation on', () => {
    expect(css).toMatch(
      /prefers-reduced-motion: no-preference\) \{\s*:root:not\(\[data-extra-animation-off\]\) :read-write[^{]*:focus \{\s*caret-animation: manual;\s*animation: caret-soft-fade/
    )
    expect(css.match(/animation: caret-soft-fade/g)).toHaveLength(1)
  })
})
