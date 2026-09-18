import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createLogger } from '../logger/logger'
import type { ToolCallOptions, ToolExecutionResult, ToolProvider } from '../llm/toolProvider'

const logger = createLogger('conductor-mcp')

/** Main-only ACP descriptor. Its bearer credential must never cross IPC. */
export interface ConductorMcpDescriptor {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

export interface ConductorMcpCallContext {
  requestId: string | number
  toolCallId: string
  name: string
  meta?: Record<string, unknown>
  signal: AbortSignal
}

export interface ConductorMcpSessionOptions {
  conductorAgentId?: string
  getProviders(): ToolProvider[] | Promise<ToolProvider[]>
  /** Establish the current/follow-up run before resolving turn-owned providers. */
  beforeCall?(context: ConductorMcpCallContext): void | Promise<void>
  /** The integration owns transcript persistence, child events and runner controls. */
  executeTool?(
    provider: ToolProvider,
    name: string,
    input: Record<string, unknown>,
    options: ToolCallOptions,
    context: ConductorMcpCallContext
  ): Promise<ToolExecutionResult>
}

export interface ConductorMcpSession {
  readonly descriptor: ConductorMcpDescriptor
  /** Updates callbacks without changing the ACP creation parameters. */
  updateOptions(options: ConductorMcpSessionOptions): void
  refreshTools(): Promise<void>
  abortCalls(reason?: string): void
  dispose(): Promise<void>
}

interface Connection {
  server: Server
  transport: StreamableHTTPServerTransport
}

interface SessionState {
  path: string
  authorization: Buffer
  options: ConductorMcpSessionOptions
  connections: Map<string, Connection>
  calls: Set<AbortController>
  disposed: boolean
  handle: ConductorMcpSession
}

function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
  response.end(message)
}

function toolResult(result: ToolExecutionResult): CallToolResult {
  // Preserve real MCP content blocks, including images/resources. Agent results
  // remain compact text; parts and trusted runner controls stay in main.
  const parsed = CallToolResultSchema.safeParse({ content: result.content, isError: result.isError })
  if (parsed.success) return parsed.data
  return {
    content: [{ type: 'text', text: typeof result.content === 'string'
      ? result.content : JSON.stringify(result.content) ?? '' }],
    isError: result.isError
  }
}

/**
 * One loopback listener, with isolated bearer-authenticated endpoints per ACP
 * session. A session can reconnect/load using the same descriptor; its MCP
 * transport connections are independent from that durable in-process identity.
 */
export class ConductorMcpServer {
  private listener?: HttpServer
  private starting?: Promise<void>
  private origin = ''
  private sessions = new Map<string, SessionState>()
  private paths = new Map<string, SessionState>()
  private disposed = false

  async ensureSession(key: string, options: ConductorMcpSessionOptions): Promise<ConductorMcpSession> {
    if (this.disposed) throw new Error('Conductor MCP server is closed')
    await this.start()
    if (this.disposed) throw new Error('Conductor MCP server is closed')
    const existing = this.sessions.get(key)
    if (existing) {
      existing.handle.updateOptions(options)
      return existing.handle
    }
    const path = `/mcp/${randomUUID()}`
    const authorization = `Bearer ${randomBytes(32).toString('base64url')}`
    const state: SessionState = {
      path, authorization: Buffer.from(authorization), options,
      connections: new Map(), calls: new Set(), disposed: false,
      handle: {
        descriptor: { type: 'http', name: 'cinna', url: `${this.origin}${path}`, headers: [{ name: 'Authorization', value: authorization }] },
        updateOptions: (next) => {
          if (state.disposed) throw new Error('Conductor MCP session is closed')
          state.options = next
        },
        refreshTools: async () => {
          if (state.disposed) return
          // A stale/disconnected transport must not prevent the other client
          // connections from seeing new tools. Fresh connections list on init.
          await Promise.allSettled([...state.connections.values()].map(({ server }) => server.sendToolListChanged()))
        },
        abortCalls: (reason = 'Conductor stopped') => {
          for (const controller of state.calls) controller.abort(new Error(reason))
        },
        dispose: async () => {
          if (state.disposed) return
          state.disposed = true
          this.sessions.delete(key)
          this.paths.delete(path)
          state.handle.abortCalls('Conductor session closed')
          const connections = [...state.connections.values()]
          state.connections.clear()
          await Promise.allSettled(connections.map(({ server }) => server.close()))
          state.authorization.fill(0)
        }
      }
    }
    this.sessions.set(key, state)
    this.paths.set(path, state)
    return state.handle
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.starting?.catch(() => {})
    await Promise.all([...this.sessions.values()].map(({ handle }) => handle.dispose()))
    if (this.listener) {
      const listener = this.listener
      this.listener = undefined
      await new Promise<void>((resolve) => {
        listener.close(() => resolve())
        listener.closeAllConnections()
      })
    }
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      const listener = createServer((request, response) => {
        void this.handleRequest(request, response).catch(() => {
          if (!response.headersSent) reply(response, 500, 'Conductor MCP request failed')
          else response.end()
        })
      })
      this.listener = listener
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Conductor MCP listener has no loopback address'))
          return
        }
        this.origin = `http://127.0.0.1:${address.port}`
        listener.unref()
        // A later socket-level error must not surface as an uncaught exception.
        listener.on('error', (error) => logger.warn('Conductor MCP listener error', { error: String(error) }))
        resolve()
      })
    })
    // One failed listen must not break every conductor until restart.
    this.starting.catch(() => { this.starting = undefined; this.listener = undefined })
    return this.starting
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Check before parsing the URL/body, including every SSE/cancel/delete call.
    // Browsers have no reason to access this native-process-only endpoint.
    if (request.headers.host !== this.origin.slice('http://'.length) ||
      (request.headers.origin !== undefined && request.headers.origin !== this.origin)) {
      reply(response, 403, 'Forbidden origin or host')
      return
    }
    const state = this.paths.get(request.url ?? '')
    if (!state || state.disposed) {
      reply(response, 404, 'Unknown conductor session')
      return
    }
    const supplied = Buffer.from(request.headers.authorization ?? '')
    if (supplied.length !== state.authorization.length || !timingSafeEqual(supplied, state.authorization)) {
      reply(response, 401, 'Unauthorized')
      return
    }
    const sessionId = request.headers['mcp-session-id']
    if (typeof sessionId === 'string') {
      const connection = state.connections.get(sessionId)
      if (!connection) {
        reply(response, 404, 'Unknown MCP connection')
        return
      }
      await connection.transport.handleRequest(request, response)
      return
    }
    if (sessionId !== undefined || request.method !== 'POST') {
      reply(response, 400, 'An MCP session is required')
      return
    }
    const connection = await this.createConnection(state)
    try {
      if (state.disposed) {
        reply(response, 410, 'Conductor session closed')
        return
      }
      await connection.transport.handleRequest(request, response)
    } finally {
      // The SDK validates initialize before assigning the connection's ID.
      if (state.disposed || !connection.transport.sessionId) await connection.server.close()
    }
  }

  private async createConnection(state: SessionState): Promise<Connection> {
    const server = new Server({ name: 'cinna-conductor', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (state.disposed) throw new Error('Conductor session closed')
        state.connections.set(id, { server, transport })
      }
    })
    server.onclose = () => {
      if (transport.sessionId) state.connections.delete(transport.sessionId)
    }
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const providers = await this.providers(state)
      const tools = [...providers].map(([name, provider]) => {
        const tool = provider.getTools().find((entry) => entry.name === name)!
        return { name, description: tool.description, inputSchema: { ...tool.inputSchema, type: 'object' as const } }
      })
      return { tools }
    })
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const controller = new AbortController()
      const abort = (): void => controller.abort(extra.signal.reason)
      extra.signal.addEventListener('abort', abort, { once: true })
      if (extra.signal.aborted) abort()
      state.calls.add(controller)
      const meta = request.params._meta
      const claudeId = meta?.['claudecode/toolUseId']
      const context: ConductorMcpCallContext = {
        requestId: extra.requestId,
        name: request.params.name,
        toolCallId: typeof claudeId === 'string' && claudeId.length > 0 ? claudeId : `cinna-${randomUUID()}`,
        meta,
        signal: controller.signal
      }
      try {
        controller.signal.throwIfAborted()
        if (state.disposed) throw new Error('Conductor session closed')
        await state.options.beforeCall?.(context)
        controller.signal.throwIfAborted()
        const provider = (await this.providers(state)).get(request.params.name)
        if (!provider) throw new Error(`Unknown tool: ${request.params.name}`)
        controller.signal.throwIfAborted()
        const options: ToolCallOptions = { signal: controller.signal, toolCallId: context.toolCallId, queueWhenBusy: true }
        const input = request.params.arguments ?? {}
        const result = state.options.executeTool
          ? await state.options.executeTool(provider, request.params.name, input, options, context)
          : await provider.callTool(request.params.name, input, options)
        return toolResult(result)
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool call failed' }], isError: true }
      } finally {
        extra.signal.removeEventListener('abort', abort)
        state.calls.delete(controller)
      }
    })
    await server.connect(transport)
    return { server, transport }
  }

  private async providers(state: SessionState): Promise<Map<string, ToolProvider>> {
    const options = state.options
    const providers = await options.getProviders()
    const names = new Map<string, ToolProvider>()
    for (const provider of providers) {
      // A self-call would wait forever on the conductor's own agent turn lock.
      if (provider.agentId && provider.agentId === options.conductorAgentId) continue
      for (const tool of provider.getTools()) {
        // Mirrors the in-process union: first provider owns a colliding name.
        if (!names.has(tool.name)) names.set(tool.name, provider)
      }
    }
    return names
  }
}

export const conductorMcpServer = new ConductorMcpServer()
