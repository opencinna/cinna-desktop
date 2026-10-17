/**
 * Driving the **real** OpenCode binary (`opencode acp`, which speaks ACP
 * itself — no adapter) against a loopback fake OpenAI-compatible provider: no
 * login, no real credential, no provider request.
 *
 * `codexHarness.ts`'s counterpart, on the same terms, so a plain-Node probe
 * can load it later: **Node builtins only, no relative imports, no enums, no
 * parameter properties, no app logger.** What is OpenCode's is here:
 * finding the pinned binary, the fake `chat/completions` SSE endpoint, the
 * scratch HOME and XDG directories, a generic stdio ACP client for a binary
 * that is its own agent, and the process-tree reads the kill entries need. The
 * egress trap is Claude's (`claudeHarness.ts`, imported by the test): every child gets
 * `HTTPS_PROXY`/`HTTP_PROXY` naming a loopback proxy that records each host and
 * refuses it, loopback exempted through `NO_PROXY`.
 *
 * The config the binary runs on is never written here: the test builds it with
 * the production `createOpencodeLauncher` (and so `buildEngineConfig`), which
 * is the point of the contract.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

type Json = Record<string, unknown>

/** The only variables a child inherits — `codexHarness.ts`'s `baseEnv`. Never an API key, never the real HOME. */
function baseEnv(): Record<string, string> {
  return Object.fromEntries(
    ['PATH', 'USER', 'LOGNAME', 'SHELL']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key] as string])
  )
}

/**
 * Where a managed OpenCode for tests is, or null. `CINNA_CONTRACT_OPENCODE`
 * first — how a *candidate* is tested without touching the pin — then the
 * per-machine cache `scripts/install-runtime.mjs opencode` fills.
 */
export function findContractOpencode(pinnedVersion: string): { path: string; source: 'override' | 'cache' } | null {
  const override = process.env['CINNA_CONTRACT_OPENCODE']
  if (override) return { path: override, source: 'override' }
  const cache = process.env['CINNA_RUNTIME_CACHE'] ?? join(homedir(), '.cache', 'cinna-runtimes')
  const cached = join(cache, `opencode-${pinnedVersion}`, 'opencode')
  try {
    readFileSync(cached, { flag: 'r' }).subarray(0, 0)
    return { path: cached, source: 'cache' }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ scratch */

/** Markers planted in the scratch HOME: none of them may reach a Cinna agent's model request. */
export const PERSONAL_MARKERS = {
  claudeSkill: 'CONTRACT_PERSONAL_CLAUDE_SKILL_3e1',
  agentsSkill: 'CONTRACT_PERSONAL_AGENTS_SKILL_3e2',
  claudeMd: 'CONTRACT_PERSONAL_CLAUDE_MD_3e3'
} as const

/** The bundled-skill stand-ins under `kit/skills/`: their markers reaching the model are the positive control. */
export const KIT_SKILL_MARKER = 'CONTRACT_KIT_SKILL_9b4'
export const KIT_ARTIFACTS_SKILL_MARKER = 'CONTRACT_KIT_ARTIFACTS_SKILL_9b5'

export interface OpencodeScratch {
  root: string
  home: string
  /** The agent's folder: the session's cwd. */
  cwd: string
  /** Where the launcher writes per-agent configs (`<userData>/acp` in the app). */
  configRoot: string
  /** The kit's `skills/` directory. */
  kitSkills: string
  /**
   * What the app passes as `skillPaths`: each platform skill by its own
   * folder (`cinna-tasks`, `cinna-artifacts`), never the `skills/` root —
   * `engineConfigSource.collectSkillPaths`.
   */
  kitSkillDirs: string[]
  /** What the launcher's `childEnv` returns: base env, scratch HOME and XDG dirs, the trap. */
  env: Record<string, string>
  dispose(): void
}

/**
 * A throwaway root holding HOME (with the user's personal skills and
 * CLAUDE.md planted in it), the agent folder, the config root and a kit skill.
 */
export function makeOpencodeScratch(prefix: string, input: { trapPort: number }): OpencodeScratch {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const home = join(root, 'home')
  const cwd = join(root, 'folder')
  const configRoot = join(root, 'acp')
  const kitSkills = join(root, 'kit', 'skills')
  const kitSkillDirs = [join(kitSkills, 'cinna-tasks'), join(kitSkills, 'cinna-artifacts')]
  for (const directory of [home, cwd, configRoot, ...kitSkillDirs, join(root, 'tmp')]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(kitSkills, 'cinna-tasks', 'SKILL.md'), `---\nname: cinna-tasks\ndescription: ${KIT_SKILL_MARKER} platform tasks\n---\nbody\n`)
  writeFileSync(join(kitSkills, 'cinna-artifacts', 'SKILL.md'), `---\nname: cinna-artifacts\ndescription: ${KIT_ARTIFACTS_SKILL_MARKER} platform artifacts\n---\nbody\n`)
  const skill = (dir: string, name: string, marker: string): void => {
    mkdirSync(join(home, dir, name), { recursive: true })
    writeFileSync(join(home, dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${marker} personal skill\n---\nbody\n`)
  }
  skill('.claude/skills', 'personal-claude', PERSONAL_MARKERS.claudeSkill)
  skill('.agents/skills', 'personal-agents', PERSONAL_MARKERS.agentsSkill)
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), `${PERSONAL_MARKERS.claudeMd}\n`)
  const proxy = `http://127.0.0.1:${input.trapPort}`
  return {
    root, home, cwd, configRoot, kitSkills, kitSkillDirs,
    env: {
      ...baseEnv(),
      HOME: home,
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      TMPDIR: join(root, 'tmp'),
      HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost'
    },
    dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/* -------------------------------------------------------- the fake provider */

/**
 * Whose request this is. A request offering no tool is the engine's own (its
 * session title); everything else is the conversation Cinna
 * asked for. By shape, never by model: the title runs on the session's model.
 */
export type OpenAiRequestKind = 'conversation' | 'auxiliary'

/** What one `chat/completions` request looked like, reduced to what a contract may assert on. */
export interface OpenAiTurn {
  index: number
  kind: OpenAiRequestKind
  path: string
  model: string | null
  /** Tool names offered, in order. */
  tools: string[]
  /** Each offered tool's parameter names. */
  toolParams: Record<string, string[]>
  /** System messages, flattened — for marker checks only. */
  systemText: string
  /** The newest user message alone. */
  lastUserText: string
  /** `tool` messages after that newest user message: 0 means the model has not acted on it yet. */
  pendingToolResults: string[]
  /** Every user message, joined — what history the request carried. */
  userText: string
  /** Whether the raw body contains a marker. The body itself is not kept. */
  mentions(marker: string): boolean
}

export type OpenAiReply =
  | { kind: 'text'; text: string; reasoning?: string }
  | { kind: 'tool'; name: string; args: Json }
  /** Hold the response open until the socket is closed. */
  | { kind: 'stall' }

export interface FakeOpenAi {
  port: number
  turns: OpenAiTurn[]
  /** Requests to anything other than `POST …/chat/completions`, as `METHOD path`. */
  otherRequests: string[]
  close(): Promise<void>
}

const contentText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block: Json) => (typeof block.text === 'string' ? block.text : '')).join('\n')
      : ''

/** A loopback OpenAI-compatible `chat/completions` SSE endpoint whose every answer is decided by the caller. */
export async function startFakeOpenAi(decide: (turn: OpenAiTurn) => OpenAiReply): Promise<FakeOpenAi> {
  const turns: OpenAiTurn[] = []
  const otherRequests: string[] = []
  const server: Server = createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const part of req) raw += part
      const path = String(req.url ?? '').split('?')[0]
      if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
        otherRequests.push(`${req.method} ${path}`)
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'contract fake' } }))
        return
      }
      req.socket.on('error', () => undefined)
      const body = JSON.parse(raw) as Json
      const messages = (Array.isArray(body.messages) ? body.messages : []) as Json[]
      // 2.0.27 appends a user-role `<system-update>` ("The Code Mode tool
      // catalog has changed") when session MCP connects mid-turn, after the
      // tool result it answers. It is the engine's, not the user's prompt.
      const lastUserAt = messages.findLastIndex((message) =>
        message.role === 'user' && !contentText(message.content).trimStart().startsWith('<system-update>'))
      const tools = (Array.isArray(body.tools) ? body.tools : []) as Json[]
      const fn = (tool: Json): Json => (tool.function ?? tool) as Json
      const turn: OpenAiTurn = {
        index: turns.length,
        kind: tools.length > 0 ? 'conversation' : 'auxiliary',
        path,
        model: typeof body.model === 'string' ? body.model : null,
        tools: tools.map((tool) => String(fn(tool).name)),
        toolParams: Object.fromEntries(tools.map((tool) => [String(fn(tool).name),
          Object.keys(((fn(tool).parameters as Json | undefined)?.properties ?? {}) as Json)])),
        systemText: messages.filter((message) => message.role === 'system').map((message) => contentText(message.content)).join('\n'),
        lastUserText: lastUserAt < 0 ? '' : contentText(messages[lastUserAt].content),
        pendingToolResults: messages.slice(lastUserAt + 1).filter((message) => message.role === 'tool').map((message) => contentText(message.content)),
        userText: messages.filter((message) => message.role === 'user').map((message) => contentText(message.content)).join('\n'),
        mentions: (marker) => raw.includes(marker)
      }
      turns.push(turn)
      const reply = decide(turn)
      if (reply.kind === 'stall') return
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const chunk = (delta: Json, finish: string | null = null): void => {
        res.write(`data: ${JSON.stringify({ id: `chatcmpl-contract-${turn.index}`, object: 'chat.completion.chunk', created: 1, model: turn.model,
          choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      }
      if (reply.kind === 'tool') {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_contract_${turn.index}`, type: 'function',
          function: { name: reply.name, arguments: JSON.stringify(reply.args) } }] })
        chunk({}, 'tool_calls')
      } else {
        // `reasoning_content` is how an OpenAI-compatible server streams
        // thinking; the AI SDK provider OpenCode uses reads it as reasoning.
        if (reply.reasoning) chunk({ role: 'assistant', reasoning_content: reply.reasoning })
        chunk({ role: 'assistant', content: reply.text })
        chunk({}, 'stop')
      }
      res.write(`data: ${JSON.stringify({ id: `chatcmpl-contract-${turn.index}`, object: 'chat.completion.chunk', created: 1, model: turn.model,
        choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    } catch {
      res.writeHead(400)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the fake provider did not bind a port')
  return {
    port: address.port, turns, otherRequests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}

/* -------------------------------------------------------------- ACP client */

export interface AcpMessage { id?: number | string; method?: string; params?: Json; result?: Json; error?: Json }

export interface AcpConnection {
  pid: number
  rpc(method: string, params: Json, timeoutMs?: number): Promise<AcpMessage>
  notify(method: string, params: Json): void
  /** Every `session/update` notification, in arrival order. */
  updates: Json[]
  /** Every request the agent made of the client (permission, elicitation…), in order. */
  clientRequests: AcpMessage[]
  stderr(): string
  /** Whether the spawned process has exited. */
  exited(): boolean
  /** Signal the spawned process alone (not its group). */
  kill(signal: NodeJS.Signals): void
  /** Take the whole process group down. */
  close(): Promise<void>
}

/**
 * Spawn an ACP agent over stdio. `answer` decides each agent→client request;
 * returning undefined answers JSON-RPC `-32601`, as a client that implements
 * no such method would. Spawned detached so `close` can reach the group.
 */
export function spawnAcp(input: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  answer?: (request: AcpMessage) => Json | undefined
}): AcpConnection {
  const child: ChildProcessWithoutNullStreams = spawn(input.command, input.args, {
    cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true
  })
  let stderr = ''
  let nextId = 0
  let exited = false
  child.on('exit', () => { exited = true })
  child.stdin.on('error', () => undefined)
  const pending = new Map<number, { resolve(message: AcpMessage): void; timer: NodeJS.Timeout }>()
  const updates: Json[] = []
  const clientRequests: AcpMessage[] = []
  child.stderr.on('data', (data) => { stderr = (stderr + String(data)).slice(-8000) })
  const lines = createInterface({ input: child.stdout })
  const write = (message: Json): void => { if (!exited) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') }
  lines.on('line', (line) => {
    let message: AcpMessage
    try { message = JSON.parse(line) as AcpMessage } catch { return }
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(Number(message.id))
      if (entry) { clearTimeout(entry.timer); pending.delete(Number(message.id)); entry.resolve(message) }
    } else if (message.method === 'session/update') {
      updates.push((message.params?.update ?? {}) as Json)
    } else if (message.id !== undefined) {
      clientRequests.push(message)
      const result = input.answer?.(message)
      write(result === undefined
        ? { id: message.id, error: { code: -32601, message: `${message.method} is not supported by the contract client` } }
        : { id: message.id, result })
    }
  })
  return {
    pid: child.pid ?? -1,
    updates, clientRequests,
    stderr: () => stderr,
    exited: () => exited,
    kill: (signal) => { try { child.kill(signal) } catch { /* gone */ } },
    notify: (method, params) => write({ method, params }),
    rpc: (method, params, timeoutMs = 30_000) => {
      const id = ++nextId
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ error: { code: 'timeout', message: method } }) }, timeoutMs)
        pending.set(id, { resolve, timer })
        write({ id, method, params })
      })
    },
    close: async () => {
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
      lines.close()
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } }
      if (!exited) {
        await new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 1500).unref() })
      }
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }
}

/* ------------------------------------------------------------ process tree */

/** Every descendant of `pid`, depth first (`pgrep -P`, POSIX). */
export function descendantsOf(pid: number): number[] {
  const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  const children = (out.stdout ?? '').split('\n').map((line) => Number(line.trim())).filter((child) => child > 0)
  return children.flatMap((child) => [child, ...descendantsOf(child)])
}

export const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Kill whatever is left of `pids`, for cleanup after an orphan check. */
export function reap(pids: readonly number[]): void {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
}
