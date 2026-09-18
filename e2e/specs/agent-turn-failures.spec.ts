import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '../fixtures/app'

const AGENT = 'Failure Reporting Agent'
const PROMPT = 'Validate the quarterly briefing before publication.'
const FAILED_TASK_ERROR = 'The quarterly briefing failed validation: cedar-7632.'
const TASK_FAILED = 'The agent reported that its task failed.'
const RPC_ERROR = 'The briefing service could not execute this request: maple-5291.'

interface Request { method: string; text: string }

/** Real A2A wire failures. No IPC handler or task outcome is substituted. */
async function serve(streaming: boolean): Promise<{ host: string; server: Server; requests: Request[] }> {
  let host = ''
  const requests: Request[] = []
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: AGENT, description: AGENT, url: `${host}/a2a`,
        protocolVersion: '0.3.0', version: '1.0.0', capabilities: { streaming },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/a2a') { res.writeHead(404); res.end(); return }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const rpc = JSON.parse(raw) as { id: string | number; method: string;
        params?: { message?: { parts?: { kind: string; text?: string }[] } } }
      const text = (rpc.params?.message?.parts ?? []).filter((part) => part.kind === 'text')
        .map((part) => part.text ?? '').join('')
      requests.push({ method: rpc.method, text })
      if (rpc.method !== (streaming ? 'message/stream' : 'message/send') || text !== PROMPT) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unexpected failure fixture request' }))
        return
      }
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
          kind: 'status-update', taskId: 'failed-briefing-task', contextId: 'failed-briefing-context', final: true,
          status: { state: 'failed', message: { kind: 'message', messageId: 'failed-briefing-message', role: 'agent',
            parts: [{ kind: 'text', text: FAILED_TASK_ERROR }] } }
        } })}\n\n`)
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: RPC_ERROR } }))
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { host, server, requests }
}

for (const streaming of [true, false]) {
  test(streaming
    ? 'a streamed failed A2A task records a failed job attempt and a visible saved error'
    : 'a nonstreaming A2A JSON-RPC error records a failed job attempt instead of success', async ({ cinna }) => {
    test.setTimeout(90_000)
    const fake = await serve(streaming)
    const error = streaming ? FAILED_TASK_ERROR : RPC_ERROR
    const title = streaming ? 'Streamed failure briefing' : 'JSON-RPC failure briefing'
    try {
      await cinna.skipOnboarding()
      const jobId = await cinna.page.evaluate(async ({ host, agentName, title, prompt }) => {
        await window.api.settings.set('autoChatTitles', false)
        const agent = await window.api.agents.upsert({ name: agentName, protocol: 'a2a',
          cardUrl: `${host}/.well-known/agent-card.json`, endpointUrl: `${host}/a2a` })
        if (!agent.success || !agent.id) throw new Error('Could not configure the failure fixture agent')
        const job = await window.api.jobs.create({ type: 'local', title, prompt })
        await window.api.jobs.setAgents(job.id, [agent.id])
        return job.id
      }, { host: fake.host, agentName: AGENT, title, prompt: PROMPT })
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
      await cinna.page.getByText(title, { exact: true }).click()
      await cinna.page.getByRole('button', { name: 'Run', exact: true }).click()
      await expect(cinna.page.getByText(error, { exact: true })).toBeVisible()
      if (streaming) await expect(cinna.page.getByText(TASK_FAILED, { exact: true })).toBeVisible()
      await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
      await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
      await expect.poll(() => cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId))
        .toEqual([expect.objectContaining({ status: 'failed' })])
      const [run] = await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId)
      expect(run.taskId).toBeTruthy()
      expect(run.localChatId).toBeTruthy()
      const task = await cinna.page.evaluate((id) => window.api.tasks.get(id), run.taskId!)
      expect(task).toMatchObject({ status: 'error', chatId: run.localChatId, jobId })
      const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), run.localChatId!)
      // A failed task's own answer is kept as a row above the error, which then
      // says only that it failed, so the agent's words appear once.
      expect(chat?.messages.map((message) => message.role)).toEqual(streaming ? ['user', 'assistant', 'error'] : ['user', 'error'])
      expect(chat?.messages[0].content).toBe(PROMPT)
      if (streaming) expect(chat?.messages[1].content).toBe(error)
      expect(JSON.parse(chat!.messages.at(-1)!.content)).toMatchObject({ short: streaming ? TASK_FAILED : error })
      await expect(cinna.page.getByText(error, { exact: true })).toHaveCount(1)
      await cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true }).fill('I can retry after fixing the report.')
      await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
      await cinna.page.getByRole('button', { name: `From job ${title}`, exact: true }).click()
      await expect(cinna.page.getByText('Failed', { exact: true })).toBeVisible()
      await expect(cinna.page.getByText('Succeeded', { exact: true })).toHaveCount(0)
      await expect(cinna.page.getByLabel('Running', { exact: true })).toHaveCount(0)
      expect(fake.requests).toEqual([{ method: streaming ? 'message/stream' : 'message/send', text: PROMPT }])
      expect(await cinna.page.evaluate(() => window.api.providers.list())).toEqual([])
      expect(await cinna.page.evaluate(() => window.api.chatModes.list())).toEqual([])
    } finally { fake.server.closeAllConnections(); await new Promise<void>((resolve) => fake.server.close(() => resolve())) }
  })
}
