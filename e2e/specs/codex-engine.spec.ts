import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { DESKTOP_STATE_FILE, MANIFEST_FILE } from '../../src/shared/kit/manifest'
import { RUNTIME_PINS } from '../../src/shared/runtimePins'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

async function openAgent(cinna: CinnaApp, name: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await cinna.page.getByRole('button', { name, exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
}

// No real Codex turn or credentials: verifies the production IPC and persistent UI state.
test('Codex runtime and approvals persist across an app restart', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Codex Example', 'Codex Example')
  const saved = await cinna.page.evaluate((input) => window.api.localAgents.updateField({
    agentId: input.agentId,
    update: { field: 'runtime', value: { engine: 'codex', credential: null, modelId: null, complexity: 'medium' } },
    expectedStamp: input.stamp
  }), { agentId: agent.id, stamp: agent.stamps[MANIFEST_FILE]! })
  expect(saved.ok).toBe(true)

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await openAgent(cinna, agent.name)
  const page = cinna.page
  await expect(page.getByLabel('Runs on')).toHaveValue('engine:codex')
  await page.getByLabel('Work complexity').selectOption('complex')
  await expect.poll(() => JSON.parse(readFileSync(join(agent.path, MANIFEST_FILE), 'utf8')).runtime)
    .toEqual({ engine: 'codex', complexity: 'complex' })
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Permissions/ }).click()
  await expect(page.getByLabel('Approvals')).toHaveValue('ask')
  await expect(page.getByText(/Both modes keep the workspace sandbox enabled/)).toBeVisible()
  await page.getByLabel('Approvals').selectOption('auto')
  await expect.poll(() => JSON.parse(readFileSync(join(agent.path, DESKTOP_STATE_FILE), 'utf8')).codexApproval).toBe('auto')
  await page.screenshot({ path: '/tmp/cinna-codex-ui.png' })

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await openAgent(cinna, agent.name)
  await cinna.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Permissions/ }).click()
  await expect(cinna.page.getByLabel('Approvals')).toHaveValue('auto')
  const state = JSON.parse(readFileSync(join(agent.path, DESKTOP_STATE_FILE), 'utf8'))
  expect(state.claudeApproval).not.toBe('auto')
})


test('Codex chats, approves, answers questions, stops, and resumes through the production launcher', async ({ cinna }) => {
  test.setTimeout(90_000)
  // A scripted CLI, named by the explicit Codex path setting — the top of the
  // production precedence, and the only way a sandbox runs Codex at all: the
  // fixture switches the managed download off, and the PATH copy is never what
  // a spawned session runs. It is also put first on this disposable home's
  // shell PATH, because detection still reports that copy for "Open in…".
  // The resolver, login probe, Electron launcher, adapter, driver and UI are real.
  const bin = join(cinna.sandbox.home, 'bin')
  mkdirSync(bin)
  const executable = join(bin, 'codex')
  writeFileSync(executable, `#!${process.execPath}\n${readFileSync(resolve('src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs'), 'utf8')}`, { mode: 0o755 })
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  for (const profile of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
    const file = join(cinna.sandbox.home, profile)
    writeFileSync(file, readFileSync(file, 'utf8') + `\nexport PATH=${quote(bin)}:$PATH\nexport CODEX_HOME=${quote(cinna.sandbox.home)}\n`)
  }
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsCodexPath', path), executable)
  const tools = await cinna.page.evaluate(() => window.api.localTools.list())
  expect(tools.find((tool) => tool.id === 'codex')?.path).toBe(executable)
  // Asked of the configured binary, not of the PATH copy.
  expect(await cinna.page.evaluate(() => window.api.localTools.codexAuth())).toEqual({ state: 'logged_in' })
  // The explicit path is reported as what it is: configured, never "managed".
  expect(await cinna.page.evaluate(() => window.api.engine.resolveCodex())).toMatchObject({ state: 'ready', path: executable, source: 'configured' })
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Codex Runner', 'Codex Runner')
  const result = await cinna.page.evaluate((input) => window.api.localAgents.updateField({
    agentId: input.id, expectedStamp: input.stamp,
    update: { field: 'runtime', value: { engine: 'codex', credential: null, modelId: null, complexity: 'complex' } }
  }), { id: agent.id, stamp: agent.stamps[MANIFEST_FILE]! })
  expect(result.ok).toBe(true)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  // Assert the executable again immediately before any chat can run.
  expect((await cinna.page.evaluate(() => window.api.localTools.list())).find((tool) => tool.id === 'codex')?.path).toBe(executable)
  await openAgent(cinna, agent.name)
  await cinna.page.getByRole('button', { name: 'Start chat', exact: true }).click()
  const send = async (text: string) => {
    const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await input.fill(text)
    await input.press('Enter')
  }
  await send('Hello Codex')
  await expect(cinna.page.getByText('Hello from Codex.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await send('Ask for permission')
  await cinna.page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(cinna.page.getByText('Codex approval: accept.', { exact: true })).toBeVisible()
  await send('Ask a question')
  await cinna.page.getByRole('button', { name: 'Answer', exact: true }).click()
  await cinna.page.getByRole('button', { name: /^Staging/ }).click()
  await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(cinna.page.getByText('Codex answer: Staging.', { exact: true })).toBeVisible()
  await send('Wait until stopped')
  const requests = () => readFileSync(join(cinna.sandbox.home, 'codex-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  await expect.poll(() => requests().some((request) => request.method === 'turn/start' && JSON.stringify(request.params).includes('Wait until stopped'))).toBe(true)
  await cinna.page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect(requests().some((request) => request.method === 'turn/interrupt')).toBe(true)
  const state = JSON.parse(readFileSync(join(agent.path, DESKTOP_STATE_FILE), 'utf8'))
  expect(Object.values(state.sessions)).toContainEqual(expect.objectContaining({ sessionId: 'codex-session' }))
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByText('Hello Codex', { exact: true }).first().click()
  await send('Continue after restart')
  // A restarted desktop has a new authenticated MCP endpoint. A fresh engine
  // session receives the full transcript instead of loading the stale URL.
  await expect.poll(() => requests().some((request) => request.method === 'turn/start' &&
    JSON.stringify(request.params.input).includes('<prior_chat_transcript>') &&
    JSON.stringify(request.params.input).includes('Continue after restart'))).toBe(true)
  await expect(cinna.page.getByText('Hello from Codex.', { exact: true })).toHaveCount(2)
  const turns = requests().filter((request) => request.method === 'turn/start' && request.params.threadId === 'codex-session')
  expect(turns).toHaveLength(5)
  expect(turns.every((turn) => turn.params.effort === 'high' && turn.params.approvalsReviewer === 'user')).toBe(true)
})

test('a plain Codex chat applies its runtime policy and keeps the session for a second turn', async ({ cinna }) => {
  test.setTimeout(90_000)
  const instructions = 'PLAIN_CODEX_MODE_7241: answer with concise prose.'
  const bin = join(cinna.sandbox.home, 'bin')
  mkdirSync(bin)
  const executable = join(bin, 'codex')
  const fixture = readFileSync(resolve('src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs'), 'utf8')
    .replace('codex-cli 0.153.4', RUNTIME_PINS.codex.versionOutput)
  // Only this fixture advertises the policy-verified CLI version/catalog. The
  // real installed ACP adapter, policy preparation and launcher remain in use.
  const prelude = `
appendFileSync(join(process.env.CODEX_HOME ?? process.env.HOME, 'codex-invocations.jsonl'), JSON.stringify({ args: process.argv.slice(2) }) + '\\n')
if (process.argv.slice(2).join(' ') === 'debug models --bundled') {
  console.log(JSON.stringify({ models: [{ slug: 'test-model', display_name: 'Test model', shell_type: 'unified_exec' }] }))
  process.exit(0)
}
`
  writeFileSync(executable, `#!${process.execPath}\n${prelude}\n${fixture}`, { mode: 0o755 })
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  for (const profile of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
    const file = join(cinna.sandbox.home, profile)
    writeFileSync(file, readFileSync(file, 'utf8') + `\nexport PATH=${quote(bin)}:$PATH\nexport CODEX_HOME=${quote(cinna.sandbox.home)}\n`)
  }
  await cinna.relaunch()
  await cinna.skipOnboarding()
  expect((await cinna.page.evaluate(() => window.api.localTools.list())).find((tool) => tool.id === 'codex')?.path).toBe(executable)
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsCodexPath', path), executable)
  await cinna.page.evaluate(async (systemPrompt) => {
    await window.api.settings.set('autoChatTitles', false)
    await window.api.chatModes.upsert({ name: 'Plain Codex', engine: 'codex', providerId: null,
      modelId: 'test-model', systemPrompt, toolPolicy: 'none', isDefault: true })
  }, instructions)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const send = async (text: string) => {
    const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await input.fill(text)
    await input.press('Enter')
  }
  await send('Start the plain Codex conversation.')
  await expect(cinna.page.getByText('Hello from Codex.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  const requests = () => readFileSync(join(cinna.sandbox.home, 'codex-requests.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
  // The adapter can generate its own ephemeral title thread independently of
  // Cinna's title setting. Continuity belongs to the conversational thread.
  const starts = requests().filter((request) => request.method === 'thread/start' && !request.params.ephemeral)
  expect(starts).toHaveLength(1)
  expect(starts[0].params.developerInstructions).toBe(instructions)
  expect(starts[0].params.cwd).toContain(join(cinna.sandbox.userData, 'chat-conductors'))
  expect(starts[0].params.config).toMatchObject({ model: 'test-model', web_search: 'disabled',
    features: { shell_tool: false, unified_exec: false, view_image: false, multi_agent: false,
      multi_agent_v2: false, code_mode: false, code_mode_only: false, code_mode_host: false,
      browser_use: false, computer_use: false, default_mode_request_user_input: false } })
  // Plain chats keep the stable bridge descriptor from their first turn. A
  // no-tools mode must expose an empty live tool list through that endpoint.
  const endpoint = starts[0].params.config.mcp_servers.cinna
  expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//)
  const client = new Client({ name: 'cinna-e2e-policy-check', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: endpoint.http_headers }
    }))
    expect((await client.listTools()).tools).toEqual([])
  } finally { await client.close() }
  expect(starts[0].params.config).not.toHaveProperty('developer_instructions')
  const invocations = readFileSync(join(cinna.sandbox.home, 'codex-invocations.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as { args: string[] })
  const catalogOverride = invocations.find((call) => call.args.includes('app-server') &&
    call.args.some((arg) => arg.startsWith('model_catalog_json=')))?.args.find((arg) => arg.startsWith('model_catalog_json='))
  expect(catalogOverride).toBeTruthy()
  const catalogPath = JSON.parse(catalogOverride!.slice('model_catalog_json='.length)) as string
  expect(catalogPath).toContain(cinna.sandbox.userData)
  expect(JSON.parse(readFileSync(catalogPath, 'utf8')).models).toEqual([
    expect.objectContaining({ slug: 'test-model', apply_patch_tool_type: null,
      experimental_supported_tools: [], node_repl_disabled: true, multi_agent_version: null })
  ])
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  const detail = await cinna.page.evaluate((id) => window.api.chat.get(id), chat.id)
  expect(await cinna.page.evaluate((id) => window.api.agents.list().then((agents) => agents.find((agent) => agent.id === id)), detail!.agentId!))
    .toMatchObject({ conductor: true, name: 'Codex' })
  await send('Continue the same plain Codex conversation.')
  await expect(cinna.page.getByText('Hello from Codex.', { exact: true })).toHaveCount(2)
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  const turns = requests().filter((request) => request.method === 'turn/start' && request.params.threadId === 'codex-session')
  expect(turns).toHaveLength(2)
  expect(turns.map((turn) => turn.params.threadId)).toEqual(['codex-session', 'codex-session'])
  expect(requests().filter((request) => request.method === 'thread/start' && !request.params.ephemeral)).toHaveLength(1)
  const resumed = requests().filter((request) => request.method === 'thread/resume')
  expect(resumed).toHaveLength(1)
  expect(resumed[0].params).toMatchObject({ threadId: 'codex-session', developerInstructions: instructions })
  expect(resumed[0].params.config.mcp_servers.cinna).toEqual(endpoint)
  await cinna.page.screenshot({ path: '/tmp/cinna-plain-codex-chat.png', animations: 'disabled' })
})
