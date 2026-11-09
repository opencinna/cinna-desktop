import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * Dashboards D4: interactivity and the full refresh policy, on the fake
 * engine (no model, no billing).
 *
 * One kit agent (`Sales Desk`) per test, with the components that test needs
 * written into its `dashboards/` here (the revenue page is the kit template
 * from `e2e/fixtures/dashboards/`). Endpoints are Node scripts that append
 * the params they got on stdin to `app-data/dashboards/<name>/runs.log`, so
 * a test can count runs and read what each run was given. Tiles are added
 * over IPC, then the app is restarted so the dashboard sees the agent.
 */

const AGENT = 'Sales Desk'
const DASHBOARD = 'My dashboard'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dashboards')
const SHOTS = '/tmp/d4-shots'
const MODEL = 'qwen3:8b'

interface ComponentFixture {
  name: string
  manifest: Record<string, unknown>
  /** Paths relative to the component folder. */
  files: Record<string, string>
}

/** A Node endpoint that logs its params (one JSON line per run) and prints `output(params)`. */
function loggingEndpoint(name: string, output: string): string {
  return [
    "import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'",
    "const params = JSON.parse(readFileSync(0, 'utf8') || '{}')",
    `mkdirSync('app-data/dashboards/${name}', { recursive: true })`,
    `appendFileSync('app-data/dashboards/${name}/runs.log', JSON.stringify(params) + '\\n')`,
    `console.log(JSON.stringify(${output}))`,
    ''
  ].join('\n')
}

function runsOf(agentPath: string, name: string): Record<string, unknown>[] {
  const file = join(agentPath, 'app-data', 'dashboards', name, 'runs.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** A page component: `index.html` + `app.js` (no inline script) and a `data` source that prints `{}`. */
function pageComponent(name: string, title: string, body: string, script: string, endpoints: Record<string, { script: string; description: string }> = {}, extraFiles: Record<string, string> = {}): ComponentFixture {
  return {
    name,
    manifest: {
      schema_version: 1, title, view: 'html', entry: 'index.html',
      source: { endpoint: 'data' },
      endpoints: { data: { script: 'api/data.mjs', description: 'Nothing to show. No params.' }, ...endpoints },
      refresh: { max_age: '1h' },
      size: 'm'
    },
    files: {
      'index.html': `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="padding:48px 12px 12px 12px;font:12px sans-serif">${body}<script src="./app.js"></script></body></html>`,
      'app.js': script,
      'api/data.mjs': 'console.log(JSON.stringify({}))\n',
      ...extraFiles
    }
  }
}

interface Arranged { agentId: string; agentPath: string; dashboardId: string; tileIds: Record<string, string> }

/**
 * The agent with `components` (and `revenue-by-week` when named), each a tile
 * on My dashboard in that order; `manifest` edits `cinna-agent.json`. Ends
 * after a relaunch, on Chats, with the index rescanned.
 */
async function arrange(
  cinna: CinnaApp,
  components: (ComponentFixture | 'revenue-by-week')[],
  options: { manifest?: (m: Record<string, unknown>) => void; beforeTiles?: () => Promise<void> } = {}
): Promise<Arranged> {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT)
  const names: string[] = []
  for (const c of components) {
    if (c === 'revenue-by-week') {
      cpSync(join(FIXTURES, c), join(agent.path, 'dashboards', c), { recursive: true })
      names.push(c)
      continue
    }
    const dir = join(agent.path, 'dashboards', c.name)
    for (const [rel, text] of Object.entries({ 'component.json': JSON.stringify(c.manifest, null, 2), ...c.files })) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
    names.push(c.name)
  }
  if (options.manifest) {
    const path = join(agent.path, 'cinna-agent.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    options.manifest(manifest)
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  }
  if (options.beforeTiles) await options.beforeTiles()
  const added = await cinna.page.evaluate(async ({ agentId, names, dashboard }) => {
    await window.api.localAgents.rescan()
    const tileIds: Record<string, string> = {}
    let dashboardId = ''
    for (const component of names) {
      const result = dashboardId
        ? await window.api.dashboards.addTile({ dashboardId, agentId, component })
        : await window.api.dashboards.addTile({ newDashboardName: dashboard, agentId, component })
      if (!result.ok) throw new Error(`${component}: ${result.message}`)
      dashboardId = result.dashboard.id
      tileIds[component] = result.tile.id
    }
    return { dashboardId, tileIds }
  }, { agentId: agent.id, names, dashboard: DASHBOARD })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { agentId: agent.id, agentPath: agent.path, ...added }
}

async function openDashboard(cinna: CinnaApp, tileCount: number): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Dashboards', exact: true }).click()
  await page.getByRole('button', { name: `${DASHBOARD}, ${tileCount === 1 ? '1 tile' : `${tileCount} tiles`}`, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: DASHBOARD, exact: true })).toBeVisible()
}

function tile(cinna: CinnaApp, title: string) {
  return cinna.page.getByTestId('dashboard-grid').getByRole('group', { name: title, exact: true })
}
function frameOf(cinna: CinnaApp, title: string) {
  return tile(cinna, title).frameLocator('[data-testid="dashboard-frame"]')
}

/**
 * Clicks `target` inside a dashboard page until the page's own handler saw it
 * (`landed`). A dashboard page is a cross-origin, out-of-process frame: in the
 * first moments after its load Chromium can still route a click at its spot to
 * the `<iframe>` element in the host window, and the page never hears of it.
 * A probe caught exactly that (pointerdown/click on IFRAME in the host, ~50 ms
 * after the frame's load, the page's text unchanged). Retry only when the page
 * shows no sign of the click, so a click that landed is never sent twice.
 */
async function clickInFreshFrame(target: Locator, landed: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await target.click()
    await landed()
  }).toPass({ timeout: 15_000, intervals: [250, 500, 1_000] })
}

async function storedTile(cinna: CinnaApp, dashboardId: string, tileId: string) {
  return cinna.page.evaluate(async ({ dashboardId, tileId }) => {
    const listed = await window.api.dashboards.tiles(dashboardId)
    if (!listed.ok) throw new Error(listed.message)
    return listed.tiles.find((view) => view.tile.id === tileId)!.tile
  }, { dashboardId, tileId })
}

function thisMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

test.beforeAll(() => { mkdirSync(SHOTS, { recursive: true }) })

// ---- 1. Filters ---------------------------------------------------------------------------------

const PIPELINE: ComponentFixture = {
  name: 'pipeline',
  manifest: {
    schema_version: 1, title: 'Pipeline', view: 'list',
    source: { endpoint: 'items' },
    endpoints: { items: { script: 'api/items.mjs', description: 'Deals in one stage and month. Params: stage, month, owner, since, min_amount, region.' } },
    params: {
      stage: { type: 'enum', label: 'Stage', values: ['open', 'won', 'lost'], default: 'open' },
      month: { type: 'month', label: 'Month', default: 'current' },
      owner: { type: 'text', label: 'Owner' },
      since: { type: 'date', label: 'Since' },
      min_amount: { type: 'number', label: 'Min amount' },
      region: { type: 'enum', label: 'Region', values: ['emea', 'americas', 'apac'], default: 'emea' }
    },
    refresh: { max_age: '1h' },
    size: 'm'
  },
  files: { 'api/items.mjs': loggingEndpoint('pipeline', "{ items: [{ id: 'echo', title: `stage=${params.stage} month=${params.month} since=${params.since ?? '-'}` }] }") }
}

test('a native tile’s filter row keeps every filter set, clears a month or date back to its default, says when a value is refused, and keeps its values across a restart', async ({ cinna }) => {
  test.setTimeout(150_000)
  const { agentPath, dashboardId, tileIds } = await arrange(cinna, [PIPELINE])
  const page = cinna.page
  const month = thisMonth()
  await openDashboard(cinna, 1)
  const pipeline = tile(cinna, 'Pipeline')
  const filters = pipeline.getByTestId('tile-filters')
  const content = pipeline.getByTestId('tile-content')
  const stored = async () => (await storedTile(cinna, dashboardId, tileIds.pipeline)).params
  const more = filters.getByRole('button', { name: 'Filters', exact: true })
  const popover = page.getByRole('dialog', { name: 'More filters', exact: true })

  await test.step('the row shows the filters that fit with the defaults, the rest behind Filters ⋯', async () => {
    await expect(filters).toBeVisible()
    await expect(filters.getByLabel('Stage', { exact: true })).toHaveValue('open')
    await expect(filters.getByLabel('Month', { exact: true })).toHaveValue(month)
    await expect(pipeline.getByText(`stage=open month=${month} since=-`, { exact: true })).toBeVisible({ timeout: 30_000 })
    expect(runsOf(agentPath, 'pipeline').at(-1)).toEqual({ stage: 'open', month, region: 'emea' })
    // Adding the tile wrote the component's defaults into it.
    expect(await stored()).toEqual({ stage: 'open', month: 'current', region: 'emea' })
    // Six filters do not fit a medium tile: the row never scrolls sideways, the rest wait behind the button.
    await expect(more).toBeVisible()
    await expect(filters.getByLabel('Region', { exact: true })).toHaveCount(0)
    // Every drawn control and the button lie inside the row (the row's invisible sizing copy is not drawn).
    const inside = await filters.evaluate((row) => {
      const edge = row.getBoundingClientRect().right
      const drawn = [...row.querySelectorAll('label, input, select, button')].filter((el) => !el.closest('[aria-hidden="true"]'))
      return { count: drawn.length, outside: drawn.filter((el) => el.getBoundingClientRect().right > edge).map((el) => el.outerHTML.slice(0, 60)) }
    })
    expect(inside.outside).toEqual([])
    expect(inside.count).toBeGreaterThan(1)
    await pipeline.screenshot({ path: `${SHOTS}/filters-overflow.png` })
    await more.click()
    await expect(popover).toBeVisible()
    await expect(popover.getByLabel('Region', { exact: true })).toHaveValue('emea')
    await expect(popover.getByLabel('Min amount', { exact: true })).toHaveValue('')
    await page.screenshot({ path: `${SHOTS}/filters-more-open.png` })
    // Focus stays on the button when it opens, so Escape does not reach the popover: the button closes it.
    await more.click()
    await expect(popover).toHaveCount(0)
  })

  await test.step('changing Stage re-runs with the new value; the row and the content stay where they were', async () => {
    const rowBefore = await filters.boundingBox()
    const contentBefore = await content.boundingBox()
    const runsBefore = runsOf(agentPath, 'pipeline').length
    await filters.getByLabel('Stage', { exact: true }).selectOption('won')
    const rowDuring = await filters.boundingBox()
    const contentDuring = await content.boundingBox()
    await expect(pipeline.getByText(`stage=won month=${month} since=-`, { exact: true })).toBeVisible({ timeout: 30_000 })
    for (const box of [rowDuring, await filters.boundingBox()]) expect(box).toEqual(rowBefore)
    for (const box of [contentDuring, await content.boundingBox()]) expect(box).toEqual(contentBefore)
    const runs = runsOf(agentPath, 'pipeline')
    expect(runs.length).toBe(runsBefore + 1)
    expect(runs.at(-1)).toEqual({ stage: 'won', month, region: 'emea' })
    await expect.poll(stored).toEqual({ stage: 'won', month: 'current', region: 'emea' })
  })

  await test.step('then Month: the second filter keeps the first', async () => {
    await filters.getByLabel('Month', { exact: true }).fill('2026-09')
    await expect(pipeline.getByText('stage=won month=2026-09 since=-', { exact: true })).toBeVisible({ timeout: 30_000 })
    expect(runsOf(agentPath, 'pipeline').at(-1)).toEqual({ stage: 'won', month: '2026-09', region: 'emea' })
    await expect.poll(stored).toEqual({ stage: 'won', month: '2026-09', region: 'emea' })
  })

  await test.step('then Since, and Region behind Filters ⋯: every earlier value stays', async () => {
    await filters.getByLabel('Since', { exact: true }).fill('2026-08-15')
    await expect(pipeline.getByText('stage=won month=2026-09 since=2026-08-15', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(stored).toEqual({ stage: 'won', month: '2026-09', since: '2026-08-15', region: 'emea' })
    await more.click()
    await popover.getByLabel('Region', { exact: true }).selectOption('apac')
    await expect.poll(stored).toEqual({ stage: 'won', month: '2026-09', since: '2026-08-15', region: 'apac' })
    await expect.poll(() => runsOf(agentPath, 'pipeline').at(-1)).toEqual({ stage: 'won', month: '2026-09', since: '2026-08-15', region: 'apac' })
    // selectOption leaves focus on the button; from inside the popover, Escape closes it.
    await popover.getByLabel('Region', { exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
  })

  await test.step('clearing the date and the month removes them: no value, the default again', async () => {
    await filters.getByLabel('Since', { exact: true }).fill('')
    await expect(pipeline.getByText('stage=won month=2026-09 since=-', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(stored).toEqual({ stage: 'won', month: '2026-09', region: 'apac' })
    await filters.getByLabel('Month', { exact: true }).fill('')
    await expect(pipeline.getByText(`stage=won month=${month} since=-`, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(stored).toEqual({ stage: 'won', region: 'apac' })
    expect(runsOf(agentPath, 'pipeline').at(-1)).toEqual({ stage: 'won', month, region: 'apac' })
    await expect(filters.getByLabel('Month', { exact: true })).toHaveValue(month)
    await expect(pipeline.getByTestId('tile-filter-notice')).toHaveCount(0)
  })

  await test.step('a refused value says why under the row, runs nothing and puts the control back', async () => {
    const runsBefore = runsOf(agentPath, 'pipeline').length
    const rowBefore = await filters.boundingBox()
    const contentBefore = await content.boundingBox()
    const owner = filters.getByLabel('Owner', { exact: true })
    await owner.fill('x'.repeat(201))
    await owner.press('Enter')
    const notice = pipeline.getByRole('alert')
    await expect(notice).toHaveText('Value refused: Owner must be text of at most 200 characters.')
    // While the owner is still in the box the text stays to be fixed; leaving it puts the stored value back.
    await expect(owner).toHaveValue('x'.repeat(201))
    await owner.blur()
    await expect(owner).toHaveValue('')
    await expect(notice).toHaveText('Value refused: Owner must be text of at most 200 characters.')
    expect(await filters.boundingBox()).toEqual(rowBefore)
    expect(await content.boundingBox()).toEqual(contentBefore)
    await pipeline.screenshot({ path: `${SHOTS}/filter-refused.png` })
    expect(runsOf(agentPath, 'pipeline')).toHaveLength(runsBefore)
    expect(await stored()).toEqual({ stage: 'won', region: 'apac' })
    await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(notice).toHaveCount(0)
  })

  await test.step('after a restart the tile still filters on won', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openDashboard(cinna, 1)
    const again = tile(cinna, 'Pipeline')
    await expect(again.getByTestId('tile-filters').getByLabel('Stage', { exact: true })).toHaveValue('won')
    await expect(again.getByText(`stage=won month=${month} since=-`, { exact: true })).toBeVisible({ timeout: 30_000 })
  })
})

// ---- 2. Page drill-down and setParams -----------------------------------------------------------

test('the revenue page drills into a week with cinna.call, and its month picker re-runs the source and persists on the tile', async ({ cinna }) => {
  test.setTimeout(150_000)
  const { dashboardId, tileIds } = await arrange(cinna, ['revenue-by-week'])
  const page = cinna.page
  await openDashboard(cinna, 1)
  const revenue = frameOf(cinna, 'Revenue by week')

  await test.step('a bar click lists that week’s deals from week_detail', async () => {
    await expect(revenue.locator('rect.bar')).toHaveCount(4, { timeout: 60_000 })
    await expect(revenue.locator('#month')).toHaveValue(thisMonth())
    await revenue.locator('rect.bar').first().click()
    await expect(revenue.locator('#detail-list li')).toHaveText(['Acme renewal: 9,800 EUR', 'Globex pilot: 4,200 EUR'], { timeout: 30_000 })
    await page.screenshot({ path: `${SHOTS}/revenue-drilldown.png` })
  })

  await test.step('picking September in the page stores month on the tile and recomputes for it', async () => {
    const tileId = tileIds['revenue-by-week']
    await revenue.locator('#month').fill('2026-09')
    await expect.poll(async () => (await storedTile(cinna, dashboardId, tileId)).params, { timeout: 15_000 }).toEqual({ month: '2026-09' })
    await expect.poll(async () => {
      const result = await page.evaluate((id) => window.api.dashboards.tileResult(id), tileId)
      return result.ok ? (result.result.data as { month?: string } | null)?.month : null
    }, { timeout: 30_000, message: 'the source ran for 2026-09' }).toBe('2026-09')
    await expect(revenue.locator('#month')).toHaveValue('2026-09')
    await expect(revenue.locator('rect.bar')).toHaveCount(4)
    await page.screenshot({ path: `${SHOTS}/revenue-september.png` })
  })
})

// ---- 3. Rate limit ------------------------------------------------------------------------------

const BURST = pageComponent(
  'burst',
  'Burst',
  '<p>ok <span id="ok">0</span> · refused <span id="refused">0</span> · other <span id="other">0</span> · <span id="done"></span></p><p id="refusal"></p>',
  [
    '(async function () {',
    '  const cinna = window.cinna',
    '  await cinna.ready',
    '  let ok = 0, refused = 0, other = 0',
    '  for (let i = 0; i < 40; i += 1) {',
    '    try { await cinna.call("ping", {}); ok += 1 }',
    '    catch (error) {',
    '      if (/more than 30 times in a minute/.test(error.message)) { refused += 1; if (!document.getElementById("refusal").textContent) document.getElementById("refusal").textContent = error.message }',
    '      else { other += 1; document.getElementById("refusal").textContent = "other: " + error.message }',
    '    }',
    '    document.getElementById("ok").textContent = String(ok)',
    '    document.getElementById("refused").textContent = String(refused)',
    '    document.getElementById("other").textContent = String(other)',
    '  }',
    '  document.getElementById("done").textContent = "done"',
    '})()',
    ''
  ].join('\n'),
  { ping: { script: 'api/ping.mjs', description: 'Answers pong. No params.' } },
  { 'api/ping.mjs': loggingEndpoint('burst', '{ pong: true }') }
)

test('a page that calls its endpoint 40 times in a burst gets 30 answers and 10 refusals', async ({ cinna }) => {
  test.setTimeout(150_000)
  const { agentPath } = await arrange(cinna, [BURST])
  await openDashboard(cinna, 1)
  const burst = frameOf(cinna, 'Burst')
  await expect(burst.locator('#done')).toHaveText('done', { timeout: 90_000 })
  await cinna.page.screenshot({ path: `${SHOTS}/rate-limit.png` })
  await expect(burst.locator('#ok')).toHaveText('30')
  await expect(burst.locator('#refused')).toHaveText('10')
  await expect(burst.locator('#other')).toHaveText('0')
  await expect(burst.locator('#refusal')).toHaveText('This page called its endpoints more than 30 times in a minute; wait a moment and try again.')
  // Refused calls spawn nothing.
  expect(runsOf(agentPath, 'burst')).toHaveLength(30)
})

// ---- 4. Open link (D17) -------------------------------------------------------------------------

const LINK_SCRIPT = [
  '(async function () {',
  '  const cinna = window.cinna',
  '  await cinna.ready',
  '  const result = document.getElementById("result")',
  '  function open(url) {',
  '    result.textContent = "waiting"',
  '    cinna.openLink(url).then(function () { result.textContent = "opened" }, function (error) { result.textContent = "rejected: " + error.message })',
  '  }',
  '  document.getElementById("go").addEventListener("click", function () { open("https://example.com/x") })',
  '  document.getElementById("script").addEventListener("click", function () { open("javascript:alert(1)") })',
  '  document.getElementById("mail").addEventListener("click", function () { open("mailto:sales@example.com?subject=Renewal") })',
  '  result.textContent = "ready"',
  '})()',
  ''
].join('\n')
const LINKS = pageComponent('links', 'Links', '<button id="go">Open example</button> <button id="script">Open script</button> <button id="mail">Write to sales</button><p id="result"></p>', LINK_SCRIPT)

/** Replaces `shell.openExternal` in main: `app:open-external` still runs, no browser opens. */
async function recordBrowser(cinna: CinnaApp): Promise<() => Promise<string[]>> {
  await cinna.electronApp.evaluate(({ shell }) => {
    const globals = globalThis as unknown as { __openedUrls?: string[] }
    globals.__openedUrls = []
    shell.openExternal = async (url: string): Promise<void> => { globals.__openedUrls!.push(url) }
  })
  return () => cinna.electronApp.evaluate(() => [...((globalThis as unknown as { __openedUrls?: string[] }).__openedUrls ?? [])])
}

test('cinna.openLink asks with the full URL: Open opens it (web or mailto), javascript: is refused without asking, Cancel rejects, and after a decline the page’s next link is refused without a dialog', async ({ cinna }) => {
  test.setTimeout(150_000)
  await arrange(cinna, [LINKS])
  const page = cinna.page
  const opened = await recordBrowser(cinna)
  await openDashboard(cinna, 1)
  const links = frameOf(cinna, 'Links')
  const confirm = page.getByRole('dialog', { name: 'Open example.com in your browser?', exact: true })
  await expect(links.locator('#result')).toHaveText('ready', { timeout: 30_000 })

  await test.step('Open: the browser gets the URL and the page’s promise resolves', async () => {
    // The page's handler writes "waiting" before it asks; still "ready" means the click never reached the page.
    await clickInFreshFrame(links.getByRole('button', { name: 'Open example', exact: true }), () =>
      expect(links.locator('#result')).not.toHaveText('ready', { timeout: 1_000 })
    )
    await expect(confirm).toBeVisible()
    await expect(confirm.getByTestId('open-link-url')).toHaveText('https://example.com/x')
    await page.screenshot({ path: `${SHOTS}/open-link-confirm.png` })
    await confirm.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(links.locator('#result')).toHaveText('opened')
    expect(await opened()).toEqual(['https://example.com/x'])
  })

  await test.step('a mailto: link asks “Write to <address>?”', async () => {
    await links.getByRole('button', { name: 'Write to sales', exact: true }).click()
    const mail = page.getByRole('dialog', { name: 'Write to sales@example.com?', exact: true })
    await expect(mail).toBeVisible()
    await expect(mail.getByTestId('open-link-url')).toHaveText('mailto:sales@example.com?subject=Renewal')
    await page.screenshot({ path: `${SHOTS}/open-link-mailto.png` })
    await mail.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(mail).toHaveCount(0)
    await expect(links.locator('#result')).toHaveText('opened')
    expect(await opened()).toEqual(['https://example.com/x', 'mailto:sales@example.com?subject=Renewal'])
  })

  await test.step('javascript: is refused with no dialog', async () => {
    await links.getByRole('button', { name: 'Open script', exact: true }).click()
    await expect(links.locator('#result')).toHaveText('rejected: Only web (http, https) and mailto links open from a dashboard.')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  await test.step('Cancel rejects the page’s promise and opens nothing', async () => {
    await links.getByRole('button', { name: 'Open example', exact: true }).click()
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(links.locator('#result')).toHaveText('rejected: The link was not opened.')
  })

  await test.step('after the decline, the page’s next link is refused without a dialog', async () => {
    await links.getByRole('button', { name: 'Open example', exact: true }).click()
    await expect(links.locator('#result')).toHaveText('rejected: The owner declined a link from this page.')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await opened()).toEqual(['https://example.com/x', 'mailto:sales@example.com?subject=Renewal'])
  })
})

// ---- 5. Ask (D14) -------------------------------------------------------------------------------

const ASK = pageComponent(
  'ask-page',
  'Late deals',
  '<button id="ask">Ask about Acme</button><p id="result"></p>',
  [
    '(async function () {',
    '  const cinna = window.cinna',
    '  await cinna.ready',
    '  const result = document.getElementById("result")',
    '  document.getElementById("ask").addEventListener("click", function () {',
    '    result.textContent = "asking"',
    '    cinna.ask("Why is Acme late?").then(function () { result.textContent = "asked" }, function (error) { result.textContent = "rejected: " + error.message })',
    '  })',
    '  result.textContent = "ready"',
    '})()',
    ''
  ].join('\n')
)

async function serveModels(): Promise<{ server: Server; host: string }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }] }))
    } else if (req.url === '/api/version') res.end(JSON.stringify({ version: '0.6.2' }))
    else { res.writeHead(404); res.end('{}') }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, host: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

test.describe('ask', () => {
  let models: { server: Server; host: string }
  test.beforeEach(async () => { models = await serveModels() })
  test.afterEach(async () => {
    models.server.closeAllConnections()
    await new Promise<void>((resolve) => models.server.close(() => resolve()))
  })

  test('cinna.ask opens the panel on the tile’s agent with the text in the composer and sends nothing', async ({ cinna }) => {
    test.setTimeout(150_000)
    let acp: FakeAcpEngine | null = null
    await arrange(cinna, [ASK], {
      beforeTiles: async () => {
        acp = await installFakeAcpEngine(cinna, { newSession: { uniqueIds: true }, prompt: { emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Unexpected reply.' } } }] } })
        await cinna.page.evaluate(async ({ host, model }) => {
          await window.api.settings.set('autoChatTitles', false)
          const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Ask fixture Ollama', baseUrl: host, enabled: true })
          await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
        }, { host: models.host, model: MODEL })
      }
    })
    const page = cinna.page
    await openDashboard(cinna, 1)
    const asking = frameOf(cinna, 'Late deals')
    await expect(asking.locator('#result')).toHaveText('ready', { timeout: 30_000 })
    const panel = page.getByTestId('dashboard-chat-panel')
    await expect(panel).toHaveCount(0)

    // "asking" is written before the ask; still "ready" means the click never reached the page.
    await clickInFreshFrame(asking.getByRole('button', { name: 'Ask about Acme', exact: true }), () =>
      expect(asking.locator('#result')).not.toHaveText('ready', { timeout: 1_000 })
    )
    await expect(panel).toBeVisible()
    await expect(asking.locator('#result')).toHaveText('asked')
    await expect(tile(cinna, 'Late deals')).toHaveAttribute('data-focused', 'true')
    await expect(panel.getByTestId('dashboard-context-chip')).toHaveText('Late deals')
    await expect(panel.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveValue('Why is Acme late?')
    await page.screenshot({ path: `${SHOTS}/ask-filled.png` })
    expect(acp!.received('session/prompt')).toHaveLength(0)
    const panelChats = (await page.evaluate(() => window.api.chat.list())).filter((c) => c.originDashboardId)
    for (const chat of panelChats) {
      const stored = await page.evaluate((id) => window.api.chat.get(id), chat.id)
      expect(stored!.messages).toHaveLength(0)
    }
  })
})

// ---- 6. Edit tile overrides ---------------------------------------------------------------------

const FOLLOW_UPS: ComponentFixture = {
  name: 'follow-ups',
  manifest: {
    schema_version: 1, title: 'Follow-ups', view: 'list',
    source: { endpoint: 'items' },
    endpoints: { items: { script: 'api/items.mjs', description: 'Open follow-ups. No params.' } },
    refresh: { max_age: '15m' },
    size: 'm'
  },
  files: { 'api/items.mjs': loggingEndpoint('follow-ups', "{ items: [{ id: 'f1', title: 'Call Priya about the renewal' }] }") }
}

async function openEditTile(cinna: CinnaApp, title: string) {
  await tile(cinna, title).hover()
  await tile(cinna, title).getByRole('button', { name: `Actions for ${title}`, exact: true }).click()
  await cinna.page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  const dialog = cinna.page.getByRole('dialog', { name: 'Edit tile', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test('Edit tile stores a refresh override, and Manual greys the other choices', async ({ cinna }) => {
  test.setTimeout(150_000)
  const { dashboardId, tileIds } = await arrange(cinna, [FOLLOW_UPS])
  const page = cinna.page
  await openDashboard(cinna, 1)
  await expect(tile(cinna, 'Follow-ups').getByText('Call Priya about the renewal')).toBeVisible({ timeout: 30_000 })

  await test.step('max age 5 minutes, every minute while on screen, recompute after a turn', async () => {
    const dialog = await openEditTile(cinna, 'Follow-ups')
    await expect(dialog.getByLabel('Recompute when older than', { exact: true })).toHaveValue('')
    await dialog.getByLabel('Recompute when older than', { exact: true }).selectOption('5m')
    await dialog.getByLabel('While on screen, every', { exact: true }).selectOption('1m')
    await dialog.getByLabel('After a chat turn of its agent', { exact: true }).selectOption('on')
    await page.screenshot({ path: `${SHOTS}/edit-tile-overrides.png` })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await storedTile(cinna, dashboardId, tileIds['follow-ups'])).refreshOverride).toEqual({ maxAge: '5m', whileOpenEvery: '1m', afterTurn: true })
  })

  await test.step('reopened it shows them; Manual disables the four selects and keeps their values', async () => {
    const dialog = await openEditTile(cinna, 'Follow-ups')
    const selects = ['Recompute when older than', 'While on screen, every', 'After a chat turn of its agent', 'When Cinna starts'].map((name) => dialog.getByLabel(name, { exact: true }))
    await expect(selects[0]).toHaveValue('5m')
    await expect(selects[1]).toHaveValue('1m')
    await expect(selects[2]).toHaveValue('on')
    const before = await dialog.boundingBox()
    await dialog.getByLabel('Only when I press Refresh', { exact: true }).check()
    for (const select of selects) await expect(select).toBeDisabled()
    expect((await dialog.boundingBox())!.height).toBe(before!.height)
    await page.screenshot({ path: `${SHOTS}/edit-tile-manual.png` })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await storedTile(cinna, dashboardId, tileIds['follow-ups'])).refreshOverride).toEqual({ maxAge: '5m', whileOpenEvery: '1m', afterTurn: true, manual: true })
  })
})

// ---- 7. Schedule-fed tiles ----------------------------------------------------------------------

function scheduleFed(name: string, title: string, schedule: string): ComponentFixture {
  return {
    name,
    manifest: {
      schema_version: 1, title, view: 'list',
      source: { endpoint: 'items' },
      endpoints: { items: { script: 'api/items.mjs', description: 'What the schedule ranked. No params.' } },
      refresh: { max_age: '1h', schedule },
      size: 'm'
    },
    files: { 'api/items.mjs': loggingEndpoint(name, "{ items: [{ id: 'l1', title: 'Acme' }] }") }
  }
}

test('a schedule-fed tile says its schedule is off on this device with Turn on…, or that the agent no longer has it', async ({ cinna }) => {
  test.setTimeout(150_000)
  await arrange(cinna, [scheduleFed('ranked-leads', 'Ranked leads', 'Nightly ranking'), scheduleFed('digest', 'Digest', 'Weekly digest')], {
    manifest: (m) => {
      m.schedules = [{ name: 'Nightly ranking', cron_string: '0 2 * * *', timezone: 'UTC', schedule_type: 'static_prompt', prompt: 'Rank the leads.', enabled: true }]
    }
  })
  const page = cinna.page
  await openDashboard(cinna, 2)
  await expect(tile(cinna, 'Ranked leads').getByTestId('tile-schedule-notice')).toHaveText('Fed by Nightly ranking, which is off on this device. Turn on…')
  await expect(tile(cinna, 'Digest').getByTestId('tile-schedule-notice')).toHaveText('Fed by Weekly digest, which this agent no longer has.')
  await expect(tile(cinna, 'Digest').getByRole('button', { name: 'Turn on…' })).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/schedule-fed.png` })

  await tile(cinna, 'Ranked leads').getByRole('button', { name: 'Turn on…', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await expect(page.getByRole('tablist', { name: 'Agent details', exact: true }).getByRole('tab', { name: 'Schedules', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: 'Local schedules', exact: true })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/schedule-turn-on.png` })
})

// ---- 8. Launch warm-up --------------------------------------------------------------------------

function warmComponent(name: string, title: string, maxAge: string): ComponentFixture {
  return {
    name,
    manifest: {
      schema_version: 1, title, view: 'list',
      source: { endpoint: 'items' },
      endpoints: { items: { script: 'api/items.mjs', description: 'A slow source. No params.' } },
      refresh: { max_age: maxAge, on_app_start: true },
      size: 's'
    },
    files: { 'api/items.mjs': loggingEndpoint(name, "{ items: [{ id: 'w1', title: 'Warm' }] }") }
  }
}

test.describe('launch warm-up', () => {
  test.use({ env: { CINNA_DASHBOARD_WARMUP: 'on' } })

  test('an on_app_start tile with a stale cache runs once after launch with the dashboard closed; a fresh one does not', async ({ cinna }) => {
    test.setTimeout(150_000)
    // Fresh first: once the stale tile (after it in the warm-up's order) has run, the fresh one was already passed over.
    const { agentPath, tileIds } = await arrange(cinna, [warmComponent('warm-fresh', 'Fresh warm', '1d'), warmComponent('warm-stale', 'Stale warm', '1s')])
    const page = cinna.page

    await test.step('both get a cache, then the app restarts with the dashboard not open', async () => {
      // arrange()'s relaunch already runs the launch warm-up, which gives both uncached tiles their
      // first run. A manual ensureFresh here raced it: when the warm-up's run of warm-fresh had
      // finished first, the manual one made it run twice. Wait for the warm-up's runs instead.
      await expect.poll(() => [runsOf(agentPath, 'warm-fresh').length, runsOf(agentPath, 'warm-stale').length], { timeout: 30_000 }).toEqual([1, 1])
      await expect.poll(async () => {
        const results = await Promise.all(Object.values(tileIds).map((id) => page.evaluate((tileId) => window.api.dashboards.tileResult(tileId), id)))
        return results.map((r) => (r.ok ? r.result.fetchedAt !== null : false))
      }, { timeout: 30_000 }).toEqual([true, true])
      await expect(page.getByTestId('dashboard-grid')).toHaveCount(0)
      await cinna.relaunch()
      await cinna.skipOnboarding()
    })

    await test.step('after launch the stale tile ran once and the fresh one not at all, with no dashboard on screen', async () => {
      await expect.poll(() => runsOf(agentPath, 'warm-stale').length, { timeout: 30_000, message: 'the warm-up ran the stale tile' }).toBe(2)
      expect(runsOf(agentPath, 'warm-fresh')).toHaveLength(1)
      await expect(cinna.page.getByTestId('dashboard-grid')).toHaveCount(0)
      await cinna.page.screenshot({ path: `${SHOTS}/warmup-after-launch.png` })
    })
  })
})
