import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * A remote-only task reaches the app through its real scheduled adapter. The
 * only database arrangement links the sandbox profile to our loopback service.
 * Claim and Continue are separate UI actions; the A2A response is held until
 * the test has checked the new task/chat ownership and single dispatch.
 * No task, ask, job, model, OAuth flow or handoff-note wire field is fabricated.
 */
const TITLE = 'Finish the transferred report'
const GOAL = 'Prepare the quarterly report using the verified revenue figures.'
const DESCRIPTION = 'The revenue checks are finished; include the regional forecast next.'
const QUESTION = 'Who should finish this report?'
const AGENT = 'Desktop Report Finisher'
const DONE = 'The transferred report is ready: harbor-6728.'
const WRONG = 'The fixture received an incorrect or duplicate continuation.'
const PROMPT = `Continue this task.\n\nGoal:\n${GOAL}\n\nCurrent description:\n${DESCRIPTION}`
const REMOTE_ID = 'transferred-report'
const TOKEN = 'task-start-fixture-token'

interface SentMessage {
  role?: string
  messageId?: string
  taskId?: string
  contextId?: string
  parts?: { kind: string; text?: string }[]
}

async function serve(): Promise<{
  origin: string
  server: Server
  sends: { method: string; message: SentMessage; text: string }[]
  requests: string[]
  authorized: () => boolean
  finish: () => void
}> {
  let origin = ''
  let authorized = true
  let finish = (): void => {}
  const sends: { method: string; message: SentMessage; text: string }[] = []
  const requests: string[] = []
  const task = {
    id: REMOTE_ID, short_code: 'REPORT-67', title: TITLE,
    original_message: GOAL, current_description: DESCRIPTION,
    status: 'blocked', priority: 'normal', updated_at: new Date().toISOString()
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('content-type', 'application/json')
    const send = (value: unknown): void => { res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      send({
        name: AGENT, description: AGENT, url: `${origin}/a2a`,
        protocolVersion: '0.3.0', version: '1.0.0', capabilities: { streaming: false },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: []
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/a2a') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const rpc = JSON.parse(body) as {
          id: string | number; method: string; params?: { message?: SentMessage }
        }
        const message = rpc.params?.message ?? {}
        const text = (message.parts ?? []).filter((part) => part.kind === 'text')
          .map((part) => part.text ?? '').join('')
        sends.push({ method: rpc.method, message, text })
        const valid = sends.length === 1 && rpc.method === 'message/send' &&
          message.role === 'user' && text === PROMPT && !message.taskId && !message.contextId
        const reply = (): void => send({ jsonrpc: '2.0', id: rpc.id, result: {
          kind: 'task', id: 'local-report-task', contextId: 'local-report-context',
          status: { state: 'completed', message: {
            kind: 'message', messageId: `report-reply-${sends.length}`, role: 'agent',
            parts: [{ kind: 'text', text: valid ? DONE : WRONG }]
          } }
        } })
        if (valid) finish = reply
        else reply()
      })
      return
    }
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    authorized &&= req.headers.authorization === `Bearer ${TOKEN}`
    if (req.method === 'GET' && url.pathname === '/api/v1/tasks/') {
      const since = url.searchParams.get('updated_since')
      const include = url.searchParams.get('status') === 'active' ||
        (!!since && Date.parse(task.updated_at) > Date.parse(since))
      send({ data: include ? [task] : [], count: include ? 1 : 0 })
      return
    }
    if (req.method === 'GET' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/detail`) {
      send(task)
      return
    }
    if (req.method === 'GET' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/sessions`) {
      send({ data: [{ id: 'report-session', interaction_status: 'waiting_for_input' }], count: 1 })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/sessions/report-session/messages') {
      send({ data: [{
        id: 'report-question', tool_questions_status: 'unanswered', timestamp: task.updated_at,
        message_metadata: { streaming_events: [{ type: 'tool', tool_name: 'AskUserQuestion',
          metadata: { tool_input: { questions: [{ question: QUESTION,
            options: [{ label: 'Desktop' }, { label: 'Service' }] }] } }
        }] }
      }], count: 1 })
      return
    }
    // Real adapter write shapes, should a status/field push accompany execution.
    if ((req.method === 'POST' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/status`) ||
      (req.method === 'PATCH' && url.pathname === `/api/v1/tasks/${REMOTE_ID}`)) {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const update = JSON.parse(body) as { status?: string; title?: string; current_description?: string }
        if (update.status) task.status = update.status
        if (update.title) task.title = update.title
        if (update.current_description) task.current_description = update.current_description
        task.updated_at = new Date().toISOString()
        send(task)
      })
      return
    }
    res.statusCode = 404
    send({ detail: 'No fixture route for this request' })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, server, sends, requests, authorized: () => authorized, finish: () => {
    const release = finish
    finish = () => {}
    release()
  } }
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

test('a remote task is claimed without execution, then Continue starts its chosen local agent exactly once', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await serve()
  try {
    await cinna.skipOnboarding()
    const created = await cinna.page.evaluate(({ origin, name }) => window.api.agents.upsert({
      name, protocol: 'a2a', cardUrl: `${origin}/.well-known/agent-card.json`, endpointUrl: `${origin}/a2a`
    }), { origin: fake.origin, name: AGENT })
    expect(created.success).toBe(true)
    expect(created.id).toBeTruthy()
    const agentId = created.id!
    await cinna.relaunch()
    await cinna.skipOnboarding()
    const initialChats = await cinna.page.evaluate(() => window.api.chat.list())
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
    await linkSandboxAccount(cinna, fake.origin)
    const tasks = () => cinna.page.evaluate(() => window.api.tasks.list())
    await expect.poll(tasks, { timeout: 20_000 }).toEqual([
      expect.objectContaining({ title: TITLE, goal: GOAL, description: DESCRIPTION,
        chatId: null, jobId: null, origin: 'remote', executor: 'remote', status: 'blocked' })
    ])
    const [remote] = await tasks()
    expect(remote.remote).toMatchObject({ adapter: 'cinna', id: REMOTE_ID })
    const inbox = cinna.page.getByRole('button', { name: /^Inbox/ })
    await expect(inbox).toHaveAccessibleName('Inbox — 1 waiting', { timeout: 20_000 })
    await inbox.click()
    await cinna.page.getByRole('article').filter({ hasText: QUESTION })
      .getByRole('button', { name: 'Open the task', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: TITLE, exact: true })).toBeVisible()
    await expect(cinna.page.getByText(GOAL, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(DESCRIPTION, { exact: true })).toBeVisible()
    await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)
    await expect(cinna.page.getByRole('region', { name: 'Continue this task' })).toHaveCount(0)
    expect(fake.sends).toEqual([])

    await cinna.page.getByRole('button', { name: 'Take over', exact: true }).click()
    const continuation = cinna.page.getByRole('region', { name: 'Continue this task' })
    await expect(continuation).toBeVisible()
    expect(await tasks()).toEqual([expect.objectContaining({
      id: remote.id, executor: 'desktop', runsHere: true, chatId: null, status: 'blocked'
    })])
    expect((await cinna.page.evaluate(() => window.api.chat.list())).map((chat) => chat.id))
      .toEqual(initialChats.map((chat) => chat.id))
    expect(fake.sends).toEqual([])

    await continuation.getByRole('combobox', { name: 'Continue with' }).selectOption({ label: AGENT })
    await continuation.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.poll(() => fake.sends.length).toBe(1)
    await expect(cinna.page.getByPlaceholder('Type a message...')).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    const [running] = await tasks()
    expect(running).toMatchObject({ id: remote.id, status: 'in_progress', executor: 'desktop',
      runsHere: true, jobId: null, goal: GOAL, description: DESCRIPTION,
      assignee: { kind: 'agent', agentId, name: AGENT } })
    expect(running.chatId).toBeTruthy()
    expect(fake.sends[0]).toMatchObject({ method: 'message/send', text: PROMPT,
      message: { role: 'user', messageId: expect.any(String) } })
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), running.chatId!)
    expect(chat).toMatchObject({ id: running.chatId, router: 'direct', agentId })
    expect(chat?.messages.filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual([PROMPT])

    fake.finish()
    // The chat stays open. Its own active-run refresh must render the final
    // persisted reply; no navigation or manual detail refetch can assist it.
    await expect(cinna.page.getByText(DONE, { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await expect.poll(tasks).toEqual([expect.objectContaining({ id: remote.id,
      chatId: running.chatId, status: 'completed', assignee: expect.objectContaining({ agentId }) })])
    expect(fake.sends).toHaveLength(1)
    expect((await cinna.page.evaluate(() => window.api.chat.list()))
      .filter((entry) => !initialChats.some((initial) => initial.id === entry.id)).map((entry) => entry.id))
      .toEqual([running.chatId])
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
    expect(await cinna.page.evaluate(() => window.api.providers.list())).toEqual([])
    expect(await cinna.page.evaluate(() => window.api.chatModes.list())).toEqual([])
    expect(fake.authorized()).toBe(true)
    expect(fake.requests.some((request) => request.startsWith('GET /api/v1/tasks/?status=active&'))).toBe(true)
  } finally {
    fake.finish()
    fake.server.closeAllConnections()
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})
