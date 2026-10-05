import { test, expect, type CinnaApp } from '../fixtures/app'
import { closeTaskFilters, openTaskFilters, showTasksLayout } from '../fixtures/tasksView'

/**
 * The Tasks view (`TasksView`): the top bar's Tasks button, New task with and
 * without More options, the Agents layout it opens on, the Filters form's
 * period and search with their pills beside Filters, the list grouped by
 * category, the board's drag and its ⋯ keyboard path, the remembered layout
 * choice and the Settings → Features switch that hides the button.
 *
 * Everything is driven through the UI; main is read back with `tasks.list()` /
 * `tasks.get()` to prove a move was stored, not only drawn. No model, engine or
 * credential is needed: a hand-written task is a desktop task that runs here.
 */

const ALPHA = 'E2E alpha task'
const BRAVO = 'E2E bravo task'

const tasksButton = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: 'Tasks', exact: true })
const newTaskDialog = (cinna: CinnaApp) => cinna.page.getByRole('dialog', { name: 'New task', exact: true })
const board = (cinna: CinnaApp, category: 'backlog' | 'ready' | 'active' | 'waiting' | 'closed') =>
  cinna.page.locator(`[data-board-column="${category}"]`)
const card = (cinna: CinnaApp, title: string) =>
  cinna.page.locator('[data-task-card]').filter({ hasText: title })

async function taskId(cinna: CinnaApp, title: string): Promise<string> {
  const tasks = await cinna.page.evaluate(() => window.api.tasks.list())
  const task = tasks.find((entry) => entry.title === title)
  if (!task) throw new Error(`main has no task titled ${title}`)
  return task.id
}

const statusOf = (cinna: CinnaApp, id: string): Promise<string> =>
  cinna.page.evaluate(async (taskId) => (await window.api.tasks.get(taskId)).status, id)

/**
 * A real HTML5 drag with the mouse, from a card onto a column. The column's
 * accent outline is drawn only once it has taken a `dragover` it accepts, so
 * that outline is the signal the drop will land; Chromium throttles
 * `dragover` and a still pointer sends none, so the pointer is nudged by a
 * pixel until it shows (as `chat-list-order.spec.ts` does).
 */
async function dragCardTo(cinna: CinnaApp, title: string, column: 'backlog' | 'ready' | 'closed'): Promise<void> {
  const page = cinna.page
  const from = await card(cinna, title).boundingBox()
  const to = await board(cinna, column).boundingBox()
  if (!from || !to) throw new Error('the card or the column is not on screen')
  await page.mouse.move(from.x + from.width / 3, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 3, from.y + from.height / 2 + 4, { steps: 2 })
  const x = to.x + to.width / 2
  const y = to.y + to.height - 20
  await page.mouse.move(x, y, { steps: 8 })
  let nudge = 0
  await expect.poll(async () => {
    nudge = 1 - nudge
    await page.mouse.move(x + nudge, y)
    return board(cinna, column).getAttribute('class')
  }).toContain('outline-[var(--color-accent)]')
  await page.mouse.up()
}

async function openFeatures(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Features', exact: true }).click()
}

test('Tasks view: create, agents, filters, list, board moves, search, remembered layout, and the Features switch', async ({ cinna }) => {
  await cinna.skipOnboarding()

  await test.step('the top bar has Tasks immediately left of Agent status, and it opens the view', async () => {
    await expect(tasksButton(cinna)).toBeVisible()
    const next = await tasksButton(cinna).evaluate((el) => el.nextElementSibling?.getAttribute('aria-label') ?? null)
    expect(next).toMatch(/^Agent status/)
    await expect(tasksButton(cinna)).toHaveAttribute('aria-pressed', 'false')
    await tasksButton(cinna).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: 'Tasks', exact: true })).toBeVisible()
    await expect(tasksButton(cinna)).toHaveAttribute('aria-pressed', 'true')
    await expect(cinna.page.getByText('No tasks yet.', { exact: true })).toBeVisible()
  })

  await test.step('New task: a title and Enter land on the task page; its arrow goes back to Tasks', async () => {
    await cinna.page.getByRole('button', { name: 'New task', exact: true }).click()
    const title = newTaskDialog(cinna).getByRole('textbox', { name: 'Title', exact: true })
    await expect(title).toBeFocused()
    await title.fill(ALPHA)
    await title.press('Enter')
    await expect(newTaskDialog(cinna)).toHaveCount(0)
    await expect(cinna.page.getByRole('heading', { level: 1, name: ALPHA, exact: true })).toBeVisible()
    const details = cinna.page.getByRole('complementary', { name: 'Details', exact: true })
    await expect(details.getByText('Backlog', { exact: true })).toBeVisible()
    await cinna.page.getByRole('button', { name: 'Back to Tasks', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: 'Tasks', exact: true })).toBeVisible()
  })

  await test.step('More options: status Ready and a custom field, shown under Fields in Details', async () => {
    await cinna.page.getByRole('button', { name: 'New task', exact: true }).click()
    const dialog = newTaskDialog(cinna)
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(BRAVO)
    await dialog.getByRole('button', { name: 'More options', exact: true }).click()
    await dialog.getByLabel('Status', { exact: true }).selectOption({ label: 'Ready' })
    await dialog.getByRole('button', { name: 'Add field', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Field 1 name', exact: true }).fill('area')
    await dialog.getByRole('textbox', { name: 'Field 1 value', exact: true }).fill('docs')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(cinna.page.getByRole('heading', { level: 1, name: BRAVO, exact: true })).toBeVisible()
    const details = cinna.page.getByRole('complementary', { name: 'Details', exact: true })
    await expect(details.getByText('Ready', { exact: true })).toBeVisible()
    const fields = details.getByRole('region', { name: 'Fields', exact: true })
    await expect(fields.getByRole('heading', { name: 'Fields', exact: true })).toBeVisible()
    await expect(fields.getByRole('term')).toHaveText(['area'])
    await expect(fields.getByRole('definition')).toHaveText(['docs'])

    const stored = await cinna.page.evaluate(() => window.api.tasks.list())
    const bravo = stored.find((task) => task.title === 'E2E bravo task')
    expect(bravo?.status).toBe('open')
    expect(bravo?.customFields).toEqual({ area: 'docs' })
    await cinna.page.getByRole('button', { name: 'Back to Tasks', exact: true }).click()
  })

  await test.step('Agents is the default layout: each task sits in its agent’s card, here No agent', async () => {
    await expect(cinna.page.getByRole('group', { name: 'Tasks layout' }).getByRole('button', { name: 'Agents', exact: true }))
      .toHaveAttribute('aria-pressed', 'true')
    const noAgent = cinna.page.getByRole('region', { name: 'No agent', exact: true })
    await expect(noAgent.getByRole('button', { name: `${ALPHA} — Backlog`, exact: true })).toBeVisible()
    await expect(noAgent.getByRole('button', { name: `${BRAVO} — Ready`, exact: true })).toBeVisible()
    // Open work counted in the card's header, as glyphs named by the sentence: Backlog is not.
    await expect(noAgent.locator('header').getByRole('img', { name: '1 ready', exact: true })).toBeVisible()
  })

  await test.step('Filters: the period radio changes the period pill beside Filters, and its × goes to All time', async () => {
    // Every pill stays mounted (a collapsed one aria-hidden, keeping its words): read the exposed ×s, not the text.
    const applied = cinna.page.getByRole('group', { name: 'Applied filters', exact: true })
    await expect(applied.getByRole('button')).toHaveCount(1)
    await expect(applied.getByRole('button', { name: 'Remove Last week', exact: true })).toBeVisible()
    const form = await openTaskFilters(cinna.page)
    await expect(form.getByRole('searchbox', { name: 'Search tasks', exact: true })).toBeFocused()
    const period = form.getByRole('radiogroup', { name: 'Changed in', exact: true })
    await expect(period.getByRole('radio', { name: 'Last week', exact: true })).toHaveAttribute('aria-checked', 'true')
    await period.getByRole('radio', { name: 'Last month', exact: true }).click()
    await expect(period.getByRole('radio', { name: 'Last month', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(applied.getByRole('button', { name: 'Remove Last month', exact: true })).toBeVisible()
    await expect(applied.getByRole('button')).toHaveCount(1)
    await closeTaskFilters(cinna.page)
    await expect(cinna.page.getByRole('button', { name: 'Filters', exact: true })).toBeFocused()
    await applied.getByRole('button', { name: 'Remove Last month', exact: true }).click()
    // All time has no pill: nothing applied, the block is just Filters.
    await expect(applied.getByRole('button')).toHaveCount(0)
    const again = await openTaskFilters(cinna.page)
    await expect(again.getByRole('radio', { name: 'All time', exact: true })).toHaveAttribute('aria-checked', 'true')
    await again.getByRole('radio', { name: 'Last week', exact: true }).click()
    await closeTaskFilters(cinna.page)
    await expect(applied.getByRole('button', { name: 'Remove Last week', exact: true })).toBeVisible()
  })

  await test.step('List: each task under its category, with counts', async () => {
    await showTasksLayout(cinna.page, 'List')
    const backlog = cinna.page.getByRole('region', { name: 'Backlog', exact: true })
    const ready = cinna.page.getByRole('region', { name: 'Ready', exact: true })
    await expect(backlog.getByRole('heading', { level: 2 })).toHaveText('Backlog1')
    await expect(ready.getByRole('heading', { level: 2 })).toHaveText('Ready1')
    await expect(backlog.getByRole('button', { name: `${ALPHA} — Backlog`, exact: true })).toBeVisible()
    await expect(ready.getByRole('button', { name: `${BRAVO} — Ready`, exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('region', { name: 'Done', exact: true }).getByRole('heading', { level: 2 }))
      .toHaveText('Done0')
  })

  const alphaId = await taskId(cinna, ALPHA)
  const bravoId = await taskId(cinna, BRAVO)

  await test.step('Board: drag Backlog → Ready, then ⋯ Move to Done; main stores both', async () => {
    await cinna.page.getByRole('group', { name: 'Tasks layout' }).getByRole('button', { name: 'Board', exact: true }).click()
    await expect(board(cinna, 'backlog').getByRole('button', { name: `${ALPHA} — Backlog`, exact: true })).toBeVisible()
    await expect(board(cinna, 'ready').getByRole('button', { name: `${BRAVO} — Ready`, exact: true })).toBeVisible()
    await expect(card(cinna, ALPHA)).toHaveAttribute('draggable', 'true')

    await dragCardTo(cinna, ALPHA, 'ready')
    await expect(board(cinna, 'ready').getByRole('button', { name: `${ALPHA} — Ready`, exact: true })).toBeVisible()
    await expect(board(cinna, 'backlog').locator('[data-task-card]')).toHaveCount(0)
    await expect.poll(() => statusOf(cinna, alphaId)).toBe('open')

    await cinna.page.getByRole('button', { name: `Actions for ${BRAVO}`, exact: true }).click()
    const menu = cinna.page.getByRole('menu', { name: 'Task actions', exact: true })
    await expect(menu.getByRole('menuitem')).toHaveText(['Move to Backlog', 'Move to Done'])
    await menu.getByRole('menuitem', { name: 'Move to Done', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(board(cinna, 'closed').getByRole('button', { name: `${BRAVO} — Done`, exact: true })).toBeVisible()
    await expect.poll(() => statusOf(cinna, bravoId)).toBe('completed')

    // A Done card has nowhere to go: no ⋯ and not draggable.
    await expect(cinna.page.getByRole('button', { name: `Actions for ${BRAVO}`, exact: true })).toHaveCount(0)
    await expect(card(cinna, BRAVO)).toHaveAttribute('draggable', 'false')
    await expect(cinna.page.getByRole('alert')).toHaveCount(0)

    await board(cinna, 'closed').getByRole('button', { name: `${BRAVO} — Done`, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: BRAVO, exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('complementary', { name: 'Details', exact: true }).getByText('Done', { exact: true }))
      .toBeVisible()
    await cinna.page.getByRole('button', { name: 'Back to Tasks', exact: true }).click()
    await expect(board(cinna, 'closed').getByRole('button', { name: `${BRAVO} — Done`, exact: true })).toBeVisible()
  })

  await test.step('Search: a query nothing matches says so; its pill beside Filters clears it', async () => {
    const search = (await openTaskFilters(cinna.page)).getByRole('searchbox', { name: 'Search tasks', exact: true })
    await search.fill('zzqx nothing like this')
    await expect(cinna.page.getByText('No tasks match.', { exact: true })).toBeVisible()
    await expect(cinna.page.locator('[data-task-card]')).toHaveCount(0)
    await search.fill('alpha')
    await expect(cinna.page.locator('[data-task-card]')).toHaveCount(1)
    await expect(card(cinna, ALPHA)).toBeVisible()
    await closeTaskFilters(cinna.page)
    const applied = cinna.page.getByRole('group', { name: 'Applied filters', exact: true })
    await expect(applied.getByText('“alpha”', { exact: true })).toBeVisible()
    await applied.getByRole('button', { name: 'Clear the search', exact: true }).click()
    await expect(cinna.page.locator('[data-task-card]')).toHaveCount(2)
    await expect(applied.getByRole('button', { name: 'Clear the search', exact: true })).toHaveCount(0)
  })

  await test.step('the Board choice survives a relaunch', async () => {
    await cinna.relaunch()
    await tasksButton(cinna).click()
    const layout = cinna.page.getByRole('group', { name: 'Tasks layout' })
    await expect(layout.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(layout.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(board(cinna, 'ready').getByRole('button', { name: `${ALPHA} — Ready`, exact: true })).toBeVisible()
    await expect(board(cinna, 'closed').getByRole('button', { name: `${BRAVO} — Done`, exact: true })).toBeVisible()
  })

  await test.step('Settings → Features → Tasks button off hides the top-bar button', async () => {
    await openFeatures(cinna)
    const toggle = cinna.page.getByRole('switch', { name: 'Tasks button', exact: true })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(tasksButton(cinna)).toHaveCount(0)
    await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(cinna.page.getByRole('button', { name: /^Agent status/ })).toBeVisible()
    await expect(tasksButton(cinna)).toHaveCount(0)
  })
})
