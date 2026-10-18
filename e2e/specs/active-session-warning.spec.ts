import { realpathSync } from 'node:fs'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { scriptAcpEngine, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'
import {
  adoptBare, arrangeScripted, createReady, openTasksTab, openTaskPage, promptFor, report, taskStatus
} from '../fixtures/dispatcher'

/**
 * The active-session warning (`docs/agents/local_agents/active_session_warning.md`)
 * and the dispatcher's start beside a live chat (`task_dispatcher.md`, "When a
 * task may start"): sessions on one agent run side by side, and the surfaces
 * that start one more only warn.
 *
 * Arrangement: the scripted ACP engine behind a keyless default mode
 * (`arrangeScripted`), a bare folder agent, and a direct chat on it whose turn
 * is started over `run.start` and **held open** by the fake — a real
 * main-owned turn (`activeRunsByChat`), so `agentSessions:active` lists it.
 * What is driven through the UI: the agent's composer, Open, Send, the Run
 * mode select, Run next, the task page's Continue-with picker.
 *
 * Real: `activeAgentSessions` and its `agentSessions:changed` push, the
 * composer notice panel, `AgentActiveSessionNotice`, `taskDispatchService`
 * starting beside a live chat. Scripted: what each ACP turn says. No model,
 * nothing billed.
 *
 * Not proved: the "a chat" wording for an untitled chat, a session started by
 * a schedule or an autonomous runner, and the task page's snapshot holding
 * still after a run ends elsewhere (asserted only as "still shown after main
 * says nothing runs", which a late push could also satisfy).
 */

const AGENT = 'Granite Keeper'
const IDLE = 'Basalt Keeper'
const CHAT_TITLE = 'Sort the granite shelf'
const CHAT_PROMPT = 'Sort the granite shelf by grain.'

const SECOND_PROMPT = 'Weigh the granite offcuts.'
const RUNNING_COMPOSER = 'Send a follow-up · Esc Esc to stop'

const conflict = (where: string, pronoun: 'it' | 'them' = 'it'): string =>
  `${AGENT} is already running in ${where}. Make sure this request won’t conflict with ${pronoun}.`
const beside = (where: string): string => `${AGENT} is also running in ${where}. Run next starts beside it.`

async function relaunchAndRescan(cinna: CinnaApp): Promise<void> {
  // Adopted agents reach the sidebar, the pickers and the dispatcher after a restart.
  await cinna.relaunch()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
}

/** A titled direct chat on `agentId` whose first turn the fake holds open; answers the chat id and the prompt index. */
async function startHeldChat(cinna: CinnaApp, fake: ScriptAcpEngine, agentId: string): Promise<{ chatId: string; call: number }> {
  const before = fake.calls.length
  const chatId = await cinna.page.evaluate(async (input) => {
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { agentId: input.agentId, router: 'direct', title: input.title })
    await window.api.run.start({ chatId: chat.id, content: input.prompt })
    return chat.id
  }, { agentId, title: CHAT_TITLE, prompt: CHAT_PROMPT })
  await expect.poll(() => fake.calls.findIndex((call, i) => i >= before && call.text.includes(CHAT_PROMPT)), { timeout: 60_000 })
    .toBeGreaterThan(-1)
  const call = fake.calls.findIndex((c, i) => i >= before && c.text.includes(CHAT_PROMPT))
  await expect.poll(() => activeSessionChats(cinna), { timeout: 15_000 }).toContain(chatId)
  return { chatId, call }
}

async function promptIndex(fake: ScriptAcpEngine, text: string): Promise<number> {
  await expect.poll(() => fake.calls.findIndex((call) => call.text.includes(text)), { timeout: 60_000, message: `a prompt with ${text}` })
    .toBeGreaterThan(-1)
  return fake.calls.findIndex((call) => call.text.includes(text))
}

async function activeSessionChats(cinna: CinnaApp): Promise<string[]> {
  const result = await cinna.page.evaluate(() => window.api.agentSessions.active())
  return result.ok ? result.sessions.map((session) => session.chatId) : []
}

async function chatIdle(cinna: CinnaApp, chatId: string): Promise<void> {
  await expect.poll(async () => (await cinna.page.evaluate((id) => window.api.chat.get(id), chatId))?.activeRunId ?? null, { timeout: 30_000 })
    .toBeNull()
}

/** Agents → the agent's row: its page in chat mode, a new-chat composer with the agent picked. */
async function openAgentComposer(cinna: CinnaApp, name: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  // The sidebar row: a chat's composer chip carries the same name.
  await cinna.page.locator('.app-sidebar-wrap').getByRole('button', { name, exact: true }).click()
  await expect(cinna.page.getByRole('heading', { level: 1, name })).toBeVisible()
}

const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
const panel = (cinna: CinnaApp) => cinna.page.getByRole('status', { name: 'Agent status' })

test('a new chat with an agent already running shows the warning row with Open, Send still sends, and the row leaves when the runs end', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await arrangeScripted(cinna, fake)
    const { agentId } = await adoptBare(cinna, 'granite-keeper', AGENT)
    await relaunchAndRescan(cinna)
    const held = await startHeldChat(cinna, fake, agentId)

    await test.step('the agent’s new-chat composer carries the warning row, naming the running chat', async () => {
      await openAgentComposer(cinna, AGENT)
      const row = panel(cinna).getByRole('listitem').filter({ hasText: conflict(`“${CHAT_TITLE}”`) })
      await expect(row).toHaveCount(1, { timeout: 15_000 })
      await expect(row.getByRole('paragraph')).toHaveText(conflict(`“${CHAT_TITLE}”`))
      await expect(row.getByRole('button', { name: 'Open', exact: true })).toHaveAttribute('title', `Open “${CHAT_TITLE}”`)
    })

    let second = -1
    await test.step('Send is not blocked: a second chat starts while the first turn is still held', async () => {
      await composer(cinna).fill(SECOND_PROMPT)
      await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
      await composer(cinna).press('Enter')
      second = await promptIndex(fake, SECOND_PROMPT)
      expect(fake.calls[held.call].closed || fake.calls[held.call].released).toBe(false)
      expect(realpathSync(fake.calls[second].cwd)).toBe(realpathSync(fake.calls[held.call].cwd))
      // Now in the second chat, which is running: an existing chat's composer shows no warning.
      await expect(cinna.page.getByRole('combobox', { name: RUNNING_COMPOSER, exact: true })).toBeVisible()
      await expect(cinna.page.getByText(/is already running in/)).toHaveCount(0)
    })

    await test.step('with both running, a new chat reads “2 sessions”, and Open goes to the newest', async () => {
      await openAgentComposer(cinna, AGENT)
      await expect(panel(cinna).getByText(conflict('2 sessions', 'them'), { exact: true })).toBeVisible({ timeout: 15_000 })
      await panel(cinna).getByRole('button', { name: 'Open', exact: true }).click()
      await expect(cinna.page.getByRole('paragraph').filter({ hasText: SECOND_PROMPT })).toBeVisible()
      await expect(cinna.page.getByRole('combobox', { name: RUNNING_COMPOSER, exact: true })).toBeVisible()
    })

    await test.step('Open on a single session goes to that chat', async () => {
      fake.calls[second].release('Offcuts weighed.')
      await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toBeVisible({ timeout: 15_000 })
      await openAgentComposer(cinna, AGENT)
      await expect(panel(cinna).getByText(conflict(`“${CHAT_TITLE}”`), { exact: true })).toBeVisible({ timeout: 15_000 })
      await panel(cinna).getByRole('button', { name: 'Open', exact: true }).click()
      await expect(cinna.page.getByRole('paragraph').filter({ hasText: CHAT_PROMPT })).toBeVisible()
      await expect(cinna.page.getByRole('combobox', { name: RUNNING_COMPOSER, exact: true })).toBeVisible()
    })

    await test.step('the row leaves once the run ends, with the new-chat composer left open', async () => {
      await openAgentComposer(cinna, AGENT)
      await expect(panel(cinna).getByText(conflict(`“${CHAT_TITLE}”`), { exact: true })).toBeVisible({ timeout: 15_000 })
      fake.calls[held.call].release('Shelf sorted.')
      await chatIdle(cinna, held.chatId)
      await expect(cinna.page.getByText(/is already running in/)).toHaveCount(0, { timeout: 15_000 })
    })
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

const TASK_ONE = 'Polish the granite-7301 slab'
const TASK_TWO = 'Polish the granite-7302 slab'

test('One at a time starts a Ready task beside a live chat in the agent’s folder, Run next starts one more past the count, and the Tasks tab names only the chat', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await arrangeScripted(cinna, fake)
    const { agentId, folder } = await adoptBare(cinna, 'granite-queue', AGENT)
    await relaunchAndRescan(cinna)
    // Created in Manual (the default), so nothing starts before the chat holds the folder.
    const one = await createReady(cinna, agentId, TASK_ONE, 'high')
    const two = await createReady(cinna, agentId, TASK_TWO, 'normal')
    const held = await startHeldChat(cinna, fake, agentId)

    await openTasksTab(cinna, AGENT)
    const tab = cinna.page.getByRole('tabpanel')
    const notice = tab.locator('[data-agent-active-session]')
    const status = tab.locator('[data-queue-status]')

    await test.step('the Tasks tab names the live chat: Run next starts beside it', async () => {
      await expect(status).toHaveText(`Next: ${TASK_ONE}`)
      await expect(notice.getByRole('status')).toHaveText(`${beside(`“${CHAT_TITLE}”`)} Open`)
      await expect(notice.getByRole('button', { name: 'Open', exact: true })).toHaveAttribute('title', `Open “${CHAT_TITLE}”`)
    })

    let i = -1
    await test.step('One at a time starts the first task beside the held chat turn, in the same folder', async () => {
      await tab.getByRole('combobox', { name: 'Run mode', exact: true }).selectOption({ label: 'One at a time' })
      i = await promptFor(fake, TASK_ONE, 30_000)
      expect(fake.calls[held.call].closed || fake.calls[held.call].released).toBe(false)
      expect(realpathSync(fake.calls[i].cwd)).toBe(realpathSync(folder))
      await expect(status).toHaveText(`Running ${TASK_ONE}`, { timeout: 15_000 })
      expect(await taskStatus(cinna, two)).toBe('open')
      // The queue's own run is on the status line, not in the notice.
      await expect(notice.getByRole('status')).toHaveText(`${beside(`“${CHAT_TITLE}”`)} Open`)
    })

    let j = -1
    await test.step('Run next past the count starts the second task too, with no refusal', async () => {
      await tab.getByRole('button', { name: 'Run next', exact: true }).click()
      j = await promptFor(fake, TASK_TWO, 30_000)
      await expect(status).toHaveText('Running 2 tasks', { timeout: 15_000 })
      await expect(tab.getByRole('alert')).toHaveCount(0)
      expect(fake.calls[held.call].closed || fake.calls[held.call].released).toBe(false)
      expect(fake.calls[i].closed || fake.calls[i].released).toBe(false)
      await expect(notice.getByRole('status')).toHaveText(`${beside(`“${CHAT_TITLE}”`)} Open`)
    })

    await test.step('the chat’s turn ends: the notice goes while the two queue runs go on', async () => {
      fake.calls[held.call].release('Shelf sorted.')
      await chatIdle(cinna, held.chatId)
      await expect(notice).toHaveCount(0, { timeout: 15_000 })
      await expect(status).toHaveText('Running 2 tasks')
    })

    await report(cinna, fake, i, one, TASK_ONE)
    await report(cinna, fake, j, two, TASK_TWO)
    await expect(status).toHaveText('No Ready tasks', { timeout: 30_000 })
    expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.paused).toBeNull()
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

const ASSIGNED = 'Seal the granite-7401 joints'
const LOOSE = 'Grade the granite-7402 gravel'

test('a task page warns about the agent its Start or Continue would run: the assignee under Start, the picked agent under Continue with', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await arrangeScripted(cinna, fake)
    const { agentId } = await adoptBare(cinna, 'granite-pages', AGENT)
    await adoptBare(cinna, 'basalt-pages', IDLE)
    await relaunchAndRescan(cinna)
    await createReady(cinna, agentId, ASSIGNED)
    await cinna.page.evaluate((title) => window.api.tasks.create({ title, status: 'open' }), LOOSE)
    const held = await startHeldChat(cinna, fake, agentId)
    const sentence = conflict(`“${CHAT_TITLE}”`)

    await test.step('a Ready task of the running agent: the warning is last under Start', async () => {
      await openTaskPage(cinna, AGENT, ASSIGNED)
      const start = cinna.page.getByRole('region', { name: 'Start this task' })
      await expect(start.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
      await expect(start.getByRole('status')).toHaveText(`${sentence} Open`)
    })

    await test.step('an unassigned task: no warning until the running agent is picked under Continue with', async () => {
      await cinna.page.getByRole('button', { name: 'Tasks', exact: true }).click()
      await cinna.page.getByRole('button', { name: 'Remove the Granite Keeper filter' }).click()
      await cinna.page.getByRole('button', { name: new RegExp(`^${LOOSE} — `) }).click()
      await expect(cinna.page.getByRole('heading', { level: 1, name: LOOSE })).toBeVisible()
      const section = cinna.page.getByRole('region', { name: 'Continue this task' })
      const picker = section.getByRole('combobox', { name: 'Continue with' })
      await expect(section.getByRole('status')).toHaveCount(0)
      await picker.selectOption({ label: IDLE })
      await expect(section.getByRole('status')).toHaveCount(0)
      await picker.selectOption({ label: AGENT })
      await expect(section.getByRole('status')).toHaveText(`${sentence} Open`)
      await expect(section.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
      await picker.selectOption({ label: IDLE })
      await expect(section.getByRole('status')).toHaveCount(0)
      await picker.selectOption({ label: AGENT })
      await expect(section.getByRole('status')).toHaveText(`${sentence} Open`)
    })

    await test.step('Open goes to the running chat', async () => {
      await cinna.page.getByRole('region', { name: 'Continue this task' }).getByRole('button', { name: 'Open', exact: true }).click()
      await expect(cinna.page.getByRole('paragraph').filter({ hasText: CHAT_PROMPT })).toBeVisible()
      await expect(cinna.page.getByRole('combobox', { name: RUNNING_COMPOSER, exact: true })).toBeVisible()
    })

    fake.calls[held.call].release('Shelf sorted.')
    await chatIdle(cinna, held.chatId)
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

/**
 * After **Open** has shown the running chat, the agent's new-chat composer is
 * still free to start one more session — the flow the warning invites. The
 * chat store's port stream is the running chat's, not this composer's, so it
 * offers Send, not Stop.
 */
test('after Open shows the running chat, the agent’s new-chat composer still offers Send', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await scriptAcpEngine()
  try {
    await arrangeScripted(cinna, fake)
    const { agentId } = await adoptBare(cinna, 'granite-return', AGENT)
    await relaunchAndRescan(cinna)
    const held = await startHeldChat(cinna, fake, agentId)

    await openAgentComposer(cinna, AGENT)
    await panel(cinna).getByRole('button', { name: 'Open', exact: true }).click()
    await expect(cinna.page.getByRole('combobox', { name: RUNNING_COMPOSER, exact: true })).toBeVisible()

    await openAgentComposer(cinna, AGENT)
    await expect(panel(cinna).getByText(conflict(`“${CHAT_TITLE}”`), { exact: true })).toBeVisible({ timeout: 15_000 })
    await composer(cinna).fill(SECOND_PROMPT)
    try {
      await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 10_000 })
    } finally {
      fake.calls[held.call].release('Shelf sorted.')
      await chatIdle(cinna, held.chatId)
    }
  } finally { await fake.close() }
})
