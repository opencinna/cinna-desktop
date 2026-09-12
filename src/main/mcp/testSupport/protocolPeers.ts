import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const MODERN = '2026-07-28'
export const LEGACY = '2025-11-25'
export const TOOL_NAME = 'peer_echo'
export const TOOL_TEXT = 'Verified through a real MCP peer: maple-7931.'
export const BEARER = 'mcp-peer-synthetic-token'
export interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}
export interface PeerRequest {
  method: string
  path: string
  authorization: string | undefined
  protocolVersion: string | undefined
  rpc?: RpcRequest
  form?: Record<string, string>
}
export interface PeerOptions {
  protocol: 'modern' | 'legacy' | 'sse'
  probeStatus?: 401 | 403 | 503
  oauth?: boolean
  tokenGate?: Promise<void>
  requireIssuer?: boolean
  noRefreshToken?: boolean
}

const tool = { name: TOOL_NAME, description: 'Echo a value through the fixture.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }

/** Raw protocol fixtures; deliberately no SDK Server or substitute Client. */
export async function protocolPeer(options: PeerOptions) {
  const requests: PeerRequest[] = []
  const sseClients = new Set<ServerResponse>()
  const state = { toolResult: null as Record<string, unknown> | null, sseClosed: 0, rejectAuthorized: false, rejectNextAuthorized: 0, refusalStatus: 401 as 401 | 403 }
  const resultFor = (rpc: RpcRequest): { result?: unknown; error?: { code: number; message: string } } => {
    switch (rpc.method) {
      case 'server/discover':
        return options.protocol === 'modern'
          ? { result: { resultType: 'complete', supportedVersions: [MODERN], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' } }
          : { error: { code: -32601, message: 'Legacy peer does not implement server/discover' } }
      case 'initialize':
        return { result: { protocolVersion: LEGACY, capabilities: { tools: {} }, serverInfo: { name: 'raw-peer', version: '1.0.0' } } }
      case 'tools/list':
        return { result: { tools: [tool], ...(options.protocol === 'modern' ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' } : {}) } }
      case 'tools/call':
        return { result: state.toolResult ?? { content: [{ type: 'text', text: TOOL_TEXT }],
          ...(options.protocol === 'modern' ? { resultType: 'complete' } : {}) } }
      case 'ping': return { result: {} }
      default: return { error: { code: -32601, message: `Unexpected fixture method: ${rpc.method}` } }
    }
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const record: PeerRequest = { method: req.method ?? 'GET', path,
      authorization: req.headers.authorization, protocolVersion: req.headers['mcp-protocol-version'] as string | undefined }
    requests.push(record)
    const json = (value: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
    }
    if (options.oauth && path.startsWith('/.well-known/oauth-protected-resource')) {
      json({ resource: `${origin}/${options.protocol === 'sse' ? 'sse' : 'mcp'}`, authorization_servers: [origin] }); return
    }
    if (options.oauth && path === '/.well-known/oauth-authorization-server') {
      json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`, response_types_supported: ['code'],
        authorization_response_iss_parameter_supported: options.requireIssuer ?? false,
        grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'] }); return
    }
    if (options.oauth && path === '/register') {
      void readBody(req).then((body) => json({ ...JSON.parse(body), client_id: 'peer-public-client' })); return
    }
    if (options.oauth && path === '/token') {
      void readBody(req).then(async (body) => {
        record.form = Object.fromEntries(new URLSearchParams(body))
        await options.tokenGate
        json({ access_token: BEARER, token_type: 'Bearer', expires_in: 3600,
          ...(options.noRefreshToken ? {} : { refresh_token: 'rotated-peer-refresh-token' }) })
      }); return
    }
    if (options.protocol === 'sse' && req.method === 'GET' && path === '/sse') {
      if (options.oauth && req.headers.authorization !== `Bearer ${BEARER}`) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` })
        res.end(); return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: endpoint\ndata: /messages?sessionId=peer-session\n\n')
      sseClients.add(res)
      res.on('close', () => { sseClients.delete(res); state.sseClosed++ })
      return
    }
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    void readBody(req).then((body) => {
      const rpc = JSON.parse(body) as RpcRequest
      record.rpc = rpc
      if (options.oauth && (state.rejectAuthorized || state.rejectNextAuthorized > 0 || req.headers.authorization !== `Bearer ${BEARER}`)) {
        if (state.rejectNextAuthorized > 0) state.rejectNextAuthorized--
        res.writeHead(state.refusalStatus, { 'www-authenticate': `Bearer ${state.refusalStatus === 403 ? 'error="insufficient_scope", ' : ''}resource_metadata="${origin}/.well-known/oauth-protected-resource"` })
        res.end(); return
      }
      if (rpc.method === 'server/discover' && options.probeStatus) {
        res.writeHead(options.probeStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Probe deliberately refused by fixture' }))
        return
      }
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
      const reply = { jsonrpc: '2.0', id: rpc.id, ...resultFor(rpc) }
      if (options.protocol === 'sse') {
        res.writeHead(202); res.end()
        for (const client of sseClients) client.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply))
      }
    }).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(400)
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, url: `${origin}/${options.protocol === 'sse' ? 'sse' : 'mcp'}`, requests, state,
    methods: () => requests.flatMap((row) => row.rpc ? [row.rpc.method] : []),
    async close(): Promise<void> {
      for (const response of sseClients) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}
export type ProtocolPeer = Awaited<ReturnType<typeof protocolPeer>>
