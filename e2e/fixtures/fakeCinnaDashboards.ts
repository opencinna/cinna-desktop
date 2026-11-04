import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Server as IoServer, type Socket } from 'socket.io'

/**
 * A loopback cinna-core with just what Dashboards D6 (tiles for the profile's
 * own cloud agents) talks to, in core's wire shapes
 * (`src/main/services/dashboards/remote/coreDashboardsClient.ts`; core's
 * `dashboard_tiles.py`, `user_dashboards.py`, `agent_dashboards.py`,
 * `dashboard_chat.py`, `dashboard_frame_content.py`):
 *
 * - `GET /api/v1/external/agents` — two core agents: `Ledger Keeper`, the
 *   profile's own, and `Partner Desk`, a bundle install it does not own;
 * - each agent's A2A card and `message/stream` endpoint at core's
 *   `/api/v1/external/a2a/agent/<id>/`, which answers one short final status
 *   and records what it was sent;
 * - the agent's component list, one component, a preview run and frame;
 * - backing dashboards (`POST /dashboards/ {origin}`), blocks, a block's
 *   `data` / `refresh` / `params` / `call` / `frame` / `page-state`;
 * - `/d/v/<cap>/<path>`: the html component's files, the entry page carrying
 *   the kit bridge byte for byte as core injects it, under core's own headers
 *   (a CSP with `frame-ancestors` and a marker header, which the desktop must
 *   not pass on). An expired or unknown cap is 404, as core answers;
 * - `POST /dashboards/<id>/chat` — the dashboard chat session;
 * - socket.io at `/ws` (auth `{token}`), whose `event` the test emits.
 *
 * Every request is recorded in `requests`. `down` makes the server drop every
 * connection (the server unreachable); `blocks[i].mode` turns a block's data
 * and refresh into core's coded refusals; `holdRefresh()` keeps the next
 * refreshes waiting until released (an environment that takes a while to wake).
 *
 * Usable outside Playwright for a manual session (no Playwright import):
 *
 *     npx tsx e2e/fixtures/fakeCinnaDashboards.ts [port]
 *
 * prints the server URL; link a profile to it (`linkSandboxAccount` in
 * `jobRemoteService.ts` writes the token {@link FAKE_CORE_TOKEN}), then
 * `window.api.agents.syncRemote()`.
 */

export const FAKE_CORE_TOKEN = 'task-handoff-fixture-token'

export const OWN_AGENT = 'Ledger Keeper'
export const SHARED_AGENT = 'Partner Desk'

/** core's `params_resolved` for `month: current`: a month no desktop clock resolves to, so the tile shows core's. */
export const CORE_MONTH = '2031-01'

const BRIDGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'cinna-agent-kit', 'protocols', 'dashboards-bridge.js'))

export interface FakeComponent {
  name: string
  component_json: Record<string, unknown>
  /** The data a run computes from the resolved params. */
  compute: (params: Record<string, unknown>) => unknown
  /** html only: component-relative files. */
  files?: Record<string, string>
}

/** A native list with no params. */
export const OPEN_DEALS: FakeComponent = {
  name: 'open-deals',
  component_json: {
    schema_version: 1,
    title: 'Open deals',
    description: 'Deals still open this quarter.',
    view: 'list',
    source: { endpoint: 'items' },
    endpoints: { items: { script: 'api/items.mjs', description: 'Open deals. No params.' } },
    refresh: { max_age: '1h' },
    prompts: [{ label: 'Biggest deal?', prompt: 'Which open deal is biggest?' }],
    size: 'm'
  },
  compute: () => ({ items: [{ id: 'acme', title: 'Acme renewal' }, { id: 'globex', title: 'Globex expansion' }] })
}

/** A native list with a stage and a month filter. */
export const PIPELINE: FakeComponent = {
  name: 'pipeline',
  component_json: {
    schema_version: 1,
    title: 'Pipeline',
    view: 'list',
    source: { endpoint: 'items' },
    endpoints: { items: { script: 'api/items.mjs', description: 'Deals in one stage and month. Params: stage, month.' } },
    params: {
      stage: { type: 'enum', label: 'Stage', values: ['open', 'won', 'lost'], default: 'open' },
      month: { type: 'month', label: 'Month', default: 'current' }
    },
    refresh: { max_age: '1h' },
    size: 'm'
  },
  compute: (params) => ({ items: [{ id: 'echo', title: `stage=${String(params.stage)} month=${String(params.month)}` }] })
}

const PAGE_SCRIPT = [
  'cinna.ready.then(async function (meta) {',
  '  document.getElementById("state").textContent = "ready " + meta.component',
  '  try {',
  '    var value = await cinna.call("ping", { n: 7 })',
  '    document.getElementById("call").textContent = "call " + JSON.stringify(value)',
  '  } catch (err) {',
  '    document.getElementById("call").textContent = "call failed " + (err && err.message)',
  '  }',
  '})',
  ''
].join('\n')

/** An html page: index.html + app.js, a `data` source, and a `ping` endpoint the page calls. */
export const LIVE_BOARD: FakeComponent = {
  name: 'live-board',
  component_json: {
    schema_version: 1,
    title: 'Live board',
    view: 'html',
    entry: 'index.html',
    source: { endpoint: 'data' },
    endpoints: {
      data: { script: 'api/data.mjs', description: 'Nothing to show. No params.' },
      ping: { script: 'api/ping.mjs', description: 'Echoes n. Params: n.' }
    },
    refresh: { max_age: '1h' },
    size: 'm'
  },
  compute: () => ({}),
  files: {
    'index.html':
      '<!doctype html><html><head><meta charset="utf-8"><title>Live board</title></head>' +
      '<body style="padding:40px 12px 12px;font:12px sans-serif"><p id="state">loading</p><p id="call">no call</p>' +
      '<script src="./app.js"></script></body></html>',
    'app.js': PAGE_SCRIPT
  }
}

export interface FakeAgent {
  id: string
  name: string
  owned: boolean
  components: FakeComponent[]
  /** Core answers 404 for this agent and its blocks (deleted on the server). */
  gone: boolean
}

export type BlockMode = 'ok' | 'env_unavailable' | 'not_found'

export interface FakeBlock {
  id: string
  dashboardId: string
  agentId: string
  title: string | null
  config: { component: string; skill?: string | null; params?: Record<string, unknown>; refresh?: Record<string, unknown> }
  /** What `data` answers: core's cache. */
  data: unknown
  stale: boolean
  fetchedAt: string | null
  mode: BlockMode
  /** What `POST …/frame` answers instead of a frame (e.g. `env_unavailable` while data still reads). */
  frameRefusal: 'env_unavailable' | null
}

export interface FakeRequest {
  method: string
  path: string
  body: unknown
}

export interface A2aSend {
  agentId: string
  method: string
  authorization: string | undefined
  message: { taskId?: string; contextId?: string; metadata?: Record<string, unknown>; parts?: { kind: string; text?: string }[] }
  text: string
}

interface Cap {
  blockId: string | null
  agentId: string
  component: string
  expired: boolean
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
  })
}

/** core's `params_resolved`: defaults filled in, `current` → {@link CORE_MONTH}. */
function resolveParams(component: FakeComponent | undefined, params: Record<string, unknown>): Record<string, unknown> {
  const declared = (component?.component_json.params ?? {}) as Record<string, { type: string; default?: unknown }>
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(declared)) {
    const value = params[key] ?? spec.default
    if (value === undefined || value === null || value === '') continue
    out[key] = spec.type === 'month' && value === 'current' ? CORE_MONTH : value
  }
  return out
}

/** The bridge right after `<head…>`, as core's `_insertion_point` puts it. */
function withBridge(html: string): Buffer {
  const match = /<head(?:\s[^>]*)?>/i.exec(html)
  const at = match ? match.index + match[0].length : 0
  return Buffer.concat([Buffer.from(html.slice(0, at)), Buffer.from('<script>'), BRIDGE, Buffer.from('</script>'), Buffer.from(html.slice(at))])
}

export async function startFakeCore(options: { port?: number } = {}) {
  let host = ''
  const agents: FakeAgent[] = [
    { id: randomUUID(), name: OWN_AGENT, owned: true, components: [OPEN_DEALS, PIPELINE, LIVE_BOARD], gone: false },
    { id: randomUUID(), name: SHARED_AGENT, owned: false, components: [OPEN_DEALS], gone: false }
  ]
  const dashboards = new Map<string, { id: string; name: string; origin: string; created: unknown }>()
  const blocks = new Map<string, FakeBlock>()
  const caps = new Map<string, Cap>()
  const requests: FakeRequest[] = []
  const a2a: A2aSend[] = []
  const sessions: Array<{ dashboardId: string; agentId: string; id: string }> = []
  const sockets: Socket[] = []
  const state = {
    /** Drop every connection: the server is unreachable. */
    down: false,
    /** The next frame minted is refused by `/d/v/` with 404, as an expired cap is. */
    expireNextCap: false,
    /** What the next `data` answers for a new block: stale (nothing ran yet) or fresh. */
    newBlocksStale: false,
    /** The reply the A2A agent streams. */
    reply: 'Ledger here: Acme renewal is the biggest.'
  }
  let refreshGate: Promise<void> | null = null

  const agentById = (id: string): FakeAgent | undefined => agents.find((agent) => agent.id === id)
  const componentOf = (agentId: string, name: string): FakeComponent | undefined => agentById(agentId)?.components.find((c) => c.name === name)

  function corePublic(agent: FakeAgent, component: FakeComponent) {
    const placements = [...blocks.values()]
      .filter((block) => block.agentId === agent.id && block.config.component === component.name)
      .map((block) => ({ dashboard_id: block.dashboardId, dashboard_name: dashboards.get(block.dashboardId)?.name ?? '', block_id: block.id, origin: 'desktop' }))
    return {
      name: component.name,
      skill: null,
      title: component.component_json.title,
      view: component.component_json.view,
      component_json: component.component_json,
      findings: [],
      has_errors: false,
      size_bytes: JSON.stringify(component.component_json).length,
      placements
    }
  }

  function blockPublic(block: FakeBlock) {
    const at = new Date().toISOString()
    return {
      id: block.id,
      agent_id: block.agentId,
      view_type: 'agent_component',
      title: block.title,
      show_border: true,
      show_header: false,
      grid_x: 0,
      grid_y: 0,
      grid_w: 4,
      grid_h: 3,
      config: block.config,
      prompt_actions: [],
      created_at: at,
      updated_at: at
    }
  }

  function dashboardPublic(id: string) {
    const board = dashboards.get(id)!
    const at = new Date().toISOString()
    return {
      id,
      name: board.name,
      description: null,
      sort_order: 0,
      origin: board.origin,
      created_at: at,
      updated_at: at,
      blocks: [...blocks.values()].filter((block) => block.dashboardId === id).map(blockPublic)
    }
  }

  function tileData(block: FakeBlock) {
    const component = componentOf(block.agentId, block.config.component)
    return {
      data: block.data,
      stale: block.stale,
      fetched_at: block.fetchedAt,
      mark: null,
      mark_at: null,
      notice: null,
      params_resolved: resolveParams(component, block.config.params ?? {}),
      missing_credentials: [],
      skipped: null
    }
  }

  function recompute(block: FakeBlock): void {
    const component = componentOf(block.agentId, block.config.component)
    block.data = component ? component.compute(resolveParams(component, block.config.params ?? {})) : null
    block.stale = false
    block.fetchedAt = new Date().toISOString()
  }

  function mint(agentId: string, component: string, blockId: string | null) {
    const cap = randomUUID().replaceAll('-', '')
    caps.set(cap, { blockId, agentId, component, expired: state.expireNextCap })
    state.expireNextCap = false
    const entry = String(componentOf(agentId, component)?.component_json.entry ?? 'index.html')
    return { frame_url: `${host}/d/v/${cap}/${entry}`, expires_at: new Date(Date.now() + 12 * 3_600_000).toISOString() }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (state.down) {
      req.socket.destroy()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const raw = await readBody(req)
    let body: unknown = undefined
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      body = raw
    }
    requests.push({ method: req.method ?? 'GET', path: url.pathname, body })
    const send = (value: unknown, status = 200): void => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    }
    const coded = (status: number, code: string, message: string): void => {
      res.setHeader('cache-control', 'no-store')
      send({ error: { code, message } }, status)
    }
    const method = req.method ?? 'GET'
    const path = url.pathname

    // Frame content: no user auth; the cap is the credential.
    const file = /^\/d\/v\/([0-9a-f]{32})\/(.+)$/.exec(path)
    if (file) {
      const cap = caps.get(file[1])
      const component = cap ? componentOf(cap.agentId, cap.component) : undefined
      const text = component?.files?.[decodeURIComponent(file[2])]
      if (!cap || cap.expired || text === undefined || (method !== 'GET' && method !== 'HEAD')) {
        res.statusCode = 404
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('Not Found')
        return
      }
      const isHtml = file[2].endsWith('.html')
      const bytes = isHtml ? withBridge(text) : Buffer.from(text)
      res.statusCode = 200
      res.setHeader('content-type', isHtml ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8')
      // Core's own headers, which must not reach the page: its CSP only lets core's SPA frame it.
      res.setHeader('content-security-policy', `sandbox allow-scripts; default-src 'none'; script-src ${host}/d/v/${file[1]}/ 'unsafe-inline'; frame-ancestors https://core-spa.invalid`)
      res.setHeader('access-control-expose-headers', 'X-Core-Marker')
      res.setHeader('x-core-marker', 'from-core')
      res.end(method === 'HEAD' ? undefined : bytes)
      return
    }

    if (method === 'GET' && path === '/api/v1/external/agents') {
      send({
        targets: agents
          .filter((agent) => !agent.gone)
          .map((agent) => ({
            target_type: 'agent',
            target_id: agent.id,
            name: agent.name,
            description: `${agent.name} on the fake core.`,
            entrypoint_prompt: null,
            example_prompts: [],
            session_mode: null,
            ui_color_preset: null,
            agent_card_url: `${host}/api/v1/external/a2a/agent/${agent.id}/.well-known/agent-card.json`,
            protocol_versions: ['0.3.0'],
            metadata: agent.owned
              ? { bundle_id: `com.me.${agent.id.slice(0, 8)}`, bundle_uuid: null, is_publisher_install: false }
              : { bundle_id: 'com.partner.desk', bundle_uuid: randomUUID(), is_publisher_install: false }
          }))
      })
      return
    }

    const a2aRoute = /^\/api\/v1\/external\/a2a\/agent\/([0-9a-f-]{36})\/(\.well-known\/agent-card\.json)?$/.exec(path)
    if (a2aRoute) {
      const agent = agentById(a2aRoute[1])
      if (!agent) return send({ detail: 'Agent not found' }, 404)
      if (method === 'GET' && a2aRoute[2]) {
        send({
          name: agent.name,
          description: agent.name,
          url: `${host}/api/v1/external/a2a/agent/${agent.id}/`,
          protocolVersion: '0.3.0',
          version: '1.0.0',
          capabilities: { streaming: true },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: []
        })
        return
      }
      if (method === 'POST' && !a2aRoute[2]) {
        const rpc = body as { id: string | number; method: string; params?: { message?: A2aSend['message'] } }
        const message = rpc.params?.message ?? {}
        const text = (message.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text ?? '').join('')
        a2a.push({ agentId: agent.id, method: rpc.method, authorization: req.headers.authorization, message, text })
        const taskId = message.taskId ?? randomUUID()
        const result = {
          kind: 'status-update',
          taskId,
          contextId: message.contextId ?? `ctx-${taskId}`,
          final: true,
          status: { state: 'completed', message: { kind: 'message', messageId: randomUUID(), role: 'agent', parts: [{ kind: 'text', text: state.reply }] } }
        }
        if (rpc.method === 'message/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`)
        } else {
          send({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: taskId, contextId: result.contextId, status: result.status } })
        }
        return
      }
    }

    // An agent's components (owner-only, never wakes anything).
    const agentRoute = /^\/api\/v1\/agents\/([0-9a-f-]{36})\/dashboards\/(?:([a-z0-9-]+)(\/run|\/frame)?)?$/.exec(path)
    if (agentRoute) {
      const agent = agentById(agentRoute[1])
      if (!agent || agent.gone) return send({ detail: 'Agent not found' }, 404)
      if (!agent.owned) return send({ detail: 'Not enough permissions' }, 403)
      const [, , name, sub] = agentRoute
      if (!name && method === 'GET') return send({ components: agent.components.map((c) => corePublic(agent, c)) })
      const component = name ? agent.components.find((c) => c.name === name) : undefined
      if (!component) return coded(404, 'not_found', 'No such component.')
      if (!sub && method === 'GET') return send(corePublic(agent, component))
      if (sub === '/run' && method === 'POST') {
        const params = ((body as { params?: Record<string, unknown> })?.params ?? {}) as Record<string, unknown>
        const resolved = resolveParams(component, params)
        return send({ value: component.compute(resolved), fetched_at: new Date().toISOString(), notice: null, params_resolved: resolved })
      }
      if (sub === '/frame' && method === 'POST') return send(mint(agent.id, component.name, null))
    }

    if (path === '/api/v1/dashboards/' && method === 'POST') {
      const input = body as { name: string; origin?: string }
      const id = randomUUID()
      dashboards.set(id, { id, name: input.name, origin: input.origin ?? 'web', created: input })
      return send(dashboardPublic(id))
    }

    const chatRoute = /^\/api\/v1\/dashboards\/([0-9a-f-]{36})\/chat$/.exec(path)
    if (chatRoute && method === 'POST') {
      if (!dashboards.has(chatRoute[1])) return send({ detail: 'Dashboard not found' }, 404)
      const input = body as { agent_id: string; new?: boolean }
      let session = input.new ? undefined : sessions.find((s) => s.dashboardId === chatRoute[1] && s.agentId === input.agent_id)
      if (!session) {
        session = { dashboardId: chatRoute[1], agentId: input.agent_id, id: randomUUID() }
        sessions.push(session)
      }
      return send({ session: { id: session.id, agent_id: session.agentId, dashboard_id: session.dashboardId, title: null } })
    }

    const dashRoute = /^\/api\/v1\/dashboards\/([0-9a-f-]{36})(?:\/blocks(?:\/([0-9a-f-]{36})(\/component\/(data|refresh|params|call|frame|page-state))?)?)?$/.exec(path)
    if (dashRoute) {
      const [, dashboardId, blockId, , action] = dashRoute
      if (!dashboards.has(dashboardId)) return send({ detail: 'Dashboard not found' }, 404)
      const isBlocks = path.includes('/blocks')
      if (!isBlocks) {
        if (method === 'GET') return send(dashboardPublic(dashboardId))
        if (method === 'PUT') {
          dashboards.get(dashboardId)!.name = (body as { name: string }).name
          return send(dashboardPublic(dashboardId))
        }
        if (method === 'DELETE') {
          dashboards.delete(dashboardId)
          for (const [id, block] of blocks) if (block.dashboardId === dashboardId) blocks.delete(id)
          return send({ message: 'Dashboard deleted' })
        }
      }
      if (isBlocks && !blockId && method === 'POST') {
        const input = body as { agent_id: string; title: string | null; view_type: string; config: FakeBlock['config'] }
        if (input.view_type !== 'agent_component') return send({ detail: 'Unsupported view type' }, 422)
        const block: FakeBlock = {
          id: randomUUID(),
          dashboardId,
          agentId: input.agent_id,
          title: input.title,
          config: input.config,
          data: null,
          stale: true,
          fetchedAt: null,
          mode: 'ok',
          frameRefusal: null
        }
        // A block made here has a cached run already unless the test wants it stale.
        if (!state.newBlocksStale) recompute(block)
        blocks.set(block.id, block)
        return send(blockPublic(block))
      }
      const block = blockId ? blocks.get(blockId) : undefined
      if (!block || block.dashboardId !== dashboardId) return action ? coded(404, 'not_found', 'Block not found.') : send({ detail: 'Block not found' }, 404)
      if (!action) {
        if (method === 'PUT') {
          const input = body as { title?: string | null; config?: FakeBlock['config'] }
          if (input.title !== undefined) block.title = input.title
          if (input.config) block.config = input.config
          return send(blockPublic(block))
        }
        if (method === 'DELETE') {
          blocks.delete(block.id)
          return send({ message: 'Block deleted' })
        }
      }
      if (block.mode === 'not_found' || agentById(block.agentId)?.gone) return coded(404, 'not_found', 'Agent not found.')
      if (action === 'data' && method === 'GET') {
        if (block.mode === 'env_unavailable') return coded(503, 'env_unavailable', 'The environment is suspended.')
        return send(tileData(block))
      }
      if (action === 'refresh' && method === 'POST') {
        if (refreshGate) await refreshGate
        if (block.mode === 'env_unavailable') return coded(503, 'env_unavailable', 'The environment is suspended.')
        const reason = (body as { reason: string }).reason
        if (reason === 'interval') return send({ ...tileData(block), skipped: 'env_asleep' })
        recompute(block)
        return send(tileData(block))
      }
      if (action === 'params' && method === 'PUT') {
        block.config = { ...block.config, params: (body as { params: Record<string, unknown> }).params }
        recompute(block)
        return send(tileData(block))
      }
      if (action === 'call' && method === 'POST') {
        const input = body as { endpoint: string; params: Record<string, unknown> }
        return send({ value: { pong: input.params.n, endpoint: input.endpoint } })
      }
      if (action === 'frame' && method === 'POST') {
        if (block.frameRefusal === 'env_unavailable') return coded(503, 'env_unavailable', 'The environment is starting; try again in a moment.')
        return send(mint(block.agentId, block.config.component, block.id))
      }
      if (action === 'page-state' && method === 'PUT') {
        res.statusCode = 204
        res.end()
        return
      }
    }
    send({ detail: 'No fixture route for this request' }, 404)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })
  // While `down`, the transport itself is refused (as an unreachable server is), so the client's own reconnection keeps trying.
  const io = new IoServer(server, { path: '/ws', cors: { origin: '*' }, allowRequest: (_req, cb) => cb(state.down ? 'down' : null, !state.down) })
  const socketAuth: string[] = []
  const socketEvents = { connections: 0 }
  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown })?.token
    socketAuth.push(typeof token === 'string' ? token : '')
    if (state.down) return next(new Error('down'))
    if (token !== FAKE_CORE_TOKEN) return next(new Error('Unauthorized'))
    next()
  })
  io.on('connection', (socket) => {
    socketEvents.connections += 1
    sockets.push(socket)
    socket.on('disconnect', () => {
      const at = sockets.indexOf(socket)
      if (at >= 0) sockets.splice(at, 1)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    host,
    /** `127.0.0.1:<port>`: the server's name in the D6.10 sentences. */
    serverName: host.replace(/^http:\/\//, ''),
    agents,
    own: agents[0],
    shared: agents[1],
    dashboards,
    blocks,
    caps,
    requests,
    a2a,
    sessions,
    sockets,
    socketAuth,
    /** How many socket connections core accepted so far. */
    socketEvents,
    state,
    /** Requests matching `method` and a path pattern. */
    calls(method: string, pattern: RegExp): FakeRequest[] {
      return requests.filter((request) => request.method === method && pattern.test(request.path))
    },
    /** Hold every refresh until the returned function is called. */
    holdRefresh(): () => void {
      let release: () => void = () => {}
      refreshGate = new Promise<void>((resolve) => {
        release = () => {
          refreshGate = null
          resolve()
        }
      })
      return release
    },
    /** Core closes every socket (`io server disconnect`); with `down` set, reconnects are refused until it is cleared. */
    dropSockets(): void {
      io.disconnectSockets(true)
    },
    /** core's `event` to every connected socket (`room user_<owner>`). */
    emit(type: string, meta: Record<string, unknown>): void {
      for (const socket of sockets) socket.emit('event', { type, model_id: meta.block_id, meta })
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        io.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}

export type FakeCinnaCore = Awaited<ReturnType<typeof startFakeCore>>

// `npx tsx e2e/fixtures/fakeCinnaDashboards.ts [port]`: a fake core for a manual session.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 0) || 0
  void startFakeCore({ port }).then((core) => {
    console.log(`fake cinna-core at ${core.host}`)
    console.log(`token: ${FAKE_CORE_TOKEN}`)
    for (const agent of core.agents) console.log(`  ${agent.name} (${agent.owned ? 'own' : 'not owned'}) ${agent.id}`)
  })
}
