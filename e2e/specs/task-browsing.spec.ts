import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Tasks with no asks and no job runs must be reachable through their own UI.
 * The scheduler imports both rows from a real loopback adapter response; the
 * only database arrangement is the sandbox account's URL/mock-keychain token.
 * Returning the child first also exercises parent resolution after list import.
 */
const ROOT_ID = 'remote-quarterly-report'
const CHILD_ID = 'remote-regional-forecast'
const FINISHED_ID = 'remote-verified-figures'
const ROOT_TITLE = 'Quarterly report awaiting work'
const CHILD_TITLE = 'Prepare the regional forecast'
const FINISHED_TITLE = 'Verify the quarterly figures'
const ROOT_GOAL = 'Deliver the quarterly report with a verified regional forecast.'
const CHILD_GOAL = 'Compare the regional revenue figures against the latest forecast.'
const FINISHED_GOAL = 'Check every quarterly figure against the signed accounts.'
const TOKEN = 'task-browsing-fixture-token'

async function serve(): Promise<{
  host: string
  server: Server
  requests: string[]
  authorized: () => boolean
}> {
  const updated = new Date().toISOString()
  const root = {
    id: ROOT_ID, short_code: 'REPORT-82', title: ROOT_TITLE,
    original_message: ROOT_GOAL, current_description: 'The forecast has been delegated.',
    status: 'open', priority: 'normal', parent_task_id: null,
    subtask_count: 2, subtask_completed_count: 1, updated_at: updated
  }
  const child = {
    id: CHILD_ID, short_code: 'REPORT-83', title: CHILD_TITLE,
    original_message: CHILD_GOAL, current_description: 'Use the approved regional spreadsheet.',
    status: 'in_progress', priority: 'normal', parent_task_id: ROOT_ID,
    subtask_count: 0, subtask_completed_count: 0, updated_at: updated
  }
  const finished = {
    ...child, id: FINISHED_ID, short_code: 'REPORT-81', title: FINISHED_TITLE,
    original_message: FINISHED_GOAL, current_description: 'The signed figures match.',
    status: 'completed', updated_at: new Date(Date.now() - 86_400_000).toISOString()
  }
  const activeRows = [child, root]
  const rows = [finished, ...activeRows]
  const requests: string[] = []
  let authorized = true
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    authorized &&= req.headers.authorization === `Bearer ${TOKEN}`
    res.setHeader('content-type', 'application/json')
    const send = (value: unknown): void => { res.end(JSON.stringify(value)) }
    if (req.method !== 'GET') {
      res.statusCode = 405
      send({ detail: 'Browsing must not write remote work' })
      return
    }
    if (url.pathname === '/api/v1/tasks/') {
      const since = url.searchParams.get('updated_since')
      const include = url.searchParams.get('status') === 'active' ||
        (!!since && Date.parse(updated) > Date.parse(since))
      // Completed before this fixture's sync cursor: only the parent-specific
      // read can discover it. Neither active nor delta assists that assertion.
      send({ data: include ? activeRows : [], count: include ? activeRows.length : 0 })
      return
    }
    const detail = rows.find((row) => url.pathname === `/api/v1/tasks/${row.id}/detail`)
    if (detail) { send(detail); return }
    if (url.pathname === `/api/v1/tasks/${ROOT_ID}/subtasks/`) {
      send({ data: [finished, child], count: 2 })
      return
    }
    if ([CHILD_ID, FINISHED_ID].some((id) => url.pathname === `/api/v1/tasks/${id}/subtasks/`)) {
      send({ data: [], count: 0 })
      return
    }
    if (rows.some((row) => url.pathname === `/api/v1/tasks/${row.id}/sessions`)) {
      send({ data: [], count: 0 })
      return
    }
    res.statusCode = 404
    send({ detail: 'No fixture route for this request' })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server, requests, authorized: () => authorized }
}

async function linkSandboxAccount(cinna: CinnaApp, host: string): Promise<void> {
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

test('remote work with no ask or job opens from Tasks and a delegated child opens through its parent', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await serve()
  try {
    await cinna.skipOnboarding()
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
    await linkSandboxAccount(cinna, fake.host)
    await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
    const taskList = cinna.page.getByRole('region', { name: 'Tasks', exact: true })
    await expect(taskList).toBeVisible()
    const rootLink = taskList.getByRole('button', { name: ROOT_TITLE, exact: true })
    await expect(rootLink).toBeVisible({ timeout: 20_000 })
    await expect(taskList.getByRole('button', { name: CHILD_TITLE, exact: true })).toHaveCount(0)
    await expect(taskList.getByRole('button', { name: FINISHED_TITLE, exact: true })).toHaveCount(0)
    expect((await cinna.page.evaluate(() => window.api.tasks.list())).some((task) => task.remote?.id === FINISHED_ID)).toBe(false)
    await expect(cinna.page.getByRole('button', { name: /^Inbox/ })).toHaveAccessibleName('Inbox')
    expect(await cinna.page.evaluate(() => window.api.inbox.list())).toEqual([])

    await rootLink.click()
    await expect(cinna.page.getByRole('heading', { name: ROOT_TITLE, level: 1, exact: true })).toBeVisible()
    await expect(cinna.page.getByText(ROOT_GOAL, { exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'Parent task', exact: true })).toHaveCount(0)
    const subtasks = cinna.page.getByRole('region', { name: 'Subtasks', exact: true })
    await expect(subtasks).toBeVisible()
    await subtasks.getByRole('button', { name: FINISHED_TITLE, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: FINISHED_TITLE, level: 1, exact: true })).toBeVisible()
    await expect(cinna.page.getByText(FINISHED_GOAL, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText('completed', { exact: true })).toBeVisible()
    await cinna.page.getByRole('button', { name: 'Parent task', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: ROOT_TITLE, level: 1, exact: true })).toBeVisible()
    await subtasks.getByRole('button', { name: CHILD_TITLE, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: CHILD_TITLE, level: 1, exact: true })).toBeVisible()
    await expect(cinna.page.getByText(CHILD_GOAL, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText('in progress', { exact: true })).toBeVisible()
    await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)
    await cinna.page.getByRole('button', { name: 'Parent task', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: ROOT_TITLE, level: 1, exact: true })).toBeVisible()
    await expect(subtasks.getByRole('button', { name: CHILD_TITLE, exact: true })).toBeVisible()

    const tasks = await cinna.page.evaluate(() => window.api.tasks.list())
    const parent = tasks.find((task) => task.remote?.id === ROOT_ID)
    const child = tasks.find((task) => task.remote?.id === CHILD_ID)
    expect(tasks).toHaveLength(3)
    expect(parent).toMatchObject({ parentTaskId: null, origin: 'remote', executor: 'remote',
      chatId: null, jobId: null, subtaskCount: 2, subtaskCompletedCount: 1 })
    expect(child).toMatchObject({ parentTaskId: parent!.id, origin: 'remote', executor: 'remote',
      chatId: null, jobId: null, goal: CHILD_GOAL })
    expect(tasks.find((task) => task.remote?.id === FINISHED_ID)).toMatchObject({
      parentTaskId: parent!.id, status: 'completed', chatId: null, jobId: null, goal: FINISHED_GOAL
    })
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
    expect(fake.authorized()).toBe(true)
    expect(fake.requests.every((request) => request.startsWith('GET '))).toBe(true)
    expect(fake.requests.some((request) => request.startsWith('GET /api/v1/tasks/?status=active&'))).toBe(true)
    expect(fake.requests).toContain(`GET /api/v1/tasks/${ROOT_ID}/subtasks/`)
  } finally {
    fake.server.closeAllConnections()
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})
