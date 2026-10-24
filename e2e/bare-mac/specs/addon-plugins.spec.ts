import { arrangeAgentsHome } from '../fixtures/agentSession'
import { startAddonCore, type FakePlugin } from '../fixtures/addonCore'
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
 * chat turn using the tool (no engine is logged in here), Python packages from
 * PyPI (the servers are stdlib only).
 */

const AGENT = 'Toolsmith'
const TOKEN = 'bare-mac-token'
/** The guest end of the reverse forward; the guest is a fresh clone, nothing else listens there. */
const GUEST_PORT = 47613
const RUNS_CODE = 'Add — runs code on this computer'
const NEEDS_NODE = 'Needs Node.js — install it from nodejs.org'
const STILL_NO_NODE = 'Still no Node.js. If you just installed it, try again in a moment.'

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

const PY_LOCKED = { plugin: 'py-tools', server: 'pytools', tool: 'py_tools_version' }
const PY_UNLOCKED = { plugin: 'py-tools-nolock', server: 'pynolock', tool: 'py_nolock_version' }

/**
 * The nag watch fails the test at its end; this says at which step one first
 * showed. Soft, so the steps after a dialog still run and report.
 */
function expectNoDialog(vm: BareVm, after: string): void {
  expect.soft(vm.nags(), `a system dialog appeared by "${after}"`).toEqual([])
}

test('a Node.js plugin is blocked and a Python plugin runs on the app’s own uv', async ({ vm }) => {
  test.fail(
    true,
    'Known defect: on the first Python server launch the managed uv looks for an interpreter on PATH before ' +
      'downloading one; the tool-shims/python3 stand-in exits 127, uv skips it as a bad interpreter and queries the ' +
      'next python3 on PATH, /usr/bin/python3 — the Command Line Tools stub — so "Install Command Line Developer Tools" ' +
      'appears during "connect pytools". The managed uv env sets no UV_PYTHON_PREFERENCE=only-managed (or ' +
      'UV_MANAGED_PYTHON=1), which skips the PATH search. Every other assertion passes; ' +
      "expectNoDialog(vm, 'connect pytools') is the one that should once it is fixed."
  )
  const core = await startAddonCore(
    [NODE_PLUGIN, pythonPlugin(PY_LOCKED.plugin, PY_LOCKED.server, PY_LOCKED.tool, true), pythonPlugin(PY_UNLOCKED.plugin, PY_UNLOCKED.server, PY_UNLOCKED.tool, false)],
    `http://127.0.0.1:${GUEST_PORT}`
  )
  const { page } = vm
  try {
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
    // Off the agent page first: its header has a Settings button of its own.
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    await page.getByRole('button', { name: user?.cinnaFullName ?? user?.displayName ?? 'User', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'MCP Providers', exact: true }).click()

    for (const py of [PY_LOCKED, PY_UNLOCKED]) {
      vm.step(`connect ${py.server}`)
      const header = page.getByRole('button', { name: new RegExp(`^${py.server}`) })
      await header.click()
      await expect(header).toHaveAttribute('aria-expanded', 'true')
      await page.getByRole('button', { name: 'Reconnect' }).click()
      // uv fetches a Python on the first launch; the card lists the tool once connected.
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible({ timeout: 5 * 60_000 })
      await expect(page.getByText(py.tool, { exact: true })).toBeVisible()
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
    test.info().annotations.push({ type: 'core requests', description: [...new Set(core.requests)].join(' | ') })
    await core.close()
  }
})

function testInfoNote(description: string): void {
  test.info().annotations.push({ type: 'note', description })
}
