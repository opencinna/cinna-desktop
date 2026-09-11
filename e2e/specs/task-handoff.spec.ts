import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Arrange a real local job task/chat without starting a renderer turn. The
 * user hands that existing task to a remote agent through the task page.
 * A definitive comment refusal preserves the binding and modal draft; retry
 * must reuse the remote task and execute once. No product IPC is replaced.
 */
const TITLE = 'Delegate the quarterly briefing'
const GOAL = 'Prepare the quarterly briefing with the approved revenue figures.'
const NOTE = 'Revenue figures are verified. Continue with the regional forecast and cite the source sheet.'
const LOCAL_AGENT = 'Local Briefing Planner'
const REMOTE_AGENT = 'Remote Briefing Writer'
const AGENT_ID = 'remote-briefing-writer'
const REMOTE_ID = 'delegated-quarterly-briefing'
const REMOTE_KEY = 'BRIEF-91'
const RECEIPT = `Handed off to ${REMOTE_AGENT} (${REMOTE_KEY}).`
const TOKEN = 'task-handoff-fixture-token'
const REFUSAL = 'Cinna would not accept that change.'

interface RemoteTask {
  id: string
  short_code: string
  title: string
  original_message: string
  current_description: string
  priority: string
  status: string
  selected_agent_id: string | null
  agent_name: string | null
  external_ref: string
  updated_at: string
}
interface Request { method: string; path: string; body?: Record<string, unknown> }

async function serve(): Promise<{
  host: string
  server: Server
  requests: Request[]
  state: { task: RemoteTask | null; refuseNote: boolean; dropExecute: boolean; remoteRunning: boolean;
    notes: string[]; localSends: number; authorized: boolean }
}> {
  let host = ''
  const requests: Request[] = []
  const state = { task: null as RemoteTask | null, refuseNote: true, dropExecute: false, remoteRunning: false,
    notes: [] as string[], localSends: 0, authorized: true }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('content-type', 'application/json')
    const send = (value: unknown): void => { res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      send({ name: LOCAL_AGENT, description: LOCAL_AGENT, url: `${host}/a2a`,
        protocolVersion: '0.3.0', version: '1.0.0', capabilities: { streaming: false },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] })
      return
    }
    if (url.pathname === '/a2a') {
      state.localSends += 1
      res.statusCode = 400
      send({ detail: 'A local run must not start during remote handoff' })
      return
    }
    state.authorized &&= req.headers.authorization === `Bearer ${TOKEN}`
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const payload = body ? JSON.parse(body) as Record<string, unknown> : undefined
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body: payload })
      if (req.method === 'GET' && url.pathname === '/api/v1/agents/') {
        send({ data: [{ id: AGENT_ID, name: REMOTE_AGENT, description: 'Writes the delegated briefing.' }], count: 1 })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/tasks/') {
        const since = url.searchParams.get('updated_since')
        const include = state.task && (url.searchParams.get('status') === 'active' ||
          (!!since && Date.parse(state.task.updated_at) > Date.parse(since)))
        send({ data: include ? [state.task] : [], count: include ? 1 : 0 })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/tasks/') {
        if (!state.task) state.task = {
          id: REMOTE_ID, short_code: REMOTE_KEY, title: String(payload?.title ?? ''),
          original_message: String(payload?.original_message ?? ''), current_description: '',
          priority: String(payload?.priority ?? 'normal'), status: 'new',
          selected_agent_id: typeof payload?.selected_agent_id === 'string' ? payload.selected_agent_id : null,
          agent_name: payload?.selected_agent_id === AGENT_ID ? REMOTE_AGENT : null,
          external_ref: String(payload?.external_ref ?? ''), updated_at: new Date().toISOString()
        }
        send(state.task)
        return
      }
      if (req.method === 'GET' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/detail` && state.task) {
        send(state.task)
        return
      }
      if (req.method === 'GET' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/sessions`) {
        send({ data: state.remoteRunning
          ? [{ id: 'briefing-session', interaction_status: 'running' }] : [],
        count: state.remoteRunning ? 1 : 0 })
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/subtasks/')) {
        send({ data: [], count: 0 })
        return
      }
      if (req.method === 'POST' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/comments/`) {
        if (state.refuseNote) {
          res.statusCode = 400
          send({ detail: 'The fixture refused this handoff note.' })
        } else if (payload?.comment_type !== 'result' || payload.content !== NOTE) {
          res.statusCode = 400
          send({ detail: 'The handoff note or comment type is incorrect.' })
        } else {
          state.notes.push(String(payload.content))
          send({ id: `note-${state.notes.length}`, ...payload })
        }
        return
      }
      if (req.method === 'PATCH' && url.pathname === `/api/v1/tasks/${REMOTE_ID}` && state.task) {
        if (typeof payload?.selected_agent_id === 'string') {
          state.task.selected_agent_id = payload.selected_agent_id
          state.task.agent_name = payload.selected_agent_id === AGENT_ID ? REMOTE_AGENT : null
        }
        if (typeof payload?.current_description === 'string') state.task.current_description = payload.current_description
        if (typeof payload?.title === 'string') state.task.title = payload.title
        state.task.updated_at = new Date().toISOString()
        send(state.task)
        return
      }
      if (req.method === 'POST' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/status` && state.task) {
        state.task.status = String(payload?.status)
        state.task.updated_at = new Date().toISOString()
        send(state.task)
        return
      }
      if (req.method === 'POST' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/execute` && state.task) {
        const valid = state.task.original_message === GOAL && state.task.selected_agent_id === AGENT_ID &&
          state.notes.includes(NOTE) && payload?.mode === 'conversation'
        if (valid) {
          state.remoteRunning = true
          state.task.status = 'in_progress'
          state.task.updated_at = new Date().toISOString()
        }
        if (valid && state.dropExecute) {
          // A warmed reusable connection makes Electron's buffered fetch replay
          // this accepted POST. The one-shot mutation transport must not.
          setTimeout(() => res.destroy(), 1_000)
          return
        }
        send({ success: valid, error: valid ? undefined : 'The goal, recipient or handoff note is missing.' })
        return
      }
      res.statusCode = 404
      send({ detail: 'No fixture route for this request' })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { host, server, requests, state }
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

async function arrangeTask(cinna: CinnaApp, fake: Awaited<ReturnType<typeof serve>>) {
  await cinna.skipOnboarding()
  const agent = await cinna.page.evaluate(({ host, name }) => window.api.agents.upsert({
    name, protocol: 'a2a', cardUrl: `${host}/.well-known/agent-card.json`, endpointUrl: `${host}/a2a`
  }), { host: fake.host, name: LOCAL_AGENT })
  expect(agent.success).toBe(true)
  expect(agent.id).toBeTruthy()
  const job = await cinna.page.evaluate(async ({ title, prompt, agentId }) => {
    const created = await window.api.jobs.create({ type: 'local', title, prompt })
    await window.api.jobs.setAgents(created.id, [agentId])
    return created
  }, { title: TITLE, prompt: GOAL, agentId: agent.id! })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  // This arranges a real task/chat/run, but sends no renderer turn. Handoff
  // is the user action under test and must not require a live local worker.
  await cinna.page.evaluate((id) => window.api.jobs.execute(id), job.id)
  const [original] = await cinna.page.evaluate(() => window.api.tasks.list())
  expect(original).toMatchObject({ title: TITLE, goal: GOAL, executor: 'desktop', origin: 'local', jobId: job.id })
  expect(original.chatId).toBeTruthy()
  expect(fake.state.localSends).toBe(0)
  await linkSandboxAccount(cinna, fake.host)
  await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await cinna.page.getByRole('region', { name: 'Tasks', exact: true })
    .getByRole('button', { name: TITLE, exact: true }).click()
  await expect(cinna.page.getByRole('heading', { name: TITLE, level: 1, exact: true })).toBeVisible()
  return { original, jobId: job.id }
}

test('an existing desktop task hands off once and preserves its recipient and note after a definitive refusal', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await serve()
  const calls = (method: string, path: string) => fake.requests.filter((request) => request.method === method && request.path === path)
  try {
    const { original, jobId } = await arrangeTask(cinna, fake)
    await cinna.page.getByRole('button', { name: 'Hand off', exact: true }).click()
    const dialog = cinna.page.getByRole('dialog', { name: 'Hand off task', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox', { name: 'Remote agent', exact: true }).selectOption({ label: REMOTE_AGENT })
    await dialog.getByRole('textbox', { name: 'Handoff note', exact: true }).fill(NOTE)
    await dialog.getByRole('button', { name: 'Hand off', exact: true }).click()
    await expect(dialog.getByText(REFUSAL, { exact: true })).toBeVisible()
    await expect(dialog.getByRole('combobox', { name: 'Remote agent', exact: true })).toHaveValue(AGENT_ID)
    await expect(dialog.getByRole('textbox', { name: 'Handoff note', exact: true })).toHaveValue(NOTE)
    expect(calls('POST', '/api/v1/tasks/')).toHaveLength(1)
    expect(calls('POST', `/api/v1/tasks/${REMOTE_ID}/execute`)).toHaveLength(0)
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), original.id)).executor).toBe('desktop')
    expect((await cinna.page.evaluate((id) => window.api.chat.get(id), original.chatId!))?.messages
      .filter((message) => message.role === 'agent_transition' && message.content.includes(REMOTE_KEY))).toEqual([])

    fake.state.refuseNote = false
    await dialog.getByRole('button', { name: 'Hand off', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(cinna.page.getByRole('heading', { name: TITLE, level: 1, exact: true })).toBeVisible()
    await expect(cinna.page.getByText('This task is running in the service that holds it.', { exact: true })).toBeVisible()
    await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)
    expect(calls('POST', '/api/v1/tasks/')).toHaveLength(1)
    expect(calls('POST', `/api/v1/tasks/${REMOTE_ID}/execute`)).toHaveLength(1)
    expect(calls('POST', '/api/v1/tasks/')[0].body).toMatchObject({ original_message: GOAL, external_ref: original.id })
    expect(fake.state.task).toMatchObject({ original_message: GOAL, selected_agent_id: AGENT_ID, external_ref: original.id })
    expect(fake.state.notes).toContain(NOTE)
    const [handed] = await cinna.page.evaluate(() => window.api.tasks.list())
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toHaveLength(1)
    expect(handed).toMatchObject({ id: original.id, chatId: original.chatId, executor: 'remote',
      origin: 'local', goal: GOAL, remote: { id: REMOTE_ID, key: REMOTE_KEY } })
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), original.chatId!)
    const receipts = chat?.messages.filter((message) => message.role === 'agent_transition' && message.content.includes(REMOTE_KEY)) ?? []
    expect(receipts).toHaveLength(1)
    expect(receipts[0].content).toBe(RECEIPT)
    await cinna.page.getByRole('button', { name: 'Open the conversation', exact: true }).click()
    // Persisted transition notices are collapsed in the default compact mode.
    const notice = cinna.page.getByRole('button', { name: 'Show agent notice', exact: true })
    await expect(notice).toHaveAttribute('title', RECEIPT)
    await notice.click()
    await expect(cinna.page.getByText(RECEIPT, { exact: true })).toBeVisible()
    // Stay on the job page while the actual adapter/surface polls complete the
    // original local attempt. A manual refresh/navigation must not assist it.
    await cinna.page.getByRole('button', { name: `From job ${TITLE}`, exact: true }).click()
    await expect(cinna.page.getByText('Running', { exact: true })).toBeVisible()
    await expect(cinna.page.getByLabel('Running', { exact: true })).toBeVisible()
    fake.state.task!.status = 'completed'
    fake.state.task!.updated_at = new Date().toISOString()
    fake.state.remoteRunning = false
    await expect(cinna.page.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(cinna.page.getByLabel('Running', { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByRole('region', { name: 'Tasks', exact: true })
      .getByRole('button', { name: TITLE, exact: true })).toContainText('completed')
    expect((await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId))[0])
      .toMatchObject({ status: 'succeeded', taskId: original.id, localChatId: original.chatId })
    expect((await cinna.page.evaluate(() => window.api.jobs.list())).find((job) => job.id === jobId)?.inProgressRunsCount).toBe(0)
    expect(fake.state.localSends).toBe(0)
    expect(fake.state.authorized).toBe(true)
    expect(await cinna.page.evaluate(() => window.api.providers.list())).toEqual([])
    expect(await cinna.page.evaluate(() => window.api.chatModes.list())).toEqual([])
  } finally {
    fake.server.closeAllConnections()
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})

test('a lost execute response sends one mutation and requires explicit recovery before local work', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await serve()
  let warmer: ReturnType<typeof setInterval> | undefined
  const warming = new Set<Promise<unknown>>()
  const executeCalls = () => fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/execute'))
  try {
    fake.state.refuseNote = false
    fake.state.dropExecute = true
    const { original } = await arrangeTask(cinna, fake)
    await cinna.page.getByRole('button', { name: 'Hand off', exact: true }).click()
    const dialog = cinna.page.getByRole('dialog', { name: 'Hand off task', exact: true })
    await dialog.getByRole('combobox', { name: 'Remote agent', exact: true }).selectOption({ label: REMOTE_AGENT })
    await dialog.getByRole('textbox', { name: 'Handoff note', exact: true }).fill(NOTE)
    // Ordinary directory reads keep Chromium's reusable connections warm.
    // With net.fetch's buffered upload, each 1s drop replays the accepted POST;
    // cold immediate-drop tests do not expose that transport behavior.
    const warm = (): void => {
      const request = cinna.page.evaluate(() => window.api.cinna.listAgents()).catch(() => {})
      warming.add(request)
      void request.finally(() => warming.delete(request))
    }
    await cinna.page.evaluate(() => window.api.cinna.listAgents())
    warmer = setInterval(warm, 200)
    await dialog.getByRole('button', { name: 'Hand off', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText(
      'The service may have started work. Check it before trying again.', { timeout: 10_000 })
    expect(executeCalls()).toHaveLength(1)
    await expect(dialog.getByRole('button', { name: 'Hand off', exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('combobox', { name: 'Remote agent', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('textbox', { name: 'Handoff note', exact: true })).toHaveValue(NOTE)
    await expect(dialog.getByRole('textbox', { name: 'Handoff note', exact: true })).toBeDisabled()
    expect(await cinna.page.evaluate((id) => window.api.tasks.handoffReceipt(id), original.id))
      .toMatchObject({ state: 'uncertain', taskId: original.id })

    // The journal's control survives leaving the original modal. It is the
    // same source chat, and no retry/execute is sent merely by opening it.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Open the conversation', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Review pending handoff', exact: true }).click()
    const recovery = cinna.page.getByRole('dialog', { name: 'Review pending handoff', exact: true })
    await expect(recovery).toBeVisible()
    await recovery.getByRole('button', { name: 'Continue here anyway', exact: true }).click()
    await expect(recovery.getByRole('alert')).toContainText(
      'An agent is working on this task in the service. Wait until it stops.')
    expect(executeCalls()).toHaveLength(1)
    fake.state.remoteRunning = false
    await recovery.getByRole('button', { name: 'Continue here anyway', exact: true }).click()
    await expect(recovery).toHaveCount(0)
    await expect(cinna.page.getByRole('button', { name: 'Review pending handoff', exact: true })).toHaveCount(0)
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), original.id)).executor).toBe('desktop')
    expect(executeCalls()).toHaveLength(1)
    expect(fake.requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/tasks/')).toHaveLength(1)
    expect(fake.state.localSends).toBe(0)
    expect(fake.state.authorized).toBe(true)
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), original.chatId!)
    expect(chat?.messages.filter((message) => message.role === 'agent_transition' && message.content === RECEIPT)).toEqual([])
  } finally {
    if (warmer) clearInterval(warmer)
    await Promise.allSettled(warming)
    fake.server.closeAllConnections()
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})
