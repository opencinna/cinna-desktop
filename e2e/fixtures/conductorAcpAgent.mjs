/** Scripted engine, real ACP and authenticated Cinna MCP transport. No app internals. */
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const host = process.env.CONDUCTOR_ACP_CONTROLLER
if (!host?.startsWith('http://127.0.0.1:')) throw new Error('A loopback controller is required')
const sessions = new Map()
const pending = new Map()
const app = agent({ name: 'conductor-e2e-acp' })
  .onRequest('initialize', () => ({ protocolVersion: 1,
    agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [] }))
  .onRequest('session/new', (ctx) => {
    const sessionId = `conductor-${randomUUID()}`
    sessions.set(sessionId, { servers: ctx.params.mcpServers, history: [] })
    return { sessionId }
  })
  .onRequest('session/load', (ctx) => {
    const previous = sessions.get(ctx.params.sessionId)
    sessions.set(ctx.params.sessionId, { servers: ctx.params.mcpServers, history: previous?.history ?? [] })
    return {}
  })
  .onRequest('session/set_mode', () => ({}))
  .onRequest('session/set_config_option', () => ({ configOptions: [] }))
  .onRequest('session/prompt', async (ctx) => {
    const { sessionId, prompt } = ctx.params
    const session = sessions.get(sessionId)
    const descriptor = session.servers.find((server) => server.name === 'cinna' && server.type === 'http')
    if (!descriptor || !descriptor.url.startsWith('http://127.0.0.1:')) throw new Error('Cinna MCP was not injected')
    const controller = new AbortController()
    pending.set(sessionId, controller)
    const client = new Client({ name: 'conductor-e2e', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url), {
        requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) }
      }))
      const { tools } = await client.listTools()
      session.history.push({ prompt })
      while (!controller.signal.aborted) {
        const response = await fetch(`${host}/runtime/step`, { method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, history: session.history, tools: tools.map((tool) => tool.name) }) })
        if (!response.ok) throw new Error(`Controller refused the runtime step: ${response.status}`)
        const call = await response.json()
        const result = await client.callTool({ name: call.name, arguments: call.args,
          _meta: { 'claudecode/toolUseId': call.id } }, undefined, { signal: controller.signal })
        session.history.push({ call, result })
        // Ending controls stop the ACP turn from main. Do not manufacture a
        // second decision while that session/cancel notification is in flight.
        if (['ask_user', 'handoff', 'finish'].includes(call.name) && !controller.signal.aborted) {
          await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }))
        }
      }
      return { stopReason: 'cancelled' }
    } catch (error) {
      if (!controller.signal.aborted) throw error
      return { stopReason: 'cancelled' }
    } finally {
      pending.delete(sessionId)
      await client.close()
    }
  })
  .onNotification('session/cancel', (ctx) => pending.get(ctx.params.sessionId)?.abort())
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
connection.closed.then(() => process.exit(0)).catch(() => process.exit(1))
