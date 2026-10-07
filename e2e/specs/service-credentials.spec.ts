import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

async function keychain(cinna: CinnaApp) {
  // Only this disposable Electron process. Never touches the real OS keychain.
  await cinna.electronApp.evaluate(({ safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => true
    safeStorage.encryptString = text => Buffer.from([...Buffer.from(text)].map(b => b ^ 0x95))
    safeStorage.decryptString = bytes => Buffer.from([...bytes].map(b => b ^ 0x95)).toString()
  })
}

test('local credential uses the attachment pipeline and stays out of DTOs', async ({ cinna }) => {
  await cinna.skipOnboarding(); await keychain(cinna)
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Credential reader')
  const result = await cinna.page.evaluate(() => window.api.serviceCredentials.save({ name: 'Fixture token', type: 'api_token', serviceUri: 'fixture', values: { api_token: 'local-e2e-fixture-secret-123' } }))
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(JSON.stringify(result)).not.toContain('local-e2e-fixture-secret')
  const attached = await cinna.page.evaluate(({ id, ref }) => window.api.serviceCredentials.setAttachments(id, 'local', [ref]), { id: agent.id, ref: result.value.id })
  expect(attached.ok).toBe(true)
  const path = join(agent.path, 'credentials/credentials.json')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(path, 'utf8'))[0].credential_data.http_header_value).toBe('Bearer local-e2e-fixture-secret-123')
  const script = execFileSync('python3', ['-c', "from cinna_credentials import require_slot; assert require_slot('fixture')['http_header_value'].startswith('Bearer '); print('OK')"], { env: { ...process.env, PYTHONPATH: join(agent.path, 'scripts'), CINNA_CREDENTIALS_PATH: path }, encoding: 'utf8' })
  expect(script.trim()).toBe('OK')
  await cinna.page.evaluate(id => window.api.serviceCredentials.setAttachments(id, 'local', []), agent.id)
  expect(existsSync(path)).toBe(false)
})

const fixturePath = process.env.CINNA_CREDENTIALS_LIVE_FIXTURE
const liveServerUrl = process.env.CINNA_CREDENTIALS_LIVE_SERVER ?? 'http://localhost:8000'

test('live Core owned and allowed shared credentials rotate, revoke, and isolate accounts', async ({ cinna }) => {
  test.skip(!fixturePath, 'Set CINNA_CREDENTIALS_LIVE_FIXTURE to a disposable local Core fixture')
  test.setTimeout(180_000)
  const fixture = JSON.parse(readFileSync(fixturePath!, 'utf8')) as { credential_id: string; share_id: string; accounts: { user_id: string; email: string; headers: Record<string, string>; desktop: { client_id: string; access_token: string; refresh_token: string } }[] }
  const reset = await fetch(`http://localhost:8000/api/v1/credentials/${fixture.credential_id}`, { method: 'PUT', headers: { ...fixture.accounts[0].headers, 'content-type': 'application/json' }, body: JSON.stringify({ allow_local_use: true, credential_data: { api_token_type: 'bearer', api_token: 'live-delivery-fixture-secret-123' } }) })
  expect(reset.ok).toBe(true)
  await cinna.skipOnboarding(); await keychain(cinna)
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Live credential reader')
  const profileIds: string[] = []
  for (const [i, account] of fixture.accounts.entries()) {
    const profile = await cinna.page.evaluate(name => window.api.auth.register({ accountType: 'local', username: name, displayName: name }), `Credential fixture ${i}`)
    expect(profile.success).toBe(true)
    const id = profile.user!.id; profileIds.push(id)
    await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
      const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(`${app.getPath('userData')}/cinna.db`)
      try { db.prepare(`UPDATE users SET type='cinna_user', cinna_server_url=?, cinna_client_id=?, cinna_access_token_enc=?, cinna_refresh_token_enc=?, cinna_token_expires_at=? WHERE id=?`).run(input.serverUrl, input.desktop.client_id, safeStorage.encryptString(input.desktop.access_token), safeStorage.encryptString(input.desktop.refresh_token), Date.now() + 3600_000, input.id) }
      finally { db.close() }
    }, { id, desktop: account.desktop, serverUrl: liveServerUrl })
    const logged = await cinna.page.evaluate(userId => window.api.auth.login({ userId }), id)
    expect(logged.success).toBe(true)
    await cinna.page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.sync(user.id, user.cinnaServerUrl!) })
    const syncStatus = await cinna.page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.list(user.id, user.cinnaServerUrl ?? null) })
    expect(syncStatus.ok && syncStatus.value.error).toBeNull()
    await cinna.page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.sync(user.id, user.cinnaServerUrl!) })
    const listed = await cinna.page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.list(user.id, user.cinnaServerUrl ?? null) })
    expect(listed.ok && listed.value.error).toBeNull()
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.message)
    const credential = listed.value.items.find(c => c.cloudId === fixture.credential_id)
    expect(credential?.relation).toBe(i === 0 ? 'owned' : 'shared')
    expect(credential?.hasValues).toBe(false)
    // Attach under the current profile's account group: the one holding this profile's cache row.
    const attached = await cinna.page.evaluate(async ({ agentId, ref, rowId }) => {
      const options = await window.api.serviceCredentials.attachOptions(agentId)
      if (!options.ok) return options
      const group = options.value.groups.find(g => g.items.some(item => item.id === rowId))
      return window.api.serviceCredentials.setAttachments(agentId, group?.key ?? 'missing-group', [ref])
    }, { agentId: agent.id, ref: fixture.credential_id, rowId: credential!.id })
    expect(attached.ok).toBe(true)
  }
  const path = join(agent.path, 'credentials/credentials.json')
  expect(readFileSync(path, 'utf8')).toContain('live-delivery-fixture-secret-123')
  const response = await fetch(`http://localhost:8000/api/v1/credentials/${fixture.credential_id}`, { method: 'PUT', headers: { ...fixture.accounts[0].headers, 'content-type': 'application/json' }, body: JSON.stringify({ credential_data: { api_token_type: 'bearer', api_token: 'live-delivery-rotated-fixture-456' } }) })
  expect(response.ok).toBe(true)
  await cinna.page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.sync(user.id, user.cinnaServerUrl!) })
  await expect.poll(() => readFileSync(path, 'utf8').includes('live-delivery-rotated-fixture-456')).toBe(true)
  const revoke = await fetch(`http://localhost:8000/api/v1/credentials/${fixture.credential_id}`, { method: 'PUT', headers: { ...fixture.accounts[0].headers, 'content-type': 'application/json' }, body: JSON.stringify({ allow_local_use: false }) })
  expect(revoke.ok).toBe(true)
  await cinna.page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.sync(user.id, user.cinnaServerUrl!) })
  // Both passwordless profiles are eligible accounts, so the agent holds the record
  // under both. Revoking local use stops the recipient's copy only; the owner's
  // copy keeps delivering, and switching profiles changes nothing.
  const states = () => cinna.page.evaluate(async agentId => {
    const result = await window.api.serviceCredentials.attachments(agentId)
    return result.ok ? result.value.map(v => v.state) : [result.message]
  }, agent.id)
  await expect.poll(async () => (await states()).filter(state => state === 'ready').length).toBe(1)
  expect(readFileSync(path, 'utf8')).toContain('live-delivery-rotated-fixture-456')
  await cinna.page.evaluate(userId => window.api.auth.login({ userId }), profileIds[0])
  await cinna.page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.sync(user.id, user.cinnaServerUrl!) })
  expect(readFileSync(path, 'utf8')).toContain('live-delivery-rotated-fixture-456')
  // IPC seeding bypasses the renderer login hook; reload to hydrate the displayed profile.
  await cinna.page.reload()
  const current = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  await cinna.page.getByTitle(current!.cinnaFullName ?? current!.displayName, { exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Credentials', exact: true }).last().click()
  await expect(cinna.page.getByRole('button', { name: 'Manage on Remote' })).toBeVisible()
  await cinna.page.getByRole('button', { name: 'Sync Now', exact: true }).click()
  await expect(cinna.page.getByRole('button', { name: 'Sync Now', exact: true })).toBeEnabled()
  const finalStatus = await cinna.page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.list(user.id, user.cinnaServerUrl ?? null) })
  expect(finalStatus.ok && finalStatus.value.error).toBeNull()
  await cinna.page.screenshot({ path: '/tmp/cinna-remote-credentials.png' })
  // Logging out of the owner leaves only the recipient's revoked copy: nothing to deliver.
  await cinna.page.evaluate(() => window.api.auth.logout())
  await expect.poll(() => existsSync(path)).toBe(false)
})

test('credential UI creates a local record, attaches it, and detaches without deleting it', async ({ cinna }) => {
  await cinna.skipOnboarding(); await keychain(cinna)
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'UI credential reader')
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Credentials', exact: true }).click()
  await page.getByRole('button', { name: 'Add Credential', exact: true }).click()
  await page.screenshot({ path: '/tmp/cinna-credential-type-picker.png' })
  await page.getByRole('button', { name: /^API token/ }).click()
  await page.getByLabel('Name', { exact: true }).fill('UI fixture')
  await page.getByLabel('API token', { exact: true }).fill('ui-fixture-secret-123')
  await page.getByLabel('Service URI', { exact: true }).fill('ui-fixture')
  await page.getByRole('button', { name: 'About Service URI' }).click()
  await page.screenshot({ path: '/tmp/cinna-credential-form.png' })
  await page.getByRole('button', { name: 'About Service URI' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('UI fixture', { exact: true })).toBeVisible()
  await page.screenshot({ path: '/tmp/cinna-credentials-settings.png' })
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'UI credential reader', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Credentials', exact: true }).click()
  await page.getByRole('button', { name: 'Attach', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Attach credential' })
  await picker.getByRole('region', { name: 'This computer' }).getByRole('button', { name: 'Attach UI fixture', exact: true }).click()
  await expect(picker.getByRole('button', { name: 'UI fixture attached', exact: true })).toBeDisabled()
  await page.screenshot({ path: '/tmp/cinna-credentials-attach-modal.png' })
  await picker.getByRole('button', { name: 'Close', exact: true }).click()
  const attachedLocal = page.getByRole('region', { name: 'This computer' })
  await expect(attachedLocal.getByText('UI fixture', { exact: true })).toBeVisible()
  await expect(attachedLocal.getByRole('img', { name: 'Ready', exact: true })).toBeVisible()
  await expect(attachedLocal.getByText('ui-fixture', { exact: true })).toBeVisible()
  await page.screenshot({ path: '/tmp/cinna-credentials-agent.png' })
  const path = join(agent.path, 'credentials/credentials.json')
  expect(existsSync(path)).toBe(true)
  await page.getByRole('button', { name: 'Detach UI fixture', exact: true }).click()
  await expect.poll(() => existsSync(path)).toBe(false)
  const remaining = await page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.list(user.id, user.cinnaServerUrl ?? null) })
  expect(remaining.ok && remaining.value.items.some(c => c.name === 'UI fixture')).toBe(true)
})

test('Sync Now after switching profiles only contacts the displayed host', async ({ cinna }) => {
  const { createServer } = await import('node:http')
  const hits: string[][] = [[], []]
  const servers = [0, 1].map(index => createServer((req, res) => {
    if (req.url?.split("?")[0] === "/api/v1/external/credentials") hits[index].push(req.url)
    res.writeHead(index === 0 ? 404 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(index === 0 ? { detail: 'Not found' } : { items: [] }))
  }))
  try {
    for (const server of servers) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const urls = servers.map(server => `http://127.0.0.1:${(server.address() as { port: number }).port}`)
    await cinna.skipOnboarding(); await keychain(cinna)
    const profiles: string[] = []
    for (let index = 0; index < urls.length; index++) {
      const created = await cinna.page.evaluate(name => window.api.auth.register({ accountType: 'local', username: name, displayName: name }), `Routing ${index}`)
      expect(created.success).toBe(true)
      const id = created.user!.id; profiles.push(id)
      await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
        const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
        const Database = req('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(`${app.getPath('userData')}/cinna.db`)
        const token = `e30.${Buffer.from(JSON.stringify({ sub: input.id })).toString('base64url')}.fixture`
        try { db.prepare(`UPDATE users SET type='cinna_user', cinna_server_url=?, cinna_client_id=?, cinna_access_token_enc=?, cinna_refresh_token_enc=?, cinna_token_expires_at=? WHERE id=?`).run(input.url, 'routing-fixture', safeStorage.encryptString(token), safeStorage.encryptString('fixture-refresh'), Date.now() + 3600_000, input.id) }
        finally { db.close() }
      }, { id, url: urls[index] })
    }
    await cinna.page.evaluate(id => window.api.auth.login({ userId: id }), profiles[0])
    await cinna.page.reload()
    await cinna.page.getByTitle('Routing 0', { exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Credentials', exact: true }).last().click()
    await expect(cinna.page.getByText('This remote does not support credential sync yet. Update Cinna Core on that server.')).toBeVisible()
    // Use the real profile switcher, including its query-cache reset.
    await cinna.page.getByTitle('Routing 0', { exact: true }).click()
    await cinna.page.getByRole('button', { name: /Routing 1/ }).click()
    await expect(cinna.page.getByRole('link', { name: new URL(urls[1]).host, exact: true })).toBeVisible()
    await expect(cinna.page.getByText('This remote does not support credential sync yet. Update Cinna Core on that server.')).not.toBeVisible()
    const before = hits.map(requests => requests.length)
    await cinna.page.getByRole('button', { name: 'Sync Now', exact: true }).click()
    await expect.poll(() => hits[1].length).toBeGreaterThan(before[1])
    await expect(cinna.page.getByRole('button', { name: 'Sync Now', exact: true })).toBeEnabled()
    expect(hits[0].length).toBe(before[0])
    const stale = await cinna.page.evaluate(({ id, url }) => window.api.serviceCredentials.sync(id, url), { id: profiles[0], url: urls[0] })
    expect(stale.ok).toBe(false)
    expect(hits[0].length).toBe(before[0])
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
})

// ---- Issued Agent API keys (plans/agent-api-issued-keys.md §11) -------------------------------

interface FakeKey {
  id: string; name: string; keyStatus: string; revision: string; token: string; expiresAt: string | null
  producerId: string; slot: string
}

/** A fake Core on node:http that lists and materializes issued Agent API keys and serves the producer's /ping. */
async function startFakeKeyCore(keys: FakeKey[]) {
  const { createServer } = await import('node:http')
  const seen = { list: [] as string[], materialize: [] as string[], pings: [] as { auth: string | undefined; status: number }[] }
  let base = ''
  const entryFor = (k: FakeKey) => ({
    id: k.id, name: k.name, type: 'agent_api', notes: null, service_uri: k.slot, is_placeholder: false,
    credential_data: { base_url: `${base}/api/v1/agent-api/${k.producerId}`, spec_url: `${base}/api/v1/agent-api/${k.producerId}/openapi.json`, token: k.token, label: 'CRM key', producer_agent_id: k.producerId }
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const ping = /^\/api\/v1\/agent-api\/([^/]+)\/ping$/.exec(url.pathname)
    if (req.method === 'GET' && ping) {
      const key = keys.find(k => k.producerId === ping[1] && k.keyStatus === 'active')
      const ok = !!key && req.headers.authorization === `Bearer ${key.token}`
      seen.pings.push({ auth: req.headers.authorization, status: ok ? 200 : 401 })
      return json(ok ? 200 : 401, ok ? { pong: true } : { detail: 'Unauthorized' })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/external/credentials') {
      seen.list.push(url.search)
      return json(200, { items: keys.map(k => ({
        id: k.id, name: k.name, type: 'agent_api', notes: null, service_uri: k.slot, status: 'complete', is_placeholder: false,
        relation: 'owned', owner_email: null, local_use_allowed: true, revision: k.revision, key_status: k.keyStatus, expires_at: k.expiresAt,
        agent_api: { producer_agent_id: k.producerId, producer_name: 'CRM producer', issuer_email: 'ana@example.com', base_url: `${base}/api/v1/agent-api/${k.producerId}`, spec_url: `${base}/api/v1/agent-api/${k.producerId}/openapi.json`, expires_at: k.expiresAt }
      })) })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/external/credentials/materialize') {
      seen.materialize.push(url.search)
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const ids = (JSON.parse(body || '{}') as { credential_ids?: string[] }).credential_ids ?? []
        const items: unknown[] = [], refused: unknown[] = []
        for (const id of ids) {
          const k = keys.find(x => x.id === id)
          if (!k) { refused.push({ id, reason: 'not_found' }); continue }
          if (k.keyStatus === 'active') items.push({ id, revision: k.revision, service_account_file: null, ssh_key: null, entry: entryFor(k) })
          else refused.push({ id, reason: k.keyStatus.startsWith('revoked') ? 'key_revoked' : 'key_paused', key_status: k.keyStatus })
        }
        json(200, { items, refused, current_user: null, owner_identity: null })
      })
      return
    }
    json(404, { detail: 'Not found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { url: base, seen, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

/** Registers a profile, turns it into a cinna_user bound to `serverUrl`, logs in and reloads. */
async function cinnaProfile(cinna: CinnaApp, serverUrl: string, name: string) {
  const created = await cinna.page.evaluate(n => window.api.auth.register({ accountType: 'local', username: n, displayName: n }), name)
  expect(created.success).toBe(true)
  const id = created.user!.id
  await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
    const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${app.getPath('userData')}/cinna.db`)
    const token = `e30.${Buffer.from(JSON.stringify({ sub: input.id })).toString('base64url')}.fixture`
    try { db.prepare(`UPDATE users SET type='cinna_user', cinna_server_url=?, cinna_client_id=?, cinna_access_token_enc=?, cinna_refresh_token_enc=?, cinna_token_expires_at=? WHERE id=?`).run(input.url, 'keys-fixture', safeStorage.encryptString(token), safeStorage.encryptString('fixture-refresh'), Date.now() + 3600_000, input.id) }
    finally { db.close() }
  }, { id, url: serverUrl })
  expect((await cinna.page.evaluate(userId => window.api.auth.login({ userId }), id)).success).toBe(true)
  await cinna.page.reload()
  return id
}

const syncNow = (cinna: CinnaApp, userId: string, url: string) => cinna.page.evaluate(({ userId, url }) => window.api.serviceCredentials.sync(userId, url), { userId, url })

async function openAgentCredentials(cinna: CinnaApp, agentName: string) {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: agentName, exact: true }).first().click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Credentials', exact: true }).click()
}

/** Everything the renderer can read about credentials, as one string. */
const rendererView = (cinna: CinnaApp, userId: string, url: string, agentId: string) => cinna.page.evaluate(async ({ userId, url, agentId }) => JSON.stringify([
  await window.api.serviceCredentials.list(userId, url),
  await window.api.serviceCredentials.attachOptions(agentId),
  await window.api.serviceCredentials.attachments(agentId)
]), { userId, url, agentId })

const helperDefinesSession = () => {
  const bundled = join(process.cwd(), 'resources/cinna-agent-kit/templates/agent/scripts/cinna_credentials.py')
  return existsSync(bundled) && readFileSync(bundled, 'utf8').includes('def agent_api_session')
}

test('issued Agent API key reaches a local agent, rotates and revokes', async ({ cinna }) => {
  const key: FakeKey = { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'CRM API (issued by ana@example.com)', keyStatus: 'active', revision: 'rev-1', token: 'issued-key-token-ONE-123456', expiresAt: null, producerId: '7d1c2a3b-0000-4000-8000-0000000000aa', slot: 'crm-api' }
  const core = await startFakeKeyCore([key])
  try {
    await cinna.skipOnboarding(); await keychain(cinna)
    const userId = await cinnaProfile(cinna, core.url, 'Key recipient')
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, 'Key reader')
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await cinna.page.reload()
    const page = cinna.page
    await openAgentCredentials(cinna, 'Key reader')
    await page.getByRole('button', { name: 'Attach', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Attach credential' })
    const card = picker.getByTestId(`credential-card-${key.id}`)
    await expect(card).toContainText('Agent API key · crm-api')
    // No status glyph on a healthy key; only the ownership glyph.
    await expect(card.getByRole('img', { name: /paused|Revoked|Expired|Unavailable|removed|turned off|Some values|not downloaded/ })).toHaveCount(0)
    await expect(card.getByRole('img', { name: 'Issued to you by ana@example.com' })).toBeVisible()
    await card.getByRole('button', { name: `Attach ${key.name}`, exact: true }).click()
    await expect(picker.getByRole('button', { name: `${key.name} attached`, exact: true })).toBeDisabled()
    await picker.getByRole('button', { name: 'Close', exact: true }).click()
    const row = page.getByRole('list').getByText(key.name, { exact: true })
    await expect(row).toBeVisible()
    await expect(page.getByRole('img', { name: 'Ready', exact: true })).toBeVisible()

    expect(core.seen.list.length).toBeGreaterThan(0)
    expect(core.seen.list.every(q => q === '?include=agent_api_keys')).toBe(true)
    expect(core.seen.materialize.length).toBeGreaterThan(0)
    expect(core.seen.materialize.every(q => q === '?include=agent_api_keys')).toBe(true)

    const path = join(agent.path, 'credentials/credentials.json')
    const readFile = () => JSON.parse(readFileSync(path, 'utf8')) as { id: string; type: string; service_uri: string; unavailable_reason?: string; key_status?: string; credential_data: Record<string, unknown> }[]
    await expect.poll(() => existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const entry = readFile().find(e => e.id === key.id)!
    expect(entry.type).toBe('agent_api')
    expect(entry.service_uri).toBe('crm-api')
    expect(entry.credential_data).toEqual({ base_url: `${core.url}/api/v1/agent-api/${key.producerId}`, spec_url: `${core.url}/api/v1/agent-api/${key.producerId}/openapi.json`, token: key.token, label: 'CRM key', producer_agent_id: key.producerId })
    expect(entry.unavailable_reason).toBeUndefined()

    // Async on purpose: the fake producer lives in this process, so a sync child would block its event loop.
    const callProducer = (): Promise<{ status: number | null; stdout: string; stderr: string }> => new Promise(resolve => {
      execFile('python3', ['-c', "from cinna_credentials import agent_api_session\nr = agent_api_session('crm-api').get('/ping')\nprint(r.status)"], { env: { ...process.env, PYTHONPATH: join(agent.path, 'scripts'), CINNA_CREDENTIALS_PATH: path }, encoding: 'utf8', timeout: 30_000 },
        (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }))
    })
    const withHelper = helperDefinesSession() && readFileSync(join(agent.path, 'scripts/cinna_credentials.py'), 'utf8').includes('def agent_api_session')
    if (!withHelper) test.info().annotations.push({ type: 'note', description: 'bundled kit has no agent_api_session yet: the python call steps were skipped' })
    if (withHelper) {
      const first = await callProducer()
      expect(first.status, first.stderr).toBe(0)
      expect(first.stdout.trim()).toBe('200')
    }

    const seenTokens: string[] = [key.token]
    // Rotation: new revision, new token. One sync.
    key.revision = 'rev-2'; key.token = 'issued-key-token-TWO-654321'; seenTokens.push(key.token)
    expect((await syncNow(cinna, userId, core.url)).ok).toBe(true)
    await expect.poll(() => readFile().find(e => e.id === key.id)?.credential_data.token).toBe(key.token)
    expect(readFileSync(path, 'utf8')).not.toContain('issued-key-token-ONE')
    if (withHelper) expect((await callProducer()).stdout.trim()).toBe('200')
    for (const phase of [await rendererView(cinna, userId, core.url, agent.id)]) for (const t of seenTokens) expect(phase).not.toContain(t)

    // Revocation: terminal status, new revision. No token reaches the file.
    key.keyStatus = 'revoked_by_issuer'; key.revision = 'rev-3'
    expect((await syncNow(cinna, userId, core.url)).ok).toBe(true)
    await expect(page.getByRole('img', { name: /^Revoked by/ })).toBeVisible()
    await expect.poll(() => readFile().find(e => e.id === key.id)?.unavailable_reason).toBe('key_revoked')
    const dead = readFile().find(e => e.id === key.id)!
    expect(dead.key_status).toBe('revoked_by_issuer')
    expect(dead.credential_data.token).toBeUndefined()
    expect(readFileSync(path, 'utf8')).not.toContain('issued-key-token')
    expect(dead.credential_data.base_url).toBe(`${core.url}/api/v1/agent-api/${key.producerId}`)
    if (withHelper) {
      const after = await callProducer()
      expect(after.status).not.toBe(0)
      expect(after.stderr).toContain('key_revoked')
    }
    const view = await rendererView(cinna, userId, core.url, agent.id)
    for (const t of seenTokens) expect(view).not.toContain(t)
    await page.screenshot({ path: '/tmp/cinna-agent-api-key-revoked.png' })
  } finally { await core.close() }
})

test('picker hides a revoked key, shows a paused one with its warning glyph', async ({ cinna }) => {
  const mk = (n: number, name: string, keyStatus: string): FakeKey => ({ id: `a1b2c3d4-0000-4000-8000-00000000010${n}`, name, keyStatus, revision: `rev-${n}`, token: `picker-key-token-${n}-abcdef`, expiresAt: '2027-01-01T00:00:00Z', producerId: `7d1c2a3b-0000-4000-8000-0000000001${n}0`, slot: `svc-${n}` })
  const active = mk(1, 'Active key', 'active'), paused = mk(2, 'Paused key', 'external_access_paused'), revoked = mk(3, 'Revoked key', 'revoked_by_issuer')
  const core = await startFakeKeyCore([active, paused, revoked])
  try {
    await cinna.skipOnboarding(); await keychain(cinna)
    const userId = await cinnaProfile(cinna, core.url, 'Picker recipient')
    const root = await addAgentRoot(cinna)
    await createFolderAgent(cinna, root, 'Picker agent')
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await cinna.page.reload()
    const page = cinna.page
    expect((await syncNow(cinna, userId, core.url)).ok).toBe(true)
    await openAgentCredentials(cinna, 'Picker agent')
    await page.getByRole('button', { name: 'Attach', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Attach credential' })
    await expect(picker.getByTestId(`credential-card-${active.id}`)).toContainText('Agent API key · svc-1')
    const activeCard = picker.getByTestId(`credential-card-${active.id}`)
    await expect(activeCard.getByRole('img', { name: 'Issued to you by ana@example.com' })).toBeVisible()
    await expect(activeCard.getByRole('img', { name: /paused|Revoked|Expired|Unavailable|removed|turned off/ })).toHaveCount(0)
    const pausedCard = picker.getByTestId(`credential-card-${paused.id}`)
    await expect(pausedCard).toContainText('Agent API key · svc-2')
    await expect(pausedCard.getByRole('img', { name: 'External access to CRM producer is paused — works again when its owner resumes it' })).toBeVisible()
    await expect(picker.getByTestId(`credential-card-${revoked.id}`)).toHaveCount(0)
    await expect(picker.getByText('Revoked key', { exact: true })).toHaveCount(0)
    await picker.getByRole('textbox', { name: 'Search credentials' }).fill('Agent API key')
    await expect(picker.getByTestId(`credential-card-${paused.id}`)).toBeVisible()
    await picker.getByRole('textbox', { name: 'Search credentials' }).fill('')
    await page.screenshot({ path: '/tmp/cinna-agent-api-key-picker.png' })
  } finally { await core.close() }
})

// ---- Live Core: issued Agent API key (opt-in) ---------------------------------------------------
// Fixture: e2e/fixtures/live-issued-key.py (`create`, then `core-checks`), run in Core's backend
// container; the recipient is the Desktop account, the producer's owner is the issuer. Needs the
// producer's environment running and a GET /greetings endpoint on its API (override with
// CINNA_ISSUED_KEY_LIVE_PATH). Waits out the real 5-minute rotation overlap.
const issuedKeyFixturePath = process.env.CINNA_ISSUED_KEY_LIVE_FIXTURE
const issuedKeyPath = process.env.CINNA_ISSUED_KEY_LIVE_PATH ?? '/greetings'
const issuedKeyShots = process.env.CINNA_ISSUED_KEY_LIVE_SHOTS ?? '/tmp/issued-keys-live'

test('live Core issued Agent API key reaches a local agent, rotates, pauses, resumes and revokes', async ({ cinna }) => {
  test.skip(!issuedKeyFixturePath, 'Set CINNA_ISSUED_KEY_LIVE_FIXTURE to a fixture from e2e/fixtures/live-issued-key.py')
  test.setTimeout(25 * 60_000)
  type Headers = Record<string, string>
  const fx = JSON.parse(readFileSync(issuedKeyFixturePath!, 'utf8')) as {
    producer_id: string; key_id: string; credential_id: string; base_url: string
    admin: { email: string; headers: Headers }
    recipient: { user_id: string; email: string; headers: Headers; desktop: { client_id: string; access_token: string; refresh_token: string } }
  }
  const core = liveServerUrl
  const log = (description: string) => { test.info().annotations.push({ type: 'live', description }); console.log(`[issued-key live] ${description}`) }
  const api = async (method: string, path: string, headers: Headers, body?: unknown) => {
    const r = await fetch(`${core}/api/v1${path}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await r.text()
    return { status: r.status, text, json: () => JSON.parse(text) }
  }
  const setExternalAccess = (on: boolean) => api('PUT', `/agents/${fx.producer_id}`, fx.admin.headers, { agent_api_external_access_enabled: on })
  const callWith = async (token: string) => (await fetch(`${fx.base_url}${issuedKeyPath}`, { headers: { Authorization: `Bearer ${token}` } })).status
  const reveal = async () => (await api('POST', `/credentials/${fx.credential_id}/agent-api-key/reveal`, fx.recipient.headers)).json().token as string

  const holder = (await api('GET', `/credentials/${fx.credential_id}/agent-api-key`, fx.recipient.headers)).json()
  expect(holder.status, 'fixture key must start active').toBe('active')
  const slot: string = holder.service_uri
  const seenTokens = [await reveal()]
  try {
    // ---- 3. Desktop lists, attaches, materializes, calls ------------------------------------
    await cinna.skipOnboarding(); await keychain(cinna)
    const created = await cinna.page.evaluate(n => window.api.auth.register({ accountType: 'local', username: n, displayName: n }), 'Issued key recipient')
    expect(created.success).toBe(true)
    const userId = created.user!.id
    await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
      const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(`${app.getPath('userData')}/cinna.db`)
      try { db.prepare(`UPDATE users SET type='cinna_user', cinna_server_url=?, cinna_client_id=?, cinna_access_token_enc=?, cinna_refresh_token_enc=?, cinna_token_expires_at=? WHERE id=?`).run(input.serverUrl, input.desktop.client_id, safeStorage.encryptString(input.desktop.access_token), safeStorage.encryptString(input.desktop.refresh_token), Date.now() + 3600_000, input.id) }
      finally { db.close() }
    }, { id: userId, desktop: fx.recipient.desktop, serverUrl: core })
    expect((await cinna.page.evaluate(id => window.api.auth.login({ userId: id }), userId)).success).toBe(true)
    await cinna.page.reload()
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, 'Issued key reader')
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await cinna.page.reload()
    expect((await syncNow(cinna, userId, core)).ok).toBe(true)
    const listed = await cinna.page.evaluate(({ userId, url }) => window.api.serviceCredentials.list(userId, url), { userId, url: core })
    expect(listed.ok && listed.value.error).toBeNull()
    if (!listed.ok) throw new Error(listed.message)
    const item = listed.value.items.find(c => c.cloudId === fx.credential_id)
    expect(item, JSON.stringify(listed.value.items.map(i => [i.cloudId, i.type]))).toBeTruthy()
    log(`desktop list item: ${JSON.stringify({ type: item!.type, relation: item!.relation, serviceUri: item!.serviceUri, keyStatus: (item as { keyStatus?: string }).keyStatus })}`)
    const page = cinna.page
    await openAgentCredentials(cinna, 'Issued key reader')
    await page.getByRole('button', { name: 'Attach', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Attach credential' })
    const card = picker.getByTestId(`credential-card-${fx.credential_id}`)
    await expect(card).toContainText(`Agent API key · ${slot}`)
    await expect(card.getByRole('img', { name: `Issued to you by ${fx.admin.email}` })).toBeVisible()
    await page.screenshot({ path: `${issuedKeyShots}/desktop-01-picker.png` })
    await card.getByRole('button', { name: /^Attach / }).click()
    await expect(picker.getByRole('button', { name: / attached$/ })).toBeDisabled()
    await picker.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('img', { name: 'Ready', exact: true })).toBeVisible()
    await page.screenshot({ path: `${issuedKeyShots}/desktop-02-attached-ready.png` })

    const path = join(agent.path, 'credentials/credentials.json')
    type Entry = { id: string; type: string; service_uri: string; unavailable_reason?: string; key_status?: string; credential_data: Record<string, unknown> }
    const entry = () => existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Entry[]).find(e => e.id === fx.credential_id) : undefined
    await expect.poll(() => entry()?.credential_data.token).toBe(seenTokens[0])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(entry()!.type).toBe('agent_api')
    expect(entry()!.service_uri).toBe(slot)
    expect(entry()!.credential_data.base_url).toBe(fx.base_url)
    log(`materialized entry keys: ${Object.keys(entry()!.credential_data).sort().join(',')}`)
    const helper = readFileSync(join(agent.path, 'scripts/cinna_credentials.py'), 'utf8')
    expect(helper).toContain('def agent_api_session')
    log(`agent helper ${/HELPER_VERSION\s*=\s*"([^"]+)"/.exec(helper)?.[1]}`)
    const callLocal = (): Promise<{ code: number; stdout: string; stderr: string }> => new Promise(resolve => {
      execFile('python3', ['-c', `from cinna_credentials import agent_api_session\nr = agent_api_session(${JSON.stringify(slot)}).get(${JSON.stringify(issuedKeyPath)})\nprint(r.status)`], { env: { ...process.env, PYTHONPATH: join(agent.path, 'scripts'), CINNA_CREDENTIALS_PATH: path }, encoding: 'utf8', timeout: 120_000 },
        (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }))
    })
    const first = await callLocal()
    log(`local agent_api_session call: exit=${first.code} stdout=${first.stdout.trim()}`)
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout.trim()).toBe('200')

    // ---- 4. Recipient rotates; Desktop picks it up on its own poll ---------------------------
    const rotated = (await api('POST', `/credentials/${fx.credential_id}/agent-api-key/rotate`, fx.recipient.headers)).json() as { token: string; previous_valid_until: string }
    const rotatedAt = Date.now()
    seenTokens.push(rotated.token)
    await expect.poll(() => entry()?.credential_data.token, { timeout: 150_000, intervals: [2_000] }).toBe(rotated.token)
    log(`rotation reached the file after ${Math.round((Date.now() - rotatedAt) / 1000)} s (no manual sync)`)
    expect(readFileSync(path, 'utf8')).not.toContain(seenTokens[0])
    expect((await callLocal()).stdout.trim()).toBe('200')
    expect(await callWith(seenTokens[0]), 'old token inside the overlap').toBe(200)
    const overlapEnd = Date.parse(rotated.previous_valid_until.endsWith('Z') || /[+-]\d\d:\d\d$/.test(rotated.previous_valid_until) ? rotated.previous_valid_until : `${rotated.previous_valid_until}Z`)
    log(`previous_valid_until=${rotated.previous_valid_until} (${Math.round((overlapEnd - rotatedAt) / 1000)} s after rotate)`)
    await page.waitForTimeout(Math.max(0, overlapEnd - Date.now() - 20_000))
    expect(await callWith(seenTokens[0]), 'old token 20 s before the overlap ends').toBe(200)
    await page.waitForTimeout(Math.max(0, overlapEnd - Date.now() + 10_000))
    expect(await callWith(seenTokens[0]), 'old token 10 s after the overlap ends').toBe(401)
    expect(await callWith(rotated.token)).toBe(200)

    // ---- 5. Producer pauses external access; resume ------------------------------------------
    expect((await setExternalAccess(false)).status).toBe(200)
    const pausedAt = Date.now()
    await expect.poll(() => entry()?.unavailable_reason, { timeout: 150_000, intervals: [2_000] }).toBe('key_paused')
    log(`pause reached the file after ${Math.round((Date.now() - pausedAt) / 1000)} s; key_status=${entry()!.key_status}`)
    expect(entry()!.credential_data.token).toBeUndefined()
    const pausedCall = await callLocal()
    log(`local call while paused: exit=${pausedCall.code} stderr=${pausedCall.stderr.trim().split('\n').pop()}`)
    expect(pausedCall.code).not.toBe(0)
    expect(pausedCall.stderr).toContain('key_paused')
    expect(await callWith(rotated.token), 'proxy refuses while paused').toBe(401)
    await page.reload(); await openAgentCredentials(cinna, 'Issued key reader')
    await expect(page.getByRole('img', { name: /paused/i }).first()).toBeVisible()
    await page.screenshot({ path: `${issuedKeyShots}/desktop-03-paused.png` })
    expect((await setExternalAccess(true)).status).toBe(200)
    const resumedAt = Date.now()
    await expect.poll(() => entry()?.credential_data.token, { timeout: 150_000, intervals: [2_000] }).toBe(rotated.token)
    log(`resume reached the file after ${Math.round((Date.now() - resumedAt) / 1000)} s`)
    expect(entry()!.unavailable_reason).toBeUndefined()
    expect((await callLocal()).stdout.trim()).toBe('200')
    await page.reload(); await openAgentCredentials(cinna, 'Issued key reader')
    await expect(page.getByRole('img', { name: 'Ready', exact: true })).toBeVisible()
    await page.screenshot({ path: `${issuedKeyShots}/desktop-04-resumed.png` })

    // ---- 6. Issuer revokes ------------------------------------------------------------------
    expect((await api('POST', `/agents/${fx.producer_id}/agent-api/keys/${fx.key_id}/revoke`, fx.admin.headers)).status).toBe(200)
    const revokedAt = Date.now()
    await expect.poll(() => entry()?.unavailable_reason, { timeout: 150_000, intervals: [2_000] }).toBe('key_revoked')
    log(`revoke reached the file after ${Math.round((Date.now() - revokedAt) / 1000)} s`)
    expect(entry()!.key_status).toBe('revoked_by_issuer')
    expect(entry()!.credential_data.token).toBeUndefined()
    expect(readFileSync(path, 'utf8')).not.toContain(rotated.token)
    const revokedCall = await callLocal()
    expect(revokedCall.code).not.toBe(0)
    expect(revokedCall.stderr).toContain('key_revoked')
    expect((await api('POST', `/credentials/${fx.credential_id}/agent-api-key/reveal`, fx.recipient.headers)).status).toBe(409)
    expect(await callWith(rotated.token)).toBe(401)
    await page.reload(); await openAgentCredentials(cinna, 'Issued key reader')
    await expect(page.getByRole('img', { name: /^Revoked by/ })).toBeVisible()
    await page.screenshot({ path: `${issuedKeyShots}/desktop-05-revoked.png` })

    // ---- Token never in renderer data or on disk outside the credentials file ----------------
    const view = await rendererView(cinna, userId, core, agent.id)
    for (const t of seenTokens) expect(view).not.toContain(t)
    const { readdirSync } = await import('node:fs')
    const leaks: string[] = []
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name)
        if (d.isSymbolicLink()) continue
        if (d.isDirectory()) { if (d.name !== 'node_modules') walk(p); continue }
        if (p === path) continue
        try { const s = statSync(p); if (s.size > 50_000_000) continue; const text = readFileSync(p, 'latin1'); for (const t of seenTokens) if (text.includes(t)) leaks.push(p) } catch { /* unreadable */ }
      }
    }
    walk(cinna.sandbox.root)
    log(`sandbox scan for tokens (logs, db, userData, home): ${leaks.length ? leaks.join(', ') : 'none'}`)
    expect(leaks).toEqual([])
  } finally {
    await setExternalAccess(true)
  }
})
