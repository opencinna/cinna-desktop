import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'

/**
 * Desktop notifications for a chat the user opened, when its turn settles
 * while no Cinna window has focus (`host/desktop/notificationService.ts`).
 *
 * Under the harness (`CINNA_BACKGROUND_WINDOW=1`) the service never builds a
 * real `Notification`; at the point it would show one it logs
 * `desktop notification suppressed under the test harness` with the chat id,
 * run id, status, title and body. That log line, read through
 * `logger.getAll()`, is the witness — every gate before it is the product's
 * own: the core's `turnNotices` rule (origin, status), the setting, the
 * activated profile and the focus check.
 *
 * Focus: the harness window is shown inactive and is never focused, so
 * `BrowserWindow.getFocusedWindow()` is really `null` here, and the spec
 * asserts that before relying on it. The *focused* case cannot be produced
 * honestly — focusing the window would bring the app forward on the
 * developer's machine — so that test replaces the static
 * `BrowserWindow.getFocusedWindow` in main with one answering the main window.
 * It proves the gate reads focus, not that macOS focus reaches it.
 *
 * The turn is a plain chat on the scripted ACP runtime (as `llm-stop.spec.ts`):
 * a keyless Ollama credential against a loopback fake, a default chat mode and
 * the fake ACP agent. No model, no billing.
 */

const MODEL = 'qwen3:8b'
const NOTICE = 'desktop notification suppressed under the test harness'
const REPLY = 'The ledger balances at forty-two.'
const PARTIAL = 'Counting slowly: one, two,'

const COMPLETES: FakeAcpScript = {
  prompt: {
    emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }],
    response: { stopReason: 'end_turn' }
  }
}

const WAITS_FOR_STOP: FakeAcpScript = {
  prompt: {
    emit: [
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: PARTIAL } } },
      { kind: 'awaitCancel' }
    ],
    response: { stopReason: 'cancelled' }
  }
}

function fakeOllama(): Server {
  return createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }))
        return
      }
      if (req.url === '/api/version') {
        res.end(JSON.stringify({ version: '0.6.2' }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
}

let server: Server
let host = ''

test.beforeAll(async () => {
  server = fakeOllama()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Credential, default mode and the scripted runtime, then a restart so the renderer sees them. */
async function arrange(cinna: CinnaApp, script: FakeAcpScript): Promise<FakeAcpEngine> {
  await cinna.skipOnboarding()
  const fake = await installFakeAcpEngine(cinna, script)
  await cinna.page.evaluate(
    async ({ host, modelId }) => {
      await window.api.settings.set('autoChatTitles', false)
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId, engine: 'opencode', toolPolicy: 'none', isDefault: true })
    },
    { host, modelId: MODEL }
  )
  await cinna.relaunch()
  await cinna.skipOnboarding()
  return fake
}

interface Notice {
  chatId: string
  runId: string
  status: string
  title: string
  body: string
}

/** Every suppressed-notification line main has logged since this launch. */
async function notices(cinna: CinnaApp): Promise<Notice[]> {
  const entries = await cinna.page.evaluate(() => window.api.logger.getAll())
  return entries
    .filter((entry) => entry.scope === 'notifications' && entry.message === NOTICE)
    .map((entry) => entry.data as Notice)
}

/** The chat whose first message is `prompt`, as main lists it. */
async function chatByTitle(cinna: CinnaApp, prompt: string) {
  const chats = await cinna.page.evaluate(() => window.api.chat.list())
  return chats.find((chat) => chat.title === prompt)
}

/**
 * Wait until main has recorded the chat's run result. `recordTurnResult`
 * writes the row and then calls the notice listeners synchronously, so once
 * the row is readable any log line it would cause is already in the buffer.
 */
async function settledRun(cinna: CinnaApp, prompt: string, status: string): Promise<{ chatId: string; runId: string }> {
  await expect
    .poll(async () => (await chatByTitle(cinna, prompt))?.lastRunResult?.status ?? null, {
      message: `the chat "${prompt}" has a ${status} run result`,
      timeout: 20_000
    })
    .toBe(status)
  const chat = await chatByTitle(cinna, prompt)
  return { chatId: chat!.id, runId: chat!.lastRunResult!.runId }
}

/** Start a new chat from the composer and wait for the reply on screen. */
async function sendNewChat(cinna: CinnaApp, prompt: string, expectOnScreen: string): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'What can I help with?' })).toBeVisible()
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(prompt)
  await input.press('Enter')
  await expect(page.getByRole('paragraph').filter({ hasText: expectOnScreen })).toHaveText(expectOnScreen, { timeout: 20_000 })
}

async function focusedWindowIsNull(cinna: CinnaApp): Promise<boolean> {
  return cinna.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null)
}

async function openFeatures(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Features', exact: true }).click()
}

function notificationsSwitch(cinna: CinnaApp) {
  return cinna.page.getByRole('switch', { name: 'Desktop notifications', exact: true })
}

test('a completed turn in a user chat while the window is unfocused is announced once, without the reply', async ({ cinna }) => {
  test.setTimeout(90_000)
  await arrange(cinna, COMPLETES)
  const prompt = 'What does the ledger say?'

  expect(await focusedWindowIsNull(cinna), 'no Cinna window is focused under the harness').toBe(true)
  await sendNewChat(cinna, prompt, REPLY)
  const { chatId, runId } = await settledRun(cinna, prompt, 'completed')
  expect(await focusedWindowIsNull(cinna), 'still unfocused when the turn settled').toBe(true)

  const lines = await notices(cinna)
  expect(lines).toHaveLength(1)
  // The chat runs on the default mode's conductor agent, which names the body.
  expect(lines[0]).toEqual({ chatId, runId, status: 'completed', title: prompt, body: 'OpenCode · Finished' })
  expect(JSON.stringify(lines[0])).not.toContain(REPLY)
  expect(JSON.stringify(lines[0])).not.toContain('forty-two')
})

test('a turn that settles while a Cinna window is focused is not announced', async ({ cinna }) => {
  test.setTimeout(90_000)
  await arrange(cinna, COMPLETES)

  await test.step('focused: no line', async () => {
    // Stand-in for real focus (see the file header): main's static
    // getFocusedWindow answers the main window.
    await cinna.electronApp.evaluate(({ BrowserWindow }) => {
      const g = globalThis as { __realGetFocusedWindow?: typeof BrowserWindow.getFocusedWindow }
      g.__realGetFocusedWindow = BrowserWindow.getFocusedWindow
      const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))
      if (!main) throw new Error('main window not found')
      BrowserWindow.getFocusedWindow = () => main
    })
    expect(await focusedWindowIsNull(cinna)).toBe(false)
    await sendNewChat(cinna, 'Focused question', REPLY)
    await settledRun(cinna, 'Focused question', 'completed')
    expect(await notices(cinna)).toEqual([])
  })

  await test.step('control: unfocused again, the next turn is announced', async () => {
    await cinna.electronApp.evaluate(({ BrowserWindow }) => {
      const g = globalThis as { __realGetFocusedWindow?: typeof BrowserWindow.getFocusedWindow }
      BrowserWindow.getFocusedWindow = g.__realGetFocusedWindow!
    })
    expect(await focusedWindowIsNull(cinna)).toBe(true)
    await sendNewChat(cinna, 'Unfocused question', REPLY)
    const { chatId } = await settledRun(cinna, 'Unfocused question', 'completed')
    const lines = await notices(cinna)
    expect(lines.map((line) => [line.chatId, line.status, line.title])).toEqual([[chatId, 'completed', 'Unfocused question']])
  })
})

test('Desktop notifications switched off in Settings → Features silences a completed turn, and stays off after a restart', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna, COMPLETES)

  await test.step('switch it off through the UI', async () => {
    await openFeatures(cinna)
    await expect(notificationsSwitch(cinna)).toBeChecked()
    await notificationsSwitch(cinna).click()
    await expect(notificationsSwitch(cinna)).not.toBeChecked()
    await expect
      .poll(() => cinna.page.evaluate(async () => (await window.api.settings.getAll()).desktopNotifications))
      .toBe(false)
    await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
  })

  await test.step('a completed turn while unfocused logs nothing', async () => {
    expect(await focusedWindowIsNull(cinna)).toBe(true)
    await sendNewChat(cinna, 'Quiet question', REPLY)
    await settledRun(cinna, 'Quiet question', 'completed')
    expect(await notices(cinna)).toEqual([])
  })

  await test.step('after a restart the switch is still off; turning it on announces the next turn', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await openFeatures(cinna)
    await expect(notificationsSwitch(cinna)).not.toBeChecked()
    await notificationsSwitch(cinna).click()
    await expect(notificationsSwitch(cinna)).toBeChecked()
    await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
    expect(await focusedWindowIsNull(cinna)).toBe(true)
    await sendNewChat(cinna, 'Loud question', REPLY)
    const { chatId } = await settledRun(cinna, 'Loud question', 'completed')
    const lines = await notices(cinna)
    expect(lines.map((line) => [line.chatId, line.status, line.title])).toEqual([[chatId, 'completed', 'Loud question']])
  })
})

test('the user’s own Stop is never announced', async ({ cinna }) => {
  test.setTimeout(90_000)
  const fake = await arrange(cinna, WAITS_FOR_STOP)
  const prompt = 'Count slowly to ten.'

  expect(await focusedWindowIsNull(cinna)).toBe(true)
  await sendNewChat(cinna, prompt, PARTIAL)
  await cinna.page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => fake.received('session/cancel').length, { message: 'the runtime received Stop' }).toBe(1)
  await settledRun(cinna, prompt, 'canceled')
  expect(await notices(cinna)).toEqual([])
})
