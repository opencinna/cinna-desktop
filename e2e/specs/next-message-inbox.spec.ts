import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * A hand-added A2A agent needs no model credential. Its real protocol ends the
 * turn to ask, so answering is a new message with its saved task/context IDs.
 * The fake follows human-routing.spec.ts: a v0.3 card, loopback JSON-RPC, and a
 * reply computed from what it actually received. No task or ask is seeded.
 *
 * Plain chat covers nonstreaming task responses and restart persistence; the
 * job covers streaming status updates and job completion ownership. Both
 * answer through the real Inbox while the chat remains off screen.
 */
const AGENT = 'Next Message Reporter'
const GOAL = 'Prepare the weekly briefing.'
const JOB = 'Weekly briefing job'
const QUESTION_ONE = 'Which audience should the briefing address?'
const QUESTION_TWO = 'Which section should come first?'
const ANSWER_ONE = 'Leadership, include the revenue risks'
const ANSWER_TWO = 'Start with the forecast'
const DONE = 'The briefing is ready: lighthouse-4382.'
const WRONG = 'The fixture received the wrong answer or conversation context.'
const A2A_TASK = 'briefing-task'
const A2A_CONTEXT = 'briefing-context'

interface SentMessage {
  kind?: string
  messageId?: string
  role?: string
  contextId?: string
  taskId?: string
  parts?: { kind: string; text?: string }[]
}
interface FakeAgent {
  origin: string
  server: Server
  sends: { method: string; message: SentMessage; text: string }[]
}

async function startAgent(streaming: boolean, twoQuestions: boolean): Promise<FakeAgent> {
  const fake: FakeAgent = { origin: '', server: undefined as unknown as Server, sends: [] }
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        name: AGENT, description: AGENT, url: `${fake.origin}/a2a`,
        protocolVersion: '0.3.0', version: '1.0.0', capabilities: { streaming },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: []
      }))
      return
    }
    if (req.method === 'POST' && req.url === '/a2a') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const rpc = JSON.parse(body) as {
          id: string | number; method: string; params?: { message?: SentMessage }
        }
        const message = rpc.params?.message ?? {}
        const text = (message.parts ?? []).filter((part) => part.kind === 'text')
          .map((part) => part.text ?? '').join('')
        const index = fake.sends.length
        fake.sends.push({ method: rpc.method, message, text })
        const expected = index === 0 ? GOAL : index === 1 ? ANSWER_ONE : ANSWER_TWO
        const resumed = index === 0 ||
          (message.contextId === A2A_CONTEXT && message.taskId === A2A_TASK)
        const valid = text === expected && resumed &&
          rpc.method === (streaming ? 'message/stream' : 'message/send')
        const asking = valid && (index === 0 || (twoQuestions && index === 1))
        const reply = !valid ? WRONG : asking ? (index === 0 ? QUESTION_ONE : QUESTION_TWO) : DONE
        const status = {
          state: asking ? 'input-required' : 'completed',
          message: {
            kind: 'message', messageId: `reply-${index}`, role: 'agent',
            parts: [{ kind: 'text', text: reply }]
          }
        }
        const result = streaming
          ? { kind: 'status-update', taskId: A2A_TASK, contextId: A2A_CONTEXT, status, final: true }
          : { kind: 'task', id: A2A_TASK, contextId: A2A_CONTEXT, status }
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`)
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.server = server
  return fake
}

async function addAgent(cinna: CinnaApp, fake: FakeAgent): Promise<string> {
  const created = await cinna.page.evaluate(({ origin, name }) => window.api.agents.upsert({
    name, protocol: 'a2a', cardUrl: `${origin}/.well-known/agent-card.json`,
    endpointUrl: `${origin}/a2a`
  }), { origin: fake.origin, name: AGENT })
  if (!created.success || !created.id) throw new Error(`agents.upsert failed: ${created.error}`)
  return created.id
}

const inbox = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: /^Inbox/ })
const rowFor = (cinna: CinnaApp, question: string) =>
  cinna.page.getByRole('article').filter({ hasText: question })

async function openInbox(cinna: CinnaApp): Promise<void> {
  await expect(inbox(cinna)).toHaveAccessibleName('Inbox — 1 waiting', { timeout: 20_000 })
  await inbox(cinna).click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)
}

async function answer(cinna: CinnaApp, question: string, text: string): Promise<void> {
  await rowFor(cinna, question).getByRole('button', { name: 'Answer', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Other (enter custom answer)', exact: true }).click()
  await cinna.page.getByPlaceholder('Type your answer…').fill(text)
  await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(rowFor(cinna, question).getByText(`Answered: ${text}.`, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)
}

async function assertNoModel(cinna: CinnaApp): Promise<void> {
  expect(await cinna.page.evaluate(() => window.api.providers.list())).toEqual([])
  expect(await cinna.page.evaluate(() => window.api.chatModes.list())).toEqual([])
}

function assertContinuation(fake: FakeAgent, expectedAnswers: string[]): void {
  expect(fake.sends.map((send) => send.text)).toEqual([GOAL, ...expectedAnswers])
  for (const send of fake.sends.slice(1)) {
    expect(send.message).toMatchObject({ role: 'user', taskId: A2A_TASK, contextId: A2A_CONTEXT })
  }
  const ids = fake.sends.map((send) => send.message.messageId)
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
}

test('a plain A2A next-message ask survives restart and a second ask gets a new Inbox address', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await startAgent(false, true)
  try {
    await cinna.skipOnboarding()
    const agentId = await addAgent(cinna, fake)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await assertNoModel(cinna)
    await cinna.page.getByPlaceholder('Type a message...').fill('@')
    await cinna.page.getByRole('listbox', { name: 'Agents and MCP servers' })
      .getByRole('option').filter({ hasText: AGENT }).click()
    await cinna.page.getByPlaceholder('Type a message...').fill(GOAL)
    await cinna.page.getByPlaceholder('Type a message...').press('Enter')
    await expect(cinna.page.getByText(QUESTION_ONE, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
    // The A2A response has ended; this is a durable continuation, not a live park.
    await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await expect.poll(() => cinna.page.evaluate(() => window.api.tasks.list())).toEqual([
      expect.objectContaining({ goal: GOAL, status: 'blocked', assignee: expect.objectContaining({ agentId }) })
    ])
    const [task] = await cinna.page.evaluate(() => window.api.tasks.list())
    const [firstAsk] = await cinna.page.evaluate(() => window.api.inbox.list())
    expect(firstAsk).toMatchObject({ source: 'local', taskId: task.id, chatId: task.chatId, resume: 'next_message' })
    expect(fake.sends).toHaveLength(1)

    await cinna.relaunch()
    await cinna.skipOnboarding()
    await openInbox(cinna)
    const [afterRestart] = await cinna.page.evaluate(() => window.api.inbox.list())
    expect(afterRestart.requestId).toBe(firstAsk.requestId)
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), task.id)).status).toBe('blocked')
    expect(fake.sends).toHaveLength(1)
    await expect(rowFor(cinna, QUESTION_ONE).getByRole('button', { name: 'Answer', exact: true })).toBeEnabled()

    await answer(cinna, QUESTION_ONE, ANSWER_ONE)
    await expect.poll(async () => (await cinna.page.evaluate(() => window.api.inbox.list())).map((entry) => entry.request))
      .toEqual([expect.objectContaining({ kind: 'question', questions: [expect.objectContaining({ question: QUESTION_TWO })] })])
    const [secondAsk] = await cinna.page.evaluate(() => window.api.inbox.list())
    expect(secondAsk.requestId).not.toBe(firstAsk.requestId)
    expect(secondAsk).toMatchObject({ taskId: task.id, chatId: task.chatId, resume: 'next_message' })
    await expect(rowFor(cinna, QUESTION_TWO).getByRole('button', { name: 'Answer', exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(rowFor(cinna, QUESTION_ONE).getByRole('button')).toHaveText(['Open the task'])
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), task.id)).status).toBe('blocked')

    await answer(cinna, QUESTION_TWO, ANSWER_TWO)
    await expect.poll(async () => (await cinna.page.evaluate((id) => window.api.tasks.get(id), task.id)).status).toBe('completed')
    await expect(inbox(cinna)).toHaveAccessibleName('Inbox')
    assertContinuation(fake, [ANSWER_ONE, ANSWER_TWO])
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), task.chatId!)
    expect(chat?.messages.filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual([GOAL, ANSWER_ONE, ANSWER_TWO])
    expect(chat?.messages.some((message) => message.content === DONE)).toBe(true)
    expect(chat?.messages.some((message) => message.content === WRONG)).toBe(false)
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toHaveLength(1)
    await assertNoModel(cinna)
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})

test('an A2A job stays blocked after its streaming turn ends and completes after an Inbox answer', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await startAgent(true, false)
  try {
    await cinna.skipOnboarding()
    const agentId = await addAgent(cinna, fake)
    const jobId = await cinna.page.evaluate(async ({ agentId, title, prompt }) => {
      const job = await window.api.jobs.create({ type: 'local', title, prompt })
      await window.api.jobs.setAgents(job.id, [agentId])
      return job.id
    }, { agentId, title: JOB, prompt: GOAL })
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
    await cinna.page.getByText(JOB, { exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(cinna.page.getByText(QUESTION_ONE, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
    await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await expect.poll(async () => (await cinna.page.evaluate(() => window.api.tasks.list()))
      .find((task) => task.jobId === jobId)?.status).toBe('blocked')
    const [run] = await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId)
    expect(run.status).toBe('running')
    expect(run.taskId).toBeTruthy()
    const task = await cinna.page.evaluate((id) => window.api.tasks.get(id), run.taskId!)
    expect(task.chatId).toBe(run.localChatId)
    await openInbox(cinna)
    await expect(rowFor(cinna, QUESTION_ONE).getByText(JOB, { exact: true })).toBeVisible()
    // Re-read after navigating away, so a late turn-completion hook cannot
    // silently mark the still-waiting job successful after the first read.
    expect((await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId))[0].status).toBe('running')
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), task.id)).status).toBe('blocked')
    await answer(cinna, QUESTION_ONE, ANSWER_ONE)
    await expect.poll(async () => (await cinna.page.evaluate((id) => window.api.tasks.get(id), task.id)).status).toBe('completed')
    await expect.poll(async () => (await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId))[0].status).toBe('succeeded')
    await expect(inbox(cinna)).toHaveAccessibleName('Inbox')
    assertContinuation(fake, [ANSWER_ONE])
    const [finishedRun] = await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId)
    expect(finishedRun).toMatchObject({ id: run.id, taskId: task.id, localChatId: task.chatId })
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), task.chatId!)
    expect(chat?.messages.some((message) => message.content === DONE)).toBe(true)
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toHaveLength(1)
    await assertNoModel(cinna)
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})
