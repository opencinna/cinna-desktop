import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installConductorAcpEngine } from '../fixtures/conductorAcpEngine'

const MODEL = 'qwen3:8b'
const CHAT = 'Autonomous briefing workspace'
const GOAL = 'Prepare and verify the autonomous quarterly briefing.'
const ANALYST = 'Autonomous Briefing Analyst'
const WRITER = 'Autonomous Briefing Writer'
const DELEGATE = 'Check the revenue figures and report the verified finding.'
const ANALYSIS = 'Revenue figures verified: juniper-6382.'
const QUESTION = 'Which audience should receive the verified briefing?'
const ANSWER = 'Leadership, with regional forecasts.'
const NOTE = 'Revenue is verified. Complete the leadership forecast. Handoff marker: cedar-4197.'
const WRITTEN = 'Leadership forecast finished and checked: quartz-5723.'
const SUMMARY = `Briefing complete. ${ANALYSIS} ${WRITTEN}`
const INTERRUPTED_SUMMARY = `Recovered without repeating the analyst. ${ANALYSIS}`
const CONTROLS = ['delegate', 'handoff', 'ask_user', 'update_task', 'finish']
interface RuntimeStep { sessionId: string; tools: string[]; history: unknown[] }
interface AgentCall { agent: string; method: string; text: string }

async function serve(interrupt: boolean): Promise<{
  host: string; server: Server; runtime: RuntimeStep[]; agents: AgentCall[]; violations: string[];
  releaseFirst: () => void; releaseFinish: () => void
}> {
  let host = ''
  let first = (): void => { throw new Error('Initial runtime request is not ready') }
  let final = (): void => { throw new Error('Final runtime request is not ready') }
  const runtime: RuntimeStep[] = []
  const agents: AgentCall[] = []
  const violations: string[] = []
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const send = (value: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (path === '/api/tags') { send({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }); return }
    if (path === '/api/version') { send({ version: '0.6.2' }); return }
    const agentName = path.startsWith('/analyst/') ? ANALYST : path.startsWith('/writer/') ? WRITER : null
    if (agentName && path.endsWith('/.well-known/agent-card.json')) {
      send({ name: agentName, description: agentName, url: `${host}/${agentName === ANALYST ? 'analyst' : 'writer'}/a2a`,
        protocolVersion: '0.3.0', version: '1.0.0', capabilities: { streaming: false },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] })
      return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (agentName && path.endsWith('/a2a')) {
        const rpc = JSON.parse(raw) as { id: string | number; method: string;
          params?: { message?: { parts?: { kind: string; text?: string }[] } } }
        const text = (rpc.params?.message?.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text ?? '').join('')
        agents.push({ agent: agentName, method: rpc.method, text })
        const valid = rpc.method === 'message/send' && (agentName === ANALYST ? text === DELEGATE :
          [GOAL, ANALYSIS, ANSWER, NOTE].every((marker) => text.includes(marker)))
        if (!valid) violations.push(`Incorrect ${agentName} request/context: ${text}`)
        send({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: agentName === ANALYST ? 'analysis-task' : 'writing-task',
          contextId: agentName === ANALYST ? 'analysis-context' : 'writing-context', status: { state: valid ? 'completed' : 'failed',
            message: { kind: 'message', messageId: `agent-reply-${agents.length}`, role: 'agent',
              parts: [{ kind: 'text', text: valid ? (agentName === ANALYST ? ANALYSIS : WRITTEN) : 'The handoff context is incomplete.' }] } } } })
        return
      }
      if (req.method !== 'POST' || path !== '/runtime/step') { res.statusCode = 404; send({}); return }
      const body = JSON.parse(raw) as RuntimeStep
      runtime.push(body)
      const index = runtime.length
      const history = JSON.stringify(body.history)
      const validTools = CONTROLS.every((name) => body.tools.filter((tool) => tool === name).length === 1)
      if (!validTools) violations.push(`Runtime step ${index} is missing coordinator controls`)
      const control = (name: string, args: unknown): void => send({ name, args, id: `autonomous-call-${index}` })
      if (index === 1) {
        if (!history.includes(GOAL)) violations.push('Initial goal missing')
        first = () => control('delegate', { agent: ANALYST, message: DELEGATE })
      } else if (index === 2) {
        if (!history.includes(ANALYSIS)) violations.push('Delegated result missing from coordinator history')
        if (!interrupt) control('ask_user', { question: QUESTION })
        // Interruption case deliberately holds before headers after the agent
        // already performed its work. Relaunch must not repeat that side effect.
      } else if (interrupt && index === 3) {
        if (!history.includes(ANALYSIS) || !history.includes('Do not repeat completed side effects.')) violations.push('Recovery context is missing')
        final = () => control('finish', { summary: INTERRUPTED_SUMMARY })
      } else if (!interrupt && index === 3) {
        if (![ANALYSIS, QUESTION, ANSWER].every((marker) => history.includes(marker))) violations.push('Durable answer/history missing')
        control('handoff', { agent: WRITER, note: NOTE })
      } else if (!interrupt && index === 4) {
        const missing = [ANALYSIS, WRITTEN, `${WRITER} handed the task back to the coordinator.`].filter((marker) => !history.includes(marker))
        if (missing.length) violations.push(`Completed specialist handback/history missing: ${missing.join('; ')}`)
        final = () => control('finish', { summary: SUMMARY })
      } else { violations.push(`Unexpected runtime continuation ${index}`); control('finish', { summary: 'Unexpected extra continuation.' }) }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { host, server, runtime, agents, violations, releaseFirst: () => first(), releaseFinish: () => final() }
}

async function arrange(cinna: CinnaApp, host: string): Promise<string> {
  await cinna.skipOnboarding()
  await installConductorAcpEngine(cinna, host)
  const chatId = await cinna.page.evaluate(async ({ host, model, chatTitle, analyst, writer }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Autonomous fixture model', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, engine: 'opencode', toolPolicy: 'connectors', isDefault: true })
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title: chatTitle, providerId: provider.id, modelId: model, router: 'coordinator' })
    for (const [name, path] of [[analyst, 'analyst'], [writer, 'writer']]) {
      const agent = await window.api.agents.upsert({ name, protocol: 'a2a', cardUrl: `${host}/${path}/.well-known/agent-card.json`, endpointUrl: `${host}/${path}/a2a` })
      if (!agent.id) throw new Error('Could not configure autonomous fixture agent')
      await window.api.chat.addOnDemandAgent(chat.id, agent.id)
    }
    await window.api.chat.showInList(chat.id)
    return chat.id
  }, { host, model: MODEL, chatTitle: CHAT, analyst: ANALYST, writer: WRITER })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByText(CHAT, { exact: true }).click()
  return chatId
}

async function start(cinna: CinnaApp, fake: Awaited<ReturnType<typeof serve>>): Promise<string> {
  await cinna.page.getByRole('button', { name: 'Add to chat', exact: true }).click()
  await cinna.page.getByRole('menuitem', { name: 'Run on its own…', exact: true }).click()
  const dialog = cinna.page.getByRole('dialog', { name: 'Run on its own', exact: true })
  await dialog.getByRole('textbox', { name: 'Goal', exact: true }).fill(GOAL)
  await dialog.getByRole('button', { name: 'Start task', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => fake.runtime.length).toBe(1)
  const [task] = await cinna.page.evaluate(() => window.api.tasks.list())
  expect(task).toMatchObject({ goal: GOAL, status: 'in_progress', runtime: { state: 'running' } })
  await openInbox(cinna)
  fake.releaseFirst()
  return task.id
}
async function openInbox(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveCount(0)
}
async function openTask(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await cinna.page.getByRole('region', { name: 'Recent tasks', exact: true }).getByRole('button', { name: GOAL }).click()
}
async function finalTranscript(cinna: CinnaApp, chatId: string, summary: string, calls: number[]): Promise<void> {
  await openTask(cinna)
  await cinna.page.getByRole('button', { name: 'Open the chat', exact: true }).click()
  await expect(cinna.page.getByText(summary, { exact: true })).toHaveCount(1)
  const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
  expect(chat?.messages.filter((message) => message.role === 'assistant' && message.content === summary)).toHaveLength(1)
  expect(chat?.messages.filter((message) => message.role === 'error')).toEqual([])
  expect(chat?.messages.filter((message) => message.role === 'tool_call').map((message) => message.toolCallId))
    .toEqual(calls.map((index) => `autonomous-call-${index}`))
}

test('an autonomous coordinator delegates, survives a durable Inbox gate, hands off and finishes with chat closed', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await serve(false)
  try {
    const chatId = await arrange(cinna, fake.host)
    const taskId = await start(cinna, fake)
    await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), taskId))
      .toMatchObject({ status: 'blocked', runtime: { state: 'waiting', ownerTurns: 1 } })
    const entries = await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)
    expect(entries).toEqual([expect.objectContaining({ taskId, chatId, deliveryOwner: 'runner', agentId: null })])
    const gateId = entries[0].requestId
    expect(fake.runtime).toHaveLength(2)
    expect(fake.agents.map((call) => call.agent)).toEqual([ANALYST])
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await openInbox(cinna)
    await expect.poll(() => cinna.page.evaluate(async () => (await window.api.inbox.list()).entries))
      .toEqual([expect.objectContaining({ requestId: gateId, taskId, deliveryOwner: 'runner' })])
    const row = cinna.page.getByRole('article').filter({ hasText: QUESTION })
    await expect(row).toBeVisible()
    expect(fake.runtime).toHaveLength(2)
    expect(fake.agents).toHaveLength(1)
    await row.getByRole('button', { name: 'Answer', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Other (enter custom answer)', exact: true }).click()
    await cinna.page.getByPlaceholder('Type your answer…').fill(ANSWER)
    await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
    await expect.poll(() => fake.runtime.length).toBe(4)
    expect(fake.agents.map((call) => call.agent)).toEqual([ANALYST, WRITER])
    expect(fake.violations).toEqual([])
    expect(await cinna.page.evaluate((id) => window.api.tasks.get(id), taskId))
      .toMatchObject({ status: 'in_progress', assignee: { kind: 'agent' }, runtime: { ownerTurns: 4 } })
    fake.releaseFinish()
    await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), taskId))
      .toMatchObject({ status: 'completed', runtime: { state: 'completed', ownerTurns: 4 } })
    expect(await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)).toEqual([])
    await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveCount(0)
    await finalTranscript(cinna, chatId, SUMMARY, [1, 2, 3, 4])
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
    expect(chat?.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([GOAL, ANSWER])
    expect(chat?.messages.filter((message) => message.role === 'agent_transition').map((message) => message.content))
      .toEqual(expect.arrayContaining([`Task handed to ${WRITER}.\n${NOTE}`, `${WRITER} handed the task back to the coordinator.`]))
    expect(fake.runtime).toHaveLength(4)
    expect(fake.agents).toHaveLength(2)
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toHaveLength(1)
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
  } finally { fake.server.closeAllConnections(); await new Promise<void>((resolve) => fake.server.close(() => resolve())) }
})

test('an interrupted autonomous runtime turn requires explicit resume without repeating completed delegation', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await serve(true)
  try {
    const chatId = await arrange(cinna, fake.host)
    const taskId = await start(cinna, fake)
    await expect.poll(() => fake.runtime.length).toBe(2)
    expect(fake.agents.map((call) => call.agent)).toEqual([ANALYST])
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await openTask(cinna)
    await expect(cinna.page.getByText('Execution interrupted', { exact: true })).toBeVisible()
    const resume = cinna.page.getByRole('button', { name: 'Resume task', exact: true })
    await expect(resume).toBeEnabled()
    expect(fake.runtime).toHaveLength(2)
    expect(fake.agents).toHaveLength(1)
    await resume.click()
    await openInbox(cinna)
    await expect.poll(() => fake.runtime.length).toBe(3)
    expect(fake.violations).toEqual([])
    expect(fake.agents).toHaveLength(1)
    fake.releaseFinish()
    await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), taskId))
      .toMatchObject({ status: 'completed', runtime: { state: 'completed' } })
    await finalTranscript(cinna, chatId, INTERRUPTED_SUMMARY, [1, 3])
    expect(fake.runtime).toHaveLength(3)
    expect(fake.agents).toHaveLength(1)
  } finally { fake.server.closeAllConnections(); await new Promise<void>((resolve) => fake.server.close(() => resolve())) }
})
