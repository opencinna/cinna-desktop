import type { Locator, Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { heldA2aAgent } from '../fixtures/heldA2aAgent'

/**
 * A job run whose task is gone (`JobRunRow.tsx`, `taskLive: false`): its row
 * in the job page's Tasks history opens the run's chat and carries its own ⋯
 * with Delete run, placed before the duration. A run whose task is live has
 * neither — its actions are on the task's page.
 *
 * ## What is real
 *
 * Three real runs, each started with the job page's **Run** against a
 * hand-added A2A agent that answers at once (`heldA2aAgent` with `autoReply`),
 * each reply naming its run, so the chat a row opens is identifiable by what
 * it says. Then, through a second handle on the sandbox DB (refusing any other
 * profile), the two ways a run loses its task: the oldest run's task is
 * soft-deleted — what a delete on another device leaves here, since runs do
 * not sync — and the middle run is made a legacy run with no task at all. The
 * same write moves the two runs back one and two hours, so the three rows
 * start at different times and sort in a known order. Everything after that
 * is the product: `job:list-runs`' `taskLive`, the row, its menu and dialog,
 * `job:delete-run`.
 *
 * ## What it proves
 *
 * - Only the two orphaned rows have `Run actions`; the live row has none and
 *   still opens the task.
 * - On an orphaned row the ⋯ sits between the part that opens and the duration,
 *   and the duration stays in the same column as the live row's.
 * - Clicking an orphaned row opens that run's own chat.
 * - Delete run… removes the row and its chat, and leaves the job and its other
 *   runs.
 *
 * ## What it does not
 *
 * A cinna run's orphan (no chat of its own; "This run is permanently deleted"),
 * a run with nothing to open (`Chat deleted`), Delete run refused while the run
 * is going (the task-page version is in `task-delete.spec.ts`), and a failed
 * delete.
 */

const JOB_TITLE = 'Nightly report'
const JOB_PROMPT = 'Summarise the nightly build.'
const reply = (n: number): string => `Run ${n} answered: build ${n} is green.`

function history(page: Page): Locator {
  return page.getByRole('region', { name: 'Tasks history', exact: true })
}

async function runFromJobPage(cinna: CinnaApp, expected: number, agent: Awaited<ReturnType<typeof heldA2aAgent>>) {
  const page = cinna.page
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect.poll(() => agent.calls.length, { timeout: 30_000 }).toBe(expected)
  await expect(page.getByText(reply(expected), { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: `From job ${JOB_TITLE}`, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: JOB_TITLE, exact: true })).toBeVisible()
}

test('an orphaned run has its own ⋯ before the duration, opens its chat, and Delete run removes it with the chat', async ({
  cinna
}) => {
  test.setTimeout(150_000)
  const fake = await heldA2aAgent()
  fake.autoReply = (_text, index) => reply(index + 1)
  try {
    await cinna.skipOnboarding()
    const agentId = await fake.register(cinna, 'Report Agent')
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
    await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
    await cinna.page.getByText(JOB_TITLE, { exact: true }).first().click()
    for (const n of [1, 2, 3]) await runFromJobPage(cinna, n, fake)

    const runs = await cinna.page.evaluate(async (id) => {
      const list = await window.api.jobs.listRuns(id)
      return list.map((r) => ({ id: r.id, taskId: r.taskId, chatId: r.localChatId, status: r.status }))
    }, jobId)
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    // Which run is which: the one whose chat holds each reply.
    const byReply = await cinna.page.evaluate(
      async ({ list, replies }) => {
        const out: Record<number, (typeof list)[number]> = {}
        for (const run of list) {
          const chat = await window.api.chat.get(run.chatId!)
          const n = replies.findIndex((text) => chat?.messages.some((m) => m.content === text))
          out[n + 1] = run
        }
        return out
      },
      { list: runs, replies: [reply(1), reply(2), reply(3)] }
    )
    const [first, second, third] = [byReply[1], byReply[2], byReply[3]]
    expect([first, second, third].every(Boolean)).toBe(true)

    await test.step('arrange: run 1’s task is soft-deleted, run 2 becomes a legacy run with no task', async () => {
      await cinna.electronApp.evaluate(
        ({ app }, input) => {
          if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
          const requireFromApp = process
            .getBuiltinModule('node:module')
            .createRequire(`${app.getAppPath()}/package.json`)
          const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
          const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
          const now = Math.floor(Date.now() / 1000)
          try {
            db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(now, input.first.taskId)
            db.prepare('UPDATE job_runs SET task_id = NULL WHERE id = ?').run(input.second.id)
            db.prepare('DELETE FROM tasks WHERE id = ?').run(input.second.taskId)
            // Two hours and one hour back, whole runs, so each keeps its duration.
            const shift = db.prepare(`UPDATE job_runs SET created_at = created_at - ?,
              started_at = started_at - ?, finished_at = finished_at - ? WHERE id = ?`)
            shift.run(7200, 7200, 7200, input.first.id)
            shift.run(3600, 3600, 3600, input.second.id)
          } finally {
            db.close()
          }
        },
        { userData: cinna.sandbox.userData, first, second }
      )
      const live = await cinna.page.evaluate(async (id) => {
        const list = await window.api.jobs.listRuns(id)
        return list.map((r) => [r.id, r.taskLive])
      }, jobId)
      expect(live).toEqual([
        [third.id, true],
        [second.id, false],
        [first.id, false]
      ])
      // The page reads runs once per visit: come back to it fresh.
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
      await cinna.page.getByText(JOB_TITLE, { exact: true }).first().click()
      await expect(cinna.page.getByRole('heading', { level: 1, name: JOB_TITLE, exact: true })).toBeVisible()
    })

    await test.step('only the orphaned rows have Run actions, placed before the duration', async () => {
      const page = cinna.page
      const actions = history(page).getByRole('button', { name: 'Run actions', exact: true })
      await expect(actions).toHaveCount(2)
      const liveRow = history(page).getByTitle('Open the task', { exact: true })
      await expect(liveRow).toHaveCount(1)
      await expect(liveRow.getByRole('button', { name: 'Run actions' })).toHaveCount(0)
      const liveDuration = liveRow.locator(':scope > span').last()
      await expect(liveDuration).toHaveText('under a minute')
      const liveBox = (await liveDuration.boundingBox())!

      for (const i of [0, 1]) {
        const menuButton = actions.nth(i)
        const row = menuButton.locator('xpath=..')
        // The opening part, then ⋯, then the duration — and nothing else.
        await expect(row.locator(':scope > *')).toHaveCount(3)
        const opener = row.locator(':scope > button').first()
        await expect(opener).toHaveAttribute('title', 'Open chat')
        const duration = row.locator(':scope > span')
        await expect(duration).toHaveText('under a minute')
        const [o, m, d] = [await opener.boundingBox(), await menuButton.boundingBox(), await duration.boundingBox()]
        expect(o!.x + o!.width).toBeLessThanOrEqual(m!.x)
        expect(m!.x + m!.width).toBeLessThanOrEqual(d!.x)
        // Same right edge as the live row's duration: the ⋯ took space from
        // the opening part, not from the column.
        expect(Math.abs(d!.x + d!.width - (liveBox.x + liveBox.width))).toBeLessThanOrEqual(1)
      }
    })

    await test.step('clicking an orphaned row opens that run’s own chat', async () => {
      const page = cinna.page
      // Newest first: run 3 (live), run 2, run 1.
      const orphanOpeners = history(page).getByTitle('Open chat', { exact: true })
      await orphanOpeners.nth(0).click()
      await expect(page.getByText(reply(2), { exact: true })).toBeVisible()
      await expect(page.getByText(reply(1), { exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: `From job ${JOB_TITLE}`, exact: true }).click()
      await history(page).getByTitle('Open chat', { exact: true }).nth(1).click()
      await expect(page.getByText(reply(1), { exact: true })).toBeVisible()
      await page.getByRole('button', { name: `From job ${JOB_TITLE}`, exact: true }).click()
      await expect(page.getByRole('heading', { level: 1, name: JOB_TITLE, exact: true })).toBeVisible()
    })

    await test.step('Delete run… removes the row and its chat, and leaves the rest', async () => {
      const page = cinna.page
      const actions = history(page).getByRole('button', { name: 'Run actions', exact: true })
      // Run 1's row, the oldest, is last.
      await actions.nth(1).click()
      const menu = page.getByRole('menu', { name: 'Run actions', exact: true })
      await expect(menu.getByRole('menuitem')).toHaveCount(1)
      await menu.getByRole('menuitem', { name: 'Delete run…', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Delete run', exact: true })
      await expect(dialog.locator('p')).toHaveText(
        "The job stays. This run and the chat it ran in are permanently deleted — this can't be undone."
      )
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(actions).toHaveCount(1)
      await expect(history(page).getByTitle('Open chat', { exact: true })).toHaveCount(1)
      await expect(history(page).getByTitle('Open the task', { exact: true })).toHaveCount(1)
      const after = await page.evaluate(
        async ({ jobId, chatId }) => ({
          runs: (await window.api.jobs.listRuns(jobId)).map((r) => r.id),
          chat: await window.api.chat.get(chatId),
          trashed: (await window.api.chat.trashList()).some((c) => c.id === chatId),
          job: (await window.api.jobs.get(jobId)).title
        }),
        { jobId, chatId: first.chatId! }
      )
      expect(after).toEqual({ runs: [third.id, second.id], chat: null, trashed: false, job: JOB_TITLE })
    })
  } finally {
    await fake.close()
  }
})
