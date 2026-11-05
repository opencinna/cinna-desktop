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
  await accessPicker(scope, name).click()
  await scope
    .page()
    .getByRole('menu', { name: `Access for ${name}`, exact: true })
    .getByRole('menuitemradio', { name: ACCESS_LABEL[access], exact: true })
    .click()
}

/** The row's ⋯. */
export function personActions(scope: Locator, name: string): Locator {
  return scope.getByRole('button', { name: `Actions for ${name}`, exact: true })
}

/** ⋯ → Remove access… → the row asks `Remove <name>’s access?` → Remove; waits until the row left. */
export async function removeAccess(scope: Locator, name: string): Promise<void> {
  await personActions(scope, name).click()
  await scope
    .page()
    .getByRole('menu', { name: `Actions for ${name}`, exact: true })
    .getByRole('menuitem', { name: 'Remove access…', exact: true })
    .click()
  await expect(scope.getByText(`Remove ${name}’s access?`, { exact: true })).toBeVisible()
  await scope.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(scope.getByText(`Remove ${name}’s access?`, { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await expect(personActions(scope, name)).toHaveCount(0)
}
