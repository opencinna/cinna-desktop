import { test, expect, type CinnaApp } from '../fixtures/app'
import type { Page } from '@playwright/test'

/**
 * Section B of `plans/manual-test-session2.md`: the logger overlay.
 *
 * `installLogBroadcast` is the one wire in `src/main/index.ts` no unit test
 * covers: drop it and the overlay opens fully populated from `logger:get-all`
 * and then never updates. B1 is the test for that exact failure shape.
 */

function overlay(page: Page) {
  return page.getByRole('heading', { name: 'App Logs' })
}

/**
 * A row is six adjacent spans with no whitespace between them, so its text
 * content reads `INF[main][local-agent-scan]agents root scanned`; filter by
 * fragments rather than matching the spaced form the eye sees.
 */
function scanRows(page: Page) {
  return page
    .locator('[data-log-index]')
    .filter({ hasText: '[local-agent-scan]' })
    .filter({ hasText: 'agents root scanned' })
}

async function openOverlayFromSidebar(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Interface' }).click()
  await cinna.page.getByRole('button', { name: 'App logs (⌘`)' }).click()
  await expect(overlay(cinna.page)).toBeVisible()
}

/** The View → Toggle App Logs menu item, which is what ⌘` is bound to. */
async function toggleOverlayFromMenu(cinna: CinnaApp): Promise<void> {
  const clicked = await cinna.electronApp.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View')
    const toggle = view?.submenu?.items.find((item) => item.label === 'Toggle App Logs')
    if (!toggle) return false
    toggle.click()
    return true
  })
  expect(clicked, 'View → Toggle App Logs exists in the application menu').toBe(true)
}

test('B1 entries arrive live while the overlay is open', async ({ cinna }) => {
  await cinna.skipOnboarding()
  await openOverlayFromSidebar(cinna)
  await cinna.page.getByRole('button', { name: 'Clear logs' }).click()
  await expect(cinna.page.getByText('No log entries yet')).toBeVisible()

  // Something that logs in main, without closing the overlay.
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await expect(scanRows(cinna.page).first()).toBeVisible()
})

test('B1 the ⌘` menu item toggles the overlay', async ({ cinna }) => {
  await cinna.skipOnboarding()
  await toggleOverlayFromMenu(cinna)
  await expect(overlay(cinna.page)).toBeVisible()
  await toggleOverlayFromMenu(cinna)
  await expect(overlay(cinna.page)).toBeHidden()
})

test('B2 history from before the overlay was first opened is present', async ({ cinna }) => {
  await cinna.skipOnboarding()
  await cinna.relaunch()
  await cinna.skipOnboarding()
  // Use the app for a bit without opening the logs.
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()

  await openOverlayFromSidebar(cinna)
  await expect(scanRows(cinna.page).first()).toBeVisible()
})

test('B3 sensitive-looking keys are redacted before they reach the overlay', async ({ cinna }) => {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() =>
    window.api.logger.log({
      level: 'warn',
      scope: 'e2e',
      message: 'redaction probe',
      data: { apiKey: 'sk-live-123', refresh_token: 'rt-abc', keep: 'visible' }
    })
  )
  await openOverlayFromSidebar(cinna)
  await cinna.page.getByPlaceholder('Filter by scope, message, source...').fill('redaction probe')
  const row = cinna.page.locator('[data-log-index]').filter({ hasText: 'redaction probe' })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'Expand data' }).click()
  const data = row.locator('pre')
  await expect(data).toContainText('"apiKey": "[REDACTED]"')
  await expect(data).toContainText('"refresh_token": "[REDACTED]"')
  await expect(data).toContainText('"keep": "visible"')
  await expect(data).not.toContainText('sk-live-123')
})
