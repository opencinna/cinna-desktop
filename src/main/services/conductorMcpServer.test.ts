import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { ConductorMcpServer, type ConductorMcpSession, type ConductorMcpSessionOptions } from './conductorMcpServer'
import type { ToolCallOptions, ToolProvider } from '../llm/toolProvider'

const servers: ConductorMcpServer[] = []
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(servers.splice(0).map((server) => server.dispose()))
})

function provider(name: string, agentId?: string): ToolProvider {
  return {
    providerType: agentId ? 'agent' : 'mcp', displayName: name, agentId,
    getTools: () => [{ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, mcpProviderId: name, providerType: agentId ? 'agent' : 'mcp' }],
    callTool: vi.fn(async () => ({ content: `${name} result` }))
  }
}

async function subject(options: ConductorMcpSessionOptions = { getProviders: () => [] }) {
  const server = new ConductorMcpServer()
  servers.push(server)
  return { server, session: await server.ensureSession('chat:agent', options) }
}

async function connect(session: ConductorMcpSession, beforeSubscribe?: Promise<void>) {
  const client = new Client({ name: 'conductor-test', version: '1' })
  clients.push(client)
  let subscribed!: (response: Response) => void
  const subscription = new Promise<Response>((resolve) => { subscribed = resolve })
  const transport = new StreamableHTTPClientTransport(new URL(session.descriptor.url), {
    fetch: async (input, init) => {
      if (init?.method === 'GET') await beforeSubscribe
      const response = await fetch(input, init)
      if (init?.method === 'GET') subscribed(response)
      return response
    },
    requestInit: { headers: Object.fromEntries(session.descriptor.headers.map(({ name, value }) => [name, value])) },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 }
  })
  await client.connect(transport)
  return { client, transport, subscription }
}

function status(session: ConductorMcpSession, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(session.descriptor.url, { method: 'POST', headers }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode!))
    })
    request.on('error', reject)
    request.end('{}')
  })
}

describe('conductor MCP loopback server', () => {
  it('keeps the endpoint and bearer stable across callback updates and reconnects, with one loopback listener', async () => {
    const { server, session } = await subject()
    const descriptor = structuredClone(session.descriptor)
    expect(new URL(descriptor.url).hostname).toBe('127.0.0.1')
    expect(descriptor.headers[0].value).toMatch(/^Bearer [\w-]{43}$/)
    const first = await connect(session)
    expect((await first.client.listTools()).tools).toEqual([])
    const updated = await server.ensureSession('chat:agent', { getProviders: () => [provider('specialist')] })
    expect(updated).toBe(session)
    expect(updated.descriptor).toEqual(descriptor)
    expect((await first.client.listTools()).tools.map(({ name }) => name)).toEqual(['specialist'])
    await first.client.close()
    const second = await connect(updated)
    expect((await second.client.listTools()).tools.map(({ name }) => name)).toEqual(['specialist'])
    const other = await server.ensureSession('other-chat', { getProviders: () => [] })
    expect(new URL(other.descriptor.url).origin).toBe(new URL(descriptor.url).origin)
    expect(other.descriptor.url).not.toBe(descriptor.url)
    expect(other.descriptor.headers).not.toEqual(descriptor.headers)
  })

  it('rejects absent/wrong/cross-session credentials, hostile Host and Origin on the HTTP boundary', async () => {
    const { server, session } = await subject()
    const authorization = session.descriptor.headers[0].value
    expect(await status(session)).toBe(401)
    expect(await status(session, { Authorization: 'Bearer invalid' })).toBe(401)
    expect(await status(session, { Authorization: authorization, Host: 'attacker.example' })).toBe(403)
    expect(await status(session, { Authorization: authorization, Origin: 'https://attacker.example' })).toBe(403)
    expect(await status(session, { Authorization: authorization, Origin: 'null' })).toBe(403)
    const other = await server.ensureSession('other', { getProviders: () => [] })
    expect(await status(other, { Authorization: authorization })).toBe(401)
    const { client } = await connect(session)
    expect((await client.listTools()).tools).toEqual([])
  })

  it('refreshes tools on a live connection, excludes the conductor and preserves collision ownership', async () => {
    const first = provider('same', 'first')
    const duplicate = provider('same', 'second')
    let providers = [provider('self', 'root')]
    const { session } = await subject({ conductorAgentId: 'root', getProviders: () => providers })
    // connect() starts the standalone notification GET in the background.
    // A tools/list POST can finish first: hold that GET to exercise the race,
    // then establish the live subscription before changing the tool list.
    let allowSubscribe!: () => void
    const beforeSubscribe = new Promise<void>((resolve) => { allowSubscribe = resolve })
    const { client, subscription } = await connect(session, beforeSubscribe)
    expect((await client.listTools()).tools).toEqual([])
    const notified = new Promise<void>((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()))
    allowSubscribe()
    expect((await subscription).status).toBe(200)
    providers = [provider('self', 'root'), first, duplicate]
    await session.refreshTools()
    await notified
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(['same'])
    expect(await client.callTool({ name: 'same', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'same result' }] })
    expect(first.callTool).toHaveBeenCalledOnce()
    expect(duplicate.callTool).not.toHaveBeenCalled()
    expect(await client.callTool({ name: 'self' })).toMatchObject({ isError: true })
  })

  it('offers exactly the names the last tools/list served, and nothing once disposed', async () => {
    let providers = [provider('self', 'root'), provider('probe')]
    const { session } = await subject({ conductorAgentId: 'root', getProviders: () => providers })
    // Nothing is offered before the engine has listed.
    expect(session.offers('probe')).toBe(false)
    const { client } = await connect(session)
    await client.listTools()
    expect(session.offers('probe')).toBe(true)
    // The conductor's own tool is never served, so never offered.
    expect(session.offers('self')).toBe(false)
    expect(session.offers('x_y')).toBe(false)
    providers = [provider('x_y')]
    await client.listTools()
    expect(session.offers('probe')).toBe(false)
    expect(session.offers('x_y')).toBe(true)
    await session.dispose()
    expect(session.offers('x_y')).toBe(false)
  })

  it('creates a between-turn run before resolving providers and forwards Claude correlation and rich MCP content', async () => {
    const tool = provider('specialist')
    let currentProviders: ToolProvider[] = []
    const beforeCall = vi.fn(async () => { currentProviders = [tool] })
    const executeTool = vi.fn(async () => ({ content: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }] }))
    const { session } = await subject({ getProviders: () => currentProviders, beforeCall, executeTool })
    const { client } = await connect(session)
    const result = await client.callTool({ name: 'specialist', arguments: { prompt: 'hello' }, _meta: { 'claudecode/toolUseId': 'claude-123' } })
    expect(result).toMatchObject({ content: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }] })
    expect(beforeCall).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'claude-123', name: 'specialist' }))
    expect(executeTool).toHaveBeenCalledWith(tool, 'specialist', { prompt: 'hello' }, expect.objectContaining({ queueWhenBusy: true, toolCallId: 'claude-123', signal: expect.any(AbortSignal) }), expect.objectContaining({ toolCallId: 'claude-123' }))
    expect(tool.callTool).not.toHaveBeenCalled()
  })

  it('runs independent tools concurrently and propagates wire cancellation only to its own call', async () => {
    const signals: AbortSignal[] = []
    const finishes: (() => void)[] = []
    const tools = [provider('alpha'), provider('beta')]
    for (const tool of tools) {
      vi.mocked(tool.callTool).mockImplementation(async (_name, _input, options) => {
        signals.push(options!.signal!)
        return new Promise((resolve) => {
          finishes.push(() => resolve({ content: 'done' }))
          options!.signal!.addEventListener('abort', () => resolve({ content: 'cancelled', isError: true }), { once: true })
        })
      })
    }
    const { session } = await subject({ getProviders: () => tools })
    const { client } = await connect(session)
    const cancellation = new AbortController()
    const first = client.callTool({ name: 'alpha' }, undefined, { signal: cancellation.signal }).catch((error) => error)
    const second = client.callTool({ name: 'beta' })
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    cancellation.abort(new Error('Stop alpha'))
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true))
    expect(signals[1].aborted).toBe(false)
    finishes[1]()
    expect(await second).toMatchObject({ content: [{ type: 'text', text: 'done' }] })
    expect(await first).toBeInstanceOf(Error)
  })

  it('aborts all active calls on Stop while allowing a later turn, and revokes disposed session endpoints', async () => {
    const tool = provider('specialist')
    let options: ToolCallOptions | undefined
    vi.mocked(tool.callTool).mockImplementation(async (_name, _input, received) => {
      options = received
      return new Promise((resolve) => received!.signal!.addEventListener('abort', () => resolve({ content: 'stopped', isError: true }), { once: true }))
    })
    const { session } = await subject({ getProviders: () => [tool] })
    const { client } = await connect(session)
    const pending = client.callTool({ name: 'specialist' })
    await vi.waitFor(() => expect(options).toBeDefined())
    session.abortCalls()
    expect(await pending).toMatchObject({ isError: true })
    vi.mocked(tool.callTool).mockResolvedValue({ content: 'new turn' })
    expect(await client.callTool({ name: 'specialist' })).toMatchObject({ content: [{ text: 'new turn' }] })
    await session.dispose()
    expect(await status(session, { Authorization: session.descriptor.headers[0].value })).toBe(404)
    expect(() => session.updateOptions({ getProviders: () => [] })).toThrow('closed')
  })

  it('cancels providers when a client terminates its MCP session, and isolates other chats', async () => {
    const tool = provider('specialist')
    let signal: AbortSignal | undefined
    vi.mocked(tool.callTool).mockImplementation(async (_name, _input, options) => {
      signal = options!.signal
      return new Promise((resolve) => signal!.addEventListener('abort', () => resolve({ content: 'stopped' }), { once: true }))
    })
    const { server, session } = await subject({ getProviders: () => [tool] })
    const { client, transport } = await connect(session)
    const pending = client.callTool({ name: 'specialist' }).catch(() => {})
    await vi.waitFor(() => expect(signal).toBeDefined())
    await transport.terminateSession()
    await vi.waitFor(() => expect(signal!.aborted).toBe(true))
    await client.close()
    await pending
    const other = await server.ensureSession('other', { getProviders: () => [provider('other')] })
    const peer = await connect(other)
    expect(await peer.client.callTool({ name: 'other' })).toMatchObject({ content: [{ text: 'other result' }] })
  })

  it('disposes the listening server and rejects further sessions', async () => {
    const { server, session } = await subject()
    await server.dispose()
    await expect(status(session)).rejects.toThrow()
    await expect(server.ensureSession('new', { getProviders: () => [] })).rejects.toThrow('closed')
    await server.dispose()
  })
})
