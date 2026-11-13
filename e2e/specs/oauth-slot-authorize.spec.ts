import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerAgentsFolder, expect, test, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * Authorize a missing Google OAuth slot where the gap is shown — the composer's
 * credential row and the Finish setup dialog — against a fake Core on
 * loopback (no browser, no Google, no model).
 *
 * The fake brokers `POST /external/credentials/oauth` as Core does since
 * slot-targeted Authorize: it keeps the body's `service_uri` on the record,
 * answers it back, and reuses the caller's pending record of the same type
 * **and** Service URI. The test plays Google's consent by flipping a record to
 * `ready`, and plays Core's end page by handing main `cinna://oauth-done`
 * through its own `second-instance` listener (the event a link click raises
 * while the app runs; Playwright cannot raise `open-url`).
 *
 * `shell.openExternal` is replaced in main before any click, so the consent
 * URL is recorded and no browser opens.
 */

const GOOGLE_NAMES: Record<string, string> = {
  gmail_oauth: 'Gmail', gmail_oauth_readonly: 'Gmail (read-only)', gdrive_oauth: 'Google Drive', gdrive_oauth_readonly: 'Google Drive (read-only)',
  gcalendar_oauth: 'Google Calendar', gcalendar_oauth_readonly: 'Google Calendar (read-only)', gmeet_oauth: 'Google Meet', gmeet_oauth_readonly: 'Google Meet (read-only)'
}

/** A Google OAuth record on the fake Core: `pending_authorization` until the test plays the consent. */
interface FakeGoogle {
  id: string; type: string; name: string; serviceUri: string | null
  oauthStatus: 'pending_authorization' | 'ready'; revision: string; grantedUserEmail: string | null; accessToken: string
}

/** Lists, materializes and creates Google OAuth records the way Core's `/external/credentials` does. */
async function startFakeGoogleCore() {
  const { createServer } = await import('node:http')
  const google: FakeGoogle[] = []
  const seen = { list: 0, oauthCreate: [] as unknown[] }
  let base = ''
  let seq = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const readBody = (then: (body: Record<string, unknown>) => void): void => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => then(JSON.parse(raw || '{}') as Record<string, unknown>))
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/external/credentials') {
      seen.list++
      return json(200, { items: google.map((g) => ({
        id: g.id, name: g.name, type: g.type, notes: null, service_uri: g.serviceUri, status: g.oauthStatus === 'ready' ? 'complete' : 'incomplete', is_placeholder: false,
        relation: 'owned', category: 'mine', owner_email: null, local_use_allowed: true, revision: g.revision, key_status: null, expires_at: null, agent_api: null,
        oauth_status: g.oauthStatus, granted_user_email: g.oauthStatus === 'ready' ? g.grantedUserEmail : null
      })) })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/external/credentials/oauth') {
      return readBody((body) => {
        seen.oauthCreate.push(body)
        const type = typeof body.type === 'string' ? body.type : ''
        const serviceUri = typeof body.service_uri === 'string' ? body.service_uri : null
        if (!GOOGLE_NAMES[type]) return json(422, { detail: { code: 'unsupported_type', message: 'Not a Google OAuth type.' } })
        let g = google.find((x) => x.type === type && x.serviceUri === serviceUri && x.oauthStatus === 'pending_authorization')
        if (!g) {
          seq++
          g = { id: `9e0f1a2b-0000-4000-8000-0000000000${String(seq).padStart(2, '0')}`, type, name: GOOGLE_NAMES[type], serviceUri, oauthStatus: 'pending_authorization', revision: 'g-rev-1', grantedUserEmail: null, accessToken: `ya29.fake-slot-access-${seq}-token` }
          google.push(g)
        }
        json(201, { credential_id: g.id, authorization_url: `${base}/fake-google/consent?credential=${g.id}`, expires_at: Math.floor(Date.now() / 1000) + 600, service_uri: g.serviceUri })
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/external/credentials/materialize') {
      return readBody((body) => {
        const ids = (body.credential_ids as string[] | undefined) ?? []
        const items: unknown[] = [], refused: unknown[] = []
        for (const id of ids) {
          const g = google.find((x) => x.id === id)
          if (!g) refused.push({ id, reason: 'not_found' })
          else if (g.oauthStatus !== 'ready') refused.push({ id, reason: 'pending_authorization' })
          else items.push({ id, revision: g.revision, service_account_file: null, ssh_key: null, entry: {
            id: g.id, name: g.name, type: g.type, notes: null, service_uri: g.serviceUri, is_placeholder: false,
            credential_data: { access_token: g.accessToken, token_type: 'Bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly', granted_user_email: g.grantedUserEmail }
          } })
        }
        json(200, { items, refused, current_user: null, owner_identity: null })
      })
    }
    json(404, { detail: 'Not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { url: base, google, seen, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) } }
}

/** Registers a profile and seals desktop tokens for `serverUrl` into it with the app's own safeStorage, then activates it. */
async function cinnaProfile(cinna: CinnaApp, serverUrl: string, name: string): Promise<string> {
  const created = await cinna.page.evaluate((n) => window.api.auth.register({ accountType: 'local', username: n, displayName: n }), name)
  expect(created.success).toBe(true)
  const id = created.user!.id
  await cinna.electronApp.evaluate(async ({ app, safeStorage }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const token = `e30.${Buffer.from(JSON.stringify({ sub: input.id })).toString('base64url')}.fixture`
    const accessEnc = await safeStorage.encryptStringAsync(token)
    const refreshEnc = await safeStorage.encryptStringAsync('fixture-refresh')
    const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
    try { db.prepare(`UPDATE users SET type='cinna_user', cinna_server_url=?, cinna_client_id=?, cinna_access_token_enc=?, cinna_refresh_token_enc=?, cinna_token_expires_at=? WHERE id=?`).run(input.url, 'slot-fixture', accessEnc, refreshEnc, Date.now() + 3600_000, input.id) }
    finally { db.close() }
  }, { id, url: serverUrl, userData: cinna.sandbox.userData })
  expect((await cinna.page.evaluate((userId) => window.api.auth.login({ userId }), id)).success).toBe(true)
  return id
}

/** Replaces `shell.openExternal` in main: the consent URL is recorded, no browser opens. */
async function recordBrowser(cinna: CinnaApp): Promise<() => Promise<string[]>> {
  await cinna.electronApp.evaluate(({ shell }) => {
    const globals = globalThis as unknown as { __openedUrls?: string[] }
    globals.__openedUrls = []
    shell.openExternal = async (url: string): Promise<void> => { globals.__openedUrls!.push(url) }
  })
  return () => cinna.electronApp.evaluate(() => [...((globalThis as unknown as { __openedUrls?: string[] }).__openedUrls ?? [])])
}

/** What main prints from now on (stdout and stderr), for the deep link's own log line. */
function mainOutput(cinna: CinnaApp): () => string {
  const chunks: string[] = []
  cinna.electronApp.process().stdout?.on('data', (c) => chunks.push(String(c)))
  cinna.electronApp.process().stderr?.on('data', (c) => chunks.push(String(c)))
  return () => chunks.join('').replace(/\x1b\[[0-9;]*m/g, '')
}

/** A link click while the app runs: the OS starts a second copy, which hands its argv to this one. */
async function deliverLink(cinna: CinnaApp, link: string): Promise<void> {
  await cinna.electronApp.evaluate(({ app }, url) => {
    app.emit('second-instance', { preventDefault() {} }, [process.execPath, url], process.cwd(), {})
  }, link)
}

/**
 * A signed-in profile on the fake Core and a folder agent whose manifest declares `slots`, the app
 * restarted so every surface reads both, the browser recorded.
 */
async function arrange(cinna: CinnaApp, coreUrl: string, agentName: string, slots: { name: string; type: string; service_uri: string }[]) {
  await cinna.skipOnboarding()
  const userId = await cinnaProfile(cinna, coreUrl, 'Google owner')
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, agentName)
  const manifestPath = join(agent.path, 'cinna-agent.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.credentials = slots
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.id).toBe(userId)
  const opened = await recordBrowser(cinna)
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await cinna.page.getByRole('button', { name: agentName, exact: true }).first().click()
  return { agent, opened, userId }
}

const attachedOf = (cinna: CinnaApp, agentId: string) => cinna.page.evaluate(async (id) => {
  const r = await window.api.serviceCredentials.attachments(id)
  return r.ok ? r.value.map((a) => ({ ref: a.ref, state: a.state })) : r.message
}, agentId)

test('composer Authorize sends the slot’s Service URI, waits for the browser, and cinna://oauth-done attaches the record', async ({ cinna }) => {
  const core = await startFakeGoogleCore()
  try {
    const { agent, opened } = await arrange(cinna, core.url, 'Mail reader', [{ name: 'Gmail', type: 'gmail_oauth_readonly', service_uri: 'gmail' }])
    const page = cinna.page
    const panel = page.getByRole('status', { name: 'Agent status' })
    const row = panel.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^(Authorize|Reopen)$/ }) })

    await test.step('the credential row names the service and offers Authorize', async () => {
      await expect(row).toHaveCount(1)
      await expect(row.getByRole('paragraph')).toHaveText('Gmail (read-only) isn’t connected.')
      await expect(row.getByRole('button', { name: 'Authorize', exact: true })).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Finish setup', exact: true })).toHaveCount(0)
    })

    await test.step('Authorize asks Core for a record with the slot’s Service URI and opens the consent page', async () => {
      await row.getByRole('button', { name: 'Authorize', exact: true }).click()
      await expect(row.getByRole('paragraph')).toHaveText('Finish in your browser.')
      await expect(row.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible()
      expect(core.seen.oauthCreate).toEqual([{ type: 'gmail_oauth_readonly', service_uri: 'gmail' }])
      expect(core.google.map((g) => [g.type, g.serviceUri, g.oauthStatus])).toEqual([['gmail_oauth_readonly', 'gmail', 'pending_authorization']])
      const consent = `${core.url}/fake-google/consent?credential=${core.google[0].id}`
      await expect.poll(opened).toEqual([consent])
      await row.getByRole('button', { name: 'Reopen', exact: true }).click()
      await expect.poll(opened).toEqual([consent, consent])
      const flow = await page.evaluate((id) => window.api.serviceCredentials.oauthFlow(id), agent.id)
      expect(flow.ok && flow.value && { state: flow.value.state, slot: flow.value.slot, credentialId: flow.value.credentialId })
        .toEqual({ state: 'waiting', slot: 'Gmail', credentialId: core.google[0].id })
    })

    await test.step('cinna://oauth-done for that record makes main poll Core now', async () => {
      const output = mainOutput(cinna)
      const before = core.seen.list
      // A scheduled poll already in flight takes the nudge's place; deliver again until main says it polled.
      await expect(async () => {
        await deliverLink(cinna, `cinna://oauth-done?credential_id=${core.google[0].id}`)
        await expect.poll(() => output(), { timeout: 1_000 }).toMatch(/\[deep-link\] Google sign-in handed back/)
        await expect.poll(() => output(), { timeout: 1_000 }).toMatch(/Polled Google connects now: the browser came back \{ count: 1 \}/)
      }).toPass({ timeout: 10_000 })
      // Main logs before its request lands: wait for the list read the nudge started.
      await expect.poll(() => core.seen.list).toBeGreaterThan(before)
      // Still pending on Core: the link changed nothing by itself.
      await expect(row.getByRole('paragraph')).toHaveText('Finish in your browser.')
      expect(await attachedOf(cinna, agent.id)).toEqual([])
    })

    await test.step('consent on Core, then the link: the row goes and the record is attached', async () => {
      Object.assign(core.google[0], { oauthStatus: 'ready', revision: 'g-rev-2', grantedUserEmail: 'owner@gmail.example' })
      await deliverLink(cinna, `cinna://oauth-done?credential_id=${core.google[0].id}`)
      await expect(row).toHaveCount(0, { timeout: 10_000 })
      await expect(panel.getByText('Gmail (read-only) isn’t connected.', { exact: true })).toHaveCount(0)
      expect(await attachedOf(cinna, agent.id)).toEqual([{ ref: core.google[0].id, state: 'ready' }])
      const path = join(agent.path, 'credentials/credentials.json')
      const entryOf = () => existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as { id: string; type: string; service_uri: string | null; credential_data: Record<string, unknown> }[]).find((e) => e.id === core.google[0].id)
        : undefined
      await expect.poll(() => entryOf()?.credential_data.access_token).toBe(core.google[0].accessToken)
      expect(entryOf()!.type).toBe('gmail_oauth_readonly')
      expect(entryOf()!.service_uri).toBe('gmail')
    })

    await test.step('the agent’s Credentials tab shows the record attached and ready', async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('tab', { name: 'Credentials', exact: true }).click()
      const attached = page.getByRole('listitem').filter({ has: page.getByTitle('Gmail (read-only)', { exact: true }) })
      await expect(attached).toHaveCount(1)
      await expect(attached.getByRole('img', { name: 'Ready', exact: true })).toBeVisible()
      await expect(attached.getByRole('button', { name: 'Detach Gmail (read-only)', exact: true })).toBeVisible()
    })
  } finally { await core.close() }
})

test('Finish setup with two Google slots: Authorize on one blocks the other until Cancel', async ({ cinna }) => {
  const core = await startFakeGoogleCore()
  try {
    const name = 'Mail and drive'
    const { opened } = await arrange(cinna, core.url, name, [
      { name: 'Gmail', type: 'gmail_oauth_readonly', service_uri: 'gmail' },
      { name: 'Drive', type: 'gdrive_oauth_readonly', service_uri: 'gdrive' }
    ])
    const page = cinna.page
    const panel = page.getByRole('status', { name: 'Agent status' })
    await panel.getByRole('button', { name: 'Finish setup', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `Finish setting up ${name}` })
    await expect(dialog).toBeVisible()
    const gmail = dialog.getByTestId('finish-setup-slot-Gmail').getByTestId('authorize-line')
    const drive = dialog.getByTestId('finish-setup-slot-Drive').getByTestId('authorize-line')

    await test.step('each missing Google slot offers Authorize', async () => {
      for (const line of [gmail, drive]) {
        await expect(line.getByText('Sign in with Google to connect it.', { exact: true })).toBeVisible()
        await expect(line.getByRole('button', { name: 'Authorize', exact: true })).not.toHaveAttribute('aria-disabled')
      }
    })

    await test.step('Authorize on Gmail waits there and blocks Drive', async () => {
      await gmail.getByRole('button', { name: 'Authorize', exact: true }).click()
      await expect(gmail.getByText('Finish in your browser…', { exact: true })).toBeVisible()
      await expect(gmail.getByRole('button', { name: 'Reopen browser', exact: true })).toBeVisible()
      await expect(gmail.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
      expect(core.seen.oauthCreate).toEqual([{ type: 'gmail_oauth_readonly', service_uri: 'gmail' }])
      await expect.poll(opened).toHaveLength(1)

      const blocked = drive.getByRole('button', { name: 'Authorize', exact: true })
      await expect(blocked).toHaveAttribute('aria-disabled', 'true')
      await expect(blocked).toHaveAttribute('title', 'Finish the other Google sign-in first.')
      await expect(drive.getByText('Finish the other Google sign-in first.', { exact: true })).toBeVisible()
      // The click is refused: no second record, no second browser. `force`, as a person's click
      // ignores aria-disabled where Playwright waits for it to clear.
      await blocked.click({ force: true })
      await expect(gmail.getByText('Finish in your browser…', { exact: true })).toBeVisible()
      expect(core.seen.oauthCreate).toHaveLength(1)
      expect(await opened()).toHaveLength(1)
    })

    await test.step('Cancel puts both rows back to Authorize', async () => {
      await gmail.getByRole('button', { name: 'Cancel', exact: true }).click()
      for (const line of [gmail, drive]) {
        await expect(line.getByText('Sign in with Google to connect it.', { exact: true })).toBeVisible()
        await expect(line.getByRole('button', { name: 'Authorize', exact: true })).not.toHaveAttribute('aria-disabled')
      }
      await expect(dialog).toBeVisible()
    })
  } finally { await core.close() }
})
