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
    await expect(
      page.getByText(
        'A link asked Cinna to connect to this Cinna server. Only continue if you recognise it.',
        { exact: true }
      )
    ).toBeVisible()
    await expect(page.getByText('Server', { exact: true })).toBeVisible()
    await expect(page.getByText(GOOD_ORIGIN, { exact: true })).toBeVisible()

    // Both actions, and declining is a plain button rather than a corner ×.
    await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()

    // The link replaced the first-run choice rather than stacking on top of it.
    await expect(page.getByText(WELCOME, { exact: true })).toHaveCount(0)
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

    // No confirm panel: not its heading, and not the line only it renders.
    // (The welcome step's own card says "Connect to a Cinna instance…", so the
    // absence has to be asserted on the panel's exact strings.)
    await expect(page.getByText('Connect to cinna.example.com?', { exact: true })).toHaveCount(0)
    await expect(
      page.getByText(
        'A link asked Cinna to connect to this Cinna server. Only continue if you recognise it.',
        { exact: true }
      )
    ).toHaveCount(0)
    await expect(page.getByText('http://cinna.example.com')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Not now' })).toHaveCount(0)
    expect(await page.evaluate(() => window.api.connect.getPending())).toBeNull()
  })
})
