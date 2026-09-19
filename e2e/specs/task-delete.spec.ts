import type { Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { seedChatTask } from '../fixtures/seed'
import { heldA2aAgent } from '../fixtures/heldA2aAgent'

/**
 * Delete task, from the task page's ⋯ (`TaskActionsMenu.tsx`), against main's
 * `task:delete-preview` and `task:delete` (`taskService.removeWithJobRun`).
 *
 * ## What is real
 *
 * The job run is a real renderer turn started with the job page's **Run**,
 * against a hand-added A2A agent that holds its `message/send` until the test
 * answers (`heldA2aAgent`) — so while it is held, main really has a turn in
 * the run's chat (`activeRunsByChat`), which is what the refusal reads. The
 * plain task is `seedChatTask` on an ordinary chat (there is no task-creation
 * IPC). The failed delete replaces the `task:delete` handler in main with one
 * that throws — the only stub here, and only in that test.
 *
 * ## What it proves
 *
 * - A job-run task's dialog says the run and its chat are permanently deleted
 *   and the job stays; while the run is still going Delete is refused with
 *   main's sentence, the dialog stays open and task, run and chat all survive;
 *   once the run is over Delete takes task, run and chat, the page goes back to
 *   the job, and the row leaves Tasks history.
 * - A task not created by a job: the dialog says the chat stays, and it does.
 * - A delete that fails keeps the dialog open with the reason under the
 *   buttons, and the Delete button does not move.
 * - A local run's task has no "Open on the server" in its menu.
 *
 * ## What it does not
 *
 * The `in_trash` and `none` copies, a task whose job was deleted ("The job run
 * it came from…"), and a preview that fails to load (the menu's own alert).
 */

const JOB_TITLE = 'Weekly digest'
const JOB_PROMPT = 'Collect the week’s merged pull requests.'
const PLAIN_TITLE = 'Draft the launch note'
const RUN_ACTIVE = 'This run is still going. Stop it first; nothing was deleted.'

function taskMenu(page: Page) {
  return page.getByRole('menu', { name: 'Task actions', exact: true })
}

async function openDeleteDialog(page: Page) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await expect(taskMenu(page)).toBeVisible()
  await taskMenu(page).getByRole('menuitem', { name: 'Delete task…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete task', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

/** An ordinary chat with a title and one message, and a task bound to it. */
async function seedPlainTask(cinna: CinnaApp): Promise<{ chatId: string; taskId: string }> {
  const chatId = await cinna.page.evaluate(async (title) => {
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title })
    await window.api.chat.addMessage(chat.id, { role: 'user', content: 'Write the launch note.' })
    return chat.id
  }, PLAIN_TITLE)
  const taskId = await seedChatTask(cinna, { chatId, title: PLAIN_TITLE })
  return { chatId, taskId }
}

async function openTaskFromInbox(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: /^Inbox/ }).click()
  await page.getByRole('region', { name: 'Recent tasks', exact: true }).getByRole('button', { name: title }).click()
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
}

test('a job-run task: refused while its run goes, then deleted with its run and chat, and the job stays', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const fake = await heldA2aAgent()
  try {
    await cinna.skipOnboarding()
    const agentId = await fake.register(cinna, 'Digest Agent')
    const jobId = await cinna.page.evaluate(
      async ({ agentId, title, prompt }) => {
        const job = await window.api.jobs.create({ type: 'local', title, prompt })
        await window.api.jobs.setAgents(job.id, [agentId])
        return job.id
      },
      { agentId, title: JOB_TITLE, prompt: JOB_PROMPT }
    )
    await cinna.relaunch()
    await cinna.skipOnboarding()

    await test.step('the job is run from its page, and the turn is held', async () => {
      const page = cinna.page
      await page.getByRole('button', { name: 'Jobs', exact: true }).click()
      await page.getByText(JOB_TITLE, { exact: true }).first().click()
      await page.getByRole('button', { name: 'Run', exact: true }).click()
      await expect.poll(() => fake.calls.length, { timeout: 30_000 }).toBe(1)
      expect(fake.calls[0].text).toContain(JOB_PROMPT)
      // Run opens the chat; the banner leads back to the job.
      await page.getByRole('button', { name: `From job ${JOB_TITLE}`, exact: true }).click()
      await page
        .getByRole('region', { name: 'Tasks history', exact: true })
        .getByRole('button', { name: / — running$/ })
        .click()
      await expect(page.getByRole('heading', { level: 1, name: JOB_TITLE, exact: true })).toBeVisible()
    })

    const [run] = await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId)
    expect(run).toMatchObject({ status: 'running', taskId: expect.any(String), localChatId: expect.any(String) })
    const taskId = run.taskId!
    const chatId = run.localChatId!

    await test.step('the menu has no Open on the server for a local run', async () => {
      const page = cinna.page
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      const items = taskMenu(page).getByRole('menuitem')
      await expect(items).toHaveCount(2)
      await expect(items.nth(0)).toHaveAccessibleName('Show in the Chats list')
      await expect(items.nth(1)).toHaveAccessibleName('Delete task…')
      await expect(taskMenu(page).getByRole('menuitem', { name: 'Open on the server' })).toHaveCount(0)
      // The trigger toggles it shut again.
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      await expect(taskMenu(page)).toHaveCount(0)
    })

    await test.step('the dialog says the run and its chat go, and the job stays', async () => {
      const dialog = await openDeleteDialog(cinna.page)
      await expect(dialog.locator('p')).toHaveText(
        `Delete ${JOB_TITLE}? The job stays. This run of it and the chat it ran in are permanently deleted with the task — this can't be undone.`
      )
    })

    await test.step('while the run is still going, Delete is refused and nothing goes', async () => {
      const page = cinna.page
      const dialog = page.getByRole('dialog', { name: 'Delete task', exact: true })
      const del = dialog.getByRole('button', { name: 'Delete', exact: true })
      const before = await del.boundingBox()
      await del.click()
      await expect(dialog.getByRole('alert')).toHaveText(RUN_ACTIVE)
      await expect(dialog).toBeVisible()
      expect(await del.boundingBox()).toEqual(before)
      const survived = await page.evaluate(
        async ({ jobId, taskId, chatId }) => ({
          task: (await window.api.tasks.list()).some((t) => t.id === taskId),
          runs: (await window.api.jobs.listRuns(jobId)).map((r) => r.taskId),
          chat: (await window.api.chat.get(chatId))?.id ?? null
        }),
        { jobId, taskId, chatId }
      )
      expect(survived).toEqual({ task: true, runs: [taskId], chat: chatId })
    })

    await test.step('once the run is over, Delete takes the task, its run and its chat, and the job stays', async () => {
      fake.calls[0].release('Seven pull requests merged this week.')
      await expect
        .poll(async () => (await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId))[0]?.status)
        .toBe('succeeded')
      const page = cinna.page
      const dialog = page.getByRole('dialog', { name: 'Delete task', exact: true })
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      // Back on the job's page, with nothing left in its history.
      await expect(page.getByRole('heading', { level: 1, name: JOB_TITLE, exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible()
      const history = page.getByRole('region', { name: 'Tasks history', exact: true })
      await expect(history).toBeVisible()
      await expect(history.getByRole('button')).toHaveCount(0)
      const after = await page.evaluate(
        async ({ jobId, taskId, chatId }) => ({
          task: (await window.api.tasks.list()).some((t) => t.id === taskId),
          runs: (await window.api.jobs.listRuns(jobId)).length,
          chat: await window.api.chat.get(chatId),
          trashed: (await window.api.chat.trashList()).some((c) => c.id === chatId),
          job: (await window.api.jobs.get(jobId)).title
        }),
        { jobId, taskId, chatId }
      )
      expect(after).toEqual({ task: false, runs: 0, chat: null, trashed: false, job: JOB_TITLE })
    })
  } finally {
    await fake.close()
  }
})

test('a task not created by a job: the dialog says its chat stays, and it does', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const { chatId, taskId } = await seedPlainTask(cinna)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await openTaskFromInbox(cinna.page, PLAIN_TITLE)

  const dialog = await openDeleteDialog(cinna.page)
  await expect(dialog.locator('p')).toHaveText(
    `Delete ${PLAIN_TITLE}? The chat it ran in stays. The task can't be restored.`
  )
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  // No job to go back to: the page goes back to the Inbox.
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(
    cinna.page.getByRole('region', { name: 'Recent tasks', exact: true }).getByRole('button', { name: PLAIN_TITLE })
  ).toHaveCount(0)
  const after = await cinna.page.evaluate(
    async ({ taskId, chatId }) => {
      const chat = await window.api.chat.get(chatId)
      return {
        task: (await window.api.tasks.list()).some((t) => t.id === taskId),
        chat: chat ? { id: chat.id, deletedAt: chat.deletedAt } : null,
        listed: (await window.api.chat.list()).some((c) => c.id === chatId)
      }
    },
    { taskId, chatId }
  )
  expect(after).toEqual({ task: false, chat: { id: chatId, deletedAt: null }, listed: true })
})

test('a delete that fails keeps the dialog open with the reason, and Delete does not move', async ({ cinna }) => {
  const REASON = 'The database refused the write (E2E stub).'
  await cinna.skipOnboarding()
  const { chatId, taskId } = await seedPlainTask(cinna)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  // After the last relaunch: handlers belong to the process.
  await cinna.electronApp.evaluate(({ ipcMain }, reason) => {
    ipcMain.removeHandler('task:delete')
    ipcMain.handle('task:delete', () => {
      throw new Error(reason)
    })
  }, REASON)
  await openTaskFromInbox(cinna.page, PLAIN_TITLE)

  const dialog = await openDeleteDialog(cinna.page)
  const del = dialog.getByRole('button', { name: 'Delete', exact: true })
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const before = { del: await del.boundingBox(), cancel: await cancel.boundingBox() }
  await del.click()
  await expect(dialog.getByRole('alert')).toHaveText(REASON)
  await expect(dialog).toBeVisible()
  await expect(del).toBeEnabled()
  expect({ del: await del.boundingBox(), cancel: await cancel.boundingBox() }).toEqual(before)
  // Still on the task's page, and nothing went.
  await expect(cinna.page.getByRole('heading', { level: 1, name: PLAIN_TITLE, exact: true })).toBeVisible()
  const after = await cinna.page.evaluate(
    async ({ taskId, chatId }) => ({
      task: (await window.api.tasks.list()).some((t) => t.id === taskId),
      chat: await window.api.chat.get(chatId).then((chat) => (chat ? chat.deletedAt : 'missing'))
    }),
    { taskId, chatId }
  )
  expect(after).toEqual({ task: true, chat: null })
})
