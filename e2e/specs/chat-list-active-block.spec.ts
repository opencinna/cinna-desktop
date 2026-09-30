import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * The Chats list's Active block: a chat with an unread result is drawn in
 * `group` "Active" above Pinned and taken out of its agent group; clicking it
 * there reads the result, but the row holds its place while the pointer stays
 * on the list; once the pointer leaves, the chat goes back to its group, which
 * opens around it (the reveal), still selected. The Chats list options menu's "Show
 * Active group" switch, off by default, takes the block away.
 *
 * Arranged over IPC with no model, engine or credential: one hand-added A2A
 * agent on a closed loopback port (never contacted — no turn runs). An unread
 * result is a `chat_run_results` row with `unread = 1`, written through a
 * second handle on the sandbox database — the same row a finished background
 * run leaves (`chat-session-status.spec.ts` proves that half with a real turn).
 * `chat:list` is polled every second, so a row written while the app runs
 * reaches the list without a restart.
 */

const AGENT = 'Writer'
const UNREAD = 'E2E unread report chat'
const SIBLING = 'E2E writer draft chat'
const PINNED = 'E2E pinned plain chat'
const UNREAD_NOTE = 'The report is ready for review.'

/** A loopback port nothing listens on: bound once, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** An unread `completed` result on `chatId`, as a finished background run leaves it. */
async function seedUnreadResult(cinna: CinnaApp, chatId: string, runId: string): Promise<void> {
  await cinna.electronApp.evaluate(({ app }, row) => {
    if (app.getPath('userData') !== row.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${row.userData}/cinna.db`, { fileMustExist: true })
    try {
      db.prepare(`INSERT INTO chat_run_results (chat_id, run_id, status, unread) VALUES (?, ?, 'completed', 1)
        ON CONFLICT(chat_id) DO UPDATE SET run_id = excluded.run_id, status = excluded.status, unread = 1`)
        .run(row.chatId, row.runId)
    } finally { db.close() }
  }, { userData: cinna.sandbox.userData, chatId, runId })
}

const activeGroup = (cinna: CinnaApp) => cinna.page.getByRole('group', { name: 'Active', exact: true })
const rowOf = (cinna: CinnaApp, id: string) => cinna.page.locator(`[data-chat-row="${id}"]`)
const header = (cinna: CinnaApp, name: string) => cinna.page.getByRole('button', { name, exact: true })
/** A group header's whole group: header button → header row → the group's container. */
const groupOf = (cinna: CinnaApp, name: string) => header(cinna, name).locator('xpath=../..')
const rowIds = (scope: ReturnType<CinnaApp['page']['locator']>) =>
  scope.locator('[data-chat-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-chat-row')))
/** The Active block and every group header, top to bottom. */
const blockOrder = (cinna: CinnaApp) =>
  cinna.page
    .locator('[role="group"][aria-label="Active"], button[data-chat-group]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent))
const menuItem = (cinna: CinnaApp, name: string) => cinna.page.getByRole('menuitemcheckbox', { name, exact: true })

test('an unread chat sits in the Active block, holds under the pointer, then returns to its opened group; the menu switch removes the block', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const host = `http://127.0.0.1:${await closedPort()}`

  const ids = await cinna.page.evaluate(async (input) => {
    await window.api.settings.set('autoChatTitles', false)
    const made = await window.api.agents.upsert({ name: input.agent, protocol: 'a2a',
      cardUrl: `${input.host}/.well-known/agent-card.json`, endpointUrl: `${input.host}/a2a` })
    if (!made.success || !made.id) throw new Error(`Could not create agent ${input.agent}`)
    const make = async (title: string, content: string, patch: Record<string, unknown>): Promise<string> => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { title, ...patch })
      await window.api.chat.addMessage(chat.id, { role: 'user', content })
      return chat.id
    }
    const pinned = await make(input.pinned, 'Hello from the pinned chat', {})
    await window.api.chat.setPinned(pinned, true)
    return {
      agentId: made.id,
      pinned,
      sibling: await make(input.sibling, 'Hello from the draft chat', { agentId: made.id, router: 'direct' }),
      unread: await make(input.unread, input.note, { agentId: made.id, router: 'direct' })
    }
  }, { host, agent: AGENT, unread: UNREAD, sibling: SIBLING, pinned: PINNED, note: UNREAD_NOTE })
  await seedUnreadResult(cinna, ids.unread, 'e2e-seeded-run-1')

  // What main believes before any screen is involved.
  const listed = await cinna.page.evaluate(() => window.api.chat.list())
  expect(listed.find((chat) => chat.id === ids.unread)?.lastRunResult)
    .toEqual({ runId: 'e2e-seeded-run-1', status: 'completed', unread: true })

  // The summaries the groups are built from are unpolled.
  await cinna.relaunch()
  await cinna.skipOnboarding()

  await test.step('Group by Agent, then collapse the unread chat\'s group', async () => {
    await cinna.page.getByRole('button', { name: 'Chats list options', exact: true }).click()
    await expect(cinna.page.getByRole('menu', { name: 'Chats list options' })).toBeVisible()
    // Off until the user turns it on.
    await expect(menuItem(cinna, 'Show Active group')).toHaveAttribute('aria-checked', 'false')
    await menuItem(cinna, 'Show Active group').click()
    await expect(menuItem(cinna, 'Show Active group')).toHaveAttribute('aria-checked', 'true')
    await menuItem(cinna, 'Group by Agent').click()
    await expect(menuItem(cinna, 'Group by Agent')).toHaveAttribute('aria-checked', 'true')
    await cinna.page.keyboard.press('Escape')
    await expect(cinna.page.getByRole('menu', { name: 'Chats list options' })).toHaveCount(0)

    // Expanded, the Writer group shows it holds only the other chat.
    await expect(header(cinna, AGENT)).toHaveAttribute('aria-expanded', 'true')
    await expect(rowOf(cinna, ids.sibling)).toBeVisible()
    expect(await rowIds(groupOf(cinna, AGENT))).toEqual([ids.sibling])
    await header(cinna, AGENT).click()
    await expect(header(cinna, AGENT)).toHaveAttribute('aria-expanded', 'false')
    await expect(rowOf(cinna, ids.sibling)).toHaveCount(0)
  })

  await test.step('Active is at the top, above Pinned, and holds the unread chat alone', async () => {
    await expect(activeGroup(cinna)).toBeVisible()
    expect(await blockOrder(cinna)).toEqual(['Active', 'Pinned', AGENT])
    expect(await rowIds(activeGroup(cinna))).toEqual([ids.unread])
    await expect(activeGroup(cinna).getByRole('img', { name: 'Completed — unread results', exact: true })).toBeVisible()
    // Drawn once: not in Pinned, not in its (closed) group.
    await expect(rowOf(cinna, ids.unread)).toHaveCount(1)
    expect(await rowIds(groupOf(cinna, 'Pinned'))).toEqual([ids.pinned])
    expect(await rowIds(groupOf(cinna, AGENT))).toEqual([])
  })

  const box = await rowOf(cinna, ids.unread).boundingBox()
  if (!box) throw new Error('The unread row has no box')
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await test.step('Clicking it reads the result, and the row holds while the pointer stays on the list', async () => {
    await cinna.page.mouse.click(at.x, at.y)
    await expect(cinna.page.getByText(UNREAD_NOTE, { exact: true })).toBeVisible()
    // Read in main, and in the renderer's list (the unread icon is gone)...
    await expect.poll(async () =>
      (await cinna.page.evaluate(() => window.api.chat.list())).find((chat) => chat.id === ids.unread)?.lastRunResult?.unread
    ).toBe(false)
    await expect(rowOf(cinna, ids.unread).getByRole('img')).toHaveCount(0)
    // ...and still in the block, under the pointer.
    expect(await rowIds(activeGroup(cinna))).toEqual([ids.unread])
    expect(await cinna.page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('[data-chat-row]')?.getAttribute('data-chat-row') ?? null, at)).toBe(ids.unread)
    await expect(rowOf(cinna, ids.unread)).toHaveClass(/app-nav-active/)
  })

  await test.step('Moving off the list sends it back to its group, opened around it, still selected', async () => {
    const composer = await cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true }).boundingBox()
    if (!composer) throw new Error('The composer has no box')
    await cinna.page.mouse.move(composer.x + composer.width / 2, composer.y + composer.height / 2, { steps: 5 })

    await expect(activeGroup(cinna)).toHaveCount(0)
    await expect(header(cinna, AGENT)).toHaveAttribute('aria-expanded', 'true')
    await expect(rowOf(cinna, ids.unread)).toHaveAttribute('data-revealed', 'true')
    await expect(rowOf(cinna, ids.unread)).toBeVisible()
    await expect(rowOf(cinna, ids.unread)).toHaveClass(/app-nav-active/)
    await expect(rowOf(cinna, ids.unread)).toHaveCount(1)
    expect((await rowIds(groupOf(cinna, AGENT))).sort()).toEqual([ids.sibling, ids.unread].sort())
    expect(await blockOrder(cinna)).toEqual(['Pinned', AGENT])
    await expect(cinna.page.getByText(UNREAD_NOTE, { exact: true })).toBeVisible()
  })

  await test.step('Unchecking "Show Active group" removes the block and returns its chat to its group', async () => {
    // A second unread result, while the pointer is off the list: it joins the block on the next poll.
    await seedUnreadResult(cinna, ids.sibling, 'e2e-seeded-run-2')
    await expect(activeGroup(cinna)).toBeVisible()
    expect(await rowIds(activeGroup(cinna))).toEqual([ids.sibling])
    expect(await rowIds(groupOf(cinna, AGENT))).toEqual([ids.unread])

    await cinna.page.getByRole('button', { name: 'Chats list options', exact: true }).click()
    await expect(cinna.page.getByRole('menu', { name: 'Chats list options' })).toBeVisible()
    await expect(menuItem(cinna, 'Show Active group')).toHaveAttribute('aria-checked', 'true')
    await menuItem(cinna, 'Show Active group').click()
    // A pick keeps the menu open.
    await expect(menuItem(cinna, 'Show Active group')).toHaveAttribute('aria-checked', 'false')
    await expect(activeGroup(cinna)).toHaveCount(0)
    await expect(rowOf(cinna, ids.sibling)).toBeVisible()
    await expect(rowOf(cinna, ids.sibling).getByRole('img', { name: 'Completed — unread results', exact: true })).toBeVisible()
    expect((await rowIds(groupOf(cinna, AGENT))).sort()).toEqual([ids.sibling, ids.unread].sort())
    expect(await blockOrder(cinna)).toEqual(['Pinned', AGENT])
  })
})
