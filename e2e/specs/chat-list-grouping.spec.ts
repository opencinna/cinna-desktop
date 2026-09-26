import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * The Chats list's "Group chats" menu: Group by Agent puts each chat under who
 * it is with (an agent, a chat mode, or the plain "Chat" group); Group by Date
 * splits into Today / Yesterday / Last Week / Previous chats by the last
 * message, nested inside the agent groups or at the top when Agent is off.
 * Groups collapse, a group's start-chat button opens the new-chat screen with
 * its agent or mode preselected, and all of it survives a restart.
 *
 * Arranged over IPC with no model, engine or credential: one hand-added A2A
 * agent on a closed loopback port (never contacted — no turn runs), one chat
 * mode, and messages written through `chat:add-message`. There is no IPC to
 * date a message, so the message and chat timestamps are moved back through a
 * second handle on the sandbox database; the summaries query is unpolled, so a
 * `relaunch()` follows.
 */

const AGENT = 'Writer'
const MODE = 'Research Mode'
const WRITER_TODAY = 'E2E writer today chat'
const WRITER_OLD = 'E2E writer old chat'
const MODE_YESTERDAY = 'E2E mode yesterday chat'
const PLAIN_LAST_WEEK = 'E2E plain last week chat'
const ALL_CHATS = [WRITER_TODAY, WRITER_OLD, MODE_YESTERDAY, PLAIN_LAST_WEEK]

/** A loopback port nothing listens on: bound once, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Move a chat's messages and its row's `updated_at` to `at` (epoch seconds). */
async function backdate(cinna: CinnaApp, stamps: Record<string, number>): Promise<void> {
  await cinna.electronApp.evaluate(({ app }, row) => {
    if (app.getPath('userData') !== row.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${row.userData}/cinna.db`, { fileMustExist: true })
    try {
      for (const [chatId, at] of Object.entries(row.stamps)) {
        db.prepare('UPDATE messages SET created_at = ? WHERE chat_id = ?').run(at, chatId)
        db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(at, chatId)
      }
    } finally { db.close() }
  }, { userData: cinna.sandbox.userData, stamps })
}

/** A group header's toggle, named `<label>, <n> chat(s)`. */
const header = (cinna: CinnaApp, name: string) => cinna.page.getByRole('button', { name, exact: true })

/** Every group header's name, top to bottom. */
const headerNames = (cinna: CinnaApp) =>
  cinna.page
    .locator('button[data-chat-group]')
    .evaluateAll((buttons) => buttons.map((button) => button.textContent))

const chatRow = (cinna: CinnaApp, title: string) => cinna.page.getByText(title, { exact: true })

async function openMenu(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Group chats', exact: true }).click()
  await expect(cinna.page.getByRole('menu', { name: 'Group chats' })).toBeVisible()
}

async function closeMenu(cinna: CinnaApp): Promise<void> {
  await cinna.page.keyboard.press('Escape')
  await expect(cinna.page.getByRole('menu', { name: 'Group chats' })).toHaveCount(0)
}

const menuItem = (cinna: CinnaApp, name: 'Group by Agent' | 'Group by Date') =>
  cinna.page.getByRole('menuitemcheckbox', { name, exact: true })

/** The new-chat composer's `[+]` → Chat mode → whether `mode` is the checked one. */
async function expectModeChecked(cinna: CinnaApp, checked: boolean): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Add to chat', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Chat mode', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: MODE })).toHaveAttribute('aria-checked', String(checked))
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitemradio', { name: MODE })).toHaveCount(0)
}

test('Chats list groups by agent and by date, collapses, starts a chat from a group, and keeps it all across a restart', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const host = `http://127.0.0.1:${await closedPort()}`

  const ids = await cinna.page.evaluate(async (input) => {
    await window.api.settings.set('autoChatTitles', false)
    const made = await window.api.agents.upsert({ name: input.agent, protocol: 'a2a',
      cardUrl: `${input.host}/.well-known/agent-card.json`, endpointUrl: `${input.host}/a2a` })
    if (!made.success || !made.id) throw new Error(`Could not create agent ${input.agent}`)
    const mode = await window.api.chatModes.upsert({ name: input.mode, colorPreset: 'blue' })
    const make = async (title: string, patch: Record<string, unknown>): Promise<string> => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { title, ...patch })
      await window.api.chat.addMessage(chat.id, { role: 'user', content: `Hello from ${title}` })
      return chat.id
    }
    return {
      today: await make(input.today, { agentId: made.id, router: 'direct' }),
      old: await make(input.old, { agentId: made.id, router: 'direct' }),
      mode: await make(input.modeChat, { modeId: mode.id }),
      plain: await make(input.plain, {})
    }
  }, { host, agent: AGENT, mode: MODE, today: WRITER_TODAY, old: WRITER_OLD, modeChat: MODE_YESTERDAY, plain: PLAIN_LAST_WEEK })

  // Calendar days in this machine's zone — the app's zone too. Clear of every
  // bucket edge: noon yesterday, three and a half days back, a month back.
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const seconds = (ms: number): number => Math.floor(ms / 1000)
  const HOUR = 3_600_000
  await backdate(cinna, {
    [ids.mode]: seconds(midnight - 12 * HOUR),
    [ids.plain]: seconds(midnight - 84 * HOUR),
    [ids.old]: seconds(midnight - 30 * 24 * HOUR)
  })

  // What main believes, before any screen is involved: the date each row is placed by.
  const summaries = await cinna.page.evaluate(() => window.api.chat.listSummaries())
  expect(new Date(summaries[ids.old].lastMessageAt ?? 0).getTime()).toBe((midnight - 30 * 24 * HOUR))
  expect(summaries[ids.mode].with).toMatchObject({ kind: 'mode', name: MODE })
  expect(summaries[ids.plain].with).toMatchObject({ kind: 'none' })

  await cinna.relaunch()
  await cinna.skipOnboarding()
  for (const title of ALL_CHATS) await expect(chatRow(cinna, title)).toBeVisible()
  expect(await headerNames(cinna)).toEqual([])

  await test.step('Group by Agent: agent, chat mode and plain "Chat" groups', async () => {
    await openMenu(cinna)
    await expect(menuItem(cinna, 'Group by Agent')).toHaveAttribute('aria-checked', 'false')
    await expect(menuItem(cinna, 'Group by Date')).toHaveAttribute('aria-checked', 'false')
    await menuItem(cinna, 'Group by Agent').click()
    // A pick keeps the menu open.
    await expect(menuItem(cinna, 'Group by Agent')).toHaveAttribute('aria-checked', 'true')
    await closeMenu(cinna)

    await expect.poll(() => headerNames(cinna)).toEqual(['Writer', 'Research Mode', 'Chat'])
    for (const title of ALL_CHATS) await expect(chatRow(cinna, title)).toBeVisible()
  })

  await test.step('collapse a group hides only its chats; expand brings them back', async () => {
    const writer = header(cinna, 'Writer')
    await expect(writer).toHaveAttribute('aria-expanded', 'true')
    await writer.click()
    await expect(writer).toHaveAttribute('aria-expanded', 'false')
    await expect(chatRow(cinna, WRITER_TODAY)).toHaveCount(0)
    await expect(chatRow(cinna, WRITER_OLD)).toHaveCount(0)
    await expect(chatRow(cinna, MODE_YESTERDAY)).toBeVisible()
    await expect(chatRow(cinna, PLAIN_LAST_WEEK)).toBeVisible()

    await writer.click()
    await expect(writer).toHaveAttribute('aria-expanded', 'true')
    await expect(chatRow(cinna, WRITER_TODAY)).toBeVisible()
    await expect(chatRow(cinna, WRITER_OLD)).toBeVisible()
  })

  await test.step('Group by Date too: only the non-empty days, nested inside each agent group', async () => {
    await openMenu(cinna)
    await menuItem(cinna, 'Group by Date').click()
    await expect(menuItem(cinna, 'Group by Date')).toHaveAttribute('aria-checked', 'true')
    await expect(menuItem(cinna, 'Group by Agent')).toHaveAttribute('aria-checked', 'true')
    await closeMenu(cinna)

    await expect.poll(() => headerNames(cinna)).toEqual([
      'Writer', 'Today', 'Previous chats',
      'Research Mode', 'Yesterday',
      'Chat', 'Last Week'
    ])
    // Beside Today, Writer's older history starts closed.
    await expect(header(cinna, 'Previous chats')).toHaveAttribute('aria-expanded', 'false')
    await expect(chatRow(cinna, WRITER_OLD)).toHaveCount(0)
    // Nested: collapsing Writer hides its days, not anyone else's.
    await header(cinna, 'Writer').click()
    await expect.poll(() => headerNames(cinna)).toEqual([
      'Writer', 'Research Mode', 'Yesterday', 'Chat', 'Last Week'
    ])
    await header(cinna, 'Writer').click()
    await expect(header(cinna, 'Today')).toBeVisible()
  })

  await test.step('Group by Agent off: the days become the top level, in fixed order', async () => {
    await openMenu(cinna)
    await menuItem(cinna, 'Group by Agent').click()
    await expect(menuItem(cinna, 'Group by Agent')).toHaveAttribute('aria-checked', 'false')
    await closeMenu(cinna)

    await expect.poll(() => headerNames(cinna)).toEqual([
      'Today', 'Yesterday', 'Last Week', 'Previous chats'
    ])
    await expect(cinna.page.getByRole('button', { name: /^Start a new chat/ })).toHaveCount(0)
    // Previous chats starts closed beside the other days; a click opens it.
    await expect(header(cinna, 'Previous chats')).toHaveAttribute('aria-expanded', 'false')
    await expect(chatRow(cinna, WRITER_OLD)).toHaveCount(0)
    await header(cinna, 'Previous chats').click()
    for (const title of ALL_CHATS) await expect(chatRow(cinna, title)).toBeVisible()

    // Collapsed here, to be found collapsed after the restart.
    await header(cinna, 'Yesterday').click()
    await expect(header(cinna, 'Yesterday')).toHaveAttribute('aria-expanded', 'false')
    await expect(chatRow(cinna, MODE_YESTERDAY)).toHaveCount(0)
  })

  await test.step('the grouping and the collapsed group survive a relaunch', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await expect.poll(() => headerNames(cinna)).toEqual([
      'Today', 'Yesterday', 'Last Week', 'Previous chats'
    ])
    await expect(header(cinna, 'Yesterday')).toHaveAttribute('aria-expanded', 'false')
    await expect(chatRow(cinna, MODE_YESTERDAY)).toHaveCount(0)
    await expect(chatRow(cinna, WRITER_TODAY)).toBeVisible()
    await openMenu(cinna)
    await expect(menuItem(cinna, 'Group by Agent')).toHaveAttribute('aria-checked', 'false')
    await expect(menuItem(cinna, 'Group by Date')).toHaveAttribute('aria-checked', 'true')
    await menuItem(cinna, 'Group by Agent').click()
    await closeMenu(cinna)
    await expect(header(cinna, 'Writer')).toBeVisible()
  })

  await test.step('a mode group\'s start button: the new-chat screen in that mode', async () => {
    // From inside an open chat, so landing on the new-chat screen is the button's doing.
    await chatRow(cinna, WRITER_TODAY).click()
    await expect(cinna.page.getByText(`Hello from ${WRITER_TODAY}`, { exact: true }).first()).toBeVisible()
    await expect(cinna.page.getByRole('heading', { name: 'What can I help with?' })).toHaveCount(0)

    await header(cinna, 'Research Mode').hover()
    await cinna.page.getByRole('button', { name: `Start a new chat in ${MODE}`, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: 'What can I help with?', level: 1 })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: `Remove agent ${AGENT}`, exact: true })).toHaveCount(0)
    await expectModeChecked(cinna, true)
  })

  await test.step('the plain "Chat" group\'s start button: a new chat with no mode', async () => {
    await header(cinna, 'Chat').hover()
    await cinna.page.getByRole('button', { name: 'Start a new chat without a mode', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: 'What can I help with?', level: 1 })).toBeVisible()
    await expectModeChecked(cinna, false)
  })

  await test.step('an agent group\'s start button: the new-chat screen with that agent selected', async () => {
    // Writer's own Previous chats is still closed by default.
    await header(cinna, 'Previous chats').click()
    await chatRow(cinna, WRITER_OLD).click()
    await expect(cinna.page.getByText(`Hello from ${WRITER_OLD}`, { exact: true }).first()).toBeVisible()

    await header(cinna, 'Writer').hover()
    await cinna.page.getByRole('button', { name: `Start a new chat with ${AGENT}`, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: 'What can I help with?', level: 1 })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: `Remove agent ${AGENT}`, exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('status', { name: 'Remote agent connection', exact: true })).toBeVisible()
    // The start button toggles nothing: the group stays open.
    await expect(header(cinna, 'Writer')).toHaveAttribute('aria-expanded', 'true')
  })
})
