import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Locator, type Page } from '@playwright/test'
import { answerAgentsFolder, homeDir, test, expect, type CinnaApp } from '../fixtures/app'
import { LIVE_REQUESTED, requireLiveKey, seedOpenAiDefaultMode } from '../fixtures/live'
import { claudeBinary, claudeLoginProblem, expectNoAgentTurn, liveEngineFor, type LiveEngine, type LiveEngineName } from '../fixtures/liveEngine'
import { approveDesktopAuth, preflight, requireLiveCinna, signIn, type LiveCinnaConfig } from '../fixtures/liveCinna'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { repoRoot } from '../playwright.config'

/**
 * Artifacts against the developer's **real local cinna-core**, with **real
 * Claude Code** for the agent's own publish, core's **real web frontend** in a
 * headless Chromium, and the **real `cinna` CLI**.
 *
 * ## What is real
 *
 * Everything: the desktop's OAuth into core (PKCE, code, token exchange,
 * userinfo — only the consent click is done over the API by
 * `approveDesktopAuth`), core's discovery `artifacts: 1`, the desktop's walk,
 * zip and multipart upload, core's ingest, revision manifest, visibility,
 * public links and the sandboxed content origin.
 *
 * - L1 — a person publishes a site folder from the desktop, republishes it,
 *   shares it with the instance and creates and revokes a public link.
 * - L2 — a **kit agent** on the developer's own `claude` (their login, on
 *   `haiku`) is asked in plain words, with no path, to build a summary and
 *   publish it. Its conversation prompt (contract 1.13.0's `artifacts` role)
 *   sends it to `artifacts/<name>`: the spec reads the path from the
 *   `artifacts_publish` call, finds the file there and has git say it is
 *   ignored. Then the approval card, a republish with no card as rev 2, and
 *   a Deny that leaves core untouched. Runs once per entry of
 *   `CINNA_E2E_LIVE_ARTIFACT_ENGINES` (below; `claude-haiku` alone by default),
 *   titled `L2 [<entry>] …`.
 * - L3 — core's web frontend (the origin core puts in its artifact URLs, never
 *   hard-coded) in a separate headless Chromium: the public link the desktop
 *   created shows the site framed with its script run and its own CSV
 *   fetched; the framed document's origin is opaque (`null`), its
 *   `localStorage` throws, and the response carries CSP `sandbox` without
 *   `allow-same-origin`. The owner page renders for a browser signed in with
 *   the account's JWT. A link with a 4-digit code pinned to rev 1 (made over
 *   core's API: the desktop's Share offers neither) refuses a wrong code and
 *   shows rev 1, not rev 2, for the right one; the plain link shows rev 2.
 * - L4 — the `cinna` CLI publishes a folder to the same account; an
 *   assistant message in a desktop chat that holds the artifact's URL draws
 *   its card; Everyone on the instance from the card's Share is what
 *   `cinna artifacts show` then reports. The profile is fresh, so it has never
 *   seen core's frontend origin: the card proves a link on it is read from
 *   core and drawn because core's own `url` is on that origin.
 * - L5 — the same kit agent on `haiku`: Edit… on its approval card opens
 *   `Publish for <agent>` prefilled with the agent's title, and the edited
 *   title is what core holds (none under the agent's); the next request is
 *   answered from the Inbox with the chat off screen, the publish lands before
 *   the chat is shown again, and the answered row stays as `Answered: Publish.`.
 *   The prompts give the agent the text to publish: it turns down other
 *   subjects as outside its role and will not invent figures.
 *
 * ## Running it
 *
 * `make e2e-one SPEC=e2e/specs/live-artifacts.spec.ts` with `.env` holding
 * `CINNA_E2E_SERVER_URL` / `_EMAIL` / `_PASSWORD` (an account on a core whose
 * discovery says `artifacts: 1`, with its frontend running) and a logged-in
 * `claude` (`CINNA_E2E_CLAUDE_PATH` or `~/.local/bin/claude`). Skips
 * otherwise. L4 also needs `cinna` on `PATH` and `CINNA_E2E_CLI_ACCOUNT_DIR`:
 * an account workspace (absolute, or relative to this repository) whose
 * `.cinna/account.json` holds a CLI token **for the same user on the same
 * core**; it skips without one. Only `account.json` is read: it is copied
 * into a temp folder and the CLI runs there, so nothing (its path memory, its
 * `cinna.log`) is written into that workspace. Runs under the real-`HOME`
 * exception (`realLogin.ts`): throwaway userData, a fresh
 * `~/.cinna-e2e-claude-*` folder for every agent, removed afterwards with
 * Claude's session records for it.
 *
 * ## What it costs and leaves
 *
 * L2 runs three Claude turns on `haiku` on the developer's subscription
 * (the turns' own telemetry estimates about $0.007; `claude-sonnet` about
 * $0.14), L5 two (about $0.005); L1, L3 and L4 run no model turn. Each test
 * registers one desktop OAuth client on core (as `cinna-integration.spec.ts`
 * does). Artifacts the run created are hard-deleted in `afterAll` by the exact
 * ids recorded here (the CLI's own by `cinna artifacts delete <id>`), never by
 * title; the public links it made are revoked by id before that.
 *
 * ## What it does not prove
 *
 * Named-people grants, link expiry, the code's lock-out after three wrong
 * tries, a `files` artifact's viewers on core's page; L5 on any engine but
 * Claude `haiku`. The engine list's `opencode`, `codex` and `antigravity`
 * entries are wired but have never been run. The owner page is opened
 * with a JWT put where core's frontend keeps it, not through its login form.
 */

const BINARY = claudeBinary()
const TAG = `${Date.now().toString(36)}`
const AGENT = 'Artifact Desk'
const KIT_AGENT = 'Quarter Reporter'
const L1_TITLE = `E2E artifacts site ${TAG}`
const L2_BASE_TITLE = `E2E artifacts summary ${TAG}`
const L2_OTHER_BASE_TITLE = `E2E artifacts other ${TAG}`
const L5_AGENT_TITLE = `E2E artifacts draft ${TAG}`
const L5_EDITED_TITLE = `E2E artifacts edited ${TAG}`
const L5_INBOX_TITLE = `E2E artifacts inbox ${TAG}`
/** Set once L5 starts, so cleanup also sweeps its run-tagged titles. */
let l5Ran = false
const L3_TITLE = `E2E artifacts web ${TAG}`
const L4_TITLE = `E2E artifacts cli ${TAG}`

const INDEX_HTML = `<!doctype html>\n<html><head><meta charset="utf-8"><title>Q3</title><script src="./app.js"></script></head>\n<body><h1>Q3 ${TAG}</h1></body></html>\n`
const APP_JS = `document.title = 'Q3 ${TAG}'\n`
const DATA_CSV = 'month,revenue\nJul,10\nAug,11\nSep,12\n'

/** L3's site: the script runs after the body and fetches the artifact's own CSV. */
function webIndex(heading: string): string {
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>Web</title></head>\n<body><h1>${heading}</h1><p id="ran">not run</p><p id="rows">no rows</p><script src="./app.js"></script></body></html>\n`
}
const WEB_APP_JS = [
  "document.getElementById('ran').textContent = 'app.js ran'",
  "fetch('data.csv').then((r) => r.text()).then((t) => { document.getElementById('rows').textContent = (t.trim().split('\\n').length - 1) + ' rows' })",
  ''
].join('\n')

/** Every artifact id this run created on core: deleted in `afterAll`, exactly these. */
const created = new Set<string>()
/** Public links this run created, revoked by id in `afterAll` (a no-op when the test already did). */
const createdLinks: Array<{ artifactId: string; linkId: string }> = []
/** The CLI's temp account folder of L4, and the artifacts it published (deleted through the CLI). */
let cliAccount: string | null = null
const cliCreated = new Set<string>()
let live: LiveCinnaConfig | null = null

test.use({
  engine: true,
  realLogin: BINARY ? { engine: 'claude', binary: BINARY, pathSetting: 'localAgentsClaudePath' } : null,
  liveEngineCheck: BINARY ? { engine: 'claude', binary: BINARY } : null
})

/**
 * The engines L2 runs on: `CINNA_E2E_LIVE_ARTIFACT_ENGINES`, a comma list of
 * `claude-haiku`, `claude-sonnet`, `claude-opus`, `claude`, `opencode`,
 * `codex`, `antigravity`; unset, `claude-haiku` alone (the run this spec always
 * made). An entry that names its model keeps it; a bare engine takes
 * `CINNA_E2E_LIVE_MODEL`, else its default (`liveEngine.ts`: Claude `haiku`
 * here, OpenCode `gpt-5.6-luna` through the `.env` key, Codex `gpt-5.6-luna`,
 * Antigravity `gemini-3.6-flash-low`). An unknown entry throws at import.
 */
interface ArtifactEngine {
  entry: string
  engine: LiveEngine
  /** What the turns' telemetry `model` must match, when the engine reports one; null checks nothing. */
  model: RegExp | null
}

const ARTIFACT_ENGINES: ArtifactEngine[] = ((process.env.CINNA_E2E_LIVE_ARTIFACT_ENGINES ?? '').trim() || 'claude-haiku')
  .split(',').map((raw) => raw.trim()).filter(Boolean).map(artifactEngine)

function artifactEngine(entry: string): ArtifactEngine {
  const override = (process.env.CINNA_E2E_LIVE_MODEL ?? '').trim()
  const claude = /^claude-(haiku|sonnet|opus)$/.exec(entry)
  if (claude) return { entry, engine: liveEngineFor('claude', claude[1]), model: new RegExp(claude[1], 'i') }
  if (entry === 'claude') {
    const model = override || 'haiku'
    return { entry, engine: liveEngineFor('claude', model), model: /^(haiku|sonnet|opus)$/.test(model) ? new RegExp(model, 'i') : null }
  }
  if (entry === 'opencode' || entry === 'codex' || entry === 'antigravity') {
    const engine = liveEngineFor(entry as LiveEngineName, override)
    // OpenCode reports no telemetry; Codex names the slug it ran; Antigravity's name is logged, not matched.
    const slug = engine.runtime?.modelId ?? ''
    return { entry, engine, model: entry === 'codex' && slug ? new RegExp(slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null }
  }
  throw new Error(`CINNA_E2E_LIVE_ARTIFACT_ENGINES: unknown entry "${entry}" (claude-haiku, claude-sonnet, claude-opus, claude, opencode, codex, antigravity)`)
}

/** Titles of the per-engine L2 tests start with this; their engine's own prerequisites are checked in the test. */
const ENGINE_TEST_PREFIX = 'L2 ['

test.beforeEach(async ({}, testInfo) => {
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
  live = requireLiveCinna()
  const ready = await preflight(live)
  test.skip(!ready.ok, ready.ok ? '' : `live cinna-core not usable: ${ready.reason}`)
  test.skip((ready as { discovery: { artifacts?: number } }).discovery.artifacts === undefined, `${live.serverUrl} does not advertise artifacts`)
  if (testInfo.title.startsWith(ENGINE_TEST_PREFIX)) return
  test.skip(BINARY === null, 'no Claude Code binary (set CINNA_E2E_CLAUDE_PATH, or install ~/.local/bin/claude)')
  const login = claudeLoginProblem(BINARY!)
  test.skip(login !== null, login ?? '')
})

test.afterAll(async () => {
  if (cliAccount) {
    for (const id of cliCreated) {
      const out = cli(['artifacts', 'delete', id, '--yes', '--json'])
      console.log(`live-artifacts cleanup: cinna artifacts delete ${id} → exit ${out.status}`)
      // The CLI's account is the .env one (L4 checks it): REST deletes what the CLI could not.
      if (out.status !== 0) created.add(id)
    }
    rmSync(cliAccount, { recursive: true, force: true })
    cliAccount = null
  }
  if (!live) return
  if (l5Ran) {
    // L5's Edit… publish is recorded from the agent's tool result; a failure
    // between the dialog's Publish and that result would leave it behind.
    // Its titles carry this run's TAG, so an exact title match is this run's.
    const titles = new Set([L5_AGENT_TITLE, L5_EDITED_TITLE, L5_INBOX_TITLE])
    const listed = await core(`/artifacts?scope=mine&q=${encodeURIComponent(TAG)}&limit=200`).catch(() => null)
    for (const item of (listed?.status === 200 ? listed.body?.data : null) ?? []) {
      if (titles.has(item?.title) && typeof item?.id === 'string' && UUID_PATTERN.test(item.id)) created.add(item.id)
    }
  }
  if (created.size === 0 && createdLinks.length === 0) return
  const token = await signIn(live)
  for (const { artifactId, linkId } of createdLinks) {
    const response = await fetch(`${live.serverUrl}/api/v1/artifacts/${artifactId}/links/${linkId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    console.log(`live-artifacts cleanup: DELETE link ${linkId} → HTTP ${response.status}`)
  }
  for (const id of created) {
    const response = await fetch(`${live.serverUrl}/api/v1/artifacts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    console.log(`live-artifacts cleanup: DELETE artifact ${id} → HTTP ${response.status}`)
  }
})

/** One authenticated JSON call to core as the configured account. */
async function core(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const config = live!
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.auth !== false) headers.Authorization = `Bearer ${await signIn(config)}`
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(path.startsWith('http') ? path : `${config.serverUrl}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const text = await response.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // keep the text
  }
  return { status: response.status, body, headers: response.headers }
}

function currentRevision(detail: any): any {
  return (detail.revisions as any[]).find((revision) => revision.number === detail.current_revision_number)
}

/**
 * The profile becomes a Cinna account through the real desktop OAuth flow;
 * the browser's approve click is `approveDesktopAuth`. Then a restart, so
 * every store reads the account from the start.
 */
async function signInDesktop(cinna: CinnaApp, config: LiveCinnaConfig): Promise<void> {
  await cinna.electronApp.evaluate(({ shell }) => {
    const globals = globalThis as unknown as { __authorizeUrl?: string }
    globals.__authorizeUrl = undefined
    shell.openExternal = async (url: string): Promise<void> => {
      globals.__authorizeUrl = url
    }
  })
  const registering = cinna.page.evaluate(
    (serverUrl) => window.api.auth.register({ accountType: 'cinna', cinnaHostingType: 'self_hosted', cinnaServerUrl: serverUrl }),
    config.serverUrl
  )
  const authorizeUrl = await (async () => {
    await expect.poll(() => cinna.electronApp.evaluate(() => (globalThis as unknown as { __authorizeUrl?: string }).__authorizeUrl ?? ''), {
      timeout: 30_000,
      message: 'the app never asked to open an authorization URL'
    }).not.toBe('')
    return cinna.electronApp.evaluate(() => (globalThis as unknown as { __authorizeUrl?: string }).__authorizeUrl as string)
  })()
  await approveDesktopAuth(config, authorizeUrl)
  const registered = await registering
  expect(registered.success, JSON.stringify(registered)).toBe(true)
  const userId = (registered as { user: { id: string } }).user.id
  await cinna.relaunch()
  await cinna.skipOnboarding()
  if ((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.id !== userId) {
    await cinna.page.evaluate((id) => window.api.auth.login({ userId: id }), userId)
    await cinna.relaunch()
    await cinna.skipOnboarding()
  }
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  expect(user?.type).toBe('cinna_user')
  await expect.poll(() => cinna.page.evaluate(() => window.api.artifacts.support()).then((s) => s.supported), { timeout: 30_000 }).toBe(true)
}

/** A bare folder agent (`CLAUDE.md`) on Claude `haiku`, adopted over the dialog's own IPC pair. */
async function bareAgent(cinna: CinnaApp, files: Record<string, string>, folder = 'artifact-desk'): Promise<{ agentId: string; dir: string }> {
  const dir = homeDir(cinna, folder)
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${AGENT}\n\nYou keep reports for your owner in this folder. Keep replies to one or two sentences.\n`)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  await cinna.stubDirectoryPicker(dir)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled || pick.refusal !== null) throw new Error(`the folder was refused: ${JSON.stringify(pick)}`)
  const added = await cinna.page.evaluate((input) => window.api.localAgents.folderAdd(input), { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) })
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
  const real = realpathSync(dir)
  const agent = (await cinna.page.evaluate(() => window.api.localAgents.list())).agents.find((row) => row.path !== null && realpathSync(row.path) === real)
  if (!agent) throw new Error(`no agent row for ${dir}`)
  const runtime = await cinna.page.evaluate(
    (id) => window.api.localAgents.setRuntime(id, { engine: 'claude', credential: null, modelId: 'haiku', complexity: null }),
    agent.id
  )
  expect(runtime.ok, JSON.stringify(runtime)).toBe(true)
  return { agentId: agent.id, dir }
}

const HAIKU_RUNTIME = { engine: 'claude', credential: null, modelId: 'haiku', complexity: null } as const

/**
 * A kit agent scaffolded from the bundled contract, its manifest's runtime set
 * to `runtime` (Claude `haiku` unless a test names another); null keeps the
 * scaffold's Default runtime (OpenCode on the default chat mode).
 */
async function kitAgent(cinna: CinnaApp, runtime: LiveEngine['runtime'] = HAIKU_RUNTIME): Promise<{ agentId: string; dir: string }> {
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, KIT_AGENT, 'Writes short business reports for its owner.')
  if (runtime === null) return { agentId: agent.id, dir: agent.path }
  const outcome = await cinna.page.evaluate(async ({ agentId, runtime }) => {
    const got = await window.api.localAgents.get(agentId)
    if (!got.ok) return { ok: false as const, message: got.message }
    const stamp = got.value.stamps['cinna-agent.json']
    if (!stamp) return { ok: false as const, message: 'the kit agent has no manifest stamp' }
    return window.api.localAgents.updateField({
      agentId,
      update: { field: 'runtime', value: runtime },
      expectedStamp: stamp
    })
  }, { agentId: agent.id, runtime })
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  return { agentId: agent.id, dir: agent.path }
}

/** A bare agent holding `files`, an assistant message naming `mention`, and the chat's id; relaunched and rescanned. */
async function seededMention(cinna: CinnaApp, files: Record<string, string>, mention: string, question: string, folder?: string): Promise<{ agentId: string; dir: string; chatId: string }> {
  const { agentId, dir } = await bareAgent(cinna, files, folder)
  // The agent's mention, seeded: what is under test is the publish, not the model.
  const chatId = await cinna.page.evaluate(async ({ id, mention, question }) => {
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { agentId: id, router: 'direct', title: question })
    await window.api.chat.addMessage(chat.id, { role: 'user', content: question })
    await window.api.chat.addMessage(chat.id, { role: 'assistant', content: `It is in \`${mention}\`.` })
    return chat.id
  }, { id: agentId, mention, question })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { agentId, dir, chatId }
}

function card(page: Page, title: string): Locator {
  return page.getByRole('group', { name: `Artifact ${title}`, exact: true })
}

/**
 * The menu reads whether artifacts are supported when it opens (a snapshot).
 * Right after a launch main may still be on core's discovery; main pushes its
 * answer when it arrives, so wait for main to say yes and open the menu once.
 */
async function openPublishOn(page: Page, link: Locator): Promise<Locator> {
  await expect.poll(() => page.evaluate(() => window.api.artifacts.support()).then((s) => s.supported), { timeout: 30_000 }).toBe(true)
  const menu = page.getByRole('menu', { name: 'Message actions', exact: true })
  const publish = menu.getByRole('menuitem', { name: 'Publish…', exact: true })
  await link.click({ button: 'right' })
  await expect(publish).toBeVisible()
  await publish.click()
  const dialog = page.getByRole('dialog', { name: 'Publish to Cinna', exact: true })
  await expect(dialog.getByRole('list', { name: 'Files to publish' })).not.toHaveAttribute('aria-busy', 'true')
  return dialog
}

test('L1 a person publishes a site folder, republishes it, and shares it with the instance and a link', async ({ cinna }) => {
  test.setTimeout(240_000)
  const config = live!
  expectNoAgentTurn()
  await cinna.skipOnboarding()
  await signInDesktop(cinna, config)
  const { dir, chatId } = await seededMention(cinna, {
    'site/index.html': INDEX_HTML,
    'site/app.js': APP_JS,
    'site/data.csv': DATA_CSV,
    'site/.env': 'SITE_TOKEN=e2e-not-a-real-token\n',
    'site/node_modules/x.js': 'module.exports = 1\n'
  }, 'site/', 'Where is the Q3 site?')
  const instance = (await cinna.page.evaluate(() => window.api.artifacts.support())).instanceName ?? 'the instance'

  let artifactId = ''
  let pageUrl = ''
  await test.step('Publish… shows the site, its files and what is left out; Only me publishes it private', async () => {
    const page = cinna.page
    await page.getByText('Where is the Q3 site?', { exact: true }).first().click()
    const link = page.getByRole('button', { name: 'Show site/ in its folder', exact: true })
    await expect(link).toBeVisible({ timeout: 30_000 })
    const dialog = await openPublishOn(page, link)
    await expect(dialog.locator('[data-artifact-kind]')).toHaveText('Mini-site · opens index.html')
    await expect(dialog.getByRole('list', { name: 'Files to publish' }).getByRole('listitem')).toHaveText([
      '.envsecret file',
      `app.js${APP_JS.length} B`,
      `data.csv${DATA_CSV.length} B`,
      `index.html${INDEX_HTML.length} B`,
      'node_modules/dependencies'
    ])
    await dialog.getByLabel('Title', { exact: true }).fill(L1_TITLE)
    await expect(dialog.getByRole('radio', { name: 'Only me', exact: true })).toBeChecked()
    await expect(dialog.getByRole('radio', { name: `Everyone on ${instance}`, exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })
    await expect(card(page, L1_TITLE)).toContainText('rev 1 · only you')
    const cards = await page.evaluate((id) => window.api.artifacts.cards(id), chatId)
    expect(cards).toHaveLength(1)
    artifactId = cards[0].artifact.id
    pageUrl = cards[0].artifact.url
    created.add(artifactId)
    console.log(`live-artifacts L1 created artifact ${artifactId}`)
    expect(pageUrl).toMatch(new RegExp(`/artifact/${artifactId}$`))
  })

  await test.step('core holds exactly the three kept files, private, published from the desktop', async () => {
    const { status, body } = await core(`/artifacts/${artifactId}`)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ id: artifactId, title: L1_TITLE, kind: 'site', entry_path: 'index.html', visibility: 'private', source_kind: 'desktop', current_revision_number: 1, url: pageUrl })
    expect(body.source_label).toBe(`${AGENT} · site`)
    const revision = currentRevision(body)
    expect(revision.files.map((file: { path: string }) => file.path).sort()).toEqual(['app.js', 'data.csv', 'index.html'])
    // The desktop never sent `.env` or `node_modules/`, so core had nothing of its own to drop.
    expect(revision.excluded).toEqual([])
  })

  await test.step('the content origin serves index.html as sent, under a sandbox CSP', async () => {
    const view = await core(`/artifacts/${artifactId}/view`, { method: 'POST' })
    expect(view.status, JSON.stringify(view.body)).toBe(200)
    expect(view.body.entry).toBe('index.html')
    expect(view.body.files.map((file: { path: string }) => file.path).sort()).toEqual(['app.js', 'data.csv', 'index.html'])
    const content = await fetch(`${view.body.content_base}index.html`)
    expect(content.status).toBe(200)
    expect(await content.text()).toBe(INDEX_HTML)
    expect(content.headers.get('content-security-policy') ?? '').toMatch(/(^|;)\s*sandbox\b/)
  })

  await test.step('Publish… again preselects Update; rev 2 keeps the id and the page', async () => {
    const page = cinna.page
    writeFileSync(join(dir, 'site', 'app.js'), `${APP_JS}// rev 2\n`)
    const dialog = await openPublishOn(page, page.getByRole('button', { name: 'Show site/ in its folder', exact: true }))
    await expect(dialog.getByRole('radio', { name: `Update “${L1_TITLE}” (rev 1)`, exact: true })).toBeChecked()
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })
    await expect(card(page, L1_TITLE)).toContainText('rev 2 · only you')
    const { body } = await core(`/artifacts/${artifactId}`)
    expect(body).toMatchObject({ id: artifactId, current_revision_number: 2, url: pageUrl, revision_count: 2 })
    expect(currentRevision(body).files.find((file: { path: string }) => file.path === 'app.js').size).toBe(`${APP_JS}// rev 2\n`.length)
    const cards = await page.evaluate((id) => window.api.artifacts.cards(id), chatId)
    expect(cards.map((row) => row.artifact.id)).toEqual([artifactId])
  })

  await test.step('Share → Everyone on the instance is what core says', async () => {
    const page = cinna.page
    // The card's drawer slides out on hover.
    await card(page, L1_TITLE).locator('[data-artifact-card-body]').hover()
    await card(page, L1_TITLE).getByRole('button', { name: `Share ${L1_TITLE}`, exact: true }).click()
    const share = page.getByRole('dialog', { name: `Share ${L1_TITLE}`, exact: true })
    const everyone = share.getByRole('radio', { name: `Everyone on ${instance}`, exact: true })
    await expect(everyone).toBeEnabled({ timeout: 30_000 })
    await everyone.click()
    await expect(everyone).toBeChecked({ timeout: 30_000 })
    await expect.poll(async () => (await core(`/artifacts/${artifactId}`)).body.visibility).toBe('instance')
    await expect(card(page, L1_TITLE)).toContainText(`rev 2 · everyone on ${instance}`)
  })

  await test.step('a link is shown once and opens without auth; revoked, it no longer does', async () => {
    const page = cinna.page
    const share = page.getByRole('dialog', { name: `Share ${L1_TITLE}`, exact: true })
    await share.getByRole('button', { name: 'Create link', exact: true }).click()
    const fresh = share.locator('[data-artifact-fresh-link]')
    await expect(fresh).toContainText('Shown once — copy it now.', { timeout: 30_000 })
    const url = (await fresh.locator('code').textContent()) ?? ''
    const token = /\/s\/([^/?#]+)$/.exec(url)?.[1] ?? ''
    expect(token, url).not.toBe('')
    const info = await core(`/artifact-links/${token}/info`, { auth: false })
    expect(info.status, JSON.stringify(info.body)).toBe(200)
    expect(info.body).toMatchObject({ title: L1_TITLE, source_kind: 'desktop', expired: false, blocked: false })
    await expect(card(page, L1_TITLE)).toContainText('1 public link')

    const links = (await core(`/artifacts/${artifactId}`)).body.links as Array<{ id: string; token_prefix: string; revoked_at: string | null }>
    expect(links.filter((link) => link.revoked_at === null)).toHaveLength(1)
    createdLinks.push({ artifactId, linkId: links[0].id })
    await share.getByRole('button', { name: `Revoke link ${links[0].token_prefix}`, exact: true }).click()
    await share.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(share.locator('[data-artifact-link="revoked"]')).toContainText('Revoked', { timeout: 30_000 })
    expect((await core(`/artifact-links/${token}/info`, { auth: false })).status).toBe(404)
    expect((await core(`/artifact-links/${token}/open`, { method: 'POST', auth: false, body: {} })).status).toBeGreaterThanOrEqual(400)
    await page.keyboard.press('Escape')
  })
})

interface TurnWatch {
  /**
   * What to do when an approval card shows: answer it, fail the turn for
   * showing one, or hand the card to the test (once; it must leave no card on
   * screen when it returns).
   */
  approval: 'publish' | 'deny' | 'none' | ((approval: Locator, chatId: string) => Promise<void>)
}

/**
 * Send `prompt` in the open chat and wait for the turn to end. Claude on
 * `haiku` asks before each write (Ask every time): every permission ask is
 * answered Allow once. An approval card is answered as `watch` says.
 */
async function turn(cinna: CinnaApp, chatId: string | null, prompt: string, watch: TurnWatch): Promise<{ chatId: string; reply: string; approvals: number }> {
  const page = cinna.page
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  const before = chatId ? ((await page.evaluate((id) => window.api.chat.get(id), chatId))?.messages.length ?? 0) : 0
  await input.fill(prompt)
  await input.press('Enter')
  let id = chatId
  let approvals = 0
  const approvalCard = page.locator('[data-artifact-approval]')
  const handler = typeof watch.approval === 'function' ? watch.approval : null
  for (;;) {
    let state = ''
    await expect.poll(async () => {
      if (!id) {
        const chats = await page.evaluate(() => window.api.chat.list())
        id = chats.find((row) => row.agentId !== null)?.id ?? null
        if (!id) return (state = 'no chat yet')
      }
      const allow = page.getByRole('button', { name: 'Allow once', exact: true })
      if (await allow.count() > 0) await allow.first().click().catch(() => undefined)
      if (await approvalCard.count() > 0) {
        if (watch.approval === 'none') return (state = 'an approval card appeared')
        // The test's own handler runs outside the poll, so its assertions fail the test instead of being retried.
        if (handler) return (state = 'approval')
        approvals += 1
        await approvalCard.first().getByRole('button', { name: watch.approval === 'publish' ? 'Publish' : 'Deny', exact: true }).click().catch(() => undefined)
        await expect(approvalCard).toHaveCount(0, { timeout: 30_000 })
      }
      const chat = await page.evaluate((chat) => window.api.chat.get(chat), id)
      const messages = chat?.messages ?? []
      recordPublished(messages)
      const last = messages[messages.length - 1]
      if (chat?.activeRunId || messages.length <= before + 1 || last?.role !== 'assistant' || !last.content) return (state = 'running')
      return (state = 'done')
    }, { timeout: 240_000, intervals: [500], message: `the turn for “${prompt.slice(0, 40)}…” ends` }).toMatch(/^(done|approval)$/)
    if (state === 'done') break
    approvals += 1
    await handler!(approvalCard.first(), id!)
    await expect(approvalCard).toHaveCount(0, { timeout: 30_000 })
  }
  const chat = await page.evaluate((chat) => window.api.chat.get(chat), id!)
  const messages = chat!.messages
  return { chatId: id!, reply: messages[messages.length - 1].content, approvals }
}

/** The chat's `artifacts_publish` rows, oldest first: the path asked for, the parsed result and notes. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every artifact an agent's `artifacts_publish` returned in these messages goes
 * into `created` at once, before any assertion can fail, so `afterAll` deletes
 * it whatever the test then thinks of it — by exact id, as always.
 */
function recordPublished(messages: ReadonlyArray<{ role: string; toolName?: string | null; content: string }>): void {
  for (const message of messages) {
    if (message.role !== 'tool_call' || message.toolName !== 'artifacts_publish') continue
    try {
      const id = (JSON.parse(message.content) as { artifact_id?: unknown }).artifact_id
      if (typeof id === 'string' && UUID_PATTERN.test(id)) created.add(id)
    } catch {
      // a refusal sentence, not a result
    }
  }
}

async function publishCalls(cinna: CinnaApp, chatId: string) {
  const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
  recordPublished(chat?.messages ?? [])
  return (chat?.messages ?? [])
    .filter((message) => message.role === 'tool_call' && message.toolName === 'artifacts_publish')
    .map((message) => {
      let result: any = null
      try {
        result = JSON.parse(message.content)
      } catch {
        result = message.content
      }
      const path = typeof message.toolInput?.path === 'string' ? message.toolInput.path : null
      return { path, result, error: message.toolError ?? null, notes: (message.parts ?? []).filter((part) => part.kind === 'notice').map((part) => part.text) }
    })
}

/** Whether git, inside the agent folder, ignores `relPath` (the kit scaffold's own repository and gitignore). */
function gitIgnores(dir: string, relPath: string): { ignored: boolean; how: string } {
  if (existsSync(join(dir, '.git'))) {
    const out = spawnSync('git', ['-C', dir, 'check-ignore', '-v', relPath], { encoding: 'utf8' })
    return { ignored: out.status === 0, how: `git check-ignore -v → exit ${out.status} ${out.stdout.trim()}` }
  }
  const lines = existsSync(join(dir, '.gitignore')) ? readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').map((line) => line.trim()) : []
  const ignored = lines.includes('artifacts/') || lines.includes('/artifacts/')
  return { ignored, how: `no repository; the agent's .gitignore ${ignored ? 'lists' : 'does not list'} artifacts/` }
}

for (const { entry, engine, model: expectedModel } of ARTIFACT_ENGINES) test.describe(`on ${entry}`, () => {
  test.use({
    engine: true,
    realLogin: engine.realLogin,
    liveEngineCheck: { engine: engine.name, binary: engine.realLogin?.binary ?? null }
  })
  // One run may hold several engines: each one's artifacts carry its entry.
  const L2_TITLE = `${L2_BASE_TITLE} ${entry}`
  const L2_OTHER_TITLE = `${L2_OTHER_BASE_TITLE} ${entry}`

test(`${ENGINE_TEST_PREFIX}${entry}] a kit agent on ${engine.label} builds under artifacts/, publishes behind the card, republishes without one, and hears a Deny`, async ({ cinna }) => {
  test.setTimeout(900_000)
  if (engine.name === 'opencode') requireLiveKey()
  test.skip(engine.skipReason !== null, engine.skipReason ?? '')
  const config = live!
  await cinna.skipOnboarding()
  await signInDesktop(cinna, config)
  // OpenCode runs on the default chat mode: the `.env` OpenAI key, gpt-5.6-luna unless CINNA_E2E_LIVE_MODEL names another.
  if (engine.name === 'opencode') console.log(`live-artifacts L2 OpenCode default mode on ${await seedOpenAiDefaultMode(cinna)}`)
  const { dir } = await kitAgent(cinna, engine.runtime)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: `Start a new chat with ${KIT_AGENT}` }).click()

  let chatId = ''
  let artifactId = ''
  let url = ''
  let path = ''
  await test.step('asked in plain words, the agent builds under artifacts/ and publishes; Publish on the card returns the URL', async () => {
    const done = await turn(cinna, null,
      `Please write a short Markdown summary (two or three lines) of a good quarter for our company, and publish it as a Cinna artifact titled "${L2_TITLE}". Reply with the artifact's link.`,
      { approval: 'publish' })
    chatId = done.chatId
    expect(done.approvals).toBeGreaterThanOrEqual(1)
    const calls = await publishCalls(cinna, chatId)
    const published = calls.find((call) => call.result && typeof call.result === 'object' && call.result.artifact_id)
    expect(published, JSON.stringify(calls)).toBeTruthy()
    path = published!.path ?? ''
    console.log(`live-artifacts L2 ${entry} the agent published ${path}`)
    expect(path, JSON.stringify(calls)).toMatch(/^artifacts\/[^/]/)
    expect(existsSync(join(dir, path)), `${path} exists in the agent folder`).toBe(true)
    const ignore = gitIgnores(dir, path)
    console.log(`live-artifacts L2 ${entry} ${ignore.how}`)
    expect(ignore.ignored, ignore.how).toBe(true)
    artifactId = published!.result.artifact_id
    url = published!.result.url
    created.add(artifactId)
    console.log(`live-artifacts L2 ${entry} created artifact ${artifactId}`)
    expect(url).toMatch(new RegExp(`/artifact/${artifactId}$`))
    expect(done.reply).toContain(`/artifact/${artifactId}`)
    const { body } = await core(`/artifacts/${artifactId}`)
    expect(body).toMatchObject({ id: artifactId, title: L2_TITLE, visibility: 'private', source_kind: 'desktop', current_revision_number: 1 })
    expect(currentRevision(body).files.some((file: { path: string }) => file.path.endsWith('.md'))).toBe(true)
    // One card, the tool row's; the URL in the agent's reply stays a plain link since the transcript already draws it.
    await expect(page.locator('[data-artifact-tool="published"]').getByRole('group', { name: `Artifact ${L2_TITLE}`, exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: `Artifact ${L2_TITLE}`, exact: true })).toHaveCount(1)
    await expect(page.locator(`a[href="${url}"]`).first()).toBeVisible()
  })

  await test.step('asked to add a line and publish again, it does with no card, as rev 2', async () => {
    const done = await turn(cinna, chatId,
      `Add one more line to the summary in ${path}, then publish ${path} again to the same artifact. Reply with the link.`,
      { approval: 'none' })
    expect(done.approvals).toBe(0)
    const calls = await publishCalls(cinna, chatId)
    const last = calls[calls.length - 1]
    expect(last.path).toBe(path)
    expect(last.result, JSON.stringify(calls)).toMatchObject({ artifact_id: artifactId, revision: 2, url })
    expect(last.notes).toContain('Updated rev 2')
    const { body } = await core(`/artifacts/${artifactId}`)
    expect(body).toMatchObject({ id: artifactId, current_revision_number: 2, visibility: 'private' })
  })

  await test.step('asked to publish another note, Deny comes back to it and nothing new is on core', async () => {
    const before = (await core('/artifacts?limit=200')).body
    const done = await turn(cinna, chatId,
      `Now write a separate one-line Markdown note that says hello, and publish it as a new, separate Cinna artifact titled "${L2_OTHER_TITLE}". Tell me what happened.`,
      { approval: 'deny' })
    expect(done.approvals).toBeGreaterThanOrEqual(1)
    const calls = await publishCalls(cinna, chatId)
    const last = calls[calls.length - 1]
    expect(last.path, JSON.stringify(last)).toMatch(/^artifacts\/[^/]/)
    expect(last.path).not.toBe(path)
    expect(last, JSON.stringify(last)).toEqual({
      path: last.path,
      result: `The user declined to publish ${last.path}; do not retry unless they ask.`,
      error: true,
      notes: ['artifact-refusal:declined:you declined']
    })
    expect(done.reply).toMatch(/\b(not (been )?published|declined|denied|didn[’']t (get )?publish|wasn[’']t published|was not published|not publish)/i)
    const after = (await core('/artifacts?limit=200')).body
    expect(after.count).toBe(before.count)
    expect((after.data as Array<{ title: string }>).map((row) => row.title)).not.toContain(L2_OTHER_TITLE)
    await expect(page.getByText('Not published — you declined', { exact: true })).toBeVisible()
  })

  await test.step(`every turn ran on ${engine.label}`, async () => {
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
    const assistant = (chat?.messages ?? []).filter((message) => message.role === 'assistant')
    const models = assistant.map((message: any) => message.telemetry?.model).filter(Boolean) as string[]
    const cost = assistant.reduce((sum: number, message: any) => sum + (message.telemetry?.costUsd ?? 0), 0)
    console.log(`live-artifacts L2 ${entry} models ${JSON.stringify([...new Set(models)])}, estimated $${cost.toFixed(3)}`)
    // Only the Claude and Codex launchers report telemetry; the fixture's engine check proves the launcher either way.
    if (engine.name === 'claude' || engine.name === 'codex') expect(models.length, 'the turns report their model').toBeGreaterThan(0)
    if (expectedModel) for (const model of models) expect(model).toMatch(expectedModel)
  })
})
})

/** The title an approval card asks to publish under, from its accessible name. */
async function requestedTitle(approval: Locator): Promise<string> {
  return ((await approval.getAttribute('aria-label')) ?? '').replace(/^Publish request: /, '')
}

/** The successful `artifacts_publish` results in the chat, oldest first (every id already recorded for cleanup). */
async function publishedResults(cinna: CinnaApp, chatId: string): Promise<Array<{ path: string | null; artifact_id: string; url: string; revision: number }>> {
  return (await publishCalls(cinna, chatId))
    .filter((call) => call.result && typeof call.result === 'object' && typeof call.result.artifact_id === 'string')
    .map((call) => ({ path: call.path, ...call.result }))
}

test('L5 a real agent’s approval: Edit… publishes under the person’s title, and Publish from the Inbox with the chat not shown publishes', async ({ cinna }) => {
  l5Ran = true
  test.setTimeout(600_000)
  const config = live!
  await cinna.skipOnboarding()
  await signInDesktop(cinna, config)
  await kitAgent(cinna)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: `Start a new chat with ${KIT_AGENT}` }).click()

  let chatId = ''
  await test.step('Edit… on the card opens the dialog with the agent’s title; Publish puts the edited title on core', async () => {
    let asked = ''
    const done = await turn(cinna, null,
      // On the agent's own subject, with the figures given: it turns down other subjects as outside its role, and will not invent numbers.
      `Please put this two-line Markdown summary in a file: "Q3 sales rose 12%. Costs held flat." Then publish it as a Cinna artifact titled "${L5_AGENT_TITLE}". Reply with the artifact's link.`,
      {
        approval: async (approval) => {
          await expect(approval.getByRole('button')).toHaveText(['Deny', 'Edit…', 'Publish'])
          asked = await requestedTitle(approval)
          console.log(`live-artifacts L5 the agent asked to publish “${asked}”`)
          await approval.getByRole('button', { name: 'Edit…', exact: true }).click()
          const dialog = page.getByRole('dialog', { name: `Publish for ${KIT_AGENT}`, exact: true })
          await expect(dialog.getByRole('list', { name: 'Files to publish' })).not.toHaveAttribute('aria-busy', 'true')
          const title = dialog.getByLabel('Title', { exact: true })
          await expect(title).toHaveValue(asked)
          await title.fill(L5_EDITED_TITLE)
          await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
          await expect(dialog).toHaveCount(0, { timeout: 60_000 })
        }
      })
    chatId = done.chatId
    expect(done.approvals).toBe(1)
    expect(asked).not.toBe(L5_EDITED_TITLE)
    const results = await publishedResults(cinna, chatId)
    expect(results, JSON.stringify(await publishCalls(cinna, chatId))).toHaveLength(1)
    const { artifact_id: artifactId, url } = results[0]
    console.log(`live-artifacts L5 created artifact ${artifactId} (Edit…)`)
    const { status, body } = await core(`/artifacts/${artifactId}`)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ id: artifactId, title: L5_EDITED_TITLE, visibility: 'private', source_kind: 'desktop', current_revision_number: 1, url })
    // Core holds no artifact under the title the agent asked for.
    const titles = ((await core('/artifacts?limit=200')).body.data as Array<{ title: string }>).map((row) => row.title)
    expect(titles).not.toContain(asked)
    await expect(page.locator('[data-artifact-tool="published"]').getByRole('group', { name: `Artifact ${L5_EDITED_TITLE}`, exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: `Artifact ${asked}`, exact: true })).toHaveCount(0)
  })

  await test.step('the next request answered from the Inbox, with the chat not on screen, publishes', async () => {
    let asked = ''
    let inboxArtifact = ''
    const done = await turn(cinna, chatId,
      `Now put this one-line Markdown note in a separate file: "Q4 outlook: steady." Publish it as a new, separate Cinna artifact titled "${L5_INBOX_TITLE}". Reply with its link.`,
      {
        approval: async (approval, chat) => {
          asked = await requestedTitle(approval)
          console.log(`live-artifacts L5 the agent asked to publish “${asked}”`)
          await page.getByRole('button', { name: /^Inbox/ }).click()
          await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
          // The chat, and with it the card, is off screen: only the Inbox can answer now.
          await expect(page.locator('[data-artifact-approval]')).toHaveCount(0)
          const row = page.getByRole('article').filter({ hasText: `${KIT_AGENT} wants to publish “${asked}”` })
          await expect(row).toHaveCount(1, { timeout: 20_000 })
          await expect(row).toContainText(new RegExp(`${KIT_AGENT} wants to publish “[^”]+” — 1 file, \\d+ B, visible to only you\\.`))
          await row.getByRole('button', { name: 'Answer', exact: true }).click()
          const modal = page.getByLabel('Question', { exact: true })
          await modal.getByRole('button', { name: /^Publish/ }).click()
          await modal.getByRole('button', { name: 'Send answer', exact: true }).click()
          // Published while the Inbox is still the screen.
          await expect.poll(async () => (await publishedResults(cinna, chat)).length, { timeout: 60_000, message: 'the Inbox answer reaches the agent as a published result' }).toBe(2)
          inboxArtifact = (await publishedResults(cinna, chat))[1].artifact_id
          // An answered row stays in the Inbox, settled: the answer line, no Answer button.
          await expect(row.getByText('Answered: Publish.', { exact: true })).toBeVisible({ timeout: 20_000 })
          await expect(row.getByRole('button', { name: 'Answer', exact: true })).toHaveCount(0)
          expect(await page.evaluate((id) => window.api.artifacts.approvals(id), chat)).toEqual([])
          await page.getByRole('button', { name: 'Chats', exact: true }).click()
        }
      })
    expect(done.approvals).toBe(1)
    console.log(`live-artifacts L5 created artifact ${inboxArtifact} (Inbox)`)
    const results = await publishedResults(cinna, chatId)
    expect(results.map((result) => result.artifact_id)).toEqual([results[0].artifact_id, inboxArtifact])
    expect(inboxArtifact).not.toBe(results[0].artifact_id)
    const { status, body } = await core(`/artifacts/${inboxArtifact}`)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ id: inboxArtifact, title: asked, visibility: 'private', source_kind: 'desktop', current_revision_number: 1 })
    await expect(page.locator('[data-artifact-tool="published"]').getByRole('group', { name: `Artifact ${asked}`, exact: true })).toBeVisible({ timeout: 30_000 })
  })

  await test.step('every turn ran on haiku', async () => {
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
    const assistant = (chat?.messages ?? []).filter((message) => message.role === 'assistant')
    const models = assistant.map((message: any) => message.telemetry?.model).filter(Boolean) as string[]
    const cost = assistant.reduce((sum: number, message: any) => sum + (message.telemetry?.costUsd ?? 0), 0)
    console.log(`live-artifacts L5 models ${JSON.stringify([...new Set(models)])}, estimated $${cost.toFixed(3)}`)
    expect(models.length, 'the turns report their model').toBeGreaterThan(0)
    for (const model of models) expect(model).toMatch(/haiku/i)
  })
})

/** The framed artifact document on a core page: the frame whose URL is on the content route. */
async function artifactFrame(page: Page, title: string): Promise<Frame> {
  const element = page.locator(`iframe[title="${title}"]`)
  await expect(element).toBeVisible({ timeout: 30_000 })
  await expect(element).toHaveAttribute('sandbox', /allow-scripts/)
  const handle = await element.elementHandle()
  const frame = await handle!.contentFrame()
  if (!frame) throw new Error(`no frame document for ${title}`)
  return frame
}

/** What the L3 site shows once its script has run. */
async function expectSite(page: Page, title: string, heading: string): Promise<Frame> {
  const framed = page.frameLocator(`iframe[title="${title}"]`)
  await expect(framed.locator('h1')).toHaveText(heading, { timeout: 30_000 })
  await expect(framed.locator('#ran')).toHaveText('app.js ran')
  await expect(framed.locator('#rows')).toHaveText('3 rows')
  return artifactFrame(page, title)
}

test('L3 core’s web page shows what the desktop published: a public link, the owner page, a code link pinned to rev 1', async ({ cinna }) => {
  test.setTimeout(300_000)
  const config = live!
  expectNoAgentTurn()
  await cinna.skipOnboarding()
  await signInDesktop(cinna, config)
  const { dir, chatId } = await seededMention(cinna, {
    'web/index.html': webIndex(`Q3 ${TAG}`),
    'web/app.js': WEB_APP_JS,
    'web/data.csv': DATA_CSV
  }, 'web/', 'Where is the web report?', 'web-desk')

  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    let artifactId = ''
    let pageUrl = ''
    let linkUrl = ''
    await test.step('the desktop publishes the site and creates a public link from Share', async () => {
      const page = cinna.page
      await page.getByText('Where is the web report?', { exact: true }).first().click()
      const dialog = await openPublishOn(page, page.getByRole('button', { name: 'Show web/ in its folder', exact: true }))
      await expect(dialog.locator('[data-artifact-kind]')).toHaveText('Mini-site · opens index.html')
      await dialog.getByLabel('Title', { exact: true }).fill(L3_TITLE)
      await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect(dialog).toHaveCount(0, { timeout: 60_000 })
      await expect(card(page, L3_TITLE)).toContainText('rev 1 · only you')
      const cards = await page.evaluate((id) => window.api.artifacts.cards(id), chatId)
      expect(cards).toHaveLength(1)
      artifactId = cards[0].artifact.id
      pageUrl = cards[0].artifact.url
      created.add(artifactId)
      console.log(`live-artifacts L3 created artifact ${artifactId}`)

      // The card's drawer slides out on hover.

      await card(page, L3_TITLE).locator('[data-artifact-card-body]').hover()

      await card(page, L3_TITLE).getByRole('button', { name: `Share ${L3_TITLE}`, exact: true }).click()
      const share = page.getByRole('dialog', { name: `Share ${L3_TITLE}`, exact: true })
      await share.getByRole('button', { name: 'Create link', exact: true }).click()
      const fresh = share.locator('[data-artifact-fresh-link]')
      await expect(fresh).toContainText('Shown once — copy it now.', { timeout: 30_000 })
      linkUrl = (await fresh.locator('code').textContent()) ?? ''
      expect(linkUrl).toMatch(/\/s\/[^/?#]+$/)
      // Core's own frontend, wherever core says it is: the page URL and the link share its origin.
      expect(new URL(linkUrl).origin).toBe(new URL(pageUrl).origin)
      const links = (await core(`/artifacts/${artifactId}`)).body.links as Array<{ id: string }>
      for (const link of links) createdLinks.push({ artifactId, linkId: link.id })
      await page.keyboard.press('Escape')
    })

    await test.step('a signed-out browser on the link sees the site framed, its script run, under an opaque origin', async () => {
      const context = await browser!.newContext()
      const web = await context.newPage()
      const document = web.waitForResponse((response) => /\/a\/v\/[^?#]*index\.html(\?|$)/.test(response.url()), { timeout: 30_000 })
      await web.goto(linkUrl)
      await expect(web.getByRole('heading', { name: L3_TITLE, exact: true })).toBeVisible({ timeout: 30_000 })
      const frame = await expectSite(web, L3_TITLE, `Q3 ${TAG}`)
      const response = await document
      const csp = (await response.allHeaders())['content-security-policy'] ?? ''
      expect(csp, csp).toMatch(/(^|;)\s*sandbox\b/)
      expect(csp, csp).not.toMatch(/allow-same-origin/)
      expect(await frame.evaluate(() => self.origin)).toBe('null')
      expect(await frame.evaluate(() => {
        try {
          return `readable: ${window.localStorage.length}`
        } catch (err) {
          return (err as Error).name
        }
      })).toBe('SecurityError')
      await context.close()
    })

    await test.step('the owner, signed in on core’s frontend, sees the artifact page render it', async () => {
      const jwt = await signIn(config)
      const context = await browser!.newContext()
      await context.addInitScript((token) => window.localStorage.setItem('access_token', token), jwt)
      const web = await context.newPage()
      await web.goto(pageUrl)
      await expectSite(web, L3_TITLE, `Q3 ${TAG}`)
      await context.close()
    })

    let pinned: { token: string; code: string; url: string } = { token: '', code: '', url: '' }
    await test.step('after rev 2, a link with a code pinned to rev 1 refuses a wrong code and shows rev 1 for the right one', async () => {
      const page = cinna.page
      writeFileSync(join(dir, 'web', 'index.html'), webIndex(`Q3 ${TAG} rev 2`))
      const dialog = await openPublishOn(page, page.getByRole('button', { name: 'Show web/ in its folder', exact: true }))
      await expect(dialog.getByRole('radio', { name: `Update “${L3_TITLE}” (rev 1)`, exact: true })).toBeChecked()
      await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect(dialog).toHaveCount(0, { timeout: 60_000 })
      await expect(card(page, L3_TITLE)).toContainText('rev 2 · only you')

      const detail = (await core(`/artifacts/${artifactId}`)).body
      const rev1 = (detail.revisions as Array<{ id: string; number: number }>).find((revision) => revision.number === 1)
      expect(rev1, JSON.stringify(detail.revisions)).toBeTruthy()
      // The desktop's Share offers neither a code nor a pin: core's own API, as its web page calls it.
      const made = await core(`/artifacts/${artifactId}/links`, { method: 'POST', body: { with_code: true, pinned_revision_id: rev1!.id, label: `e2e ${TAG}` } })
      expect(made.status, JSON.stringify(made.body)).toBe(200)
      createdLinks.push({ artifactId, linkId: made.body.id })
      expect(made.body).toMatchObject({ pinned_revision_number: 1 })
      expect(made.body.code).toMatch(/^\d{4}$/)
      pinned = { token: made.body.token, code: made.body.code, url: made.body.url }
      expect(new URL(pinned.url).origin).toBe(new URL(pageUrl).origin)

      const context = await browser!.newContext()
      const web = await context.newPage()
      await web.goto(pinned.url)
      await expect(web.getByText('Enter the 4-digit code you were given.', { exact: true })).toBeVisible({ timeout: 30_000 })
      const enter = async (code: string): Promise<void> => {
        for (let i = 0; i < 4; i++) await web.getByLabel(`Digit ${i + 1}`, { exact: true }).fill(code[i])
        await web.getByRole('button', { name: 'Continue', exact: true }).click()
      }
      const wrong = String((Number(pinned.code) + 1) % 10_000).padStart(4, '0')
      await enter(wrong)
      await expect(web.getByRole('alert')).toHaveText('Incorrect code. 2 attempts left.')
      await expect(web.locator(`iframe[title="${L3_TITLE}"]`)).toHaveCount(0)
      await enter(pinned.code)
      await expectSite(web, L3_TITLE, `Q3 ${TAG}`)
      await context.close()
    })

    await test.step('the plain link follows the artifact to rev 2', async () => {
      const context = await browser!.newContext()
      const web = await context.newPage()
      await web.goto(linkUrl)
      await expectSite(web, L3_TITLE, `Q3 ${TAG} rev 2`)
      await context.close()
    })

    await test.step('revoked, both links are gone', async () => {
      for (const { linkId } of createdLinks.filter((link) => link.artifactId === artifactId)) {
        const revoked = await core(`/artifacts/${artifactId}/links/${linkId}`, { method: 'DELETE' })
        expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
      }
      for (const url of [linkUrl, pinned.url]) {
        const token = /\/s\/([^/?#]+)$/.exec(url)?.[1] ?? ''
        expect((await core(`/artifact-links/${token}/info`, { auth: false })).status).toBe(404)
      }
    })
  } finally {
    await browser?.close()
  }
})

/** `CINNA_E2E_CLI_ACCOUNT_DIR`, absolute or relative to this repository; empty when unset. */
function cliAccountSource(): string {
  const raw = (process.env.CINNA_E2E_CLI_ACCOUNT_DIR ?? '').trim()
  if (!raw) return ''
  return isAbsolute(raw) ? raw : resolve(repoRoot, raw)
}

/** `cinna <args>` in the temp account folder; JSON mode's final `{"result": …}` line parsed. */
function cli(args: string[]): { status: number | null; result: any; stderr: string } {
  const out = spawnSync('cinna', args, { cwd: cliAccount!, encoding: 'utf8', timeout: 120_000, env: { ...process.env, CINNA_NO_INPUT: '1' } })
  const lines = (out.stdout ?? '').split('\n').filter((line) => line.trim().startsWith('{'))
  let result: any = null
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && 'result' in parsed) result = parsed
    } catch {
      // a progress line
    }
  }
  return { status: out.status, result, stderr: (out.stderr ?? '').slice(-2000) }
}

test('L4 the CLI publishes, the desktop draws the card for its URL, and a Share from the desktop is what the CLI shows', async ({ cinna }) => {
  test.setTimeout(240_000)
  const config = live!
  const source = cliAccountSource()
  test.skip(source === '', 'set CINNA_E2E_CLI_ACCOUNT_DIR in .env to an account workspace whose .cinna/account.json is for this core and account')
  test.skip(!existsSync(join(source, '.cinna', 'account.json')), 'CINNA_E2E_CLI_ACCOUNT_DIR has no .cinna/account.json')
  test.skip(spawnSync('cinna', ['--version'], { encoding: 'utf8' }).status !== 0, 'no cinna CLI on PATH')
  const account = JSON.parse(readFileSync(join(source, '.cinna', 'account.json'), 'utf8')) as { platform_url?: string }
  test.skip(new URL(account.platform_url ?? 'http://invalid').origin !== new URL(config.serverUrl).origin, `the CLI account is for ${account.platform_url}, not ${config.serverUrl}`)
  expectNoAgentTurn()
  // Only account.json travels: the CLI's memory and log land in this temp folder.
  cliAccount = mkdtempSync(join(tmpdir(), 'cinna-e2e-cli-'))
  mkdirSync(join(cliAccount, '.cinna'))
  copyFileSync(join(source, '.cinna', 'account.json'), join(cliAccount, '.cinna', 'account.json'))
  const report = join(cliAccount, 'cli-report')
  mkdirSync(report)
  writeFileSync(join(report, 'report.md'), `# CLI report ${TAG}\n\nRevenue grew in Q3.\n`)
  writeFileSync(join(report, 'numbers.csv'), DATA_CSV)

  let artifactId = ''
  let url = ''
  await test.step('cinna artifacts publish puts a private artifact on core for this account', async () => {
    const out = cli(['artifacts', 'publish', report, '--title', L4_TITLE, '--new', '--json'])
    // Recorded before any assertion, so a failed check still cleans it up.
    const madeId = out.result?.artifact_id
    if (typeof madeId === 'string' && UUID_PATTERN.test(madeId)) cliCreated.add(madeId)
    expect(out.status, out.stderr).toBe(0)
    expect(out.result, out.stderr).toMatchObject({ result: 'ok', action: 'created', revision: 1, title: L4_TITLE, kind: 'files', visibility: 'private', file_count: 2 })
    artifactId = out.result.artifact_id
    url = out.result.url
    cliCreated.add(artifactId)
    console.log(`live-artifacts L4 the CLI created artifact ${artifactId}`)
    const { status, body } = await core(`/artifacts/${artifactId}`)
    expect(status, `the CLI's account must be the .env account: ${JSON.stringify(body)}`).toBe(200)
    expect(body).toMatchObject({ id: artifactId, title: L4_TITLE, source_kind: 'cli', visibility: 'private', current_revision_number: 1, url })
  })

  await cinna.skipOnboarding()
  await signInDesktop(cinna, config)
  const instance = (await cinna.page.evaluate(() => window.api.artifacts.support())).instanceName ?? 'the instance'
  const question = 'Where did the CLI report go?'
  await cinna.page.evaluate(async ({ question, url }) => {
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title: question })
    await window.api.chat.addMessage(chat.id, { role: 'user', content: question })
    await window.api.chat.addMessage(chat.id, { role: 'assistant', content: `It is published here: ${url}` })
  }, { question, url })
  await cinna.relaunch()
  await cinna.skipOnboarding()

  await test.step('the URL in an assistant message is drawn as the artifact’s card', async () => {
    const page = cinna.page
    await page.getByText(question, { exact: true }).first().click()
    await expect(card(page, L4_TITLE)).toBeVisible({ timeout: 30_000 })
    await expect(card(page, L4_TITLE)).toContainText('rev 1 · only you')
    await expect(card(page, L4_TITLE).getByRole('button', { name: `Open ${L4_TITLE}`, exact: true })).toBeVisible()
  })

  await test.step('Everyone on the instance from the card’s Share is what cinna artifacts show reports', async () => {
    const page = cinna.page
    // The card's drawer slides out on hover.
    await card(page, L4_TITLE).locator('[data-artifact-card-body]').hover()
    await card(page, L4_TITLE).getByRole('button', { name: `Share ${L4_TITLE}`, exact: true }).click()
    const share = page.getByRole('dialog', { name: `Share ${L4_TITLE}`, exact: true })
    const everyone = share.getByRole('radio', { name: `Everyone on ${instance}`, exact: true })
    await expect(everyone).toBeEnabled({ timeout: 30_000 })
    await everyone.click()
    await expect(everyone).toBeChecked({ timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(card(page, L4_TITLE)).toContainText(`rev 1 · everyone on ${instance}`)
    const shown = cli(['artifacts', 'show', artifactId, '--json'])
    expect(shown.status, shown.stderr).toBe(0)
    expect(shown.result?.artifact, shown.stderr).toMatchObject({ id: artifactId, title: L4_TITLE, visibility: 'instance', source_kind: 'cli' })
  })
})
