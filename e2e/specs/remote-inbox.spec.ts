import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * Real Electron inbox, IPC, repositories, Cinna adapter and HTTP transport.
 * Only the remote service and local ACP agent are fakes. A linked account and
 * blocked remote task are seeded in the fixture's SQLite database: OAuth and
 * task discovery are not under test, and no real account/server is contacted.
 * The local ask is raised by a real run and answered over its live ACP park.
 */
const LOCAL_TITLE = 'Local report approval'
const REMOTE_TITLE = 'Remote report colour'
const REMOTE_TASK = 'remote-inbox-task'
const QUESTION = 'Which colour should the remote report use?'
const MODEL = 'qwen3:8b'
const ANSWER = 'Teal with high contrast labels'

interface RemoteState {
  createdAt: string
  answered: boolean
  failRead: boolean
  failAnswer: boolean
  posts: unknown[]
  authorized: boolean
}

let server: Server
let host = ''
let state: RemoteState

function serve(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('content-type', 'application/json')
    const send = (body: unknown): void => { res.end(JSON.stringify(body)) }
    if (url.pathname === '/api/tags') {
      send({ models: [{ name: MODEL, model: MODEL, details: { parameter_size: '8.2B' } }] })
      return
    }
    if (url.pathname === '/api/version') {
      send({ version: '0.6.2' })
      return
    }
    if (url.pathname.startsWith('/api/v1/')) {
      state.authorized &&= req.headers.authorization === 'Bearer remote-inbox-fixture-token'
    }
    // The active scheduler and task:get's background detail refresh use the
    // same task as the explicit fixture binding. A fake 404 here would unbind
    // a healthy task and quietly weaken the answer assertions below.
    const task = {
      id: 'remote-task', title: REMOTE_TITLE, original_message: REMOTE_TITLE,
      status: 'blocked', priority: 'normal', updated_at: state.createdAt
    }
    if (url.pathname === '/api/v1/tasks/remote-task/detail') {
      send(task)
      return
    }
    if (url.pathname === '/api/v1/tasks/') {
      const since = url.searchParams.get('updated_since')
      const include = url.searchParams.get('status') === 'active' ||
        (!!since && Date.parse(task.updated_at) > Date.parse(since))
      send({ data: include ? [task] : [], count: include ? 1 : 0 })
      return
    }
    if (url.pathname === '/api/v1/tasks/remote-task/sessions') {
      if (state.failRead) {
        res.statusCode = 503
        send({ detail: 'Fixture service temporarily unavailable' })
      } else {
        send({ data: [{ id: 'remote-session', interaction_status: 'waiting_for_input' }], count: 1 })
      }
      return
    }
    if (url.pathname === '/api/v1/sessions/remote-session/messages') {
      send({
        data: state.answered ? [] : [{
          id: 'remote-question', timestamp: new Date().toISOString(),
          tool_questions_status: 'unanswered',
          message_metadata: { streaming_events: [{
            type: 'tool', tool_name: 'AskUserQuestion',
            metadata: { tool_input: { questions: [{
              question: QUESTION, header: 'Colour', multiSelect: false,
              options: [{ label: 'Teal', description: 'Calm and readable' }, { label: 'Amber', description: 'Bright' }]
            }] } }
          }] }
        }], count: state.answered ? 0 : 1
      })
      return
    }
    if (url.pathname === '/api/v1/sessions/remote-session/messages/stream' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      state.posts.push(JSON.parse(body))
      if (state.failAnswer) {
        res.statusCode = 503
        send({ detail: 'Fixture answer temporarily unavailable' })
      } else {
        state.answered = true
        send({})
      }
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
  state = { createdAt: new Date().toISOString(), answered: false, failRead: false, failAnswer: false, posts: [], authorized: true }
})
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** No task-creation IPC exists. Seed only this sandbox, through a second DB handle. */
async function seedRemote(cinna: CinnaApp): Promise<void> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  expect(user).not.toBeNull()
  await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
    // evaluate runs in an ESM bundle: createRequire is a builtin, bare require is absent.
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${app.getPath('userData')}/cinna.db`)
    try {
      const token = safeStorage.encryptString('remote-inbox-fixture-token')
      db.prepare(`UPDATE users SET type = 'cinna_user', cinna_server_url = ?,
        cinna_access_token_enc = ?, cinna_refresh_token_enc = ?, cinna_token_expires_at = ?
        WHERE id = ?`).run(input.host, token, token, Date.now() + 3_600_000, input.userId)
      const now = Math.floor(Date.now() / 1000)
      db.prepare(`INSERT INTO tasks (id, user_id, title, goal, status, executor,
        remote_adapter, remote_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'blocked', 'remote', 'cinna', 'remote-task', ?, ?)`)
        .run(input.taskId, input.userId, input.title, input.title, now, now)
    } finally { db.close() }
  }, { host, userId: user!.id, taskId: REMOTE_TASK, title: REMOTE_TITLE })
}

test('remote and local asks share the Inbox; remote failures stay retryable and answers reach the service with chat closed', async ({ cinna }) => {
  test.setTimeout(180_000)
  await cinna.skipOnboarding()
  const acp = await installFakeAcpEngine(cinna, {
    newSession: { sessionId: 'local-inbox-session' },
    prompt: { emit: [
      { kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'local-read', title: 'bash', kind: 'execute', status: 'pending', locations: [], rawInput: {} } },
      { kind: 'permission', toolCall: { toolCallId: 'local-read', title: 'cat report.txt', kind: 'execute', status: 'pending', locations: [], rawInput: { command: 'cat report.txt' } }, options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
      ] },
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Local approval handled.' } } }
    ] }
  })
  await cinna.page.evaluate(async ({ host, model }) => {
    const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Fixture Ollama', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
  }, { host, model: MODEL })
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Local Approver', 'Local Approver')
  await cinna.page.evaluate(async ({ agentId, title }) => {
    const job = await window.api.jobs.create({ type: 'local', title, prompt: 'Read the report.' })
    await window.api.jobs.setAgents(job.id, [agentId])
  }, { agentId: agent.id, title: LOCAL_TITLE })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  // Seed after the last restart: no account activation, sync or OAuth is fabricated.
  await seedRemote(cinna)

  const inbox = () => cinna.page.getByRole('button', { name: /^Inbox/ })
  const remote = () => cinna.page.getByRole('article').filter({ hasText: REMOTE_TITLE })
  const local = () => cinna.page.getByRole('article').filter({ hasText: LOCAL_TITLE })
  await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await cinna.page.getByText(LOCAL_TITLE, { exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(cinna.page.getByText('The agent is asking to run a command', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(inbox()).toHaveAccessibleName('Inbox — 2 waiting', { timeout: 20_000 })
  await inbox().click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)
  await expect(cinna.page.getByRole('article')).toHaveCount(2)
  await expect(remote().getByText(QUESTION, { exact: true })).toBeVisible()
  await expect(local().getByText('cat report.txt', { exact: true })).toBeVisible()
  expect(acp.answers('session/request_permission')).toEqual([])

  await test.step('a failed remote refresh keeps both cards and exposes a retry', async () => {
    state.failRead = true
    await expect(inbox()).toHaveAccessibleName('Inbox — could not be read', { timeout: 20_000 })
    await expect(cinna.page.getByText('Showing the last read — the inbox could not be refreshed.', { exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('article')).toHaveCount(2)
    await expect(remote().getByRole('button', { name: 'Answer', exact: true })).toBeEnabled()
    state.failRead = false
    await cinna.page.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(inbox()).toHaveAccessibleName('Inbox — 2 waiting')
  })

  const answerRemote = async (): Promise<void> => {
    await remote().getByRole('button', { name: 'Answer', exact: true }).click()
    await expect(cinna.page.getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled()
    await cinna.page.getByRole('button', { name: 'Other (enter custom answer)', exact: true }).click()
    await cinna.page.getByPlaceholder('Type your answer…').fill(ANSWER)
    await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
  }
  await test.step('a failed delivery leaves the question answerable', async () => {
    state.failAnswer = true
    await answerRemote()
    await expect(cinna.page.getByRole('alert')).toHaveText('Cinna did not answer.')
    await expect(cinna.page.getByPlaceholder('Type your answer…')).toHaveValue(ANSWER)
    await expect(cinna.page.getByRole('button', { name: 'Send answer', exact: true })).toBeEnabled()
    expect(state.answered).toBe(false)
    expect(state.posts).toEqual([{ content: `${QUESTION}\nAnswer: ${ANSWER}`, answers_to_message_id: 'remote-question' }])
  })
  await test.step('the retried answer reaches the remote and only its badge count settles', async () => {
    state.failAnswer = false
    // Retry in the same modal: the failed submission must not erase the draft.
    await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect(remote().getByText(`Answered: ${ANSWER}.`, { exact: true })).toBeVisible()
    await expect(remote().getByRole('button')).toHaveText(['Open the task'])
    await expect(inbox()).toHaveAccessibleName('Inbox — 1 waiting')
    expect(state.posts).toEqual(Array(2).fill({ content: `${QUESTION}\nAnswer: ${ANSWER}`, answers_to_message_id: 'remote-question' }))
    expect(state.authorized).toBe(true)
    await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)
    // An answer is not a remote status update: the service still owns blocked.
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), REMOTE_TASK)).status).toBe('blocked')
    await expect(local().getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled()
    await local().getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(() => acp.answers('session/request_permission').map((entry) => entry.result)).toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }])
    await expect(inbox()).toHaveAccessibleName('Inbox')
    // Settled cards stay until navigation; reopening shows the real empty read.
    await expect(cinna.page.getByRole('article')).toHaveCount(2)
    await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
    await inbox().click()
    await expect(cinna.page.getByText('Nothing is waiting on you.', { exact: true })).toBeVisible()
  })
})

test('an initial remote Inbox read failure is visible and Try again recovers the waiting question', async ({ cinna }) => {
  test.setTimeout(90_000)
  await cinna.skipOnboarding()
  state.failRead = true
  await seedRemote(cinna)
  const inbox = () => cinna.page.getByRole('button', { name: /^Inbox/ })
  await expect(inbox()).toHaveAccessibleName('Inbox — could not be read', { timeout: 20_000 })
  await inbox().click()
  await expect(cinna.page.getByText('The inbox could not be read.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByText('Anything waiting is still waiting — this is the list, not the requests.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByText('Nothing is waiting on you.', { exact: true })).toHaveCount(0)
  state.failRead = false
  await cinna.page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(inbox()).toHaveAccessibleName('Inbox — 1 waiting')
  await expect(cinna.page.getByRole('article')).toHaveCount(1)
  await expect(cinna.page.getByRole('article').getByText(QUESTION, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('article').getByRole('button', { name: 'Answer', exact: true })).toBeEnabled()
  expect(state.posts).toEqual([])
  expect(state.authorized).toBe(true)
})
