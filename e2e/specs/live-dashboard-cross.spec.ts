import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '../fixtures/app'
import { CinnaCli } from '../fixtures/cinnaCli'
import { coreCall, makeTeamTest, type PersonApp, type TeamFixtureBase } from '../fixtures/liveTeamSharing'

/**
 * Dashboards across **all three products on one real cloud agent**: Cinna
 * Desktop (this build), the real local cinna-core, and cinna-cli run from
 * source. Each scenario touches at least two of them, so a contract one of
 * them reads differently shows up here and not in any one product's own suite.
 *
 * Setup: `e2e/fixtures/live-dashboard-cross.py create opencode claude-haiku`
 * (see its docstring): one `agent-developer` person and per engine a cloud
 * agent `Dash cross e2e <engine> <tag>` with **no** components.
 * `CINNA_DASHBOARD_CROSS_LIVE_FIXTURE` points at the JSON it printed; without
 * it every test skips. Core must be at `c32f211b`+ (the CLI's capabilities
 * route) with migration `7c1d4e8a2b90`. The CLI comes from `CINNA_CLI_PATH`
 * (default `../cinna-cli`), run with `uv`; it signs in through a real account
 * setup token and syncs the agent with Mutagen, all in a sandboxed `HOME`.
 *
 * Engines: `CINNA_E2E_LIVE_DASHBOARD_CROSS_ENGINES=opencode,claude-haiku`
 * (the default), one `describe('on <engine>')` each, tests titled
 * `X<n> [<engine>] …`, so `GREP="\[opencode\]"` picks one.
 *
 * Per engine, before the tests: the CLI signs in, syncs the agent and writes
 * `dashboards/deals/` (a `table` with an enum param `stage`, rows only a run
 * can print) into the synced workspace; `check --run` must pass.
 *
 * - X1 the CLI-authored component is on desktop's agent Dashboards tab; Add
 *   draws the rows `cinna dashboards run` prints.
 * - X2 a desktop tile's backing dashboard: placements say Cinna Desktop, the
 *   CLI lists and reads it by id only and refuses to change it
 *   (`desktop_dashboard`), core's web list hides it. A direct core write
 *   through the CLI's api-proxy is recorded, not asserted (see the test).
 * - X3 a CLI web dashboard with the same component: on the web list, not on
 *   desktop; its params change leaves the desktop tile's params alone.
 * - X4 a CLI edit (new rows) reaches the desktop tile on Refresh; a broken
 *   component is refused by `check` and the desktop tile says it has problems.
 * - X5 the reference `cinna dashboards ref` prints, said by the agent in a
 *   desktop chat, becomes a card for the owned cloud agent; its Add places it.
 * - X6 `cinna chat --board` changes the web tile's params through the tile
 *   tools; the desktop panel chat on the same agent still reads its own tile
 *   (all stages) and its params stay untouched.
 *
 * Billing: X1–X4 run no model. X5 makes one turn, X6 two (one CLI, one
 * desktop), in the cloud environment on the fixture's key.
 */

interface CloudAgentFixture {
  id: string
  name: string
  envId: string
  sdk: string | null
  model: string
}

interface DashCrossFixture extends TeamFixtureBase {
  agents: Record<string, CloudAgentFixture>
}

const fixturePath = (process.env.CINNA_DASHBOARD_CROSS_LIVE_FIXTURE ?? '').trim()

function dashCrossFixture(): DashCrossFixture | null {
  if (!fixturePath || !existsSync(fixturePath)) return null
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as Omit<DashCrossFixture, 'people'> & {
    people: Record<'a', TeamFixtureBase['people']['a']>
  }
  // The team fixture's shape names three people; this one has one, and only A is ever opened.
  return { ...raw, people: { a: raw.people.a, b: raw.people.a, c: raw.people.a } }
}

const test = makeTeamTest(
  dashCrossFixture,
  'Set CINNA_DASHBOARD_CROSS_LIVE_FIXTURE to the JSON printed by e2e/fixtures/live-dashboard-cross.py create (a running local cinna-core)'
)

const ENGINES = (process.env.CINNA_E2E_LIVE_DASHBOARD_CROSS_ENGINES ?? 'opencode,claude-haiku')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

/** A page that may wake an environment and run a script there: generous, never a sleep. */
const CLOUD_WAIT = 180_000
const COMPONENT = 'deals'
/**
 * Every dashboard name carries this run's nonce: core keeps a closed sandbox's backing dashboards and the
 * CLI's web boards for the fixture's whole life, so a rerun on the same fixture would find two of a name.
 */
const RUN = Date.now().toString(36)
const TITLE = 'Open deals'

const COMPONENT_JSON = {
  schema_version: 1,
  title: TITLE,
  description: 'Open deals, by stage.',
  view: 'table',
  size: 'm',
  source: { endpoint: 'rows' },
  endpoints: { rows: { script: 'api/rows.py', description: 'Open deals. Params: stage.' } },
  params: { stage: { type: 'enum', label: 'Stage', values: ['all', 'won'], default: 'all' } },
  refresh: { max_age: '1h' },
  context: 'One row per deal; amount in EUR.'
}

/** Params arrive on stdin as one JSON object (guide 14); the stamp row is only printed by a run of this file. */
function rowsScript(stamp: string): string {
  return [
    'import json, sys',
    'params = json.loads(sys.stdin.read() or "{}")',
    'rows = [{"id": "d1", "name": "Acme", "stage": "won", "amount": 1200},',
    '        {"id": "d2", "name": "Globex", "stage": "open", "amount": 800},',
    `        {"id": "d3", "name": "${stamp}", "stage": "open", "amount": 1}]`,
    'if params.get("stage") == "won":',
    '    rows = [r for r in rows if r["stage"] == "won"]',
    'cols = [{"key": "name", "label": "Name"}, {"key": "stage", "label": "Stage"}, {"key": "amount", "label": "Amount"}]',
    'print(json.dumps({"columns": cols, "rows": rows}))',
    ''
  ].join('\n')
}

function writeComponent(workspace: string, stamp: string, json: unknown = COMPONENT_JSON): void {
  const dir = join(workspace, 'dashboards', COMPONENT)
  mkdirSync(join(dir, 'api'), { recursive: true })
  writeFileSync(join(dir, 'component.json'), JSON.stringify(json, null, 2))
  writeFileSync(join(dir, 'api', 'rows.py'), rowsScript(stamp))
}

/** Dashboards on, the product's own sync writes the remote row, a restart so every store reads it. Answers the agent's row id. */
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

async function addTile(app: PersonApp, agentId: string, dashboard: string): Promise<string> {
  const added = await app.page.evaluate(
    ({ agentId, component, dashboard }) => window.api.dashboards.addTile({ newDashboardName: dashboard, agentId, component }),
    { agentId, component: COMPONENT, dashboard }
  )
  expect(added, JSON.stringify(added)).toMatchObject({ ok: true })
  return (added as { ok: true; dashboard: { id: string } }).dashboard.id
}

async function openDashboard(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Dashboards', exact: true }).click()
  await page.getByRole('button', { name: `${name}, 1 tile`, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
}

function tile(page: Page, title = TITLE) {
  return page.getByTestId('dashboard-grid').getByRole('group', { name: title, exact: true })
}

/** The desktop tile's stored params, through the renderer's own IPC. */
async function desktopParams(app: PersonApp, dashboardId: string): Promise<Record<string, unknown>> {
  const outcome = await app.page.evaluate((id) => window.api.dashboards.tiles(id), dashboardId)
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true })
  const tiles = (outcome as { ok: true; tiles: { tile: { params: Record<string, unknown> } }[] }).tiles
  expect(tiles).toHaveLength(1)
  return tiles[0].tile.params
}

/** Core's desktop-owned backing dashboard for the desktop dashboard `name`. */
async function backingDashboard(fixture: DashCrossFixture, token: string, name: string): Promise<{ id: string; blocks: { id: string; config: any }[] }> {
  const desktop = await coreCall(fixture, token, '/dashboards/?origin=desktop')
  expect(desktop.status).toBe(200)
  const found = (desktop.body as { id: string; name: string; blocks: { id: string; config: any }[] }[]).filter((d) => d.name === name)
  expect(found, `core has no desktop dashboard named ${name}`).toHaveLength(1)
  return found[0]
}

/** Wait until the chat holding the user message `text` has a finished reply; answers it. */
async function waitForReply(app: PersonApp, text: string): Promise<string> {
  let reply = ''
  await expect
    .poll(
      async () => {
        const found = await app.page.evaluate(async (question) => {
          for (const row of await window.api.chat.list()) {
            const chat = await window.api.chat.get(row.id)
            if (!chat) continue
            const at = chat.messages.findIndex((m) => m.role === 'user' && m.content === question)
            if (at < 0) continue
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

async function send(scope: Page | ReturnType<Page['getByTestId']>, text: string): Promise<void> {
  const composer = scope.getByRole('combobox', { name: 'Type a message...', exact: true })
  await composer.fill(text)
  await composer.press('Enter')
}

for (const engine of ENGINES) {
  test.describe(`on ${engine}`, () => {
    let cli: CinnaCli | null = null
    let workspace = ''
    let stampV1 = ''

    test.beforeAll(async () => {
      test.setTimeout(600_000)
      const fixture = dashCrossFixture()
      const agent = fixture?.agents?.[engine]
      if (!fixture || !agent) return
      stampV1 = `stamp-v1-${engine}-${fixture.tag}`
      cli = await CinnaCli.signIn(fixture, fixture.people.a)
      workspace = cli.syncAgent(agent.name)
      writeComponent(workspace, stampV1)
      const check = cli.run(['dashboards', 'check', agent.name, COMPONENT, '--run'])
      expect(check.code, `cinna dashboards check --run:\n${check.stdout}\n${check.stderr}`).toBe(0)
      expect(check.stdout).toContain(`${COMPONENT}: ok (ran)`)
    })

    test.afterAll(() => {
      cli?.dispose()
      cli = null
    })

    function agentOf(fixture: DashCrossFixture): CloudAgentFixture {
      const agent = fixture.agents?.[engine]
      test.skip(!agent, `the fixture has no ${engine} agent; run live-dashboard-cross.py create ${engine}`)
      expect(cli, 'the CLI did not sign in (beforeAll)').not.toBeNull()
      return agent!
    }

    test(`X1 [${engine}] a component the CLI wrote and checked is on desktop’s Dashboards tab, and Add draws what cinna dashboards run prints`, async ({ team }) => {
      test.setTimeout(480_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const app = await team.open('a')

      const listed = cli!.json(['dashboards', 'list', agent.name])
      expect(listed.code, listed.raw.stderr).toBe(0)
      const component = (listed.result.components as any[]).find((c) => c.name === COMPONENT)
      expect(component).toMatchObject({ title: TITLE, view: 'table', has_errors: false })
      expect(component.reference).toBe(`cinna://component/bundle:${listed.result.agent.bundle_id}/${COMPONENT}`)

      const ran = cli!.json(['dashboards', 'run', agent.name, COMPONENT])
      expect(ran.code, ran.raw.stderr).toBe(0)
      const names = (ran.result.value.rows as { name: string }[]).map((r) => r.name)
      expect(names).toEqual(['Acme', 'Globex', stampV1])

      await prepare(app, agent)
      const dashboard = `Cross X1 ${engine} ${fixture.tag} ${RUN}`
      await test.step('the agent page’s Dashboards tab lists the CLI’s component', async () => {
        await app.page.getByRole('button', { name: 'Agents', exact: true }).click()
        await app.page.getByRole('button', { name: agent.name, exact: true }).click()
        await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
        const tabs = app.page.getByRole('tablist', { name: 'Agent settings', exact: true }).getByRole('tab')
        await tabs.filter({ hasText: 'Dashboards' }).click()
        await expect(app.page.getByRole('heading', { level: 3, name: TITLE, exact: true })).toBeVisible({ timeout: 60_000 })
      })
      await test.step('Add to a new dashboard', async () => {
        await app.page.getByRole('button', { name: `Add ${TITLE} to a dashboard`, exact: true }).click()
        const dialog = app.page.getByRole('dialog', { name: `Add ${TITLE} to a dashboard`, exact: true })
        await dialog.getByLabel('Dashboard', { exact: true }).fill(dashboard)
        await dialog.getByRole('button', { name: 'Add', exact: true }).click()
        await expect(dialog).toHaveCount(0, { timeout: 60_000 })
      })
      await test.step('the desktop tile draws the rows the CLI’s run printed', async () => {
        await openDashboard(app.page, dashboard)
        for (const name of names) await expect(tile(app.page).getByText(name, { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })
      })
    })

    test(`X2 [${engine}] a desktop tile’s backing dashboard is read-only from the CLI and hidden on the web`, async ({ team }) => {
      test.setTimeout(480_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const person = fixture.people.a
      const app = await team.open('a')
      const agentId = await prepare(app, agent)
      const dashboard = `Cross X2 ${engine} ${fixture.tag} ${RUN}`
      const desktopId = await addTile(app, agentId, dashboard)
      await openDashboard(app.page, dashboard)
      await expect(tile(app.page).getByText(stampV1, { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })
      const backing = await backingDashboard(fixture, person.token, dashboard)

      await test.step('core’s web list hides it', async () => {
        const web = await coreCall(fixture, person.token, '/dashboards/')
        expect(web.status).toBe(200)
        expect((web.body as { id: string }[]).map((d) => d.id)).not.toContain(backing.id)
      })
      await test.step('cinna dashboards list: the placement says Cinna Desktop', async () => {
        const listed = cli!.json(['dashboards', 'list', agent.name])
        expect(listed.code, listed.raw.stderr).toBe(0)
        const component = (listed.result.components as any[]).find((c) => c.name === COMPONENT)
        test.info().annotations.push({ type: 'X2 placements', description: JSON.stringify(component.placements) })
        expect(JSON.stringify(component.placements)).toMatch(/desktop/i)
        const pretty = cli!.run(['dashboards', 'list', agent.name])
        expect(pretty.stdout).toContain('Cinna Desktop')
      })
      await test.step('cinna dashboards boards omits it; tiles by full id reads it as read only', async () => {
        const boards = cli!.json(['dashboards', 'boards'])
        expect(boards.code, boards.raw.stderr).toBe(0)
        expect((boards.result.dashboards as { id: string }[]).map((d) => d.id)).not.toContain(backing.id)
        const tiles = cli!.json(['dashboards', 'tiles', backing.id])
        expect(tiles.code, tiles.raw.stderr).toBe(0)
        expect(tiles.result.dashboard.origin).toBe('desktop')
        expect(tiles.result.tiles).toHaveLength(1)
        const pretty = cli!.run(['dashboards', 'tiles', backing.id])
        expect(pretty.stdout).toMatch(/read only/i)
      })
      await test.step('cinna dashboards tile params --set is refused with desktop_dashboard, exit 1, and nothing changes', async () => {
        const refused = cli!.json(['dashboards', 'tile', 'params', backing.id, COMPONENT, '--set', 'stage=won'])
        expect(refused.code, refused.raw.stdout + refused.raw.stderr).toBe(1)
        expect(refused.result).toMatchObject({ result: 'error', code: 'desktop_dashboard' })
        const after = await backingDashboard(fixture, person.token, dashboard)
        expect(after.blocks[0].config.params ?? {}).toEqual({})
        expect(await desktopParams(app, desktopId)).toEqual({})
      })
      await test.step('recorded: a direct core write to the desktop block through the account api-proxy', async () => {
        // Not a product rule either way: read-only is enforced by the CLI's verbs, and core lets the owner
        // write their own block. Recorded so a change on core's side (refusing it) is noticed.
        const block = backing.blocks[0]
        const direct = cli!.run(['api', 'PUT', `dashboards/${backing.id}/blocks/${block.id}`, '--json', JSON.stringify({ title: 'written by cinna api' })])
        test.info().annotations.push({ type: 'X2 direct api-proxy write', description: `exit ${direct.code}: ${(direct.stdout + direct.stderr).slice(0, 300)}` })
        if (direct.code === 0) {
          // Put it back so the desktop's tile stays the desktop's.
          cli!.run(['api', 'PUT', `dashboards/${backing.id}/blocks/${block.id}`, '--json', JSON.stringify({ title: block.config?.title ?? null })])
        }
      })
    })

    test(`X3 [${engine}] a CLI web dashboard with the same component is on the web list, not on desktop, and its params leave the desktop tile alone`, async ({ team }) => {
      test.setTimeout(480_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const person = fixture.people.a
      const app = await team.open('a')
      const agentId = await prepare(app, agent)
      const dashboard = `Cross X3 ${engine} ${fixture.tag} ${RUN}`
      const desktopId = await addTile(app, agentId, dashboard)
      const web = `Cross web ${engine} ${fixture.tag} ${RUN}`

      const created = cli!.json(['dashboards', 'board', 'create', web])
      expect(created.code, created.raw.stderr).toBe(0)
      expect(created.result.dashboard.origin).toBe('web')
      const added = cli!.json(['dashboards', 'add', agent.name, COMPONENT, '--board', web])
      expect(added.code, added.raw.stderr).toBe(0)

      await test.step('core’s web list has it; desktop’s dashboards don’t', async () => {
        const list = await coreCall(fixture, person.token, '/dashboards/')
        expect((list.body as { name: string }[]).map((d) => d.name)).toContain(web)
        const desktop = await app.page.evaluate(() => window.api.dashboards.list())
        expect(desktop.map((d) => d.name)).toEqual([dashboard])
      })
      await test.step('tile params --set on the web tile: the web tile filters, the desktop tile keeps all stages', async () => {
        const set = cli!.json(['dashboards', 'tile', 'params', web, COMPONENT, '--set', 'stage=won'])
        expect(set.code, set.raw.stdout + set.raw.stderr).toBe(0)
        expect(set.result.params).toEqual({ stage: 'won' })
        expect((set.result.data.rows as { name: string }[]).map((r) => r.name)).toEqual(['Acme'])
        await openDashboard(app.page, dashboard)
        const t = tile(app.page)
        await expect(t.getByText(stampV1, { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })
        await t.hover()
        await t.getByRole('button', { name: `Refresh ${TITLE}`, exact: true }).click()
        await expect(t.getByText('Globex', { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })
        expect(await desktopParams(app, desktopId)).toEqual({})
        const backing = await backingDashboard(fixture, person.token, dashboard)
        expect(backing.blocks[0].config.params ?? {}).toEqual({})
      })
    })

    test(`X4 [${engine}] a CLI edit reaches the desktop tile on Refresh; a broken component fails check and the desktop tile says so`, async ({ team }) => {
      test.setTimeout(600_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const app = await team.open('a')
      const agentId = await prepare(app, agent)
      const dashboard = `Cross X4 ${engine} ${fixture.tag} ${RUN}`
      await addTile(app, agentId, dashboard)
      await openDashboard(app.page, dashboard)
      const t = tile(app.page)
      await expect(t.getByText(stampV1, { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })
      const stampV2 = `stamp-v2-${engine}-${fixture.tag}`
      try {
        await test.step('new rows through the CLI → Refresh on desktop draws them', async () => {
          writeComponent(workspace, stampV2)
          const check = cli!.run(['dashboards', 'check', agent.name, COMPONENT, '--run'])
          expect(check.code, check.stdout + check.stderr).toBe(0)
          await t.hover()
          await t.getByRole('button', { name: `Refresh ${TITLE}`, exact: true }).click()
          await expect(t.getByText(stampV2, { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })
          await expect(t.getByText(stampV1, { exact: true })).toHaveCount(0)
        })
        await test.step('a component.json naming a missing script: check exits 1, the desktop tile has problems to fix', async () => {
          writeComponent(workspace, stampV2, { ...COMPONENT_JSON, endpoints: { rows: { script: 'api/missing.py', description: 'Gone.' } } })
          // The CLI's promise: a check right after a push sees the push (it flushes and asks `?fresh=true`).
          // KNOWN FAILING (2026-11-04, core c32f211b): core's GET agents/{id}/dashboards/ and /{name} take
          // no `fresh` query parameter (backend/app/api/routes/agent_dashboards.py), so it is ignored and
          // core's 10 s per-worker list cache answers the component as it was: "deals: ok", exit 0, while the
          // environment's file already names api/missing.py. Soft, so the desktop half below still runs.
          const immediate = cli!.run(['dashboards', 'check', agent.name, COMPONENT])
          expect.soft(immediate.code, `check right after the push (core's list cache):\n${immediate.stdout}${immediate.stderr}`).toBe(1)
          let check = immediate
          await expect
            .poll(() => (check = cli!.run(['dashboards', 'check', agent.name, COMPONENT])).code, { timeout: 60_000, intervals: [5_000] })
            .toBe(1)
          expect(check.stdout).toContain('[script_missing]')
          test.info().annotations.push({ type: 'X4 CLI check (broken)', description: check.stdout.slice(0, 400) })
          // Desktop re-reads a cloud agent's component list only when the dashboard's tiles are listed again
          // (opening it, focus, a tile change), and at most once a minute per agent (CLOUD_CATALOGUE_TTL_MS):
          // a dashboard left open never shows the broken component. Re-open it, as the owner would.
          const problems = app.page.getByTestId('dashboard-grid').getByText(`${TITLE} has problems to fix:`)
          await expect
            .poll(
              async () => {
                await app.page.getByRole('button', { name: 'Agents', exact: true }).click()
                await openDashboard(app.page, dashboard)
                return problems.isVisible()
              },
              { timeout: 150_000, intervals: [15_000], message: 'the desktop tile never said the component has problems' }
            )
            .toBe(true)
        })
      } finally {
        writeComponent(workspace, stampV1)
        // Polled: core's list cache answers the broken component for up to 10 s after the push (see above).
        let restored = cli!.run(['dashboards', 'check', agent.name, COMPONENT, '--run'])
        await expect
          .poll(() => (restored = cli!.run(['dashboards', 'check', agent.name, COMPONENT, '--run'])).code, { timeout: 60_000, intervals: [5_000], message: `restoring v1: ${restored.stdout}${restored.stderr}` })
          .toBe(0)
      }
    })

    test(`X5 [${engine}] the reference cinna dashboards ref prints, said by the agent in a desktop chat, is a card for the owned cloud agent; Add places it`, async ({ team }) => {
      test.setTimeout(600_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const app = await team.open('a')
      const agentId = await prepare(app, agent)
      const ref = cli!.run(['dashboards', 'ref', agent.name, COMPONENT, '--check'])
      expect(ref.code, ref.stdout + ref.stderr).toBe(0)
      const line = ref.stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('cinna://component/'))!
      expect(line).toMatch(/^cinna:\/\/component\/bundle:[^/]+\/deals$/)

      const title = `Cross X5 ${engine} ${fixture.tag} ${RUN}`
      await app.page.evaluate(async ({ title, agentId }) => {
        const chat = await window.api.chat.create()
        await window.api.chat.update(chat.id, { title, agentId })
        await window.api.chat.showInList(chat.id)
      }, { title, agentId })
      await app.page.getByText(title, { exact: true }).click()
      const question = `Repeat this line verbatim, on its own line, outside backticks, and nothing else: ${line}`
      await send(app.page, question)
      const reply = await waitForReply(app, question)
      expect(reply).toContain(line)

      const card = app.page.locator('[data-component-cards]').getByRole('group', { name: `Component ${TITLE}`, exact: true })
      await expect(card).toBeVisible({ timeout: 60_000 })
      await expect(card).toContainText(agent.name)
      await expect(card).toContainText('Not on a dashboard yet.')
      await card.getByRole('button', { name: `Add ${TITLE} to a dashboard`, exact: true }).click()
      const dialog = app.page.getByRole('dialog', { name: `Add ${TITLE} to a dashboard` })
      await dialog.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(dialog).toBeHidden({ timeout: 60_000 })
      await expect(card).toContainText('On My dashboard')
      await card.getByRole('button', { name: 'My dashboard', exact: true }).click()
      await expect(tile(app.page).getByText(stampV1, { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })
    })

    test(`X6 [${engine}] cinna chat --board changes the web tile through the tile tools; the desktop panel chat still reads its own tile`, async ({ team }) => {
      test.setTimeout(900_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const person = fixture.people.a
      const app = await team.open('a')
      const agentId = await prepare(app, agent)
      const dashboard = `Cross X6 ${engine} ${fixture.tag} ${RUN}`
      const desktopId = await addTile(app, agentId, dashboard)
      const web = `Cross chat ${engine} ${fixture.tag} ${RUN}`
      expect(cli!.json(['dashboards', 'add', agent.name, COMPONENT, '--board', web, '--new-board']).code).toBe(0)

      await test.step('cinna chat --board --focus: the agent sets stage=won on the web tile', async () => {
        const chat = cli!.run(
          ['chat', '--agent', agent.name, '--board', web, '--focus', COMPONENT, '--new-chat',
            'Call dashboards_tiles to get the tile_id of the Open deals tile, then call dashboards_update_tile with that tile_id and params {"stage": "won"}. Reply "done".'],
          420_000
        )
        test.info().annotations.push({ type: 'X6 cinna chat (tail)', description: (chat.stdout.split('\n').slice(-6).join('\n') + chat.stderr).slice(-900) })
        expect(chat.code, chat.stderr.slice(-800)).toBe(0)
        expect(chat.stdout).toContain('"dashboard"')
        const tiles = cli!.json(['dashboards', 'tiles', web])
        expect(tiles.code, tiles.raw.stderr).toBe(0)
        expect(tiles.result.tiles[0].params).toEqual({ stage: 'won' })
      })
      await test.step('the desktop panel chat reads its own tile (all stages), and its params are untouched', async () => {
        await openDashboard(app.page, dashboard)
        const t = tile(app.page)
        await expect(t.getByText('Globex', { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })
        await t.hover()
        await t.getByRole('button', { name: `Ask about ${TITLE}`, exact: true }).click()
        const panel = app.page.getByTestId('dashboard-chat-panel')
        const question = 'Which deal names does the tile I am looking at show? Reply with the names only, comma separated.'
        await send(panel, question)
        const reply = await waitForReply(app, question)
        expect(reply).toMatch(/globex/i)
        expect(reply).toContain(stampV1)
        expect(await desktopParams(app, desktopId)).toEqual({})
        const backing = await backingDashboard(fixture, person.token, dashboard)
        expect(backing.blocks[0].config.params ?? {}).toEqual({})
      })
    })

    test(`X7 [${engine}] the same component twice on one desktop dashboard: the panel chat on the second copy changes that copy only`, async ({ team }) => {
      // Two copies with one title: only the focused tile's core block id (focused.tile_id) tells core which
      // one the owner means; core's component match finds none when the component is placed twice.
      test.setTimeout(900_000)
      const { fixture } = team
      const agent = agentOf(fixture)
      const person = fixture.people.a
      const app = await team.open('a')
      const agentId = await prepare(app, agent)
      const dashboard = `Cross X7 ${engine} ${fixture.tag} ${RUN}`
      const desktopId = await addTile(app, agentId, dashboard)
      const second = await app.page.evaluate(
        ({ agentId, component, dashboardId }) => window.api.dashboards.addTile({ dashboardId, agentId, component }),
        { agentId, component: COMPONENT, dashboardId: desktopId }
      )
      expect(second, JSON.stringify(second)).toMatchObject({ ok: true })
      const paramsOfTiles = async (): Promise<Record<string, unknown>[]> => {
        const outcome = await app.page.evaluate((id) => window.api.dashboards.tiles(id), desktopId)
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true })
        return (outcome as { ok: true; tiles: { tile: { params: Record<string, unknown> } }[] }).tiles.map((entry) => entry.tile.params)
      }
      expect(await paramsOfTiles()).toEqual([{}, {}])

      await app.page.getByRole('button', { name: 'Dashboards', exact: true }).click()
      await app.page.getByRole('button', { name: `${dashboard}, 2 tiles`, exact: true }).click()
      const copies = app.page.getByTestId('dashboard-grid').getByRole('group', { name: TITLE, exact: true })
      await expect(copies).toHaveCount(2)
      const focused = copies.nth(1)
      await expect(focused.getByText('Globex', { exact: true })).toBeVisible({ timeout: CLOUD_WAIT })

      await test.step('the panel chat on the second copy sets stage=won on the tile the owner looks at', async () => {
        await focused.hover()
        await focused.getByRole('button', { name: `Ask about ${TITLE}`, exact: true }).click()
        const panel = app.page.getByTestId('dashboard-chat-panel')
        const question = 'Use your dashboards tools to set params {"stage": "won"} on the tile I am looking at, and only that tile. Reply "done".'
        await send(panel, question)
        await waitForReply(app, question)
      })
      await test.step('core changed the focused copy’s block only, and desktop shows it on the second tile', async () => {
        await expect
          .poll(async () => (await backingDashboard(fixture, person.token, dashboard)).blocks.map((block) => block.config.params ?? {}).filter((params) => params.stage === 'won').length, { timeout: 60_000 })
          .toBe(1)
        const blocks = (await backingDashboard(fixture, person.token, dashboard)).blocks
        expect(blocks).toHaveLength(2)
        await expect.poll(paramsOfTiles, { timeout: 60_000, message: 'the second desktop tile took stage=won, the first kept its params' }).toEqual([{}, { stage: 'won' }])
      })
    })
  })
}
