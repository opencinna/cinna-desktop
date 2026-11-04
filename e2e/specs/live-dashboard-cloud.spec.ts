import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect } from '../fixtures/app'
import { coreCall, makeTeamTest, type PersonApp, type TeamFixtureBase } from '../fixtures/liveTeamSharing'

/**
 * Dashboards D6 against the **real** local cinna-core: tiles for the
 * profile's own cloud agent, whose components really run in its environment.
 *
 * Setup: `e2e/fixtures/live-dashboard-cloud.py create opencode claude-haiku`
 * (see its docstring): one person, `agent-developer`, and per engine a cloud
 * agent `Dash cloud e2e <engine> <tag>` on a real AI key (`opencode/openai`
 * with `gpt-5.6-luna`, `claude-code/anthropic` with `claude-haiku-4-5`;
 * `CINNA_E2E_LIVE_MODEL` overrides), with `dashboards/ledger-items` (a native
 * list) and `dashboards/ledger-page` (an html page with a `ping` endpoint)
 * written into its workspace. `CINNA_DASHBOARD_CLOUD_LIVE_FIXTURE` points at
 * the JSON it printed; without it every test skips. Core must be at
 * `2fca550b`+ with migration `7c1d4e8a2b90` applied.
 *
 * Engines: `CINNA_E2E_LIVE_DASHBOARD_CLOUD_ENGINES=claude-haiku,opencode`
 * (the default), one `test.describe('on <engine>')` each, titled
 * `L<n> [<engine>] …`, so `GREP="\[opencode\]"` picks one. An engine the
 * fixture did not make skips.
 *
 * Billing: L1 and L2 run no model (endpoints are plain scripts). L3 makes two
 * short turns in the cloud environment, on the key the fixture was given.
 *
 * What it proves: the desktop, signed in with real desktop tokens, lists the
 * cloud agent's components from core, adds one (a desktop-owned backing
 * dashboard core keeps off the web list), draws data the environment
 * computed, relays an html page's files from `/d/v/` with core's bridge and
 * round-trips its `cinna.call`; the panel chat's context reaches the agent as
 * A2A metadata (it names the selected row, which the question does not), and
 * the agent's `dashboards_update_tile` highlight reaches the tile over core's
 * socket.
 *
 * What it does not prove: failure marks, re-minting, header stripping and
 * params (`dashboard-cloud.spec.ts` against a fake core covers those).
 */

interface CloudAgentFixture {
  id: string
  name: string
  envId: string
  sdk: string | null
  model: string
}

interface DashCloudFixture extends TeamFixtureBase {
  agents: Record<string, CloudAgentFixture>
}

const fixturePath = (process.env.CINNA_DASHBOARD_CLOUD_LIVE_FIXTURE ?? '').trim()

function dashCloudFixture(): DashCloudFixture | null {
  if (!fixturePath || !existsSync(fixturePath)) return null
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as Omit<DashCloudFixture, 'people'> & {
    people: Record<'a', TeamFixtureBase['people']['a']>
  }
  // The team fixture's shape names three people; this one has one, and only A is ever opened.
  return { ...raw, people: { a: raw.people.a, b: raw.people.a, c: raw.people.a } }
}

const test = makeTeamTest(
  dashCloudFixture,
  'Set CINNA_DASHBOARD_CLOUD_LIVE_FIXTURE to the JSON printed by e2e/fixtures/live-dashboard-cloud.py create (a running local cinna-core)'
)

const ENGINES = (process.env.CINNA_E2E_LIVE_DASHBOARD_CLOUD_ENGINES ?? 'claude-haiku,opencode')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

/** A page that may wake an environment and run a script there: generous, never a sleep. */
const CLOUD_WAIT = 180_000

/**
 * Dashboards on, the product's own sync writes the remote row, a restart
 * (which also writes a fresh desktop token pair) so every store reads it.
 * Answers the agent's row id.
 */
async function prepare(app: PersonApp, agent: CloudAgentFixture): Promise<string> {
  await app.page.evaluate(() => window.api.settings.set('dashboardsCapability', 'on'))
  await app.page.getByRole('button', { name: 'Dashboards', exact: true }).waitFor()
  const synced = await app.page.evaluate(() => window.api.agents.syncRemote())
  expect(synced).toMatchObject({ success: true })
  const row = (await app.page.evaluate(() => window.api.agents.list())).find((entry) => entry.name === agent.name)
  expect(row, `${agent.name} was not synced`).toMatchObject({ source: 'remote', remoteTargetType: 'agent', remoteTargetId: agent.id })
  await app.relaunch()
  await app.page.getByRole('button', { name: 'Dashboards', exact: true }).waitFor()
  return row!.id
}

async function addTile(app: PersonApp, agentId: string, component: string, dashboard: string): Promise<void> {
  const added = await app.page.evaluate(
    ({ agentId, component, dashboard }) => window.api.dashboards.addTile({ newDashboardName: dashboard, agentId, component }),
    { agentId, component, dashboard }
  )
  expect(added, JSON.stringify(added)).toMatchObject({ ok: true })
}

async function openDashboard(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Dashboards', exact: true }).click()
  await page.getByRole('button', { name: `${name}, 1 tile`, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
}

function tile(page: Page, title: string) {
  return page.getByTestId('dashboard-grid').getByRole('group', { name: title, exact: true })
}

/** Send in the panel's composer and wait until the chat that starts with `text` has a finished reply; answers it. */
async function panelTurn(app: PersonApp, text: string): Promise<string> {
  const panel = app.page.getByTestId('dashboard-chat-panel')
  const composer = panel.getByRole('combobox', { name: 'Type a message...', exact: true })
  await composer.fill(text)
  await composer.press('Enter')
  let reply = ''
  await expect
    .poll(
      async () => {
        const found = await app.page.evaluate(async (question) => {
          for (const row of await window.api.chat.list()) {
            const chat = await window.api.chat.get(row.id)
            if (!chat) continue
            const users = chat.messages.filter((m) => m.role === 'user')
            const at = chat.messages.findIndex((m) => m.role === 'user' && m.content === question)
            if (at < 0 || users.length === 0) continue
            const after = chat.messages.slice(at + 1).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n')
            return { reply: after, running: !!chat.activeRunId }
          }
          return null
        }, text)
        if (!found) return 'no chat yet'
        if (found.running) return 'turn still running'
        reply = found.reply
        return found.reply ? 'answered' : 'no reply'
      },
      { timeout: 240_000, intervals: [2_000], message: 'the cloud agent never finished its reply' }
    )
    .toBe('answered')
  return reply
}

for (const engine of ENGINES) {
  test.describe(`on ${engine}`, () => {
    function agentOf(fixture: DashCloudFixture): CloudAgentFixture {
      const agent = fixture.agents?.[engine]
      test.skip(!agent, `the fixture has no ${engine} agent; run live-dashboard-cloud.py create ${engine}`)
      return agent!
    }

    test(`L1 [${engine}] the Dashboards tab lists the cloud agent’s component; Add draws the environment’s data on a backing dashboard the web list hides`, async ({ team }) => {
      test.setTimeout(420_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const person = fixture.people.a
      const app = await team.open('a')
      await prepare(app, agent)
      const page = app.page
      const dashboard = `Ledger ${engine} ${fixture.tag}`

      await test.step('the agent page’s Dashboards tab lists both components from core', async () => {
        await page.getByRole('button', { name: 'Agents', exact: true }).click()
        await page.getByRole('button', { name: agent.name, exact: true }).click()
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(agent.name)
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        const tabs = page.getByRole('tablist', { name: 'Agent settings', exact: true }).getByRole('tab')
        await expect(tabs).toHaveText(['Overview', 'Connection', 'Interface', 'Dashboards'])
        await tabs.filter({ hasText: 'Dashboards' }).click()
        await expect(page.getByRole('heading', { level: 3, name: 'Ledger items', exact: true })).toBeVisible({ timeout: 60_000 })
        await expect(page.getByRole('heading', { level: 3, name: 'Ledger page', exact: true })).toBeVisible()
      })

      await test.step('Add to a new dashboard', async () => {
        await page.getByRole('button', { name: 'Add Ledger items to a dashboard', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Add Ledger items to a dashboard', exact: true })
        await expect(dialog).toBeVisible()
        await dialog.getByLabel('Dashboard', { exact: true }).fill(dashboard)
        await dialog.getByRole('button', { name: 'Add', exact: true }).click()
        await expect(dialog).toHaveCount(0, { timeout: 60_000 })
      })

      await test.step('the tile draws what the environment computed', async () => {
        await openDashboard(page, dashboard)
        const items = tile(page, 'Ledger items')
        await expect(items.getByText(`stamp ${fixture.tag}`, { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })
        await expect(items.getByText('Kestrel ledger', { exact: true })).toBeVisible()
      })

      await test.step('core keeps the backing dashboard off the web list; ?origin=desktop has it with the block', async () => {
        const web = await coreCall(fixture, person.token, '/dashboards/')
        expect(web.status).toBe(200)
        expect((web.body as { name: string }[]).map((d) => d.name)).not.toContain(dashboard)
        const desktop = await coreCall(fixture, person.token, '/dashboards/?origin=desktop')
        expect(desktop.status).toBe(200)
        const backing = (desktop.body as { name: string; origin: string; blocks: { agent_id: string; view_type: string; config: { component: string } }[] }[])
          .filter((d) => d.name === dashboard)
        expect(backing).toHaveLength(1)
        expect(backing[0].origin).toBe('desktop')
        expect(backing[0].blocks.map((b) => ({ agent: b.agent_id, view: b.view_type, component: b.config.component }))).toEqual([
          { agent: agent.id, view: 'agent_component', component: 'ledger-items' }
        ])
      })
    })

    test(`L2 [${engine}] an html component’s page loads through the relay with core’s bridge, and its cinna.call runs in the environment`, async ({ team }) => {
      test.setTimeout(420_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const app = await team.open('a')
      const agentId = await prepare(app, agent)
      const dashboard = `Ledger page ${engine} ${fixture.tag}`
      await addTile(app, agentId, 'ledger-page', dashboard)
      await openDashboard(app.page, dashboard)
      const frame = tile(app.page, 'Ledger page').frameLocator('[data-testid="dashboard-frame"]')
      await expect(frame.locator('#state')).toHaveText('ready ledger-page', { timeout: CLOUD_WAIT })
      await expect(frame.locator('#call')).toHaveText('call {"pong":7,"from":"env"}', { timeout: CLOUD_WAIT })
    })

    test(`L3 [${engine}] the panel chat’s context reaches the agent over A2A (it names the selected row), and its highlight reaches the tile over the socket`, async ({ team }) => {
      test.setTimeout(600_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const app = await team.open('a')
      const agentId = await prepare(app, agent)
      const page = app.page
      const dashboard = `Ledger chat ${engine} ${fixture.tag}`
      await addTile(app, agentId, 'ledger-items', dashboard)
      await openDashboard(page, dashboard)
      const items = tile(page, 'Ledger items')
      await expect(items.getByText('Kestrel ledger', { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })

      await test.step('select Kestrel ledger and open the panel on the tile', async () => {
        // The hover bar floats over the top of the first row: click it low and right.
        const row = items.locator('li', { hasText: 'Kestrel ledger' })
        const box = await row.boundingBox()
        await row.click({ position: { x: box!.width - 12, y: box!.height - 4 } })
        await expect(row).toHaveAttribute('aria-selected', 'true')
        await items.hover()
        await items.getByRole('button', { name: 'Ask about Ledger items', exact: true }).click()
        const chip = page.getByTestId('dashboard-chat-panel').getByTestId('dashboard-context-chip')
        await expect(chip).toContainText('Ledger items · 1 selected')
      })

      await test.step('turn 1: the agent names the selected row, which only the dashboard context says', async () => {
        const reply = await panelTurn(app, 'Which row is selected on the tile I am looking at? Reply with that row’s title only.')
        expect(reply).toMatch(/kestrel/i)
      })

      await test.step('turn 2: the agent’s highlight reaches the tile through core’s socket', async () => {
        await panelTurn(
          app,
          // Both steps named: Haiku otherwise passes the component name as `tile_id`, which core refuses as not its tile.
          'Call dashboards_tiles to get the tile_id of the Ledger items tile, then call dashboards_update_tile with that tile_id and highlight ["osprey"]. Reply "done".'
        )
        const highlighted = items.locator('li[data-highlighted="true"]')
        await expect(highlighted).toHaveCount(1, { timeout: 60_000 })
        await expect(highlighted).toContainText('Osprey invoice')
      })
    })
  })
}
