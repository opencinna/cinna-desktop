import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * The HTTP response never produces another byte after its initial update (or
 * any response at all in nonstreaming mode). tasks/cancel acknowledges without
 * closing that response. Only the app aborting its reader can release the turn.
 */
const AGENT = 'Silent Stream Reporter'
const PROMPT = 'Begin the report and wait for my next instruction.'
const PARTIAL = 'The report has started: cedar-9146.'
const TASK_ID = 'silent-report-task'
const CONTEXT_ID = 'silent-report-context'

interface RpcRequest {
  id: string | number
  method: string
  params?: { id?: string; message?: { parts?: { kind: string; text?: string }[] } }
}

async function serve(streaming: boolean): Promise<{
  host: string
  server: Server
  requests: RpcRequest[]
  closed: () => number
}> {
  let host = ''
  let closed = 0
  const requests: RpcRequest[] = []
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        name: AGENT, description: AGENT, url: `${host}/a2a`,
        protocolVersion: '0.3.0', version: '1.0.0', capabilities: { streaming },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: []
      }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/a2a') {
      res.writeHead(404)
      res.end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const rpc = JSON.parse(raw) as RpcRequest
      requests.push(rpc)
      if (rpc.method === 'tasks/cancel') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
          kind: 'task', id: TASK_ID, contextId: CONTEXT_ID, status: { state: 'canceled' }
        } }))
        // Deliberately leave the original response silent and open. A cancel
        // acknowledgement alone cannot release the caller's stream iterator.
        return
      }
      const text = (rpc.params?.message?.parts ?? [])
        .filter((part) => part.kind === 'text').map((part) => part.text ?? '').join('')
      if (rpc.method !== (streaming ? 'message/stream' : 'message/send') || text !== PROMPT) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unexpected A2A method or prompt' }))
        return
      }
      // Response close, not request close: the latter fires after reading its
      // body and says nothing about aborting the held response.
      res.on('close', () => { if (!res.writableEnded) closed += 1 })
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
          kind: 'status-update', taskId: TASK_ID, contextId: CONTEXT_ID, final: false,
          status: { state: 'working', message: {
            kind: 'message', messageId: 'partial-reply', role: 'agent',
            parts: [{ kind: 'text', text: PARTIAL }]
          } }
        } })}\n\n`)
      }
      // No heartbeat, completion, or timer: nonstreaming also holds headers.
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { host, server, requests, closed: () => closed }
}

/**
 * The composer by role, not placeholder: for ~260ms after the first send the
 * chat curtain (`ChatTransition`) keeps an inert, aria-hidden clone of the
 * new-chat composer, placeholder included, and Stop lands inside that window.
 */
function composer(cinna: CinnaApp) {
  return cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
}

async function arrange(cinna: CinnaApp, host: string): Promise<void> {
  await cinna.skipOnboarding()
  const agent = await cinna.page.evaluate(({ host, name }) => window.api.agents.upsert({
    name, protocol: 'a2a', cardUrl: `${host}/.well-known/agent-card.json`, endpointUrl: `${host}/a2a`
  }), { host, name: AGENT })
  expect(agent.success).toBe(true)
  expect(agent.id).toBeTruthy()
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await composer(cinna).fill('@')
  await cinna.page.getByRole('listbox', { name: 'Agents and MCP servers' })
    .getByRole('option').filter({ hasText: AGENT }).click()
  await composer(cinna).fill(PROMPT)
  await composer(cinna).press('Enter')
}

async function messages(cinna: CinnaApp): Promise<{ role: string; content: string }[]> {
  return cinna.page.evaluate(async () => {
    const [chat] = await window.api.chat.list()
    const detail = chat && await window.api.chat.get(chat.id)
    return (detail?.messages ?? []).map((message) => ({ role: message.role, content: message.content }))
  })
}

for (const streaming of [true, false]) {
  test(streaming
    ? 'Stop interrupts a silent A2A stream, preserves its partial reply and cancels the known task once'
    : 'Stop interrupts a nonstreaming A2A response that has not returned headers', async ({ cinna }) => {
    test.setTimeout(90_000)
    const fake = await serve(streaming)
    try {
      await arrange(cinna, fake.host)
      await expect.poll(() => fake.requests.length).toBe(1)
      expect(fake.closed()).toBe(0)
      if (streaming) await expect(cinna.page.getByText(PARTIAL, { exact: true })).toBeVisible()
      const stop = cinna.page.getByRole('button', { name: 'Stop', exact: true })
      await expect(stop).toBeEnabled()
      await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)
      await stop.click()
      // A short web-first deadline, not a test sleep or a server release. With
      // the old code, an abort checked only on the next frame never gets here.
      await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 5_000 })
      await expect(stop).toHaveCount(0)
      await expect.poll(fake.closed, { timeout: 5_000 }).toBe(1)
      const expected = [{ role: 'user', content: PROMPT }]
      if (streaming) expected.push({ role: 'assistant', content: PARTIAL })
      else expected.push({ role: 'agent_transition', content: 'Stopped waiting locally. The remote agent’s stop was not confirmed; check its task before starting more work.' })
      await expect.poll(() => messages(cinna)).toEqual(expected)
      if (streaming) {
        await expect(cinna.page.getByText(PARTIAL, { exact: true })).toBeVisible()
        await expect.poll(() => fake.requests.filter((request) => request.method === 'tasks/cancel'))
          .toEqual([expect.objectContaining({ params: { id: TASK_ID } })])
      } else {
        // The server never identified a task; no fabricated cancel is valid.
        expect(fake.requests.filter((request) => request.method === 'tasks/cancel')).toEqual([])
      }
      expect(fake.requests.filter((request) => request.method.startsWith('message/'))).toHaveLength(1)
      await composer(cinna).fill('Continue when I am ready.')
      await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
      await composer(cinna).fill('')
      expect(await cinna.page.evaluate(() => window.api.providers.list())).toEqual([])
      expect(await cinna.page.evaluate(() => window.api.chatModes.list())).toEqual([])
    } finally {
      fake.server.closeAllConnections()
      await new Promise<void>((resolve) => fake.server.close(() => resolve()))
    }
  })
}
