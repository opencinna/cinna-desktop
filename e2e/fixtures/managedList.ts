import { expect, type Locator } from '@playwright/test'

/**
 * A People list (the Sharing tab, a skill's Who can use), driven the way a
 * user does: a row is found by its name, its access is a picker named by the
 * access it shows that opens a menu named `Access for <name>`, and removing
 * is the row's ⋯ (`Actions for <name>`) → Remove access… → the row's own
 * confirm. The menus are portaled, so they are found on the page.
 */

export type PeopleAccess = 'use' | 'edit' | 'maintain'

/** The picker's words for each access. */
export const ACCESS_LABEL: Record<PeopleAccess, string> = { use: 'Can use', edit: 'Can edit', maintain: 'Maintainer' }

/** The row titled exactly `name`. */
export function peopleRow(scope: Locator, name: string): Locator {
  return scope.locator('[data-managed-row]').filter({ has: scope.page().getByText(name, { exact: true }) })
}

/** The row's access picker: the menu button without an `aria-label` (the ⋯ has one). */
export function accessPicker(scope: Locator, name: string): Locator {
  return peopleRow(scope, name).locator('button[aria-haspopup="menu"]:not([aria-label])')
}

/** Every access picker in the list. */
export function accessPickers(scope: Locator): Locator {
  return scope.locator('[data-managed-row] button[aria-haspopup="menu"]:not([aria-label])')
}

export async function expectAccess(scope: Locator, name: string, access: PeopleAccess, timeout?: number): Promise<void> {
  await expect(accessPicker(scope, name)).toHaveText(ACCESS_LABEL[access], timeout === undefined ? undefined : { timeout })
}

/** Open `name`'s access picker and choose `access`. */
export async function pickAccess(scope: Locator, name: string, access: PeopleAccess): Promise<void> {
  const menu = scope.page().getByRole('menu', { name: `Access for ${name}`, exact: true })
  await openMenu(accessPicker(scope, name), menu)
  await menu.getByRole('menuitemradio', { name: ACCESS_LABEL[access], exact: true }).click()
}

/**
 * Click `trigger` until `menu` stays open. The menu closes on a scroll of
 * the pane holding its trigger, and the scroll Playwright makes to bring a
 * row low on the page into view can be delivered after the click opened it.
 */
async function openMenu(trigger: Locator, menu: Locator): Promise<void> {
  await expect(async () => {
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
    await expect(menu).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
}

/** The row's ⋯. */
export function personActions(scope: Locator, name: string): Locator {
  return scope.getByRole('button', { name: `Actions for ${name}`, exact: true })
}

/** ⋯ → Remove access… → the row asks `Remove <name>’s access?` → Remove; waits until the row left. */
export async function removeAccess(scope: Locator, name: string): Promise<void> {
  const menu = scope.page().getByRole('menu', { name: `Actions for ${name}`, exact: true })
  await openMenu(personActions(scope, name), menu)
  await menu.getByRole('menuitem', { name: 'Remove access…', exact: true }).click()
  await expect(scope.getByText(`Remove ${name}’s access?`, { exact: true })).toBeVisible()
  await scope.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(scope.getByText(`Remove ${name}’s access?`, { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await expect(personActions(scope, name)).toHaveCount(0)
}
