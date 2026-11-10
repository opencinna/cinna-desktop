import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/app'

/**
 * The startup splash (`hooks/useStartupSplash.ts`, main.css "Startup splash",
 * docs/ui/app_shell/app_shell.md → "Startup splash").
 *
 * A launch that lands straight in the shell carries `data-startup-splash` on
 * the shell root: `wait` → `hold` → `reveal` → removed. During `hold` the
 * `.splash-block`s show and everything else is transparent; it clears on its
 * own within MAX_HOLD_MS (1500) + REVEAL_MS (280), or at once on a key or
 * pointer press. A shell reached through onboarding skips it.
 *
 * The phases are a few hundred milliseconds long, so they are recorded in the
 * page — a MutationObserver for the transitions and a requestAnimationFrame
 * loop for opacity samples — installed right after the window loads, and read
 * back once the attribute is gone.
 */

interface Transition {
  t: number
  phase: string | null
}

interface HoldSample {
  /** Product of computed opacities from the composer textarea up to the shell root. */
  composer: number | null
  /** The same for the sidebar's `Chats` tab. */
  chatsTab: number | null
  /** The sidebar card's own computed opacity (a block: shows during hold). */
  sidebarCard: number | null
  blocks: number
}

interface SplashRecord {
  transitions: Transition[]
  holdSamples: HoldSample[]
  keydowns: number[]
}

type Recorder = { __splash?: SplashRecord; __splashDone?: Promise<SplashRecord>; __splashHold?: Promise<void> }

/** Starts recording on the current page; resolves once installed. */
async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as Recorder
    const rec: SplashRecord = { transitions: [], holdSamples: [], keydowns: [] }
    g.__splash = rec
    const phaseNow = (): string | null =>
      document.querySelector('[data-startup-splash]')?.getAttribute('data-startup-splash') ?? null
    const effectiveOpacity = (el: Element | null): number | null => {
      if (!el) return null
      let o = 1
      for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
        o *= Number(getComputedStyle(n).opacity)
      }
      return o
    }
    let last: string | null | undefined = undefined
    const note = (): void => {
      const p = phaseNow()
      if (p !== last) {
        last = p
        rec.transitions.push({ t: performance.now(), phase: p })
      }
    }
    note()
    const mo = new MutationObserver(note)
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-startup-splash']
    })
    window.addEventListener('keydown', () => rec.keydowns.push(performance.now()), true)
    let resolveHold: () => void = () => {}
    g.__splashHold = new Promise<void>((r) => (resolveHold = r))
    g.__splashDone = new Promise<SplashRecord>((resolve) => {
      const started = performance.now()
      let goneFrames = 0
      const frame = (): void => {
        note()
        const p = phaseNow()
        if (p === 'hold') {
          resolveHold()
          rec.holdSamples.push({
            composer: effectiveOpacity(document.querySelector('textarea[data-chat-composer]')),
            chatsTab: effectiveOpacity(document.querySelector('.app-sidebar-tabs button[aria-label="Chats"]')),
            sidebarCard: (() => {
              const el = document.querySelector('.app-sidebar')
              return el ? Number(getComputedStyle(el).opacity) : null
            })(),
            blocks: document.querySelectorAll('[data-startup-splash] .splash-block').length
          })
        }
        const seen = rec.transitions.some((x) => x.phase !== null)
        // Stop a few frames after the attribute is gone (or 15 s with no splash at all).
        if (seen && p === null) goneFrames++
        if (goneFrames >= 3 || performance.now() - started > 15_000) {
          mo.disconnect()
          resolve(rec)
          return
        }
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  })
}

const awaitDone = (page: Page): Promise<SplashRecord> =>
  page.evaluate(() => (globalThis as unknown as Recorder).__splashDone as Promise<SplashRecord>)

const phasesOf = (rec: SplashRecord): (string | null)[] => rec.transitions.map((x) => x.phase)

/** Time the attribute first had `phase`, and the next transition after it. */
function span(rec: SplashRecord, phase: string): { start: number; end: number } {
  const i = rec.transitions.findIndex((x) => x.phase === phase)
  expect(i, `phase ${phase} observed in ${JSON.stringify(phasesOf(rec))}`).toBeGreaterThanOrEqual(0)
  const next = rec.transitions[i + 1]
  expect(next, `a transition after ${phase}`).toBeTruthy()
  return { start: rec.transitions[i].t, end: next.t }
}

const composerOf = (page: Page) => page.getByRole('combobox', { name: 'Type a message...', exact: true })

test.describe('startup splash', () => {
  test('a launch into the shell holds a skeleton, then reveals on its own', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await cinna.relaunch()
    await installRecorder(cinna.page)
    const rec = await awaitDone(cinna.page)

    await test.step('phases run hold → reveal → removed, and clear within the cap', async () => {
      const phases = phasesOf(rec)
      // The recorder may join after `wait` began, never after `hold`.
      expect(phases.filter((p) => p !== 'wait')).toEqual(
        phases[0] === null ? [null, 'hold', 'reveal', null] : ['hold', 'reveal', null]
      )
      const hold = span(rec, 'hold')
      const reveal = span(rec, 'reveal')
      // MAX_HOLD_MS 1500 + REVEAL_MS 280, with slack for a loaded machine.
      expect(reveal.end - hold.start).toBeLessThan(3_000)
      expect(reveal.end - reveal.start).toBeLessThan(1_000)
    })

    await test.step('during hold the blocks show and the content is transparent', async () => {
      expect(rec.holdSamples.length).toBeGreaterThan(0)
      for (const s of rec.holdSamples) {
        expect(s.blocks).toBeGreaterThanOrEqual(3)
        expect(s.composer).toBe(0)
        expect(s.chatsTab).toBe(0)
      }
      // The sidebar card is a block: once its 150 ms fade-in has played it is opaque.
      expect(Math.max(...rec.holdSamples.map((s) => s.sidebarCard ?? 0))).toBe(1)
    })

    await test.step('afterwards the content is opaque and the composer takes typing', async () => {
      const page = cinna.page
      await expect(page.locator('[data-startup-splash]')).toHaveCount(0)
      const opacityUp = (sel: string): Promise<number> =>
        page.locator(sel).first().evaluate((el) => {
          let o = 1
          for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
            o *= Number(getComputedStyle(n).opacity)
          }
          return o
        })
      await expect.poll(() => opacityUp('textarea[data-chat-composer]')).toBe(1)
      await expect.poll(() => opacityUp('.app-sidebar-tabs button[aria-label="Chats"]')).toBe(1)
      const composer = composerOf(page)
      await composer.click()
      await composer.pressSequentially('hello splash')
      await expect(composer).toHaveValue('hello splash')
    })
  })

  test('a key press during hold reveals at once', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await cinna.relaunch()
    const page = cinna.page
    await installRecorder(page)
    await page.evaluate(() => (globalThis as unknown as Recorder).__splashHold)
    await page.keyboard.press('Shift')
    const rec = await awaitDone(page)

    expect(rec.keydowns.length).toBeGreaterThan(0)
    const hold = span(rec, 'hold')
    const key = rec.keydowns[0]
    expect(key).toBeGreaterThanOrEqual(hold.start)
    // The reveal follows the keydown within a frame or two…
    expect(hold.end - key).toBeLessThan(100)
    // …and well before the 300 ms minimum hold would have allowed it.
    expect(hold.end - hold.start).toBeLessThan(300)
    expect(rec.transitions[rec.transitions.findIndex((x) => x.phase === 'hold') + 1].phase).toBe('reveal')
  })

  test('a shell reached through onboarding gets no splash', async ({ cinna }) => {
    const page = cinna.page
    const skip = page.getByRole('button', { name: 'Skip for now' })
    await expect(skip).toBeVisible()
    await installRecorder(page)
    await skip.click()
    await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()
    await expect(composerOf(page)).toBeVisible()
    await expect(page.locator('[data-startup-splash]')).toHaveCount(0)
    const phases = await page.evaluate(() =>
      (globalThis as unknown as Recorder).__splash!.transitions.map((x) => x.phase)
    )
    expect(phases).toEqual([null])
  })
})
