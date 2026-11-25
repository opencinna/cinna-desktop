import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs'
import { join, sep } from 'node:path'
import { test, expect, answerAgentsFolder, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { approveDesktopAuth, liveCinnaConfig, preflight, signIn, type LiveCinnaConfig } from '../fixtures/liveCinna'
import { mintDesktopTokens, type SharingPerson, type TeamFixtureBase } from '../fixtures/liveTeamSharing'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'
import { writeFakeClaudeCli } from '../fixtures/fakeClaudeCli'
import type { AgentRootDto, LocalAgentDto } from '../../src/shared/localAgents'

/**
 * Credentials from a Cinna account that cannot supply them now (commit 9e9a12b0,
 * `docs/agents/service_credentials/README.md` "Unavailable accounts"), against the
 * **real** local cinna-core, model-free: the one turn runs on the scripted ACP engine.
 *
 * Part of `make e2e` whenever `CINNA_E2E_SERVER_URL` / `_EMAIL` / `_PASSWORD` are set, in the
 * environment or in the repo's `.env` (which `e2e/playwright.config.ts` loads; the environment
 * wins), like the other core-backed specs; without them, or when the server is not usable, every
 * test skips with the reason. One spec:
 *
 * ```
 * npx electron-vite build
 * make e2e-one SPEC=e2e/specs/unavailable-account-credentials.spec.ts
 * ```
 *
 * The `CINNA_E2E_*` account must be a **superuser** (checked first: the tests skip, saying so,
 * when it is not), used only to create one
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
 * she is eligible, then she becomes unavailable and the agent is looked at from the
 * guest profile: signed out through the menu's Sign Out with "Delete data from this
 * device" off (the profile stays, its tokens are cleared), locked, or signed out with
 * the switch on (the profile is deleted). A sign-out clears her credential cache, so a
 * held slot is matched only by what main recorded for it while she was eligible.
 * Switching back to the kept profile opens "Sign in to Cinna"; its Sign in is the real
 * desktop OAuth, with `shell.openExternal` recorded and the browser's approve click
 * done over core's consent API as her (`approveDesktopAuth`).
 *
 * Also: U6 an expired session (core revokes this sandbox's desktop client by id, the stored
 * access token is aged so the app's own refresh is refused and clears her tokens) seen after a
 * restart, with Re-authenticate through the same recorded browser; U6b the same state without a
 * restart (clearing her tokens makes main derive the accounts again at once); U7 the kept profile rebound to another core account
 * (her address moved by the admin to a second throwaway user, then signed in over
 * `auth.register`), whose held slot reads `unknown` and is named only from what was recorded;
 * U8 an own skill's credential slot held the same way; U9 a vault agent on the fake vault backend
 * (`CINNA_VAULT_FAKE=1`, no VM, network for the move's `uv python install`) whose run-secrets copy
 * is withdrawn at the first turn after she signs out.
 *
 * Not proven here: Re-authenticate failing on an identity mismatch, a held Google slot, and a
 * real vault VM.
 */

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
/** Users and credentials a test made beyond Alicia's, deleted by exact id in afterAll (credentials first, as their owner). */
const extraUsers: Person[] = []
const extraCredentials: { id: string; owner: Person }[] = []
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

/** A throwaway core user, made by the admin and recorded for afterAll unless it is Alicia (`track` false). */
async function makePerson(admin: string, input: { first: string; label: string; email: string }, track = true): Promise<Person> {
  const password = `${randomBytes(18).toString('base64url')}Aa1!`
  const name = `${input.first} E2E ${input.label} (delete me)`
  const created = await api(admin, '/users/', { method: 'POST', body: { email: input.email, password, full_name: name, is_active: true, is_superuser: false } })
  if (created.status !== 200) throw new Error(`could not create a throwaway user: HTTP ${created.status}`)
  const made: Person = { id: String(created.body.id), email: input.email, name, token: '', password }
  if (track) extraUsers.push(made)
  made.token = await signIn({ ...(config as LiveCinnaConfig), email: input.email, password })
  return made
}

/** An `api_token` credential `owner` holds, local use allowed, recorded for afterAll unless it is Alicia's. */
async function makeCredential(owner: Person, tag: string, track = true): Promise<CoreCredential> {
  const fixture: CoreCredential = { id: '', name: `Held fixture ${tag}`, secret: `held-secret-${randomBytes(6).toString('hex')}`, serviceUri: `e2e-held-${tag}` }
  const made = await api(owner.token, '/credentials/', { method: 'POST', body: {
    name: fixture.name, type: 'api_token', service_uri: fixture.serviceUri, allow_sharing: false, allow_local_use: true,
    credential_data: { api_token_type: 'bearer', api_token: fixture.secret }
  } })
  if (made.status !== 200) throw new Error(`could not create a fixture credential: HTTP ${made.status}`)
  const out = { ...fixture, id: String(made.body.id) }
  if (track) extraCredentials.push({ id: out.id, owner })
  return out
}

interface AgentSpec {
  name: string
  slots: { name: string; serviceUri: string }[]
  /** Own skills (`skills/<name>/SKILL.md`), each declaring one `api_token` credential slot. */
  skills?: { name: string; slot: string }[]
}

/** A kit agent whose manifest declares `slots` (each `api_token`, one field) and its own `skills`, seen only after a relaunch. */
async function kitAgent(cinna: CinnaApp, root: AgentRootDto, spec: AgentSpec): Promise<LocalAgentDto> {
  const agent = await createFolderAgent(cinna, root, spec.name)
  const path = join(agent.path, 'cinna-agent.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.credentials = spec.slots.map((slot) => ({ name: slot.name, type: 'api_token', service_uri: slot.serviceUri, fields: ['api_token'] }))
  writeFileSync(path, JSON.stringify(manifest, null, 2))
  for (const skill of spec.skills ?? []) {
    mkdirSync(join(agent.path, 'skills', skill.name), { recursive: true })
    writeFileSync(join(agent.path, 'skills', skill.name, 'SKILL.md'), [
      '---', `name: ${skill.name}`, 'description: Reads the held API status.', 'credentials:', `  - slot: ${skill.slot}`, '    type: api_token', '---', '',
      `Call the held API with \`credentials.require_slot("${skill.slot}")\`.`, ''
    ].join('\n'))
  }
  return agent
}

/**
 * Alicia's profile in this sandbox: a local profile turned into her Cinna account with fresh
 * desktop tokens sealed by the app's own safeStorage, made current, with a keyless Ollama
 * Default mode on the scripted engine's `/api/tags` (her turns need a model).
 */
async function aliciaProfile(cinna: CinnaApp, fake: ScriptAcpEngine, p: Person): Promise<{ userId: string; clientId: string }> {
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
  return { userId, clientId: tokens.clientId }
}

/** Sync Alicia (current) and attach her credential to each agent under her account's group. */
async function attachHeld(cinna: CinnaApp, agents: LocalAgentDto[], c: CoreCredential): Promise<void> {
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
async function arrange(
  cinna: CinnaApp, fake: ScriptAcpEngine, agents: AgentSpec[], who: { person: Person; credential: CoreCredential } = { person: person!, credential: credential! }
): Promise<{ userId: string; clientId: string; agents: LocalAgentDto[] }> {
  await cinna.skipOnboarding()
  await fake.install(cinna)
  const root = await addAgentRoot(cinna)
  const made: LocalAgentDto[] = []
  for (const a of agents) made.push(await kitAgent(cinna, root, a))
  const { userId, clientId } = await aliciaProfile(cinna, fake, who.person)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.id).toBe(userId)
  await attachHeld(cinna, made, who.credential)
  return { userId, clientId, agents: made }
}

const currentId = async (cinna: CinnaApp): Promise<string | undefined> => (await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.id

/**
 * The menu's Sign Out (the title button is the profile's full name, then the dialog's own `Sign
 * Out`), with "Delete data from this device" as `deleteData` leaves it: off keeps the profile and
 * clears its tokens (`auth:logout { userId }`), on deletes the profile. Guest is current after it.
 */
async function signOutThroughMenu(cinna: CinnaApp, deleteData: boolean, name = person!.name): Promise<void> {
  const page = cinna.page
  await page.reload()
  await page.getByTitle(name, { exact: true }).click()
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click()
  await expect(page.getByText(`Sign Out — ${name}`, { exact: true })).toBeVisible()
  const toggle = page.getByRole('switch', { name: 'Delete data from this device', exact: true })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  if (!deleteData) {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  }
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click()
  await expect(page.getByText(`Sign Out — ${name}`, { exact: true })).toHaveCount(0)
  await expect.poll(() => currentId(cinna)).toBe('__default__')
}

/** Sign Out with the switch off: the profile stays, signed out, with no tokens. */
async function signOutKeepingData(cinna: CinnaApp, userId: string, name = person!.name): Promise<void> {
  await signOutThroughMenu(cinna, false, name)
  const users = await cinna.page.evaluate(() => window.api.auth.listUsers())
  expect(users.find((u) => u.id === userId)).toMatchObject({ type: 'cinna_user', hasCinnaTokens: false })
}

/**
 * Stand in for the browser of the app's next desktop OAuth: `shell.openExternal` records the
 * authorize URL instead of opening it. Install after the last relaunch (a relaunch drops it).
 */
async function recordBrowser(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ shell }) => {
    const globals = globalThis as unknown as { __authorizeUrl?: string }
    globals.__authorizeUrl = undefined
    shell.openExternal = async (url: string): Promise<void> => { globals.__authorizeUrl = url }
  })
}

/**
 * Her desktop session dies on core while she is current: core revokes exactly this sandbox's client
 * (as she would from Cinna web's device list), the stored access token is aged so the next call
 * refreshes, and core refuses the refresh, so the app clears her tokens. She stays current.
 */
async function revokeSession(cinna: CinnaApp, p: Person, userId: string, clientId: string): Promise<void> {
  expect((await api(p.token, `/desktop-auth/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' })).status).toBe(204)
  await cinna.electronApp.evaluate(({ app }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
    try { db.prepare('UPDATE users SET cinna_token_expires_at = ? WHERE id = ?').run(Date.now() - 1000, input.userId) } finally { db.close() }
  }, { userId, userData: cinna.sandbox.userData })
  // The app's own account sync is the next call: its refresh is refused (HTTP 400/401) and the tokens go.
  await cinna.page.evaluate((u) => window.api.serviceCredentials.sync(u.id, u.url), { id: userId, url: (config as LiveCinnaConfig).serverUrl })
  await expect.poll(async () => (await cinna.page.evaluate(() => window.api.auth.listUsers())).find((u) => u.id === userId)?.hasCinnaTokens).toBe(false)
  expect(await currentId(cinna)).toBe(userId)
}

/** What the user does in that browser: approve the authorization as `who` (core's real consent over the API). */
async function approveInBrowser(cinna: CinnaApp, who: { email: string; password: string }): Promise<void> {
  const url = (): Promise<string> => cinna.electronApp.evaluate(() => (globalThis as unknown as { __authorizeUrl?: string }).__authorizeUrl ?? '')
  await expect.poll(url, { timeout: 30_000, message: 'the app never asked to open an authorization URL' }).not.toBe('')
  await approveDesktopAuth({ ...(config as LiveCinnaConfig), email: who.email, password: who.password }, await url())
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
  test.skip(!config, 'no live cinna-core configured: set CINNA_E2E_SERVER_URL / _EMAIL / _PASSWORD in .env (a superuser on a local cinna-core)')
  test.describe.configure({ mode: 'serial' })

  let fake: ScriptAcpEngine
  test.beforeEach(async () => { fake = await scriptAcpEngine() })
  test.afterEach(async () => { await fake.close() })

  test.beforeAll(async () => {
    const live = config as LiveCinnaConfig
    const ready = await preflight(live)
    test.skip(!ready.ok, ready.ok ? '' : `live cinna-core not usable: ${ready.reason}`)
    const admin = await signIn(live)
    const me = await api(admin, '/users/me')
    test.skip(me.body?.is_superuser !== true, `CINNA_E2E_EMAIL must be a superuser on ${live.serverUrl}: this spec creates a throwaway user and deletes it by id`)
    const tag = `${Date.now()}-${randomBytes(3).toString('hex')}`
    person = await makePerson(admin, { first: FIRST, label: 'unavailable account', email: `e2e-unavailable-${tag}@example.com` }, false)
    credential = await makeCredential(person, tag, false)
  })

  test.afterAll(async () => {
    const live = config as LiveCinnaConfig
    if (extraUsers.length || extraCredentials.length) {
      const admin = await signIn(live)
      for (const c of extraCredentials.splice(0)) {
        // As the owner, by the email core holds for that id now (D2 moves one).
        const held = await api(admin, `/users/${c.owner.id}`)
        const token = held.status === 200 ? await signIn({ ...live, email: held.body.email, password: c.owner.password }).catch(() => null) : null
        console.log(`extra credential cleanup: DELETE → ${token ? (await api(token, `/credentials/${c.id}`, { method: 'DELETE' })).status : `owner HTTP ${held.status}`}`)
      }
      for (const u of extraUsers.splice(0)) {
        const del = await api(admin, `/users/${u.id}`, { method: 'DELETE' })
        console.log(`extra user cleanup: DELETE /users/<id> → ${del.status}, GET after → ${(await api(admin, `/users/${u.id}`)).status}`)
      }
    }
    if (!person) return
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

  test('U1 signed out keeping data: every surface names Alicia instead of a missing credential, and Switch carries the draft back to her, through Sign in to Cinna, for a turn that gets the credential', async ({ cinna }) => {
    test.setTimeout(180_000)
    const c = credential!
    const { userId, agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Reader', slots: [{ name: SLOT, serviceUri: c.serviceUri }] }])
    await signOutKeepingData(cinna, userId)

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

    await test.step('Switch to Alicia with a typed message: her signed-out profile opens "Sign in to Cinna" over the kept message and agent', async () => {
      await newChatWith(cinna, 'Held Reader')
      const page = cinna.page
      const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
      await input.fill(DRAFT)
      await statusPanel(cinna).getByRole('button', { name: `Switch to ${FIRST}`, exact: true }).click()
      await expect(page.getByTitle(person!.name, { exact: true })).toBeVisible()
      await expect.poll(() => currentId(cinna)).toBe(userId)
      await expect(page.getByText('Sign in to Cinna', { exact: true })).toBeVisible()
      await expect(page.getByText('Cinna session expired', { exact: true })).toHaveCount(0)
      await expect(page.getByText(/is signed out on this device\./)).toHaveText(
        `${person!.name} on localhost:8000 is signed out on this device. Sign in again to use this account's agents and credentials.`
      )
      await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveValue(DRAFT)
      await expect(page.getByRole('button', { name: 'Agent "Held Reader" attached as a participant' })).toBeVisible()
      // Her tokens are gone: nothing is delivered until she signs in.
      expect(readCredentials(agent)).toBe('')
    })

    await test.step('Sign in (her browser approves as her): the prompt closes, the row is gone, the credential is delivered', async () => {
      const page = cinna.page
      await recordBrowser(cinna)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await approveInBrowser(cinna, person!)
      await expect(page.getByText('Sign in to Cinna', { exact: true })).toHaveCount(0)
      const users = await page.evaluate(() => window.api.auth.listUsers())
      expect(users.find((u) => u.id === userId)).toMatchObject({ hasCinnaTokens: true })
      await expect.poll(() => currentId(cinna)).toBe(userId)
      await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveValue(DRAFT)
      await expect(statusPanel(cinna).getByText(`${FIRST} is signed out`)).toHaveCount(0)
      await expect(statusPanel(cinna).getByText(`${FIRST}’s session expired`)).toHaveCount(0)
      await expect.poll(() => readCredentials(agent), { timeout: 30_000 }).toContain(c.secret)
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
    const { userId, agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Mixed', slots: [{ name: SLOT, serviceUri: c.serviceUri }, { name: 'Other API', serviceUri: `${c.serviceUri}-other` }] }])
    await signOutKeepingData(cinna, userId)
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
    // The switch left on (its default): the profile is deleted.
    await signOutThroughMenu(cinna, true)
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
      const { userId, agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Runner', slots: [{ name: SLOT, serviceUri: credential!.serviceUri }] }])
      const managedId = `managed:${aiCredentialId}`
      await expect.poll(async () => (await cinna.page.evaluate(() => window.api.providers.list())).some((row) => row.id === managedId), { timeout: 30_000 }).toBe(true)
      const got = await cinna.page.evaluate((id) => window.api.localAgents.get(id), agent.id)
      if (!got.ok) throw new Error(got.message)
      const updated = await cinna.page.evaluate(({ agentId, stamp, credential }) => window.api.localAgents.updateField({
        agentId, update: { field: 'runtime', value: { engine: 'opencode', credential, modelId: null, complexity: null } }, expectedStamp: stamp
      }), { agentId: agent.id, stamp: got.value.stamps['cinna-agent.json']!, credential: managedId })
      expect(updated.ok, JSON.stringify(updated)).toBe(true)
      await signOutKeepingData(cinna, userId)
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

  test('U6 session expired: her desktop session is revoked on core while she is current; after a restart the row offers Re-authenticate, and it brings the credential back', async ({ cinna }) => {
    test.setTimeout(180_000)
    const c = credential!
    const p = person!
    const { userId, clientId, agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Reader', slots: [{ name: SLOT, serviceUri: c.serviceUri }] }])
    await revokeSession(cinna, p, userId, clientId)
    // Main derives the accounts again at start; U6b proves it also does so in the same app session.
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    expect(await currentId(cinna)).toBe(userId)
    const page = cinna.page

    await test.step('the app-level prompt says her session expired; Not now leaves her in her profile', async () => {
      await expect(page.getByText('Cinna session expired', { exact: true })).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Not now', exact: true }).click()
      await expect(page.getByText('Cinna session expired', { exact: true })).toHaveCount(0)
    })

    await test.step('main holds the slot as her expired session, current, and delivers nothing', async () => {
      const accounts = await page.evaluate((id) => window.api.serviceCredentials.unavailableAccounts(id), agent.id)
      expect(accounts.ok && accounts.value.accounts.map((a) => [a.name, a.reason, a.current, a.credentials])).toEqual([[p.name, 'session_expired', true, 1]])
      const setup = await page.evaluate((id) => window.api.serviceCredentials.setupState(id), agent.id)
      expect(setup.ok && setup.value.slots.map((s) => [s.name, s.state])).toEqual([[SLOT, 'account_unavailable']])
      await expect.poll(() => readCredentials(agent)).toBe('')
      expect(await rendererView(cinna, agent.id)).not.toContain(c.name)
    })

    await test.step('her composer: the row says the session expired and offers Re-authenticate, not Switch', async () => {
      await newChatWith(cinna, 'Held Reader')
      const panel = statusPanel(cinna)
      await expectRows(cinna, [`${FIRST}’s session expired: 1 credential comes from that account.`])
      await expect(panel.getByRole('button', { name: 'Re-authenticate', exact: true })).toBeVisible()
      await expect(panel.getByRole('button', { name: `Switch to ${FIRST}`, exact: true })).toHaveCount(0)
      await expect(panel).not.toContainText('needs a credential')
      await expect(page.locator('body')).not.toContainText(c.name)
    })

    await test.step('Re-authenticate (her browser approves as her): new tokens, the row is gone, the credential is delivered', async () => {
      await page.getByRole('combobox', { name: 'Type a message...', exact: true }).fill(DRAFT)
      await recordBrowser(cinna)
      await statusPanel(cinna).getByRole('button', { name: 'Re-authenticate', exact: true }).click()
      await approveInBrowser(cinna, p)
      await expect.poll(async () => (await page.evaluate(() => window.api.auth.listUsers())).find((u) => u.id === userId)?.hasCinnaTokens).toBe(true)
      await expect(statusPanel(cinna).getByText(`${FIRST}’s session expired`)).toHaveCount(0)
      await expect(page.getByText('Cinna session expired', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveValue(DRAFT)
      await expect.poll(() => readCredentials(agent), { timeout: 30_000 }).toContain(c.secret)
    })
  })

  test('U6b session expired in the same app session: once the app has cleared her tokens, the slot is held and the row offers Re-authenticate without a restart', async ({ cinna }) => {
    // Clearing the current profile's tokens after the refused refresh makes main derive the accounts
    // again at once (`onCinnaTokensCleared`): before that, her account stayed eligible until a restart
    // and the composer read "Add the credentials for Held API…" with her secret still delivered.
    test.setTimeout(120_000)
    const c = credential!
    const p = person!
    const { userId, clientId, agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Reader', slots: [{ name: SLOT, serviceUri: c.serviceUri }] }])
    await revokeSession(cinna, p, userId, clientId)
    const page = cinna.page
    await expect(page.getByText('Cinna session expired', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await newChatWith(cinna, 'Held Reader')
    // The same state a restart shows (U6), and the credential's name never reaches the renderer.
    const panel = statusPanel(cinna)
    await expectRows(cinna, [`${FIRST}’s session expired: 1 credential comes from that account.`])
    await expect(panel.getByRole('button', { name: 'Re-authenticate', exact: true })).toBeVisible()
    await expect(panel).not.toContainText('needs a credential')
    await expect.poll(() => readCredentials(agent)).toBe('')
    const setup = await page.evaluate((id) => window.api.serviceCredentials.setupState(id), agent.id)
    expect(setup.ok && setup.value.slots.map((s) => [s.name, s.state])).toEqual([[SLOT, 'account_unavailable']])
    expect(await rendererView(cinna, agent.id)).not.toContain(c.name)
    await expect(page.locator('body')).not.toContainText(c.name)
  })

  test('U7 the profile signs back in as a different Cinna account (same email, another account on core): the held slot is not delivered to it or named for it', async ({ cinna }) => {
    test.setTimeout(180_000)
    const live = config as LiveCinnaConfig
    const admin = await signIn(live)
    const tag = `${Date.now()}-${randomBytes(3).toString('hex')}`
    const email = `e2e-unavailable-rebind-${tag}@example.com`
    const first = await makePerson(admin, { first: FIRST, label: 'rebind old account', email })
    const held = await makeCredential(first, `rebind-${tag}`)
    const { userId, agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Rebound', slots: [{ name: SLOT, serviceUri: held.serviceUri }] }], { person: first, credential: held })
    const page = cinna.page
    await signOutKeepingData(cinna, userId, first.name)

    // Core: her address moves to a second account, so signing in "as her" again is someone else.
    const moved = await api(admin, `/users/${first.id}`, { method: 'PATCH', body: { email: `e2e-unavailable-rebind-${tag}-moved@example.com` } })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    const second = await makePerson(admin, { first: 'Bruno', label: 'rebind new account', email })
    expect(second.id).not.toBe(first.id)

    await test.step('signing in to Cinna with that address rebinds the kept profile to the new account', async () => {
      await recordBrowser(cinna)
      const registering = page.evaluate((serverUrl) => window.api.auth.register({ accountType: 'cinna', cinnaHostingType: 'self_hosted', cinnaServerUrl: serverUrl }), live.serverUrl)
      await approveInBrowser(cinna, second)
      const registered = await registering
      expect(registered.success, JSON.stringify(registered)).toBe(true)
      expect(registered.user?.id).toBe(userId)
      await page.reload()
      await expect.poll(() => currentId(cinna)).toBe(userId)
      await expect(page.getByTitle(second.name, { exact: true })).toBeVisible()
    })

    await test.step('main: the old account is unknown here, named only from what was recorded, and nothing is delivered', async () => {
      const synced = await page.evaluate((u) => window.api.serviceCredentials.sync(u.id, u.url), { id: userId, url: live.serverUrl })
      expect(synced.ok, JSON.stringify(synced)).toBe(true)
      const accounts = await page.evaluate((id) => window.api.serviceCredentials.unavailableAccounts(id), agent.id)
      expect(accounts.ok && accounts.value.accounts.map((a) => [a.name, a.email, a.reason, a.userId, a.current, a.credentials])).toEqual([[first.name, email, 'unknown', null, false, 1]])
      const setup = await page.evaluate((id) => window.api.serviceCredentials.setupState(id), agent.id)
      expect(setup.ok && setup.value.slots.map((s) => [s.name, s.state])).toEqual([[SLOT, 'account_unavailable']])
      // Not under the new account's group: the attachment stays in the old key's group, unnamed, and
      // the new account's group (offered for attaching, as any current account is) does not list it.
      const attachments = await page.evaluate((id) => window.api.serviceCredentials.attachments(id), agent.id)
      expect(attachments.ok && attachments.value.map((a) => [a.ref, a.state, a.credential, a.groupLabel])).toEqual([[held.id, 'account_unavailable', null, 'Signed-out account']])
      const options = await page.evaluate((id) => window.api.serviceCredentials.attachOptions(id), agent.id)
      expect(options.ok && options.value.groups.map((g) => [g.label, g.items.length])).toEqual([['This computer', 0], [second.name, 0]])
      expect(JSON.stringify(options)).not.toContain(held.id)
      expect(JSON.stringify([attachments, accounts, setup])).not.toContain(second.name)
      expect(await rendererView(cinna, agent.id)).not.toContain(held.name)
      await expect.poll(() => readCredentials(agent)).toBe('')
    })

    await test.step('the new account’s composer names the old account, offers Open accounts, and never names the new one', async () => {
      await newChatWith(cinna, 'Held Rebound')
      const panel = statusPanel(cinna)
      await expectRows(cinna, [`${FIRST} isn’t signed in here: 1 credential comes from that account.`])
      await expect(panel.getByRole('button', { name: 'Open accounts', exact: true })).toBeVisible()
      await expect(panel.getByRole('button', { name: /^Switch to/ })).toHaveCount(0)
      await expect(panel).not.toContainText('Bruno')
      await expect(panel).not.toContainText('needs a credential')
      await expect(page.locator('body')).not.toContainText(held.name)
    })
  })

  test('U8 a held skill slot: an own skill’s credential from a signed-out account reads as held, not missing, in Finish setup and the composer', async ({ cinna }) => {
    test.setTimeout(180_000)
    const c = credential!
    const skill = 'held-reader'
    const { userId, agents: [agent] } = await arrange(cinna, fake, [{ name: 'Held Skills', slots: [], skills: [{ name: skill, slot: c.serviceUri }] }])
    const page = cinna.page
    const got = await page.evaluate((id) => window.api.localAgents.get(id), agent.id)
    expect(got.ok && got.value.skills?.find((s) => s.name === skill)?.credentials.map((slot) => [slot.slot, slot.filled])).toEqual([[c.serviceUri, true]])
    await signOutKeepingData(cinna, userId)

    await test.step('main: the skill slot is held by her account, not missing, and nothing is delivered', async () => {
      await page.evaluate(() => window.api.localAgents.rescan())
      const setup = await page.evaluate((id) => window.api.serviceCredentials.setupState(id), agent.id)
      expect(setup.ok && setup.value.skillSlots.map((s) => [s.slot, s.state, s.account?.name ?? null, s.account?.reason ?? null])).toEqual([[c.serviceUri, 'account_unavailable', person!.name, 'signed_out']])
      expect(setup.ok && setup.value.setupNeeded).toBe(false)
      const skills = await page.evaluate((id) => window.api.localAgents.get(id), agent.id)
      expect(skills.ok && skills.value.skills?.find((s) => s.name === skill)?.credentials.map((slot) => [slot.filled, slot.attachment?.state])).toEqual([[false, 'account_unavailable']])
      await expect.poll(() => readCredentials(agent)).toBe('')
      expect(await rendererView(cinna, agent.id)).not.toContain(c.name)
    })

    await test.step('the composer: the account row, and no skill prompt asking for the credential', async () => {
      await newChatWith(cinna, 'Held Skills')
      const panel = statusPanel(cinna)
      await expectRows(cinna, [`${FIRST} is signed out: 1 credential comes from that account.`])
      await expect(panel.getByRole('button', { name: `Switch to ${FIRST}`, exact: true })).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Dismiss skill credential prompt' })).toHaveCount(0)
      await expect(page.locator('body')).not.toContainText(c.name)
    })

    await test.step('Addons → Finish setup: the skill slot says where its credential comes from, not that none fits', async () => {
      await page.getByRole('button', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: 'Held Skills', exact: true }).first().click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('tab', { name: /^Addons/ }).click()
      const row = page.getByRole('tabpanel').getByRole('listitem').filter({ hasText: skill })
      await row.getByRole('button', { name: 'Finish setup', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Finish setting up Held Skills' })
      const held = dialog.getByTestId(`finish-setup-skill-slot-${c.serviceUri}`)
      await expect(held).toContainText(new RegExp(`${escape(c.serviceUri)}\\s*Signed out`))
      await expect(held.getByTestId('held-account-line')).toContainText(new RegExp(`^From\\s*${escape(`${person!.name} <${person!.email}> localhost:8000`)}Switch to ${FIRST}`))
      await expect(held.getByRole('button', { name: `Switch to ${FIRST}`, exact: true })).toBeVisible()
      await expect(held).not.toContainText('None of your credentials fits it')
      await expect(dialog).not.toContainText(c.name)
    })
  })

  test.describe('a vault agent (fake vault backend)', () => {
    test.use({ env: { CINNA_VAULT_FAKE: '1' } })
    const VAULT_AGENT = 'Held Vault'
    const VAULT_REPLY = 'Hello from the held vault.'

    /** Every `credentials.json` under the sandbox outside the agents root: the fake vault's run-secrets copies. */
    function vaultCopies(cinna: CinnaApp): string[] {
      const out: string[] = []
      const walk = (dir: string, depth: number): void => {
        if (depth > 12) return
        let entries: Dirent[]
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const full = join(dir, e.name)
          if (e.isDirectory() && !e.isSymbolicLink()) walk(full, depth + 1)
          else if (e.name === 'credentials.json' && full.includes(`${sep}run-secrets${sep}`)) out.push(full)
        }
      }
      walk(cinna.sandbox.root, 0)
      return out
    }

    test('U9 a vault agent moved in with her credential: once she signs out, the next turn in the vault runs without it', async ({ cinna }) => {
      test.setTimeout(420_000)
      const c = credential!
      const page = (): typeof cinna.page => cinna.page
      await cinna.skipOnboarding()
      const claude = writeFakeClaudeCli(cinna, { models: [{ value: 'default', displayName: 'Default', description: 'fake', supportsAutoMode: true }], reply: VAULT_REPLY })
      await page().evaluate((path) => window.api.settings.set('localAgentsClaudePath', path), claude.path)
      await page().evaluate(() => window.api.localAgents.homeGrant())
      const root = (await page().evaluate(() => window.api.localAgents.rootsList())).find((r) => r.isDefault)
      if (!root) throw new Error('no default agents root after homeGrant')
      const agent = await kitAgent(cinna, root, { name: VAULT_AGENT, slots: [{ name: SLOT, serviceUri: c.serviceUri }] })
      const got = await page().evaluate((id) => window.api.localAgents.get(id), agent.id)
      if (!got.ok) throw new Error(got.message)
      const set = await page().evaluate(({ id, stamp }) => window.api.localAgents.updateField({
        agentId: id, update: { field: 'runtime', value: { engine: 'claude', credential: null, modelId: null, complexity: null } }, expectedStamp: stamp
      } as never), { id: agent.id, stamp: got.value.stamps['cinna-agent.json']! })
      expect(set.ok, JSON.stringify(set)).toBe(true)
      const { userId } = await aliciaProfile(cinna, fake, person!)
      await page().evaluate((path) => window.api.settings.set('localAgentsClaudePath', path), claude.path)
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await page().evaluate(() => window.api.localAgents.rescan())
      expect(await currentId(cinna)).toBe(userId)
      await attachHeld(cinna, [agent], c)

      const started = await page().evaluate((id) => window.api.vault.moveIn(id, { sizeBytes: 10 * 1024 ** 3 }), agent.id)
      expect(started.ok, JSON.stringify(started)).toBe(true)
      await expect.poll(async () => { const a = await page().evaluate((id) => window.api.localAgents.get(id), agent.id); return a.ok ? a.value.vault != null : false }, { timeout: 240_000 }).toBe(true)
      // The credentials step delivered her credential into the vault (vaultd's run-secrets copy).
      const copies = vaultCopies(cinna)
      expect(copies).toHaveLength(1)
      expect(readFileSync(copies[0], 'utf8')).toContain(c.secret)

      await signOutKeepingData(cinna, userId)
      // Vault agents get no account row (docs/agents/service_credentials/README.md, Known limits), so
      // only delivery and naming are asserted here.
      await newChatWith(cinna, VAULT_AGENT)
      await expect(page().getByRole('button', { name: `Agent "${VAULT_AGENT}" attached as a participant` })).toBeVisible()
      await expect(page().locator('body')).not.toContainText(c.name)
      const box = page().getByRole('combobox', { name: 'Type a message...', exact: true })
      await box.fill('Say hello in one word.')
      await box.press('Enter')
      await expect(page().getByText(VAULT_REPLY, { exact: true })).toBeVisible({ timeout: 90_000 })
      // Before that turn the vault got the files again without her credential: the copy is withdrawn.
      expect(vaultCopies(cinna).filter((f) => readFileSync(f, 'utf8').includes(c.secret))).toEqual([])
      expect(vaultCopies(cinna)).toEqual([])
      expect(await rendererView(cinna, agent.id)).not.toContain(c.name)
    })
  })
})
