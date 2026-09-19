import type { Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { seedChatTask } from '../fixtures/seed'
import { heldA2aAgent } from '../fixtures/heldA2aAgent'

/**
 * "Show in the Chats list" on the task page's ⋯ (`TaskActionsMenu.tsx`): the
 * chat is moved out of hiding when a job spawned it, the sidebar switches to
 * Chats and the row flashes (`ChatItem`'s `data-revealed`), and the task page
 * stays where it is.
 *
 * ## What is real
 *
 * The job-spawned chat is made by `jobs.execute` over IPC — the same row, run
 * and hidden chat a Run makes, with no turn started, which is all this item
 * needs. `chat:show-in-list` is main's own in the first test; in the second it
 * is replaced by a recorder after the last relaunch, because the claim there is
 * that it is *not* called. The Trash is `chat.delete`.
 *
 * ## What it proves
 *
 * - A hidden job chat: after the click it is in the Chats list (main's
 *   `chat.list` and the sidebar), the Chats tab is the pressed one, its row is
 *   the revealed one, and the task page is still open.
 * - A chat already listed is revealed without `chat:show-in-list` being called.
 * - A chat in the Trash: the item is disabled with `The chat is in the Trash.`
 *   as visible text, and a click on it changes nothing.
 *
 * ## What it does not
 *
 * The scroll into view of a row below the fold, the failure path (the page's
 * error line and the withdrawn reveal), and a chat that is gone altogether
 * (`The chat was deleted.`).
 */

const JOB_TITLE = 'Tidy the backlog'
const PLAIN_TITLE = 'Plan the offsite'

function sidebar(page: Page) {
  return page.locator('.app-sidebar-wrap')
}

async function openTaskFromInbox(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: /^Inbox/ }).click()
  await page.getByRole('region', { name: 'Recent tasks', exact: true }).getByRole('button', { name: title }).click()
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
}

async function openTaskMenu(page: Page) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Task actions', exact: true })
  await expect(menu).toBeVisible()
  return menu
}

async function seedPlainTask(cinna: CinnaApp, trashed = false): Promise<{ chatId: string; taskId: string }> {
  const chatId = await cinna.page.evaluate(async (title) => {
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title })
    await window.api.chat.addMessage(chat.id, { role: 'user', content: 'Where should the offsite be?' })
    return chat.id
  }, PLAIN_TITLE)
  const taskId = await seedChatTask(cinna, { chatId, title: PLAIN_TITLE })
  if (trashed) await cinna.page.evaluate((id) => window.api.chat.delete(id), chatId)
  return { chatId, taskId }
}

async function chatState(cinna: CinnaApp, chatId: string) {
  return cinna.page.evaluate(async (id) => {
    const chat = await window.api.chat.get(id)
    return {
      hidden: !!chat?.hiddenFromList,
      listed: (await window.api.chat.list()).some((c) => c.id === id)
    }
  }, chatId)
}

test('a hidden job chat is moved into the Chats list and revealed there, and the task page stays', async ({
  cinna
}) => {
  const fake = await heldA2aAgent()
  try {
    await cinna.skipOnboarding()
    const agentId = await fake.register(cinna, 'Backlog Agent')
    const jobId = await cinna.page.evaluate(
      async ({ agentId, title }) => {
        const job = await window.api.jobs.create({ type: 'local', title, prompt: 'Close stale issues.' })
        await window.api.jobs.setAgents(job.id, [agentId])
        return job.id
      },
      { agentId, title: JOB_TITLE }
    )
    await cinna.relaunch()
    await cinna.skipOnboarding()
    const executed = await cinna.page.evaluate((id) => window.api.jobs.execute(id), jobId)
    const chatId = executed.chatId!
    expect(await chatState(cinna, chatId)).toEqual({ hidden: true, listed: false })

    const page = cinna.page
    // Start from another tab, so the switch to Chats is something that happens.
    await page.getByRole('button', { name: 'Jobs', exact: true }).click()
    await openTaskFromInbox(page, JOB_TITLE)
    const menu = await openTaskMenu(page)
    await menu.getByRole('menuitem', { name: 'Show in the Chats list', exact: true }).click()

    await expect(page.getByRole('button', { name: 'Chats', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Jobs', exact: true })).toHaveAttribute('aria-pressed', 'false')
    const revealed = sidebar(page).locator('[data-revealed="true"]')
    await expect(revealed).toHaveCount(1)
    await expect(revealed).toHaveText(JOB_TITLE)
    // The row outlives the flash: it is in the list now, not just lit.
    await expect(sidebar(page).getByText(JOB_TITLE, { exact: true })).toBeVisible()
    // Still the task's page, not the chat.
    await expect(page.getByRole('heading', { level: 1, name: JOB_TITLE, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open the chat', exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveCount(0)
    expect(await chatState(cinna, chatId)).toEqual({ hidden: false, listed: true })
  } finally {
    await fake.close()
  }
})

test('a chat already in the list is revealed without being moved', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const { chatId } = await seedPlainTask(cinna)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.electronApp.evaluate(({ ipcMain }) => {
    const g = globalThis as { __e2eShowInListCalls?: number }
    g.__e2eShowInListCalls = 0
    ipcMain.removeHandler('chat:show-in-list')
    ipcMain.handle('chat:show-in-list', () => {
      g.__e2eShowInListCalls = (g.__e2eShowInListCalls ?? 0) + 1
      return { success: true }
    })
  })
  expect(await chatState(cinna, chatId)).toEqual({ hidden: false, listed: true })

  const page = cinna.page
  await page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await openTaskFromInbox(page, PLAIN_TITLE)
  const menu = await openTaskMenu(page)
  await menu.getByRole('menuitem', { name: 'Show in the Chats list', exact: true }).click()

  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const revealed = sidebar(page).locator('[data-revealed="true"]')
  await expect(revealed).toHaveCount(1)
  await expect(revealed).toHaveText(PLAIN_TITLE)
  await expect(page.getByRole('heading', { level: 1, name: PLAIN_TITLE, exact: true })).toBeVisible()
  expect(
    await cinna.electronApp.evaluate(() => (globalThis as { __e2eShowInListCalls?: number }).__e2eShowInListCalls)
  ).toBe(0)
  expect(await chatState(cinna, chatId)).toEqual({ hidden: false, listed: true })
})

test('a chat in the Trash: the item is disabled and says so', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const { chatId } = await seedPlainTask(cinna, true)
  await cinna.relaunch()
  await cinna.skipOnboarding()

  const page = cinna.page
  await page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await openTaskFromInbox(page, PLAIN_TITLE)
  const menu = await openTaskMenu(page)
  const item = menu.getByRole('menuitem', { name: 'Show in the Chats list', exact: true })
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await expect(item).toHaveAccessibleDescription('The chat is in the Trash.')
  await expect(item.getByText('The chat is in the Trash.', { exact: true })).toBeVisible()
  // `force`: Playwright will not click an aria-disabled item itself; what a
  // click does is the point — nothing.
  await item.click({ force: true })
  await expect(menu).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(
    await page.evaluate(async (id) => (await window.api.chat.trashList()).some((c) => c.id === id), chatId)
  ).toBe(true)
})
