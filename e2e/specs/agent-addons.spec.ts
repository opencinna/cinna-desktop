import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL } from '../fixtures/scriptAcpEngine'

/**
 * A folder agent's Overview carries its prompts, and its Addons tab attaches
 * MCP connectors that every session of the agent then gets through the
 * desktop's own `cinna` MCP server.
 *
 * The connector is a real streamable-HTTP MCP server on loopback (the shape
 * `mcp-connection.spec.ts` uses), so "connected" is the app's own verdict and
 * a tool call that reaches it is the witness that the tools travelled. A
 * second connector points at a port that was bound and closed, which is how a
 * not-connected addon is arranged without guessing at a bad host.
 */

const AGENT = 'Ledger Clerk'
const CONNECTOR = 'Ledger MCP'
const BROKEN = 'Broken MCP'
const TOOL = 'ledger_lookup'
/** What only the loopback connector knows; never in any prompt. */
const MARKER = 'ledger-balance-7341'

async function mcpPeer() {
  const methods: string[] = []
  const calls: { name: string; arguments: unknown }[] = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(req.method === 'DELETE' ? 204 : 405); res.end(); return }
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      const rpc = JSON.parse(body) as { id?: string | number; method: string; params?: { name: string; arguments: unknown } }
      methods.push(rpc.method)
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
      const common = { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
      const result =
        rpc.method === 'server/discover'
          ? { ...common, supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
          : rpc.method === 'tools/list'
            ? { ...common, tools: [{ name: TOOL, description: 'Look up the ledger balance.', inputSchema: { type: 'object', properties: {} } }] }
            : rpc.method === 'tools/call'
              ? (calls.push({ name: rpc.params!.name, arguments: rpc.params!.arguments }),
                { resultType: 'complete', content: [{ type: 'text', text: MARKER }] })
              : {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    methods,
    calls,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  }
}

/** A loopback URL nothing listens on: bound, read, closed. */
async function closedUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}/mcp`
}

/** Agents tab → the agent's row → its Settings, on `tab`. */
async function openAgentTab(cinna: CinnaApp, tab: string): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
}

/** Footer user menu → Settings → MCP Providers. The menu item toggles, so only when not already there. */
async function openMcpSettings(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const nav = page.getByRole('button', { name: 'MCP Providers', exact: true })
  if (!(await nav.isVisible())) {
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  }
  await nav.click()
  await expect(page.getByRole('heading', { name: 'MCP Providers', exact: true })).toBeVisible()
}

/** Leave Settings for the chat shell (the user menu's Settings item toggles). */
async function leaveSettings(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'MCP Providers', exact: true })).toHaveCount(0)
}

test('a kit agent’s Overview shows its prompts as markdown, with author notes and Show all', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  await createFolderAgent(cinna, root, AGENT)
  await openAgentTab(cinna, 'Overview')
  const page = cinna.page
  const panel = page.getByRole('tabpanel')

  await test.step('there is no Prompts tab, and Addons sits after Overview', async () => {
    await expect(page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab')).toHaveText([
      'Overview', 'Addons', 'Credentials', 'Commands1', 'Schedules', 'Permissions', 'Folder2', 'Interface'
    ])
    await expect(page.getByRole('tab', { name: 'Prompts' })).toHaveCount(0)
  })

  await test.step('Overview holds the agent cards, then the three prompt cards', async () => {
    await expect(panel.locator('section > header > h2')).toHaveText([
      'Status', 'Description', 'Example prompts', 'Workflow prompt', 'Entrypoint prompt', 'Refiner prompt'
    ])
  })

  const workflow = panel.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Workflow prompt', exact: true }) })
  await test.step('the workflow prompt is rendered markdown, its scaffold comment an author note', async () => {
    const note = workflow.getByRole('note', { name: 'Author note' }).first()
    await expect(note).toContainText("This is the agent's conversation-mode system prompt")
    await expect(workflow.getByText(`You are ${AGENT}.`, { exact: true })).toBeVisible()
    await expect(workflow.getByRole('heading', { name: 'What you do', exact: true })).toBeVisible()
    // Rendered, not raw: neither the comment markers nor the heading hashes show.
    await expect(workflow).not.toContainText('<!--')
    await expect(workflow).not.toContainText('## What you do')
  })

  await test.step('a long prompt is clipped, and Show all / Show less toggle it', async () => {
    const body = workflow.locator('.markdown-body')
    const clipped = (): Promise<boolean> => body.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
    const toggle = workflow.getByRole('button', { name: 'Show all of Workflow prompt', exact: true })
    await expect(toggle).toHaveText('Show all')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(clipped).toBe(true)
    await toggle.click()
    const collapse = workflow.getByRole('button', { name: 'Collapse Workflow prompt', exact: true })
    await expect(collapse).toHaveText('Show less')
    await expect(collapse).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(clipped).toBe(false)
    await expect(workflow.getByText('Never print, echo or log a credential value.', { exact: true })).toBeVisible()
    await collapse.click()
    await expect(workflow.getByRole('button', { name: 'Show all of Workflow prompt', exact: true })).toHaveText('Show all')
    await expect.poll(clipped).toBe(true)
  })

  await test.step('a short prompt has nothing to show all of', async () => {
    const entry = panel.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Entrypoint prompt', exact: true }) })
    await expect(entry.getByText("Run today's check and report what needs attention.", { exact: true })).toBeVisible()
    await expect(entry.getByRole('note', { name: 'Author note' })).toContainText('A short, human-like first message')
    await expect(entry.getByRole('button', { name: /Show all/ })).toHaveCount(0)
  })
})

test('Addons attaches an existing connector and a new one, detaches, and a Settings delete names the agent', async ({ cinna }) => {
  const peer = await mcpPeer()
  const broken = await closedUrl()
  try {
    await cinna.skipOnboarding()
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT)
    const connectorId = await cinna.page.evaluate(
      (url) => window.api.mcp.upsert({ name: 'Ledger MCP', transportType: 'streamable-http', url, enabled: true }),
      peer.url
    ).then((r) => r.id)
    await expect.poll(async () => (await cinna.page.evaluate(() => window.api.mcp.list())).find((p) => p.id === connectorId)?.status).toBe('connected')

    const page = cinna.page
    const panel = page.getByRole('tabpanel')
    const addonsTab = page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ })
    const dialog = page.getByRole('dialog', { name: 'Attach MCP connector' })

    await test.step('a new agent has no connectors', async () => {
      await openAgentTab(cinna, 'Addons')
      await expect(addonsTab).toHaveText('Addons')
      await expect(panel.getByText('No connectors attached.', { exact: true })).toBeVisible()
    })

    await test.step('attach an existing connector: the card turns Attached, and the row appears on close', async () => {
      await panel.getByRole('button', { name: 'Attach', exact: true }).click()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: `Attach ${CONNECTOR}`, exact: true }).click()
      const attached = dialog.getByRole('button', { name: `${CONNECTOR} attached`, exact: true })
      await expect(attached).toHaveText('Attached')
      await expect(attached).toBeDisabled()
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(panel.getByRole('button', { name: `Detach ${CONNECTOR} from this agent`, exact: true })).toBeVisible()
      await expect(panel.getByText('No connectors attached.', { exact: true })).toHaveCount(0)
      await expect(addonsTab).toHaveText('Addons1')
      await expect(addonsTab.locator('span[title]')).toHaveAttribute('title', '1 connector')
      expect(await page.evaluate((id) => window.api.localAgents.listMcpProviders(id), agent.id)).toEqual([connectorId])
    })

    await test.step('create a new connector inside the dialog: attached, dialog closed, badge warns', async () => {
      await panel.getByRole('button', { name: 'Attach', exact: true }).click()
      await dialog.getByRole('button', { name: 'Custom MCP', exact: true }).click()
      await dialog.getByPlaceholder('e.g., My MCP Server').fill(BROKEN)
      await dialog.getByPlaceholder('https://mcp.example.com').fill(broken)
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(panel.getByRole('button', { name: `Detach ${BROKEN} from this agent`, exact: true })).toBeVisible()
      await expect(addonsTab).toHaveText('Addons2')
      await expect(addonsTab.locator('span[title]')).toHaveAttribute('title', '1 of 2 connectors needs attention')
    })

    await test.step('detach removes it from the agent only', async () => {
      await panel.getByRole('button', { name: `Detach ${BROKEN} from this agent`, exact: true }).click()
      await expect(panel.getByRole('button', { name: `Detach ${BROKEN} from this agent`, exact: true })).toHaveCount(0)
      await expect(addonsTab).toHaveText('Addons1')
      await expect(addonsTab.locator('span[title]')).toHaveAttribute('title', '1 connector')
      const names = (await page.evaluate(() => window.api.mcp.list())).map((p) => p.name).sort()
      expect(names).toEqual([BROKEN, CONNECTOR])
    })

    await test.step('Settings → MCP lists both; deleting the attached one names the agent', async () => {
      await openMcpSettings(cinna)
      await expect(page.getByText(BROKEN, { exact: true })).toBeVisible()
      await expect(page.getByText(CONNECTOR, { exact: true })).toBeVisible()

      await page.getByRole('button', { name: `Delete MCP ${BROKEN}`, exact: true }).click()
      const confirmBroken = page.getByRole('dialog', { name: 'Delete MCP connector' })
      await expect(confirmBroken).toContainText(`Delete ${BROKEN}?`)
      await expect(confirmBroken).not.toContainText('Used by')
      await confirmBroken.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(confirmBroken).toBeHidden()

      await page.getByRole('button', { name: `Delete MCP ${CONNECTOR}`, exact: true }).click()
      const confirm = page.getByRole('dialog', { name: 'Delete MCP connector' })
      await expect(confirm.getByText(/^Used by /)).toHaveText(`Used by ${AGENT} — it will be removed from it.`)
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(confirm).toBeHidden()
      await expect(page.getByText(CONNECTOR, { exact: true })).toHaveCount(0)
      await expect(page.getByText(BROKEN, { exact: true })).toBeVisible()
    })

    await test.step('the agent’s Addons tab is empty again', async () => {
      await leaveSettings(cinna)
      await openAgentTab(cinna, 'Addons')
      await expect(panel.getByText('No connectors attached.', { exact: true })).toBeVisible()
      await expect(addonsTab).toHaveText('Addons')
      expect(await page.evaluate((id) => window.api.localAgents.listMcpProviders(id), agent.id)).toEqual([])
    })
  } finally { await peer.close() }
})

test('a chat with the agent gets its attached connector’s tools through the cinna MCP server', async ({ cinna }) => {
  test.setTimeout(120_000)
  const peer = await mcpPeer()
  const fake = await scriptAcpEngine()
  try {
    await cinna.skipOnboarding()
    await fake.install(cinna)
    await cinna.page.evaluate(async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Addon fixture', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
    }, { host: fake.host, model: SCRIPT_MODEL })
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT)
    await cinna.page.evaluate(async ({ url, agentId }) => {
      const { id } = await window.api.mcp.upsert({ name: 'Ledger MCP', transportType: 'streamable-http', url, enabled: true })
      await window.api.localAgents.attachMcpProvider(agentId, id)
    }, { url: peer.url, agentId: agent.id })
    const chatId = await cinna.page.evaluate(async (agentId) => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { agentId, router: 'direct', title: 'Ledger check' })
      return chat.id
    }, agent.id)
    await cinna.page.evaluate((chatId) => window.api.run.start({ chatId, content: 'What is the ledger balance?' }), chatId)

    await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(1)
    // An empty tool list still makes the fake connect to `cinna` and list what it offers.
    fake.calls[0].release({ tools: [] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(1)
    const offered = fake.tools[0].params.offered as string[]
    expect(offered).toContain(TOOL)

    fake.tools[0].release({ tools: [{ name: TOOL, args: {} }] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(2)
    expect(peer.calls).toEqual([{ name: TOOL, arguments: {} }])
    const results = fake.tools[1].params.results as { result: { content: { type: string; text?: string }[] } }[]
    expect(JSON.stringify(results[0].result.content)).toContain(MARKER)
    fake.tools[1].release({ text: 'The ledger balance is known.' })

    // The control: the same connector, connected, but not attached to this
    // agent — its session is offered the Cinna tools and not the connector's.
    const plain = await createFolderAgent(cinna, root, 'Plain Clerk')
    const plainChat = await cinna.page.evaluate(async (agentId) => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { agentId, router: 'direct', title: 'Plain check' })
      return chat.id
    }, plain.id)
    await cinna.page.evaluate((chatId) => window.api.run.start({ chatId, content: 'What is the ledger balance?' }), plainChat)
    await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(2)
    fake.calls[1].release({ tools: [] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(3)
    expect(fake.tools[2].params.offered as string[]).not.toContain(TOOL)
    fake.tools[2].release({ text: 'No ledger here.' })
    expect(peer.calls).toHaveLength(1)
    expect(fake.unexpected).toEqual([])
  } finally {
    await fake.close()
    await peer.close()
  }
})
