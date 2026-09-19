/**
 * Driving the **real** Codex CLI and the **real** patched ACP adapter against a
 * loopback fake provider: no login, no API credential, no provider request.
 *
 * Shared by the contract tests beside this file and by
 * `scripts/probes/runtime-conductor-codex.mjs`, which is why it is written the
 * way it is. The probe runs under `node --experimental-strip-types`, so this
 * module must stay loadable by a type-stripping loader: **Node builtins only,
 * no relative imports, no enums, no parameter properties, no app logger.**
 * Anything app-owned the harness needs (the Cinna MCP server, the production
 * policy helper) is passed in by the caller, which imports it its own way.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

type Json = Record<string, unknown>

/** The only variables a probe child inherits. Never an API key, never the real HOME. */
export function baseEnv(): Record<string, string> {
  return Object.fromEntries(
    ['PATH', 'USER', 'LOGNAME', 'SHELL']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key] as string])
  )
}

/**
 * Where a managed Codex for tests is, or null.
 *
 * `CINNA_CONTRACT_CODEX` first — that is how a *candidate* version is tested
 * without touching the pin — then the per-machine cache
 * `scripts/install-runtime.mjs` fills.
 */
export function findContractCodex(pinnedVersion: string): { path: string; source: 'override' | 'cache' } | null {
  const override = process.env['CINNA_CONTRACT_CODEX']
  if (override) return { path: override, source: 'override' }
  const cache = process.env['CINNA_RUNTIME_CACHE'] ?? join(homedir(), '.cache', 'cinna-runtimes')
  const cached = join(cache, `codex-${pinnedVersion}`, 'codex')
  try {
    readFileSync(cached, { flag: 'r' }).subarray(0, 0)
    return { path: cached, source: 'cache' }
  } catch {
    return null
  }
}

/** A throwaway HOME with `work/` and `codex/` inside it. Removed by `dispose`. */
export function makeScratch(prefix: string, root = tmpdir()): { home: string; cwd: string; codexHome: string; env: Record<string, string>; dispose(): void } {
  const home = mkdtempSync(join(root, prefix))
  const cwd = join(home, 'work')
  const codexHome = join(home, 'codex')
  mkdirSync(cwd)
  mkdirSync(codexHome)
  return {
    home, cwd, codexHome,
    env: { ...baseEnv(), HOME: home, CODEX_HOME: codexHome },
    // Codex clones plugins into CODEX_HOME in the background; a first rm can
    // race it, so removal is retried rather than allowed to fail a run.
    dispose: () => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** Run the CLI once, bounded. `status` is null when it was killed. */
export function runCli(binary: string, args: string[], env: Record<string, string>, cwd: string): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}

/** Flattened tool names as the provider is offered them: `mcp__cinna.probe`, `request_user_input`. */
export function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool: Json) =>
    tool.type === 'namespace' && Array.isArray(tool.tools)
      ? (tool.tools as Json[]).map((child) => `${String(tool.name)}.${String(child.name)}`)
      : [String(tool.name ?? tool.type)]
  )
}

/* -------------------------------------------------------- the fake provider */

/**
 * Whose request this is. Observed against 0.155.0 (2026-09-18), by content and
 * never by model — "it is on another model" is exactly what a conversation that
 * failed to move to a new model would also look like:
 *
 * - `title` — the CLI names the thread: once per session, beside the first
 *   turn, a strict `json_schema` output with a single `title` property.
 * - `compaction` — after a model change the CLI has the **old** model write a
 *   handoff summary; the last user item is its fixed compaction instruction.
 * - `conversation` — everything else, which is what Cinna asked for.
 *
 * A release that rewords either shape makes that request read as
 * `conversation`, and the entries that separate them turn red — on purpose.
 */
export type ProviderRequestKind = 'conversation' | 'title' | 'compaction'

export function providerRequestKind(body: unknown): ProviderRequestKind {
  const request = (body && typeof body === 'object' ? body : {}) as Json
  const format = ((request.text as Json | undefined)?.format ?? {}) as Json
  const properties = ((format.schema as Json | undefined)?.properties ?? {}) as Json
  if (format.type === 'json_schema' && Object.keys(properties).join() === 'title') return 'title'
  const input = (Array.isArray(request.input) ? request.input : []) as Json[]
  const lastUser = input.filter((item) => item.role === 'user').at(-1)
  if (/^You are performing a CONTEXT CHECKPOINT COMPACTION\b/.test(textOf(lastUser?.content))) return 'compaction'
  return 'conversation'
}

/** What one Responses request looked like, reduced to what a contract may assert on. Never prompt bodies. */
export interface ProviderTurn {
  index: number
  kind: ProviderRequestKind
  /** Request path, e.g. `/v1/responses`. */
  path: string
  model: string | null
  reasoningEffort: string | null
  tools: string[]
  /** `function_call_output` payloads the CLI sent back — our own deterministic tool results. */
  outputs: string[]
  /** Developer/system text, for marker checks only. */
  systemText: string
  userText: string
  /** The newest user item alone — what this request is *about*, where `userText` is the whole history. */
  lastUserText: string
  /** `function_call_output` items after that newest user item: 0 means the model has not acted on it yet. */
  pendingOutputs: number
}

export type ProviderReply =
  | { kind: 'text'; text: string }
  /** Call a tool by its bare name; the namespace is looked up in the offered catalog. */
  | { kind: 'tool'; name: string; args?: string }
  /** Native deferred MCP discovery uses a Responses tool_search_call, not function_call. */
  | { kind: 'tool-search'; args: Record<string, unknown> }
  | { kind: 'status'; status: number; body: Json }
  /** Hold the response open until the socket is closed — for cancellation. */
  | { kind: 'stall' }

export interface FakeProvider {
  port: number
  turns: ProviderTurn[]
  close(): Promise<void>
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block: Json) => (typeof block.text === 'string' ? block.text : '')).join('\n')
      : ''

/** A loopback OpenAI-Responses SSE endpoint whose every answer is decided by the caller. */
export async function startFakeProvider(decide: (turn: ProviderTurn) => ProviderReply): Promise<FakeProvider> {
  const turns: ProviderTurn[] = []
  const server: Server = createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const part of req) raw += part
      const body = JSON.parse(raw) as Json
      const input = (Array.isArray(body.input) ? body.input : []) as Json[]
      const lastUserAt = input.map((item) => item.role).lastIndexOf('user')
      const turn: ProviderTurn = {
        index: turns.length,
        kind: providerRequestKind(body),
        path: String(req.url ?? ''),
        model: typeof body.model === 'string' ? body.model : null,
        reasoningEffort: typeof (body.reasoning as Json | undefined)?.effort === 'string' ? String((body.reasoning as Json).effort) : null,
        tools: toolNames([...(Array.isArray(body.tools) ? body.tools : []), ...input.filter((item) => item.type === 'tool_search_output').flatMap((item) => Array.isArray(item.tools) ? item.tools : [])]),
        outputs: input.filter((item) => item.type === 'function_call_output').map((item) => textOf(item.output) || JSON.stringify(item.output)),
        systemText: [typeof body.instructions === 'string' ? body.instructions : '',
          ...input.filter((item) => item.role === 'developer' || item.role === 'system').map((item) => textOf(item.content))].join('\n'),
        userText: input.filter((item) => item.role === 'user').map((item) => textOf(item.content)).join('\n'),
        lastUserText: lastUserAt < 0 ? '' : textOf(input[lastUserAt].content),
        pendingOutputs: input.slice(lastUserAt + 1).filter((item) => item.type === 'function_call_output').length
      }
      turns.push(turn)
      const reply = decide(turn)
      if (reply.kind === 'stall') return
      if (reply.kind === 'status') {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(reply.body))
        return
      }
      const offered = [...(Array.isArray(body.tools) ? body.tools : []), ...input.filter((item) => item.type === 'tool_search_output').flatMap((item) => Array.isArray(item.tools) ? item.tools : [])] as Json[]
      const flat = offered.flatMap((tool) => tool.type === 'namespace' && Array.isArray(tool.tools)
        ? (tool.tools as Json[]).map((child) => ({ name: String(child.name), namespace: String(tool.name) }))
        : [{ name: String(tool.name), namespace: undefined as string | undefined }])
      const args = reply.kind === 'tool' ? (reply.args ?? '{}') : ''
      const target = reply.kind === 'tool' ? (flat.find((tool) => tool.name === reply.name) ?? { name: reply.name, namespace: undefined }) : null
      const item: Json = reply.kind === 'tool-search'
        ? { type: 'tool_search_call', id: `search_${turn.index}`, call_id: `call_${turn.index}`, execution: 'client', status: 'completed', arguments: reply.args }
        : target
        ? { type: 'function_call', id: `fc_${turn.index}`, call_id: `call_${turn.index}`, name: target.name,
            ...(target.namespace ? { namespace: target.namespace } : {}), arguments: args, status: 'completed' }
        : { type: 'message', id: `msg_${turn.index}`, role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: (reply as { text: string }).text, annotations: [] }] }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const event = (type: string, data: Json): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`) }
      event('response.created', { response: { id: 'resp', object: 'response', created_at: 1, status: 'in_progress', output: [] } })
      event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', ...(target ? { arguments: '' } : { content: [] }) } })
      if (target) {
        event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: args })
        event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: args })
      } else if (reply.kind !== 'tool-search') {
        const text = (reply as { text: string }).text
        event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
        event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text })
      }
      event('response.output_item.done', { output_index: 0, item })
      event('response.completed', { response: { id: 'resp', object: 'response', created_at: 1, status: 'completed',
        output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
      res.end()
    } catch {
      res.writeHead(400)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the fake provider did not bind a port')
  return {
    port: address.port,
    turns,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}

/** `config.toml` that routes the CLI's model traffic to the loopback provider and nowhere else. */
export function writeProviderConfig(codexHome: string, port: number, model: string, extraLines: string[] = []): void {
  writeFileSync(join(codexHome, 'config.toml'), [
    `model = ${JSON.stringify(model)}`, 'model_provider = "probe"', ...extraLines,
    '[model_providers.probe]', 'name = "Loopback fake model"',
    `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
    'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0'
  ].join('\n') + '\n')
}

/* ------------------------------------------------------------- the adapter */

export interface AdapterMessage { id?: number | string; method?: string; params?: Json; result?: Json; error?: Json }

export interface AdapterConnection {
  /** A JSON-RPC request. Resolves with the whole response; a timeout resolves as an error. */
  rpc(method: string, params: Json, timeoutMs?: number): Promise<AdapterMessage>
  notify(method: string, params: Json): void
  /** Every `session/update` notification, in arrival order. */
  updates: Json[]
  /** Every request the agent made of the client (permission, elicitation, fs…), in order. */
  clientRequests: AdapterMessage[]
  stderr(): string
  close(): Promise<void>
}

/**
 * Spawn the adapter over stdio. `answer` decides each agent→client request;
 * returning undefined answers `{ outcome: { outcome: 'cancelled' } }`.
 */
export function spawnAdapter(input: {
  adapterPath: string
  cwd: string
  env: Record<string, string>
  answer?: (request: AdapterMessage) => Json | undefined
}): AdapterConnection {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [input.adapterPath], {
    cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true
  })
  let stderr = ''
  let nextId = 0
  const pending = new Map<number, { resolve(message: AdapterMessage): void; timer: NodeJS.Timeout }>()
  const updates: Json[] = []
  const clientRequests: AdapterMessage[] = []
  child.stderr.on('data', (data) => { stderr = (stderr + String(data)).slice(-4000) })
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
      const result = input.answer?.(message) ?? { outcome: { outcome: 'cancelled' } }
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    }
  })
  return {
    updates, clientRequests,
    stderr: () => stderr,
    notify: (method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') },
    rpc: (method, params, timeoutMs = 30_000) => {
      const id = ++nextId
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ error: { code: 'timeout', message: method } }) }, timeoutMs)
        pending.set(id, { resolve, timer })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    close: async () => {
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
      lines.close()
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } }
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 1000).unref() })
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
      }
    }
  }
}

/** One-shot JSON-RPC conversation with `codex app-server`, the way the policy helper inspects it. */
export async function askAppServer(binary: string, env: Record<string, string>, cwd: string, requests: { method: string; params: Json }[]): Promise<AdapterMessage[]> {
  const child = spawn(binary, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const answers = new Map<number, AdapterMessage>()
  const lines = createInterface({ input: child.stdout })
  const waiters = new Map<number, () => void>()
  lines.on('line', (line) => {
    let message: AdapterMessage
    try { message = JSON.parse(line) as AdapterMessage } catch { return }
    if (typeof message.id === 'number') { answers.set(message.id, message); waiters.get(message.id)?.() }
  })
  const ask = (id: number, method: string, params: Json): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, 20_000)
    waiters.set(id, () => { clearTimeout(timer); resolve() })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  try {
    for (let i = 0; i < requests.length; i++) {
      await ask(i + 1, requests[i].method, requests[i].params)
      if (i === 0) child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    }
    return requests.map((_, i) => answers.get(i + 1) ?? { error: { code: 'timeout' } })
  } finally {
    lines.close()
    child.kill('SIGKILL')
  }
}

/* ------------------------------------------------ production policy, for Node */

/**
 * Load `prepareCodexConductorPolicy` in **plain Node**, where TypeScript path
 * imports do not resolve: transpile the helper and the pin manifest it reads
 * into `dir` and point one at the other. Vitest callers import the helper
 * directly and do not need this.
 */
export function loadProductionPolicy(repo: string, dir: string): (plan: unknown, configRoot: string) => Promise<Json> {
  const require = createRequire(join(repo, 'package.json'))
  const ts = require('typescript') as { transpileModule(source: string, options: Json): { outputText: string }; ModuleKind: Json; ScriptTarget: Json }
  const compile = (source: string): string => ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
  } }).outputText
  writeFileSync(join(dir, 'runtimePins.cjs'), compile(readFileSync(join(repo, 'src/shared/runtimePins.ts'), 'utf8')))
  const policy = compile(readFileSync(join(repo, 'src/main/agents/drivers/acp/codexConductorPolicy.ts'), 'utf8'))
  const rewired = policy.replace(/require\((['"])[^'"]*shared\/runtimePins\1\)/, 'require("./runtimePins.cjs")')
  if (rewired === policy) throw new Error('the policy helper no longer imports shared/runtimePins; update loadProductionPolicy')
  const helperPath = join(dir, 'codexConductorPolicy.cjs')
  writeFileSync(helperPath, rewired)
  return (createRequire(helperPath)(helperPath) as { prepareCodexConductorPolicy(plan: unknown, configRoot: string): Promise<Json> }).prepareCodexConductorPolicy
}
