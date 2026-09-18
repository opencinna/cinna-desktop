import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { customAcpCommand } from '../fixtures/customAcpCommand'
import { scriptAcpEngine, SCRIPT_MODEL } from '../fixtures/scriptAcpEngine'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LOCAL = 'Runtime Guide'
const REMOTE = 'Remote Researcher'
const ANSWER = 'The conductor fixture completed: cedar-8421.'
const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })

async function openSettings(cinna: CinnaApp, section: string): Promise<void> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  await cinna.page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('button', { name: section, exact: true }).click()
}

async function pick(cinna: CinnaApp, name: string): Promise<void> {
  await composer(cinna).fill('@')
  await cinna.page.getByRole('listbox', { name: 'Agents and MCP servers' }).getByRole('option').filter({ hasText: name }).click()
}

async function arrangeAgents(cinna: CinnaApp) {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const peer = customAcpCommand(cinna, { prompt: { emit: [
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ANSWER } } }
  ] } })
  const local = await cinna.page.evaluate(async ({ config, name }) => {
    const probe = await window.api.customAgents.test({ config })
    return window.api.customAgents.save({ name, config, testToken: probe.token })
  }, { config: peer.config, name: LOCAL })
  // A Local conductor need not invoke this participant for these routing tests.
  const server = createServer((_req, res) => { res.writeHead(404); res.end() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const remote = await cinna.page.evaluate(async ({ name, origin }) => window.api.agents.upsert({
    name, protocol: 'a2a', cardUrl: `${origin}/.well-known/agent-card.json`, endpointUrl: `${origin}/a2a`
  }), { name: REMOTE, origin: `http://127.0.0.1:${port}` })
  expect(remote.id).toBeTruthy()
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { localId: local.id, remoteId: remote.id!, peer }
}

for (const engine of ['claude', 'codex'] as const) {
test(`${engine} routing preference and runtime chat-mode fields persist through the real settings UI`, async ({ cinna }) => {
  await cinna.skipOnboarding()
  await openSettings(cinna, 'Features')
  await expect(cinna.page.getByRole('button', { name: 'You route', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await cinna.page.getByRole('button', { name: 'AI routes', exact: true }).click()
  await expect.poll(() => cinna.page.evaluate(async () => (await window.api.settings.getAll()).defaultMultiAgentRouting)).toBe('coordinator')
  await expect(cinna.page.getByLabel('AI Functions credentials', { exact: true })).toHaveValue('')
  await expect(cinna.page.getByText('Runs on: Default runtime', { exact: true })).toBeVisible()
  await cinna.page.screenshot({ path: '/tmp/runtime-conductor-features.png', animations: 'disabled' })
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Add Chat Mode', exact: true }).click()
  await cinna.page.getByPlaceholder('e.g. Development, Writing, Research...').fill('Subscription writing')
  await cinna.page.getByLabel('Runtime', { exact: true }).selectOption(engine)
  await cinna.page.getByText('More options', { exact: true }).click()
  const model = engine === 'claude' ? 'sonnet' : 'gpt-5.5'
  if (engine === 'claude') await cinna.page.getByLabel('Model', { exact: true }).selectOption(model)
  else await cinna.page.getByLabel('Model', { exact: true }).fill(model)
  await cinna.page.getByLabel('Tools', { exact: true }).selectOption('none')
  await cinna.page.getByLabel('Instructions', { exact: true }).fill('Use short sentences and plain language.')
  await cinna.page.getByLabel('Name', { exact: true }).press('Enter')
  await expect.poll(() => cinna.page.evaluate(async () => (await window.api.chatModes.list()).find((mode) => mode.name === 'Subscription writing'))).toMatchObject({ engine, modelId: model, providerId: null, toolPolicy: 'none', systemPrompt: 'Use short sentences and plain language.' })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await openSettings(cinna, 'Chats')
  await cinna.page.getByText('Subscription writing', { exact: true }).click()
  await expect(cinna.page.getByLabel('Runtime', { exact: true })).toHaveValue(engine)
  await expect(cinna.page.getByLabel('Instructions', { exact: true })).toHaveValue('Use short sentences and plain language.')
  await cinna.page.screenshot({ path: `/tmp/runtime-conductor-${engine}-chat-mode.png`, animations: 'disabled' })
  expect((await cinna.page.evaluate(() => window.api.settings.getAll())).defaultMultiAgentRouting).toBe('coordinator')
})
}

test('AI routes previews Local and remote-first coordinators without reordering selected agents', async ({ cinna }) => {
  await arrangeAgents(cinna)
  await openSettings(cinna, 'Features')
  await cinna.page.getByRole('button', { name: 'AI routes', exact: true }).click()
  await expect(cinna.page.getByRole('button', { name: 'AI routes', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
  await pick(cinna, LOCAL)
  await pick(cinna, REMOTE)
  await expect(cinna.page.getByRole('status', { name: `Coordinated by ${LOCAL}`, exact: true })).toHaveText(`${LOCAL} routes`)
  await expect(cinna.page.getByTitle(`${LOCAL} — Coordinator`, { exact: true })).toBeVisible()
  await expect(cinna.page.getByTitle(`${REMOTE} — Participant`, { exact: true })).toBeVisible()
  expect(await cinna.page.getByRole('button', { name: /^Remove agent / }).allTextContents()).toHaveLength(2)
  expect(await cinna.page.getByRole('button', { name: /^Remove agent / }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))).toEqual([`Remove agent ${LOCAL}`, `Remove agent ${REMOTE}`])
  await cinna.page.screenshot({ path: '/tmp/runtime-conductor-local-preview.png', animations: 'disabled' })
  await cinna.page.getByRole('button', { name: `Remove agent ${LOCAL}`, exact: true }).click()
  await pick(cinna, LOCAL)
  await expect(cinna.page.getByRole('status', { name: 'Coordinated by Default runtime', exact: true })).toHaveText('Default runtime routes')
  await expect(cinna.page.getByTitle('Default runtime — Coordinator', { exact: true })).toBeVisible()
  await expect(cinna.page.getByTitle(`${LOCAL} — Participant`, { exact: true })).toBeVisible()
  expect(await cinna.page.getByRole('button', { name: /^Remove agent / }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))).toEqual([`Remove agent ${REMOTE}`, `Remove agent ${LOCAL}`])
  await cinna.page.screenshot({ path: '/tmp/runtime-conductor-remote-preview.png', animations: 'disabled' })
})

test('badge coordination is one-way and a Local conductor preserves its ACP session without AI credentials', async ({ cinna }) => {
  const { localId, remoteId, peer } = await arrangeAgents(cinna)
  expect(await cinna.page.evaluate(() => window.api.providers.list())).toEqual([])
  await pick(cinna, LOCAL)
  await composer(cinna).fill('Start with the local guide.')
  await composer(cinna).press('Enter')
  await expect(cinna.page.getByText(ANSWER, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  await cinna.page.getByRole('status', { name: 'Local agent connection', exact: true }).focus()
  await cinna.page.getByRole('dialog', { name: 'Chat routing', exact: true }).getByRole('button', { name: `Coordinate by ${LOCAL}`, exact: true }).click()
  await expect(cinna.page.getByRole('status', { name: `Coordinated by ${LOCAL}`, exact: true })).toBeVisible()
  await expect.poll(() => cinna.page.evaluate((id) => window.api.chat.get(id), chat.id)).toMatchObject({ router: 'coordinator', agentId: localId })
  await cinna.page.keyboard.press('Escape')
  await pick(cinna, REMOTE)
  expect(await cinna.page.evaluate((id) => window.api.chat.listOnDemandAgents(id), chat.id)).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: remoteId })]))
  await cinna.page.getByRole('button', { name: 'Add to chat', exact: true }).click()
  await expect(cinna.page.getByRole('menuitem', { name: /^Coordinate by/ })).toHaveCount(0)
  await cinna.page.keyboard.press('Escape')
  await composer(cinna).fill('Continue with the participant available.')
  await composer(cinna).press('Enter')
  await expect.poll(() => peer.received('session/prompt').length).toBe(2)
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  const sessions = peer.received('session/new')
  expect(sessions).toHaveLength(1)
  expect(sessions[0].params?.mcpServers).toEqual([expect.objectContaining({ type: 'http', name: 'cinna', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) })])
  expect(peer.received('session/prompt').map((entry) => entry.params?.sessionId)).toEqual(['ses_fake', 'ses_fake'])
  await cinna.page.screenshot({ path: '/tmp/runtime-conductor-active.png', animations: 'disabled' })
})

test('a plain chat starts its chat-owned runtime on a keyless credential and applies the mode policy', async ({ cinna }) => {
  const fake = await scriptAcpEngine()
  try {
    await cinna.skipOnboarding()
    await fake.install(cinna)
    await cinna.page.evaluate(async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const credential = await window.api.providers.upsert({ type: 'ollama', name: 'Local fixture', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Plain fixture', engine: 'opencode', providerId: credential.id, modelId: model, systemPrompt: 'Answer with concise prose.', toolPolicy: 'none', isDefault: true })
    }, { host: fake.host, model: SCRIPT_MODEL })
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await composer(cinna).fill('Use the plain runtime.')
    await composer(cinna).press('Enter')
    await expect.poll(() => fake.calls.length, { timeout: 20_000 }).toBe(1)
    expect(fake.calls[0].cwd).toContain(join(cinna.sandbox.userData, 'chat-conductors'))
    expect(readFileSync(join(fake.calls[0].cwd, 'AGENTS.md'), 'utf8')).toBe('Answer with concise prose.\n')
    fake.calls[0].release('Plain runtime delivered: hazel-5719.')
    await expect(cinna.page.getByText('Plain runtime delivered: hazel-5719.', { exact: true })).toBeVisible()
    const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
    const detail = await cinna.page.evaluate((id) => window.api.chat.get(id), chat.id)
    expect(detail?.agentId).toBeTruthy()
    expect(await cinna.page.evaluate((id) => window.api.agents.list().then((agents) => agents.find((agent) => agent.id === id)), detail!.agentId!)).toMatchObject({ conductor: true, name: 'OpenCode' })
    await expect(cinna.page.getByRole('status', { name: 'Local agent connection', exact: true })).toBeVisible()
    await expect(cinna.page.getByText('OpenCode', { exact: true })).toBeVisible()
    await cinna.page.screenshot({ path: '/tmp/runtime-conductor-plain.png', animations: 'disabled' })
  } finally { await fake.close() }
})


test('a plain chat with no provider reaches its Default runtime and reports its missing setup', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const fake = await installFakeAcpEngine(cinna)
  expect(await cinna.page.evaluate(() => window.api.providers.list())).toEqual([])
  await composer(cinna).fill('A plain conversation without a provider.')
  await composer(cinna).press('Enter')
  await expect.poll(() => cinna.page.evaluate(async () => (await window.api.chat.list()).length)).toBe(1)
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  const detail = await cinna.page.evaluate((id) => window.api.chat.get(id), chat.id)
  expect(detail?.agentId).toBeTruthy()
  expect(await cinna.page.evaluate((id) => window.api.agents.list().then((agents) => agents.find((agent) => agent.id === id)), detail!.agentId!)).toMatchObject({ conductor: true, name: 'OpenCode' })
  await expect(cinna.page.getByText('The engine skipped this agent because its credential is not available to it.', { exact: true })).toBeVisible()
  expect(fake.received('session/prompt')).toEqual([])
})
