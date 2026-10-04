import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Open the Tasks view (the top bar's Tasks button) in its **Recent** layout —
 * every root task in one list, the last changed first, where the Inbox's
 * Recent tasks used to be — and return that list, the `Recent tasks` region.
 *
 * The layout is remembered, so the switch may already be pressed; clicking it
 * again is harmless. Pass `cinna.page` at the call, never a page held across a
 * `relaunch()`.
 */
export async function openRecentTasks(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks', exact: true })).toBeVisible()
  const recent = page.getByRole('group', { name: 'Tasks layout', exact: true })
    .getByRole('button', { name: 'Recent', exact: true })
  await recent.click()
  await expect(recent).toHaveAttribute('aria-pressed', 'true')
  return page.getByRole('region', { name: 'Recent tasks', exact: true })
}
