import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

/**
 * A fake cinna-core for the bare-Mac addon specs, served on the host's
 * loopback and reached from the guest through `vm.reverseForward`.
 *
 * It answers what the desktop asks when a profile adds a marketplace plugin:
 * the unified `/api/v1/addons/directory` (with a policy that allows local
 * servers), the batch lookup `/api/v1/llm-plugins/plugins?ids=`, the old
 * `/discover` read, and each plugin's `/archive` with its `X-Archive-Sha256`.
 * The archives are real tar.gz files built here, with every member under
 * `<plugin-name>/`, as core serves them. The directory also lists entries of
 * core's MCP directory (`core-mcp-directory`), each a published package with
 * the connect descriptor core sends in `install.mcp`.
 */

export interface FakePlugin {
  name: string
  description: string
  files: Record<string, { text: string; mode?: number }>
  /** One per server in its `.mcp.json`, as core describes it in `components.mcp_servers`. */
  servers: Array<{ name: string; runtime: 'node' | 'python' | 'docker' }>
}

/** An entry of core's MCP directory: a local server run from a published package. */
export interface FakeConnector {
  name: string
  title: string
  description: string
  package: { registry: 'npm' | 'pypi' | 'oci'; name: string; version: string }
}

export interface AddonCore {
  /** Host port the server listens on (loopback). */
  port: number
  /** Entry id of each plugin and connector, by name. */
  ids: Record<string, string>
  /** Every request, `METHOD /path?query`. */
  requests: string[]
  close(): Promise<void>
}

const MARKETPLACE = { id: randomUUID(), name: 'Acme Plugins', owner: 'Acme Labs' }

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

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
export function pluginArchive(name: string, files: FakePlugin['files']): Buffer {
  const blocks: Buffer[] = [tarHeader(`${name}/`, '5', 0, 0o755)]
  for (const [path, file] of Object.entries(files)) {
    const data = Buffer.from(file.text, 'utf8')
    blocks.push(tarHeader(`${name}/${path}`, '0', data.length, file.mode ?? 0o644), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** `origin`: where the app reaches this server (the guest end of the forward), for discovery's endpoints. */
export async function startAddonCore(plugins: readonly FakePlugin[], origin: string, connectors: readonly FakeConnector[] = []): Promise<AddonCore> {
  const requests: string[] = []
  const built = plugins.map((plugin) => {
    const archive = pluginArchive(plugin.name, plugin.files)
    return { plugin, id: randomUUID(), archive, sha: sha256(archive) }
  })
  const components = (plugin: FakePlugin) => ({
    skills: [],
    commands: [],
    agents: [],
    hooks: null,
    mcp_servers: plugin.servers.map((s) => ({ name: s.name, transport: 'stdio', runtime: s.runtime, auth: 'none', env: [] })),
    lsp_servers: []
  })
  const archivePath = (b: (typeof built)[number]): string => `/api/v1/llm-plugins/plugins/${b.id}/archive?sha256=${b.sha}`
  // The batch lookup's and /discover's row.
  const lookupRow = (b: (typeof built)[number]) => ({
    id: b.id,
    marketplace_id: MARKETPLACE.id,
    marketplace_name: MARKETPLACE.name,
    marketplace_owner: MARKETPLACE.owner,
    name: b.plugin.name,
    description: b.plugin.description,
    version: '1.0.0',
    plugin_type: 'claude',
    supported: true,
    unsupported_reason: null,
    commit_hash: 'abc123',
    archive_sha256: b.sha,
    archive_size: b.archive.length,
    snapshot_status: 'ready',
    snapshot_reason: null,
    runs_code: true,
    components: components(b.plugin)
  })
  // The unified index's row.
  const directoryRow = (b: (typeof built)[number]) => ({
    ref: { source: 'core-marketplace', id: b.id },
    kind: 'plugin',
    name: b.plugin.name,
    title: b.plugin.name,
    summary: b.plugin.description,
    description: b.plugin.description,
    category: null,
    tags: [],
    icon_url: null,
    publisher: { name: MARKETPLACE.owner, verified: false },
    origin: { label: MARKETPLACE.name, kind: 'marketplace', repository_url: null, homepage: null },
    version: '1.0.0',
    digest: `sha256:${b.sha}`,
    components: components(b.plugin),
    runs_code: true,
    status: 'ready',
    install: { archive_path: archivePath(b) }
  })

  const connectorRows = connectors.map((connector) => ({ connector, id: randomUUID() }))
  // A row of core's MCP directory, as `/addons/directory` lists it.
  const connectorRow = ({ connector, id }: (typeof connectorRows)[number]) => ({
    ref: { source: 'core-mcp-directory', id },
    kind: 'mcp',
    name: connector.name,
    title: connector.title,
    summary: connector.description,
    description: connector.description,
    category: null,
    tags: [],
    icon_url: null,
    publisher: null,
    origin: { label: 'Cinna MCP directory', kind: 'directory', repository_url: null, homepage: null },
    version: connector.package.version,
    digest: null,
    runs_code: true,
    status: 'ready',
    install: { mcp: { transport: 'stdio', auth: 'none', package: connector.package, env: [] } }
  })

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    const send = (value: unknown, status = 200): void => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    }
    if (req.method !== 'GET') return send({ detail: 'No fixture route for this request' }, 404)
    if (url.pathname === '/.well-known/cinna-desktop') {
      return send({ authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, userinfo_endpoint: `${origin}/oauth/userinfo`, instance_name: 'Acme Labs' })
    }
    if (url.pathname === '/api/v1/addons/directory') {
      return send({
        data: [...built.map(directoryRow), ...connectorRows.map(connectorRow)],
        policy: { external_directories: true, custom_mcp: true, plugin_hooks: true, stdio_mcp: true },
        etag: '"bare-mac-1"'
      })
    }
    if (url.pathname === '/api/v1/llm-plugins/discover') {
      const rows = url.searchParams.get('plugin_type') === 'claude' ? built.map(lookupRow) : []
      return send({ data: rows, count: rows.length })
    }
    if (url.pathname === '/api/v1/llm-plugins/plugins') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map((id) => id.trim().toLowerCase())
      const data = built.filter((b) => ids.includes(b.id)).map(lookupRow)
      return send({ data, count: data.length })
    }
    for (const b of built) {
      if (url.pathname !== `/api/v1/llm-plugins/plugins/${b.id}/archive`) continue
      if (url.searchParams.get('sha256') !== b.sha) return send({ detail: { code: 'snapshot_missing' } }, 404)
      res.statusCode = 200
      res.setHeader('content-type', 'application/gzip')
      res.setHeader('x-archive-sha256', b.sha)
      res.end(b.archive)
      return
    }
    send({ detail: 'No fixture route for this request' }, 404)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    port,
    ids: Object.fromEntries([...built.map((b) => [b.plugin.name, b.id]), ...connectorRows.map((c) => [c.connector.name, c.id])]),
    requests,
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
