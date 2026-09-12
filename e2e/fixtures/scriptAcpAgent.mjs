/** E2E-only ACP process; a loopback controller holds and releases each real prompt. */
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream } from '@agentclientprotocol/sdk'

const host = process.env.SCRIPT_ACP_CONTROLLER
if (!host || !host.startsWith('http://127.0.0.1:')) throw new Error('A loopback controller is required')
const pending = new Map()
const app = agent({ name: 'script-e2e-acp' })
  .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }))
  .onRequest('session/new', () => ({ sessionId: `script-${randomUUID()}` }))
  .onRequest('session/load', () => ({}))
  .onRequest('session/set_mode', () => ({}))
  .onRequest('session/set_config_option', () => ({ configOptions: [] }))
  .onRequest('session/prompt', async (ctx) => {
    const controller = new AbortController()
    const { sessionId } = ctx.params
    pending.set(sessionId, controller)
    try {
      const response = await fetch(`${host}/prompt`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: process.cwd(), pid: process.pid, ...ctx.params }) })
      if (!response.ok) throw new Error(`Controller refused prompt: ${response.status}`)
      const { text } = await response.json()
      await ctx.client.notify('session/update', { sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
      return { stopReason: 'end_turn' }
    } catch (error) {
      if (!controller.signal.aborted) throw error
      return { stopReason: 'cancelled' }
    } finally { pending.delete(sessionId) }
  })
  .onNotification('session/cancel', (ctx) => pending.get(ctx.params.sessionId)?.abort())
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
connection.closed.then(() => process.exit(0)).catch(() => process.exit(1))
