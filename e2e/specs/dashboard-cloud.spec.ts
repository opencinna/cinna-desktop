import type { Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'
import { CORE_MONTH, OWN_AGENT, SHARED_AGENT, startFakeCore, type FakeCinnaCore } from '../fixtures/fakeCinnaDashboards'

/**
 * Dashboards D6: tiles for the profile's own cloud agents, against a fake
 * cinna-core (`e2e/fixtures/fakeCinnaDashboards.ts`). No model, nothing billed.
 *
 * ## What is real and what is not
 *
 * Real: the remote-agent sync (`agents.syncRemote()` over the fake's listing),
 * the agent page's Dashboards tab and Add dialog, main's backing dashboard and
 * block calls, the remote tile source (data / refresh / params / call), its
 * mirror and marks, the frame relay (`dash-` host, cap held in main, re-mint on
 * 404, the desktop's own CSP), the kit bridge the page runs, the panel chat's
 * core session and the A2A driver's `message/stream`, the socket.io client.
 * Faked: cinna-core itself — routes in core's wire shapes, an A2A agent that
 * streams one final answer, a socket.io server the test emits on. The profile
 * is made a signed-in Cinna account by `linkSandboxAccount` (a token written
 * into the sandbox DB), so no OAuth runs.
 *
 * ## What it does not prove
 *
 * Core's own behaviour (budget, schedule, waking an environment, its bridge
 * injection, socket rooms) — the billed live spec against a local core.
 * Reauth, `adapter_unsupported`, `needs_credentials`, `rate_limited` marks and
 * a server change ("Not on this server.") are unit-tested
 * (`remoteTileSource.test.ts`, `Tile.cloud.test.tsx`, `dashboardService.cloud.test.ts`).
 */

const DASHBOARD = 'My dashboard'

let core: FakeCinnaCore
test.beforeEach(async () => {
  core = await startFakeCore()
})
test.afterEach(async () => {
  await core?.close()
})

/** Onboarding skipped, the profile linked to the fake, the remote rows synced by the product, restarted. */
async function arrange(cinna: CinnaApp): Promise<{ own: string; shared: string }> {
  await cinna.skipOnboarding()
  await linkSandboxAccount(cinna, core.host)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  const synced = await cinna.page.evaluate(() => window.api.agents.syncRemote())
  expect(synced).toMatchObject({ success: true, synced: 2 })
  const rows = await cinna.page.evaluate(() => window.api.agents.list())
  const own = rows.find((row) => row.name === OWN_AGENT)
  const shared = rows.find((row) => row.name === SHARED_AGENT)
  expect(own, 'the own agent was not synced').toMatchObject({ source: 'remote', remoteTargetType: 'agent', remoteTargetId: core.own.id })
  expect(shared, 'the shared agent was not synced').toMatchObject({ source: 'remote', remoteTargetType: 'agent' })
  // The renderer reads the profile's server at startup; restart so it and the agent list are fresh.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  return { own: own!.id, shared: shared!.id }
}

/** Cloud tiles added over IPC to a new "My dashboard", in this order. */
async function addTiles(cinna: CinnaApp, agentId: string, components: string[]): Promise<{ dashboardId: string; tileIds: Record<string, string> }> {
  return cinna.page.evaluate(async ({ agentId, components, name }) => {
    const tileIds: Record<string, string> = {}
    let dashboardId = ''
    for (const component of components) {
      const result = dashboardId
        ? await window.api.dashboards.addTile({ dashboardId, agentId, component })
        : await window.api.dashboards.addTile({ newDashboardName: name, agentId, component })
      if (!result.ok) throw new Error(`${component}: ${result.code} ${result.message}`)
      dashboardId = result.dashboard.id
      tileIds[component] = result.tile.id
    }
    return { dashboardId, tileIds }
  }, { agentId, components, name: DASHBOARD })
}

async function openDashboard(page: Page, tileCount: number): Promise<void> {
  await page.getByRole('button', { name: 'Dashboards', exact: true }).click()
  await page.getByRole('button', { name: `${DASHBOARD}, ${tileCount === 1 ? '1 tile' : `${tileCount} tiles`}`, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: DASHBOARD, exact: true })).toBeVisible()
}

function tile(page: Page, title: string) {
  return page.getByTestId('dashboard-grid').getByRole('group', { name: title, exact: true })
}

/** The agent's page in settings mode. */
async function openAgentSettings(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('tablist', { name: 'Agent settings', exact: true })).toBeVisible()
}

test('1 an own cloud agent’s Dashboards tab lists its components, and Add puts one on a new dashboard backed by a desktop-owned core dashboard', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page

  await test.step('the Dashboards tab lists what core lists', async () => {
    await openAgentSettings(page, OWN_AGENT)
    const tabs = page.getByRole('tablist', { name: 'Agent settings', exact: true }).getByRole('tab')
    await expect(tabs).toHaveText(['Overview', 'Connection', 'Interface', 'Dashboards'])
    await tabs.filter({ hasText: 'Dashboards' }).click()
    for (const title of ['Open deals', 'Pipeline', 'Live board']) {
      await expect(page.getByRole('heading', { level: 3, name: title, exact: true })).toBeVisible()
    }
    expect(core.calls('GET', new RegExp(`^/api/v1/agents/${core.own.id}/dashboards/$`)).length).toBeGreaterThan(0)
  })

  await test.step('Add to a new dashboard: core records a desktop dashboard and an agent_component block', async () => {
    await page.getByRole('button', { name: 'Add Open deals to a dashboard', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Open deals to a dashboard', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Dashboard', { exact: true })).toHaveValue(DASHBOARD)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const created = core.calls('POST', /^\/api\/v1\/dashboards\/$/)
    expect(created.map((request) => request.body)).toEqual([{ name: DASHBOARD, origin: 'desktop' }])
    const added = core.calls('POST', /^\/api\/v1\/dashboards\/[0-9a-f-]{36}\/blocks$/)
    expect(added).toHaveLength(1)
    expect(added[0].body).toMatchObject({ agent_id: core.own.id, view_type: 'agent_component', config: { component: 'open-deals', skill: null, params: {} } })
    expect([...core.blocks.values()].map((block) => block.config.component)).toEqual(['open-deals'])
  })

  await test.step('the tile is on the dashboard and draws core’s data', async () => {
    await openDashboard(page, 1)
    await expect(tile(page, 'Open deals').getByText('Acme renewal', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(tile(page, 'Open deals').getByText('Globex expansion', { exact: true })).toBeVisible()
  })
})

test('2 a native cloud tile draws core’s cached data; stale asks for one open refresh, waking the agent with the data still drawn; fresh asks for none', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { own } = await arrange(cinna)
  const page = cinna.page
  core.state.newBlocksStale = false
  await addTiles(cinna, own, ['open-deals'])
  const block = [...core.blocks.values()][0]
  const refreshes = () => core.calls('POST', new RegExp(`/blocks/${block.id}/component/refresh$`))
  const reads = () => core.calls('GET', new RegExp(`/blocks/${block.id}/component/data$`))

  await test.step('fresh: the data is drawn and nothing is refreshed', async () => {
    await openDashboard(page, 1)
    const deals = tile(page, 'Open deals')
    await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => reads().length).toBeGreaterThan(0)
    expect(refreshes()).toHaveLength(0)
  })

  await test.step('stale: one refresh {reason: open}, "Waking Ledger Keeper…" over the cached data while it runs', async () => {
    // Core's cache is stale: its data is the mirror the desktop already holds.
    block.stale = true
    const release = core.holdRefresh()
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await openDashboard(cinna.page, 1)
    const deals = tile(cinna.page, 'Open deals')
    const mark = deals.locator('[data-cloud-mark="waking"]')
    await expect(mark).toHaveText(`Waking ${OWN_AGENT}…`, { timeout: 30_000 })
    await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible()
    await expect.poll(() => refreshes().map((request) => request.body)).toEqual([{ reason: 'open' }])
    release()
    await expect(mark).toHaveCount(0, { timeout: 30_000 })
    await expect(deals.getByText('Globex expansion', { exact: true })).toBeVisible()
    // Settled: still exactly one refresh.
    await expect(cinna.page.getByTestId('dashboard-grid')).toBeVisible()
    expect(refreshes().map((request) => request.body)).toEqual([{ reason: 'open' }])
  })
})

test('3 an html cloud tile is minted on core, relayed through main under the desktop’s CSP, re-minted once on an expired cap, and its tools/call reaches core', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { own } = await arrange(cinna)
  const page = cinna.page
  await addTiles(cinna, own, ['live-board'])
  const block = [...core.blocks.values()][0]
  // The first cap core mints is refused by /d/v/ with 404, as an expired one is.
  core.state.expireNextCap = true

  await openDashboard(page, 1)
  const board = tile(page, 'Live board')
  const frame = board.frameLocator('[data-testid="dashboard-frame"]')

  await test.step('the page loads after one re-mint, runs the bridge and its cinna.call reaches core', async () => {
    await expect(frame.locator('#state')).toHaveText('ready live-board', { timeout: 30_000 })
    await expect(frame.locator('#call')).toHaveText('call {"pong":7,"endpoint":"ping"}')
    const mints = core.calls('POST', new RegExp(`/blocks/${block.id}/component/frame$`))
    expect(mints).toHaveLength(2)
    const caps = [...core.caps.entries()].filter(([, cap]) => cap.blockId === block.id)
    expect(caps.map(([, cap]) => cap.expired)).toEqual([true, false])
    const files = core.requests.filter((request) => request.path.startsWith('/d/v/')).map((request) => request.path)
    expect(files).toEqual([
      `/d/v/${caps[0][0]}/index.html`,
      `/d/v/${caps[1][0]}/index.html`,
      `/d/v/${caps[1][0]}/app.js`
    ])
    expect(core.calls('POST', new RegExp(`/blocks/${block.id}/component/call$`)).map((request) => request.body)).toEqual([{ endpoint: 'ping', params: { n: 7 } }])
  })

  await test.step('the page gets the desktop’s headers, none of core’s', async () => {
    const src = await board.locator('[data-testid="dashboard-frame"]').getAttribute('src')
    expect(src).toMatch(/^cinna-preview:\/\/dash-[^/]+\/[^/]+\/index\.html$/)
    const answer = await cinna.electronApp.evaluate(async ({ session }, url) => {
      const response = await session.defaultSession.fetch(url)
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()) }
    }, src!)
    expect(answer.status).toBe(200)
    const [, host, token] = /^cinna-preview:\/\/([^/]+)\/([^/]+)\//.exec(src!)!
    const prefix = `cinna-preview://${host}/${token}/`
    expect(answer.headers['content-security-policy']).toBe(
      "default-src 'none'; " +
        `connect-src ${prefix}; script-src ${prefix} 'unsafe-inline'; style-src ${prefix} 'unsafe-inline'; ` +
        `img-src ${prefix} data: blob:; font-src ${prefix} data:; media-src ${prefix} blob:; ` +
        "form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'"
    )
    expect(answer.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(answer.headers['x-core-marker']).toBeUndefined()
    expect(answer.headers['access-control-expose-headers']).toBeUndefined()
  })
})

test('4 a filter change sends the whole param set to core, and the tile shows the params core resolved', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { own } = await arrange(cinna)
  const page = cinna.page
  await addTiles(cinna, own, ['pipeline'])
  const block = [...core.blocks.values()][0]
  const puts = () => core.calls('PUT', new RegExp(`/blocks/${block.id}/component/params$`)).map((request) => request.body)

  await openDashboard(page, 1)
  const pipeline = tile(page, 'Pipeline')
  const filters = pipeline.getByTestId('tile-filters')
  // Core resolved `month: current` in the owner's server time zone; the fake says CORE_MONTH.
  await expect(pipeline.getByText(`stage=open month=${CORE_MONTH}`, { exact: true })).toBeVisible({ timeout: 30_000 })
  // The Month control starts at the month core resolved, not one resolved here.
  await expect(filters.getByLabel('Month', { exact: true })).toHaveValue(CORE_MONTH)

  await test.step('Stage → won: PUT params, the tile draws core’s recomputed data', async () => {
    await filters.getByLabel('Stage', { exact: true }).selectOption('won')
    await expect(pipeline.getByText(`stage=won month=${CORE_MONTH}`, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(puts).toHaveLength(1)
    expect(puts()[0]).toEqual({ params: { stage: 'won' } })
  })

  await test.step('the focused tile’s context names the params core resolved, not a month resolved here', async () => {
    await pipeline.hover()
    await pipeline.getByRole('button', { name: 'Ask about Pipeline', exact: true }).click()
    const chip = page.getByTestId('dashboard-chat-panel').getByTestId('dashboard-context-chip')
    await expect(chip).toContainText('Pipeline · won · Jan 2031')
  })

  await test.step('Month → 2026-09: the whole set again, the earlier Stage kept', async () => {
    await filters.getByLabel('Month', { exact: true }).fill('2026-09')
    await expect(pipeline.getByText('stage=won month=2026-09', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(puts).toHaveLength(2)
    expect(puts()[1]).toEqual({ params: { stage: 'won', month: '2026-09' } })
  })
})

test('5 failure marks: server down keeps the data with Retry, a sleeping environment says so, a gone agent offers Remove', async ({ cinna }) => {
  test.setTimeout(150_000)
  const { own } = await arrange(cinna)
  const page = cinna.page
  await addTiles(cinna, own, ['open-deals'])
  const block = [...core.blocks.values()][0]
  await openDashboard(page, 1)
  const deals = tile(page, 'Open deals')
  await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible({ timeout: 30_000 })
  const refresh = async (): Promise<void> => {
    await deals.hover()
    await deals.getByRole('button', { name: 'Refresh Open deals', exact: true }).click()
  }

  await test.step('core down, socket still up: the mark stays until Retry, which clears it once core is back', async () => {
    // Core's socket stays connected, so nothing re-reads the tile on its own: only Retry can clear the mark.
    await expect.poll(() => core.sockets.length, { timeout: 30_000 }).toBe(1)
    core.state.down = true
    await refresh()
    const mark = deals.locator('[data-cloud-mark="unreachable"]')
    await expect(mark.getByText(`Can’t reach ${core.serverName}.`, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible()
    core.state.down = false
    await expect(mark).toHaveCount(1)
    await mark.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(mark).toHaveCount(0, { timeout: 30_000 })
    await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible()
  })

  await test.step('core down with its socket dropped: the mark clears on its own once the socket reconnects', async () => {
    const connections = core.socketEvents.connections
    core.state.down = true
    core.dropSockets()
    await expect.poll(() => core.sockets.length).toBe(0)
    await refresh()
    const mark = deals.locator('[data-cloud-mark="unreachable"]')
    await expect(mark.getByText(`Can’t reach ${core.serverName}.`, { exact: true })).toBeVisible({ timeout: 30_000 })
    core.state.down = false
    // No Retry pressed: the reconnect re-reads every on-screen cloud tile.
    await expect.poll(() => core.socketEvents.connections, { timeout: 60_000 }).toBe(connections + 1)
    await expect(mark).toHaveCount(0, { timeout: 30_000 })
    await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible()
  })

  await test.step('env_unavailable: "<agent>’s environment isn’t running."; the data stays', async () => {
    block.mode = 'env_unavailable'
    await refresh()
    const mark = deals.locator('[data-cloud-mark="env_unavailable"]')
    await expect(mark).toHaveText(`${OWN_AGENT}’s environment isn’t running.`, { timeout: 30_000 })
    await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible()
    block.mode = 'ok'
  })

  await test.step('not_found: "<agent> is no longer available." with Remove, which deletes the block', async () => {
    block.mode = 'not_found'
    await refresh()
    await expect(deals.getByText(`${OWN_AGENT} is no longer available.`, { exact: true })).toBeVisible({ timeout: 30_000 })
    await deals.getByRole('button', { name: 'Remove', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: 'Remove Open deals', exact: true })
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(deals).toHaveCount(0)
    await expect.poll(() => core.calls('DELETE', new RegExp(`/blocks/${block.id}$`)).length).toBe(1)
    expect(core.blocks.size).toBe(0)
  })
})

test('6 a cloud agent the profile does not own has no Dashboards tab, and main refuses its components without asking core', async ({ cinna }) => {
  test.setTimeout(90_000)
  const { shared } = await arrange(cinna)
  const page = cinna.page
  await openAgentSettings(page, SHARED_AGENT)
  await expect(page.getByRole('tablist', { name: 'Agent settings', exact: true }).getByRole('tab')).toHaveText(['Overview', 'Connection', 'Interface'])
  const sentence = `Only ${SHARED_AGENT}’s owner can add its components to a dashboard.`
  const listed = await page.evaluate((id) => window.api.dashboards.cloudComponents(id), shared)
  expect(listed).toEqual({ ok: false, code: 'not_owner', message: sentence })
  const added = await page.evaluate(
    (id) => window.api.dashboards.addTile({ newDashboardName: 'Shared', agentId: id, component: 'open-deals' }),
    shared
  )
  expect(added).toEqual({ ok: false, code: 'not_owner', message: sentence })
  expect(core.requests.filter((request) => request.path.includes(`/agents/${core.shared.id}/dashboards`))).toEqual([])
  expect(core.calls('POST', /^\/api\/v1\/dashboards\/$/)).toEqual([])
})

test('7 the panel on a cloud tile opens core’s dashboard chat and sends the context as A2A metadata, not in the text', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { own } = await arrange(cinna)
  const page = cinna.page
  await addTiles(cinna, own, ['open-deals'])
  const backing = [...core.dashboards.keys()][0]
  await openDashboard(page, 1)
  const deals = tile(page, 'Open deals')
  await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible({ timeout: 30_000 })

  await deals.hover()
  await deals.getByRole('button', { name: 'Ask about Open deals', exact: true }).click()
  const panel = page.getByTestId('dashboard-chat-panel')
  await expect(panel).toBeVisible()
  await expect.poll(() => core.calls('POST', new RegExp(`^/api/v1/dashboards/${backing}/chat$`)).map((request) => request.body)).toEqual([
    { agent_id: core.own.id, new: false }
  ])
  const session = core.sessions[0].id

  const question = 'Which open deal is the biggest?'
  const composer = panel.getByRole('combobox', { name: 'Type a message...', exact: true })
  await composer.fill(question)
  await composer.press('Enter')
  await expect(panel.getByText(core.state.reply, { exact: true })).toBeVisible({ timeout: 30_000 })

  expect(core.a2a).toHaveLength(1)
  const sent = core.a2a[0]
  expect(sent.method).toBe('message/stream')
  expect(sent.authorization).toBe('Bearer task-handoff-fixture-token')
  expect(sent.message.taskId).toBe(session)
  expect(sent.text).toBe(question)
  expect(sent.text).not.toContain('<dashboard_context>')
  const context = sent.message.metadata?.cinna_dashboard_context as { dashboard?: string; focused?: { title?: string; component?: string } } | undefined
  expect(context, JSON.stringify(sent.message.metadata)).toBeTruthy()
  expect(context!.dashboard).toBe(DASHBOARD)
  expect(context!.focused).toMatchObject({ title: 'Open deals', component: 'open-deals' })
})

test('8 core’s socket events reach the tile: a highlight marks the row, an update re-reads the data', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { own } = await arrange(cinna)
  const page = cinna.page
  await addTiles(cinna, own, ['open-deals'])
  const block = [...core.blocks.values()][0]
  await openDashboard(page, 1)
  const deals = tile(page, 'Open deals')
  await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => core.sockets.length, { timeout: 30_000 }).toBe(1)
  expect(core.socketAuth.at(-1)).toBe('task-handoff-fixture-token')

  await test.step('dashboard_tile_highlight marks the named row', async () => {
    core.emit('dashboard_tile_highlight', { dashboard_id: block.dashboardId, block_id: block.id, ids: ['globex'] })
    const highlighted = deals.locator('li[data-highlighted="true"]')
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toContainText('Globex expansion')
  })

  await test.step('dashboard_tile_updated re-reads core’s data (well before the 30 s poll)', async () => {
    block.data = { items: [{ id: 'initech', title: 'Initech pilot' }] }
    core.emit('dashboard_tile_updated', { dashboard_id: block.dashboardId, block_id: block.id })
    await expect(deals.getByText('Initech pilot', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(deals.getByText('Acme renewal', { exact: true })).toHaveCount(0)
  })
})

test('9 an html cloud tile whose frame mint finds the environment not running shows Retry, and opens once a tile update arrives', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { own } = await arrange(cinna)
  const page = cinna.page
  await addTiles(cinna, own, ['live-board'])
  const block = [...core.blocks.values()][0]
  block.frameRefusal = 'env_unavailable'
  const mints = () => core.calls('POST', new RegExp(`/blocks/${block.id}/component/frame$`))

  await openDashboard(page, 1)
  const board = tile(page, 'Live board')
  const refusal = board.locator('[data-refusal="env_unavailable"]')
  await expect(refusal).toContainText(`${OWN_AGENT}’s environment isn’t running.`, { timeout: 30_000 })
  const retry = refusal.getByRole('button', { name: 'Retry', exact: true })
  await expect(retry).toBeVisible()
  // The accent link every Retry on a dashboard uses.
  await expect(retry).toHaveClass(/text-\[var\(--color-accent\)\]/)

  // The environment is up; core says the tile changed, the tile re-reads, and the page opens again without a click.
  await expect.poll(() => core.sockets.length, { timeout: 30_000 }).toBe(1)
  block.frameRefusal = null
  core.emit('dashboard_tile_updated', { dashboard_id: block.dashboardId, block_id: block.id })
  const frame = board.frameLocator('[data-testid="dashboard-frame"]')
  const openedFrom = Date.now()
  // An automatic reopen keeps 10 s from the last open (CLOUD_FRAME_REOPEN_GAP_MS): allow for it.
  await expect(frame.locator('#state')).toHaveText('ready live-board', { timeout: 20_000 })
  await expect(refusal).toHaveCount(0)
  // A burst of result changes gives one reopen, not one per change: the refused mint and the one that opened.
  expect(Date.now() - openedFrom).toBeLessThan(13_000)
  expect(mints()).toHaveLength(2)
})

test('10 the Remove confirm on a tile whose block core no longer has says the agent is gone, as its mark does', async ({ cinna }) => {
  test.setTimeout(90_000)
  const { own } = await arrange(cinna)
  const page = cinna.page
  await addTiles(cinna, own, ['open-deals'])
  const block = [...core.blocks.values()][0]
  await openDashboard(page, 1)
  const deals = tile(page, 'Open deals')
  await expect(deals.getByText('Acme renewal', { exact: true })).toBeVisible({ timeout: 30_000 })
  block.mode = 'not_found'
  await deals.hover()
  await deals.getByRole('button', { name: 'Refresh Open deals', exact: true }).click()
  await expect(deals.locator('[data-cloud-mark="agent_gone"]')).toContainText(`${OWN_AGENT} is no longer available.`, { timeout: 30_000 })
  await deals.getByRole('button', { name: 'Remove', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove Open deals', exact: true })
  await expect(confirm).toContainText(`Remove Open deals from ${DASHBOARD}? ${OWN_AGENT} is no longer available, so its data goes with the tile.`, { timeout: 5_000 })
})

test('11 an agent deleted on core: after a restart its tile says so with Remove, and the confirm says its data goes with the tile', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { own } = await arrange(cinna)
  await addTiles(cinna, own, ['open-deals'])
  const block = [...core.blocks.values()][0]
  core.own.gone = true
  await cinna.relaunch()
  await cinna.skipOnboarding()
  const page = cinna.page
  await openDashboard(page, 1)
  const deals = tile(page, 'Open deals')
  await expect(deals.getByText(`${OWN_AGENT} is no longer available.`, { exact: true })).toBeVisible({ timeout: 30_000 })
  await deals.getByRole('button', { name: 'Remove', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove Open deals', exact: true })
  await expect(confirm).toContainText(`Remove Open deals from ${DASHBOARD}? ${OWN_AGENT} is no longer available, so its data goes with the tile.`)
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(deals).toHaveCount(0)
  await expect.poll(() => core.calls('DELETE', new RegExp(`/blocks/${block.id}$`)).length).toBe(1)
})
