import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser } from '@playwright/test'
import { answerAgentsFolder, expect, test, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { mintDesktopTokens, type SharingPerson, type TeamFixtureBase } from '../fixtures/liveTeamSharing'
import { repoRoot } from '../playwright.config'

/**
 * Authorize a missing Google OAuth slot against the **real** local cinna-core
 * (Google OAuth configured on it), model-free and without Google: the consent
 * page is recorded, never opened, and a fixture script stands in for Google by
 * storing a fake token blob on the record through core's own encryption.
 *
 * Opt-in: `CINNA_OAUTH_SLOT_LIVE=1` and `CINNA_CORE_PATH` (core's checkout; its
 * docker compose stack running, backend :8000, web app :5173). The spec runs
 * `e2e/fixtures/live-oauth-slot.py` in the backend container itself: `create`
 * (one `oauth-slot-e2e-<tag>` person, kept in memory only), `inspect` / `ready`
 * on the credential the Authorize made, and in the end `delete` of that
 * credential and `cleanup` of that person — both by exact id.
 *
 *     npx electron-vite build
 *     CINNA_OAUTH_SLOT_LIVE=1 CINNA_CORE_PATH=../workflow-runner-core make e2e-one SPEC=e2e/specs/live-oauth-slot-authorize.spec.ts
 *
 * `shell.openExternal` is recorded from process start (`openExternalRecorder.cjs`).
 */

const enabled = process.env.CINNA_OAUTH_SLOT_LIVE === '1'
const corePath = (process.env.CINNA_CORE_PATH ?? '').trim()
const SCRIPT = join(repoRoot, 'e2e', 'fixtures', 'live-oauth-slot.py')

test.use({ mainRequire: [join(repoRoot, 'e2e', 'fixtures', 'openExternalRecorder.cjs')] })

interface Fixture { server: string; web: string; tag: string; person: SharingPerson }

/** One command of the fixture script in core's backend container; its last stdout line, parsed. */
function coreScript(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', 'exec', '-T', 'backend', 'python', '-', ...args], { cwd: corePath, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`live-oauth-slot.py ${args[0]} exited ${code}: ${(err || out).slice(-500)}`))
      const last = out.trim().split('\n').pop() ?? ''
      try { resolve(JSON.parse(last)) } catch { reject(new Error(`live-oauth-slot.py ${args[0]} printed no JSON: ${out.slice(-300)}`)) }
    })
    child.stdin.end(readFileSync(SCRIPT))
  })
}

let fixture: Fixture | null = null
let unavailable: string | null = null

test.beforeAll(async () => {
  if (!enabled || !corePath) {
    unavailable = 'Set CINNA_OAUTH_SLOT_LIVE=1 and CINNA_CORE_PATH (a running local cinna-core with Google OAuth configured)'
    return
  }
  if (!existsSync(join(corePath, 'docker-compose.yml'))) {
    unavailable = `CINNA_CORE_PATH has no docker-compose.yml: ${corePath}`
    return
  }
  fixture = await coreScript(['create']) as Fixture
})

test.afterAll(async () => {
  if (fixture) await coreScript(['cleanup', fixture.person.id])
})

/** A profile named by the person's email, signed in to the local core with real desktop tokens, activated. */
async function signIn(cinna: CinnaApp, f: Fixture): Promise<void> {
  const created = await cinna.page.evaluate((p) => window.api.auth.register({ accountType: 'local', username: p.email, displayName: p.name }), f.person)
  expect(created.success).toBe(true)
  const tokens = await mintDesktopTokens({ server: f.server } as TeamFixtureBase, f.person)
  await cinna.electronApp.evaluate(async ({ app, safeStorage }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const accessEnc = await safeStorage.encryptStringAsync(input.accessToken)
    const refreshEnc = await safeStorage.encryptStringAsync(input.refreshToken)
    const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
    try {
      db.prepare(`UPDATE users SET type = 'cinna_user', cinna_server_url = ?, cinna_client_id = ?, cinna_full_name = ?, cinna_hosting_type = 'self_hosted',
        cinna_access_token_enc = ?, cinna_refresh_token_enc = ?, cinna_token_expires_at = ? WHERE id = ?`)
        .run(input.server, input.clientId, input.name, accessEnc, refreshEnc, Date.now() + (input.expiresIn - 60) * 1000, input.userId)
    } finally { db.close() }
  }, { ...tokens, userId: created.user!.id, server: f.server, name: f.person.name, userData: cinna.sandbox.userData })
  expect((await cinna.page.evaluate((userId) => window.api.auth.login({ userId }), created.user!.id)).success).toBe(true)
}

async function openedUrls(cinna: CinnaApp): Promise<string[]> {
  const seen = await cinna.electronApp.evaluate(() => {
    const g = globalThis as unknown as { __cinnaOpenedUrls?: string[]; __cinnaOpenExternalRecorded?: boolean }
    return g.__cinnaOpenExternalRecorded ? [...(g.__cinnaOpenedUrls ?? [])] : null
  })
  if (seen === null) throw new Error('openExternalRecorder.cjs is not loaded in main: Authorize would open a real browser')
  return seen
}

/** The person's own REST call against core, with their web token. */
async function asPerson(f: Fixture, path: string, method = 'GET'): Promise<number> {
  const response = await fetch(`${f.server}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${f.person.token}` } })
  await response.text()
  return response.status
}

test('live: Authorize a Gmail slot creates its record on core, and cinna://oauth-done attaches it once core holds a token', async ({ cinna }) => {
  test.skip(unavailable !== null, unavailable ?? '')
  const f = fixture!
  const AGENT = `Live mail ${f.tag}`
  let credentialId: string | null = null
  try {
    await cinna.skipOnboarding()
    await signIn(cinna, f)
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT)
    const manifestPath = join(agent.path, 'cinna-agent.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.credentials = [{ name: 'Gmail', type: 'gmail_oauth_readonly', service_uri: 'gmail' }]
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.username).toBe(f.person.email)

    const page = cinna.page
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)
    await page.getByRole('button', { name: AGENT, exact: true }).first().click()
    const panel = page.getByRole('status', { name: 'Agent status' })
    const row = panel.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^(Authorize|Reopen)$/ }) })

    await test.step('Authorize: core creates a pending Gmail record with the slot’s Service URI, the consent URL is Google’s', async () => {
      await expect(row.getByRole('paragraph')).toHaveText('Gmail (read-only) isn’t connected.')
      await row.getByRole('button', { name: 'Authorize', exact: true }).click()
      await expect(row.getByRole('paragraph')).toHaveText('Finish in your browser.')
      await expect.poll(() => openedUrls(cinna)).toHaveLength(1)
      const consent = new URL((await openedUrls(cinna))[0])
      expect(consent.origin).toBe('https://accounts.google.com')
      expect(consent.searchParams.get('state')?.startsWith('desktop.')).toBe(true)

      const flow = await page.evaluate((id) => window.api.serviceCredentials.oauthFlow(id), agent.id)
      expect(flow.ok && flow.value?.state).toBe('waiting')
      credentialId = flow.ok ? flow.value?.credentialId ?? null : null
      expect(credentialId).toMatch(/^[0-9a-f-]{36}$/)
      expect(await coreScript(['inspect', credentialId!])).toEqual({
        id: credentialId, type: 'gmail_oauth_readonly', service_uri: 'gmail', owner_email: f.person.email, oauth_status: 'pending_authorization'
      })
    })

    await test.step('core holds a token, the link comes back: the row goes and the record is attached', async () => {
      await coreScript(['ready', credentialId!])
      expect((await coreScript(['inspect', credentialId!])).oauth_status).toBe('ready')
      await cinna.electronApp.evaluate(({ app }, url) => {
        app.emit('second-instance', { preventDefault() {} }, [process.execPath, url], process.cwd(), {})
      }, `cinna://oauth-done?credential_id=${credentialId}`)
      await expect(row).toHaveCount(0, { timeout: 10_000 })
      await expect(panel.getByText('Gmail (read-only) isn’t connected.', { exact: true })).toHaveCount(0)
      const attached = await page.evaluate(async (id) => {
        const r = await window.api.serviceCredentials.attachments(id)
        return r.ok ? r.value.map((a) => ({ ref: a.ref, state: a.state })) : r.message
      }, agent.id)
      expect(attached).toEqual([{ ref: credentialId, state: 'ready' }])
      const path = join(agent.path, 'credentials/credentials.json')
      const entryOf = () => existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as { id: string; type: string; service_uri: string | null; credential_data: Record<string, unknown> }[]).find((e) => e.id === credentialId)
        : undefined
      await expect.poll(() => entryOf()?.credential_data.access_token, { timeout: 10_000 }).toBe(`ya29.e2e-oauth-slot-${credentialId!.slice(0, 8)}`)
      expect(entryOf()!.type).toBe('gmail_oauth_readonly')
      expect(entryOf()!.service_uri).toBe('gmail')
    })

    await test.step('the Credentials tab shows it attached and ready', async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('tab', { name: 'Credentials', exact: true }).click()
      const item = page.getByRole('listitem').filter({ has: page.getByTitle('Gmail (read-only)', { exact: true }) })
      await expect(item).toHaveCount(1)
      await expect(item.getByRole('img', { name: 'Ready', exact: true })).toBeVisible()
    })
  } finally {
    // Exactly the record this test made, by id; `cleanup` in afterAll is the backstop.
    if (credentialId) {
      await coreScript(['delete', credentialId])
      expect(await asPerson(f, `/credentials/${credentialId}`)).toBe(404)
    }
  }
})

test('live: core’s end page for a failed desktop sign-in offers Open Cinna Desktop with the error link', async () => {
  test.skip(unavailable !== null, unavailable ?? '')
  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(`${fixture!.web}/credentials/oauth/callback?state=desktop.x&error=access_denied`)
    const link = page.getByRole('link', { name: 'Open Cinna Desktop', exact: true })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', 'cinna://oauth-done?status=error')
  } finally {
    await browser?.close()
  }
})
