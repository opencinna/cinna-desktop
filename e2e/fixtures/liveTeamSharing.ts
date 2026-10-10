import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect, launch, makeSandbox, type Sandbox } from './app'

/**
 * Team sharing against the **real** local cinna-core, with one app per person.
 *
 * The core state is disposable and made outside the suite by
 * `e2e/fixtures/live-team-sharing.py` (run inside the backend container; see
 * its docstring). `CINNA_SHARING_LIVE_FIXTURE` points at the JSON it printed;
 * without it every spec that uses {@link test} skips.
 *
 * Each person gets their own sandbox (`HOME` + `userData`) and their own app
 * process, side by side. Their profile is a Cinna profile holding **desktop**
 * tokens (core materializes credentials only for `kind=desktop`), minted the
 * way the desktop's own OAuth gets them: PKCE authorize, the consent click done
 * over the API with the person's web token, the code exchanged at the token
 * endpoint. Core's desktop tokens live fifteen minutes and rotate, so a pair is
 * minted per launch rather than stored in the fixture.
 */

export interface SharingPerson {
  id: string
  email: string
  name: string
  /** Web (login) token: for consent and for the spec's own REST calls as this person. */
  token: string
}

export interface SharingFixture {
  server: string
  tag: string
  admin: { id: string; token: string }
  people: Record<'a' | 'b' | 'c', SharingPerson>
  credentials: {
    acme: { id: string; name: string; secret: string; shares: Record<'a' | 'b', string> }
    other: { id: string; name: string; secret: string }
  }
}

export type PersonLabel = 'a' | 'b' | 'c'

const fixturePath = (process.env.CINNA_SHARING_LIVE_FIXTURE ?? '').trim()

export function sharingFixture(): SharingFixture | null {
  if (!fixturePath || !existsSync(fixturePath)) return null
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as SharingFixture
}

/** One authenticated JSON call to core's API. */
export async function coreCall(
  fixture: SharingFixture,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${fixture.server}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
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

/**
 * A fresh desktop token pair for `person`, through core's real desktop OAuth.
 * The redirect URI is a loopback nobody listens on: the consent answer carries
 * the code and client id in `redirect_to`, which is read instead of followed.
 */
export async function mintDesktopTokens(
  fixture: SharingFixture,
  person: SharingPerson
): Promise<{ clientId: string; accessToken: string; refreshToken: string; expiresIn: number }> {
  const b64 = (bytes: Buffer): string => bytes.toString('base64url')
  const verifier = b64(randomBytes(32))
  const challenge = b64(createHash('sha256').update(verifier).digest())
  const redirectUri = 'http://127.0.0.1:45678/oauth/callback'
  const query = new URLSearchParams({
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: b64(randomBytes(8)),
    device_name: 'cinna-e2e',
    platform: process.platform,
    app_version: '0.0.0-e2e'
  })
  const authorize = await fetch(`${fixture.server}/api/v1/desktop-auth/authorize?${query}`, { redirect: 'manual' })
  const location = authorize.headers.get('location')
  const nonce = location ? new URL(location, fixture.server).searchParams.get('request') : null
  if (!nonce) throw new Error(`desktop authorize gave no consent request (HTTP ${authorize.status})`)
  const consent = await coreCall(fixture, person.token, '/desktop-auth/consent', {
    method: 'POST',
    body: { request_nonce: nonce, action: 'approve' }
  })
  if (consent.status !== 200) throw new Error(`desktop consent failed: HTTP ${consent.status}`)
  const callback = new URL(consent.body.redirect_to as string)
  const code = callback.searchParams.get('code')
  const clientId = callback.searchParams.get('client_id')
  if (!code || !clientId) throw new Error('desktop consent redirect carried no code or client id')
  const exchange = await fetch(`${fixture.server}/api/v1/desktop-auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier
    })
  })
  if (!exchange.ok) throw new Error(`desktop token exchange failed: HTTP ${exchange.status}`)
  const tokens = (await exchange.json()) as { access_token: string; refresh_token: string; expires_in: number }
  return { clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresIn: tokens.expires_in }
}

/** One person's app: a sandbox, a launched process, and their Cinna profile. */
export class PersonApp {
  private current: { electronApp: ElectronApplication; page: Page } | null = null
  /** This person's agents home (where Get lands and agents are made). */
  rootPath = ''

  constructor(
    readonly label: PersonLabel,
    readonly person: SharingPerson,
    readonly sandbox: Sandbox,
    private readonly fixture: SharingFixture
  ) {}

  /** The fixture this person came from. */
  get fixtureRef(): SharingFixture {
    return this.fixture
  }

  get page(): Page {
    if (!this.current) throw new Error(`${this.label}'s app is not running`)
    return this.current.page
  }

  get electronApp(): ElectronApplication {
    if (!this.current) throw new Error(`${this.label}'s app is not running`)
    return this.current.electronApp
  }

  async start(): Promise<void> {
    this.current = await launch(this.sandbox)
  }

  async close(): Promise<void> {
    if (this.current) await this.current.electronApp.close()
    this.current = null
  }

  /**
   * Quit and start again; the stored tokens are replaced by a fresh pair first,
   * so a long test never starts an app on a token about to expire.
   */
  async relaunch(): Promise<void> {
    await this.writeTokens()
    await this.close()
    await this.start()
    await this.waitForShell()
    await this.page.evaluate(() => window.api.localAgents.rescan())
  }

  async waitForShell(): Promise<void> {
    const skip = this.page.getByRole('button', { name: 'Skip for now' })
    const shell = this.page.getByRole('button', { name: 'Chats', exact: true })
    await skip.or(shell).first().waitFor()
    if (await skip.isVisible()) await skip.click()
    await shell.waitFor()
  }

  /** Seal a fresh desktop pair into this person's profile row with the app's own safeStorage. */
  async writeTokens(): Promise<void> {
    const tokens = await mintDesktopTokens(this.fixture, this.person)
    const userId = await this.page.evaluate(async (email) => {
      const users = await window.api.auth.listUsers()
      return users.find((u) => u.username === email)?.id ?? null
    }, this.person.email)
    if (!userId) throw new Error(`${this.label} has no profile to write tokens into`)
    await this.electronApp.evaluate(
      ({ app, safeStorage }, input) => {
        if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
        const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
        const Database = req('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
        try {
          db.prepare(
            `UPDATE users SET type = 'cinna_user', cinna_server_url = ?, cinna_client_id = ?, cinna_full_name = ?,
             cinna_hosting_type = 'self_hosted', cinna_access_token_enc = ?, cinna_refresh_token_enc = ?,
             cinna_token_expires_at = ? WHERE id = ?`
          ).run(
            input.server,
            input.clientId,
            input.name,
            safeStorage.encryptString(input.accessToken),
            safeStorage.encryptString(input.refreshToken),
            Date.now() + (input.expiresIn - 60) * 1000,
            input.userId
          )
        } finally {
          db.close()
        }
      },
      { ...tokens, userId, server: this.fixture.server, name: this.person.name, userData: this.sandbox.userData }
    )
  }

  /**
   * First launch: past onboarding, a profile named by the person's email made
   * a Cinna profile with desktop tokens and activated, an agents root, then a
   * restart so every store reads the profile from the start.
   */
  async setUp(): Promise<void> {
    await this.start()
    await this.waitForShell()
    const registered = await this.page.evaluate(
      (p) => window.api.auth.register({ accountType: 'local', username: p.email, displayName: p.name }),
      this.person
    )
    if (!registered.success || !registered.user) throw new Error(`could not register ${this.label}'s profile`)
    await this.writeTokens()
    const logged = await this.page.evaluate((userId) => window.api.auth.login({ userId }), registered.user.id)
    if (!logged.success) throw new Error(`could not activate ${this.label}'s profile`)
    // Same reason as `skipOnboarding`: never let the developer's real `claude`
    // become the Default runtime of a sandbox.
    await this.page.evaluate(() => window.api.settings.set('localAgentsDefaultEngine', 'opencode'))
    // The agents home (`~/Documents/CinnaAgents` under the sandbox HOME):
    // Get lands in its `Local/`, and an added root is not a home.
    await this.page.evaluate(() => window.api.localAgents.homeGrant())
    const roots = await this.page.evaluate(() => window.api.localAgents.rootsList())
    const root = roots.find((r) => r.isDefault)
    if (!root || !root.path.startsWith(this.sandbox.home)) throw new Error(`${this.label} has no agents home in the sandbox`)
    this.rootPath = root.path
    await this.relaunch()
    const current = await this.page.evaluate(() => window.api.auth.getCurrent())
    expect(current?.username).toBe(this.person.email)
    expect(current?.type).toBe('cinna_user')
  }

  /** The first registered agents root's id. */
  async rootId(): Promise<string> {
    const roots = await this.page.evaluate(() => window.api.localAgents.rootsList())
    const root = roots.find((r) => r.path === this.rootPath)
    if (!root) throw new Error(`${this.label} has no agents root`)
    return root.id
  }
}

export interface Team {
  fixture: SharingFixture
  /** Launch (once) and return a person's app, set up and signed in. */
  open(label: PersonLabel): Promise<PersonApp>
}

export const test = base.extend<{ team: Team }>({
  team: async ({}, use, testInfo) => {
    const fixture = sharingFixture()
    test.skip(
      fixture === null,
      'Set CINNA_SHARING_LIVE_FIXTURE to the JSON printed by e2e/fixtures/live-team-sharing.py create (a running local cinna-core)'
    )
    const apps = new Map<PersonLabel, PersonApp>()
    const team: Team = {
      fixture: fixture as SharingFixture,
      async open(label) {
        const existing = apps.get(label)
        if (existing) return existing
        const app = new PersonApp(label, (fixture as SharingFixture).people[label], makeSandbox(), fixture as SharingFixture)
        apps.set(label, app)
        await app.setUp()
        return app
      }
    }
    await use(team)
    const failed = testInfo.status !== testInfo.expectedStatus
    for (const app of apps.values()) {
      // Each person's screen at the moment of failure: error-context.md shows
      // only one window, and rarely the one that matters.
      if (failed) {
        try {
          writeFileSync(testInfo.outputPath(`${app.label}-screen.yaml`), await app.page.locator('body').ariaSnapshot())
          await app.page.screenshot({ path: testInfo.outputPath(`${app.label}-screen.png`) })
        } catch {
          // the app may be gone already
        }
      }
      await app.close().catch(() => {})
      if (testInfo.status === testInfo.expectedStatus) rmSync(app.sandbox.root, { recursive: true, force: true })
      else testInfo.annotations.push({ type: `sandbox ${app.label}`, description: app.sandbox.root })
    }
  }
})

export { expect }

/**
 * Every path ever recorded in a library repository, across all of its history,
 * read from an admin's raw clone (superusers can clone any library repo). Also
 * returns the concatenated content of every version of every file, for a leak
 * scan of secret values.
 */
export function cloneHistory(
  fixture: SharingFixture,
  repoId: string,
  token: string
):
  | {
      status: 'ok'
      paths: string[]
      blobs: string
      authors: string[]
      /** Every version, newest first: full note and every symlink in its tree. */
      commits: { sha: string; message: string; symlinks: string[]; maxBlob: number }[]
    }
  | { status: 'refused'; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cinna-e2e-clone-'))
  try {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${fixture.server}/.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`
    }
    try {
      execFileSync('git', ['clone', '--quiet', '--mirror', `${fixture.server}/git/${repoId}.git`, join(dir, 'r.git')], {
        env,
        stdio: 'pipe'
      })
    } catch (error) {
      const err = error as { stderr?: Buffer }
      return { status: 'refused', output: (err.stderr?.toString() ?? String(error)).replace(/Bearer \S+/g, 'Bearer ***') }
    }
    const git = (...args: string[]): string =>
      execFileSync('git', ['--git-dir', join(dir, 'r.git'), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const paths = [...new Set(git('log', '--all', '--name-only', '--pretty=format:').split('\n').filter(Boolean))].sort()
    const authors = git('log', '--all', '--pretty=format:%an <%ae>').split('\n').filter(Boolean)
    const objects = git('rev-list', '--all', '--objects')
      .split('\n')
      .map((line) => line.split(' ')[0])
      .filter(Boolean)
    let blobs = ''
    for (const sha of objects) {
      if (git('cat-file', '-t', sha).trim() === 'blob') blobs += git('cat-file', '-p', sha) + '\n'
    }
    const commits = git('rev-list', '--all')
      .split('\n')
      .filter(Boolean)
      .map((sha) => {
        const tree = git('ls-tree', '-r', '-l', sha).split('\n').filter(Boolean)
        return {
          sha,
          message: git('log', '-1', '--format=%B', sha).trim(),
          symlinks: tree.filter((line) => line.startsWith('120000 ')).map((line) => line.split('\t')[1]),
          maxBlob: Math.max(0, ...tree.map((line) => Number(line.split(/\s+/)[3]) || 0))
        }
      })
    return { status: 'ok', paths, blobs, authors, commits }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** First twelve hex of sha256: what `check-creds` prints for each value. */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/**
 * `scripts/check_creds.py`: reads both slots the way an agent's script would
 * (`cinna_credentials.get_credential`, required) and prints a hash prefix of
 * each value, never the value. Exits non-zero, with the helper's own
 * sentence, when either is missing.
 */
const CHECK_CREDS = `import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cinna_credentials import CredentialError, get_credential


def short(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:12]


try:
    acme = get_credential("acme", "http_header_value", required=True)
    weather = get_credential("weather", "api_key", required=True)
except CredentialError as error:
    print(f"check-creds failed: {error}")
    sys.exit(1)
print(f"acme={short(acme)} weather={short(weather)}")
`

const CLI_COMMANDS = `commands:
  - name: status
    description: Refresh the agent's self-reported STATUS.md.
    command: python3 scripts/update_status.py --status ok --summary "Ready"
  - name: check-creds
    description: Prove both credentials reach a script, by hash.
    command: python3 scripts/check_creds.py
`

export const ACME_SLOT = { name: 'acme', type: 'api_token', service_uri: 'acme-api', env_prefix: 'ACME_', description: 'The Acme API.' }
export const WEATHER_SLOT = { name: 'weather', type: 'api_token', env_prefix: 'WEATHER_', fields: ['api_key'], description: 'The weather service.' }

export interface AcmeAgent {
  id: string
  name: string
  slug: string
  path: string
  manifestId: string
}

/** A unique agent name per test: core's library slugs are unique server-wide. */
export function agentName(fixture: SharingFixture): string {
  return `Acme reporter ${fixture.tag} ${randomBytes(2).toString('hex')}`
}

/**
 * The test agent, in `app`'s agents home: two credential slots (`acme` by
 * service URI, `weather` from `.env`), a status refresh command, a schedule,
 * `check-creds` and `status` in the catalog, a skill and a knowledge file.
 * Then, as its owner would: `Acme API` attached from the account, and
 * `WEATHER_API_KEY` saved into `credentials/.env`. Ends with a relaunch, so the
 * composer and pickers see the agent.
 */
export async function buildAcmeReporter(
  app: PersonApp,
  fixture: SharingFixture,
  input: { name: string; weatherKey: string; extraSlots?: object[] }
): Promise<AcmeAgent> {
  const rootId = await app.rootId()
  const created = await app.page.evaluate((args) => window.api.localAgents.create(args), {
    rootId,
    name: input.name,
    description: 'Reports on Acme with the weather.'
  })
  const manifestPath = join(created.path, 'cinna-agent.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.credentials = [ACME_SLOT, WEATHER_SLOT, ...(input.extraSlots ?? [])]
  manifest.schedules = [
    { name: 'morning-report', description: 'The morning report.', cron_string: '0 8 * * 1-5', timezone: 'UTC', schedule_type: 'script_trigger', command: '/run:check-creds' }
  ]
  manifest.status_refresh_command = '/run:status'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(created.path, 'scripts/check_creds.py'), CHECK_CREDS)
  writeFileSync(join(created.path, 'docs/CLI_COMMANDS.yaml'), CLI_COMMANDS)
  mkdirSync(join(created.path, 'skills/acme-report'), { recursive: true })
  writeFileSync(
    join(created.path, 'skills/acme-report/SKILL.md'),
    '---\nname: acme-report\ndescription: Write the Acme report.\n---\n\nRun `/run:check-creds`, then summarise.\n'
  )
  writeFileSync(join(created.path, 'knowledge/acme.md'), '# Acme\n\nAcme sells anvils.\n')
  await app.page.evaluate(() => window.api.localAgents.rescan())

  // Attach the account's Acme API through the same option the dialog offers.
  await syncCredentials(app)
  const attached = await app.page.evaluate(
    async ({ id, credentialId }) => {
      const setup = await window.api.serviceCredentials.setupState(id)
      if (!setup.ok) return setup.message
      const option = setup.value.slots.find((s) => s.name === 'acme')?.options.find((o) => o.ref === credentialId)
      if (!option) return `no Acme option: ${JSON.stringify(setup.value.slots.map((s) => [s.name, s.options.map((o) => o.credential.name)]))}`
      const result = await window.api.serviceCredentials.attach(id, option.group, option.ref)
      return result.ok ? 'ok' : result.message
    },
    { id: created.id, credentialId: fixture.credentials.acme.id }
  )
  expect(attached).toBe('ok')
  const saved = await app.page.evaluate(
    ({ id, key }) => window.api.localAgents.setEnvValues(id, { WEATHER_API_KEY: key }),
    { id: created.id, key: input.weatherKey }
  )
  expect(saved.ok).toBe(true)
  await app.relaunch()
  const agent = await app.page.evaluate((id) => window.api.localAgents.get(id), created.id)
  if (!agent.ok) throw new Error(agent.message)
  return { id: created.id, name: input.name, slug: created.slug, path: created.path, manifestId: String(manifest.id) }
}

/** Sync the active profile's service credentials from core now. */
export async function syncCredentials(app: PersonApp): Promise<void> {
  const result = await app.page.evaluate(async () => {
    const user = await window.api.auth.getCurrent()
    if (!user?.cinnaServerUrl) return 'no cinna profile'
    const synced = await window.api.serviceCredentials.sync(user.id, user.cinnaServerUrl)
    if (!synced.ok) return synced.message
    const listed = await window.api.serviceCredentials.list(user.id, user.cinnaServerUrl)
    return listed.ok ? listed.value.error ?? 'ok' : listed.message
  })
  expect(result).toBe('ok')
}

/** Agents tab → the agent's row → its page. */
export async function openAgent(app: PersonApp, name: string): Promise<void> {
  await app.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await app.page.getByRole('button', { name, exact: true }).click()
  await expect(app.page.getByRole('heading', { level: 1 })).toHaveText(name)
}

/**
 * The agent page's Settings → Commands → Run on `command`, which starts a
 * new chat that runs `/run:<command>` with no model; answers the command's
 * output as the chat shows it.
 */
export async function runCommand(app: PersonApp, name: string, command: string): Promise<void> {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await app.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Commands/ }).click()
  const row = app.page.getByRole('listitem').filter({ hasText: `/run:${command}` })
  await row.getByRole('button', { name: 'Run', exact: true }).click()
}

/** ⋯ → Share with the team…, with each of `people` added at `access`, then Share. */
export async function shareWithTeam(
  app: PersonApp,
  name: string,
  people: { person: SharingPerson; access?: 'Can use' | 'Can edit' | 'Maintainer' }[]
): Promise<void> {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'More actions' }).click()
  await app.page.getByRole('menu', { name: 'Agent actions' }).getByRole('menuitem', { name: 'Share with the team…' }).click()
  const dialog = app.page.getByRole('dialog', { name: 'Share with the team' })
  await expect(dialog.getByRole('textbox')).toHaveValue(name)
  for (const { person, access } of people) {
    const label = `${person.name} <${person.email}>`
    await dialog.getByRole('combobox', { name: 'Find a person' }).fill(person.name)
    await dialog.getByRole('option', { name: label }).click()
    if (access) await dialog.getByRole('combobox', { name: `Access for ${label}` }).selectOption({ label: access })
  }
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 60_000 })
}

/** Agents → + → Install from catalog → Team library → the tile's Get. */
export async function getFromLibrary(app: PersonApp, name: string): Promise<void> {
  await app.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await app.page.getByRole('button', { name: 'Add an agent' }).click()
  await app.page.getByRole('dialog', { name: 'Add an agent' }).getByRole('button', { name: /Install from catalog/ }).click()
  const catalog = app.page.getByRole('dialog', { name: 'Agent catalog' })
  await catalog.getByRole('tablist', { name: 'Catalog source' }).getByRole('tab', { name: 'Team library' }).click()
  await catalog.getByRole('group', { name }).getByRole('button', { name: 'Get', exact: true }).click()
  await expect(catalog).toHaveCount(0, { timeout: 60_000 })
  await expect(app.page.getByRole('heading', { level: 1 })).toHaveText(name)
}

/** The library entry `slug` as `person` sees it, or undefined. */
export async function libraryEntry(fixture: SharingFixture, token: string, slug: string): Promise<any> {
  const listed = await coreCall(fixture, token, '/library')
  expect(listed.status).toBe(200)
  return (listed.body.agents as any[]).find((agent) => agent.slug === slug)
}

/** The admin's REST steps between a test's UI steps. */
export const admin = {
  /** Share credential `credentialId` with `email`; answers the share id. */
  async share(fixture: SharingFixture, credentialId: string, email: string): Promise<string> {
    const shared = await coreCall(fixture, fixture.admin.token, `/credentials/${credentialId}/shares`, {
      method: 'POST',
      body: { shared_with_email: email }
    })
    expect(shared.status, JSON.stringify(shared.body)).toBeLessThan(300)
    return shared.body.id as string
  },
  /** Revoke every share of `credentialId` with `email`. */
  async unshare(fixture: SharingFixture, credentialId: string, email: string): Promise<void> {
    const listed = await coreCall(fixture, fixture.admin.token, `/credentials/${credentialId}/shares`)
    for (const share of (listed.body?.data ?? []) as { id: string; shared_with_email: string }[]) {
      if (share.shared_with_email !== email) continue
      const removed = await coreCall(fixture, fixture.admin.token, `/credentials/${credentialId}/shares/${share.id}`, { method: 'DELETE' })
      expect(removed.status).toBeLessThan(300)
    }
  },
  async isSharedWith(fixture: SharingFixture, credentialId: string, email: string): Promise<boolean> {
    const listed = await coreCall(fixture, fixture.admin.token, `/credentials/${credentialId}/shares`)
    return ((listed.body?.data ?? []) as { shared_with_email: string }[]).some((s) => s.shared_with_email === email)
  },
  /** Replace the credential's token value. */
  async rotate(fixture: SharingFixture, credentialId: string, secret: string): Promise<void> {
    const put = await coreCall(fixture, fixture.admin.token, `/credentials/${credentialId}`, {
      method: 'PUT',
      body: { credential_data: { api_token_type: 'bearer', api_token: secret } }
    })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
  }
}

/** One agent of `app` by name, re-read from the index. */
export async function findAgent(app: PersonApp, name: string): Promise<{ id: string; path: string; readiness: string; slug: string }> {
  const listed = await app.page.evaluate(() => window.api.localAgents.list())
  const row = listed.agents.find((agent) => agent.name === name)
  if (!row) throw new Error(`${app.label} has no agent named ${name}`)
  return { id: row.id, path: row.path, readiness: row.readiness, slug: row.slug }
}

/** Re-read the Team library now — what opening the catalog or the Sharing tab does. */
export async function refreshLibrary(app: PersonApp): Promise<void> {
  const listed = await app.page.evaluate(() => window.api.sharing.library(true))
  expect(listed.success).toBe(true)
}

/** The share badge's Share changes… → What changed → Share. */
export async function shareChanges(app: PersonApp, name: string, note: string): Promise<void> {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'Share changes…', exact: true }).click()
  const dialog = app.page.getByRole('dialog', { name: 'Share changes' })
  await dialog.getByRole('textbox').fill(note)
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 60_000 })
  // Then either the collision dialog (nothing was sent) or core having the
  // new head: its listing takes it a few seconds after the send lands, and a
  // teammate's refresh before that still reads the old one.
  const agent = await findAgent(app, name)
  await expect
    .poll(
      async () => {
        if (await app.page.getByRole('dialog', { name: 'The team changed this agent too' }).isVisible()) return 'collision'
        const sent = execFileSync('git', ['-C', agent.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
        return (await libraryEntry(app.fixtureRef, app.person.token, agent.slug))?.head_sha === sent ? 'sent' : 'waiting'
      },
      { timeout: 30_000 }
    )
    .not.toBe('waiting')
}

/** A slot's state as main's setup read answers it. */
export async function slotStates(app: PersonApp, agentId: string): Promise<Record<string, string>> {
  const setup = await app.page.evaluate((id) => window.api.serviceCredentials.setupState(id), agentId)
  if (!setup.ok) throw new Error(setup.message)
  return Object.fromEntries(setup.value.slots.map((slot) => [slot.name, slot.state]))
}

/** The open Finish setting up dialog for `name`, and one slot's row in it. */
export function finishDialog(app: PersonApp, name: string) {
  const dialog = app.page.getByRole('dialog', { name: `Finish setting up ${name}` })
  return { dialog, row: (slot: string) => dialog.getByTestId(`finish-setup-slot-${slot}`) }
}

/** In the open Finish setting up dialog: type the weather key, Save, Done. */
export async function finishWithWeather(app: PersonApp, name: string, key: string): Promise<void> {
  const { dialog, row } = finishDialog(app, name)
  await expect(dialog).toBeVisible()
  await row('weather').getByLabel('WEATHER_API_KEY').fill(key)
  await row('weather').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(row('weather').getByText('Set on this computer', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}
