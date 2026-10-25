import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { installCachedEngine } from '../fixtures/engine-cache'
import { requireLiveKey, seedOpenAiDefaultMode } from '../fixtures/live'
import { LIVE_ENGINE } from '../fixtures/liveEngine'
import { askAgent, findFiles, manifestOf, openTile, picker, type DirectoryEntry } from '../fixtures/livePlugins'
import {
  test,
  expect,
  agentName,
  catalogEntryOrFail,
  cloneHistory,
  coreCall,
  findAgent,
  getFromLibrary,
  openAgent,
  shareWithTeam,
  type PersonApp
} from '../fixtures/liveTeamSharing'

/**
 * @live — **a shared agent carries its connectors and plugins to a teammate**
 * (unified addons D6), two apps against the real local cinna-core
 * (`e2e/fixtures/live-team-sharing.py`, `CINNA_SHARING_LIVE_FIXTURE`).
 *
 * - A makes a kit agent and, through Addons → Add, pins `playground` (a
 *   skills-only plugin) and adds an OAuth entry of core's MCP directory
 *   (`rovo`, else the first ready HTTP one) without signing in — the browser
 *   is stubbed in main. `cinna-agent.json` then holds one
 *   `marketplace_plugins[]` pin and one `mcp_servers[]` requirement.
 * - A's connector is then given stored secrets in its own slots, the way a
 *   finished sign-in leaves them (encrypted OAuth tokens, a client secret)
 *   plus an env value, each a random canary. The row is switched off first
 *   so nothing ever sends a canary to the real server.
 * - A shares the agent with B (a named person, no role grant). An admin
 *   clone of the whole repository history holds the requirement and the pin,
 *   and no canary and not A's connector id.
 * - B gets it from the catalog. The Addons tab shows the requirement as a
 *   Needs setup row ("Needs setup on this computer"); Set up opens the picker
 *   straight at the entry (its detail, with Add). The plugin arrives on its
 *   own; its row reads `1 skill`. One OpenCode turn answers from the plugin's
 *   SKILL.md (`document-critique.md`, absent from the prompt). Afterwards no
 *   file under B's sandbox (HOME and userData, `cinna.db` and logs included)
 *   holds a canary or A's connector id.
 *
 * ## Cost
 *
 * One short OpenCode turn (`.env` `OPENAI_API_KEY`, gpt-5.6-luna by default).
 * Run deliberately:
 * `CINNA_SHARING_LIVE_FIXTURE=… make e2e-one SPEC=e2e/specs/live-sharing-addons.spec.ts LIVE_ENGINE=opencode`.
 * Fixture cleanup is the fixture script's own `cleanup` (exact name shapes and
 * notes marker; the agent's slug is `acme-reporter-<tag>-<hex>`).
 *
 * ## What it does not prove
 *
 * B signing in to the connector or using it in a turn (core lists only OAuth
 * entries; no account behind them); a no-auth, token or stdio entry
 * travelling (their `mcp_servers[]` shapes are unit-tested); a plugin with
 * connectors of its own travelling; the canaries are planted in A's database,
 * not typed through a real sign-in, so the test proves what sharing reads,
 * not what a sign-in writes.
 */

/** Anthropic's skills-only plugin, its one skill under skills/playground/. */
const PLAYGROUND = 'playground'
/** In its SKILL.md: "`templates/document-critique.md` — Document review". */
const PLAYGROUND_FACT = 'document-critique.md'

test.beforeEach(() => {
  requireLiveKey()
  test.skip(LIVE_ENGINE.name !== 'opencode', 'the teammate’s turn runs on OpenCode only')
})

/** Agent page → Settings → Addons, and its Addons section. */
async function openAddons(app: PersonApp, name: string): Promise<Locator> {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await app.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
  return app.page
    .getByRole('tabpanel')
    .locator('section')
    .filter({ has: app.page.getByRole('heading', { level: 2, name: 'Addons', exact: true }) })
}

/** Every file under `root` (links not followed) whose bytes contain one of `needles`, as `path: needle`. */
function filesHolding(root: string, needles: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) {
        const bytes = readFileSync(path)
        for (const needle of needles) if (bytes.includes(needle)) found.push(`${path}: ${needle}`)
      }
    }
  }
  if (existsSync(root)) walk(root)
  return found
}

test('@live a shared agent brings its connector as Needs setup and its plugin, and no secret travels', async ({ team }) => {
  test.setTimeout(12 * 60_000)
  const { fixture } = team

  const listed = await coreCall(fixture, fixture.people.a.token, '/addons/directory')
  expect(listed.status, 'core serves /addons/directory').toBe(200)
  const directory = listed.body.data as DirectoryEntry[]
  const plugin = directory.find((entry) => entry.kind === 'plugin' && entry.name === PLAYGROUND)
  test.skip(!plugin, `core lists no ${PLAYGROUND} plugin`)
  const http = directory.filter((entry) => entry.kind === 'mcp' && entry.status === 'ready' && entry.install?.mcp?.transport === 'http' && entry.install.mcp.auth === 'oauth')
  const target = http.find((entry) => entry.name === 'rovo') ?? http[0]
  test.skip(!target, 'core’s MCP directory lists no ready OAuth HTTP server')
  const connector = target as DirectoryEntry
  console.log(`live-sharing-addons entry: ${connector.title} (${connector.ref.id})`)

  const name = agentName(fixture)
  const canary = {
    access: `canary-access-${randomBytes(12).toString('hex')}`,
    refresh: `canary-refresh-${randomBytes(12).toString('hex')}`,
    clientSecret: `canary-client-${randomBytes(12).toString('hex')}`,
    env: `canary-env-${randomBytes(12).toString('hex')}`
  }

  const a = await team.open('a')
  const created = await a.page.evaluate(
    (args) => window.api.localAgents.create(args),
    { rootId: await a.rootId(), name, description: 'Reviews documents.' }
  )
  // Pickers and the composer see a new agent only after a restart.
  await a.relaunch()
  // Never a browser from the test: a sign-in would open one.
  await a.electronApp.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __opened?: string[] }).__opened = opened
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })

  let providerId = ''
  let requirementName = ''
  await test.step(`A adds ${PLAYGROUND} and ${connector.title} through the picker`, async () => {
    const section = await openAddons(a, name)
    const { dialog, detail } = picker(a, name)
    await openTile(a, section, PLAYGROUND, PLAYGROUND, 'Plugin', name)
    await detail.getByRole('button', { name: `Add to ${name}`, exact: true }).click()
    await expect(detail.getByText('Ready in the next chat', { exact: true })).toBeVisible({ timeout: 90_000 })
    await detail.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    await openTile(a, section, connector.title, connector.title, 'Connector', name)
    await detail.getByRole('button', { name: `Add to ${name}`, exact: true }).click()
    await expect(detail.locator('[data-addon-setup="oauth"]')).toContainText(`Sign in to ${connector.title} to finish.`, { timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const attached = await a.page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), created.id)
    expect(attached).toHaveLength(1)
    providerId = attached[0]
    const manifest = manifestOf(created.path)
    console.log(`live-sharing-addons A mcp_servers: ${JSON.stringify(manifest.mcp_servers)} marketplace_plugins: ${JSON.stringify(manifest.marketplace_plugins)}`)
    const requirements = (manifest.mcp_servers ?? []) as Array<Record<string, unknown>>
    expect(requirements).toHaveLength(1)
    expect(JSON.stringify(requirements[0])).toContain(connector.ref.id)
    expect(requirements[0]).toMatchObject({ url: connector.install?.mcp?.url })
    requirementName = String(requirements[0].name)
    const pins = (manifest.marketplace_plugins ?? []) as Array<Record<string, unknown>>
    expect(pins).toHaveLength(1)
    expect(pins[0]).toMatchObject({ entry_uuid: plugin!.ref.id, name: PLAYGROUND })
    expect(await a.electronApp.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])).toEqual([])
  })

  await test.step('A’s connector holds stored secrets: OAuth tokens, a client secret, an env value', async () => {
    // Off first, through the app, so nothing sends a canary to the real server.
    const row = (await a.page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)!
    const off = await a.page.evaluate(
      (r) => window.api.mcp.upsert({ id: r.id, name: r.name, transportType: r.transportType, url: r.url, enabled: false }),
      row
    )
    expect(off.success).toBe(true)
    await a.electronApp.evaluate(
      ({ app, safeStorage }, input) => {
        if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
        const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
        const Database = req('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
        try {
          const tokens = JSON.stringify({ access_token: input.access, refresh_token: input.refresh, token_type: 'Bearer', expires_in: 3600 })
          const changed = db
            .prepare('UPDATE mcp_providers SET auth_tokens_enc = ?, client_info = ?, env = ? WHERE id = ?')
            .run(
              safeStorage.encryptString(tokens),
              JSON.stringify({ client_id: 'cinna-e2e-client', client_secret: input.clientSecret }),
              JSON.stringify({ E2E_CANARY: input.env }),
              input.id
            ).changes
          if (changed !== 1) throw new Error(`planted on ${changed} rows`)
        } finally {
          db.close()
        }
      },
      { ...canary, id: providerId, userData: a.sandbox.userData }
    )
    const stored = (await a.page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)!
    expect(stored).toMatchObject({ enabled: false, hasAuth: true, env: { E2E_CANARY: canary.env } })
    const manifestText = readFileSync(join(created.path, 'cinna-agent.json'), 'utf8')
    for (const secret of [providerId, ...Object.values(canary)]) expect(manifestText).not.toContain(secret)
    expect(manifestText).not.toContain('E2E_CANARY')
  })

  await test.step('A shares it with B; core’s whole history carries the requirement and the pin, and no secret', async () => {
    await shareWithTeam(a, name, [{ person: fixture.people.b }])
    const agent = await findAgent(a, name)
    const entry = await catalogEntryOrFail(fixture, agent.slug)
    const history = cloneHistory(fixture, entry.desktop.repo_id, fixture.admin.token)
    if (history.status !== 'ok') throw new Error(`admin clone refused: ${history.output}`)
    expect(history.blobs).toContain(connector.ref.id)
    expect(history.blobs).toContain(plugin!.ref.id)
    for (const secret of [providerId, ...Object.values(canary)]) expect(history.blobs, `the bundle holds no ${secret.split('-')[1] ?? 'id'}`).not.toContain(secret)
    expect(history.blobs).not.toContain('E2E_CANARY')
  })

  const b = await team.open('b')
  installCachedEngine(b.sandbox.userData)
  await b.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const model = await seedOpenAiDefaultMode(b)
  console.log(`live-sharing-addons model: ${model}`)
  test.info().annotations.push({ type: 'model', description: model })

  await test.step('B gets the agent: the same requirement and pin, nothing of A’s', async () => {
    await getFromLibrary(b, name)
    const agent = await findAgent(b, name)
    const manifest = manifestOf(agent.path)
    expect(manifest.mcp_servers).toEqual(manifestOf(created.path).mcp_servers)
    expect(manifest.marketplace_plugins).toEqual(manifestOf(created.path).marketplace_plugins)
    expect(await b.page.evaluate(() => window.api.mcp.list())).toEqual([])
  })

  const section = await openAddons(b, name)
  await test.step(`B: ${requirementName} is a Needs setup row, and Set up opens the picker at ${connector.title}`, async () => {
    const row = section.locator(`[data-mcp-requirement="${requirementName}"]`)
    await expect(row).toHaveAttribute('data-mcp-requirement-state', 'needs_setup', { timeout: 30_000 })
    await expect(row.getByText('In cinna-agent.json', { exact: true })).toBeVisible()
    await expect(row.getByText('Needs setup on this computer', { exact: true })).toBeVisible()
    await row.getByRole('button', { name: `Set up ${requirementName}`, exact: true }).click()
    const { dialog, detail } = picker(b, name)
    await expect(dialog).toBeVisible()
    await expect(detail.getByRole('heading', { level: 3, name: connector.title, exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(detail.getByRole('button', { name: `Add to ${name}`, exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  await test.step(`B: ${PLAYGROUND} arrives on its own and its row reads 1 skill`, async () => {
    const row = section.locator(`[data-plugin-row="${PLAYGROUND}"]`)
    await expect(row.locator('[data-addon-kind]')).toHaveText('Plugin', { timeout: 90_000 })
    await expect(row.locator('[data-plugin-summary]')).toHaveText('1 skill', { timeout: 90_000 })
    const cached = findFiles(join(b.sandbox.userData, 'marketplace-plugins'), join(PLAYGROUND, 'SKILL.md'))
    expect(cached, 'B downloaded the snapshot into its own cache').toHaveLength(1)
    expect(readFileSync(cached[0], 'utf8')).toContain(`templates/${PLAYGROUND_FACT}`)
  })

  const agentB = await findAgent(b, name)
  const prompt = `Use your ${PLAYGROUND} skill: which template file does it tell you to load for a document review playground? Reply with only the file name.`
  expect(prompt).not.toContain(PLAYGROUND_FACT)
  const { turn } = await askAgent(b, agentB.path, prompt, { agent: name })
  await test.step('B’s turn answers from the plugin’s SKILL.md', async () => {
    expect(turn.errors).toEqual([])
    expect(turn.reply).toContain(PLAYGROUND_FACT)
  })

  await test.step('nothing under B’s sandbox holds a secret of A’s connector, or its id', async () => {
    // The scan's control: the entry ref B's manifest really holds is found.
    expect(filesHolding(b.sandbox.root, [connector.ref.id]).length, 'the scan reads B’s files').toBeGreaterThan(0)
    expect(filesHolding(b.sandbox.root, [providerId, ...Object.values(canary)])).toEqual([])
  })
})
