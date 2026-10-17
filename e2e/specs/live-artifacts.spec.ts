import { realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { answerAgentsFolder, homeDir, test, expect, type CinnaApp } from '../fixtures/app'
import { LIVE_REQUESTED } from '../fixtures/live'
import { claudeBinary, claudeLoginProblem, expectNoAgentTurn } from '../fixtures/liveEngine'
import { approveDesktopAuth, preflight, requireLiveCinna, signIn, type LiveCinnaConfig } from '../fixtures/liveCinna'

/**
 * Artifacts against the developer's **real local cinna-core**, with **real
 * Claude Code** for the agent's own publish.
 *
 * ## What is real
 *
 * Everything: the desktop's OAuth into core (PKCE, code, token exchange,
 * userinfo — only the consent click is done over the API by
 * `approveDesktopAuth`), core's discovery `artifacts: 1`, the desktop's walk,
 * zip and multipart upload, core's ingest, revision manifest, visibility,
 * public links and the sandboxed content origin; and in L2 the developer's own
 * `claude` (their login, on `haiku`) calling `artifacts_publish` on the
 * session's `cinna` MCP server.
 *
 * ## Running it
 *
 * `make e2e-one SPEC=e2e/specs/live-artifacts.spec.ts` with `.env` holding
 * `CINNA_E2E_SERVER_URL` / `_EMAIL` / `_PASSWORD` (an account on a core whose
 * discovery says `artifacts: 1`) and a logged-in `claude` (`CINNA_E2E_CLAUDE_PATH`
 * or `~/.local/bin/claude`). Skips otherwise. Runs under the real-`HOME`
 * exception (`realLogin.ts`): throwaway userData, a fresh `~/.cinna-e2e-claude-*`
 * folder for the agent, removed afterwards with Claude's session records for it.
 *
 * ## What it costs and leaves
 *
 * L1 runs no model turn (the agent's mention is a seeded message). L2 runs
 * three Claude turns on `haiku` on the developer's subscription. Each test
 * registers one desktop OAuth client on core (as `cinna-integration.spec.ts`
 * does); artifacts it created are hard-deleted in `afterAll` by the exact ids
 * recorded here, never by title.
 *
 * ## What it does not prove
 *
 * Core's web page rendering the artifact, a link with a code, a pinned link,
 * Edit… on an approval, the Inbox's own answer path. A kit agent publishing
 * what it wrote: its conversation prompt says to write only under `app-data/`,
 * which is never published — so the agent here is a bare folder.
 */

const BINARY = claudeBinary()
const TAG = `${Date.now().toString(36)}`
const AGENT = 'Artifact Desk'
const L1_TITLE = `E2E artifacts site ${TAG}`
const L2_TITLE = `E2E artifacts summary ${TAG}`

const INDEX_HTML = `<!doctype html>\n<html><head><meta charset="utf-8"><title>Q3</title><script src="./app.js"></script></head>\n<body><h1>Q3 ${TAG}</h1></body></html>\n`
const APP_JS = `document.title = 'Q3 ${TAG}'\n`
const DATA_CSV = 'month,revenue\nJul,10\nAug,11\nSep,12\n'

/** Every artifact id this run created on core: deleted in `afterAll`, exactly these. */
const created = new Set<string>()
let live: LiveCinnaConfig | null = null

test.use({
  engine: true,
  realLogin: BINARY ? { engine: 'claude', binary: BINARY, pathSetting: 'localAgentsClaudePath' } : null,
  liveEngineCheck: BINARY ? { engine: 'claude', binary: BINARY } : null
})

test.beforeEach(async () => {
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
  live = requireLiveCinna()
  test.skip(BINARY === null, 'no Claude Code binary (set CINNA_E2E_CLAUDE_PATH, or install ~/.local/bin/claude)')
  const login = claudeLoginProblem(BINARY!)
  test.skip(login !== null, login ?? '')
  const ready = await preflight(live)
  test.skip(!ready.ok, ready.ok ? '' : `live cinna-core not usable: ${ready.reason}`)
  test.skip((ready as { discovery: { artifacts?: number } }).discovery.artifacts === undefined, `${live.serverUrl} does not advertise artifacts`)
})

test.afterAll(async () => {
  if (!live || created.size === 0) return
  const token = await signIn(live)
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
async function bareAgent(cinna: CinnaApp, files: Record<string, string>): Promise<{ agentId: string; dir: string }> {
  const dir = homeDir(cinna, 'artifact-desk')
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

function card(page: Page, title: string): Locator {
  return page.getByRole('group', { name: `Artifact ${title}`, exact: true })
}

async function openPublishOn(page: Page, link: Locator): Promise<Locator> {
  await link.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Message actions', exact: true })
  await menu.getByRole('menuitem', { name: 'Publish…', exact: true }).click()
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
  const { agentId, dir } = await bareAgent(cinna, {
    'site/index.html': INDEX_HTML,
    'site/app.js': APP_JS,
    'site/data.csv': DATA_CSV,
    'site/.env': 'SITE_TOKEN=e2e-not-a-real-token\n',
    'site/node_modules/x.js': 'module.exports = 1\n'
  })
  // The agent's mention, seeded: what is under test is the publish, not the model.
  const chatId = await cinna.page.evaluate(async (id) => {
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { agentId: id, router: 'direct', title: 'Where is the Q3 site?' })
    await window.api.chat.addMessage(chat.id, { role: 'user', content: 'Where is the Q3 site?' })
    await window.api.chat.addMessage(chat.id, { role: 'assistant', content: 'The Q3 site is in `site/`.' })
    return chat.id
  }, agentId)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
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

    const links = (await core(`/artifacts/${artifactId}`)).body.links as Array<{ token_prefix: string; revoked_at: string | null }>
    expect(links.filter((link) => link.revoked_at === null)).toHaveLength(1)
    await share.getByRole('button', { name: `Revoke link ${links[0].token_prefix}`, exact: true }).click()
    await share.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(share.locator('[data-artifact-link="revoked"]')).toContainText('Revoked', { timeout: 30_000 })
    expect((await core(`/artifact-links/${token}/info`, { auth: false })).status).toBe(404)
    expect((await core(`/artifact-links/${token}/open`, { method: 'POST', auth: false, body: {} })).status).toBeGreaterThanOrEqual(400)
    await page.keyboard.press('Escape')
  })
})

interface TurnWatch {
  /** What to do when an approval card shows: answer it, or fail the turn for showing one. */
  approval: 'publish' | 'deny' | 'none'
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
  await expect.poll(async () => {
    if (!id) {
      const chats = await page.evaluate(() => window.api.chat.list())
      id = chats.find((row) => row.agentId !== null)?.id ?? null
      if (!id) return 'no chat yet'
    }
    const allow = page.getByRole('button', { name: 'Allow once', exact: true })
    if (await allow.count() > 0) await allow.first().click().catch(() => undefined)
    if (await approvalCard.count() > 0) {
      approvals += 1
      if (watch.approval === 'none') return 'an approval card appeared'
      await approvalCard.first().getByRole('button', { name: watch.approval === 'publish' ? 'Publish' : 'Deny', exact: true }).click().catch(() => undefined)
      await expect(approvalCard).toHaveCount(0, { timeout: 30_000 })
    }
    const chat = await page.evaluate((chat) => window.api.chat.get(chat), id)
    const messages = chat?.messages ?? []
    const last = messages[messages.length - 1]
    if (chat?.activeRunId || messages.length <= before + 1 || last?.role !== 'assistant' || !last.content) return 'running'
    return 'done'
  }, { timeout: 240_000, intervals: [500], message: `the turn for “${prompt.slice(0, 40)}…” ends` }).toBe('done')
  const chat = await page.evaluate((chat) => window.api.chat.get(chat), id!)
  const messages = chat!.messages
  return { chatId: id!, reply: messages[messages.length - 1].content, approvals }
}

/** This turn's `artifacts_publish` rows, oldest first: their parsed results and notes. */
async function publishCalls(cinna: CinnaApp, chatId: string) {
  const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
  return (chat?.messages ?? [])
    .filter((message) => message.role === 'tool_call' && message.toolName === 'artifacts_publish')
    .map((message) => {
      let result: any = null
      try {
        result = JSON.parse(message.content)
      } catch {
        result = message.content
      }
      return { result, error: message.toolError ?? null, notes: (message.parts ?? []).filter((part) => part.kind === 'notice').map((part) => part.text) }
    })
}

test('L2 real Claude publishes behind the card, republishes without one, and hears a Deny', async ({ cinna }) => {
  test.setTimeout(900_000)
  const config = live!
  await cinna.skipOnboarding()
  await signInDesktop(cinna, config)
  await bareAgent(cinna, {})
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  const toolName = 'mcp__cinna__artifacts_publish'

  let chatId = ''
  let artifactId = ''
  let url = ''
  await test.step('asked in plain words, the agent writes and publishes; Publish on the card returns the URL', async () => {
    const done = await turn(cinna, null,
      `Write a file report/summary.md with two short lines summarising a good quarter, then publish report/summary.md with the artifacts_publish tool (${toolName}) titled "${L2_TITLE}". Reply with the artifact's URL.`,
      { approval: 'publish' })
    chatId = done.chatId
    expect(done.approvals).toBeGreaterThanOrEqual(1)
    const calls = await publishCalls(cinna, chatId)
    const published = calls.find((call) => call.result && typeof call.result === 'object' && call.result.artifact_id)
    expect(published, JSON.stringify(calls)).toBeTruthy()
    artifactId = published!.result.artifact_id
    url = published!.result.url
    created.add(artifactId)
    console.log(`live-artifacts L2 created artifact ${artifactId}`)
    expect(url).toMatch(new RegExp(`/artifact/${artifactId}$`))
    expect(done.reply).toContain(`/artifact/${artifactId}`)
    const { body } = await core(`/artifacts/${artifactId}`)
    expect(body).toMatchObject({ id: artifactId, visibility: 'private', source_kind: 'desktop', current_revision_number: 1 })
    expect(currentRevision(body).files.map((file: { path: string }) => file.path)).toContain('summary.md')
    // One card, the tool row's; the URL in the agent's reply stays a plain link since the transcript already draws it.
    await expect(page.locator('[data-artifact-tool="published"]').getByRole('group', { name: `Artifact ${body.title}`, exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: `Artifact ${body.title}`, exact: true })).toHaveCount(1)
    await expect(page.locator(`a[href="${url}"]`).first()).toBeVisible()
  })

  await test.step('asked to update and publish again, it does with no card, as rev 2', async () => {
    const done = await turn(cinna, chatId,
      `Add one more line to report/summary.md, then publish report/summary.md again with ${toolName}, the same path. Reply with the URL.`,
      { approval: 'none' })
    expect(done.approvals).toBe(0)
    const calls = await publishCalls(cinna, chatId)
    const last = calls[calls.length - 1]
    expect(last.result, JSON.stringify(calls)).toMatchObject({ artifact_id: artifactId, revision: 2, url })
    expect(last.notes).toContain('Updated rev 2')
    const { body } = await core(`/artifacts/${artifactId}`)
    expect(body).toMatchObject({ id: artifactId, current_revision_number: 2, visibility: 'private' })
  })

  await test.step('asked to publish another file, Deny comes back to it and nothing new is on core', async () => {
    const before = (await core('/artifacts?limit=200')).body
    const done = await turn(cinna, chatId,
      `Write report/other.md with one line saying hello, then publish report/other.md with ${toolName} titled "E2E artifacts other ${TAG}". Tell me what happened.`,
      { approval: 'deny' })
    expect(done.approvals).toBeGreaterThanOrEqual(1)
    const calls = await publishCalls(cinna, chatId)
    const last = calls[calls.length - 1]
    expect(last, JSON.stringify(last)).toEqual({
      result: 'The user declined to publish report/other.md; do not retry unless they ask.',
      error: true,
      notes: ['artifact-refusal:declined:you declined']
    })
    expect(done.reply).toMatch(/\b(not (been )?published|declined|denied|didn[’']t (get )?publish|wasn[’']t published|was not published|not publish)/i)
    const after = (await core('/artifacts?limit=200')).body
    expect(after.count).toBe(before.count)
    expect((after.data as Array<{ title: string }>).map((row) => row.title)).not.toContain(`E2E artifacts other ${TAG}`)
    await expect(page.getByText('Not published — you declined', { exact: true })).toBeVisible()
  })

  await test.step('every turn ran on haiku', async () => {
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
    const assistant = (chat?.messages ?? []).filter((message) => message.role === 'assistant')
    const models = assistant.map((message: any) => message.telemetry?.model).filter(Boolean) as string[]
    const cost = assistant.reduce((sum: number, message: any) => sum + (message.telemetry?.costUsd ?? 0), 0)
    console.log(`live-artifacts L2 models ${JSON.stringify([...new Set(models)])}, estimated $${cost.toFixed(3)}`)
    expect(models.length, 'the turns report their model').toBeGreaterThan(0)
    for (const model of models) expect(model).toMatch(/haiku/i)
  })
})
