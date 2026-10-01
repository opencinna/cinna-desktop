import { afterAll, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolProvider } from '../llm/toolProvider'
import type { AgentRow } from '../db/agents'
import type { AcpLaunchPlan } from '../agents/drivers/acp/acpLaunchers'
import type { ConductorMcpDescriptor } from './conductorMcpServer'

/**
 * A chat releasing its conductor's sessions while a turn is bound to the
 * conductor's `cinna` endpoint — the incident in which attaching an agent
 * mid-turn disposed the endpoint under the running engine, which reconnected
 * to ENDPOINT_NOT_FOUND and lost every Cinna tool.
 *
 * Real loopback server, real SDK HTTP clients, real forgetter registry; only
 * the chat's rows are faked.
 */

const state = vi.hoisted(() => ({
  chat: { agentId: 'root', router: 'direct' } as { agentId: string | null; router: string },
  tools: [] as string[]
}))
vi.mock('../auth/chatScope', () => ({ visibleChat: () => state.chat }))
vi.mock('../db/chatMcp', () => ({ chatMcpRepo: { listProviderIds: () => [] } }))
vi.mock('../db/chatOnDemandMcp', () => ({ chatOnDemandMcpRepo: { listProviderIds: () => [] } }))
vi.mock('../db/messages', () => ({ messageRepo: { saveToolCall: vi.fn() } }))
vi.mock('../db/conductorSessions', () => ({ conductorSessionRepo: { get: vi.fn(), save: vi.fn() } }))
vi.mock('../tasks/toolCallBudget', () => ({ taskToolCallBudgetForChat: () => null }))
vi.mock('../mcp/manager', () => ({ mcpManager: {} }))
vi.mock('../mcp/toolChanges', () => ({ onMcpToolsChanged: vi.fn() }))
vi.mock('./chatConductorService', () => ({ canConduct: () => true, isChatConductor: () => false, conductorContext: vi.fn() }))
vi.mock('./a2aAsMcpProvider', () => ({
  buildAgentToolProviders: (): ToolProvider[] => state.tools.map((name) => ({
    providerType: 'agent', displayName: name, agentId: name,
    getTools: () => [{ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, mcpProviderId: name, providerType: 'agent' }],
    callTool: async () => ({ content: `${name} result` })
  }))
}))

const { conductorBridge } = await import('./conductorBridge')
const { forgetChatSessions } = await import('./chatSessionRelease')

const clients: Client[] = []
afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await conductorBridge.shutdown()
})

let counter = 0
const root = { id: 'root', driver: 'acp' } as AgentRow

async function prepare(chatId: string, nested = false) {
  const plan = { spec: { remote: false }, session: { mcpServers: [] } } as unknown as AcpLaunchPlan
  const lease = await conductorBridge.prepare('owner', root,
    { chatId, wireContent: 'Task', signal: new AbortController().signal, runScope: { profileUserId: 'user', settingsUserId: 'settings' }, ...(nested ? { nested: true } : {}) } as never,
    plan, vi.fn(), () => true)
  return { lease, plan, descriptor: plan.session.mcpServers.find((mcp) => mcp.name === 'cinna') as ConductorMcpDescriptor | undefined }
}

async function connect(descriptor: ConductorMcpDescriptor) {
  const client = new Client({ name: 'engine', version: '1' })
  clients.push(client)
  let changed!: () => void
  const listChanged = new Promise<void>((resolve) => { changed = resolve })
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => changed())
  // The SDK opens the standalone GET stream fire-and-forget after
  // `initialized`, and the server drops a notification sent before that
  // stream is registered (no event store). Its response headers mean it is.
  let opened!: () => void
  const sseOpen = new Promise<void>((resolve) => { opened = resolve })
  const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
    fetch: async (url, init) => {
      const response = await fetch(url, init)
      if (init?.method === 'GET' && response.ok) opened()
      return response
    },
    requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 }
  })
  await client.connect(transport)
  return { client, listChanged, sseOpen }
}

function status(descriptor: ConductorMcpDescriptor): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(descriptor.url, { method: 'POST', headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode!))
    })
    request.on('error', reject)
    request.end('{}')
  })
}

const names = async (client: Client): Promise<string[]> => (await client.listTools()).tools.map(({ name }) => name)

/** Settle within `ms`, or fail saying what never happened. */
function within<T>(promise: Promise<T>, what: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms) })
  ]).finally(() => clearTimeout(timer))
}

/** Ask tools/list until it names `tool`; fail with the last answer at the deadline. */
async function untilListed(client: Client, tool: string, ms = 2000): Promise<string[]> {
  const deadline = Date.now() + ms
  let last: string[] = []
  while (Date.now() < deadline) {
    last = await names(client)
    if (last.includes(tool)) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`tools/list never named ${tool} within ${ms}ms; last answer: ${JSON.stringify(last)}`)
}

describe('releasing a conductor whose turn is bound', () => {
  it('keeps the endpoint answering tools/list until the lease closes, then 404s', async () => {
    state.chat = { agentId: 'root', router: 'coordinator' }
    state.tools = ['writer']
    const chatId = `retire-${++counter}`
    const { lease, descriptor } = await prepare(chatId)
    const engine = await connect(descriptor!)
    expect(await names(engine.client)).toEqual(['writer'])

    forgetChatSessions(chatId, 'root')

    expect(await names(engine.client)).toEqual(['writer'])
    lease!.close()
    // dispose() runs on close; give its socket teardown a tick.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await status(descriptor!)).toBe(404)
    state.tools = []
  })

  it('disposes at once when no turn is bound', async () => {
    state.chat = { agentId: 'root', router: 'coordinator' }
    const chatId = `retire-${++counter}`
    const { lease, descriptor } = await prepare(chatId)
    lease!.close()
    forgetChatSessions(chatId)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await status(descriptor!)).toBe(404)
  })

  it('gives the next turn a fresh endpoint, which the retiring lease’s close leaves alone', async () => {
    state.chat = { agentId: 'root', router: 'coordinator' }
    const chatId = `retire-${++counter}`
    const first = await prepare(chatId)
    forgetChatSessions(chatId, 'root')
    const second = await prepare(chatId)
    expect(second.descriptor!.url).not.toBe(first.descriptor!.url)
    first.lease!.close()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await status(first.descriptor!)).toBe(404)
    const engine = await connect(second.descriptor!)
    expect(await names(engine.client)).toEqual([])
    second.lease!.close()
  })

  it('still reaches the live connection when an agent is attached and coordination turned on mid-turn', async () => {
    // The incident's shape: a direct chat's root mid-turn, then an agent
    // attached (the old code released every agent here) and coordination on.
    state.chat = { agentId: 'root', router: 'direct' }
    state.tools = []
    const chatId = `retire-${++counter}`
    const { lease, descriptor } = await prepare(chatId)
    const engine = await connect(descriptor!)
    expect(await names(engine.client)).toEqual([])
    await within(engine.sseOpen, 'the engine never opened its notification stream')

    forgetChatSessions(chatId)
    state.chat = { agentId: 'root', router: 'coordinator' }
    state.tools = ['sh_odoo_coding_agent']
    await conductorBridge.refresh(chatId)

    await within(engine.listChanged, 'refresh never reached the live connection with tools/list_changed')
    expect(await untilListed(engine.client, 'sh_odoo_coding_agent')).toEqual(['sh_odoo_coding_agent'])
    lease!.close()
    state.tools = []
  })

  it('leaves a former conductor reused for a nested call with no cinna endpoint, and its old one dead', async () => {
    state.chat = { agentId: 'root', router: 'coordinator' }
    const chatId = `retire-${++counter}`
    const conducting = await prepare(chatId)
    conducting.lease!.close()
    // `setCoordinator` releasing the old conductor's sessions.
    forgetChatSessions(chatId, 'root')
    state.chat = { agentId: 'other', router: 'coordinator' }

    const nested = await prepare(chatId, true)

    expect(nested.lease).toBeUndefined()
    expect(nested.plan.session.mcpServers).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await status(conducting.descriptor!)).toBe(404)
  })
})
