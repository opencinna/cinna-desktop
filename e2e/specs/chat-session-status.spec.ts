import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Real sidebar → IPC → run registry → A2A cancellation and persisted results.
 * The loopback agent holds each stream until this spec releases it; there are
 * no timers, seeded run results, replacement IPC handlers, or model keys.
 * CSS opacity is asserted explicitly: Playwright considers opacity-zero icons
 * visible, which would miss the original disappearing-spinner regression.
 */
const CHAT = 'Sidebar status session'
const OTHER = 'Another saved conversation'
const NOTE = 'Only this conversation is open.'
const DRAFT = 'Preserve this unsent draft.'
const PROMPT = 'Prepare the sidebar status report.'
const PARTIAL = 'The status report has started: birch-8315.'
const FINAL = 'The status report is ready: juniper-2946.'
const QUESTION = 'Which audience should receive the status report?'
const FAILURE = 'The status report could not be completed.'
const TASK = 'sidebar-status-task'
const labels = {
  completed: 'Completed — unread results',
  needs_input: 'Needs input — unread results',
  failed: 'Failed — unread results'
} as const
type Outcome = keyof typeof labels
const outcomeText = (outcome: Outcome) => outcome === 'completed' ? FINAL : outcome === 'needs_input' ? QUESTION : FAILURE
const visibleResult = (outcome: Outcome) => PARTIAL + outcomeText(outcome)
interface Rpc { id: string | number; method: string; params?: { id?: string; message?: { parts?: { kind: string; text?: string }[] } } }

async function serve() {
  let host = ''
  let response: ServerResponse | undefined
  let requestId: string | number = ''
  let closed = 0
  const requests: Rpc[] = []
  const emit = (state: string, text: string, final: boolean): void => {
    if (!response) throw new Error('The agent has not received a turn')
    response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: requestId, result: {
      kind: 'status-update', taskId: TASK, contextId: 'sidebar-status-context', final,
      status: { state, message: { kind: 'message', messageId: final ? 'final' : 'partial',
        role: 'agent', parts: [{ kind: 'text', text }] } }
    } })}\n\n`)
    if (final) response.end()
  }
  const server = createServer((req, res) => {
    const send = (body: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      send({ name: 'Sidebar Reporter', description: 'Sidebar Reporter', url: `${host}/a2a`,
        protocolVersion: '0.3.0', version: '1.0.0', capabilities: { streaming: true },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] })
      return
    }
    if (req.method !== 'POST' || req.url !== '/a2a') { res.statusCode = 404; send({}); return }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const rpc = JSON.parse(raw) as Rpc
      requests.push(rpc)
      if (rpc.method === 'tasks/cancel') {
        send({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: TASK,
          contextId: 'sidebar-status-context', status: { state: 'canceled' } } })
        // Keep the stream open: the client's abort must actually close it.
        return
      }
      const text = (rpc.params?.message?.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text ?? '').join('')
      if (rpc.method !== 'message/stream' || text !== PROMPT) { res.statusCode = 400; send({ error: 'Unexpected sidebar report request' }); return }
      requestId = rpc.id
      response = res
      res.on('close', () => { if (!res.writableEnded) closed += 1 })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      emit('working', PARTIAL, false)
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    host, requests, closed: () => closed,
    finish: (outcome: Outcome) => emit(outcome === 'needs_input' ? 'input-required' : outcome, outcomeText(outcome), true),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  }
}

const row = (cinna: CinnaApp) => cinna.page.getByText(CHAT, { exact: true }).locator('..')
const saved = (cinna: CinnaApp, id: string) => cinna.page.evaluate(async (chatId) =>
  (await window.api.chat.list()).find((chat) => chat.id === chatId), id)

async function arrange(cinna: CinnaApp, host: string): Promise<string> {
  await cinna.skipOnboarding()
  const id = await cinna.page.evaluate(async ({ host, names }) => {
    await window.api.settings.set('autoChatTitles', false)
    const agent = await window.api.agents.upsert({ name: 'Sidebar Reporter', protocol: 'a2a',
      cardUrl: `${host}/.well-known/agent-card.json`, endpointUrl: `${host}/a2a` })
    if (!agent.success || !agent.id) throw new Error(`Could not arrange agent: ${agent.error}`)
    const other = await window.api.chat.create()
    await window.api.chat.update(other.id, { title: names.other })
    await window.api.chat.addMessage(other.id, { role: 'user', content: names.note })
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title: names.chat, agentId: agent.id, router: 'direct' })
    await window.api.chat.showInList(chat.id)
    return chat.id
  }, { host, names: { chat: CHAT, other: OTHER, note: NOTE } })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByText(CHAT, { exact: true }).click()
  await cinna.page.getByPlaceholder('Type a message...').fill(PROMPT)
  await cinna.page.getByPlaceholder('Type a message...').press('Enter')
  await expect(cinna.page.getByText(PARTIAL, { exact: true })).toBeVisible()
  return id
}

async function switchAway(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByText(OTHER, { exact: true }).click()
  await expect(cinna.page.getByText(NOTE, { exact: true })).toBeVisible()
  await cinna.page.getByPlaceholder('Type a message...').fill(DRAFT)
  // Ensure both pointer and keyboard focus are outside the running row.
  await cinna.page.getByPlaceholder('Type a message...').hover()
}

async function assertSpinner(cinna: CinnaApp): Promise<void> {
  const action = row(cinna).getByRole('button', { name: 'Interrupt session', exact: true })
  await expect(action).toBeEnabled()
  await expect(action).toHaveCSS('opacity', '1')
  const spinner = action.locator('svg.lucide-loader-circle')
  await expect(spinner).toHaveCSS('opacity', '1')
  await expect(spinner).toHaveCSS('animation-name', 'spin')
  await expect(row(cinna).getByRole('button', { name: 'Delete session', exact: true })).toHaveCount(0)
}

test('a background session keeps its spinner and can be interrupted then deleted without opening it', async ({ cinna }) => {
  const fake = await serve()
  try {
    const id = await arrange(cinna, fake.host)
    await switchAway(cinna)
    await assertSpinner(cinna)
    await row(cinna).hover()
    const action = row(cinna).getByRole('button', { name: 'Interrupt session', exact: true })
    await expect(action.locator('svg.lucide-loader-circle')).toHaveCSS('opacity', '0')
    await expect(action.locator('svg.lucide-square')).toHaveCSS('opacity', '1')
    await action.click()
    await expect.poll(fake.closed).toBe(1)
    await expect.poll(() => fake.requests.filter((rpc) => rpc.method === 'tasks/cancel'))
      .toEqual([expect.objectContaining({ params: { id: TASK } })])
    await expect(row(cinna).getByRole('button', { name: 'Delete session', exact: true })).toBeEnabled()
    await expect.poll(async () => (await saved(cinna, id))?.lastRunResult)
      .toEqual(expect.objectContaining({ status: 'canceled', unread: false }))
    await expect(row(cinna).getByRole('img')).toHaveCount(0)
    await expect(cinna.page.getByText(NOTE, { exact: true })).toBeVisible()
    await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveValue(DRAFT)
    await row(cinna).getByRole('button', { name: 'Delete session', exact: true }).click()
    await expect(cinna.page.getByText(CHAT, { exact: true })).toHaveCount(0)
    await expect.poll(() => cinna.page.evaluate(() => window.api.chat.list()))
      .toEqual([expect.objectContaining({ title: OTHER })])
    expect(fake.requests.filter((rpc) => rpc.method === 'message/stream')).toHaveLength(1)
  } finally { await fake.close() }
})

for (const outcome of ['completed', 'needs_input', 'failed'] as const) {
  test(`a background ${outcome} result stays unread through restart until its conversation opens`, async ({ cinna }) => {
    test.setTimeout(90_000)
    const fake = await serve()
    try {
      const id = await arrange(cinna, fake.host)
      await switchAway(cinna)
      await assertSpinner(cinna)
      fake.finish(outcome)
      await expect(row(cinna).getByRole('img', { name: labels[outcome], exact: true })).toHaveCSS('opacity', '1')
      await expect(row(cinna).getByRole('button', { name: 'Interrupt session', exact: true })).toHaveCount(0)
      await expect.poll(async () => (await saved(cinna, id))?.lastRunResult)
        .toEqual(expect.objectContaining({ status: outcome, unread: true }))
      await expect(cinna.page.getByText(NOTE, { exact: true })).toBeVisible()
      await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveValue(DRAFT)
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await expect(row(cinna).getByRole('img', { name: labels[outcome], exact: true })).toHaveCSS('opacity', '1')
      await cinna.page.getByText(CHAT, { exact: true }).click()
      await expect(cinna.page.getByText(visibleResult(outcome), { exact: true }).first()).toBeVisible()
      await expect(row(cinna).getByRole('img')).toHaveCount(0)
      await expect.poll(async () => (await saved(cinna, id))?.lastRunResult)
        .toEqual(expect.objectContaining({ status: outcome, unread: false }))
      await switchAway(cinna)
      await expect(row(cinna).getByRole('img')).toHaveCount(0)
      expect(fake.requests.filter((rpc) => rpc.method === 'message/stream')).toHaveLength(1)
      expect(fake.requests.filter((rpc) => rpc.method === 'tasks/cancel')).toHaveLength(0)
    } finally { await fake.close() }
  })
}

for (const outcome of ['completed', 'needs_input', 'failed'] as const) {
  test(`a foreground ${outcome} result does not gain an unread badge after switching away`, async ({ cinna }) => {
    const fake = await serve()
    try {
      const id = await arrange(cinna, fake.host)
      fake.finish(outcome)
      await expect(cinna.page.getByText(visibleResult(outcome), { exact: true }).first()).toBeVisible()
      await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
      await expect.poll(async () => (await saved(cinna, id))?.lastRunResult)
        .toEqual(expect.objectContaining({ status: outcome, unread: false }))
      await switchAway(cinna)
      await expect(row(cinna).getByRole('img')).toHaveCount(0)
      await expect(row(cinna).getByRole('button', { name: 'Interrupt session', exact: true })).toHaveCount(0)
    } finally { await fake.close() }
  })
}
