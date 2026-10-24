import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { test, expect } from '../fixtures/app'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL } from '../fixtures/scriptAcpEngine'

/**
 * A marketplace plugin on a kit agent, against a fake cinna-core and the
 * scripted engine: Add pins the plugin's snapshot, unpacks it into the
 * read-only cache and turns its stdio MCP server into a managed connector
 * attached to the agent ("Needs settings filled in" until its token is
 * given); the connector refuses edits to what the plugin owns; the token
 * reaches the server through `${LEDGER_TOKEN}`; a chat with the agent is
 * offered the server's tool through Cinna's `cinna` MCP server and calls it;
 * OpenCode's config carries the plugin's command and skill; Remove takes the
 * pin and the connector away.
 *
 * ## What is real and what is not
 *
 * Real: main's `marketplacePluginService` (discover, batch lookup, both digest
 * checks, the plugin archive reader, the cache), the managed provider, the
 * login-shell Node.js probe, the MCP manager spawning the plugin's server with
 * `node`, the conductor bridge, the OpenCode config the launcher writes.
 * Faked: cinna-core (a loopback server for discovery, `/llm-plugins/discover`,
 * the batch lookup and `/plugins/{id}/archive`, with a tar.gz it builds), and
 * the engine (`scriptAcpAgent.mjs` behind the OpenCode launcher). No model.
 *
 * ## What it does not prove
 *
 * That a real engine runs the plugin's command or skill, Claude's wrapper
 * plugin, hooks, the managed uv for a Python server (unit-tested in
 * `pluginMcpProviders.test.ts` / `stdioRuntimes.test.ts`), or the renderer's
 * plugin rows, which a later change builds.
 */

const AGENT = 'Ledger Clerk'
const PLUGIN = 'ledger-tools'
const SERVER = 'ledger'
const TOOL = 'ledger_balance'
const MARKER = 'ledger-balance-7341'
const TOKEN = 'tok-ledger-42'
const MARKETPLACE = { id: randomUUID(), name: 'Acme Plugins' }

/* ------------------------------------------------------------- archives */

function tarHeader(path: string, type: '0' | '5', size: number, mode: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(path, 0, 100, 'utf8')
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/** A plugin archive as core serves it: every member under `<plugin-name>/`. */
function pluginArchive(name: string, files: Record<string, { text: string; mode?: number }>): Buffer {
  const blocks: Buffer[] = [tarHeader(`${name}/`, '5', 0, 0o755)]
  for (const [path, file] of Object.entries(files)) {
    const data = Buffer.from(file.text, 'utf8')
    blocks.push(tarHeader(`${name}/${path}`, '0', data.length, file.mode ?? 0o644), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/**
 * A stdio MCP server with no dependencies: newline-delimited JSON-RPC, one
 * tool whose answer carries the marker and the token it was started with.
 */
const SERVER_MJS = `
import { createInterface } from 'node:readline'
const common = { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const rpc = JSON.parse(line)
  if (rpc.id === undefined) return
  if (rpc.method === 'initialize') return reply(rpc.id, { protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: '${SERVER}', version: '1.0.0' } })
  if (rpc.method === 'server/discover') return reply(rpc.id, { ...common, supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: '${SERVER}', version: '1.0.0' } })
  if (rpc.method === 'tools/list') return reply(rpc.id, { ...common, tools: [{ name: '${TOOL}', description: 'The ledger balance.', inputSchema: { type: 'object', properties: {} } }] })
  if (rpc.method === 'tools/call') return reply(rpc.id, { resultType: 'complete', content: [{ type: 'text', text: '${MARKER} token=' + (process.env.LEDGER_TOKEN ?? '') + ' ' + (process.argv.find((arg) => arg.startsWith('--label=')) ?? '') }] })
  reply(rpc.id, {})
})
`

function ledgerPlugin(): Buffer {
  return pluginArchive(PLUGIN, {
    '.claude-plugin/plugin.json': { text: JSON.stringify({ name: PLUGIN, version: '1.0.0', description: 'Ledger lookups.' }) },
    '.mcp.json': {
      text: JSON.stringify({ mcpServers: { [SERVER]: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs', '--label=${LEDGER_TOKEN}'], env: { LEDGER_TOKEN: '${LEDGER_TOKEN}' } } } })
    },
    'server.mjs': { text: SERVER_MJS, mode: 0o755 },
    'commands/balance.md': { text: '---\ndescription: Look up a balance\n---\nLook up the balance of $ARGUMENTS\n' },
    'skills/ledger-howto/SKILL.md': { text: '---\nname: ledger-howto\ndescription: How to read the ledger.\n---\n\n# Ledger\n' }
  })
}

/* ------------------------------------------------------------ fake core */

async function fakeCore(archive: Buffer) {
  const id = randomUUID()
  let host = ''
  const requests: string[] = []
  const row = {
    id,
    marketplace_id: MARKETPLACE.id,
    marketplace_name: MARKETPLACE.name,
    marketplace_owner: 'Acme Labs',
    name: PLUGIN,
    description: 'Ledger lookups for the books.',
    version: '1.0.0',
    plugin_type: 'claude',
    supported: true,
    unsupported_reason: null,
    commit_hash: 'abc123',
    archive_sha256: sha256(archive),
    archive_size: archive.length,
    snapshot_status: 'ready',
    snapshot_reason: null,
    runs_code: true,
    components: {
      skills: [{ name: 'ledger-howto', has_scripts: false }],
      commands: ['balance'],
      agents: [],
      hooks: null,
      mcp_servers: [{ name: SERVER, transport: 'stdio', runtime: 'node', auth: 'env', env: [{ name: 'LEDGER_TOKEN', secret: true }] }],
      lsp_servers: []
    }
  }
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    const send = (value: unknown, status = 200): void => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/cinna-desktop') {
      return send({ authorization_endpoint: `${host}/oauth/authorize`, token_endpoint: `${host}/oauth/token`, userinfo_endpoint: `${host}/oauth/userinfo`, instance_name: 'Acme Labs' })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/llm-plugins/discover') {
      const rows = url.searchParams.get('plugin_type') === 'claude' ? [row] : []
      return send({ data: rows, count: rows.length })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/llm-plugins/plugins') {
      const ids = (url.searchParams.get('ids') ?? '').split(',')
      const data = ids.includes(id) ? [row] : []
      return send({ data, count: data.length })
    }
    if (req.method === 'GET' && url.pathname === `/api/v1/llm-plugins/plugins/${id}/archive`) {
      if (url.searchParams.get('sha256') !== sha256(archive)) return send({ detail: { code: 'snapshot_missing' } }, 404)
      res.statusCode = 200
      res.setHeader('content-type', 'application/gzip')
      res.setHeader('x-archive-sha256', sha256(archive))
      res.end(archive)
      return
    }
    send({ detail: 'No fixture route for this request' }, 404)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    id,
    host,
    requests,
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

const agentKey = (agentId: string): string => createHash('sha256').update(agentId).digest('hex').slice(0, 16)

/* ---------------------------------------------------------------- test */

test('a marketplace plugin’s stdio MCP server reaches the agent’s turn as a managed connector', async ({ cinna }) => {
  test.setTimeout(240_000)
  const archive = ledgerPlugin()
  const core = await fakeCore(archive)
  const fake = await scriptAcpEngine()
  try {
    await cinna.skipOnboarding()
    await fake.install(cinna)
    await cinna.page.evaluate(async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Plugin fixture', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
    }, { host: fake.host, model: SCRIPT_MODEL })
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT, 'Answers ledger questions.')
    await linkSandboxAccount(cinna, core.host)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    const page = cinna.page
    const ref = { source: 'core-marketplace-plugin', id: core.id }
    const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(agent.path, 'cinna-agent.json'), 'utf8'))

    await test.step('the directory lists the plugin with its parts, addable on this computer', async () => {
      const listed = await page.evaluate((agentId) => window.api.addons.directory(agentId, { refresh: true }), agent.id)
      expect(listed.ok).toBe(true)
      const plugin = listed.ok ? listed.entries.find((e) => e.ref.source === ref.source && e.ref.id === ref.id) : undefined
      expect(plugin).toMatchObject({ kind: 'plugin', name: PLUGIN, state: 'addable', runsCode: true, components: { commands: ['balance'] } })
      expect(core.requests).toContain('GET /api/v1/llm-plugins/discover?plugin_type=claude&skip=0&limit=100')
    })

    let providerId = ''
    await test.step('Add pins the snapshot, caches it, and makes a managed connector that needs its token', async () => {
      expect(await page.evaluate(({ agentId, ref }) => window.api.addons.add(agentId, ref), { agentId: agent.id, ref })).toEqual({ ok: true, next: 'env' })
      expect(manifest().marketplace_plugins).toEqual([
        { entry_uuid: core.id, marketplace_uuid: MARKETPLACE.id, marketplace_name: MARKETPLACE.name, name: PLUGIN, archive_sha256: sha256(archive), version: '1.0.0', commit_hash: 'abc123' }
      ])
      const cached = join(cinna.sandbox.userData, 'marketplace-plugins')
      expect(existsSync(cached)).toBe(true)
      const providers = await page.evaluate(() => window.api.mcp.list())
      const managed = providers.filter((p) => p.managedBy === `plugin:${core.id}@${sha256(archive)}`)
      expect(managed).toHaveLength(1)
      // The renderer sees the name to fill in and whether it has a value — never a value.
      expect(managed[0]).toMatchObject({ name: SERVER, transportType: 'stdio', command: 'node', env: { LEDGER_TOKEN: '' }, envSlots: [{ name: 'LEDGER_TOKEN', hasValue: false }] })
      expect(managed[0].args?.[0]).toMatch(/marketplace-plugins\/.+\/ledger-tools\/server\.mjs$/)
      providerId = managed[0].id
      expect(await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)).toEqual([providerId])
      const status = await page.evaluate((agentId) => window.api.addons.pluginStatus(agentId), agent.id)
      expect(status.ok && status.plugins[0].mcpServers).toEqual([
        { name: SERVER, transport: 'stdio', disabled: false, mcpProviderId: providerId, setup: 'env', missingEnv: ['LEDGER_TOKEN'] }
      ])
    })

    await test.step('only the token is the user’s to change', async () => {
      const managed = (await page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)!
      const base = { id: providerId, name: managed.name, transportType: managed.transportType, command: managed.command, args: managed.args }
      // Refusals arrive as data: a thrown code would not survive IPC.
      const refused = await page.evaluate((input) => window.api.mcp.upsert(input), { ...base, command: 'python3', env: { LEDGER_TOKEN: '' } })
      expect(refused).toMatchObject({ success: false, ok: false, code: 'managed' })
      expect(refused.message).toContain('comes with a plugin')
      expect(await page.evaluate((id) => window.api.mcp.delete(id), providerId)).toMatchObject({ success: false, ok: false, code: 'managed' })
      expect(await page.evaluate((input) => window.api.mcp.upsert(input), { ...base, env: { LEDGER_TOKEN: TOKEN }, enabled: true })).toMatchObject({ success: true })
      const status = await page.evaluate((agentId) => window.api.addons.pluginStatus(agentId), agent.id)
      expect(status.ok && status.plugins[0].mcpServers[0]).toEqual({ name: SERVER, transport: 'stdio', disabled: false, mcpProviderId: providerId })
      const listed = (await page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)!
      expect(listed.envSlots).toEqual([{ name: 'LEDGER_TOKEN', hasValue: true }])
      expect(JSON.stringify(listed)).not.toContain(TOKEN)
    })

    await test.step('a chat with the agent is offered the server’s tool, and calling it reaches the server with the token', async () => {
      const chatId = await page.evaluate(async (agentId) => {
        const chat = await window.api.chat.create()
        await window.api.chat.update(chat.id, { agentId, router: 'direct', title: 'Ledger check' })
        return chat.id
      }, agent.id)
      await page.evaluate((chatId) => window.api.run.start({ chatId, content: 'What is the ledger balance?' }), chatId)
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(1)
      fake.calls[0].release({ tools: [] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(1)
      expect(fake.tools[0].params.offered as string[]).toContain(TOOL)
      fake.tools[0].release({ tools: [{ name: TOOL, args: {} }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(2)
      const results = fake.tools[1].params.results as { result: { content: { type: string; text?: string }[] } }[]
      // The token reached the server as its env value and, through `${LEDGER_TOKEN}`, in its args.
      expect(JSON.stringify(results[0].result.content)).toContain(`${MARKER} token=${TOKEN} --label=${TOKEN}`)
      fake.tools[1].release({ text: 'The ledger balance is known.' })
    })

    await test.step('OpenCode’s config carries the plugin’s command and its skill', async () => {
      const file = join(cinna.sandbox.userData, 'acp', 'opencode', agentKey(agent.id), 'opencode.json')
      await expect.poll(() => existsSync(file)).toBe(true)
      const config = JSON.parse(readFileSync(file, 'utf8'))
      // Under the agent's own key and bound to it: the config is shared by every agent.
      const name = Object.keys(config.command).find((key) => key.endsWith(`/${PLUGIN}:balance`))!
      const owner = name.slice(0, name.indexOf('/'))
      expect(config.agent[owner]).toBeTruthy()
      expect(config.command[name]).toMatchObject({ template: 'Look up the balance of $ARGUMENTS\n', description: 'Look up a balance', agent: owner })
      const links = join(config.skills.paths.find((path: string) => path.includes('cinna-plugins')), 'ledger-howto', 'SKILL.md')
      expect(readFileSync(links, 'utf8')).toContain('How to read the ledger.')
    })

    await test.step('Remove drops the pin and the plugin’s connector', async () => {
      expect(await page.evaluate(({ agentId, ref }) => window.api.addons.remove(agentId, ref), { agentId: agent.id, ref })).toEqual({ ok: true, next: null })
      expect(manifest().marketplace_plugins).toEqual([])
      expect((await page.evaluate(() => window.api.mcp.list())).some((p) => p.id === providerId)).toBe(false)
      expect(await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)).toEqual([])
    })
    expect(fake.unexpected).toEqual([])
  } finally {
    await fake.close()
    await core.close()
  }
})
