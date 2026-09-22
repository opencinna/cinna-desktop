import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
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
  await cinna.page.getByRole('button', { name: 'Skip', exact: true }).click()
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
  await expect(page.getByText('UI fixture · ready · ui-fixture', { exact: true })).toBeVisible()
  await page.screenshot({ path: '/tmp/cinna-credentials-agent.png' })
  const path = join(agent.path, 'credentials/credentials.json')
  expect(existsSync(path)).toBe(true)
  await page.getByRole('button', { name: 'Detach', exact: true }).click()
  await expect.poll(() => existsSync(path)).toBe(false)
  const remaining = await page.evaluate(async () => { const user = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.list(user.id, user.cinnaServerUrl ?? null) })
  expect(remaining.ok && remaining.value.items.some(c => c.name === 'UI fixture')).toBe(true)
})

test('Sync Now after switching profiles only contacts the displayed host', async ({ cinna }) => {
  const { createServer } = await import('node:http')
  const hits: string[][] = [[], []]
  const servers = [0, 1].map(index => createServer((req, res) => {
    if (req.url === '/api/v1/external/credentials') hits[index].push(req.url)
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
    await expect(cinna.page.getByText(`Server: ${urls[1]}`, { exact: true })).toBeVisible()
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
