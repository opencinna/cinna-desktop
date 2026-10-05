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

/**
 * The Tasks view's Filters form (`TasksFilterButton`): the search, the Agent
 * select and the Changed in period. Opened from its button unless it is open
 * already; returns the form.
 */
export async function openTaskFilters(page: Page): Promise<Locator> {
  const form = page.getByRole('dialog', { name: 'Filter tasks', exact: true })
  if (await form.count() === 0) await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await expect(form).toBeVisible()
  return form
}

/** Close the Filters form with Escape, as a user leaves it. */
export async function closeTaskFilters(page: Page): Promise<void> {
  const form = page.getByRole('dialog', { name: 'Filter tasks', exact: true })
  await page.keyboard.press('Escape')
  await expect(form).toHaveCount(0)
}

/**
 * Filter the open Tasks view to one agent (its option label, the agent's
 * name) through the Filters form, then close the form. The choice lives in the
 * store for the window's life, so it survives a visit to a task page.
 */
export async function filterTasksByAgent(page: Page, label: string): Promise<void> {
  const form = await openTaskFilters(page)
  await form.getByRole('combobox', { name: 'Agent', exact: true }).selectOption({ label })
  await closeTaskFilters(page)
  // Its pill: a collapsed pill keeps its words but is aria-hidden, so look for the exposed ×.
  await expect(page.getByRole('group', { name: 'Applied filters', exact: true })
    .getByRole('button', { name: `Remove the ${label} filter`, exact: true })).toBeVisible()
}

/**
 * Press one of the Tasks view's layouts (Agents, the default, Recent, Board or
 * List). The List layout's sections (`Waiting`, `Ready`, …) exist only there.
 */
export async function showTasksLayout(page: Page, name: 'Agents' | 'Recent' | 'Board' | 'List'): Promise<void> {
  const button = page.getByRole('group', { name: 'Tasks layout', exact: true }).getByRole('button', { name, exact: true })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
}
