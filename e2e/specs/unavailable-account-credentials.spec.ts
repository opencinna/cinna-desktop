import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, answerAgentsFolder, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { liveCinnaConfig, preflight, signIn, type LiveCinnaConfig } from '../fixtures/liveCinna'
import { mintDesktopTokens, type SharingPerson, type TeamFixtureBase } from '../fixtures/liveTeamSharing'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'
import type { AgentRootDto, LocalAgentDto } from '../../src/shared/localAgents'

/**
 * Credentials from a Cinna account that cannot supply them now (commit 9e9a12b0,
 * `docs/agents/service_credentials/README.md` "Unavailable accounts"), against the
 * **real** local cinna-core, model-free: the one turn runs on the scripted ACP engine.
 *
 * ```
 * npx electron-vite build
 * set -a; source <file holding the local admin credentials>; set +a
 * CINNA_UNAVAILABLE_ACCOUNT_LIVE=1 CINNA_E2E_SERVER_URL=http://localhost:8000 \
 *   CINNA_E2E_EMAIL="$CINNA_LOCAL_ADMIN_EMAIL" CINNA_E2E_PASSWORD="$CINNA_LOCAL_ADMIN_PASSWORD" \
 *   make e2e-one SPEC=e2e/specs/unavailable-account-credentials.spec.ts
 * ```
 *
 * The `CINNA_E2E_*` account must be a **superuser**, used only to create one
 * throwaway user (`e2e-unavailable-<time>-<hex>@example.com`, full name `Alicia E2E
 * unavailable account (delete me)`, so the app calls it "Alicia") and to delete
 * exactly that id afterwards (`DELETE /users/{id}`, then `GET` must answer 404).
 * Alicia owns one `api_token` credential (`Held fixture <tag>`, Service URI
 * `e2e-held-<tag>`, local use allowed), deleted by id before her; test U5 adds an
 * `openai_compatible` AI credential on a closed loopback port and deletes it by id.
 *
 * Each test: a sandbox profile linked to Alicia with desktop tokens minted through
 * core's real desktop OAuth (`mintDesktopTokens`), kit agents whose manifest
 * declares a slot that credential fills, the credential attached and delivered while
 * she is eligible, then she becomes unavailable (logged out, locked, or signed out
 * through the menu, which deletes the profile) and the agent is looked at from the
 * guest profile. A logout clears her credential cache, so a held slot is matched only
 * by what main recorded for it while she was eligible.
 *
 * Not proven here: Re-authenticate (the current profile's expired session) and a
 * profile rebound to another account (`unknown`), the skill-slot side of held slots,
 * and vault agents.
 */

const enabled = process.env.CINNA_UNAVAILABLE_ACCOUNT_LIVE === '1'
const config = liveCinnaConfig()

const FIRST = 'Alicia'
const SLOT = 'Held API'
const SLOT_KEY = 'HELD_API_API_TOKEN'
const DRAFT = 'Read the held API status for me.'
const REPLY = 'The held API answered.'

interface Person extends SharingPerson { password: string }
interface CoreCredential { id: string; name: string; secret: string; serviceUri: string }
let person: Person | null = null
let credential: CoreCredential | null = null
/** U5's AI credential, kept here so afterAll can delete it by id when the test did not. */
let aiCredentialId: string | null = null

async function api(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${(config as LiveCinnaConfig).serverUrl}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/** A kit agent whose manifest declares `slots` (each `api_token`, one field), seen only after a relaunch. */
async function kitAgent(cinna: CinnaApp, root: AgentRootDto, name: string, slots: { name: string; serviceUri: string }[]): Promise<LocalAgentDto> {
  const agent = await createFolderAgent(cinna, root, name)
  const path = join(agent.path, 'cinna-agent.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.credentials = slots.map((slot) => ({ name: slot.name, type: 'api_token', service_uri: slot.serviceUri, fields: ['api_token'] }))
  writeFileSync(path, JSON.stringify(manifest, null, 2))
  return agent
}

/**
 * Alicia's profile in this sandbox: a local profile turned into her Cinna account with fresh
 * desktop tokens sealed by the app's own safeStorage, made current, with a keyless Ollama
 * Default mode on the scripted engine's `/api/tags` (her turns need a model).
 */
async function aliciaProfile(cinna: CinnaApp, fake: ScriptAcpEngine): Promise<string> {
  const p = person!
  const created = await cinna.page.evaluate((x) => window.api.auth.register({ accountType: 'local', username: x.email, displayName: x.name }), { email: p.email, name: p.name })
  expect(created.success).toBe(true)
  const userId = created.user!.id
  const tokens = await mintDesktopTokens({ server: (config as LiveCinnaConfig).serverUrl } as TeamFixtureBase, p)
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
  }, { ...tokens, userId, server: (config as LiveCinnaConfig).serverUrl, name: p.name, userData: cinna.sandbox.userData })
  expect((await cinna.page.evaluate((id) => window.api.auth.login({ userId: id }), userId)).success).toBe(true)
  await cinna.page.evaluate(async ({ host, model }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Scripted fixture', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
  }, { host: fake.host, model: SCRIPT_MODEL })
  return userId
}

/** Sync Alicia (current) and attach her credential to each agent under her account's group. */
async function attachHeld(cinna: CinnaApp, agents: LocalAgentDto[]): Promise<void> {
  const c = credential!
  const synced = await cinna.page.evaluate(async () => { const u = (await window.api.auth.getCurrent())!; return window.api.serviceCredentials.sync(u.id, u.cinnaServerUrl!) })
  expect(synced.ok).toBe(true)
  for (const agent of agents) {
    const attached = await cinna.page.evaluate(async ({ agentId, ref }) => {
      const options = await window.api.serviceCredentials.attachOptions(agentId)
      if (!options.ok) return options
      const group = options.value.groups.find((g) => g.items.some((item) => item.cloudId === ref))
      return window.api.serviceCredentials.setAttachments(agentId, group?.key ?? 'no-group-holds-the-fixture', [ref])
    }, { agentId: agent.id, ref: c.id })
    expect(attached.ok, JSON.stringify(attached)).toBe(true)
    // Delivered while she is eligible: this is also when main records what the slot is matched by.
    await expect.poll(() => readCredentials(agent)).toContain(c.secret)
  }
}

function readCredentials(agent: LocalAgentDto): string {
  const path = join(agent.path, 'credentials/credentials.json')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * The common arrangement: the scripted engine, `agents` declared, Alicia linked, a relaunch so
 * the composer sees the agents, her credential attached and delivered. Alicia is current after it.
 */
async function arrange(cinna: CinnaApp, fake: ScriptAcpEngine, agents: { name: string; slots: { name: string; serviceUri: string }[] }[]): Promise<{ userId: string; agents: LocalAgentDto[] }> {
  await cinna.skipOnboarding()
  await fake.install(cinna)
  const root = await addAgentRoot(cinna)
  const made: LocalAgentDto[] = []
  for (const a of agents) made.push(await kitAgent(cinna, root, a.name, a.slots))
  const userId = await aliciaProfile(cinna, fake)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.id).toBe(userId)
  await attachHeld(cinna, made)
  return { userId, agents: made }
}

/** Log Alicia out (no menu item does this; the IPC is the app's own `auth:logout`) and hydrate the guest. */
async function logOut(cinna: CinnaApp): Promise<void> {
  await cinna.page.evaluate(() => window.api.auth.logout())
  await cinna.page.reload()
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
  expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.id).toBe('__default__')
}

async function newChatWith(cinna: CinnaApp, agentName: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await cinna.page.getByRole('button', { name: `Start a new chat with ${agentName}` }).click()
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const statusPanel = (cinna: CinnaApp) => cinna.page.getByRole('status', { name: 'Agent status' })

/** The composer panel's rows, exactly: one sentence per row (a row's button label is not its sentence). */
async function expectRows(cinna: CinnaApp, sentences: string[]): Promise<void> {
  const rows = statusPanel(cinna).getByRole('listitem')
  await expect(rows.getByRole('paragraph')).toHaveText(sentences)
  await expect(rows).toHaveCount(sentences.length)
}

/** Everything main hands the renderer about the agent's credentials, as one string. */
const rendererView = (cinna: CinnaApp, agentId: string) => cinna.page.evaluate(async (id) => JSON.stringify([
  await window.api.serviceCredentials.attachments(id),
  await window.api.serviceCredentials.setupState(id),
  await window.api.serviceCredentials.unavailableAccounts(id),
  await window.api.serviceCredentials.attachOptions(id),
  await window.api.localAgents.list()
]), agentId)

test.describe('credentials from an unavailable Cinna account (real cinna-core)', () => {
  test.skip(!enabled || !config, 'set CINNA_UNAVAILABLE_ACCOUNT_LIVE=1 and CINNA_E2E_SERVER_URL / _EMAIL / _PASSWORD (a superuser on a local cinna-core)')
  test.describe.configure({ mode: 'serial' })

  let fake: ScriptAcpEngine
  test.beforeEach(async () => { fake = await scriptAcpEngine() })
  test.afterEach(async () => { await fake.close() })

  test.beforeAll(async () => {
    const live = config as LiveCinnaConfig
    const ready = await preflight(live)
    if (!ready.ok) throw new Error(`live cinna-core not usable: ${ready.reason}`)
    const admin = await signIn(live)
    const tag = `${Date.now()}-${randomBytes(3).toString('hex')}`
    const email = `e2e-unavailable-${tag}@example.com`
    const password = `${randomBytes(18).toString('base64url')}Aa1!`
    const name = `${FIRST} E2E unavailable account (delete me)`
    const created = await api(admin, '/users/', { method: 'POST', body: { email, password, full_name: name, is_active: true, is_superuser: false } })
    if (created.status !== 200) throw new Error(`could not create the throwaway user: HTTP ${created.status}`)
    const token = await signIn({ ...live, email, password })
    person = { id: created.body.id, email, name, token, password }
    const fixture: CoreCredential = { id: '', name: `Held fixture ${tag}`, secret: `held-secret-${randomBytes(6).toString('hex')}`, serviceUri: `e2e-held-${tag}` }
    const made = await api(token, '/credentials/', { method: 'POST', body: {
      name: fixture.name, type: 'api_token', service_uri: fixture.serviceUri, allow_sharing: false, allow_local_use: true,
      credential_data: { api_token_type: 'bearer', api_token: fixture.secret }
    } })
    if (made.status !== 200) throw new Error(`could not create the fixture credential: HTTP ${made.status}`)
    credential = { ...fixture, id: String(made.body.id) }
  })

  test.afterAll(async () => {
    if (!person) return
    const live = config as LiveCinnaConfig
    // Exactly the ids this run created, and nothing else.
    const token = await signIn({ ...live, email: person.email, password: person.password })
    if (aiCredentialId) console.log(`AI credential cleanup: DELETE → ${(await api(token, `/ai-credentials/${aiCredentialId}`, { method: 'DELETE' })).status}`)
    if (credential) console.log(`fixture credential cleanup: DELETE → ${(await api(token, `/credentials/${credential.id}`, { method: 'DELETE' })).status}`)
    const admin = await signIn(live)
    const del = await api(admin, `/users/${person.id}`, { method: 'DELETE' })
    const after = await api(admin, `/users/${person.id}`)
    console.log(`throwaway user cleanup: DELETE /users/<id> → ${del.status}, GET after → ${after.status}`)
    person = null; credential = null; aiCredentialId = null
    expect({ del: del.status, after: after.status }).toEqual({ del: 200, after: 404 })
  })

  test('U1 logged out: every surface names Alicia instead of a missing credential, and Switch carries the draft back to her for a turn that gets the credential', async ({ cinna }) => {
    test.setTimeout(180_000)
    const c = credential!
    const { userId, agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Reader', slots: [{ name: SLOT, serviceUri: c.serviceUri }] }])
    await logOut(cinna)

    await test.step('main holds the slot by what it recorded: her cache is gone and nothing is delivered', async () => {
      const cache = await cinna.page.evaluate((id) => window.api.serviceCredentials.list(id, 'http://localhost:8000'), userId)
      expect(JSON.stringify(cache)).not.toContain(c.id)
      await expect.poll(() => readCredentials(agent)).toBe('')
      const accounts = await cinna.page.evaluate((id) => window.api.serviceCredentials.unavailableAccounts(id), agent.id)
      expect(accounts.ok && accounts.value.accounts.map((a) => [a.name, a.reason, a.credentials, a.host])).toEqual([[person!.name, 'signed_out', 1, 'localhost:8000']])
      const setup = await cinna.page.evaluate((id) => window.api.serviceCredentials.setupState(id), agent.id)
      expect(setup.ok && setup.value.slots.map((s) => [s.name, s.state])).toEqual([[SLOT, 'account_unavailable']])
      expect(setup.ok && setup.value.setupNeeded).toBe(false)
      expect(await rendererView(cinna, agent.id)).not.toContain(c.name)
    })

    await test.step('the guest composer has the account row and no missing-credential row', async () => {
      await newChatWith(cinna, 'Held Reader')
      const panel = statusPanel(cinna)
      await expectRows(cinna, [`${FIRST} is signed out: 1 credential comes from that account.`])
      await expect(panel.getByRole('button', { name: `Switch to ${FIRST}`, exact: true })).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Finish setup' })).toHaveCount(0)
      await expect(panel.getByRole('button', { name: 'Authorize' })).toHaveCount(0)
      await expect(panel).not.toContainText('needs a credential')
      await expect(cinna.page.locator('body')).not.toContainText(c.name)
    })

    await test.step('the agent page: Credentials tab group, .env card and Runs with Secrets name the account, never the credential', async () => {
      const page = cinna.page
      await page.getByRole('button', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: 'Held Reader', exact: true }).first().click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('tab', { name: 'Credentials', exact: true }).click()
      const group = page.getByRole('region', { name: `${person!.name} <${person!.email}> localhost:8000` })
      // The heading is the account (its region's name) and its action; never the credential.
      await expect(group).toHaveCount(1)
      await expect(group.getByRole('button', { name: `Switch to ${FIRST}`, exact: true })).toBeVisible()
      await expect(group.getByRole('listitem')).toHaveText([`Hidden until its account is available`])
      await expect(group.getByRole('img', { name: `${FIRST} is signed out`, exact: true })).toBeVisible()
      await expect(page.getByRole('tabpanel').getByTestId('held-slot-label')).toHaveText(`${FIRST} is signed out`)
      await expect(page.getByRole('region', { name: 'Runs with' }).getByTestId('held-slot-label')).toHaveText(`${FIRST} is signed out`)
      await expect(page.locator('body')).not.toContainText(c.name)
    })

    await test.step('Switch to Alicia with a typed message: her new-chat screen keeps the message and the agent, the row is gone', async () => {
      await newChatWith(cinna, 'Held Reader')
      const page = cinna.page
      const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
      await input.fill(DRAFT)
      await statusPanel(cinna).getByRole('button', { name: `Switch to ${FIRST}`, exact: true }).click()
      await expect(page.getByTitle(person!.name, { exact: true })).toBeVisible()
      expect((await page.evaluate(() => window.api.auth.getCurrent()))?.id).toBe(userId)
      await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveValue(DRAFT)
      await expect(page.getByRole('button', { name: 'Agent "Held Reader" attached as a participant' })).toBeVisible()
      await expect(page.getByText(`${FIRST} is signed out`)).toHaveCount(0)
      await expect.poll(() => readCredentials(agent)).toContain(c.secret)
    })

    await test.step('the next turn runs with the credential in the agent folder', async () => {
      const page = cinna.page
      await page.getByRole('combobox', { name: 'Type a message...', exact: true }).press('Enter')
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(1)
      expect(fake.calls[0].text).toContain(DRAFT)
      // What the agent's process reads while its turn runs.
      expect(readCredentials(agent)).toContain(c.secret)
      fake.calls[0].release(REPLY)
      await expect(page.getByText(REPLY, { exact: true })).toBeVisible()
    })
  })

  test('U2 locked: a password profile not unlocked this session reads "is locked", and Switch asks for its password', async ({ cinna }) => {
    test.setTimeout(180_000)
    const c = credential!
    const { userId, agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Reader', slots: [{ name: SLOT, serviceUri: c.serviceUri }] }])
    const password = `local-${randomBytes(6).toString('hex')}`
    const set = await cinna.page.evaluate(({ id, pw }) => window.api.auth.updateUser({ userId: id, password: pw }), { id: userId, pw: password })
    expect(set.success, set.error).toBe(true)
    // To the guest without logging out, then a new app session: Alicia is locked, not signed out.
    expect((await cinna.page.evaluate(() => window.api.auth.login({ userId: '__default__' }))).success).toBe(true)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.id).toBe('__default__')

    await newChatWith(cinna, 'Held Reader')
    const panel = statusPanel(cinna)
    await expectRows(cinna, [`${FIRST} is locked: 1 credential comes from that account.`])
    await expect(panel).not.toContainText('needs a credential')
    await expect(cinna.page.locator('body')).not.toContainText(c.name)
    await expect.poll(() => readCredentials(agent)).toBe('')
    expect(await rendererView(cinna, agent.id)).not.toContain(c.name)

    const page = cinna.page
    await page.getByRole('combobox', { name: 'Type a message...', exact: true }).fill(DRAFT)
    await panel.getByRole('button', { name: `Switch to ${FIRST}`, exact: true }).click()
    const field = page.getByPlaceholder('Enter password')
    await expect(field).toBeVisible()
    await field.fill(password)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(field).toHaveCount(0)
    await expect(page.getByTitle(person!.name, { exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.api.auth.getCurrent()))?.id).toBe(userId)
    await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveValue(DRAFT)
    await expect(page.getByRole('button', { name: 'Agent "Held Reader" attached as a participant' })).toBeVisible()
    await expect(page.getByText(`${FIRST} is locked`)).toHaveCount(0)
    await expect.poll(() => readCredentials(agent)).toContain(c.secret)
  })

  test('U3 Finish setup on a held slot reads "From Alicia", and what is typed under "Use another credential instead" is never saved once folded', async ({ cinna }) => {
    test.setTimeout(180_000)
    const c = credential!
    const { agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Mixed', slots: [{ name: SLOT, serviceUri: c.serviceUri }, { name: 'Other API', serviceUri: `${c.serviceUri}-other` }] }])
    await logOut(cinna)
    await newChatWith(cinna, 'Held Mixed')
    const page = cinna.page
    const panel = statusPanel(cinna)
    // The other slot is plainly missing, so Finish setup is offered; the account row is beside it.
    await expectRows(cinna, [
      // Names only the missing slot: the held one is the account row's.
      'Add the credentials for Other API by attaching them or configuring credentials/.env.',
      `${FIRST} is signed out: 1 credential comes from that account.`
    ])
    await panel.getByRole('button', { name: 'Finish setup' }).click()
    const dialog = page.getByRole('dialog', { name: 'Finish setting up Held Mixed' })
    const held = dialog.getByTestId(`finish-setup-slot-${SLOT}`)
    // "From" and the account are flex siblings: the gap draws the space their text lacks.
    await expect(held.getByTestId('held-account-line')).toContainText(new RegExp(`^From\\s*${escape(`${person!.name} <${person!.email}> localhost:8000`)}Switch to ${FIRST}`))
    await expect(held).toContainText(`${SLOT}Signed out`)
    await expect(held.getByRole('button', { name: `Switch to ${FIRST}`, exact: true })).toBeVisible()
    await expect(held.getByLabel(SLOT_KEY, { exact: true })).toHaveCount(0)
    await expect(dialog).not.toContainText(c.name)

    const typed = `typed-under-another-${randomBytes(4).toString('hex')}`
    await held.getByRole('button', { name: 'Use another credential instead' }).click()
    await held.getByLabel(SLOT_KEY, { exact: true }).fill(typed)
    await held.getByRole('button', { name: 'Keep the account’s credential' }).click()
    await expect(held.getByLabel(SLOT_KEY, { exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const envPath = join(agent.path, 'credentials/.env')
    const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
    expect(env).not.toContain(typed)
    expect(env).not.toMatch(new RegExp(`^${SLOT_KEY}=.+`, 'm'))

    // Folding dropped it: opened again, the field is empty.
    await panel.getByRole('button', { name: 'Finish setup' }).click()
    await held.getByRole('button', { name: 'Use another credential instead' }).click()
    await expect(held.getByLabel(SLOT_KEY, { exact: true })).toHaveValue('')
    await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expectRows(cinna, [
      'Add the credentials for Other API by attaching them or configuring credentials/.env.',
      `${FIRST} is signed out: 1 credential comes from that account.`
    ])
  })

  test('U4 signed out through the menu (the profile is deleted): the row says Alicia was removed, from what was recorded, and offers Open accounts', async ({ cinna }) => {
    test.setTimeout(180_000)
    const c = credential!
    const { agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Reader', slots: [{ name: SLOT, serviceUri: c.serviceUri }] }])
    const page = cinna.page
    await page.reload()
    await page.getByTitle(person!.name, { exact: true }).click()
    await page.getByRole('button', { name: 'Sign Out', exact: true }).click()
    await expect(page.getByText(`Sign Out — ${person!.name}`)).toBeVisible()
    await page.getByRole('button', { name: 'Sign Out', exact: true }).click()
    await expect(page.getByText(`Sign Out — ${person!.name}`)).toHaveCount(0)
    expect((await page.evaluate(() => window.api.auth.getCurrent()))?.id).toBe('__default__')
    expect((await page.evaluate(() => window.api.auth.listUsers())).some((u) => u.username === person!.email)).toBe(false)

    await newChatWith(cinna, 'Held Reader')
    const panel = statusPanel(cinna)
    await expectRows(cinna, [`${FIRST} was removed: 1 credential came from that account.`])
    await expect(panel).not.toContainText('needs a credential')
    await expect(page.locator('body')).not.toContainText(c.name)
    await expect.poll(() => readCredentials(agent)).toBe('')
    await panel.getByRole('button', { name: 'Open accounts', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'User Accounts' })).toBeVisible()
  })

  test('U5 an AI credential Alicia’s account provisioned: the OpenCode agent’s Runs with and composer name her, not "AI credential needed"', async ({ cinna }) => {
    test.setTimeout(180_000)
    const p = person!
    // A closed loopback port: nothing the managed provider might call leaves this machine.
    const made = await api(p.token, '/ai-credentials/', { method: 'POST', body: {
      name: 'Alicia fixture AI (delete me)', type: 'openai_compatible', api_key: `sk-e2e-${randomBytes(8).toString('hex')}`,
      base_url: 'http://127.0.0.1:9/v1', model: 'fixture-model'
    } })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    aiCredentialId = String(made.body.id)
    try {
      // Her Core credential too: one account, so one row that names both.
      const { agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Runner', slots: [{ name: SLOT, serviceUri: credential!.serviceUri }] }])
      const managedId = `managed:${aiCredentialId}`
      await expect.poll(async () => (await cinna.page.evaluate(() => window.api.providers.list())).some((row) => row.id === managedId), { timeout: 30_000 }).toBe(true)
      const got = await cinna.page.evaluate((id) => window.api.localAgents.get(id), agent.id)
      if (!got.ok) throw new Error(got.message)
      const updated = await cinna.page.evaluate(({ agentId, stamp, credential }) => window.api.localAgents.updateField({
        agentId, update: { field: 'runtime', value: { engine: 'opencode', credential, modelId: null, complexity: null } }, expectedStamp: stamp
      }), { agentId: agent.id, stamp: got.value.stamps['cinna-agent.json']!, credential: managedId })
      expect(updated.ok, JSON.stringify(updated)).toBe(true)
      await logOut(cinna)
      await cinna.page.evaluate(() => window.api.localAgents.rescan())

      const accounts = await cinna.page.evaluate((id) => window.api.serviceCredentials.unavailableAccounts(id), agent.id)
      expect(accounts.ok && accounts.value.accounts.map((a) => [a.name, a.reason, a.credentials, a.aiCredential])).toEqual([[p.name, 'signed_out', 1, true]])

      await newChatWith(cinna, 'Held Runner')
      const panel = statusPanel(cinna)
      await expectRows(cinna, [`${FIRST} is signed out: 1 credential and its AI credential come from that account.`])
      await expect(panel).not.toContainText('No AI credential')

      const page = cinna.page
      await page.getByRole('button', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: 'Held Runner', exact: true }).first().click()
      // The header's badge, then the Runs with panel's status line with the account's action.
      const summary = page.getByRole('group', { name: 'Runtime summary' })
      await expect(summary).toContainText(`${FIRST} is signed out`)
      await expect(summary).not.toContainText('AI credential needed')
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const runsWith = page.getByRole('region', { name: 'Runs with' })
      await expect(runsWith).toContainText(`${FIRST} is signed out`)
      await expect(runsWith.getByRole('button', { name: `Switch to ${FIRST}`, exact: true })).toBeVisible()
      await expect(runsWith).not.toContainText('AI credential needed')
    } finally {
      const token = await signIn({ ...(config as LiveCinnaConfig), email: p.email, password: p.password })
      const del = await api(token, `/ai-credentials/${aiCredentialId}`, { method: 'DELETE' })
      if (del.status === 200) aiCredentialId = null
    }
  })
})
