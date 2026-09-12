import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '../fixtures/app'

const NAME = 'Local MCP connection'
const TOKEN = 'local-e2e-synthetic-token'
const ERROR = 'The local MCP test server is temporarily unavailable.'

async function peer() {
  let holding = true
  let held: { res: ServerResponse; rpc: { id?: string | number; method: string } }[] = []
  const methods: string[] = []
  let authorized = true
  function reply(res: ServerResponse, rpc: { id?: string | number; method: string }, fail = false) {
    if (fail) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end(ERROR); return }
    if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
    const result = rpc.method === 'server/discover'
      ? { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' }
      : rpc.method === 'tools/list'
        ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [{ name: 'fixture_echo', description: 'A local verification tool.', inputSchema: { type: 'object', properties: {} } }] }
        : {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  }
  const server = createServer((req, res) => {
    authorized &&= req.headers.authorization === `Bearer ${TOKEN}`
    if (req.method !== 'POST') { res.writeHead(req.method === 'DELETE' ? 204 : 405); res.end(); return }
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      const rpc = JSON.parse(body) as { id?: string | number; method: string }
      methods.push(rpc.method)
      if (holding && rpc.method === 'server/discover') held.push({ res, rpc })
      else reply(res, rpc)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, methods,
    get heldCount() { return held.length }, get authorized() { return authorized },
    hold() { holding = true }, release(fail: boolean) { holding = false; for (const item of held) reply(item.res, item.rpc, fail); held = [] },
    async close() { for (const item of held) item.res.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
}

test('MCP HTTP refusal preserves one provider and reconnects with modern tools; legacy SSE stays selectable', async ({ cinna }) => {
  const remote = await peer()
  try {
    await cinna.skipOnboarding()
    // Seed the disabled transport choice before Settings first reads its provider query.
    // It never spawns a process or connects to a server.
    await cinna.page.evaluate(() => window.api.mcp.upsert({ name: 'Legacy transport choice',
      transportType: 'stdio', command: '/not-launched', enabled: false }))
    const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
    await cinna.page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'MCP Providers', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: 'MCP Providers', exact: true })).toBeVisible()
    await cinna.page.getByRole('button', { name: 'Add Custom MCP', exact: true }).click()
    const form = cinna.page.getByText('Add Custom MCP Server', { exact: true }).locator('..')
    await form.getByPlaceholder('e.g., My MCP Server').fill(NAME)
    await form.getByPlaceholder('https://mcp.example.com').fill(remote.url)
    await form.getByRole('button', { name: 'Bearer Token', exact: true }).click()
    await form.getByPlaceholder("Paste the server's access token").fill(TOKEN)
    await form.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect.poll(() => remote.heldCount).toBe(1)
    await expect(form.getByRole('button', { name: 'Connecting...', exact: true })).toBeDisabled()
    remote.release(true)
    await expect(cinna.page.getByText(NAME, { exact: true })).toBeVisible()
    await cinna.page.getByText(NAME, { exact: true }).click()
    const card = cinna.page.getByText(NAME, { exact: true }).locator('../..')
    await expect(card.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
    await expect(card.getByText(/503|temporarily unavailable/)).toBeVisible()
    const failed = (await cinna.page.evaluate(() => window.api.mcp.list())).filter(p => p.name === NAME)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ transportType: 'streamable-http', url: remote.url, authType: 'bearer', status: 'error' })
    expect(remote.methods).toEqual(['server/discover'])
    remote.hold()
    await card.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect.poll(() => remote.heldCount).toBe(1)
    await expect(card.getByRole('button', { name: 'Connecting...', exact: true })).toBeDisabled()
    remote.release(false)
    await expect(card.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
    await expect(card.getByText('fixture_echo', { exact: true })).toBeVisible()
    const connected = (await cinna.page.evaluate(() => window.api.mcp.list())).filter(p => p.name === NAME)
    expect(connected).toHaveLength(1)
    expect(connected[0]).toMatchObject({ id: failed[0].id, status: 'connected', transportType: 'streamable-http', url: remote.url })
    expect(remote.methods).toEqual(['server/discover', 'server/discover', 'tools/list'])

    await cinna.page.getByText('Legacy transport choice', { exact: true }).click()
    const legacy = cinna.page.getByText('Legacy transport choice', { exact: true }).locator('../..')
    const transport = legacy.getByRole('combobox')
    await expect(transport.locator('option')).toHaveText(['stdio', 'SSE (deprecated)', 'Streamable HTTP'])
    await transport.selectOption('sse')
    await legacy.getByPlaceholder('https://mcp.example.com').fill(remote.url)
    await legacy.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await cinna.page.evaluate(() => window.api.mcp.list()))
      .find(p => p.name === 'Legacy transport choice')?.transportType).toBe('sse')
    expect((await cinna.page.evaluate(() => window.api.mcp.list()))
      .find(p => p.name === 'Legacy transport choice')?.enabled).toBe(false)
    expect(remote.methods).toEqual(['server/discover', 'server/discover', 'tools/list'])
    expect(remote.authorized).toBe(true)
  } finally { await remote.close() }
})
