import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { scriptAcpEngine, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'
import { seedChatTask } from '../fixtures/seed'
import { repoRoot } from '../playwright.config'

/**
 * Session activity under the composer: the Background badge, its popover and
 * Stop, the turn a local agent starts on its own after its reply, and the
 * Tasks badge.
 *
 * The agent is a command-line ACP agent (the custom launcher, which advertises
 * the AIR `asyncTasks` capability) running `scriptAcpAgent.mjs`. What it sends
 * is **replayed from the recorded Claude fixtures** — the frames a real
 * `claude-agent-acp` sent — and the test decides when each part goes out: the
 * prompt's reply, the traffic after it (the task ending, then the unprompted
 * turn) and the answer to `_session/async_task/stop`.
 */

const AGENT = 'Background Worker'
const IDLE = 'Type a message...'

interface Fixture {
  notifications: { update: Record<string, unknown> }[]
  promptReturnedAtIndex: number
  stopRequest?: Record<string, unknown>
  stopResult?: Record<string, unknown>
}
const fixture = (name: string): Fixture => JSON.parse(readFileSync(
  join(repoRoot, 'src/main/agents/drivers/acp/__fixtures__/claude', `${name}.json`), 'utf8')) as Fixture
const updates = (f: Fixture, from = 0, to?: number): Record<string, unknown>[] =>
  f.notifications.slice(from, to).map((n) => n.update)

const SHELL = fixture('async_task_background_shell')
const FOLLOW_UP = fixture('followup_turn')
const STOP = fixture('async_task_stop')
/** `name` of the recorded tasks: what the popover row is titled. */
const SHELL_TASK = 'Background sleep and echo command'
const STOP_TASK = 'Sleep for 120 seconds in background'

const composer = (cinna: CinnaApp, name = IDLE) => cinna.page.getByRole('combobox', { name, exact: true })
const backgroundBadge = (cinna: CinnaApp) =>
  cinna.page.getByRole('button', { name: '1 background process running', exact: true })
const anyBackgroundBadge = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: /background process/ })
const backgroundPopover = (cinna: CinnaApp) => cinna.page.getByLabel('Background processes', { exact: true })

/** The command-line agent, saved through the real test-then-save handlers, then a restart. */
async function arrange(cinna: CinnaApp, fake: ScriptAcpEngine): Promise<void> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const saved = await cinna.page.evaluate(async ({ config, name }) => {
    const probe = await window.api.customAgents.test({ config })
    return window.api.customAgents.save({ name, config, testToken: probe.token })
  }, { config: fake.customConfig(cinna), name: AGENT })
  expect(saved.id).toBeTruthy()
  // Agents saved over IPC are invisible to the sidebar's query until a restart.
  await cinna.relaunch()
  await cinna.skipOnboarding()
}

/** Agents → the agent → its composer; send `prompt` and wait for the fake to hold it. */
async function send(cinna: CinnaApp, fake: ScriptAcpEngine, prompt: string): Promise<string> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: AGENT, exact: true }).click()
  const input = composer(cinna)
  await input.fill(prompt)
  await input.press('Enter')
  await expect.poll(() => fake.calls.length, { timeout: 20_000 }).toBe(1)
  expect(fake.calls[0].text).toBe(prompt)
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  return chat.id
}

async function savedRows(cinna: CinnaApp, chatId: string): Promise<{ role: string; content: string }[]> {
  return cinna.page.evaluate(async (id) => {
    const detail = await window.api.chat.get(id)
    return (detail?.messages ?? []).map((message) => ({ role: message.role, content: message.content }))
  }, chatId)
}

let fake: ScriptAcpEngine
test.beforeEach(async () => { fake = await scriptAcpEngine() })
test.afterEach(async () => {
  await fake.close()
  expect(fake.unexpected).toEqual([])
})

test('a background task shows its badge while it runs, and the turn it wakes lands as a new assistant message', async ({ cinna }) => {
  test.setTimeout(120_000)
  const PROMPT = 'Kick off the probe in the background.'
  await arrange(cinna, fake)
  const chatId = await send(cinna, fake, PROMPT)

  await test.step('the launcher advertises background tasks', () => {
    expect(fake.inits.length).toBeGreaterThan(0)
    for (const init of fake.inits) {
      expect(init).toMatchObject({ clientCapabilities: { _meta: { jetbrains: { air: { version: 1 } } } } })
      const air = (init.clientCapabilities as { _meta: { jetbrains: { air: { capabilities: string[] } } } })._meta.jetbrains.air
      expect(air.capabilities).toContain('asyncTasks')
    }
  })

  await test.step('the turn starts a background shell and returns', async () => {
    // Everything the recording saw before `session/prompt` answered.
    fake.calls[0].release({ updates: updates(SHELL, 0, SHELL.promptReturnedAtIndex), after: true })
    await expect(cinna.page.getByRole('paragraph').filter({ hasText: /^started$/ })).toBeVisible()
    await expect(composer(cinna)).toBeVisible()
    await expect.poll(() => fake.afters.length).toBe(1)
  })

  await test.step('the Background badge sits left of the Local badge; its popover names the task as running', async () => {
    const badge = backgroundBadge(cinna)
    await expect(badge).toBeVisible()
    const local = cinna.page.getByRole('status', { name: 'Local agent connection', exact: true })
    await expect(local).toBeVisible()
    const [b, l] = [await badge.boundingBox(), await local.boundingBox()]
    expect(b!.x + b!.width).toBeLessThanOrEqual(l!.x)
    await badge.hover()
    const popover = backgroundPopover(cinna)
    await expect(popover).toBeVisible()
    const row = popover.getByRole('listitem')
    await expect(row).toHaveCount(1)
    await expect(row.getByTitle(SHELL_TASK, { exact: true }).first()).toHaveText(SHELL_TASK)
    await expect(row.getByText('Running', { exact: true })).toBeVisible()
    await cinna.page.mouse.move(0, 0)
  })

  await test.step('the task ends and the agent answers on its own: a new assistant turn, no new user turn', async () => {
    // The task's end, then the turn it wakes, ended by the `usage_update` carrying `cost`.
    fake.afters[0].release({ updates: [...updates(SHELL, SHELL.promptReturnedAtIndex, SHELL.promptReturnedAtIndex + 1), ...updates(FOLLOW_UP)] })
    await expect(cinna.page.getByRole('paragraph').filter({ hasText: /^Output: probe-done$/ })).toBeVisible({ timeout: 20_000 })
    await expect(anyBackgroundBadge(cinna)).toHaveCount(0)
    await expect(composer(cinna)).toBeVisible()
    await expect.poll(() => savedRows(cinna, chatId).then((rows) => rows.map((row) => row.role)), { timeout: 20_000 })
      .toEqual(['user', 'assistant', 'assistant'])
    const rows = await savedRows(cinna, chatId)
    expect(rows[0].content).toBe(PROMPT)
    expect(rows[2].content).toContain('probe-done')
    expect(fake.calls).toHaveLength(1)
  })
})

test('Stop on a running background task stops it at the agent, and the badge leaves', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna, fake)
  const chatId = await send(cinna, fake, 'Sleep for a while in the background.')
  fake.calls[0].release({ updates: updates(STOP, 0, STOP.promptReturnedAtIndex) })
  await expect(cinna.page.getByRole('paragraph').filter({ hasText: /^started$/ })).toBeVisible()
  await expect(composer(cinna)).toBeVisible()

  await test.step('hover the badge and press Stop', async () => {
    await backgroundBadge(cinna).hover()
    const popover = backgroundPopover(cinna)
    await expect(popover.getByText('Running', { exact: true })).toBeVisible()
    await popover.getByRole('button', { name: `Stop ${STOP_TASK}`, exact: true }).click()
  })

  await test.step('the agent is asked to stop that task, and the row waits for its answer', async () => {
    await expect.poll(() => fake.stops.length).toBe(1)
    expect(fake.stops[0].params).toEqual({ sessionId: fake.calls[0].sessionId, asyncTaskId: STOP.stopRequest!.asyncTaskId })
    await expect(backgroundPopover(cinna).getByRole('button', { name: `Stopping ${STOP_TASK}`, exact: true })).toBeVisible()
  })

  await test.step('the agent reports the task stopped and answers {stopped: true}: the open popover shows it stopped, and the badge leaves once it closes', async () => {
    // As recorded: `stopped` twice, then the synthetic "Task stopped by user" chunk with no messageId.
    fake.stops[0].release({ updates: updates(STOP, 10), result: STOP.stopResult! })
    // The popover the user is looking at stays, with its badge, so the outcome is readable.
    await expect(backgroundPopover(cinna).getByText('Stopped', { exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'No background processes running', exact: true })).toBeVisible()
    await cinna.page.mouse.move(5, 5)
    await expect(anyBackgroundBadge(cinna)).toHaveCount(0)
    await expect(backgroundPopover(cinna)).toHaveCount(0)
  })

  await test.step('the synthetic stop text opened no turn: the next user turn follows the first directly', async () => {
    const input = composer(cinna)
    await input.fill('Anything left running?')
    await input.press('Enter')
    await expect.poll(() => fake.calls.length).toBe(2)
    fake.calls[1].release('Nothing is running now.')
    await expect(cinna.page.getByRole('paragraph').filter({ hasText: /^Nothing is running now\.$/ })).toBeVisible()
    await expect.poll(() => savedRows(cinna, chatId), { timeout: 20_000 }).toEqual([
      { role: 'user', content: 'Sleep for a while in the background.' },
      { role: 'assistant', content: expect.stringContaining('started') },
      { role: 'user', content: 'Anything left running?' },
      { role: 'assistant', content: 'Nothing is running now.' }
    ])
  })
})

test('the Tasks badge appears once the chat has a task, and its row opens the task page', async ({ cinna }) => {
  test.setTimeout(90_000)
  const TITLE = 'Audit the nightly export'
  await arrange(cinna, fake)
  const chatId = await send(cinna, fake, 'Say hello.')
  fake.calls[0].release('Hello there.')
  await expect(cinna.page.getByRole('paragraph').filter({ hasText: /^Hello there\.$/ })).toBeVisible()
  const badge = cinna.page.getByRole('button', { name: '1 task in this chat', exact: true })
  await expect(badge).toHaveCount(0)

  await seedChatTask(cinna, { chatId, title: TITLE })
  // The chat's task list is re-read every five seconds.
  await expect(badge).toBeVisible({ timeout: 15_000 })
  const local = cinna.page.getByRole('status', { name: 'Local agent connection', exact: true })
  const [b, l] = [await badge.boundingBox(), await local.boundingBox()]
  expect(b!.x + b!.width).toBeLessThanOrEqual(l!.x)

  await badge.hover()
  const popover = cinna.page.getByLabel('Tasks in this chat', { exact: true })
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: `${TITLE} — completed`, exact: true }).click()
  await expect(cinna.page.getByRole('heading', { level: 1, name: TITLE, exact: true })).toBeVisible()
  await expect(popover).toHaveCount(0)
})
