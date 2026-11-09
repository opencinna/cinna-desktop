import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'

/**
 * Runtime modes: every agent runtime as a chat mode, made by main.
 *
 * Model-free and unbilled. A loopback "Ollama" (`/api/tags`, `/api/version`)
 * is the one AI credential — keyless, so its model list is this server and no
 * vendor is reached — and is found by the app through `OLLAMA_HOST`, the same
 * probe a user's real Ollama answers, so the credential is added by the
 * one-click **Add Ollama** offer rather than over IPC. OpenCode's runtime mode
 * is ready exactly when such a credential exists, which makes it the one
 * runtime whose readiness this spec can move on any machine (Claude Agent,
 * Codex and Antigravity read binaries the sandbox does not download).
 *
 * The workspace test runs the OpenCode runtime on the scriptable fake ACP
 * agent (`installFakeAcpEngine`), which raises the native `bash` permission
 * ask a real OpenCode raises before a shell command. It proves the ask, its
 * per-chat *Always allow*, and the chat's own folder as the session cwd; it
 * cannot prove a file is written there (the fake runs no tools) — that is the
 * live spec's job (`live-runtime-modes.spec.ts`).
 */

const MODEL = 'qwen3:8b'
const env: Record<string, string> = {}
let models: Server
test.use({ env })

test.beforeAll(async () => {
  models = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }))
    } else if (req.url === '/api/version') res.end(JSON.stringify({ version: '0.6.2' }))
    else { res.writeHead(404); res.end('{}') }
  })
  await new Promise<void>((resolve, reject) => { models.once('error', reject); models.listen(0, '127.0.0.1', resolve) })
  env.OLLAMA_HOST = `http://127.0.0.1:${(models.address() as AddressInfo).port}`
})
test.afterAll(async () => { await new Promise<void>((resolve) => models.close(() => resolve())) })

const composer = (cinna: CinnaApp): Locator => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })

/** Settings → `tab`, from wherever the app is. The user-menu item toggles, so it is pressed only from outside Settings. */
async function openSettings(cinna: CinnaApp, tab: string): Promise<void> {
  const page = cinna.page
  const settingsOnly = page.getByRole('button', { name: 'MCP Providers', exact: true })
  if (!(await settingsOnly.isVisible())) {
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(settingsOnly).toBeVisible()
  }
  await page.getByRole('button', { name: tab, exact: true }).click()
}

async function leaveSettings(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(composer(cinna)).toBeVisible()
}

/** A runtime card's status slot (the line and its chip). */
const status = (cinna: CinnaApp, engine: string): Locator => cinna.page.locator(`[data-runtime-status="${engine}"]`)
/** A runtime card's collapsed header row: name, status, star, reset. */
const header = (cinna: CinnaApp, engine: string): Locator => status(cinna, engine).locator('xpath=..')

/** AI Credentials → the one-click offer for the loopback Ollama. */
async function addOllama(cinna: CinnaApp): Promise<void> {
  await expect(cinna.page.getByRole('heading', { name: 'AI Credentials' })).toBeVisible()
  await cinna.page.getByRole('button', { name: 'Add Ollama' }).click()
  await expect(cinna.page.getByText('Ollama is running on this machine')).toHaveCount(0)
}

async function runtimeMode(cinna: CinnaApp, engine: string) {
  const modes = await cinna.page.evaluate(() => window.api.chatModes.list())
  return modes.find((mode) => mode.builtinEngine === engine)!
}

test('Settings lists every runtime with its status; Add credential readies OpenCode, the star makes it the default, and Reset asks first', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const page = cinna.page
  await openSettings(cinna, 'Chats')

  await test.step('four runtime cards, in the Agents tab order, above Saved modes', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Runtimes', exact: true })).toBeVisible()
    const names = await page.locator('[data-runtime-status]').evaluateAll((slots) => slots.map((slot) => slot.getAttribute('data-runtime-status')))
    expect(names).toEqual(['claude', 'codex', 'antigravity', 'opencode'])
    for (const [engine, name] of [['claude', 'Claude Agent'], ['codex', 'Codex'], ['antigravity', 'Antigravity'], ['opencode', 'OpenCode']]) {
      await expect(header(cinna, engine).getByText(name, { exact: true })).toBeVisible()
    }
    // The sandbox never downloads a CLI, and has no credential.
    await expect(status(cinna, 'codex')).toHaveText('Not installedInstall')
    await expect(status(cinna, 'antigravity')).toHaveText('Not installedInstall')
    await expect(status(cinna, 'opencode')).toHaveText('Needs an AI credentialAdd credential')
    // A runtime mode is never deleted, only reset — and a fresh one has nothing to reset.
    await expect(header(cinna, 'opencode').getByRole('button', { name: 'Delete chat mode' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reset OpenCode to defaults', exact: true })).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByRole('heading', { level: 2, name: 'Saved modes', exact: true })).toBeVisible()
  })

  await test.step('Add credential opens AI Credentials; once one exists, OpenCode is Ready', async () => {
    await status(cinna, 'opencode').getByRole('button', { name: 'Add credential', exact: true }).click()
    await addOllama(cinna)
    await openSettings(cinna, 'Chats')
    await expect(status(cinna, 'opencode')).toHaveText('Ready')
    await expect(status(cinna, 'codex')).toHaveText('Not installedInstall')
  })

  await test.step('the star makes OpenCode the default mode', async () => {
    await header(cinna, 'opencode').getByRole('button', { name: 'Set as default', exact: true }).click()
    await expect(header(cinna, 'opencode').getByRole('button', { name: 'Remove as default', exact: true })).toBeVisible()
    await expect.poll(async () => (await runtimeMode(cinna, 'opencode')).isDefault).toBe(true)
    // Exactly one default.
    const defaults = (await page.evaluate(() => window.api.chatModes.list())).filter((mode) => mode.isDefault)
    expect(defaults.map((mode) => mode.name)).toEqual(['OpenCode'])
  })

  await test.step('Reset to defaults names what it changes, Cancel keeps the edit, Reset restores and keeps the star', async () => {
    await header(cinna, 'opencode').getByText('OpenCode', { exact: true }).click()
    const effort = page.getByLabel('Effort', { exact: true })
    await expect(effort).toHaveValue('medium')
    await expect(page.getByLabel('Tools', { exact: true })).toHaveValue('workspace')
    await effort.selectOption({ label: 'High' })
    await expect.poll(async () => (await runtimeMode(cinna, 'opencode')).complexity).toBe('complex')
    const reset = page.getByRole('button', { name: 'Reset OpenCode to defaults', exact: true })
    await expect(reset).not.toHaveAttribute('aria-disabled', 'true')
    await reset.click()
    const dialog = page.getByRole('dialog', { name: 'Reset to defaults', exact: true })
    await expect(dialog.locator('p')).toHaveText(
      'Reset OpenCode to its defaults? It sets Effort to Medium. It stays your default mode.'
    )
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(effort).toHaveValue('complex')
    expect((await runtimeMode(cinna, 'opencode')).complexity).toBe('complex')

    await reset.click()
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(effort).toHaveValue('medium')
    await expect(reset).toHaveAttribute('aria-disabled', 'true')
    expect(await runtimeMode(cinna, 'opencode')).toMatchObject({ complexity: 'medium', toolPolicy: 'workspace', isDefault: true, name: 'OpenCode' })
  })
})

test('the composer offers a runtime mode under Runtimes only once it is ready', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const page = cinna.page
  const plus = page.getByRole('button', { name: 'Add to chat', exact: true })
  const menu = page.getByRole('menu', { name: 'Add to chat', exact: true })
  const openCodeItem = menu.getByRole('menuitemradio', { name: /^OpenCode/ })

  await test.step('without a credential OpenCode is absent, not disabled', async () => {
    await plus.click()
    const chatMode = menu.getByRole('menuitem', { name: 'Chat mode', exact: true })
    // Nothing else may be ready on this machine either, in which case there is no Chat mode item at all.
    if (await chatMode.isVisible()) await chatMode.click()
    await expect(menu).toBeVisible()
    await expect(openCodeItem).toHaveCount(0)
    await page.keyboard.press('Escape')
    await composer(cinna).fill('~')
    await expect(page.getByRole('option', { name: /^OpenCode/ })).toHaveCount(0)
    await composer(cinna).fill('')
  })

  await openSettings(cinna, 'AI Credentials')
  await addOllama(cinna)
  await leaveSettings(cinna)

  await test.step('[+] → Chat mode lists OpenCode under the Runtimes heading', async () => {
    await plus.click()
    await menu.getByRole('menuitem', { name: 'Chat mode', exact: true }).click()
    await expect(openCodeItem).toBeVisible()
    await expect(menu.getByText('Runtimes', { exact: true })).toBeVisible()
    // The Runtimes heading comes before OpenCode, and before any saved mode.
    const order = await menu.evaluate((root) => [...root.querySelectorAll('[role="presentation"], [role="menuitemradio"]')]
      .map((node) => (node.getAttribute('role') === 'presentation' ? `#${node.textContent}` : node.textContent ?? '')))
    expect(order[0]).toBe('#Runtimes')
    expect(order.some((entry) => entry.startsWith('OpenCode'))).toBe(true)
    await page.keyboard.press('Escape')
  })

  await test.step('~ offers it under Runtimes too', async () => {
    await composer(cinna).fill('~')
    const option = page.getByRole('option', { name: /^OpenCode/ })
    await expect(option).toBeVisible()
    await expect(page.getByText('Runtimes', { exact: true })).toBeVisible()
    await composer(cinna).fill('')
  })
})

/** The fake runs one native shell command per prompt, behind OpenCode's own ask. */
const COMMAND = 'echo cinna > hello.txt'
const REPLY = 'Workspace fixture wrote hello.txt: juniper-4471.'
const SCRIPT: FakeAcpScript = {
  newSession: { uniqueIds: true },
  prompt: { emit: [
    { kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'hello-write', title: 'bash', kind: 'execute', status: 'pending', locations: [], rawInput: {} } },
    { kind: 'permission', toolCall: { toolCallId: 'hello-write', title: COMMAND, kind: 'execute', status: 'pending', locations: [], rawInput: { command: COMMAND } },
      options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] },
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }
  ] }
}

/**
 * Through the screens the first test proves: the credential, optionally bound
 * on the OpenCode card, then the star; ends on a new chat.
 */
async function starOpenCode(cinna: CinnaApp, bindCredential: boolean): Promise<void> {
  await openSettings(cinna, 'AI Credentials')
  await addOllama(cinna)
  await openSettings(cinna, 'Chats')
  if (bindCredential) {
    await header(cinna, 'opencode').getByText('OpenCode', { exact: true }).click()
    await cinna.page.getByLabel('AI credential', { exact: true }).selectOption({ label: 'Ollama' })
    await expect.poll(async () => (await runtimeMode(cinna, 'opencode')).providerId).not.toBeNull()
    await cinna.page.getByLabel('Model override', { exact: true }).selectOption(MODEL)
    await expect.poll(async () => (await runtimeMode(cinna, 'opencode')).modelId).toBe(MODEL)
  }
  await header(cinna, 'opencode').getByRole('button', { name: 'Set as default', exact: true }).click()
  await expect(header(cinna, 'opencode').getByRole('button', { name: 'Remove as default', exact: true })).toBeVisible()
  await leaveSettings(cinna)
  await cinna.page.getByRole('button', { name: 'New Chat', exact: true }).click()
}

/** The turn's skips when the runtime resolves no credential, or no model. */
const NO_CREDENTIAL = 'The engine skipped this agent because its credential is not available to it.'
const NO_MODEL = 'The engine skipped this agent because its runtime names no model.'

test('a starred OpenCode runtime with no credential chosen runs on the credential that made it Ready', async ({ cinna }) => {
  // The card's AI credential stays `Automatic` and Model override `From effort`:
  // the mode is itself the default, so the chat takes the first credential that
  // can run (the one that made it Ready), and Effort picks that credential's
  // model once the engine has listed it (chatConductorService).
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  await installFakeAcpEngine(cinna, SCRIPT)
  await starOpenCode(cinna, false)
  await composer(cinna).fill('Write hello.txt.')
  await composer(cinna).press('Enter')
  const skip = cinna.page.getByText(NO_CREDENTIAL, { exact: true }).or(cinna.page.getByText(NO_MODEL, { exact: true }))
  await expect(cinna.page.getByRole('button', { name: 'Always allow', exact: true }).or(skip)).toBeVisible()
  // Whichever came first decides; no waiting for a skip to go away.
  expect(await skip.count()).toBe(0)
})

test('the starred OpenCode runtime starts an unattached workspace chat whose Always allow holds for that chat only', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const page = cinna.page
  await page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const acp = await installFakeAcpEngine(cinna, SCRIPT)
  await starOpenCode(cinna, true)

  const allowOnce = page.getByRole('button', { name: 'Allow once', exact: true })
  const always = page.getByRole('button', { name: 'Always allow', exact: true })
  const replies = page.getByText(REPLY, { exact: true })
  let firstChatId = ''

  await test.step('the first message starts the OpenCode runtime in the chat folder, with no agent attached, and asks', async () => {
    await composer(cinna).fill('Write hello.txt.')
    await composer(cinna).press('Enter')
    await expect(always).toBeEnabled()
    expect(acp.answers('session/request_permission')).toEqual([])
    const [chat] = await page.evaluate(() => window.api.chat.list())
    firstChatId = chat.id
    const detail = await page.evaluate((id) => window.api.chat.get(id), chat.id)
    expect(detail?.modeId).toBe((await runtimeMode(cinna, 'opencode')).id)
    // The chat's agent row is its own runtime, not an agent the user attached.
    const agent = (await page.evaluate(() => window.api.agents.list())).find((row) => row.id === detail?.agentId)
    expect(agent).toMatchObject({ conductor: true, name: 'OpenCode' })
    await expect(page.getByRole('button', { name: /^Remove agent / })).toHaveCount(0)
    const folder = join(cinna.sandbox.userData, 'chat-conductors', chat.id)
    expect(acp.received('session/new').map((entry) => realpathSync(String(entry.params?.cwd)))).toEqual([realpathSync(folder)])
    // A workspace folder holds the user's work alone: no instructions file the model could rewrite.
    expect(existsSync(join(folder, 'AGENTS.md'))).toBe(false)
  })

  await test.step('Always allow answers the ask and says it is kept for this chat', async () => {
    await always.click()
    await expect(page.getByText('Allowed, and remembered for this chat.', { exact: true })).toBeVisible()
    await expect(replies).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    expect(acp.answers('session/request_permission').map((entry) => entry.result)).toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }])
  })

  await test.step('the same command again in this chat is not asked', async () => {
    await composer(cinna).fill('Write it again.')
    await composer(cinna).press('Enter')
    await expect(replies).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await expect(allowOnce).toHaveCount(0)
    expect(acp.answers('session/request_permission').map((entry) => entry.result)).toEqual([
      { outcome: { outcome: 'selected', optionId: 'once' } },
      { outcome: { outcome: 'selected', optionId: 'once' } }
    ])
  })

  await test.step('[+] → Actions → Open Chat Folder opens this chat\'s folder', async () => {
    await cinna.electronApp.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as { __openedPaths?: string[] }).__openedPaths = opened
      shell.openPath = async (path: string) => { opened.push(path); return '' }
    })
    await page.getByRole('button', { name: 'Add to chat', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'Add to chat', exact: true })
    await menu.getByRole('menuitem', { name: 'Actions', exact: true }).click()
    await menu.getByRole('menuitem', { name: 'Open Chat Folder', exact: true }).click()
    await expect.poll(() => cinna.electronApp.evaluate(() => (globalThis as { __openedPaths?: string[] }).__openedPaths))
      .toEqual([join(cinna.sandbox.userData, 'chat-conductors', firstChatId)])
  })

  await test.step('a new chat on the same runtime asks again', async () => {
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await composer(cinna).fill('Write hello.txt here too.')
    await composer(cinna).press('Enter')
    await expect(always).toBeEnabled()
    expect(acp.answers('session/request_permission')).toHaveLength(2)
    const chats = await page.evaluate(() => window.api.chat.list())
    expect(chats).toHaveLength(2)
    const second = chats.find((chat) => chat.id !== firstChatId)!
    expect((await page.evaluate((id) => window.api.chat.get(id), second.id))?.modeId).toBe((await runtimeMode(cinna, 'opencode')).id)
    expect(acp.received('session/new').map((entry) => realpathSync(String(entry.params?.cwd))))
      .toEqual([firstChatId, second.id].map((id) => realpathSync(join(cinna.sandbox.userData, 'chat-conductors', id))))
    await allowOnce.click()
    await expect(page.getByText('Allowed once.', { exact: true })).toBeVisible()
    await expect(replies).toHaveCount(1)
    expect(acp.answers('session/request_permission')).toHaveLength(3)
  })
})
