import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

const AGENT = 'Live Attachment Reporter'
const CHAT_A = 'Live attachment A'
const CHAT_B = 'Unrelated saved conversation'
const B_TEXT = 'This conversation contains only its own saved note.'
const DRAFT = 'Keep this unsent draft in the unrelated conversation.'
const FIRST = 'First live finding: willow-4381.'
const SECOND = ' Second live finding: granite-7295.'
const THIRD = ' Third live finding: meadow-5163.'
const PROMPT = 'Report three findings as they become available.'
const TASK_TITLE = 'Continue the live attachment report'
const GOAL = 'Prepare the live attachment report.'
const DESCRIPTION = 'The initial figures are verified; inspect the forecast next.'
const TASK_PROMPT = `Continue this task.\n\nGoal:\n${GOAL}\n\nCurrent description:\n${DESCRIPTION}`
const REMOTE_ID = 'live-attachment-report'
const A2A_TASK_ID = 'live-report-protocol-task'
const TOKEN = 'live-attach-fixture-token'

interface Rpc { id: string | number; method: string; params?: { id?: string; message?: { parts?: { kind: string; text?: string }[] } } }

async function serve(withRemoteTask = false): Promise<{
  host: string; server: Server; requests: Rpc[]; emit: (text: string) => void; closed: () => number
}> {
  let host = ''
  let response: ServerResponse | undefined
  let requestId: string | number = ''
  let closed = 0
  const requests: Rpc[] = []
  const task = { id: REMOTE_ID, short_code: 'LIVE-43', title: TASK_TITLE, original_message: GOAL,
    current_description: DESCRIPTION, status: 'blocked', priority: 'normal', updated_at: new Date().toISOString() }
  const emit = (text: string): void => {
    if (!response) throw new Error('The streaming request has not arrived')
    // A single growing protocol message becomes incremental RunEvent deltas.
    response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: requestId, result: {
      kind: 'status-update', taskId: A2A_TASK_ID, contextId: 'live-report-context', final: false,
      status: { state: 'working', message: { kind: 'message', messageId: 'live-report-message',
        role: 'agent', parts: [{ kind: 'text', text }] } }
    } })}\n\n`)
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (value: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      send({ name: AGENT, description: AGENT, url: `${host}/a2a`, protocolVersion: '0.3.0', version: '1.0.0',
        capabilities: { streaming: true }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] })
      return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/a2a') {
        const rpc = JSON.parse(raw) as Rpc
        requests.push(rpc)
        if (rpc.method === 'tasks/cancel') {
          send({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: A2A_TASK_ID,
            contextId: 'live-report-context', status: { state: 'canceled' } } })
          return
        }
        const text = (rpc.params?.message?.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text ?? '').join('')
        if (rpc.method !== 'message/stream' || text !== (withRemoteTask ? TASK_PROMPT : PROMPT)) {
          res.statusCode = 400; send({ error: 'Unexpected live attachment request' }); return
        }
        requestId = rpc.id
        response = res
        res.on('close', () => { if (!res.writableEnded) closed += 1 })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        emit(FIRST)
        return
      }
      if (!withRemoteTask || req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401; send({ detail: 'This is an isolated fixture account' }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/tasks/') {
        const since = url.searchParams.get('updated_since')
        const include = url.searchParams.get('status') === 'active' || (!!since && Date.parse(task.updated_at) > Date.parse(since))
        send({ data: include ? [task] : [], count: include ? 1 : 0 }); return
      }
      if (req.method === 'GET' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/detail`) { send(task); return }
      if (req.method === 'GET' && (url.pathname.endsWith('/sessions') || url.pathname.endsWith('/subtasks/'))) {
        send({ data: [], count: 0 }); return
      }
      if ((req.method === 'POST' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/status`) ||
        (req.method === 'PATCH' && url.pathname === `/api/v1/tasks/${REMOTE_ID}`)) {
        Object.assign(task, JSON.parse(raw), { updated_at: new Date().toISOString() }); send(task); return
      }
      res.statusCode = 404; send({ detail: 'No fixture route' })
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { host, server, requests, emit, closed: () => closed }
}

async function arrange(cinna: CinnaApp, host: string, directChat: boolean): Promise<{ agentId: string; chatA: string | null; chatB: string }> {
  await cinna.skipOnboarding()
  const result = await cinna.page.evaluate(async ({ host, directChat, names }) => {
    const agent = await window.api.agents.upsert({ name: names.agent, protocol: 'a2a',
      cardUrl: `${host}/.well-known/agent-card.json`, endpointUrl: `${host}/a2a` })
    if (!agent.success || !agent.id) throw new Error('Could not create fixture agent')
    const b = await window.api.chat.create()
    await window.api.chat.update(b.id, { title: names.b })
    await window.api.chat.addMessage(b.id, { role: 'user', content: names.note })
    let chatA: string | null = null
    if (directChat) {
      const a = await window.api.chat.create()
      await window.api.chat.update(a.id, { title: names.a, agentId: agent.id, router: 'direct' })
      await window.api.chat.showInList(a.id)
      chatA = a.id
    }
    return { agentId: agent.id, chatA, chatB: b.id }
  }, { host, directChat, names: { agent: AGENT, a: CHAT_A, b: CHAT_B, note: B_TEXT } })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  return result
}

async function linkSandboxAccount(cinna: CinnaApp, host: string): Promise<void> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${app.getPath('userData')}/cinna.db`)
    try {
      const token = safeStorage.encryptString(input.token)
      db.prepare(`UPDATE users SET type = 'cinna_user', cinna_server_url = ?, cinna_access_token_enc = ?,
        cinna_refresh_token_enc = ?, cinna_token_expires_at = ? WHERE id = ?`)
        .run(input.host, token, token, Date.now() + 3_600_000, input.userId)
    } finally { db.close() }
  }, { host, token: TOKEN, userId: user!.id })
}

/**
 * The composer by role, not placeholder: for ~260ms after every chat switch
 * the chat curtain (`ChatTransition`) keeps an inert, aria-hidden clone of the
 * outgoing view, composer and placeholder included, and every step here that
 * types into the composer lands inside that window — right after a sidebar
 * click. `getByPlaceholder` counts the clone and fails strict mode on two
 * textareas; the role query skips it. This spec was written the day before the
 * curtain arrived and failed from then on. See `e2e_llm.md`, "The chat curtain
 * clones the composer".
 */
function composer(cinna: CinnaApp) {
  return cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
}

async function visitB(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
  await cinna.page.getByText(CHAT_B, { exact: true }).click()
  await expect(cinna.page.getByText(B_TEXT, { exact: true })).toBeVisible()
  await composer(cinna).fill(DRAFT)
}

async function stopAndCheck(cinna: CinnaApp, fake: Awaited<ReturnType<typeof serve>>, chatId: string, prompt: string): Promise<void> {
  await expect(cinna.page.getByText(FIRST + SECOND + THIRD, { exact: true })).toHaveCount(1)
  await cinna.page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 5_000 })
  await expect.poll(fake.closed).toBe(1)
  await expect.poll(() => cinna.page.evaluate(async (id) => (await window.api.chat.get(id))?.messages
    .map((message) => ({ role: message.role, content: message.content })), chatId))
    .toEqual([{ role: 'user', content: prompt }, { role: 'assistant', content: FIRST + SECOND + THIRD }])
  await expect(cinna.page.getByText(FIRST + SECOND + THIRD, { exact: true })).toHaveCount(1)
  await expect.poll(() => fake.requests.filter((rpc) => rpc.method === 'tasks/cancel'))
    .toEqual([expect.objectContaining({ params: { id: A2A_TASK_ID } })])
  expect(fake.requests.filter((rpc) => rpc.method === 'message/stream')).toHaveLength(1)
}

test('returning to an active chat replays its accumulated reply once and keeps another chat clean', async ({ cinna }) => {
  const fake = await serve()
  try {
    const setup = await arrange(cinna, fake.host, true)
    await cinna.page.getByText(CHAT_A, { exact: true }).click()
    await composer(cinna).fill(PROMPT)
    await composer(cinna).press('Enter')
    await expect(cinna.page.getByText(FIRST, { exact: true })).toBeVisible()
    await visitB(cinna)
    fake.emit(FIRST + SECOND)
    // Main's real diagnostic log is a delivery witness, not a mocked event.
    await expect.poll(async () => JSON.stringify(await cinna.page.evaluate(() => window.api.logger.getAll())).includes(SECOND)).toBe(true)
    await expect(cinna.page.getByText(FIRST + SECOND, { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByText(SECOND.trim(), { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await expect(composer(cinna)).toHaveValue(DRAFT)
    await cinna.page.getByText(CHAT_A, { exact: true }).click()
    await expect(cinna.page.getByText(FIRST + SECOND, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    fake.emit(FIRST + SECOND + THIRD)
    await stopAndCheck(cinna, fake, setup.chatA!, PROMPT)
    const other = await cinna.page.evaluate((id) => window.api.chat.get(id), setup.chatB)
    expect(other?.messages.map((message) => message.content)).toEqual([B_TEXT])
  } finally { fake.server.closeAllConnections(); await new Promise<void>((resolve) => fake.server.close(() => resolve())) }
})

test('Task Continue attaches to main-owned live output before the turn finishes', async ({ cinna }) => {
  test.setTimeout(90_000)
  const fake = await serve(true)
  try {
    await arrange(cinna, fake.host, false)
    await linkSandboxAccount(cinna, fake.host)
    await expect.poll(() => cinna.page.evaluate(() => window.api.tasks.list()), { timeout: 20_000 })
      .toEqual([expect.objectContaining({ title: TASK_TITLE, chatId: null, executor: 'remote' })])
    await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
    await cinna.page.getByRole('region', { name: 'Recent tasks', exact: true }).getByRole('button', { name: TASK_TITLE }).click()
    await cinna.page.getByRole('button', { name: 'Take over', exact: true }).click()
    const continuation = cinna.page.getByRole('region', { name: 'Continue this task', exact: true })
    await continuation.getByRole('combobox', { name: 'Continue with', exact: true }).selectOption({ label: AGENT })
    await continuation.getByRole('button', { name: 'Continue', exact: true }).click()
    // This first chunk is sent immediately by HTTP, without a renderer send.
    await expect(cinna.page.getByText(FIRST, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    const [running] = await cinna.page.evaluate(() => window.api.tasks.list())
    expect(running).toMatchObject({ title: TASK_TITLE, executor: 'desktop', status: 'in_progress' })
    expect(running.chatId).toBeTruthy()
    await visitB(cinna)
    fake.emit(FIRST + SECOND)
    await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
    await cinna.page.getByRole('region', { name: 'Recent tasks', exact: true }).getByRole('button', { name: TASK_TITLE }).click()
    await cinna.page.getByRole('button', { name: 'Open the chat', exact: true }).click()
    await expect(cinna.page.getByText(FIRST + SECOND, { exact: true })).toHaveCount(1)
    fake.emit(FIRST + SECOND + THIRD)
    await stopAndCheck(cinna, fake, running.chatId!, TASK_PROMPT)
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
  } finally { fake.server.closeAllConnections(); await new Promise<void>((resolve) => fake.server.close(() => resolve())) }
})

const MODEL = 'qwen3:8b'
const MODEL_CHAT = 'Model tool-round attachment'
const MODEL_PROMPT = 'Ask the analyst for its finding, then explain the result.'
const TOOL_AGENT = 'Attachment Analyst'
const TOOL_PROMPT = 'Return the verified finding.'
const TOOL_RESULT = 'Verified finding: juniper-8246.'
const ROUND_ONE = 'I will ask the analyst for the verified finding.'
const ROUND_TWO = 'The analyst has replied; I am checking the conclusion.'
const ROUND_END = ' The conclusion is ready: quartz-1927.'

interface ModelRequest {
  stream?: boolean
  tools?: { type: string; function: { name: string } }[]
  messages?: { role: string; content?: unknown; tool_call_id?: string }[]
}

async function serveModelTool(): Promise<{
  host: string; server: Server; rounds: ModelRequest[]; toolCalls: Rpc[]; finish: () => void
}> {
  let host = ''
  let finish = (): void => { throw new Error('The second model round has not arrived') }
  const rounds: ModelRequest[] = []
  const toolCalls: Rpc[] = []
  const server = createServer((req, res) => {
    const send = (value: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (req.url === '/api/tags') { send({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }); return }
    if (req.url === '/api/version') { send({ version: '0.6.2' }); return }
    if (req.url === '/.well-known/agent-card.json') {
      send({ name: TOOL_AGENT, description: TOOL_AGENT, url: `${host}/a2a`, protocolVersion: '0.3.0', version: '1.0.0',
        capabilities: { streaming: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] })
      return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/a2a') {
        const rpc = JSON.parse(raw) as Rpc
        toolCalls.push(rpc)
        const text = (rpc.params?.message?.parts ?? []).map((part) => part.text ?? '').join('')
        if (rpc.method !== 'message/send' || text !== TOOL_PROMPT) { res.statusCode = 400; send({ error: 'Incorrect analyst request' }); return }
        send({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'message', messageId: 'analyst-reply', role: 'agent',
          parts: [{ kind: 'text', text: TOOL_RESULT }] } })
        return
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.statusCode = 404; send({}); return }
      const body = JSON.parse(raw) as ModelRequest
      // OpenCode may name its own session through a separate no-tools model
      // request. It is not a conversation round or Cinna's opt-in auto-title.
      if (!body.tools?.length) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ id: 'engine-title', object: 'chat.completion.chunk', created: 1, model: MODEL,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Attachment check' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      rounds.push(body)
      if (!body.stream) { res.statusCode = 400; send({ error: { message: 'The fixture only supports streamed model rounds' } }); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta: unknown, finishReason: string | null = null): void => {
        res.write(`data: ${JSON.stringify({ id: `model-round-${rounds.length}`, object: 'chat.completion.chunk',
          created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
      }
      if (rounds.length === 1) {
        const tool = body.tools?.[0]
        if (!tool || body.tools?.length !== 1) { res.end('data: [DONE]\n\n'); return }
        chunk({ role: 'assistant', content: ROUND_ONE })
        chunk({ tool_calls: [{ index: 0, id: 'call_attachment_analyst', type: 'function',
          function: { name: tool.function.name, arguments: JSON.stringify({ message: TOOL_PROMPT }) } }] })
        chunk({}, 'tool_calls')
        res.end('data: [DONE]\n\n')
      } else if (rounds.length === 2 && body.messages?.some((message) => message.role === 'tool' && message.content === TOOL_RESULT)) {
        chunk({ role: 'assistant', content: ROUND_TWO })
        finish = (): void => { chunk({ content: ROUND_END }); chunk({}, 'stop'); res.end('data: [DONE]\n\n') }
      } else {
        chunk({ content: 'The fixture received an invalid tool-round history.' }, 'stop')
        res.end('data: [DONE]\n\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { host, server, rounds, toolCalls, finish: () => finish() }
}

test('reattaching during a model tool loop shows saved rounds and live replay once', async ({ cinna }) => {
  test.setTimeout(90_000)
  const fake = await serveModelTool()
  try {
    await cinna.skipOnboarding()
    const chatId = await cinna.page.evaluate(async ({ host, names }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Attachment model fixture', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: names.model, isDefault: true })
      const agent = await window.api.agents.upsert({ name: names.agent, protocol: 'a2a',
        cardUrl: `${host}/.well-known/agent-card.json`, endpointUrl: `${host}/a2a` })
      if (!agent.id) throw new Error('Could not configure the analyst')
      const b = await window.api.chat.create()
      await window.api.chat.update(b.id, { title: names.b })
      await window.api.chat.addMessage(b.id, { role: 'user', content: names.note })
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { title: names.chat, providerId: provider.id, modelId: names.model, router: 'coordinator' })
      await window.api.chat.addOnDemandAgent(chat.id, agent.id)
      await window.api.chat.showInList(chat.id)
      return chat.id
    }, { host: fake.host, names: { model: MODEL, agent: TOOL_AGENT, b: CHAT_B, note: B_TEXT, chat: MODEL_CHAT } })
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.getByRole('button', { name: 'Interface', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Switch to verbose mode', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Interface', exact: true }).click()
    await cinna.page.getByText(MODEL_CHAT, { exact: true }).click()
    await composer(cinna).fill(MODEL_PROMPT)
    await composer(cinna).press('Enter')
    await expect.poll(() => fake.rounds.length).toBe(2)
    await expect(cinna.page.getByText(ROUND_TWO, { exact: true })).toHaveCount(1)
    const saved = () => cinna.page.evaluate(async (id) => (await window.api.chat.get(id))?.messages
      .map((message) => ({ role: message.role, content: message.content })), chatId)
    // The open round may already be saved as an in-flight draft (every 2s,
    // DRAFT_INTERVAL_MS); it is updated in place when the round ends.
    await expect.poll(async () => {
      const rows = await saved()
      const last = rows?.at(-1)
      return last?.role === 'assistant' && last.content === ROUND_TWO ? rows!.slice(0, -1) : rows
    }).toEqual([
      { role: 'user', content: MODEL_PROMPT },
      { role: 'assistant', content: ROUND_ONE },
      { role: 'tool_call', content: TOOL_RESULT }
    ])
    // A real tool round is already durable while the next model response is
    // open. Reattachment must choose one presentation for each saved/live part.
    await visitB(cinna)
    await expect(cinna.page.getByText(ROUND_ONE, { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByText(ROUND_TWO, { exact: true })).toHaveCount(0)
    await cinna.page.getByText(MODEL_CHAT, { exact: true }).click()
    await expect(cinna.page.getByText(ROUND_ONE, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByText(TOOL_RESULT, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByText(TOOL_RESULT, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(ROUND_TWO, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    fake.finish()
    await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await expect.poll(saved).toEqual([
      { role: 'user', content: MODEL_PROMPT },
      { role: 'assistant', content: ROUND_ONE },
      { role: 'tool_call', content: TOOL_RESULT },
      { role: 'assistant', content: ROUND_TWO + ROUND_END }
    ])
    await expect(cinna.page.getByText(ROUND_ONE, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByText(TOOL_RESULT, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByText(ROUND_TWO + ROUND_END, { exact: true })).toHaveCount(1)
    expect(fake.rounds).toHaveLength(2)
    expect(fake.toolCalls).toHaveLength(1)
  } finally { fake.server.closeAllConnections(); await new Promise<void>((resolve) => fake.server.close(() => resolve())) }
})
