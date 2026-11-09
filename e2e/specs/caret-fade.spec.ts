import type { Locator, Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * The fading caret in the built app: the real `:read-write…:focus` selector, the
 * real Chromium animation and the real `caretFade.ts` listeners. The unit test
 * has a fake animation and regexes over the CSS, so it proves none of these.
 *
 * Nothing here runs a turn or needs a credential.
 */

/** The composer, focused on the new-chat screen of a plain profile. */
async function focusedComposer(cinna: CinnaApp): Promise<Locator> {
  await cinna.skipOnboarding()
  const page = cinna.page
  // `:focus` needs an active page and a test window never comes forward
  // (`CINNA_BACKGROUND_WINDOW`), so this is focus emulation, not real window focus.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const composer = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await composer.focus()
  await expectMatchesFocus(composer)
  return composer
}

/** Focused for the selector too: without this, "no animation" could pass on a field `:focus` never matched. */
async function expectMatchesFocus(field: Locator): Promise<void> {
  await expect(field).toBeFocused()
  expect(await field.evaluate((el) => el.matches(':focus'))).toBe(true)
}

/** The fade on `field`, or null when none runs. */
const fadeOf = (field: Locator) =>
  field.evaluate((el) => {
    const fade = el
      .getAnimations()
      .find((animation) => animation instanceof CSSAnimation && animation.animationName === 'caret-soft-fade')
    if (!fade) return null
    return {
      playState: fade.playState,
      currentTime: Number(fade.currentTime),
      colours: (fade.effect as KeyframeEffect).getKeyframes().map((frame) => [frame.computedOffset, frame.caretColor])
    }
  })

/** `--color-accent` resolved to the form computed styles report it in. */
const resolvedAccent = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const probe = document.createElement('i')
    probe.style.color = 'var(--color-accent)'
    document.body.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  })

test('a focused composer runs the fade in the accent colour, on a manual caret', async ({ cinna }) => {
  const composer = await focusedComposer(cinna)
  const accent = await resolvedAccent(cinna.page)
  await expect(composer).toHaveCSS('caret-animation', 'manual')
  const fade = await fadeOf(composer)
  expect(fade?.playState).toBe('running')
  const transparent = 'rgba(0, 0, 0, 0)'
  expect(fade?.colours).toEqual([
    [0, accent],
    [0.3, accent],
    [0.6, transparent],
    [0.7, transparent],
    [1, accent]
  ])
})

test('a real key press rewinds the fade to its start', async ({ cinna }) => {
  const composer = await focusedComposer(cinna)
  // currentTime does not wrap at the 1.2 s iteration, so it only falls on a rewind.
  await expect.poll(async () => (await fadeOf(composer))?.currentTime).toBeGreaterThan(1500)
  await cinna.page.keyboard.press('a')
  const after = await fadeOf(composer)
  expect(after?.playState).toBe('running')
  expect(after?.currentTime).toBeLessThan(500)
  await expect(composer).toHaveValue('a')
})

test('a read-only, checkbox or date input does not run the fade; a text input does', async ({ cinna }) => {
  await focusedComposer(cinna)
  const page = cinna.page
  await page.evaluate(() => {
    const inputs: [string, string, boolean][] = [
      ['text', 'text', false],
      ['readonly', 'text', true],
      ['checkbox', 'checkbox', false],
      ['date', 'date', false]
    ]
    for (const [name, type, readOnly] of inputs) {
      const input = Object.assign(document.createElement('input'), { type, readOnly })
      input.dataset.caretProbe = name
      document.body.append(input)
    }
  })
  const probe = (name: string): Locator => page.locator(`[data-caret-probe="${name}"]`)

  await probe('text').focus()
  await expectMatchesFocus(probe('text'))
  expect((await fadeOf(probe('text')))?.playState).toBe('running')

  for (const name of ['readonly', 'checkbox', 'date']) {
    await probe(name).focus()
    await expectMatchesFocus(probe(name))
    expect(await fadeOf(probe(name)), name).toBeNull()
  }
})

test('an idle fade parks solid at the idle time, and a key press starts it again', async ({ cinna }) => {
  // Before any input, so the timers `caretFade.ts` arms are the fake clock's: it
  // calls the global `setTimeout` each time. The run takes seconds, so nothing a
  // real timer armed during startup can fire inside it; the 29 s check would catch it.
  await cinna.page.clock.install()
  const composer = await focusedComposer(cinna)
  const page = cinna.page
  await page.keyboard.press('a')

  await page.clock.fastForward(29_000)
  expect((await fadeOf(composer))?.playState).toBe('running')

  await page.clock.fastForward(1_500)
  const parked = await fadeOf(composer)
  expect(parked?.playState).toBe('paused')
  expect(parked?.currentTime).toBe(0)
  await expect(composer).toHaveCSS('caret-color', await resolvedAccent(page))

  await page.keyboard.press('b')
  expect((await fadeOf(composer))?.playState).toBe('running')
})

test('under reduced motion no fade runs and the caret keeps the accent colour', async ({ cinna }) => {
  const composer = await focusedComposer(cinna)
  const page = cinna.page
  expect((await fadeOf(composer))?.playState).toBe('running')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(composer).toHaveCSS('caret-animation', 'auto')
  await expectMatchesFocus(composer)
  expect(await fadeOf(composer)).toBeNull()
  await expect(composer).toHaveCSS('caret-color', await resolvedAccent(page))
})

test('with Extra UI animation off no fade runs and the caret keeps the accent colour', async ({ cinna }) => {
  const composer = await focusedComposer(cinna)
  const page = cinna.page
  expect((await fadeOf(composer))?.playState).toBe('running')

  // The saved preference, read at startup; caretFade.test.ts covers the live toggle.
  await page.evaluate(() => localStorage.setItem('cinna-extra-ui-animation', '0'))
  await page.reload()
  await composer.focus()
  await expectMatchesFocus(composer)
  await expect(page.locator('html')).toHaveAttribute('data-extra-animation-off', '')
  await expect(composer).toHaveCSS('caret-animation', 'auto')
  expect(await fadeOf(composer)).toBeNull()
  await expect(composer).toHaveCSS('caret-color', await resolvedAccent(page))
})
