import { test, expect, type CinnaApp } from '../fixtures/app'
import { customAcpCommand, CUSTOM_NAME, CUSTOM_VERSION, CUSTOM_AUTH, CUSTOM_CWD, CUSTOM_PROMPT,
  CUSTOM_PARTIAL, CUSTOM_ANSWER, CUSTOM_STDERR, CUSTOM_REFUSAL, CUSTOM_ARGS, CUSTOM_SCRIPT,
  type CustomAcpCommand } from '../fixtures/customAcpCommand'

/** Every agent/chat/request is created through the product. Only peer files are arranged. */
async function openForm(cinna: CinnaApp, peer: CustomAcpCommand) {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  expect(await cinna.page.evaluate(() => window.api.localAgents.rootsList())).toEqual([])
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Add an agent', exact: true }).click()
  await cinna.page.getByRole('dialog', { name: 'Add an agent', exact: true })
    .getByRole('button', { name: /^Command-line agent/ }).click()
  const form = cinna.page.getByRole('dialog', { name: 'Add command-line agent', exact: true })
  await form.getByRole('textbox', { name: 'Command', exact: true }).fill(JSON.stringify(peer.config.command))
  await form.getByLabel('Working directory', { exact: true }).fill(CUSTOM_CWD)
  await form.getByRole('button', { name: 'More options', exact: true }).click()
  await form.getByLabel('Local process directory', { exact: true }).fill(peer.config.localCwd!)
  await form.getByLabel('Name', { exact: true }).fill(CUSTOM_NAME)
  return form
}

async function testCommand(cinna: CinnaApp, peer: CustomAcpCommand): Promise<void> {
  const form = cinna.page.getByRole('dialog', { name: 'Add command-line agent', exact: true })
  await form.getByRole('button', { name: 'Test', exact: true }).click()
  await expect(form.getByText(`Initialization succeeded: ${CUSTOM_NAME} · ${CUSTOM_VERSION}`, { exact: true })).toBeVisible()
  await expect(form.getByText(`Authentication methods: ${CUSTOM_AUTH}.`, { exact: true })).toBeVisible()
  // The fake explicitly handles/logs authenticate, so zero is a wire witness,
  // not the absence of an unregistered-method log entry.
  expect(peer.received('authenticate')).toEqual([])
  expect(peer.received('session/new')).toEqual([])
  expect(peer.received('session/load')).toEqual([])
  expect(peer.received('session/prompt')).toEqual([])
  expect(await cinna.page.evaluate(() => window.api.chat.list())).toEqual([])
  expect(await cinna.page.evaluate(async () => (await window.api.agents.list()).filter(row => row.driver === 'acp' && row.capabilities.cwd === false))).toEqual([])
  for (const start of peer.log().filter(row => row.dir === 'start')) {
    await expect.poll(() => { try { process.kill(start.pid!, 0); return false } catch { return true } }).toBe(true)
  }
}

async function addAndSend(cinna: CinnaApp): Promise<string> {
  await cinna.page.getByRole('dialog', { name: 'Add command-line agent', exact: true })
    .getByRole('button', { name: 'Add agent', exact: true }).click()
  await expect(cinna.page.getByRole('dialog', { name: 'Add command-line agent', exact: true })).toHaveCount(0)
  const agents = await cinna.page.evaluate(() => window.api.agents.list())
  const agent = agents.find(row => row.name === CUSTOM_NAME)
  expect(agent).toMatchObject({ driver: 'acp', capabilities: { cwd: false } })
  expect(await cinna.page.evaluate(id => window.api.customAgents.configuration(id), agent!.id)).toMatchObject({ config: { launcher: 'custom', cwd: CUSTOM_CWD } })
  const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(CUSTOM_PROMPT); await input.press('Enter')
  await expect(cinna.page.getByText(CUSTOM_PARTIAL, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled()
  return agent!.id
}

async function durableReplies(cinna: CinnaApp) {
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  return cinna.electronApp.evaluate(({ app }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`, { readonly: true, fileMustExist: true })
    try { return (db.prepare('SELECT id, status, resolution FROM task_input_requests WHERE chat_id = ?').all(input.chatId) as
      { id: string; status: string; resolution: string | null }[]).map(row => ({ ...row, resolution: row.resolution ? JSON.parse(row.resolution) : null })) }
    finally { db.close() }
  }, { userData: cinna.sandbox.userData, chatId: chat.id })
}

function assertWire(peer: CustomAcpCommand): void {
  const lines = peer.stdout()
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
  expect(lines.join('\n')).not.toContain(CUSTOM_STDERR)
  for (const start of peer.log().filter(row => row.dir === 'start')) {
    expect(start.cwd).toBe(peer.config.localCwd)
    expect(start.argv?.slice(-CUSTOM_ARGS.length)).toEqual(CUSTOM_ARGS)
  }
  expect(peer.received('authenticate')).toEqual([])
}

test('a command-line agent tests only initialization, then chats and answers one permission without a folder or credential', async ({ cinna }) => {
  test.setTimeout(60_000)
  const peer = customAcpCommand(cinna)
  await openForm(cinna, peer)
  await testCommand(cinna, peer)
  await addAndSend(cinna)
  expect(peer.received('session/new')[0].params).toEqual({ cwd: CUSTOM_CWD, mcpServers: [] })
  expect(peer.received('session/prompt')[0].params?.prompt).toEqual([{ type: 'text', text: CUSTOM_PROMPT }])
  await cinna.page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(cinna.page.getByText(CUSTOM_ANSWER, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect(peer.answers()).toHaveLength(1)
  expect(peer.answers()[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  const saved = await durableReplies(cinna)
  expect(saved).toEqual([expect.objectContaining({ status: 'answered', resolution: { kind: 'permission', reply: 'once' } })])
  await cinna.relaunch(); await cinna.skipOnboarding()
  await cinna.page.getByText(CUSTOM_PROMPT, { exact: true }).first().click()
  await expect(cinna.page.getByText(CUSTOM_ANSWER, { exact: true })).toBeVisible()
  await expect(cinna.page.getByText('Allowed once.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
  expect(await durableReplies(cinna)).toEqual(saved)
  expect(peer.received('session/prompt')).toHaveLength(1)
  expect(peer.answers()).toHaveLength(1)
  expect(await cinna.page.evaluate(() => window.api.localAgents.rootsList())).toEqual([])
  await expect(cinna.page.getByText(CUSTOM_STDERR, { exact: true })).toHaveCount(0)
  assertWire(peer)
})

test('a failed command test retains its draft, retry succeeds, and a remembered external permission can be revoked', async ({ cinna }) => {
  test.setTimeout(60_000)
  const peer = customAcpCommand(cinna, { ...CUSTOM_SCRIPT, initialize: { error: { code: -32603, message: CUSTOM_REFUSAL } } })
  const form = await openForm(cinna, peer)
  await form.getByRole('button', { name: 'Test', exact: true }).click()
  await expect(form.getByRole('alert')).toContainText(CUSTOM_REFUSAL)
  await expect(form.getByRole('button', { name: 'Test', exact: true })).toBeEnabled()
  await expect(form.getByRole('button', { name: 'Add agent', exact: true })).toBeDisabled()
  await expect(form.getByRole('textbox', { name: 'Command', exact: true })).toHaveValue(JSON.stringify(peer.config.command))
  await expect(form.getByLabel('Working directory', { exact: true })).toHaveValue(CUSTOM_CWD)
  await expect(form.getByLabel('Local process directory', { exact: true })).toHaveValue(peer.config.localCwd!)
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue(CUSTOM_NAME)
  peer.setScript(CUSTOM_SCRIPT)
  await testCommand(cinna, peer)
  const agentId = await addAndSend(cinna)
  await cinna.page.getByRole('button', { name: 'Always allow', exact: true }).click()
  await expect(cinna.page.getByText(CUSTOM_ANSWER, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect(peer.answers()).toHaveLength(1)
  expect(peer.answers()[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  expect(await durableReplies(cinna)).toEqual([expect.objectContaining({ status: 'answered', resolution: { kind: 'permission', reply: 'once', remembered: true } })])
  const configuration = await cinna.page.evaluate(id => window.api.customAgents.configuration(id), agentId)
  expect(configuration.grants).toEqual([expect.objectContaining({ action: 'edit', pattern: `${CUSTOM_CWD}/checklist.txt`, scope: 'exact' })])
  await cinna.relaunch(); await cinna.skipOnboarding()
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: CUSTOM_NAME, exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('tab', { name: 'Connection', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Configure', exact: true }).click()
  const edit = cinna.page.getByRole('dialog', { name: 'Command-line agent', exact: true })
  await edit.getByText('Remembered permissions (1)', { exact: true }).click()
  await expect(edit.getByText(`edit: ${CUSTOM_CWD}/checklist.txt`, { exact: true })).toBeVisible()
  await edit.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(edit.getByText('Remembered permissions (0)', { exact: true })).toBeVisible()
  expect((await cinna.page.evaluate(id => window.api.customAgents.configuration(id), agentId)).grants).toEqual([])
  expect(peer.received('session/prompt')).toHaveLength(1)
  expect(peer.answers()).toHaveLength(1)
  assertWire(peer)
})
