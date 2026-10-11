/**
 * Driving the **real** Antigravity ACP server (`agy_acp_server.par`) against a
 * loopback fake Gemini endpoint: no Google login, no credential, no provider
 * request.
 *
 * `codexHarness.ts`'s counterpart. Antigravity needs no adapter — the server
 * speaks ACP itself — so the connection here spawns the server directly. Its
 * fake provider is the server's own **gateway** auth mode: a home whose
 * `antigravity-acp/settings.json` says `{"auth":{"type":"gateway"}}`, plus
 * `AGY_LLM_GATEWAY_URL` / `AGY_LLM_GATEWAY_API_KEY` / `AGY_LLM_GATEWAY_MODELS`,
 * sends every model request to `POST <url>/v1beta/models/<model>:streamGenerateContent?alt=sse`
 * in the Gemini (genai) wire format, and touches no Google login.
 *
 * **Never a personal login.** A home whose settings name `oauth-personal` with
 * no token makes `session/new` open the browser sign-in by itself, so
 * {@link assertGatewayHome} is checked before every spawn, and nothing here
 * ever calls `authenticate` or `logout`.
 *
 * Node builtins only and no relative imports beyond erased types, on the same
 * terms as `codexHarness.ts`: a probe script may load it under a type-stripping
 * Node.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AdapterConnection, AdapterMessage } from './codexHarness'

type Json = Record<string, unknown>

/** The executable's install name; `localharness_external` must sit beside it. */
export const ANTIGRAVITY_BINARY = 'agy_acp_server.par'

/**
 * Where a managed Antigravity server for tests is, or null.
 * `CINNA_CONTRACT_ANTIGRAVITY` first — how a *candidate* is tested without
 * touching the pin — then the per-machine cache `scripts/install-runtime.mjs
 * antigravity` fills. A cached server without its sibling is no server.
 */
export function findContractAntigravity(pinnedVersion: string): { path: string; source: 'override' | 'cache' } | null {
  const override = process.env['CINNA_CONTRACT_ANTIGRAVITY']
  if (override) return { path: override, source: 'override' }
  const cache = process.env['CINNA_RUNTIME_CACHE'] ?? join(homedir(), '.cache', 'cinna-runtimes')
  const dir = join(cache, `antigravity-${pinnedVersion}`)
  const cached = join(dir, ANTIGRAVITY_BINARY)
  return existsSync(cached) && existsSync(join(dir, 'localharness_external')) ? { path: cached, source: 'cache' } : null
}

/** The only variables a child inherits. Never an API key, never the real HOME. */
function baseEnv(): Record<string, string> {
  return Object.fromEntries(
    ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key] as string])
  )
}

/**
 * A throwaway root, **realpath'd** (the server reports `/private/var/…` for a
 * macOS temp dir, and paths are compared literally), with `home/` as `HOME`.
 */
export function makeAntigravityScratch(prefix: string): { root: string; home: string; env: Record<string, string>; dispose(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const home = join(root, 'home')
  mkdirSync(home)
  return {
    root, home,
    env: { ...baseEnv(), HOME: home },
    dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** Make `geminiHome` a gateway home: the server's model traffic goes to the loopback fake and nowhere else. */
export function writeGatewayHome(geminiHome: string): void {
  mkdirSync(join(geminiHome, 'antigravity-acp'), { recursive: true })
  writeFileSync(join(geminiHome, 'antigravity-acp', 'settings.json'), `${JSON.stringify({ auth: { type: 'gateway' } })}\n`)
}

/**
 * Refuse to spawn on anything but a gateway home or an empty one. An
 * `oauth-personal` home with no token opens a browser on `session/new`.
 */
export function assertGatewayHome(geminiHome: string): void {
  const path = join(geminiHome, 'antigravity-acp', 'settings.json')
  if (!existsSync(path)) return
  const type = (JSON.parse(readFileSync(path, 'utf8')) as { auth?: { type?: unknown } }).auth?.type
  if (type !== 'gateway') throw new Error(`refusing to start Antigravity on ${path}: auth.type is ${String(type)}, not gateway`)
}

/** The gateway variables, for a fake on `port`. `models` is the picker's allowlist, in order. */
export function gatewayEnv(port: number, models: readonly string[]): Record<string, string> {
  return {
    AGY_LLM_GATEWAY_URL: `http://127.0.0.1:${port}`,
    AGY_LLM_GATEWAY_API_KEY: 'contract-fake-key',
    AGY_LLM_GATEWAY_MODELS: models.join(',')
  }
}

/** Run the server once with `args`, bounded. `status` is null when it was killed. */
export function runServer(binary: string, args: string[], env: Record<string, string>, cwd: string): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}

/* -------------------------------------------------------- the fake gateway */

/** One request the server made of the gateway, reduced to what a contract may assert on. */
export interface GatewayTurn {
  index: number
  /** Request path, query included. */
  path: string
  /** The model the path names (`/v1beta/models/<model>:…`), or null. */
  model: string | null
  /** `streamGenerateContent`, `generateContent`, `countTokens`… */
  method: string | null
  /** Every function declared to the model, by name. */
  tools: string[]
  systemText: string
  /** Every user text part, the whole history. */
  userText: string
  /** The newest user text alone. */
  lastUserText: string
  /** The `functionResponse` parts after that newest user text — 0 means the model has not acted yet. */
  responses: { name: string; output: string }[]
  authorization: string | null
}

export type GatewayReply =
  | { kind: 'text'; text: string }
  /** A `functionCall` part: the server runs the tool and asks again with its `functionResponse`. */
  | { kind: 'call'; name: string; args: Json }
  /** Hold the response open until the socket is closed — for cancellation. */
  | { kind: 'stall' }

export interface FakeGateway {
  port: number
  turns: GatewayTurn[]
  close(): Promise<void>
}

const partsOf = (content: unknown): Json[] => {
  const parts = (content as Json | undefined)?.parts
  return Array.isArray(parts) ? (parts as Json[]) : []
}
const textOfParts = (parts: Json[]): string => parts.map((part) => (typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n')

/** A loopback Gemini SSE endpoint whose every answer is decided by the caller. */
export async function startFakeGateway(decide: (turn: GatewayTurn) => GatewayReply): Promise<FakeGateway> {
  const turns: GatewayTurn[] = []
  const server: Server = createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const part of req) raw += part
      const body = (raw ? JSON.parse(raw) : {}) as Json
      const path = String(req.url ?? '')
      const route = /\/models\/([^/:?]+):([A-Za-z]+)/.exec(path)
      const contents = (Array.isArray(body.contents) ? body.contents : []) as Json[]
      const userTexts = contents.map((content, index) => ({ index, role: content.role, text: textOfParts(partsOf(content)) }))
        .filter((entry) => entry.role === 'user' && entry.text)
      const lastUserAt = userTexts.at(-1)?.index ?? -1
      const turn: GatewayTurn = {
        index: turns.length,
        path,
        model: route?.[1] ?? null,
        method: route?.[2] ?? null,
        tools: ((Array.isArray(body.tools) ? body.tools : []) as Json[])
          .flatMap((tool) => (Array.isArray(tool.functionDeclarations) ? (tool.functionDeclarations as Json[]) : []))
          .map((declaration) => String(declaration.name)),
        systemText: textOfParts(partsOf(body.systemInstruction)),
        userText: userTexts.map((entry) => entry.text).join('\n'),
        lastUserText: userTexts.at(-1)?.text ?? '',
        responses: contents.slice(lastUserAt + 1).flatMap((content) => partsOf(content))
          .map((part) => part.functionResponse as Json | undefined).filter((response): response is Json => !!response)
          .map((response) => ({ name: String(response.name), output: JSON.stringify(response.response ?? null) })),
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null
      }
      turns.push(turn)
      const reply: GatewayReply = turn.method === 'streamGenerateContent' || turn.method === 'generateContent'
        ? decide(turn) : { kind: 'text', text: 'x' }
      if (reply.kind === 'stall') return
      const parts = reply.kind === 'call' ? [{ functionCall: { name: reply.name, args: reply.args } }] : [{ text: reply.text }]
      const chunk = {
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 100 + turn.index, candidatesTokenCount: 2, totalTokenCount: 102 + turn.index },
        modelVersion: 'contract-fake'
      }
      if (turn.method === 'streamGenerateContent') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.end(`data: ${JSON.stringify(chunk)}\r\n\r\n`)
      } else if (turn.method === 'countTokens') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ totalTokens: 10 }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(chunk))
      }
    } catch {
      res.writeHead(400)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the fake gateway did not bind a port')
  return {
    port: address.port,
    turns,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}

/* -------------------------------------------------------------- the server */

/**
 * Spawn the server over stdio, in its own process group (it starts
 * `localharness_external` beside itself, which must go with it). `answer`
 * decides each server→client request; undefined answers a permission request
 * `cancelled` and anything else "method not found".
 */
export function spawnAntigravity(input: {
  binary: string
  args?: readonly string[]
  cwd: string
  env: Record<string, string>
  geminiHome: string | null
  answer?: (request: AdapterMessage) => Json | undefined
}): AdapterConnection {
  if (input.geminiHome) assertGatewayHome(input.geminiHome)
  const child: ChildProcessWithoutNullStreams = spawn(input.binary, [...(input.args ?? [])], {
    cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true
  })
  let stderr = ''
  let nextId = 0
  const pending = new Map<number, { resolve(message: AdapterMessage): void; timer: NodeJS.Timeout }>()
  const updates: Json[] = []
  const clientRequests: AdapterMessage[] = []
  child.stderr.on('data', (data) => { stderr = (stderr + String(data)).slice(-8000) })
  child.stdin.on('error', () => undefined)
  const write = (message: Json): void => { if (child.exitCode === null && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n') }
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let message: AdapterMessage
    try { message = JSON.parse(line) as AdapterMessage } catch { return }
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(Number(message.id))
      if (entry) { clearTimeout(entry.timer); pending.delete(Number(message.id)); entry.resolve(message) }
    } else if (message.method === 'session/update') {
      updates.push((message.params?.update ?? {}) as Json)
    } else if (message.id !== undefined) {
      clientRequests.push(message)
      const result = input.answer?.(message)
      if (result !== undefined) write({ jsonrpc: '2.0', id: message.id, result })
      else if (message.method === 'session/request_permission') write({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })
      else write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported by the contract client' } })
    }
  })
  return {
    updates, clientRequests,
    stderr: () => stderr,
    notify: (method, params) => { write({ jsonrpc: '2.0', method, params }) },
    rpc: (method, params, timeoutMs = 60_000) => {
      const id = ++nextId
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ error: { code: 'timeout', message: method } }) }, timeoutMs)
        pending.set(id, { resolve, timer })
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    close: async () => {
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
      lines.close()
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } }
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 3000).unref() })
      }
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }
}
