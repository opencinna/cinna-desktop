/**
 * Driving the **real** Claude Code CLI and the **real** ACP adapter against a
 * loopback fake Anthropic Messages endpoint: no login, no real credential, no
 * provider request.
 *
 * `codexHarness.ts`'s counterpart. The adapter connection, the bounded CLI run
 * and the base environment are generic and come from there; what is Claude's is
 * here: the scratch HOME, the fake `/v1/messages` endpoint, and the **egress
 * trap** that is how "zero real provider requests" is asserted rather than
 * assumed.
 *
 * ## How "no real request" is known
 *
 * `ANTHROPIC_BASE_URL` sends the CLI's model traffic to the loopback endpoint,
 * but the CLI also talks to other hosts on its own (bootstrap, telemetry,
 * update checks). Every child therefore gets `HTTPS_PROXY`/`HTTP_PROXY` naming a
 * loopback proxy that **records the host and refuses the connection**, with
 * loopback exempted through `NO_PROXY`. Nothing that honours the proxy settings can leave the machine (a direct socket would be invisible here, and would carry only the dummy key), and
 * whatever tried to is a list a test can read.
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseEnv } from './codexHarness'

type Json = Record<string, unknown>

/**
 * Where a managed Claude Code for tests is, or null. `CINNA_CONTRACT_CLAUDE`
 * first — how a *candidate* is tested without touching the pin — then the
 * per-machine cache `scripts/install-runtime.mjs claude` fills.
 */
export function findContractClaude(pinnedVersion: string): { path: string; source: 'override' | 'cache' } | null {
  const override = process.env['CINNA_CONTRACT_CLAUDE']
  if (override) return { path: override, source: 'override' }
  const cache = process.env['CINNA_RUNTIME_CACHE'] ?? join(homedir(), '.cache', 'cinna-runtimes')
  const cached = join(cache, `claude-${pinnedVersion}`, 'claude')
  try {
    readFileSync(cached, { flag: 'r' }).subarray(0, 0)
    return { path: cached, source: 'cache' }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ the egress trap */

export interface EgressTrap {
  port: number
  /** Every host a child tried to reach through the proxy, `host:port`, in order. Each was refused. */
  attempts: string[]
  close(): Promise<void>
}

/** A proxy that lets nothing through: CONNECT and plain requests are recorded, then refused. */
export async function startEgressTrap(): Promise<EgressTrap> {
  const attempts: string[] = []
  const server: Server = createServer((req, res) => {
    attempts.push(String(req.headers.host ?? req.url ?? 'unknown'))
    res.writeHead(502)
    res.end()
  })
  server.on('connect', (req, socket) => {
    attempts.push(String(req.url ?? 'unknown'))
    // A refused client resets the socket; unhandled, that is an uncaught error
    // in the test process — "might cause false positive tests", as vitest says.
    socket.on('error', () => undefined)
    socket.end('HTTP/1.1 502 Blocked by the contract harness\r\n\r\n')
  })
  server.on('clientError', (_error, socket) => { socket.destroy() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the egress trap did not bind a port')
  return {
    port: address.port, attempts,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}

/* ------------------------------------------------------------------ scratch */

/** A throwaway HOME with `work/` inside it, and the env that points a child at the fakes. */
export function makeClaudeScratch(prefix: string, input: { providerPort: number; trapPort: number }): {
  home: string; cwd: string; env: Record<string, string>; dispose(): void
} {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const cwd = join(home, 'work')
  mkdirSync(cwd)
  const proxy = `http://127.0.0.1:${input.trapPort}`
  return {
    home, cwd,
    env: {
      ...baseEnv(),
      // The isolated HOME is what makes this "no login": the real Keychain
      // entry and `~/.claude` belong to another HOME. `CLAUDE_CONFIG_DIR` pins
      // the CLI's own state inside the scratch as well.
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${input.providerPort}`,
      // A dummy, recognisably so: it must never look like a key worth stealing
      // in a log, and the fake endpoint asserts it is the one that arrives.
      ANTHROPIC_API_KEY: 'sk-ant-contract-dummy-not-a-real-key',
      HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      DISABLE_AUTOUPDATER: '1'
    },
    dispose: () => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/* -------------------------------------------------------- the fake provider */

/**
 * Whose request this is, by content and never by model (the title request runs
 * on the conversation's own model). Observed against 2.1.276 (2026-09-18):
 *
 * - `title` — the CLI names the session: system prompt opening "You are naming
 *   a coding…", the session's text inside `<session>…</session>`, no tools.
 * - `conversation` — everything else, which is what Cinna asked for.
 *
 * A release that rewords the title prompt makes it read as `conversation`, and
 * the entries that separate them turn red — on purpose.
 */
export type ClaudeRequestKind = 'conversation' | 'title'

export function isClaudeTitleRequest(systemText: string, lastUserText: string): boolean {
  return /\bYou are naming a coding\b/.test(systemText) && /<session>[\s\S]*<\/session>/.test(lastUserText)
}

/** What one Messages request looked like, reduced to what a contract may assert on. */
export interface ClaudeProviderTurn {
  index: number
  kind: ClaudeRequestKind
  /** Request path without the query, e.g. `/v1/messages`. */
  path: string
  method: string
  model: string | null
  stream: boolean
  /** `max_tokens`, which is how the CLI's own small requests differ from a conversation. */
  maxTokens: number | null
  /** Tool names offered to the model, in order. */
  tools: string[]
  /** Text of every `tool_result` block the CLI sent back. */
  toolResults: string[]
  /** The `system` prompt, flattened — for marker checks only. */
  systemText: string
  /** The last user message's text. */
  lastUserText: string
  userMessages: number
  /** Whether the dummy key arrived, and only it. */
  apiKey: 'dummy' | 'absent' | 'other'
  hasThinking: boolean
  /**
   * Whether the raw request body contains a marker. The body itself is not kept
   * on the turn: a snapshot must never be able to hold a prompt.
   */
  mentions(marker: string): boolean
}

export type ClaudeProviderReply =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input?: Json }
  | { kind: 'status'; status: number; body: Json; headers?: Record<string, string> }
  /** Hold the response open until the socket is closed — for cancellation. */
  | { kind: 'stall' }

export interface FakeAnthropic {
  port: number
  turns: ClaudeProviderTurn[]
  /** Requests to anything other than `POST /v1/messages`, as `METHOD path`. */
  otherRequests: string[]
  close(): Promise<void>
}

const blockText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block: Json) => (typeof block.text === 'string' ? block.text : '')).join('\n')
      : ''

/** A loopback Anthropic Messages endpoint whose every answer is decided by the caller. */
export async function startFakeAnthropic(decide: (turn: ClaudeProviderTurn) => ClaudeProviderReply): Promise<FakeAnthropic> {
  const turns: ClaudeProviderTurn[] = []
  const otherRequests: string[] = []
  const server: Server = createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const part of req) raw += part
      const path = String(req.url ?? '').split('?')[0]
      if (req.method !== 'POST' || path !== '/v1/messages') {
        otherRequests.push(`${req.method} ${path}`)
        // `count_tokens` is answered so the CLI is not left retrying it; anything
        // else gets an honest 404 — this is not a whole Anthropic API.
        if (path === '/v1/messages/count_tokens') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ input_tokens: 1 }))
          return
        }
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'contract fake' } }))
        return
      }
      const body = JSON.parse(raw) as Json
      const messages = (Array.isArray(body.messages) ? body.messages : []) as Json[]
      const users = messages.filter((message) => message.role === 'user')
      req.socket.on('error', () => undefined)
      const key = req.headers['x-api-key']
      const systemText = blockText(body.system)
      const lastUserText = blockText(users.at(-1)?.content)
      const turn: ClaudeProviderTurn = {
        index: turns.length, kind: isClaudeTitleRequest(systemText, lastUserText) ? 'title' : 'conversation',
        path, method: String(req.method),
        model: typeof body.model === 'string' ? body.model : null,
        stream: body.stream === true,
        maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
        tools: (Array.isArray(body.tools) ? body.tools as Json[] : []).map((tool) => String(tool.name ?? tool.type)),
        toolResults: messages.flatMap((message) => Array.isArray(message.content) ? message.content as Json[] : [])
          .filter((block) => block.type === 'tool_result').map((block) => blockText(block.content) || JSON.stringify(block.content)),
        systemText, lastUserText,
        userMessages: users.length,
        apiKey: key === undefined ? 'absent' : key === 'sk-ant-contract-dummy-not-a-real-key' ? 'dummy' : 'other',
        hasThinking: body.thinking !== undefined,
        mentions: (marker) => raw.includes(marker)
      }
      turns.push(turn)
      const reply = decide(turn)
      if (reply.kind === 'stall') return
      if (reply.kind === 'status') {
        res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) })
        res.end(JSON.stringify(reply.body))
        return
      }
      const id = `msg_contract_${turn.index}`
      const block: Json = reply.kind === 'tool'
        ? { type: 'tool_use', id: `toolu_contract_${turn.index}`, name: reply.name, input: reply.input ?? {} }
        : { type: 'text', text: reply.text }
      const stopReason = reply.kind === 'tool' ? 'tool_use' : 'end_turn'
      const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      if (!turn.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: turn.model, content: [block], stop_reason: stopReason, stop_sequence: null, usage }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const event = (type: string, data: Json): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`) }
      event('message_start', { message: { id, type: 'message', role: 'assistant', model: turn.model, content: [], stop_reason: null, stop_sequence: null, usage } })
      if (reply.kind === 'tool') {
        event('content_block_start', { index: 0, content_block: { ...block, input: {} } })
        event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input ?? {}) } })
      } else {
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text } })
      }
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } })
      event('message_stop', {})
      res.end()
    } catch {
      res.writeHead(400)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the fake Anthropic endpoint did not bind a port')
  return {
    port: address.port, turns, otherRequests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}
