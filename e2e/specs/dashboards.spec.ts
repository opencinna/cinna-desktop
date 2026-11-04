import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * Dashboards D1: a kit agent with four components — a markdown file source,
 * a list fed by a Python endpoint (`uv run`), a page drawn from a Node
 * endpoint, and the kit's own web-view template (`revenue-by-week`: a Python
 * source, a `month: current` param, and `cinna.call`/`setContext`/`setParams`
 * against the kit's bridge) — added from the agent's Dashboards tab, rendered
 * on a dashboard, then shown again from the cache when the dashboard is reopened.
 *
 * Real endpoints run: `uv run` with the developer's tool caches (the sandbox
 * reuses them), and `node` from the sandbox's PATH. The Python endpoint
 * counts its runs in `app-data/dashboards/open-tasks/runs.txt`, which is how
 * the reopen step proves it showed the cache rather than running again.
 */

const AGENT = 'Sales Desk'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dashboards')

async function openDashboardsTab(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Dashboards/ }).click()
}

test('three components added from the agent tab render on a dashboard, and a reopened dashboard shows its cache at once', async ({ cinna }) => {
  test.setTimeout(180_000)
  const page = cinna.page
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT)
  for (const name of ['daily-notes', 'open-tasks', 'weekly-chart', 'revenue-by-week']) {
    cpSync(join(FIXTURES, name), join(agent.path, 'dashboards', name), { recursive: true })
  }
  mkdirSync(join(agent.path, 'app-data'), { recursive: true })
  cpSync(join(FIXTURES, 'app-data', 'notes.md'), join(agent.path, 'app-data', 'notes.md'))
  const runsFile = join(agent.path, 'app-data', 'dashboards', 'open-tasks', 'runs.txt')

  await test.step('the agent’s Dashboards tab lists its four components, valid and not placed', async () => {
    await openDashboardsTab(cinna)
    for (const title of ['Daily notes', 'Open tasks', 'Weekly signups', 'Revenue by week']) {
      await expect(page.getByRole('heading', { level: 3, name: title })).toBeVisible()
    }
    await expect(page.getByText('Not on a dashboard yet.')).toHaveCount(4)
  })

  await test.step('each is added with the dialog’s prefilled choices; the first makes My dashboard', async () => {
    for (const title of ['Daily notes', 'Open tasks', 'Weekly signups', 'Revenue by week']) {
      await page.getByRole('button', { name: `Add ${title} to a dashboard` }).click()
      const dialog = page.getByRole('dialog', { name: `Add ${title} to a dashboard` })
      await expect(dialog).toBeVisible()
      // The live preview ran the source once.
      await expect(dialog.getByTestId('component-preview')).toBeVisible()
      await dialog.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(dialog).toBeHidden()
      const card = page.locator(`[data-component]`).filter({ has: page.getByRole('heading', { level: 3, name: title }) })
      await expect(card.getByRole('button', { name: 'My dashboard' })).toBeVisible()
    }
  })

  await test.step('the dashboard draws all four: markdown, the Python list, the Node-fed page and the kit template', async () => {
    await page.locator('[data-component="daily-notes"]').getByRole('button', { name: 'My dashboard' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My dashboard')
    const grid = page.getByTestId('dashboard-grid')
    await expect(grid.getByRole('group', { name: 'Daily notes' }).getByText('Call')).toBeVisible({ timeout: 30_000 })
    await expect(grid.getByRole('group', { name: 'Open tasks' }).getByText('Renew the Acme contract')).toBeVisible({ timeout: 60_000 })
    const frame = grid.getByRole('group', { name: 'Weekly signups' }).frameLocator('[data-testid="dashboard-frame"]')
    await expect(frame.locator('#title')).toHaveText('Signups this week', { timeout: 30_000 })
    await expect(frame.locator('rect')).toHaveCount(7)
    // The kit template, on the kit's bridge: its Python source got `current` as this month,
    // and a click's `cinna.call` (D4) runs its own week_detail endpoint as a drill-down.
    // Below the fold at this window size: only a tile on screen computes, so bring it there.
    await grid.getByRole('group', { name: 'Revenue by week' }).scrollIntoViewIfNeeded()
    const revenue = grid.getByRole('group', { name: 'Revenue by week' }).frameLocator('[data-testid="dashboard-frame"]')
    await expect(revenue.locator('rect.bar')).toHaveCount(4, { timeout: 60_000 })
    await expect(revenue.locator('#status')).toHaveText('Sample data: nothing has been written yet.')
    const now = new Date()
    await expect(revenue.locator('#month')).toHaveValue(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
    await revenue.locator('rect.bar').first().click()
    await expect(revenue.locator('#detail-list li')).toHaveText(['Acme renewal: 9,800 EUR', 'Globex pilot: 4,200 EUR'], { timeout: 30_000 })
    await expect.poll(() => (existsSync(runsFile) ? readFileSync(runsFile, 'utf8') : '')).not.toBe('')
  })

  await test.step('reopened, the dashboard shows the cached data at once and runs nothing', async () => {
    // Settle: the preview and the first tile run have both written their count.
    const runsBefore = readFileSync(runsFile, 'utf8')
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await expect(page.getByTestId('dashboard-grid')).toHaveCount(0)
    await page.getByRole('button', { name: 'Dashboards', exact: true }).click()
    const grid = page.getByTestId('dashboard-grid')
    // At once: well under any endpoint's run time.
    await expect(grid.getByRole('group', { name: 'Open tasks' }).getByText('Renew the Acme contract')).toBeVisible({ timeout: 1500 })
    await expect(grid.getByRole('group', { name: 'Daily notes' }).getByText('Call')).toBeVisible({ timeout: 1500 })
    await expect(grid.getByRole('group', { name: 'Weekly signups' }).frameLocator('[data-testid="dashboard-frame"]').locator('rect')).toHaveCount(7, { timeout: 5000 })
    await page.waitForTimeout(1500)
    expect(readFileSync(runsFile, 'utf8')).toBe(runsBefore)
  })
})
