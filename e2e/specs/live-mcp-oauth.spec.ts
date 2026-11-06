import { chromium, type Browser, type Locator } from '@playwright/test'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { catalogFixture } from '../fixtures/liveCatalog'
import { repoRoot } from '../playwright.config'

/**
 * A real MCP OAuth connector — one of the local cinna-core's agent MCP
 * connectors — added in Settings → MCP Providers, signed in through core's
 * consent page, and still signed in after restarts. Guards the 2026-11 move to
 * `@modelcontextprotocol/client` 2.4, which stamps an issuer onto stored
 * tokens that have none and validates discovery more strictly; until this spec
 * nothing drove the client against a real OAuth MCP server.
 *
 * Core: each connector is a resource server at `/mcp/<connector id>/mcp` with
 * a shared authorization server at `/mcp/oauth` (DCR, PKCE, consent on the web
 * app). The resource URL the app connects to must be the one core advertises,
 * so core's `MCP_SERVER_BASE_URL` must be `http://localhost:8000/mcp` for the
 * run (`make mcp-set-url URL=http://localhost:8000` in `$CINNA_CORE_PATH`,
 * `make mcp-set-url` afterwards); the spec skips when the advertised issuer is
 * not on localhost.
 *
 * People come from `CINNA_CATALOG_LIVE_FIXTURE` (`e2e/fixtures/live-catalog.py`):
 * A owns the connector and approves the consent in Playwright's Chromium,
 * signed in on core's web app with the fixture's web token.
 *
 * No model runs: the connector's tools are listed, never called
 * (`send_message` would run the agent).
 *
 * `shell.openExternal` is recorded from process start by
 * `fixtures/openExternalRecorder.cjs` (the fixture's `mainRequire`), on every
 * launch: the restart's own startup connect is what this spec is about, and a
 * stub installed after launch would let a failed one open a real browser.
 */

const fixture = catalogFixture()
const ISSUER = 'http://localhost:8000/mcp/oauth'
const TOOLS = ['get_file_upload_url', 'send_message']

test.use({ mainRequire: [join(repoRoot, 'e2e', 'fixtures', 'openExternalRecorder.cjs')] })

let unavailable: string | null = null
test.beforeAll(async () => {
  if (!fixture) {
    unavailable = 'Set CINNA_CATALOG_LIVE_FIXTURE to the JSON printed by e2e/fixtures/live-catalog.py create (a running local cinna-core)'
    return
  }
  let issuer: unknown
  try {
    const response = await fetch(`${fixture.server}/mcp/oauth/.well-known/oauth-authorization-server`)
    issuer = ((await response.json()) as { issuer?: unknown }).issuer
  } catch (err) {
    unavailable = `cinna-core at ${fixture.server} is unreachable (${String(err)})`
    return
  }
  if (issuer !== ISSUER) {
    unavailable = `core advertises the MCP issuer ${JSON.stringify(issuer)}, not ${ISSUER}: run \`make mcp-set-url URL=http://localhost:8000\` in $CINNA_CORE_PATH for this spec (and \`make mcp-set-url\` afterwards)`
  }
})

/** A's REST call against core. */
async function asA(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${fixture!.server}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${fixture!.people.a.token}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const text = await response.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // keep the text
  }
  return { status: response.status, body }
}

/** Every URL main asked the OS to open since this launch began; throws when the recorder is not in place. */
async function openedUrls(cinna: CinnaApp): Promise<string[]> {
  const seen = await cinna.electronApp.evaluate(() => {
    const globals = globalThis as unknown as { __cinnaOpenedUrls?: string[]; __cinnaOpenExternalRecorded?: boolean }
    return globals.__cinnaOpenExternalRecorded ? [...(globals.__cinnaOpenedUrls ?? [])] : null
  })
  if (seen === null) throw new Error('openExternalRecorder.cjs is not loaded in main: a sign-in would open a real browser')
  return seen
}

/**
 * The connector's stored OAuth tokens, decrypted, or with `write` the record
 * replaced — straight on the sandbox DB in main, with the app's own
 * `safeStorage` (the mock keychain the fixture launches with). There is no IPC
 * for either, and only main may decrypt.
 */
function storedTokens(cinna: CinnaApp, providerId: string, write?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return cinna.electronApp.evaluate(async ({ app, safeStorage }, row) => {
    if (app.getPath('userData') !== row.userData) throw new Error('Not the isolated test profile')
    const sealed = row.write ? await safeStorage.encryptStringAsync(JSON.stringify(row.write)) : null
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${row.userData}/cinna.db`, { fileMustExist: true })
    let enc: Buffer | null = null
    try {
      if (sealed) {
        const changed = db.prepare('UPDATE mcp_providers SET auth_tokens_enc = ? WHERE id = ?')
          .run(sealed, row.providerId).changes
        if (changed !== 1) throw new Error(`no provider row ${row.providerId}`)
      }
      const found = db.prepare('SELECT auth_tokens_enc AS enc FROM mcp_providers WHERE id = ?').get(row.providerId) as { enc: Buffer | null } | undefined
      enc = found?.enc ? Buffer.from(found.enc) : null
    } finally {
      db.close()
    }
    return enc ? JSON.parse((await safeStorage.decryptStringAsync(enc)).result) as Record<string, unknown> : null
  }, { userData: cinna.sandbox.userData, providerId, write: write ?? null })
}

async function openMcpSettings(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'MCP Providers', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MCP Providers', exact: true })).toBeVisible()
}

function card(cinna: CinnaApp, name: string): Locator {
  return cinna.page.getByText(name, { exact: true }).locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]')
}

/** The connector's card reads connected and, opened, lists core's two tools. */
async function expectConnectedCard(cinna: CinnaApp, name: string): Promise<void> {
  const row = card(cinna, name)
  await expect(row.getByRole('img', { name: 'Connected', exact: true })).toBeVisible({ timeout: 30_000 })
  if ((await row.getByRole('button', { expanded: false }).count()) > 0) await row.getByRole('button', { expanded: false }).click()
  await expect(row.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
  await expect(row.getByText('2 tools', { exact: true })).toBeVisible()
  for (const tool of TOOLS) await expect(row.getByText(tool, { exact: true })).toBeVisible()
}

async function providerState(cinna: CinnaApp, id: string): Promise<{ status: string; tools: string[]; hasAuth: boolean } | undefined> {
  const found = (await cinna.page.evaluate(() => window.api.mcp.list())).find((p) => p.id === id)
  return found && { status: found.status, tools: found.tools.map((t) => t.name).sort(), hasAuth: found.hasAuth }
}

/** Restart, and wait until the startup connect has the connector connected with core's tools, then show its card. */
async function restartConnected(cinna: CinnaApp, providerId: string, name: string): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await expect.poll(() => providerState(cinna, providerId), { timeout: 30_000 }).toEqual({ status: 'connected', tools: TOOLS, hasAuth: true })
  await openMcpSettings(cinna)
  await expectConnectedCard(cinna, name)
}

test('a real cinna-core MCP OAuth connector signs in once and stays signed in across restarts, issuer-less tokens included', async ({ cinna }) => {
  test.skip(unavailable !== null, unavailable ?? '')
  test.setTimeout(240_000)
  const a = fixture!.people.a
  const marker = `mcp-oauth-e2e ${Date.now().toString(36)}`
  const name = `Core MCP ${marker}`
  let createdAgentId: string | null = null
  let agentId: string | null = null
  let connectorId: string | null = null
  let browser: Browser | null = null
  try {
    await test.step('as A, core gets an MCP connector on an agent A owns, allowed for A', async () => {
      const own = fixture!.cloud?.agentId
      if (own && (await asA(`/agents/${own}`)).status === 200) agentId = own
      else {
        const made = await asA('/agents/', { method: 'POST', body: { name: `MCP OAuth e2e ${marker}` } })
        expect(made.status, JSON.stringify(made.body)).toBe(200)
        createdAgentId = agentId = made.body.id as string
      }
      const created = await asA(`/agents/${agentId}/mcp-connectors`, {
        method: 'POST',
        body: { name: `${marker} connector`, mode: 'conversation', allowed_user_ids: [a.id] }
      })
      expect(created.status, JSON.stringify(created.body)).toBe(200)
      connectorId = created.body.id as string
      expect(created.body.mcp_server_url).toBe(`${fixture!.server}/mcp/${connectorId}/mcp`)
    })
    const serverUrl = `${fixture!.server}/mcp/${connectorId}/mcp`

    expect(await openedUrls(cinna)).toEqual([])
    await cinna.skipOnboarding()
    await openMcpSettings(cinna)
    let authorizeUrl = ''
    await test.step('Settings → MCP Providers adds it as a remote OAuth connector; Connect asks for one browser sign-in', async () => {
      const page = cinna.page
      await page.getByRole('button', { name: 'Add Custom MCP', exact: true }).click()
      const form = page.getByText('Add Custom MCP Server', { exact: true }).locator('..')
      await form.getByPlaceholder('e.g., My MCP Server').fill(name)
      await form.getByPlaceholder('https://mcp.example.com').fill(serverUrl)
      await form.getByRole('button', { name: 'OAuth', exact: true }).click()
      await expect(form.getByText('If the server requires authentication, you will be redirected to authorize in your browser.', { exact: true })).toBeVisible()
      await form.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect.poll(() => openedUrls(cinna), { timeout: 30_000, message: 'the app never asked to open an authorization URL' }).toHaveLength(1)
      authorizeUrl = (await openedUrls(cinna))[0]
      const url = new URL(authorizeUrl)
      expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/authorize`)
      expect(url.searchParams.get('resource')).toBe(serverUrl)
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
      await expect(card(cinna, name).getByRole('img', { name: 'Waiting for authorization in your browser', exact: true })).toBeVisible()
    })

    await test.step('A authorizes on core’s consent page; the loopback callback finishes the sign-in', async () => {
      browser = await chromium.launch()
      const context = await browser.newContext()
      await context.addInitScript((token) => window.localStorage.setItem('access_token', token), a.token)
      const web = await context.newPage()
      await web.goto(authorizeUrl)
      await expect(web.getByText('Authorize Access', { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(web.getByText(`${marker} connector`, { exact: true })).toBeVisible()
      await expect(web.getByText('Cinna Desktop', { exact: true })).toBeVisible()
      await web.getByRole('button', { name: 'Authorize', exact: true }).click()
      const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri')!
      await expect(web).toHaveURL((u) => u.toString().startsWith(`${redirect}?`), { timeout: 30_000 })
      await expect(web.getByRole('heading', { name: 'Return to Cinna', exact: true })).toBeVisible()
    })

    const providerId = (await cinna.page.evaluate(() => window.api.mcp.list())).find((p) => p.name === name)!.id
    await test.step('the connector reads connected and lists core’s tools; the stored tokens carry core’s issuer', async () => {
      await expectConnectedCard(cinna, name)
      expect(await providerState(cinna, providerId)).toEqual({ status: 'connected', tools: TOOLS, hasAuth: true })
      expect(await storedTokens(cinna, providerId)).toMatchObject({ issuer: ISSUER, token_type: expect.stringMatching(/^bearer$/i) })
      expect(await openedUrls(cinna)).toHaveLength(1)
    })

    await test.step('after a restart it connects again with no new sign-in', async () => {
      await restartConnected(cinna, providerId, name)
      expect(await openedUrls(cinna)).toEqual([])
    })

    await test.step('tokens stored without an issuer (as before client 2.4) still connect after a restart, with no sign-in', async () => {
      const { issuer, ...legacy } = (await storedTokens(cinna, providerId))!
      expect(issuer).toBe(ISSUER)
      expect(await storedTokens(cinna, providerId, legacy)).toEqual(legacy)
      await restartConnected(cinna, providerId, name)
      expect(await openedUrls(cinna)).toEqual([])
    })

    // The client stamps a missing issuer only when it runs its auth flow — on a
    // 401 — not while the stored access token is still accepted. A pre-2.4
    // record whose access token has expired is the case that reaches it:
    // played here with an access token core does not know, so the server
    // answers 401 and the client must refresh with the stored refresh token.
    await test.step('an issuer-less record whose access token core refuses is refreshed silently and gets core’s issuer stamped', async () => {
      const { issuer: _stamped, ...legacy } = (await storedTokens(cinna, providerId))!
      expect(typeof legacy.refresh_token).toBe('string')
      const refused = { ...legacy, access_token: `e2e-refused-${Date.now().toString(36)}` }
      expect(await storedTokens(cinna, providerId, refused)).toEqual(refused)
      await restartConnected(cinna, providerId, name)
      expect(await openedUrls(cinna)).toEqual([])
      const after = await storedTokens(cinna, providerId)
      expect(after).toMatchObject({ issuer: ISSUER })
      expect(after!.access_token).not.toBe(refused.access_token)
    })
  } finally {
    await (browser as Browser | null)?.close()
    if (connectorId && agentId) {
      const removed = await asA(`/agents/${agentId}/mcp-connectors/${connectorId}`, { method: 'DELETE' })
      expect(removed.status, `delete connector ${connectorId}`).toBe(200)
    }
    if (createdAgentId) {
      const removed = await asA(`/agents/${createdAgentId}`, { method: 'DELETE' })
      expect(removed.status, `delete agent ${createdAgentId}`).toBeLessThan(300)
    }
  }
})
