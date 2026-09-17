import { test, expect, type CinnaApp } from '../fixtures/app'
import { serveManaged, MANAGED_NAME, MANAGED_KEY, MANAGED_REMOTE_ID, MANAGED_ENVIRONMENT,
  MANAGED_WORKSPACE, FIRST_PROMPT, SECOND_PROMPT, BUDGET_PROMPT, UNCERTAIN_PROMPT,
  BEFORE_PERMISSION, AFTER_PERMISSION, SECOND_ANSWER, BUDGET_ANSWER, type ManagedServiceFixture } from '../fixtures/managedService'

const CREDENTIAL_ID = 'managed-e2e-credential'
const ENV: Record<string, string> = {}
let remote: ManagedServiceFixture
let startRequest = 0
let startSession = 0
test.use({ env: ENV })
test.beforeAll(async () => { remote = await serveManaged(); ENV.ANTHROPIC_BASE_URL = remote.origin })
test.afterAll(async () => { await remote.close() })
test.beforeEach(() => {
  startRequest = remote.requests.length; startSession = remote.sessions.size
  remote.state.holdConfirmation = true; remote.state.failChoices = false; remote.state.failSave = false
})

/** Seed only a synthetic credential; agent, chat, session and ask are all created by the product. */
async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`)
    try { db.prepare('INSERT INTO llm_providers (id, user_id, type, name, api_key_enc, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, '__default__', 'anthropic', 'Managed E2E credential', safeStorage.encryptString(input.key), 1, Date.now()) }
    finally { db.close() }
  }, { userData: cinna.sandbox.userData, id: CREDENTIAL_ID, key: MANAGED_KEY })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  expect(await cinna.page.evaluate(() => window.api.localAgents.rootsList())).toEqual([])
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Add an agent', exact: true }).click()
  await cinna.page.getByRole('dialog', { name: 'Add an agent', exact: true })
    .getByRole('button', { name: /^Advanced options/ }).click()
  await cinna.page.getByRole('dialog', { name: 'Advanced options', exact: true }).locator('[data-settled="true"]').waitFor()
  await cinna.page.getByRole('dialog', { name: 'Advanced options', exact: true })
    .getByRole('button', { name: /^Managed \(Claude\)/ }).click()
  const form = cinna.page.getByRole('dialog', { name: 'Add Managed agent', exact: true })
  await form.getByRole('combobox', { name: /^Credential/ }).selectOption(CREDENTIAL_ID)
  await form.getByRole('button', { name: 'More options', exact: true }).click()
  await form.getByLabel('Workspace ID', { exact: true }).fill(MANAGED_WORKSPACE)
  await form.getByLabel('Agent version', { exact: true }).fill('1')
  await form.getByRole('button', { name: 'Load workspace', exact: true }).click()
  await form.getByRole('combobox', { name: /^Agent/ }).selectOption(MANAGED_REMOTE_ID)
  await form.getByRole('combobox', { name: /^Environment/ }).selectOption(MANAGED_ENVIRONMENT)
  await form.getByRole('button', { name: 'Add agent', exact: true }).click()
  await expect(form).not.toBeVisible()
  await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toBeVisible()
  expect(await cinna.page.evaluate(() => window.api.localAgents.rootsList())).toEqual([])
  const agents = await cinna.page.evaluate(() => window.api.agents.list())
  expect(agents).toEqual(expect.arrayContaining([expect.objectContaining({ name: MANAGED_NAME, driver: 'managed' })]))
}

async function send(cinna: CinnaApp, value: string): Promise<void> {
  const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(value); await input.press('Enter')
}
function session() { return remote.sessions.get(`sesn_e2e_${startSession + 1}`)! }
function events(type: string) {
  return remote.requests.slice(startRequest).flatMap(row => row.body?.events?.filter(event => event.type === type) ?? [])
}
async function durable(cinna: CinnaApp) {
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  if (!chat) throw new Error('Managed chat has not been created')
  return cinna.electronApp.evaluate(({ app }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`, { readonly: true, fileMustExist: true })
    try { return {
      asks: (db.prepare('SELECT id, status, resolution FROM task_input_requests WHERE chat_id = ? ORDER BY created_at').all(input.chatId) as
        { id: string; status: string; resolution: string | null }[]).map(row => ({ ...row, resolution: row.resolution ? JSON.parse(row.resolution) : null })),
      checkpoint: db.prepare('SELECT session_id, state FROM managed_agent_sessions WHERE chat_id = ?').get(input.chatId) as { session_id: string; state: string } | undefined
    } } finally { db.close() }
  }, { userData: cinna.sandbox.userData, chatId: chat.id })
}

// Official SDK HTTP/SSE runs in main. There are no renderer pumps, SDK mocks or permission IPC replacements.
test('Managed setup needs no folder; permission waits for acknowledgment, then the same remote session survives restart and reaches its budget', async ({ cinna }) => {
  test.setTimeout(90_000)
  await arrange(cinna)
  await send(cinna, FIRST_PROMPT)
  await expect(cinna.page.getByText(BEFORE_PERMISSION, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled()
  await expect(cinna.page.getByRole('button', { name: 'Always allow', exact: true })).toHaveCount(0)
  await expect.poll(() => durable(cinna)).toMatchObject({ asks: [{ status: 'open', resolution: null }] })
  await cinna.page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect.poll(() => session()?.held.length).toBe(1)
  expect(events('user.tool_confirmation')).toEqual([{ type: 'user.tool_confirmation', result: 'allow', tool_use_id: `${session().id}-permission` }])
  // The server has already streamed the answer and end event, but local acceptance is not committed yet.
  expect((await durable(cinna)).asks).toEqual([expect.objectContaining({ status: 'open', resolution: null })])
  await expect(cinna.page.getByRole('button', { name: 'Allowing…', exact: true })).toBeDisabled()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(cinna.page.getByText(AFTER_PERMISSION, { exact: true })).toHaveCount(0)
  remote.releaseConfirmation(session().id)
  await expect(cinna.page.getByText(AFTER_PERMISSION, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(cinna.page.getByText('Allowed once.', { exact: true })).toBeVisible()
  const saved = await durable(cinna)
  expect(saved).toMatchObject({ asks: [{ status: 'answered', resolution: { kind: 'permission', reply: 'once' } }], checkpoint: { session_id: session().id, state: 'ready' } })
  await cinna.relaunch(); await cinna.skipOnboarding()
  await cinna.page.getByText(FIRST_PROMPT, { exact: true }).first().click()
  await expect(cinna.page.getByText(AFTER_PERMISSION, { exact: true })).toBeVisible()
  expect(await durable(cinna)).toEqual(saved)
  await send(cinna, SECOND_PROMPT)
  await expect(cinna.page.getByText(SECOND_ANSWER, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect(remote.sessions.size - startSession).toBe(1)
  expect(events('user.message')).toHaveLength(2)
  expect(events('user.tool_confirmation')).toHaveLength(1)
  await send(cinna, BUDGET_PROMPT)
  await expect(cinna.page.getByText(BUDGET_ANSWER, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect((await durable(cinna)).checkpoint).toEqual({ session_id: session().id, state: 'budget' })
  await send(cinna, 'Try to continue this paused session.')
  await expect(cinna.page.getByText('This Managed session is paused at its remote budget. Review the budget in Claude before continuing.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect(events('user.message')).toHaveLength(3)
  expect(remote.requests.slice(startRequest).filter(row => row.method === 'POST' && row.path === '/v1/sessions')).toHaveLength(1)
  expect(remote.requests.slice(startRequest).filter(row => row.path !== '/v1/models').every(row => row.key === MANAGED_KEY && row.workspace === MANAGED_WORKSPACE)).toBe(true)
  expect(remote.unexpected).toEqual([])
})

test('a lost Managed permission acknowledgment disables retry and Stop confirms interruption without resending the answer', async ({ cinna }) => {
  test.setTimeout(60_000)
  await arrange(cinna)
  await send(cinna, UNCERTAIN_PROMPT)
  await expect(cinna.page.getByText(BEFORE_PERMISSION, { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Always allow', exact: true })).toHaveCount(0)
  await cinna.page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(cinna.page.getByText(/The Managed answer may have been accepted, but its acknowledgment was lost/)).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
  await expect(cinna.page.getByRole('button', { name: 'Deny', exact: true })).toBeDisabled()
  expect(events('user.tool_confirmation')).toHaveLength(1)
  expect((await durable(cinna)).asks).toEqual([expect.objectContaining({ status: 'open', resolution: null })])
  await cinna.page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await expect(cinna.page.getByText(BEFORE_PERMISSION, { exact: true })).toBeVisible()
  await expect(cinna.page.getByText(/remote stop was not confirmed/)).toHaveCount(0)
  expect(events('user.interrupt')).toEqual([{ type: 'user.interrupt' }])
  expect(events('user.tool_confirmation')).toHaveLength(1)
  expect((await durable(cinna)).checkpoint).toEqual({ session_id: session().id, state: 'ready' })
  expect(remote.unexpected).toEqual([])
})
