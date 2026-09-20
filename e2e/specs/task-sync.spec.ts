import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * The only arranged local state is the sandbox account's loopback URL and
 * mock-keychain token. No task, ask, scheduler IPC or renderer query is seeded.
 * Discovery and updates must cross the real adapter and scheduled sync carrier.
 * OAuth, a real Cinna server, and model execution are outside this scenario.
 */
const INITIAL_TITLE = 'Report waiting on the service'
const DETAIL_ONLY_TITLE = 'This detail response must not drive list discovery'
const DELTA_TITLE = 'Report renamed on the service'
const FINISHED_TITLE = 'Report completed on the service'
const REVISED_TITLE = 'Completed report title corrected'
const GOAL = 'Prepare the weekly report using the figures from Friday.'
const QUESTION = 'Which audience should the report address?'
const REMOTE_ID = 'server-created-report'
const TOKEN = 'task-sync-fixture-token'

interface RemoteTask {
  id: string
  short_code: string
  title: string
  original_message: string
  current_description: string
  status: 'blocked' | 'completed'
  priority: string
  updated_at: string
}
interface ServiceState {
  task: RemoteTask
  suppressDelta: boolean
  asksOpen: boolean
  requests: string[]
  authorized: boolean
  detailReads: number
  detailTitle: string | null
}
let service: ServiceState
let server: Server
let host = ''

function serve(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    service.requests.push(`${req.method} ${url.pathname}${url.search}`)
    service.authorized &&= req.headers.authorization === `Bearer ${TOKEN}`
    res.setHeader('content-type', 'application/json')
    const send = (value: unknown): void => { res.end(JSON.stringify(value)) }
    if (url.pathname === '/api/v1/tasks/') {
      const since = url.searchParams.get('updated_since')
      const active = url.searchParams.get('status') === 'active'
      const include = active
        ? service.task.status === 'blocked'
        : !service.suppressDelta && !!since && Date.parse(service.task.updated_at) > Date.parse(since)
      send({ data: include ? [service.task] : [], count: include ? 1 : 0 })
      return
    }
    if (url.pathname === `/api/v1/tasks/${REMOTE_ID}/detail`) {
      service.detailReads += 1
      send({ ...service.task, title: service.detailTitle ?? service.task.title })
      return
    }
    if (url.pathname === `/api/v1/tasks/${REMOTE_ID}/sessions`) {
      send({ data: [{ id: 'report-session', interaction_status: service.asksOpen ? 'waiting_for_input' : 'idle' }], count: 1 })
      return
    }
    if (url.pathname === '/api/v1/sessions/report-session/messages') {
      send({ data: service.asksOpen ? [{
        id: 'report-question', tool_questions_status: 'unanswered',
        timestamp: service.task.updated_at,
        message_metadata: { streaming_events: [{
          type: 'tool', tool_name: 'AskUserQuestion',
          metadata: { tool_input: { questions: [{ question: QUESTION,
            options: [{ label: 'Leadership' }, { label: 'Engineering' }] }] } }
        }] }
      }] : [], count: service.asksOpen ? 1 : 0 })
      return
    }
    res.statusCode = 404
    send({ detail: 'No fixture route for this request' })
  })
}

test.beforeAll(async () => {
  server = serve()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.beforeEach(() => {
  service = {
    task: {
      id: REMOTE_ID, short_code: 'REPORT-42', title: INITIAL_TITLE,
      original_message: GOAL, current_description: 'A report owned by the remote service.',
      status: 'blocked', priority: 'normal', updated_at: new Date().toISOString()
    },
    suppressDelta: false, asksOpen: true, requests: [], authorized: true, detailReads: 0, detailTitle: DETAIL_ONLY_TITLE
  }
})
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Reuses remote-inbox's sandbox-only linked-profile arrangement, without its task INSERT. */
async function linkSandboxAccount(cinna: CinnaApp): Promise<void> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  expect(user).not.toBeNull()
  await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${app.getPath('userData')}/cinna.db`)
    try {
      const token = safeStorage.encryptString(input.token)
      db.prepare(`UPDATE users SET type = 'cinna_user', cinna_server_url = ?,
        cinna_access_token_enc = ?, cinna_refresh_token_enc = ?, cinna_token_expires_at = ?
        WHERE id = ?`).run(input.host, token, token, Date.now() + 3_600_000, input.userId)
    } finally { db.close() }
  }, { host, token: TOKEN, userId: user!.id })
}

test('scheduled sync discovers a remote-only task and its ask, then the open task page refreshes remote changes', async ({ cinna }) => {
  test.setTimeout(120_000)
  await cinna.skipOnboarding()
  // A task already exists on the fake service but has never existed locally.
  expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
  await linkSandboxAccount(cinna)
  const tasks = () => cinna.page.evaluate(() => window.api.tasks.list())
  await expect.poll(async () => (await tasks()).map((task) => task.title), { timeout: 20_000 }).toEqual([INITIAL_TITLE])
  const [discovered] = await tasks()
  expect(discovered).toMatchObject({ title: INITIAL_TITLE, goal: GOAL, status: 'blocked', origin: 'remote', executor: 'remote' })
  expect(discovered.remote).toMatchObject({ adapter: 'cinna', id: REMOTE_ID, key: 'REPORT-42' })
  expect(service.requests.some((request) => request.startsWith('GET /api/v1/tasks/?status=active&'))).toBe(true)
  expect(service.requests.some((request) => request.startsWith('GET /api/v1/tasks/?updated_since='))).toBe(true)
  // Inbox reads detail to discover structured delegation asks. Its detail-only
  // title differs, so the title above proves the list carrier discovered the task;
  // forbidding all detail requests would incorrectly forbid ordinary Inbox reads.

  const inbox = () => cinna.page.getByRole('button', { name: /^Inbox/ })
  await expect(inbox()).toHaveAccessibleName('Inbox — 1 waiting', { timeout: 20_000 })
  await inbox().click()
  const row = () => cinna.page.getByRole('article')
  await expect(row()).toHaveCount(1)
  await expect(row().getByText(INITIAL_TITLE, { exact: true })).toBeVisible()
  await expect(row().getByText(QUESTION, { exact: true })).toBeVisible()
  await expect(row().getByRole('button', { name: 'Answer', exact: true })).toBeEnabled()
  await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveCount(0)

  await test.step('the unattended delta carrier refreshes the task while the Inbox stays open', async () => {
    service.task = { ...service.task, title: DELTA_TITLE, updated_at: new Date().toISOString() }
    await expect(row().getByText(DELTA_TITLE, { exact: true })).toBeVisible({ timeout: 20_000 })
    expect((await tasks())[0].id).toBe(discovered.id)
    expect((await tasks())[0].title).toBe(DELTA_TITLE)
  })

  await test.step('an open task reads detail updates even when the delta list omits them', async () => {
    service.detailTitle = null
    await row().getByRole('button', { name: 'Open the task', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: DELTA_TITLE, exact: true })).toBeVisible()
    await expect(cinna.page.getByText('blocked', { exact: true })).toBeVisible()
    await expect.poll(() => service.detailReads).toBeGreaterThan(0)
    const reads = service.detailReads
    // No list response can carry this change: task:get's background detail pull
    // is the only producer left, so a passing page assertion proves that path.
    service.suppressDelta = true
    service.asksOpen = false
    service.task = { ...service.task, title: FINISHED_TITLE, status: 'completed', updated_at: new Date().toISOString() }
    await expect(cinna.page.getByRole('heading', { level: 1, name: FINISHED_TITLE, exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(cinna.page.getByText('completed', { exact: true })).toBeVisible()
    expect(service.detailReads).toBeGreaterThan(reads)
    await expect(inbox()).toHaveAccessibleName('Inbox', { timeout: 20_000 })
    expect((await tasks())[0]).toMatchObject({ id: discovered.id, status: 'completed', title: FINISHED_TITLE })
  })

  await test.step('a settled remote task remains current while its page is watched', async () => {
    service.task = { ...service.task, title: REVISED_TITLE, updated_at: new Date().toISOString() }
    await expect(cinna.page.getByRole('heading', { level: 1, name: REVISED_TITLE, exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(cinna.page.getByText('completed', { exact: true })).toBeVisible()
    expect((await tasks())[0]).toMatchObject({ id: discovered.id, title: REVISED_TITLE, status: 'completed' })
    expect(service.authorized).toBe(true)
    expect(service.requests.every((request) => request.startsWith('GET '))).toBe(true)
  })
})
