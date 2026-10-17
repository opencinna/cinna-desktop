import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { homeDir, test, expect, type CinnaApp } from '../fixtures/app'
import { LIVE_REQUESTED } from '../fixtures/live'
import { approveDesktopAuth, preflight, requireLiveCinna, signIn, type LiveCinnaConfig } from '../fixtures/liveCinna'

/**
 * Who can open an artifact, and what core's web page shows of it, against the
 * developer's **real local cinna-core** and its **real web frontend** in a
 * headless Chromium. No model turn: what is under test is core's access rules
 * and viewers, and the desktop's publish and card.
 *
 * - G — named people (A7). The desktop publishes a folder privately; two more
 *   users are made over core's admin API. A view grant to the second (over
 *   core's API: the desktop has no grant UI, by design) lets them read the
 *   artifact's detail and content and open its page in a browser signed in as
 *   them; the third gets 404 and "Artifact not found". A link card for the
 *   artifact in another desktop chat says `shared with 1 person`. Revoking
 *   the grant (PUT []) ends it everywhere, including a content capability the
 *   second user had already minted.
 * - G2 — the card the desktop drew when it published says the grant too, as
 *   `docs/chat/artifacts/artifacts.md` promises.
 * - K — link expiry and the code lock-out (A7). A link expiring a few seconds
 *   ahead opens before and refuses after (410 `This link has expired`, the
 *   page's expired screen, and a capability minted before expiry stops
 *   serving). A code link takes three wrong codes in the browser, then shows
 *   the blocked screen; the right code is refused afterwards too.
 * - V1 — non-site viewers (A5) on core's public link page: a `files` folder
 *   published from the desktop (Markdown with raw HTML and script, CSV, JSON,
 *   Python, an SVG carrying a script, a PDF) and a single Markdown file that
 *   opens straight in its viewer. Each renders, and no script runs: no
 *   `window.__pwned`, no request to the `pwned.invalid` marker host.
 * - V2 — a `.py` file is syntax-highlighted, as plan A5 says code is (core
 *   b09cd499 onwards).
 *
 * ## Running it
 *
 * `make e2e-one SPEC=e2e/specs/live-artifacts-access.spec.ts` with `.env`
 * holding `CINNA_E2E_SERVER_URL` / `_EMAIL` / `_PASSWORD` for a **superuser**
 * on a disposable local core whose discovery says `artifacts: 1`, with its
 * frontend running. Skips otherwise.
 *
 * ## What it leaves
 *
 * Nothing it can find again. Every artifact, link and user it creates is
 * recorded by id **before** any assertion; `afterAll` revokes those links,
 * deletes those artifacts, and deletes those users by exact id — and only
 * when core still holds that id under the email this run gave it. Each desktop test
 * registers one OAuth client on core, as the other live specs do.
 */

const TAG = Date.now().toString(36)
const MARKER = `artifacts-access-e2e-${TAG}`
const AGENT = 'Access Desk'
const G_TITLE = `E2E access grants ${TAG}`
const G2_TITLE = `E2E access card ${TAG}`
const K_TITLE = `E2E access links ${TAG}`
const V_FILES_TITLE = `E2E access viewers ${TAG}`
const V_SINGLE_TITLE = `E2E access single ${TAG}`
const V2_TITLE = `E2E access python ${TAG}`
const PWNED = 'pwned.invalid'

/** Every artifact this run created: deleted in `afterAll`, exactly these. */
const created = new Set<string>()
/** Links this run created, revoked by id in `afterAll`. */
const createdLinks: Array<{ artifactId: string; linkId: string }> = []
/** Users this run created over the admin API: id → the email it was made with. */
const createdUsers = new Map<string, string>()
let live: LiveCinnaConfig | null = null

test.beforeEach(async () => {
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
  live = requireLiveCinna()
  const ready = await preflight(live)
  test.skip(!ready.ok, ready.ok ? '' : `live cinna-core not usable: ${ready.reason}`)
  test.skip((ready as { discovery: { artifacts?: number } }).discovery.artifacts === undefined, `${live.serverUrl} does not advertise artifacts`)
})

test.afterAll(async () => {
  if (!live) return
  const token = await signIn(live)
  const call = (path: string): Promise<Response> => fetch(`${live!.serverUrl}/api/v1${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  for (const { artifactId, linkId } of createdLinks) {
    console.log(`live-artifacts-access cleanup: DELETE link ${linkId} → HTTP ${(await call(`/artifacts/${artifactId}/links/${linkId}`)).status}`)
  }
  for (const id of created) {
    console.log(`live-artifacts-access cleanup: DELETE artifact ${id} → HTTP ${(await call(`/artifacts/${id}`)).status}`)
  }
  for (const [id, email] of createdUsers) {
    // Exact id, and only while core still holds it under this run's email.
    const response = await fetch(`${live!.serverUrl}/api/v1/users/${id}`, { headers: { Authorization: `Bearer ${token}` } })
    const held = response.ok ? ((await response.json()) as { email?: string }).email : undefined
    if (held !== email || !email.startsWith(`${MARKER}-`)) {
      console.log(`live-artifacts-access cleanup: user ${id} not deleted (HTTP ${response.status}, email ${held ?? '-'})`)
      continue
    }
    console.log(`live-artifacts-access cleanup: DELETE user ${id} (${email}) → HTTP ${(await call(`/users/${id}`)).status}`)
  }
})

interface Reply {
  status: number
  body: any
}

/** One JSON call to core: as the configured account unless `token` says otherwise (`null` = no auth). */
async function api(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<Reply> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = init.token === undefined ? await signIn(live!) : init.token
  if (token) headers.Authorization = `Bearer ${token}`
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${live!.serverUrl}/api/v1${path}`, {
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
  return { status: response.status, body }
}

async function loginAs(email: string, password: string): Promise<string> {
  const response = await fetch(`${live!.serverUrl}/api/v1/login/access-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: email, password }).toString()
  })
  const body = (await response.json()) as { access_token?: string }
  if (!response.ok || !body.access_token) throw new Error(`could not sign in as ${email}: HTTP ${response.status}`)
  return body.access_token
}

/** A user made over core's admin API, recorded before anything is asserted about it. */
async function makeUser(letter: string): Promise<{ id: string; email: string; token: string }> {
  const email = `${MARKER}-${letter}@example.com`
  const password = `E2e-${TAG}-${letter}-Pw9!`
  const made = await api('/users/', { method: 'POST', body: { email, password, full_name: `Artifacts access e2e ${TAG} ${letter.toUpperCase()}` } })
  if (typeof made.body?.id === 'string') createdUsers.set(made.body.id, email)
  expect(made.status, JSON.stringify(made.body)).toBe(200)
  console.log(`live-artifacts-access created user ${made.body.id} (${email})`)
  return { id: made.body.id, email, token: await loginAs(email, password) }
}

/** A `files` artifact published over core's API (`files[]`, each filename its path). */
async function publishOverApi(title: string, files: Record<string, string | Buffer>): Promise<{ id: string; url: string }> {
  const form = new FormData()
  form.append('title', title)
  for (const [path, content] of Object.entries(files)) form.append('files', new Blob([typeof content === 'string' ? content : Uint8Array.from(content)]), path)
  const response = await fetch(`${live!.serverUrl}/api/v1/artifacts`, { method: 'POST', headers: { Authorization: `Bearer ${await signIn(live!)}` }, body: form })
  const body = await response.json() as any
  const id = body?.artifact?.id ?? body?.id
  if (typeof id === 'string') created.add(id)
  expect(response.status, JSON.stringify(body)).toBe(200)
  console.log(`live-artifacts-access published artifact ${id} over the API`)
  const detail = await api(`/artifacts/${id}`)
  return { id, url: detail.body.url }
}

/** A plain link over core's API, recorded before it is asserted on. */
async function makeLink(artifactId: string, body: Record<string, unknown>): Promise<{ id: string; token: string; url: string; code: string | null; status: number; raw: any }> {
  const made = await api(`/artifacts/${artifactId}/links`, { method: 'POST', body: { label: `e2e ${TAG}`, ...body } })
  if (typeof made.body?.id === 'string') createdLinks.push({ artifactId, linkId: made.body.id })
  return { id: made.body?.id, token: made.body?.token, url: made.body?.url, code: made.body?.code ?? null, status: made.status, raw: made.body }
}

/** The configured account signs the profile in through the real desktop OAuth flow (consent over the API), then a restart. */
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
  await expect.poll(() => cinna.electronApp.evaluate(() => (globalThis as unknown as { __authorizeUrl?: string }).__authorizeUrl ?? ''), {
    timeout: 30_000,
    message: 'the app never asked to open an authorization URL'
  }).not.toBe('')
  const authorizeUrl = await cinna.electronApp.evaluate(() => (globalThis as unknown as { __authorizeUrl?: string }).__authorizeUrl as string)
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
  expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.type).toBe('cinna_user')
  await expect.poll(() => cinna.page.evaluate(() => window.api.artifacts.support()).then((s) => s.supported), { timeout: 30_000 }).toBe(true)
}

/**
 * A bare folder agent holding `files`, and a chat where it mentions
 * `mention`; relaunched and rescanned so the chat and the reference resolve.
 * No runtime is set: no turn runs.
 */
async function seededMention(cinna: CinnaApp, files: Record<string, string | Buffer>, mention: string, question: string, folder: string): Promise<{ dir: string; chatId: string }> {
  const dir = homeDir(cinna, folder)
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${AGENT}\n\nYou keep reports for your owner in this folder.\n`)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  await cinna.stubDirectoryPicker(dir)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled || pick.refusal !== null) throw new Error(`the folder was refused: ${JSON.stringify(pick)}`)
  const added = await cinna.page.evaluate((input) => window.api.localAgents.folderAdd(input), { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) })
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
  const real = realpathSync(dir)
  const agent = (await cinna.page.evaluate(() => window.api.localAgents.list())).agents.find((row) => row.path !== null && realpathSync(row.path) === real)
  if (!agent) throw new Error(`no agent row for ${dir}`)
  const chatId = await cinna.page.evaluate(async ({ id, mention, question }) => {
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { agentId: id, router: 'direct', title: question })
    await window.api.chat.addMessage(chat.id, { role: 'user', content: question })
    await window.api.chat.addMessage(chat.id, { role: 'assistant', content: mention })
    return chat.id
  }, { id: agent.id, mention, question })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { dir, chatId }
}

function card(page: Page, title: string): Locator {
  return page.getByRole('group', { name: `Artifact ${title}`, exact: true })
}

/** Publish… decides on support when the menu opens; reopen until main has finished core's discovery. */
async function openPublishOn(page: Page, link: Locator): Promise<Locator> {
  await expect.poll(() => page.evaluate(() => window.api.artifacts.support()).then((s) => s.supported), { timeout: 30_000 }).toBe(true)
  const menu = page.getByRole('menu', { name: 'Message actions', exact: true })
  const publish = menu.getByRole('menuitem', { name: 'Publish…', exact: true })
  await expect(async () => {
    if (await menu.count() > 0) await page.keyboard.press('Escape')
    await link.click({ button: 'right' })
    await expect(publish).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await publish.click()
  const dialog = page.getByRole('dialog', { name: 'Publish to Cinna', exact: true })
  await expect(dialog.getByRole('list', { name: 'Files to publish' })).not.toHaveAttribute('aria-busy', 'true')
  return dialog
}

/** Publish what `link` names as `title`, Only me; returns the new card's artifact id (recorded) and core URL. */
async function publishFromDesktop(cinna: CinnaApp, chatId: string, link: Locator, title: string, kindLine: string): Promise<{ id: string; url: string }> {
  const page = cinna.page
  const before = new Set((await page.evaluate((id) => window.api.artifacts.cards(id), chatId)).map((row) => row.artifact.id))
  const dialog = await openPublishOn(page, link)
  await expect(dialog.locator('[data-artifact-kind]')).toHaveText(kindLine)
  await dialog.getByLabel('Title', { exact: true }).fill(title)
  await expect(dialog.getByRole('radio', { name: 'Only me', exact: true })).toBeChecked()
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 60_000 })
  let fresh: { id: string; url: string } | null = null
  await expect.poll(async () => {
    const cards = await page.evaluate((id) => window.api.artifacts.cards(id), chatId)
    const row = cards.find((entry) => !before.has(entry.artifact.id))
    if (row) fresh = { id: row.artifact.id, url: row.artifact.url }
    return fresh !== null
  }, { timeout: 30_000 }).toBe(true)
  created.add(fresh!.id)
  console.log(`live-artifacts-access published artifact ${fresh!.id} (${title}) from the desktop`)
  await expect(card(page, title)).toContainText('rev 1 · only you')
  return fresh!
}

/** A browser context that is signed in on core's frontend as `jwt` (where the frontend keeps it). */
async function signedInContext(browser: Browser, jwt: string): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.addInitScript((token) => window.localStorage.setItem('access_token', token), jwt)
  return context
}

/** Every request a context makes to the marker host: a script that ran would have called it. */
function watchPwned(context: BrowserContext): string[] {
  const hits: string[] = []
  context.on('request', (request) => {
    if (request.url().includes(PWNED)) hits.push(request.url())
  })
  return hits
}

async function pwnedFlag(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned ?? null)
}

/* ------------------------------------------------------------------ G, G2 */

const BRIEF_MD = `# Brief ${TAG}\n\nOnly the people it is shared with read this.\n`
const BRIEF_CSV = 'quarter,deals\nQ3,7\n'

test('G a view grant lets the named person open the artifact and its page, a third cannot, and revoking it ends access', async ({ cinna }) => {
  test.setTimeout(300_000)
  const config = live!
  await cinna.skipOnboarding()
  await signInDesktop(cinna, config)
  const { chatId } = await seededMention(cinna, { 'brief/notes.md': BRIEF_MD, 'brief/figures.csv': BRIEF_CSV }, 'It is in `brief/`.', 'Where is the brief?', 'access-desk')
  await cinna.page.getByText('Where is the brief?', { exact: true }).first().click()
  const { id: artifactId, url: pageUrl } = await publishFromDesktop(cinna, chatId, cinna.page.getByRole('button', { name: 'Show brief/ in its folder', exact: true }), G_TITLE, '2 files')

  const b = await makeUser('b')
  const c = await makeUser('c')
  let browser: Browser | null = null
  try {
    browser = await chromium.launch()

    await test.step('before any grant, neither person can read it', async () => {
      for (const person of [b, c]) {
        expect((await api(`/artifacts/${artifactId}`, { token: person.token })).status).toBe(404)
        expect((await api(`/artifacts/${artifactId}/view`, { method: 'POST', token: person.token })).status).toBe(404)
      }
    })

    let bCap = ''
    await test.step('PUT grants with B as view: core lists exactly B; B reads the detail and the content', async () => {
      const put = await api(`/artifacts/${artifactId}/grants`, { method: 'PUT', body: [{ principal: { user_id: b.id }, access: 'view' }] })
      expect(put.status, JSON.stringify(put.body)).toBe(200)
      expect(put.body).toHaveLength(1)
      expect(put.body[0]).toMatchObject({ principal: { user_id: b.id }, access: 'view', email: b.email })
      const owner = await api(`/artifacts/${artifactId}`)
      expect(owner.body.grant_count, JSON.stringify(owner.body)).toBe(1)

      const detail = await api(`/artifacts/${artifactId}`, { token: b.token })
      expect(detail.status, JSON.stringify(detail.body)).toBe(200)
      expect(detail.body).toMatchObject({ id: artifactId, title: G_TITLE, is_owner: false })
      const view = await api(`/artifacts/${artifactId}/view`, { method: 'POST', token: b.token })
      expect(view.status, JSON.stringify(view.body)).toBe(200)
      bCap = view.body.content_base
      const content = await fetch(`${bCap}notes.md`)
      expect(content.status).toBe(200)
      expect(await content.text()).toBe(BRIEF_MD)
    })

    await test.step('C, not named, still gets 404 from the detail and the view', async () => {
      expect((await api(`/artifacts/${artifactId}`, { token: c.token })).status).toBe(404)
      expect((await api(`/artifacts/${artifactId}/view`, { method: 'POST', token: c.token })).status).toBe(404)
    })

    await test.step('on core’s frontend, B’s browser renders the page; C’s says it was not found', async () => {
      const asB = await signedInContext(browser!, b.token)
      const webB = await asB.newPage()
      await webB.goto(`${pageUrl}?file=notes.md`)
      await expect(webB.getByRole('heading', { name: `Brief ${TAG}`, exact: true })).toBeVisible({ timeout: 30_000 })
      await asB.close()

      const asC = await signedInContext(browser!, c.token)
      const webC = await asC.newPage()
      await webC.goto(`${pageUrl}?file=notes.md`)
      await expect(webC.getByText('Artifact not found', { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(webC.getByText('This artifact doesn\'t exist or you can\'t open it.', { exact: true })).toBeVisible()
      await expect(webC.getByRole('heading', { name: `Brief ${TAG}`, exact: true })).toHaveCount(0)
      await asC.close()
    })

    await test.step('a desktop link card for the artifact, in another chat, says it is shared with 1 person', async () => {
      const otherChat = await cinna.page.evaluate(async (url) => {
        const chat = await window.api.chat.create()
        await window.api.chat.update(chat.id, { title: 'Who has the brief?' })
        await window.api.chat.addMessage(chat.id, { role: 'user', content: 'Who has the brief?' })
        await window.api.chat.addMessage(chat.id, { role: 'assistant', content: `The brief: ${url}` })
        return chat.id
      }, pageUrl)
      expect(otherChat).toBeTruthy()
      await cinna.relaunch()
      await cinna.skipOnboarding()
      const page = cinna.page
      await page.getByText('Who has the brief?', { exact: true }).first().click()
      await expect(card(page, G_TITLE)).toContainText('rev 1 · only you · shared with 1 person', { timeout: 30_000 })
    })

    await test.step('PUT grants [] revokes B: detail, view, B’s minted capability and B’s page all refuse', async () => {
      const put = await api(`/artifacts/${artifactId}/grants`, { method: 'PUT', body: [] })
      expect(put.status, JSON.stringify(put.body)).toBe(200)
      expect(put.body).toEqual([])
      expect((await api(`/artifacts/${artifactId}`, { token: b.token })).status).toBe(404)
      expect((await api(`/artifacts/${artifactId}/view`, { method: 'POST', token: b.token })).status).toBe(404)
      const stale = await fetch(`${bCap}notes.md`)
      console.log(`live-artifacts-access G: B's capability after revoke → HTTP ${stale.status}`)
      expect(stale.status).toBeGreaterThanOrEqual(400)

      const asB = await signedInContext(browser!, b.token)
      const webB = await asB.newPage()
      await webB.goto(`${pageUrl}?file=notes.md`)
      await expect(webB.getByText('Artifact not found', { exact: true })).toBeVisible({ timeout: 30_000 })
      await asB.close()
    })
  } finally {
    await browser?.close()
  }
})

test('G2 the card the desktop drew when it published shows a grant made on core', async ({ cinna }) => {
  // The owner's card reads core's detail for its audience line, since grants
  // are made on core's page and never reach the stored PublishedArtifact.
  test.setTimeout(240_000)
  const config = live!
  await cinna.skipOnboarding()
  await signInDesktop(cinna, config)
  const { chatId } = await seededMention(cinna, { 'memo.md': `# Memo ${TAG}\n` }, 'It is in `memo.md`.', 'Where is the memo?', 'memo-desk')
  await cinna.page.getByText('Where is the memo?', { exact: true }).first().click()
  const { id: artifactId } = await publishFromDesktop(cinna, chatId, cinna.page.getByRole('button', { name: 'Preview memo.md', exact: true }), G2_TITLE, 'Markdown document')
  const b = await makeUser('d')
  const put = await api(`/artifacts/${artifactId}/grants`, { method: 'PUT', body: [{ principal: { user_id: b.id }, access: 'view' }] })
  expect(put.status, JSON.stringify(put.body)).toBe(200)

  const page = cinna.page
  // Share… reads core's current state when it opens: the refresh the card has.
  // The card's drawer slides out on hover.
  await card(page, G2_TITLE).locator('[data-artifact-card-body]').hover()
  await card(page, G2_TITLE).getByRole('button', { name: `Share ${G2_TITLE}`, exact: true }).click()
  const share = page.getByRole('dialog', { name: `Share ${G2_TITLE}`, exact: true })
  await expect(share.getByRole('radio', { name: 'Only me', exact: true })).toBeEnabled({ timeout: 30_000 })
  await page.keyboard.press('Escape')
  await expect(card(page, G2_TITLE)).toContainText('rev 1 · only you · shared with 1 person', { timeout: 15_000 })
})

/* ---------------------------------------------------------------------- K */

const K_MD = `# Links ${TAG}\n\nOpened through a link.\n`

test('K a link opens until its expiry and refuses after; a code link blocks after three wrong codes, the right one included', async () => {
  test.setTimeout(180_000)
  const { id: artifactId } = await publishOverApi(K_TITLE, { 'links.md': K_MD })
  let browser: Browser | null = null
  try {
    browser = await chromium.launch()

    await test.step('an expiry in the past is refused', async () => {
      const past = await makeLink(artifactId, { expires_at: new Date(Date.now() - 60_000).toISOString() })
      expect(past.status, JSON.stringify(past.raw)).toBe(422)
      expect(past.raw).toEqual({ detail: 'Expiry must be in the future' })
    })

    await test.step('a link expiring seconds ahead opens before its expiry, and refuses after it', async () => {
      const expiresAt = new Date(Date.now() + 8_000)
      const link = await makeLink(artifactId, { expires_at: expiresAt.toISOString() })
      expect(link.status, JSON.stringify(link.raw)).toBe(200)
      expect(link.raw.expired).toBe(false)

      const context = await browser!.newContext()
      const web = await context.newPage()
      await web.goto(link.url)
      await expect(web.getByRole('heading', { name: `Links ${TAG}`, exact: true })).toBeVisible({ timeout: 30_000 })
      const opened = await api(`/artifact-links/${link.token}/open`, { method: 'POST', body: {}, token: null })
      expect(opened.status, JSON.stringify(opened.body)).toBe(200)
      const cap = opened.body.content_base as string
      expect((await fetch(`${cap}links.md`)).status).toBe(200)
      expect(Date.now(), 'the link was not opened before its expiry: the run is too slow for an 8 s expiry').toBeLessThan(expiresAt.getTime())

      await expect.poll(async () => (await api(`/artifact-links/${link.token}/info`, { token: null })).body?.expired, { timeout: 30_000, intervals: [1_000] }).toBe(true)
      const refused = await api(`/artifact-links/${link.token}/open`, { method: 'POST', body: {}, token: null })
      expect(refused).toEqual({ status: 410, body: { detail: 'This link has expired' } })
      const stale = await fetch(`${cap}links.md`)
      console.log(`live-artifacts-access K: a capability minted before expiry, after it → HTTP ${stale.status}`)
      expect(stale.status).toBeGreaterThanOrEqual(400)

      await web.reload()
      await expect(web.getByRole('heading', { name: 'Unable to open', exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(web.getByText('This link has expired. Ask the person who shared it for a new one.', { exact: true })).toBeVisible()
      await expect(web.getByRole('heading', { name: `Links ${TAG}`, exact: true })).toHaveCount(0)
      await context.close()

      const owner = (await api(`/artifacts/${artifactId}`)).body.links.find((row: { id: string }) => row.id === link.id)
      expect(owner).toMatchObject({ expired: true, blocked: false })
    })

    await test.step('three wrong codes in the browser block the link; the right code is then refused too', async () => {
      const link = await makeLink(artifactId, { with_code: true })
      expect(link.status, JSON.stringify(link.raw)).toBe(200)
      expect(link.code).toMatch(/^\d{4}$/)
      const code = link.code!
      const wrong = (n: number): string => String((Number(code) + n) % 10_000).padStart(4, '0')

      const context = await browser!.newContext()
      const web = await context.newPage()
      await web.goto(link.url)
      await expect(web.getByText('Enter the 4-digit code you were given.', { exact: true })).toBeVisible({ timeout: 30_000 })
      const enter = async (digits: string): Promise<void> => {
        for (let i = 0; i < 4; i++) await web.getByLabel(`Digit ${i + 1}`, { exact: true }).fill(digits[i])
        await web.getByRole('button', { name: 'Continue', exact: true }).click()
      }
      await enter(wrong(1))
      await expect(web.getByRole('alert')).toHaveText('Incorrect code. 2 attempts left.')
      await enter(wrong(2))
      await expect(web.getByRole('alert')).toHaveText('Incorrect code. 1 attempt left.')
      await enter(wrong(3))
      await expect(web.getByRole('heading', { name: 'Unable to open', exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(web.getByText('This link was blocked after too many wrong codes. Ask the person who shared it for a new one.', { exact: true })).toBeVisible()
      await expect(web.getByLabel('Digit 1', { exact: true })).toHaveCount(0)

      const right = await api(`/artifact-links/${link.token}/open`, { method: 'POST', body: { code }, token: null })
      expect(right).toEqual({
        status: 403,
        body: { detail: { message: 'This link has been blocked after too many wrong codes. Contact the owner.', attempts_left: 0, blocked: true } }
      })
      expect((await api(`/artifact-links/${link.token}/info`, { token: null })).body).toMatchObject({ needs_code: true, blocked: true, expired: false })

      // A fresh visitor never sees the code boxes.
      const again = await (await browser!.newContext()).newPage()
      await again.goto(link.url)
      await expect(again.getByText('This link was blocked after too many wrong codes. Ask the person who shared it for a new one.', { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(again.getByLabel('Digit 1', { exact: true })).toHaveCount(0)
      await again.context().close()
      await context.close()

      const owner = (await api(`/artifacts/${artifactId}`)).body.links.find((row: { id: string }) => row.id === link.id)
      expect(owner).toMatchObject({ needs_code: true, failed_attempts: 3, blocked: true, expired: false })
    })
  } finally {
    await browser?.close()
  }
})

/* --------------------------------------------------------------------- V1 */

const REPORT_MD = [
  `# Findings ${TAG}`,
  '',
  'Revenue grew **12 percent**.',
  '',
  `<script>window.__pwned = 'md-script'; fetch('https://${PWNED}/md-script')</script>`,
  '',
  `<img src="nothing.png" onerror="window.__pwned = 'md-img'; fetch('https://${PWNED}/md-img')">`,
  '',
  '<div id="raw-html-marker">raw html block</div>',
  '',
  `[a script link](javascript:window.__pwned='md-link')`,
  ''
].join('\n')
const DATA_CSV = `region,revenue\nNorth,10\nSouth,"<img src=x onerror=fetch('https://${PWNED}/csv')>"\n`
const DATA_JSON = JSON.stringify({ name: `<script>fetch('https://${PWNED}/json')</script>`, count: 3 }, null, 2) + '\n'
const SCRIPT_PY = `def total(rows):\n    return sum(rows)  # ${TAG}\n`
const IMAGE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">',
  '<rect width="120" height="60" fill="#3366cc"/>',
  `<script>window.top.__pwned = 'svg'; fetch('https://${PWNED}/svg')</script>`,
  '</svg>',
  ''
].join('\n')
const SINGLE_MD = `# Single ${TAG}\n\nOne file, straight into its viewer.\n`

/** A one-page PDF with one line of Helvetica, offsets computed so pdf.js needs no repair. */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 20 60 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Open `file` of the link in `web` (the page's own `?file=` route). */
async function openFile(web: Page, linkUrl: string, file: string): Promise<void> {
  await web.goto(`${linkUrl}?file=${encodeURIComponent(file)}`)
  await expect(web.getByRole('navigation', { name: 'Files', exact: true })).toBeVisible({ timeout: 30_000 })
}

test('V1 core’s page shows a files artifact’s Markdown, CSV, JSON, Python, SVG and PDF with no script run, and a single file straight in its viewer', async ({ cinna }) => {
  test.setTimeout(300_000)
  const config = live!
  await cinna.skipOnboarding()
  await signInDesktop(cinna, config)
  const pdf = minimalPdf(`PDF ${TAG}`)
  const { chatId } = await seededMention(cinna, {
    'outputs/report.md': REPORT_MD,
    'outputs/data.csv': DATA_CSV,
    'outputs/data.json': DATA_JSON,
    'outputs/script.py': SCRIPT_PY,
    'outputs/image.svg': IMAGE_SVG,
    'outputs/doc.pdf': pdf,
    'single.md': SINGLE_MD
  }, 'The outputs are in `outputs/` and the summary in `single.md`.', 'Where are the outputs?', 'viewer-desk')
  const page = cinna.page
  await page.getByText('Where are the outputs?', { exact: true }).first().click()
  const files = await publishFromDesktop(cinna, chatId, page.getByRole('button', { name: 'Show outputs/ in its folder', exact: true }), V_FILES_TITLE, '6 files')
  const single = await publishFromDesktop(cinna, chatId, page.getByRole('button', { name: 'Preview single.md', exact: true }), V_SINGLE_TITLE, 'Markdown document')

  await test.step('core holds both as files artifacts with no entry', async () => {
    const detail = await api(`/artifacts/${files.id}`)
    expect(detail.body).toMatchObject({ kind: 'files', entry_path: null })
    const revision = (detail.body.revisions as any[]).find((row) => row.number === 1)
    expect(revision.files.map((file: { path: string }) => file.path).sort()).toEqual(['data.csv', 'data.json', 'doc.pdf', 'image.svg', 'report.md', 'script.py'])
    expect((await api(`/artifacts/${single.id}`)).body).toMatchObject({ kind: 'files' })
  })

  const filesLink = await makeLink(files.id, {})
  expect(filesLink.status, JSON.stringify(filesLink.raw)).toBe(200)
  const singleLink = await makeLink(single.id, {})
  expect(singleLink.status, JSON.stringify(singleLink.raw)).toBe(200)

  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    const context = await browser.newContext()
    const hits = watchPwned(context)
    const web = await context.newPage()

    await test.step('Markdown renders its text; the script, the onerror image, the raw HTML and the javascript: link do nothing', async () => {
      await openFile(web, filesLink.url, 'report.md')
      await expect(web.getByRole('heading', { name: `Findings ${TAG}`, exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(web.locator('strong', { hasText: '12 percent' })).toBeVisible()
      const main = web.locator('main')
      await expect(main).toHaveCount(1)
      await expect(main.locator('#raw-html-marker')).toHaveCount(0)
      await expect(main.locator('img[onerror]')).toHaveCount(0)
      await expect(main.locator('script')).toHaveCount(0)
      // Core's MarkdownViewer prints raw HTML as literal text: visible, inert.
      await expect(main).toContainText('<div id="raw-html-marker">raw html block</div>')
      await expect(main).toContainText(`<script>window.__pwned = 'md-script'; fetch('https://${PWNED}/md-script')</script>`)
      const anchor = main.getByText('a script link', { exact: true })
      await expect(anchor).toBeVisible()
      const href = await anchor.evaluate((node) => (node.closest('a') as HTMLAnchorElement | null)?.getAttribute('href') ?? null)
      console.log(`live-artifacts-access V1: the javascript: link renders with href ${JSON.stringify(href)}`)
      expect(href ?? '').not.toMatch(/^\s*javascript:/i)
      console.log(`live-artifacts-access V1: report.md as rendered: ${JSON.stringify((await main.innerText()).slice(0, 600))}`)
      expect(await pwnedFlag(web)).toBeNull()
    })

    await test.step('CSV is a table with its header and rows; markup in a cell stays text', async () => {
      await openFile(web, filesLink.url, 'data.csv')
      const main = web.locator('main')
      for (const text of ['region', 'revenue', 'North', '10', 'South']) await expect(main.getByText(text, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(main.getByText(`<img src=x onerror=fetch('https://${PWNED}/csv')>`, { exact: true })).toBeVisible()
      await expect(main.locator('img')).toHaveCount(0)
    })

    await test.step('JSON is a coloured tree; a script in a string stays text', async () => {
      await openFile(web, filesLink.url, 'data.json')
      const main = web.locator('main')
      await expect(main.getByText(`"<script>fetch('https://${PWNED}/json')</script>"`, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(main.getByText(`"<script>fetch('https://${PWNED}/json')</script>"`, { exact: true })).toHaveClass(/text-green-600/)
      await expect(main.getByText('"count": ', { exact: true })).toBeVisible()
      await expect(main.locator('script')).toHaveCount(0)
    })

    await test.step('Python shows its source as text', async () => {
      await openFile(web, filesLink.url, 'script.py')
      await expect(web.locator('main pre')).toHaveText(SCRIPT_PY, { timeout: 30_000 })
    })

    await test.step('the SVG is an <img> that loaded, and its script never ran', async () => {
      await openFile(web, filesLink.url, 'image.svg')
      const image = web.getByRole('img', { name: 'image.svg', exact: true })
      await expect(image).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(120)
      expect(await image.evaluate((node) => node.tagName)).toBe('IMG')
      await expect(web.locator('main svg script')).toHaveCount(0)
      expect(await pwnedFlag(web)).toBeNull()
    })

    await test.step('the PDF is drawn by pdf.js onto a canvas: page 1 of 1, with ink on it', async () => {
      await openFile(web, filesLink.url, 'doc.pdf')
      const canvas = web.getByLabel('Page 1', { exact: true })
      await expect(canvas).toBeVisible({ timeout: 30_000 })
      await expect(web.getByText('1 / 1', { exact: true })).toBeVisible()
      // Rendering is asynchronous: wait until the text has put dark pixels on the white page.
      await expect.poll(() => canvas.evaluate((node) => {
        const element = node as HTMLCanvasElement
        const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
        let dark = 0
        for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100 && data[i + 3] > 200) dark++
        return dark
      }), { timeout: 30_000 }).toBeGreaterThan(50)
    })

    await test.step('the single Markdown file opens straight in its viewer, with no file tree', async () => {
      await web.goto(singleLink.url)
      await expect(web.getByRole('heading', { name: `Single ${TAG}`, exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(web.getByText('One file, straight into its viewer.', { exact: true })).toBeVisible()
      await expect(web.getByRole('navigation', { name: 'Files', exact: true })).toHaveCount(0)
    })

    await test.step('across every viewer, nothing reached the marker host', async () => {
      expect(await pwnedFlag(web)).toBeNull()
      expect(hits).toEqual([])
    })
    await context.close()
  } finally {
    await browser?.close()
  }
})

/* --------------------------------------------------------------------- V2 */

test('V2 a Python file is syntax-highlighted on core’s page, as plan A5 says code is', async () => {
  // Core highlights code files by extension (lowlight; cinna-core b09cd499):
  // the text stays exact and is split into token spans.
  test.setTimeout(120_000)
  const { id } = await publishOverApi(V2_TITLE, { 'script.py': SCRIPT_PY })
  const link = await makeLink(id, {})
  expect(link.status, JSON.stringify(link.raw)).toBe(200)
  const browser = await chromium.launch()
  try {
    const web = await (await browser.newContext()).newPage()
    await web.goto(link.url)
    const source = web.locator('main pre')
    await expect(source).toHaveText(SCRIPT_PY, { timeout: 30_000 })
    // Highlighted code is split into token elements; plain text is one text node.
    await expect(source.locator('span, code span')).not.toHaveCount(0)
  } finally {
    await browser.close()
  }
})
