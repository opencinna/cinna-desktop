import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../fixtures/app'

/**
 * The `cinna://connect?server=<origin>` deep link, end to end through the real
 * main process: argv → `connectIntentService` → the renderer's confirm step.
 *
 * The link is driven with `--cinna-connect-intent=`, the test-only argv form
 * declared in `src/shared/connectIntent.ts`. It enters the same funnel as the
 * OS `open-url` hook (which Playwright cannot raise), so everything below that
 * hook is real: the URL validation, the one-intent buffer, the push, and the
 * whole confirm step.
 *
 * What is *not* here: clicking **Connect**. That starts the ordinary browser
 * OAuth flow against the named host, and a suite that opens a browser at a
 * server which does not exist is testing the network, not the app. The
 * property these tests are about is the one before it — nothing connects
 * without a human reading the host and saying yes.
 */

const GOOD_ORIGIN = 'https://cinna.example.com'
const GOOD_LINK = `--cinna-connect-intent=cinna://connect?server=${GOOD_ORIGIN}`
// Plain http off loopback: refused by `normalizeServerOrigin`, and a refusal
// has no UI at all by design.
const REFUSED_LINK = '--cinna-connect-intent=cinna://connect?server=http://cinna.example.com'

/** The onboarding welcome step, the screen a fresh profile shows with no link. */
const WELCOME = 'Welcome to Cinna'

test.describe('a link the app accepts', () => {
  test.use({ launchArgs: [GOOD_LINK] })

  test('lands a fresh profile on the confirm step, naming the full origin', async ({ cinna }) => {
    const { page } = cinna

    // The heading names the host; the panel below it shows the origin
    // unabbreviated, because the origin is the thing the user is being asked
    // to trust.
    await expect(page.getByText('Connect to cinna.example.com?', { exact: true })).toBeVisible()
    await expect(page.getByText(GOOD_ORIGIN, { exact: true })).toBeVisible()

    // Both actions, and declining is still a real button — quieter than
    // Connect, but never a corner ×.
    await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()

    // Local development rides along with the connect button, ticked, so that
    // answering it is not a step of its own after sign-in.
    await expect(page.getByRole('checkbox', { name: /local development/i })).toBeChecked()

    // The link replaced the first-run choice rather than stacking on top of it.
    await expect(page.getByText(WELCOME, { exact: true })).toHaveCount(0)
  })

  test('the local-dev explainer stays inside a narrow window', async ({ cinna }) => {
    const { page } = cinna
    // The (?) sits mid-card, so its popover is anchored to a trigger that is
    // nowhere near a window edge — and a 22rem popover anchored to a point two
    // thirds of the way across a narrow window hangs off the far side. The hook
    // shifts it back; this is the only place that behaviour is exercised.
    await page.setViewportSize({ width: 620, height: 700 })
    await page.getByRole('button', { name: /what local development installs/i }).click()
    const explainer = page.getByRole('dialog', { name: /what local development installs/i })
    await expect(explainer).toBeVisible()

    const box = await explainer.boundingBox()
    const width = await page.evaluate(() => window.innerWidth)
    // The window has a `minWidth`, so assert the narrowing actually took: at
    // the full width the popover fits unshifted and the rest of this test would
    // pass with the clamp doing nothing at all.
    expect(width).toBeLessThan(700)
    // And that it is the clamp holding it in, not luck.
    expect(await explainer.evaluate((el) => (el as HTMLElement).style.transform)).toContain(
      'translateX'
    )
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  })

  test('Not now drops it, and the consumed buffer does not come back', async ({ cinna }) => {
    await cinna.page.getByRole('button', { name: 'Not now' }).click()

    // Declining is not a finished first run: the user still needs the ordinary
    // choices, so the welcome step is what is underneath.
    await expect(cinna.page.getByText(WELCOME, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText('Connect to cinna.example.com?', { exact: true })).toHaveCount(
      0
    )

    // Main dropped the buffer too — not just the renderer's copy. This is the
    // in-process half of "consumed"; the relaunch below is the other half.
    expect(await cinna.page.evaluate(() => window.api.connect.getPending())).toBeNull()

    // A plain restart (no link on argv) must be an ordinary first run.
    await cinna.relaunch()
    await expect(cinna.page.getByText(WELCOME, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText('Connect to cinna.example.com?', { exact: true })).toHaveCount(
      0
    )
    expect(await cinna.page.evaluate(() => window.api.connect.getPending())).toBeNull()
  })
})

test.describe('a link the app refuses', () => {
  test.use({ launchArgs: [REFUSED_LINK] })

  test('plain http off loopback looks exactly like no link at all', async ({ cinna }) => {
    const { page } = cinna

    // The refusal reason is logged, never shown: a link the app refuses should
    // be indistinguishable from a link nobody sent.
    await expect(page.getByText(WELCOME, { exact: true })).toBeVisible()
    await expect(page.getByText('Pick how you want to start chatting', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible()

    // No confirm panel: not its heading, and not the controls only it renders.
    // (The welcome step's own card says "Connect to a Cinna instance…", so the
    // absence has to be asserted on the panel's exact strings.)
    await expect(page.getByText('Connect to cinna.example.com?', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('checkbox', { name: /local development/i })).toHaveCount(0)
    await expect(page.getByText('http://cinna.example.com')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Not now' })).toHaveCount(0)
    expect(await page.evaluate(() => window.api.connect.getPending())).toBeNull()
  })
})

/**
 * The install handoff: the download page copies a `cinna://connect` link, and
 * the first run of the freshly installed app picks it up — from the clipboard
 * (Linux only in a real run), or from a paste into the Server URL field.
 *
 * **Nothing here touches the developer's clipboard.** Under the sandbox main
 * never reads the real pasteboard; it reads `CINNA_E2E_CLIPBOARD_TEXT` (passed
 * per launch through the fixture's `env`, never `process.env`) and nothing at
 * all without it — on every platform, so the gate's path runs on macOS too.
 * The paste tests dispatch a synthetic `ClipboardEvent` whose `DataTransfer`
 * the test builds; no `Meta+V`, so Chromium never reads the pasteboard either.
 */
const HANDOFF_HOST = 'cinna.example.test'
const HANDOFF_LINK = `cinna://connect?server=https://${HANDOFF_HOST}`
const HANDOFF_HEADING = `Connect to ${HANDOFF_HOST}?`
// Plain http off loopback, the same refusal as `REFUSED_LINK` above.
const REFUSED_HANDOFF_LINK = `cinna://connect?server=http://${HANDOFF_HOST}`
const SERVER_URL_PLACEHOLDER = 'https://your-server.com'

test.describe('install handoff: a connect link on the clipboard', () => {
  test.use({ env: { CINNA_E2E_CLIPBOARD_TEXT: HANDOFF_LINK } })

  test('first run opens on the confirm step instead of Welcome', async ({ cinna }) => {
    // The gate holds its blank placeholder until the clipboard answer is in,
    // so the first screen it paints is the confirm step.
    await expect(cinna.page.getByText(HANDOFF_HEADING, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(`https://${HANDOFF_HOST}`, { exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
    await expect(cinna.page.getByText(WELCOME, { exact: true })).toHaveCount(0)

    // Buffered in main like any other link, so declining drops it there too
    // and the user is back on the ordinary first-run choices.
    await cinna.page.getByRole('button', { name: 'Not now' }).click()
    await expect(cinna.page.getByText(WELCOME, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(HANDOFF_HEADING, { exact: true })).toHaveCount(0)
    expect(await cinna.page.evaluate(() => window.api.connect.getPending())).toBeNull()
  })
})

test.describe('install handoff: a clicked link outranks the clipboard', () => {
  test.use({ launchArgs: [GOOD_LINK], env: { CINNA_E2E_CLIPBOARD_TEXT: HANDOFF_LINK } })

  test('the argv link is the one confirmed, and the clipboard is not read over it', async ({
    cinna
  }) => {
    await expect(cinna.page.getByText('Connect to cinna.example.com?', { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(HANDOFF_HEADING, { exact: true })).toHaveCount(0)
    expect(
      await cinna.page.evaluate(() => window.api.connect.getPending().then((i) => i?.serverUrl))
    ).toBe(GOOD_ORIGIN)
  })
})

test.describe('install handoff: clipboard text that is not a link', () => {
  // Names the host, but is not a `cinna://connect` link: never parsed.
  test.use({ env: { CINNA_E2E_CLIPBOARD_TEXT: `hello https://${HANDOFF_HOST}` } })

  test('first run shows Welcome and nothing is buffered', async ({ cinna }) => {
    await expect(cinna.page.getByText(WELCOME, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(HANDOFF_HEADING, { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByRole('button', { name: 'Not now' })).toHaveCount(0)
    expect(await cinna.page.evaluate(() => window.api.connect.getPending())).toBeNull()
  })
})

/**
 * Paste `text` into `input` the way a user's paste reaches React, without the
 * system clipboard: a synthetic, cancelable `paste` carrying a `DataTransfer`.
 * A synthetic event inserts nothing by itself, so when the app does *not*
 * cancel it this performs the browser's default action (`insertText`) — which
 * is what makes "the field never received the text" a real assertion rather
 * than a property of the synthetic event. Every value the field takes on
 * through `input` events is returned in `seen`.
 */
async function pasteInto(
  input: Locator,
  text: string
): Promise<{ prevented: boolean; value: string; seen: string[] }> {
  return input.evaluate((el, pasted) => {
    const field = el as HTMLInputElement
    const seen: string[] = []
    field.addEventListener('input', () => seen.push(field.value))
    field.focus()
    const data = new DataTransfer()
    data.setData('text/plain', pasted)
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    field.dispatchEvent(event)
    if (!event.defaultPrevented) document.execCommand('insertText', false, pasted)
    return { prevented: event.defaultPrevented, value: field.value, seen }
  }, text)
}

async function openServerUrlField(page: Page): Promise<Locator> {
  await expect(page.getByText(WELCOME, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Cinna Server/ }).click()
  const field = page.getByPlaceholder(SERVER_URL_PLACEHOLDER, { exact: true })
  await expect(field).toBeVisible()
  return field
}

test.describe('install handoff: a link pasted into Server URL', () => {
  test('an accepted link opens the confirm step and never enters the field', async ({ cinna }) => {
    const field = await openServerUrlField(cinna.page)

    const pasted = await pasteInto(field, HANDOFF_LINK)
    expect(pasted).toEqual({ prevented: true, value: '', seen: [] })

    await expect(cinna.page.getByText(HANDOFF_HEADING, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(`https://${HANDOFF_HOST}`, { exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'Not now' })).toBeVisible()
    expect(
      await cinna.page.evaluate(() => window.api.connect.getPending().then((i) => i?.serverUrl))
    ).toBe(`https://${HANDOFF_HOST}`)
  })

  test('a refused link leaves the field empty and says why', async ({ cinna }) => {
    const field = await openServerUrlField(cinna.page)

    const pasted = await pasteInto(field, REFUSED_HANDOFF_LINK)
    expect(pasted).toEqual({ prevented: true, value: '', seen: [] })

    await expect(
      cinna.page.getByText('That link has no server Cinna can use.', { exact: true })
    ).toBeVisible()
    await expect(field).toHaveValue('')
    await expect(cinna.page.getByText(`Connect to ${HANDOFF_HOST}?`, { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByRole('button', { name: 'Not now' })).toHaveCount(0)
    expect(await cinna.page.evaluate(() => window.api.connect.getPending())).toBeNull()
  })

  test('an ordinary URL pastes into the field as usual', async ({ cinna }) => {
    // The control: without it, the two tests above would pass with a field
    // that refused every paste.
    const field = await openServerUrlField(cinna.page)
    const pasted = await pasteInto(field, `https://${HANDOFF_HOST}`)
    expect(pasted.prevented).toBe(false)
    await expect(field).toHaveValue(`https://${HANDOFF_HOST}`)
    await expect(cinna.page.getByText(HANDOFF_HEADING, { exact: true })).toHaveCount(0)
  })
})

/**
 * The download page's note says "paste it", and the first screen is Welcome,
 * which has no field. A paste with nothing focused fires at the body: that is
 * where Edit → Paste (Cmd+V) lands in the app.
 */
test.describe('install handoff: a link pasted on Welcome', () => {
  test('opens the confirm step', async ({ cinna }) => {
    await expect(cinna.page.getByText(WELCOME, { exact: true })).toBeVisible()
    const prevented = await cinna.page.evaluate((pasted) => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      const data = new DataTransfer()
      data.setData('text/plain', pasted)
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      document.body.dispatchEvent(event)
      return event.defaultPrevented
    }, HANDOFF_LINK)
    expect(prevented).toBe(true)
    await expect(cinna.page.getByText(HANDOFF_HEADING, { exact: true })).toBeVisible()
    expect(
      await cinna.page.evaluate(() => window.api.connect.getPending().then((i) => i?.serverUrl))
    ).toBe(`https://${HANDOFF_HOST}`)
  })
})
