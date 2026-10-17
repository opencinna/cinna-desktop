/**
 * The loopback token endpoint a folder agent's skill scripts call for a fresh Google access token
 * (`core.cinna_api.credentials.access_token`), Desktop's stand-in for Core's env endpoint
 * `POST /api/v1/agent/credentials/{id}/access-token`: same body, same answer, same error codes.
 *
 * Its own listener on 127.0.0.1, started on first need and kept for the app session, so the
 * `CINNA_CREDENTIALS_TOKEN_URL` an engine was launched with stays valid while the engine is pooled.
 * One route, `POST /credentials/{id}/access-token`; everything else is 404. The Host header must
 * name this listener and any request with an Origin header is refused: browsers have no reason
 * to call it. The bearer is per agent, random, minted once per app session (an engine process
 * is pooled across turns and its env is part of its identity, so a per-turn bearer would respawn
 * it every turn); whether the agent may use it *now* — a turn, kit command or scheduled run holds
 * it — and for which credential is the handler's decision.
 *
 * Core module: no Electron.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export interface CredentialTokenRequest { agentId: string; credentialId: string; minTtl: number; knownExpiresAt: number | null }
/** What to answer: the status and JSON body as they go out, and Core's `Retry-After` when it sent one. */
export interface CredentialTokenAnswer { status: number; body: unknown; retryAfter?: string | null }
export interface CredentialTokenHandler {
  /** Whether the agent may get a token right now (a turn, command or scheduled run holds it). */
  live(agentId: string): boolean
  issue(request: CredentialTokenRequest): Promise<CredentialTokenAnswer>
}

/** Core's own ceiling (`OAUTH_ON_DEMAND_MAX_MIN_TTL_SECONDS`) and default. */
export const MAX_MIN_TTL = 1800, DEFAULT_MIN_TTL = 300
const MAX_BODY = 4096
const ROUTE = /^\/credentials\/([a-zA-Z0-9_-]{1,128})\/access-token$/

function send(response: ServerResponse, answer: CredentialTokenAnswer): void {
  // One request per connection: a script asks once in a while, and nothing is left half-read on a kept socket.
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' }
  if (answer.retryAfter && /^[0-9]{1,6}$/.test(answer.retryAfter)) headers['Retry-After'] = answer.retryAfter
  response.writeHead(answer.status, headers)
  response.end(JSON.stringify(answer.body))
}
const refusal = (status: number, code: string, message: string): CredentialTokenAnswer => ({ status, body: { detail: { code, message } } })

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0, over = false
    request.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > MAX_BODY) { over = true; resolve(null); return }
      chunks.push(chunk)
    })
    request.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

/** `{min_ttl, known_expires_at}`, both optional as in Core; min_ttl clamped to [0, 1800]. Null when malformed. */
export function parseTokenBody(text: string): { minTtl: number; knownExpiresAt: number | null } | null {
  let value: unknown
  try { value = text.trim() === '' ? {} : JSON.parse(text) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { min_ttl: minTtl = DEFAULT_MIN_TTL, known_expires_at: known = null } = value as Record<string, unknown>
  if (typeof minTtl !== 'number' || !Number.isFinite(minTtl)) return null
  if (known !== null && (typeof known !== 'number' || !Number.isFinite(known))) return null
  return { minTtl: Math.max(0, Math.min(Math.trunc(minTtl), MAX_MIN_TTL)), knownExpiresAt: known === null ? null : Math.trunc(known) }
}

export function createCredentialTokenServer(handler: CredentialTokenHandler, onListenerError: (error: unknown) => void = () => {}) {
  /** Per agent, for the app session. Never written anywhere but the engine's env. */
  const bearers = new Map<string, Buffer>()
  let listener: Server | undefined, starting: Promise<string> | undefined, origin = '', port = 0

  /** The agent whose bearer this is, compared in constant time per agent. */
  function agentOf(header: string | undefined): string | null {
    if (!header?.startsWith('Bearer ')) return null
    const supplied = Buffer.from(header.slice(7))
    let found: string | null = null
    for (const [agentId, bearer] of bearers) if (supplied.length === bearer.length && timingSafeEqual(supplied, bearer)) found = agentId
    return found
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // An early refusal drains the unread body, so a kept-alive connection stays usable.
    const refuse = (answer: CredentialTokenAnswer): void => { request.resume(); send(response, answer) }
    const host = request.headers.host
    if ((host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) || request.headers.origin !== undefined) {
      refuse(refusal(403, 'forbidden', 'Forbidden origin or host.'))
      return
    }
    const match = request.method === 'POST' ? ROUTE.exec(request.url ?? '') : null
    if (!match) { refuse(refusal(404, 'not_found', 'Not found.')); return }
    const agentId = agentOf(request.headers.authorization)
    if (!agentId || !handler.live(agentId)) {
      refuse(refusal(401, 'unauthorized', 'This token is not valid now.'))
      return
    }
    const text = await readBody(request)
    if (text === null) { refuse(refusal(413, 'invalid_request', 'Request body too large.')); return }
    const body = parseTokenBody(text)
    if (!body) { send(response, refusal(422, 'invalid_request', 'Expected {"min_ttl": <seconds>, "known_expires_at": <epoch seconds | null>}.')); return }
    send(response, await handler.issue({ agentId, credentialId: match[1], ...body }))
  }

  return {
    /** The agent's bearer, minted on first use and kept for the app session. */
    bearer(agentId: string): string {
      let bearer = bearers.get(agentId)
      if (!bearer) { bearer = Buffer.from(randomBytes(32).toString('base64url')); bearers.set(agentId, bearer) }
      return bearer.toString()
    },
    /** Listen (once) and answer the origin, `http://127.0.0.1:<port>`. */
    start(): Promise<string> {
      if (starting) return starting
      starting = new Promise<string>((resolve, reject) => {
        const server = createServer((request, response) => {
          void handle(request, response).catch(() => {
            if (!response.headersSent) send(response, { status: 503, body: { detail: 'Token request failed.' } })
            else response.end()
          })
        })
        listener = server
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          if (!address || typeof address === 'string') { reject(new Error('Token listener has no loopback address')); return }
          port = address.port
          origin = `http://127.0.0.1:${port}`
          server.unref()
          server.on('error', onListenerError)
          resolve(origin)
        })
      })
      // One failed listen must not break the endpoint until restart.
      starting.catch(() => { starting = undefined; listener = undefined })
      return starting
    },
    /** Shutdown: stop listening and forget every bearer. A later `start` listens anew. */
    async close(): Promise<void> {
      await starting?.catch(() => undefined)
      const server = listener
      listener = undefined; starting = undefined; origin = ''; port = 0
      for (const bearer of bearers.values()) bearer.fill(0)
      bearers.clear()
      if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    }
  }
}
export type CredentialTokenServer = ReturnType<typeof createCredentialTokenServer>
