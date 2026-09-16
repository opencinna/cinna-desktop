/** E2E-only ACP process; a loopback controller holds and releases each real prompt. */
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream } from '@agentclientprotocol/sdk'

const host = process.env.SCRIPT_ACP_CONTROLLER
if (!host || !host.startsWith('http://127.0.0.1:')) throw new Error('A loopback controller is required')
const pending = new Map()

/** POST to the controller and read its JSON answer; the controller may hold it. */
async function ask(path, body, signal) {
  const response = await fetch(`${host}${path}`, { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`Controller refused ${path}: ${response.status}`)
  return response.json()
}

/** Send the controller's `updates` (bare `session/update` payloads) on this session, in order. */
async function send(client, sessionId, updates) {
  for (const update of updates ?? []) await client.notify('session/update', { sessionId, update })
}

const app = agent({ name: 'script-e2e-acp' })
  .onRequest('initialize', async (ctx) => {
    // The client's advertised capabilities are the witness for what the launcher sends.
    await ask('/initialize', ctx.params)
    return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }
  })
  .onRequest('session/new', () => ({ sessionId: `script-${randomUUID()}` }))
  .onRequest('session/load', () => ({}))
  .onRequest('session/set_mode', () => ({}))
  .onRequest('session/set_config_option', () => ({ configOptions: [] }))
  .onRequest('session/prompt', async (ctx) => {
    const controller = new AbortController()
    const { sessionId } = ctx.params
    pending.set(sessionId, controller)
    try {
      // `{ text }` alone is a plain reply. `updates` go out before it, and
      // `after: true` asks the controller, once this prompt has returned, for
      // the traffic the agent then sends on its own (a background task ending,
      // a turn nobody prompted) — held until the test releases it.
      const { text, updates, after } = await ask('/prompt', { cwd: process.cwd(), pid: process.pid, ...ctx.params }, controller.signal)
      await send(ctx.client, sessionId, updates)
      if (text) {
        await ctx.client.notify('session/update', { sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
      }
      if (after) {
        setTimeout(() => {
          ask('/after', { sessionId })
            .then((reply) => send(ctx.client, sessionId, reply.updates))
            .catch((error) => process.stderr.write(`script-e2e-acp: after failed: ${error}\n`))
        }, 20)
      }
      return { stopReason: 'end_turn' }
    } catch (error) {
      if (!controller.signal.aborted) throw error
      return { stopReason: 'cancelled' }
    } finally { pending.delete(sessionId) }
  })
  // The AIR extension's stop: the controller says what the agent sends first and what it answers.
  .onRequest('_session/async_task/stop', (params) => params, async (ctx) => {
    const { updates, result } = await ask('/stop', ctx.params)
    await send(ctx.client, ctx.params.sessionId, updates)
    return result
  })
  .onNotification('session/cancel', (ctx) => pending.get(ctx.params.sessionId)?.abort())
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
connection.closed.then(() => process.exit(0)).catch(() => process.exit(1))
