import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Frame, Page } from '@playwright/test'
import { answerAgentsFolder, expect, test, type CinnaApp } from '../fixtures/app'
import { createFolderAgent } from '../fixtures/seed'
import { liveCinnaConfig, signIn } from '../fixtures/liveCinna'
import { coreCall, makeTeamTest, type PersonApp, type SharingPerson, type TeamFixtureBase } from '../fixtures/liveTeamSharing'

/**
 * Agent Details (orchestrator `features/agent-details`, V9): an agent's
 * readable page, opened from **Details** — the catalog detail's header button,
 * a catalog version row's icon, or the ⋯ menu of an agent's page.
 *
 * Two halves:
 *
 * - **Folder agents, no server** (run by every `make e2e`). A kit agent's own
 *   `docs/AGENT_DETAILS.md` / `.html`: the ⋯ menu offers Details only when a
 *   file is there; markdown renders as a document with raw HTML off; HTML is
 *   served by the `cinna-preview://det-…/` frame server into an iframe
 *   sandboxed without `allow-scripts` / `allow-same-origin`. That is the same
 *   server, frame and guards a core-served custom page gets, so the navigation
 *   lock is driven here on pages the test writes byte for byte: a
 *   `<meta http-equiv="refresh">` to `http:`, `cinna-preview:`, `data:` and
 *   `https:` never moves the frame and never opens the browser; a clicked
 *   `https:` link goes to the browser (`shell.openExternal`, recorded in main)
 *   and the frame stays.
 * - **The real local cinna-core** (`CINNA_E2E_INTEGRATION=1` plus
 *   `CINNA_E2E_SERVER_URL` / `_EMAIL` / `_PASSWORD`, a superuser). The admin's
 *   desktop, on real desktop tokens, shares a throwaway kit agent to the
 *   catalog with nobody else, reads its **generated** Details from the catalog
 *   before any install, shares a second version carrying
 *   `docs/AGENT_DETAILS.html` (with a script and a refresh), reads the
 *   **publisher's page** and the **Platform summary** from core, and the
 *   version-1 row's Details; then an own cloud agent's Details from its page.
 *   The catalog item is deleted afterwards by exact name and the run's marker.
 *
 * Not proven: a cloud agent's custom page (no workspace fixture), an
 * installed bundle's revision pin, a vault agent, mobile and web.
 */

const DET_URL = /^cinna-preview:\/\/det-[0-9a-f]+\/$/
const FRAME_SANDBOX = 'allow-top-navigation-by-user-activation'

/** The open Details modal for `name`. */
function detailsModal(page: Page, name: string) {
  return page.getByRole('dialog', { name: `Details: ${name}`, exact: true })
}

/** The page's ⋯ → Details. */
async function openDetailsFromMenu(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menu', { name: 'Agent actions', exact: true }).getByRole('menuitem', { name: 'Details', exact: true }).click()
  await expect(detailsModal(page, name)).toBeVisible()
}

/** The Details frame of `name`'s modal, once it has loaded its det- URL. */
async function detailsFrame(page: Page, name: string): Promise<Frame> {
  const handle = await detailsModal(page, name).locator(`iframe[title="Details of ${name}"]`).elementHandle()
  const frame = await handle?.contentFrame()
  if (!frame) throw new Error(`no Details frame for ${name}`)
  await expect.poll(() => frame.url()).toMatch(DET_URL)
  return frame
}

/** Record `shell.openExternal` in main instead of opening a browser. */
async function recordOpenExternal(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ shell }) => {
    const globals = globalThis as unknown as { __detailsOpened: string[] }
    globals.__detailsOpened = []
    shell.openExternal = async (url: string): Promise<void> => {
      globals.__detailsOpened.push(url)
    }
  })
}

/**
 * Records what main's renderer-failure path would do — the "Cinna Desktop
 * renderer failed" box and the exit after it — instead of doing it, so a
 * frame's refused load that reached it fails the test rather than the run.
 */
async function recordRendererFailures(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ app, dialog }) => {
    const globals = globalThis as unknown as { __rendererFailures: string[] }
    globals.__rendererFailures = []
    dialog.showErrorBox = (title: string, content: string): void => {
      globals.__rendererFailures.push(`${title}: ${content.split('\n')[0]}`)
    }
    app.exit = (code?: number): void => {
      globals.__rendererFailures.push(`exit ${code ?? 0}`)
    }
  })
}

async function rendererFailures(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(() => (globalThis as unknown as { __rendererFailures?: string[] }).__rendererFailures ?? [])
}

async function openedUrls(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(() => (globalThis as unknown as { __detailsOpened?: string[] }).__detailsOpened ?? [])
}

/** A Details page whose script, if it ran, would leave three marks. */
function scriptedPage(title: string, extraHead = '', extraBody = ''): string {
  return `<!DOCTYPE html>
<html><head><title>${title}</title>${extraHead}
<style>body { font-family: sans-serif; }</style>
<script>
  document.title = 'SCRIPT RAN';
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('static').textContent = 'SCRIPT REWROTE THIS';
    var p = document.createElement('p'); p.id = 'injected'; p.textContent = 'SCRIPT INJECTED THIS';
    document.body.appendChild(p);
  });
</script>
</head><body>
<h1>Weather Desk page</h1>
<p id="static">Static text from the publisher.</p>
<noscript><p id="noscript">Scripts are off in this frame.</p></noscript>
${extraBody}
</body></html>
`
}

/**
 * The frame shows the page as written and the script left none of its marks;
 * the iframe is sandboxed without scripts or same origin.
 */
async function expectInertPage(page: Page, name: string, title: string): Promise<Frame> {
  const modal = detailsModal(page, name)
  const iframe = modal.locator(`iframe[title="Details of ${name}"]`)
  await expect(iframe).toHaveAttribute('sandbox', FRAME_SANDBOX)
  await expect(iframe).toHaveAttribute('src', DET_URL)
  const frame = modal.frameLocator(`iframe[title="Details of ${name}"]`)
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Weather Desk page')
  await expect(frame.locator('#static')).toHaveText('Static text from the publisher.')
  await expect(frame.locator('#noscript')).toHaveText('Scripts are off in this frame.')
  await expect(frame.locator('#injected')).toHaveCount(0)
  const loaded = await detailsFrame(page, name)
  expect(await loaded.title()).toBe(title)
  return loaded
}

async function openAgentPage(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
}

/** Folder agents in the default home, each with the given `docs/` files; a restart so every list reads them. */
async function seedFolderAgents(cinna: CinnaApp, agents: Record<string, Record<string, string | Buffer>>): Promise<Record<string, string>> {
  await cinna.skipOnboarding()
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  const root = (await cinna.page.evaluate(() => window.api.localAgents.rootsList()))[0]
  const ids: Record<string, string> = {}
  for (const [name, files] of Object.entries(agents)) {
    const agent = await createFolderAgent(cinna, root, name)
    ids[name] = agent.id
    mkdirSync(join(agent.path, 'docs'), { recursive: true })
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(agent.path, rel), body)
  }
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return ids
}

// ---------------------------------------------------------------------------
// Folder agents: no server.
// ---------------------------------------------------------------------------

test.describe('a folder agent’s own Details file', () => {
  test('V9 local: .md as a document, .html in the det- frame with its script inert, no file means no Details', async ({ cinna }) => {
    test.setTimeout(120_000)
    const ids = await seedFolderAgents(cinna, {
      'Markdown Desk': {
        'docs/AGENT_DETAILS.md': '# Markdown Desk\n\n## What it does\n\nAsk me about **forecasts**.\n\n<b>raw html stays out</b>\n'
      },
      'Html Desk': { 'docs/AGENT_DETAILS.html': scriptedPage('Html Desk') },
      'Plain Desk': {}
    })
    const page = cinna.page

    await test.step('no file: main answers not_found and the ⋯ menu has no Details', async () => {
      const answer = await page.evaluate((agentId) => window.api.agentDetails.get({ kind: 'local', agentId }), ids['Plain Desk'])
      expect(answer).toEqual({ ok: false, code: 'not_found', message: 'This agent has no Details page.' })
      await openAgentPage(page, 'Plain Desk')
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      const menu = page.getByRole('menu', { name: 'Agent actions', exact: true })
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: 'Details', exact: true })).toHaveCount(0)
      // The ⋯ menu (usePopover) closes on an outside press, not on Escape.
      await page.getByRole('heading', { level: 1 }).click()
      await expect(menu).toHaveCount(0)
    })

    await test.step('.md: Details opens the document; raw HTML is not rendered; no summary switch', async () => {
      await openAgentPage(page, 'Markdown Desk')
      await openDetailsFromMenu(page, 'Markdown Desk')
      const modal = detailsModal(page, 'Markdown Desk')
      // The document's headings sit under the modal's own (markdown h2 → h4).
      await expect(modal.getByRole('heading', { level: 4, name: 'What it does', exact: true })).toBeVisible()
      await expect(modal.getByText('Ask me about forecasts.', { exact: true })).toBeVisible()
      await expect(modal.locator('strong')).toHaveText('forecasts')
      await expect(modal.locator('b')).toHaveCount(0)
      await expect(modal.getByRole('group', { name: 'Show' })).toHaveCount(0)
      await expect(modal.locator('iframe')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(modal).toHaveCount(0)
    })

    await test.step('.html: a det- frame sandboxed without scripts or same origin; the script did nothing', async () => {
      await openAgentPage(page, 'Html Desk')
      await openDetailsFromMenu(page, 'Html Desk')
      await expectInertPage(page, 'Html Desk', 'Html Desk')
      // A local page has no generated summary to switch to.
      await expect(detailsModal(page, 'Html Desk').getByRole('group', { name: 'Show' })).toHaveCount(0)
    })
  })

  test('V9 local: a file over 1 MiB or not UTF-8 still offers Details, which says why', async ({ cinna }) => {
    test.setTimeout(120_000)
    await seedFolderAgents(cinna, {
      'Huge Desk': { 'docs/AGENT_DETAILS.md': `# Huge\n\n${'x'.repeat(1_048_577)}\n` },
      'Latin Desk': { 'docs/AGENT_DETAILS.html': Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]) }
    })
    const page = cinna.page
    for (const [name, message] of [
      ['Huge Desk', 'docs/AGENT_DETAILS.md is over 1 MiB.'],
      ['Latin Desk', 'docs/AGENT_DETAILS.html is not UTF-8 text.']
    ] as const) {
      await test.step(`${name}: “${message}”`, async () => {
        await openAgentPage(page, name)
        await openDetailsFromMenu(page, name)
        const modal = detailsModal(page, name)
        await expect(modal.getByRole('alert')).toHaveText(message)
        await expect(modal.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(modal).toHaveCount(0)
      })
    }
  })

  test('V9 local: a meta refresh to http, cinna-preview, data or https never moves the frame or opens the browser', async ({ cinna }) => {
    test.setTimeout(120_000)
    const targets: Record<string, string> = {
      'Refresh Http': 'http://example.com/details-e2e',
      'Refresh Preview': 'cinna-preview://det-0000/',
      'Refresh Data': 'data:text/html,<h1>DATA PAGE</h1>',
      'Refresh Https': 'https://example.com/refreshed-e2e'
    }
    const agents: Record<string, Record<string, string>> = {}
    for (const [name, url] of Object.entries(targets)) {
      agents[name] = { 'docs/AGENT_DETAILS.html': scriptedPage(name, `<meta http-equiv="refresh" content="0;url=${url}">`) }
    }
    await seedFolderAgents(cinna, agents)
    await recordOpenExternal(cinna.electronApp)
    await recordRendererFailures(cinna.electronApp)
    const page = cinna.page
    const consoleLines: string[] = []
    page.on('console', (message) => consoleLines.push(message.text()))

    for (const name of Object.keys(targets)) {
      await test.step(`${name}: the frame keeps its det- URL and no refresh tag reaches it`, async () => {
        await openAgentPage(page, name)
        await openDetailsFromMenu(page, name)
        const frame = await expectInertPage(page, name, name)
        const url = frame.url()
        // Settled: the frame's parser has reached the <script> after the
        // <meta> (Chromium reports blocking it), so a refresh would have been
        // scheduled by now if one were there.
        await expect.poll(() => consoleLines.some((line) => line.includes(`Blocked script execution in '${url}'`))).toBe(true)
        await expect(detailsModal(page, name).frameLocator('iframe').locator('meta[http-equiv="refresh" i]')).toHaveCount(0)
        expect(frame.url()).toBe(url)
        await expect(detailsModal(page, name).frameLocator('iframe').locator('#static')).toHaveText('Static text from the publisher.')
        expect(await openedUrls(cinna.electronApp)).toEqual([])
        expect(await rendererFailures(cinna.electronApp)).toEqual([])
        await page.keyboard.press('Escape')
        await expect(detailsModal(page, name)).toHaveCount(0)
      })
    }
  })

  for (const [kind, target] of [
    ['a plain', ''],
    ['a target=_blank', ' target="_blank"'],
    ['a target=_top', ' target="_top"']
  ] as const) {
    test(`V9 local: ${kind} https link goes to the browser and the frame stays`, async ({ cinna }) => {
      // The frame server retargets every https link to _top: a plain or _blank one would
      // otherwise be refused by the app window's CSP (ERR_BLOCKED_BY_CSP) before main's guard.
      test.setTimeout(120_000)
      const name = 'Link Desk'
      await seedFolderAgents(cinna, {
        [name]: {
          'docs/AGENT_DETAILS.html': scriptedPage(name, '', `<p><a href="https://example.com/details-link-e2e"${target}>The https site</a></p>`)
        }
      })
      await recordOpenExternal(cinna.electronApp)
      const page = cinna.page
      await openAgentPage(page, name)
      await openDetailsFromMenu(page, name)
      const frame = await expectInertPage(page, name, name)
      const url = frame.url()
      await detailsModal(page, name).frameLocator('iframe').getByRole('link', { name: 'The https site', exact: true }).click({ noWaitAfter: true })
      await expect.poll(() => openedUrls(cinna.electronApp)).toEqual(['https://example.com/details-link-e2e'])
      expect(frame.url()).toBe(url)
      await expect(detailsModal(page, name).frameLocator('iframe').locator('#static')).toHaveText('Static text from the publisher.')
      // No refused load reached main's renderer-failure dialog (or its exit).
      expect(await rendererFailures(cinna.electronApp)).toEqual([])
    })
  }

  test('V9 local: Escape closes Details after a click inside the HTML frame', async ({ cinna }) => {
    const name = 'Escape Desk'
    await seedFolderAgents(cinna, { [name]: { 'docs/AGENT_DETAILS.html': scriptedPage(name) } })
    const page = cinna.page
    await openAgentPage(page, name)
    await openDetailsFromMenu(page, name)
    await expectInertPage(page, name, name)
    // Focus moves into the cross-origin frame, whose keys the app's document never hears.
    await detailsModal(page, name).frameLocator('iframe').locator('#static').click()
    await expect
      .poll(() =>
        cinna.electronApp.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().find((w) => /\/index\.html$/.test(w.webContents.getURL().split(/[?#]/)[0]))?.webContents.focusedFrame?.url ?? ''
        )
      )
      .toMatch(DET_URL)
    // A key press through the window's native input path, which main's before-input-event
    // sees (Playwright's keyboard dispatches over CDP, which it does not). sendInputEvent
    // lands on the main frame's widget, so the app's own listener could close the modal
    // too: what proves the forward is main sending it while the det- frame has focus. A
    // real key in the out-of-process frame reaches only that frame, and main.
    const forwarded = await cinna.electronApp.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => /\/index\.html$/.test(w.webContents.getURL().split(/[?#]/)[0]))
      if (!main) return []
      const sent: string[] = []
      const send = main.webContents.send.bind(main.webContents)
      main.webContents.send = (channel: string, ...args: unknown[]): void => {
        sent.push(channel)
        send(channel, ...args)
      }
      main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      main.webContents.send = send
      return sent
    })
    expect(forwarded).toContain('agent-details:escape')
    await expect(detailsModal(page, name)).toHaveCount(0)
  })

  test('a refused subframe load is not a renderer failure: no dialog, no exit', async ({ cinna }) => {
    await recordRendererFailures(cinna.electronApp)
    const page = cinna.page
    await cinna.electronApp.evaluate(({ BrowserWindow }) => {
      const globals = globalThis as unknown as { __subframeFailures: Array<{ code: number; isMainFrame: boolean }> }
      globals.__subframeFailures = []
      const main = BrowserWindow.getAllWindows().find((w) => /\/index\.html$/.test(w.webContents.getURL().split(/[?#]/)[0]))
      main?.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
        if (url.includes('subframe-e2e')) globals.__subframeFailures.push({ code, isMainFrame })
      })
    })
    const failures = () =>
      cinna.electronApp.evaluate(() => (globalThis as unknown as { __subframeFailures?: Array<{ code: number; isMainFrame: boolean }> }).__subframeFailures ?? [])
    // The app's own CSP refuses an https frame: the load fails in a subframe, as a Details link once did.
    await page.evaluate(() => {
      const frame = document.createElement('iframe')
      frame.src = 'https://example.com/subframe-e2e'
      frame.id = 'subframe-e2e'
      document.body.append(frame)
    })
    await expect.poll(async () => (await failures()).length).toBeGreaterThan(0)
    expect((await failures()).every((failure) => !failure.isMainFrame)).toBe(true)
    await page.evaluate(() => document.getElementById('subframe-e2e')?.remove())
    expect(await rendererFailures(cinna.electronApp)).toEqual([])
    // Still answering, both sides.
    expect(await page.evaluate(() => document.readyState)).toBe('complete')
    expect(await cinna.electronApp.evaluate(({ app }) => app.isReady())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The real local cinna-core.
// ---------------------------------------------------------------------------

const INTEGRATION = process.env.CINNA_E2E_INTEGRATION === '1'

/** The admin as the one person of a team fixture; filled in `beforeAll`. */
let coreFixture: TeamFixtureBase | null = null

const coreTest = makeTeamTest(
  () => coreFixture,
  'Set CINNA_E2E_INTEGRATION=1 and CINNA_E2E_SERVER_URL / _EMAIL / _PASSWORD (a superuser) for a running local cinna-core serving agent_details'
)

/** The catalog dialog's Agents, then `name`'s detail. */
async function openCatalogDetail(app: PersonApp, name: string) {
  await app.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await app.page.getByRole('button', { name: 'Add an agent' }).click()
  await app.page.getByRole('dialog', { name: 'Add an agent' }).getByRole('button', { name: /Install from catalog/ }).click()
  const catalog = app.page.getByRole('dialog', { name: 'Catalog' })
  await catalog.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: 'Agents', exact: true }).click()
  await catalog.getByRole('group', { name, exact: true }).getByRole('button', { name, exact: true }).click()
  await expect(catalog.getByRole('button', { name: `Details of ${name}`, exact: true })).toBeVisible({ timeout: 30_000 })
  return catalog
}

/** The catalog item core lists under exactly `name` and carrying `marker`, as the admin sees it. */
async function ownCatalogItem(fixture: TeamFixtureBase, name: string, marker: string): Promise<any> {
  const listed = await coreCall(fixture, fixture.admin.token, '/catalog/items?kind=agent&runs_on=desktop&limit=200')
  expect(listed.status, JSON.stringify(listed.body)).toBe(200)
  return (listed.body.data as any[]).find((item) => item.display_name === name && String(item.description ?? '').includes(marker))
}

coreTest.describe('Details from the real local cinna-core', () => {
  coreTest.beforeAll(async () => {
    const config = liveCinnaConfig()
    if (!INTEGRATION || !config) return
    const discovery = await fetch(`${config.serverUrl}/.well-known/cinna-desktop`).then((r) => r.json()).catch(() => null)
    if (discovery?.agent_details !== 1) return
    const token = await signIn(config)
    const base: TeamFixtureBase = {
      server: config.serverUrl,
      tag: `e2e-details-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`,
      admin: { id: '', token },
      people: {} as TeamFixtureBase['people']
    }
    const me = await coreCall(base, token, '/users/me')
    expect(me.status).toBe(200)
    const person: SharingPerson = { id: me.body.id, email: config.email, name: me.body.full_name || config.email, token }
    coreFixture = { ...base, admin: { id: person.id, token }, people: { a: person, b: person, c: person } }
  })

  coreTest('V9 core: catalog Details before install (generated), then the publisher’s page and the Platform summary', async ({ team }) => {
    coreTest.setTimeout(300_000)
    const fixture = team.fixture
    const name = `Details Desk ${fixture.tag}`
    const marker = `[${fixture.tag}]`
    const description = `Reads the weather for the agent details run ${marker}.`
    try {
      const a = await team.open('a')
      let agentId = ''

      await coreTest.step('arrange: a kit agent with no Details file, shared to the catalog with nobody else', async () => {
        const rootId = await a.rootId()
        const created = await a.page.evaluate(
          async (input) => {
            const agent = await window.api.localAgents.create(input)
            await window.api.localAgents.markGuidedBuildDone(agent.id)
            return agent
          },
          { rootId, name, description }
        )
        agentId = created.id
        const shared = await a.page.evaluate((id) => window.api.sharing.shareWithTeam(id, { name: '', people: [] }), agentId)
        expect(shared, JSON.stringify(shared)).toMatchObject({ success: true, value: { done: true } })
        await expect.poll(async () => (await ownCatalogItem(fixture, name, marker))?.latest?.revision_number ?? null, { timeout: 30_000 }).toBe(1)
      })

      await coreTest.step('1 catalog, before install: Details shows core’s generated page, About first', async () => {
        const catalog = await openCatalogDetail(a, name)
        await catalog.getByRole('button', { name: `Details of ${name}`, exact: true }).click()
        const modal = detailsModal(a.page, name)
        await expect(modal.getByRole('heading', { level: 4, name: 'About', exact: true })).toBeVisible()
        await expect(modal.getByText(description, { exact: true })).toBeVisible()
        await expect(modal.getByRole('group', { name: 'Show' })).toHaveCount(0)
        await expect(modal.locator('iframe')).toHaveCount(0)
        // Escape closes the Details only; the catalog stays.
        await a.page.keyboard.press('Escape')
        await expect(modal).toHaveCount(0)
        await expect(catalog).toBeVisible()
        await catalog.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(catalog).toHaveCount(0)
      })

      await coreTest.step('arrange: version 2 carries docs/AGENT_DETAILS.html with a script and a refresh', async () => {
        const agent = await a.page.evaluate((id) => window.api.localAgents.get(id), agentId)
        if (!agent.ok) throw new Error(agent.message)
        mkdirSync(join(agent.value.path, 'docs'), { recursive: true })
        writeFileSync(
          join(agent.value.path, 'docs/AGENT_DETAILS.html'),
          scriptedPage('Details Desk', '<meta http-equiv="refresh" content="0;url=https://example.com/core-refresh-e2e">')
        )
        const sent = await a.page.evaluate((id) => window.api.sharing.shareChanges(id, 'Adds a Details page'), agentId)
        expect(sent, JSON.stringify(sent)).toMatchObject({ success: true, value: { done: true } })
        await expect.poll(async () => (await ownCatalogItem(fixture, name, marker))?.latest?.revision_number ?? null, { timeout: 30_000 }).toBe(2)
      })

      await recordOpenExternal(a.electronApp)
      await coreTest.step('4 the publisher’s page from core, in the det- frame: the script did nothing, the frame stays', async () => {
        const catalog = await openCatalogDetail(a, name)
        await catalog.getByRole('button', { name: `Details of ${name}`, exact: true }).click()
        const modal = detailsModal(a.page, name)
        const show = modal.getByRole('group', { name: 'Show' })
        await expect(show.getByRole('button', { name: 'Publisher’s page', exact: true })).toHaveAttribute('aria-pressed', 'true')
        const frame = await expectInertPage(a.page, name, 'Details Desk')
        await expect(modal.frameLocator('iframe').locator('meta[http-equiv="refresh" i]')).toHaveCount(0)
        expect(frame.url()).toMatch(DET_URL)
        expect(await openedUrls(a.electronApp)).toEqual([])
      })

      await coreTest.step('5 Platform summary shows the generated page, and back', async () => {
        const modal = detailsModal(a.page, name)
        const show = modal.getByRole('group', { name: 'Show' })
        await show.getByRole('button', { name: 'Platform summary', exact: true }).click()
        await expect(show.getByRole('button', { name: 'Platform summary', exact: true })).toHaveAttribute('aria-pressed', 'true')
        await expect(modal.getByRole('heading', { level: 4, name: 'About', exact: true })).toBeVisible()
        await expect(modal.getByText(description, { exact: true })).toBeVisible()
        await expect(modal.locator('iframe')).toHaveCount(0)
        await show.getByRole('button', { name: 'Publisher’s page', exact: true }).click()
        await expectInertPage(a.page, name, 'Details Desk')
        await expect(modal.getByRole('heading', { level: 4, name: 'About', exact: true })).toHaveCount(0)
        await a.page.keyboard.press('Escape')
        await expect(modal).toHaveCount(0)
      })

      await coreTest.step('the Version 1 row’s Details reads that version: generated, no switch', async () => {
        const catalog = a.page.getByRole('dialog', { name: 'Catalog' })
        await catalog.getByRole('button', { name: 'Details of Version 1', exact: true }).click()
        const modal = detailsModal(a.page, name)
        await expect(modal.getByText('Version 1', { exact: true })).toBeVisible()
        await expect(modal.getByRole('heading', { level: 4, name: 'About', exact: true })).toBeVisible()
        await expect(modal.getByRole('group', { name: 'Show' })).toHaveCount(0)
        await a.page.keyboard.press('Escape')
        await expect(modal).toHaveCount(0)
        await expect(catalog).toBeVisible()
        await catalog.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(catalog).toHaveCount(0)
      })
    } finally {
      // Exact name and the run's marker only: never a loose match.
      const fresh = await signIn(liveCinnaConfig()!)
      const cleanup = { ...fixture, admin: { ...fixture.admin, token: fresh } }
      const item = await ownCatalogItem(cleanup, name, marker)
      if (item) {
        const removed = await coreCall(cleanup, fresh, `/catalog/items/${item.uuid}`, { method: 'DELETE' })
        coreTest.info().annotations.push({ type: 'core cleanup', description: `DELETE catalog item ${item.uuid} (${name}): HTTP ${removed.status}` })
        expect(removed.status).toBe(204)
      }
    }
  })

  coreTest('V9 core: an own Cinna agent’s Details from its page’s ⋯ menu', async ({ team }) => {
    coreTest.setTimeout(180_000)
    const fixture = team.fixture
    const a = await team.open('a')
    const synced = await a.page.evaluate(() => window.api.agents.syncRemote())
    expect(synced).toMatchObject({ success: true })
    const rows = (await a.page.evaluate(() => window.api.agents.list())).filter((row) => row.source === 'remote' && row.remoteTargetType === 'agent')
    // An agent with a unique name whose About is plain text (read-only: nothing is created on core).
    let chosen: { name: string; about: string } | null = null
    for (const row of rows) {
      if (rows.filter((other) => other.name === row.name).length !== 1 || !row.remoteTargetId) continue
      const details = await coreCall(fixture, fixture.admin.token, `/agents/${row.remoteTargetId}/details`)
      if (details.status !== 200 || details.body.source !== 'generated') continue
      const about = /^## About\n\n([^\n]+)/.exec(details.body.content as string)?.[1] ?? ''
      if (about && !/[*_`[\]<>#\\]/.test(about)) {
        chosen = { name: row.name, about }
        break
      }
    }
    coreTest.skip(chosen === null, 'the admin has no cloud agent with a plain-text generated About on this core')
    const { name, about } = chosen!
    await a.relaunch()
    await openAgentPage(a.page, name)
    await openDetailsFromMenu(a.page, name)
    const modal = detailsModal(a.page, name)
    await expect(modal.getByRole('heading', { level: 4, name: 'About', exact: true })).toBeVisible()
    await expect(modal.getByText(about, { exact: true })).toBeVisible()
    await a.page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
  })
})
