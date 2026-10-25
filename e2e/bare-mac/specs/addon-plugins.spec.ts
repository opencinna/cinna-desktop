import { arrangeAgentsHome } from '../fixtures/agentSession'
import type { Locator, Page } from '@playwright/test'
import { startAddonCore, type AddonCore, type FakeConnector, type FakePlugin } from '../fixtures/addonCore'
import { expect, q, test, type BareVm } from '../fixtures/vm'

/**
 * Marketplace plugins on a Mac with no Command Line Tools, no Homebrew, no
 * Node and no uv: an agent's Add picker shows a Node.js plugin blocked with
 * where to get Node, and Check again keeps it blocked; a Python plugin adds,
 * the app installs its own uv on demand, and the plugin's connector reaches
 * connected with its tool listed — on a Python uv fetched itself, never the
 * `/usr/bin/python3` stub — with no system dialog at any step (the fixture
 * fails the test on any).
 *
 * A second test, on a VM of its own (so the managed uv is installed by this
 * path and not by a plugin's): a PyPI server from core's MCP directory
 * (`mcp-server-time`) is added, the app installs its uv and creates the
 * connector as the managed `uvx mcp-server-time==<version>`, uv fetches a
 * Python and the package from PyPI, and the connector reaches connected with
 * `get_current_time` listed. On this Mac with no Docker, a container image from
 * the same directory and a plugin whose server runs `docker` are both blocked
 * with "Needs Docker — install it from docker.com": the tile says so, Add is
 * disabled with the reason beside it, and main refuses the add as data. No
 * system dialog at any step.
 *
 * ## Arrangement
 *
 * The guest reaches no cinna-core, so the host serves a fake one
 * (`fixtures/addonCore.ts`: the unified addon directory, the batch lookup and
 * the archives) and the guest reaches it on its own loopback through an SSH
 * reverse forward. The profile is linked to it the way the main suite's
 * `linkSandboxAccount` does, without a browser: the users row is updated
 * directly. The token must be encrypted with the app's own safeStorage key,
 * which only the app can use without a keychain prompt, so the app encrypts it
 * itself — saved as an (unused) AI credential's API key — and `sqlite3` copies
 * that blob into the user's token columns.
 *
 * ## Not proven
 *
 * A real cinna-core or marketplace, a Node plugin on a Mac that has Node, a
 * chat turn using a tool (no engine is logged in here, so no tool is called),
 * PyPI dependencies of a *plugin's* server (the plugin servers are stdlib
 * only; the directory server does pull its dependencies from PyPI), Docker on
 * a Mac that has it, and Check again on a blocked *directory* connector — the
 * picker offers Check again and the docker.com link on plugins only.
 */

const AGENT = 'Toolsmith'
const TOKEN = 'bare-mac-token'
/** The guest end of the reverse forward; the guest is a fresh clone, nothing else listens there. */
const GUEST_PORT = 47613
const RUNS_CODE = 'Add — runs code on this computer'
const NEEDS_NODE = 'Needs Node.js — install it from nodejs.org'
const STILL_NO_NODE = 'Still no Node.js. If you just installed it, try again in a moment.'
const NEEDS_DOCKER = 'Needs Docker — install it from docker.com'
const STILL_NO_DOCKER = 'Still no Docker. If you just installed it, try again in a moment.'

/**
 * A stdio MCP server on the Python standard library: newline-delimited
 * JSON-RPC, one tool whose description names the interpreter running it.
 */
function serverPy(server: string, tool: string): string {
  return [
    'import json, sys',
    'def reply(i, result):',
    "    sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': i, 'result': result}) + '\\n')",
    '    sys.stdout.flush()',
    `info = {'name': '${server}', 'version': '1.0.0'}`,
    "common = {'resultType': 'complete', 'ttlMs': 0, 'cacheScope': 'private'}",
    'for line in sys.stdin:',
    '    if not line.strip():',
    '        continue',
    '    rpc = json.loads(line)',
    "    if 'id' not in rpc:",
    '        continue',
    "    method = rpc.get('method')",
    "    if method == 'initialize':",
    "        reply(rpc['id'], {'protocolVersion': (rpc.get('params') or {}).get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}}, 'serverInfo': info})",
    "    elif method == 'server/discover':",
    "        reply(rpc['id'], dict(common, supportedVersions=['2026-07-28'], capabilities={'tools': {}}, serverInfo=info))",
    "    elif method == 'tools/list':",
    `        reply(rpc['id'], dict(common, tools=[{'name': '${tool}', 'description': 'Runs on ' + sys.executable, 'inputSchema': {'type': 'object', 'properties': {}}}]))`,
    "    elif method == 'tools/call':",
    "        reply(rpc['id'], {'resultType': 'complete', 'content': [{'type': 'text', 'text': sys.version}]})",
    '    else:',
    "        reply(rpc['id'], {})",
    ''
  ].join('\n')
}

const pyproject = (name: string): string =>
  `[project]\nname = "${name}"\nversion = "1.0.0"\nrequires-python = ">=3.10"\ndependencies = []\n`

/** What `uv lock` writes for {@link pyproject}: no dependencies, the project itself virtual. */
const uvLock = (name: string): string =>
  `version = 1\nrevision = 3\nrequires-python = ">=3.10"\n\n[[package]]\nname = "${name}"\nversion = "1.0.0"\nsource = { virtual = "." }\n`

/** A Python plugin whose server runs as `uv run --directory ${CLAUDE_PLUGIN_ROOT} server.py`. */
function pythonPlugin(name: string, server: string, tool: string, locked: boolean): FakePlugin {
  return {
    name,
    description: `Python tools (${locked ? 'with' : 'without'} a uv.lock).`,
    servers: [{ name: server, runtime: 'python' }],
    files: {
      '.claude-plugin/plugin.json': { text: JSON.stringify({ name, version: '1.0.0', description: 'Python tools.' }) },
      '.mcp.json': { text: JSON.stringify({ mcpServers: { [server]: { command: 'uv', args: ['run', '--directory', '${CLAUDE_PLUGIN_ROOT}', 'server.py'] } } }) },
      'pyproject.toml': { text: pyproject(name) },
      ...(locked ? { 'uv.lock': { text: uvLock(name) } } : {}),
      'server.py': { text: serverPy(server, tool) }
    }
  }
}

const NODE_PLUGIN: FakePlugin = {
  name: 'node-tools',
  description: 'Node tools from npm.',
  servers: [{ name: 'nodetools', runtime: 'node' }],
  files: {
    '.claude-plugin/plugin.json': { text: JSON.stringify({ name: 'node-tools', version: '1.0.0', description: 'Node tools.' }) },
    '.mcp.json': { text: JSON.stringify({ mcpServers: { nodetools: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] } } }) }
  }
}

const DOCKER_PLUGIN: FakePlugin = {
  name: 'docker-tools',
  description: 'Tools in a container.',
  servers: [{ name: 'dockertools', runtime: 'docker' }],
  files: {
    '.claude-plugin/plugin.json': { text: JSON.stringify({ name: 'docker-tools', version: '1.0.0', description: 'Tools in a container.' }) },
    '.mcp.json': { text: JSON.stringify({ mcpServers: { dockertools: { command: 'docker', args: ['run', '-i', '--rm', 'mcp/time'] } } }) }
  }
}

/** The PyPI server L3c of live-marketplace-plugins runs on the developer's Mac. */
const TIME_SERVER: FakeConnector = {
  name: 'time-server',
  title: 'Clock Server',
  description: 'The current time in any timezone.',
  package: { registry: 'pypi', name: 'mcp-server-time', version: '2026.10.19' }
}
const TIME_TOOL = 'get_current_time'
const DOCKER_SERVER: FakeConnector = {
  name: 'boxed-time',
  title: 'Boxed Clock',
  description: 'The current time, from a container image.',
  package: { registry: 'oci', name: 'mcp/time', version: 'latest' }
}

const PY_LOCKED = { plugin: 'py-tools', server: 'pytools', tool: 'py_tools_version' }
const PY_UNLOCKED = { plugin: 'py-tools-nolock', server: 'pynolock', tool: 'py_nolock_version' }

/**
 * The nag watch fails the test at its end; this says at which step one first
 * showed. Soft, so the steps after a dialog still run and report.
 */
function expectNoDialog(vm: BareVm, after: string): void {
  expect.soft(vm.nags(), `a system dialog appeared by "${after}"`).toEqual([])
}

/**
 * The fake core forwarded into the guest, the profile linked to it and a new
 * agent named {@link AGENT} open on its page.
 */
async function arrange(vm: BareVm, core: AddonCore): Promise<void> {
  const { page } = vm
  await vm.reverseForward(core.port, GUEST_PORT)
  expect((await vm.sh(`curl -s -m 5 http://127.0.0.1:${GUEST_PORT}/.well-known/cinna-desktop`)).trim()).toContain('instance_name')

  await arrangeAgentsHome(vm, 'claude', async () => {
    vm.step('link the profile to the fake core')
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    expect(user).not.toBeNull()
    // The app encrypts the token with its own key, as the API key of a credential nothing uses.
    const carrier = await page.evaluate((token) => window.api.providers.upsert({ type: 'openai', name: 'Token carrier', apiKey: token, enabled: false }), TOKEN)
    const db = `${vm.userData}/cinna.db`
    const blob = `(SELECT api_key_enc FROM llm_providers WHERE id = '${carrier.id}')`
    const sql =
      `UPDATE users SET type = 'cinna_user', cinna_server_url = 'http://127.0.0.1:${GUEST_PORT}', cinna_hosting_type = 'self_hosted', ` +
      `cinna_client_id = 'bare-mac', cinna_access_token_enc = ${blob}, cinna_refresh_token_enc = ${blob}, ` +
      `cinna_token_expires_at = ${Date.now() + 3 * 3_600_000} WHERE id = '${user!.id}';` +
      `SELECT type || ' ' || length(cinna_access_token_enc) FROM users WHERE id = '${user!.id}';`
    const linked = (await vm.sh(`/usr/bin/sqlite3 -cmd '.timeout 10000' ${q(db)} ${q(sql)}`)).trim()
    expect(linked).toMatch(/^cinna_user \d+$/)
    expect((await page.evaluate((id) => window.api.providers.delete(id), carrier.id)).success).toBe(true)
  })
  expectNoDialog(vm, 'link the profile to the fake core')

  vm.step('create an agent')
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Add an agent' }).click()
  await page.getByRole('dialog', { name: 'Add an agent' }).getByRole('button', { name: /^New agent/ }).click()
  const form = page.getByRole('dialog', { name: 'New agent' })
  await form.getByLabel('Name').fill(AGENT)
  await form.getByLabel('Name').press('Enter')
  await expect(form).toBeHidden()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
}

/** Settings → MCP Providers, off the agent page first: its header has a Settings button of its own. */
async function openMcpSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.cinnaFullName ?? user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'MCP Providers', exact: true }).click()
}

/** A Settings → MCP card by its header; its buttons are found inside it, never page-wide. */
function mcpCard(page: Page, name: string): { header: Locator; card: Locator } {
  const header = page.getByRole('button', { name: new RegExp(`^${name}`) })
  return { header, card: header.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]') }
}

function closeCore(core: AddonCore): Promise<void> {
  test.info().annotations.push({ type: 'core requests', description: [...new Set(core.requests)].join(' | ') })
  return core.close()
}

test('a Node.js plugin is blocked and a Python plugin runs on the app’s own uv', async ({ vm }) => {
  const core = await startAddonCore(
    [NODE_PLUGIN, pythonPlugin(PY_LOCKED.plugin, PY_LOCKED.server, PY_LOCKED.tool, true), pythonPlugin(PY_UNLOCKED.plugin, PY_UNLOCKED.server, PY_UNLOCKED.tool, false)],
    `http://127.0.0.1:${GUEST_PORT}`
  )
  const { page } = vm
  try {
    await arrange(vm, core)

    vm.step('open the Add picker')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const picker = page.getByRole('dialog', { name: `Addons for ${AGENT}`, exact: true })
    const tile = (plugin: string) => picker.locator(`[data-addon-tile="core-marketplace-plugin:${core.ids[plugin]}"]`)
    await expect(tile(NODE_PLUGIN.name)).toBeVisible()
    await expect(tile(NODE_PLUGIN.name).locator('[data-addon-state-line]')).toHaveText(NEEDS_NODE)

    vm.step('open node-tools')
    await picker.getByRole('button', { name: NODE_PLUGIN.name, exact: true }).click()
    const detail = picker.locator('[data-addon-detail]')
    await expect(detail.locator('[data-addon-state-reason]')).toHaveText(NEEDS_NODE)
    await expect(detail.getByRole('button', { name: RUNS_CODE })).toBeDisabled()
    await expect(detail.getByRole('link', { name: 'nodejs.org' })).toBeVisible()

    vm.step('Check again on node-tools')
    await detail.getByRole('button', { name: 'Check again' }).click()
    await expect(detail.locator('[data-addon-recheck]')).toHaveText(STILL_NO_NODE)
    await expect(detail.getByRole('button', { name: 'Check again' })).toBeEnabled()
    await expect(detail.locator('[data-addon-state-reason]')).toHaveText(NEEDS_NODE)
    await expect(detail.getByRole('button', { name: RUNS_CODE })).toBeDisabled()
    expectNoDialog(vm, 'Check again on node-tools')

    for (const py of [PY_LOCKED, PY_UNLOCKED]) {
      vm.step(`add ${py.plugin}`)
      if (!(await picker.isVisible())) await page.getByRole('button', { name: 'Add', exact: true }).click()
      else await detail.getByRole('button', { name: 'Back' }).click()
      await picker.getByRole('button', { name: py.plugin, exact: true }).click()
      await detail.getByRole('button', { name: RUNS_CODE }).click()
      // The Add installs the app's own uv first (a download on the first Python plugin).
      await expect(detail.getByText('Ready in the next chat')).toBeVisible({ timeout: 5 * 60_000 })
      await detail.getByRole('button', { name: 'Done' }).click()
      await expect(picker).toBeHidden()
      expectNoDialog(vm, `add ${py.plugin}`)
    }
    const uv = (await vm.sh(`ls ${q(vm.userData)}/localdev/uv-*/uv`)).trim()
    expect(uv).toMatch(/\/localdev\/uv-[\d.]+\/uv$/)
    testInfoNote(`managed uv: ${uv}`)

    vm.step('open Settings → MCP Providers')
    await openMcpSettings(page)

    for (const py of [PY_LOCKED, PY_UNLOCKED]) {
      vm.step(`connect ${py.server}`)
      const { header, card } = mcpCard(page, py.server)
      await header.click()
      await expect(header).toHaveAttribute('aria-expanded', 'true')
      // The Add started it (uv fetched a Python on the first launch); the card lists the tool once connected.
      await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible({ timeout: 5 * 60_000 })
      await expect(card.getByText(py.tool, { exact: true })).toBeVisible()
      const listed = (await page.evaluate(() => window.api.mcp.list())).find((p) => p.managedBy?.startsWith(`plugin:${core.ids[py.plugin]}@`))
      expect(listed).toMatchObject({ name: py.server, status: 'connected' })
      expect(listed!.tools.map((t) => t.name)).toEqual([py.tool])
      // The interpreter is uv's, under the app's profile — not the /usr/bin/python3 stub.
      expect(listed!.tools[0].description).toContain(vm.userData)
      testInfoNote(`${py.server}: ${listed!.tools[0].description}`)
      await header.click()
      await expect(header).toHaveAttribute('aria-expanded', 'false')
      expectNoDialog(vm, `connect ${py.server}`)
    }

    vm.step('idle on Settings')
    // A deliberate idle window: a dialog raised late by the Python download or a server would show here.
    await page.waitForTimeout(15_000)
  } finally {
    await closeCore(core)
  }
})

test('a PyPI server from core’s MCP directory runs on the app’s own uvx, and Docker entries are blocked with no Docker', async ({ vm }) => {
  const core = await startAddonCore([DOCKER_PLUGIN], `http://127.0.0.1:${GUEST_PORT}`, [TIME_SERVER, DOCKER_SERVER])
  const { page } = vm
  try {
    // What the Docker half rests on: nothing named docker on the login shell's PATH, the one the app reads.
    expect((await vm.sh(`/bin/zsh -lc 'command -v docker || echo none'`)).trim()).toBe('none')
    await arrange(vm, core)

    vm.step('open the Add picker')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const picker = page.getByRole('dialog', { name: `Addons for ${AGENT}`, exact: true })
    const detail = picker.locator('[data-addon-detail]')
    const tile = (ref: string) => picker.locator(`[data-addon-tile="${ref}"]`)
    const timeTile = tile(`core-mcp-directory:${core.ids[TIME_SERVER.name]}`)
    const dockerTile = tile(`core-mcp-directory:${core.ids[DOCKER_SERVER.name]}`)
    const dockerPluginTile = tile(`core-marketplace-plugin:${core.ids[DOCKER_PLUGIN.name]}`)
    await expect(timeTile).toBeVisible()
    await expect(timeTile.locator('[data-addon-kind]')).toHaveText('Connector')
    await expect(timeTile.locator('[data-addon-state-line]')).toHaveCount(0)
    await expect(dockerTile.locator('[data-addon-state-line]')).toHaveText(NEEDS_DOCKER)
    await expect(dockerPluginTile.locator('[data-addon-state-line]')).toHaveText(NEEDS_DOCKER)

    vm.step(`open ${DOCKER_SERVER.title}`)
    await dockerTile.click()
    await expect(detail.locator('[data-addon-state-reason]')).toHaveText(NEEDS_DOCKER)
    await expect(detail.getByRole('button', { name: `Add to ${AGENT}`, exact: true })).toBeDisabled()
    // Main refuses it too, not only the disabled button: nothing is created.
    const agentId = (await page.evaluate(() => window.api.localAgents.list())).agents.find((a) => a.name === AGENT)!.id
    const refusal = await page.evaluate(
      ({ id, ref }) => window.api.addons.add(id, ref),
      { id: agentId, ref: { source: 'core-mcp-directory', id: core.ids[DOCKER_SERVER.name] } }
    )
    expect(refusal).toEqual({ ok: false, code: 'blocked', message: NEEDS_DOCKER })
    expect((await page.evaluate(() => window.api.mcp.list())).map((p) => p.name)).not.toContain(DOCKER_SERVER.title)
    expectNoDialog(vm, `open ${DOCKER_SERVER.title}`)

    vm.step(`Check again on ${DOCKER_PLUGIN.name}`)
    await detail.getByRole('button', { name: 'Back' }).click()
    await dockerPluginTile.click()
    await expect(detail.locator('[data-addon-state-reason]')).toHaveText(NEEDS_DOCKER)
    await expect(detail.getByRole('button', { name: RUNS_CODE })).toBeDisabled()
    await expect(detail.getByRole('link', { name: 'docker.com' })).toBeVisible()
    await detail.getByRole('button', { name: 'Check again' }).click()
    await expect(detail.locator('[data-addon-recheck]')).toHaveText(STILL_NO_DOCKER)
    await expect(detail.getByRole('button', { name: 'Check again' })).toBeEnabled()
    await expect(detail.getByRole('button', { name: RUNS_CODE })).toBeDisabled()
    expectNoDialog(vm, `Check again on ${DOCKER_PLUGIN.name}`)

    vm.step(`add ${TIME_SERVER.title}`)
    await detail.getByRole('button', { name: 'Back' }).click()
    await timeTile.click()
    await expect(detail.locator('[data-addon-runs-code]')).toHaveText('Runs code on this computer')
    await detail.getByRole('button', { name: `Add to ${AGENT}`, exact: true }).click()
    // The Add installs the app's uv, then starts the connector: uv fetches a Python and the package from PyPI.
    await expect(detail.getByText('Ready in the next chat', { exact: true })).toBeVisible({ timeout: 5 * 60_000 })
    await expect(detail.locator('[data-addon-setup]'), 'no sign-in, key or settings step').toHaveCount(0)
    await detail.getByRole('button', { name: 'Done' }).click()
    await expect(picker).toBeHidden()
    expectNoDialog(vm, `add ${TIME_SERVER.title}`)

    const uv = (await vm.sh(`ls ${q(vm.userData)}/localdev/uv-*/uvx`)).trim()
    expect(uv).toMatch(/\/localdev\/uv-[\d.]+\/uvx$/)
    const created = (await page.evaluate(() => window.api.mcp.list())).find((p) => p.name === TIME_SERVER.title)
    expect(created, 'the connector the Add created').toBeTruthy()
    expect(created!.command).toBe(uv)
    expect(created!.args).toContain(`${TIME_SERVER.package.name}==${TIME_SERVER.package.version}`)
    expect(await page.evaluate((id) => window.api.localAgents.listMcpProviders(id), agentId)).toEqual([created!.id])
    testInfoNote(`directory connector: ${created!.command} ${(created!.args ?? []).join(' ')}`)

    vm.step(`connect ${TIME_SERVER.title}`)
    await openMcpSettings(page)
    const { header, card } = mcpCard(page, TIME_SERVER.title)
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    // The Add started it; Disconnect is offered once it is connected.
    await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible({ timeout: 5 * 60_000 })
    await expect(card.getByText(TIME_TOOL, { exact: true })).toBeVisible()
    const listed = (await page.evaluate(() => window.api.mcp.list())).find((p) => p.id === created!.id)
    expect(listed).toMatchObject({ status: 'connected' })
    expect(listed!.tools.map((t) => t.name)).toContain(TIME_TOOL)
    testInfoNote(`${TIME_SERVER.title} tools: ${listed!.tools.map((t) => t.name).join(', ')}`)
    // uv's own Python, under the app's profile: never the /usr/bin/python3 stub.
    expect((await vm.sh(`ls -d ${q(vm.userData)}/localdev/python/cpython-*`)).trim()).toMatch(/\/localdev\/python\/cpython-3\./)
    expectNoDialog(vm, `connect ${TIME_SERVER.title}`)

    vm.step('idle on Settings')
    // A deliberate idle window: a dialog raised late by the PyPI install or the server would show here.
    await page.waitForTimeout(15_000)
  } finally {
    await closeCore(core)
  }
})

function testInfoNote(description: string): void {
  test.info().annotations.push({ type: 'note', description })
}
