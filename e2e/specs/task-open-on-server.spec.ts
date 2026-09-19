import { randomUUID } from 'node:crypto'
import { test, expect, type CinnaApp } from '../fixtures/app'
import {
  jobRemoteService,
  linkSandboxAccount,
  GOAL,
  AGENT_ID,
  REMOTE_AGENT,
  REMOTE_ID,
  REMOTE_KEY
} from '../fixtures/jobRemoteService'

/**
 * "Open on the server" in the task page's ⋯ (`TaskActionsMenu.tsx`): offered
 * first for a task a Cinna run produced, and it lands on that run's view even
 * when the task page was reached from the Inbox with no job active.
 *
 * ## What is real, and what is seeded
 *
 * A Cinna run with a `cinnaTaskId` cannot be produced offline through the
 * UI's own path (the dispatch needs a real service), so this is the
 * arrangement `job-executor-refresh.spec.ts` already uses: the sandbox profile
 * linked to the loopback Cinna fixture (`jobRemoteService`), a `cinna_task`
 * job created over IPC, and one pre-Task `job_runs` row written through a
 * second DB handle (refusing any other profile). The app then adopts it itself
 * — the real UI poll creates the Task and binds it to the run — so the task,
 * its `jobRunId` and the run's `taskId` are the product's, not the test's.
 *
 * ## What it proves
 *
 * - For that task, `Open on the server` is the menu's first item.
 * - From a task page reached via the Inbox after a restart (no job active), it
 *   opens the Cinna run view for that run (`#<short code>`, `Back to <job>`),
 *   not `This run is not available.`
 *
 * The local-run case (the item absent) is asserted in `task-delete.spec.ts`,
 * on a real local run's task.
 *
 * ## What it does not
 *
 * The run view's own content (comments, attachments, `Open on Cinna`), and a
 * Cinna run dispatched by the desktop rather than adopted.
 */

const TITLE = 'Quarterly revenue review'

async function restart(cinna: CinnaApp): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
}

test('a Cinna run’s task offers Open on the server first, and it lands on the run view from the Inbox', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const fake = await jobRemoteService()
  const runId = randomUUID()
  try {
    await cinna.skipOnboarding()
    await linkSandboxAccount(cinna, fake.host)
    const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
    const job = await cinna.page.evaluate((input) => window.api.jobs.create(input), {
      type: 'cinna_task' as const,
      title: TITLE,
      prompt: GOAL,
      cinnaAgentId: AGENT_ID,
      cinnaPriority: 'normal'
    })
    fake.state.includeInLists = false
    fake.state.remoteRunning = true
    fake.state.task = {
      id: REMOTE_ID,
      short_code: REMOTE_KEY,
      title: TITLE,
      original_message: GOAL,
      current_description: 'Work already running on the service.',
      priority: 'normal',
      status: 'in_progress',
      selected_agent_id: AGENT_ID,
      agent_name: REMOTE_AGENT,
      external_ref: '',
      updated_at: new Date().toISOString()
    }
    const changed = await cinna.electronApp.evaluate(
      ({ app }, input) => {
        if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
        const requireFromApp = process
          .getBuiltinModule('node:module')
          .createRequire(`${app.getAppPath()}/package.json`)
        const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
        try {
          return db
            .prepare(
              `INSERT INTO job_runs
              (id,job_id,user_id,type,status,cinna_task_id,cinna_short_code,task_id,started_at,created_at)
              VALUES (?,?,?,'cinna_task','running',?,?,NULL,?,?)`
            )
            .run(input.runId, input.jobId, input.userId, input.remoteId, input.remoteKey, input.now, input.now).changes
        } finally {
          db.close()
        }
      },
      {
        userData: cinna.sandbox.userData,
        runId,
        jobId: job.id,
        userId: user!.id,
        remoteId: REMOTE_ID,
        remoteKey: REMOTE_KEY,
        now: Math.floor(Date.now() / 1000)
      }
    )
    expect(changed).toBe(1)

    await test.step('the app adopts the run into a task of its own', async () => {
      await restart(cinna)
      await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
      await cinna.page.getByText(TITLE, { exact: true }).first().click()
      await expect
        .poll(() => cinna.page.evaluate((id) => window.api.jobs.listRuns(id), job.id), { timeout: 20_000 })
        .toEqual([expect.objectContaining({ id: runId, taskId: expect.any(String), cinnaTaskId: REMOTE_ID })])
      const tasks = await cinna.page.evaluate(() => window.api.tasks.list())
      expect(tasks).toEqual([expect.objectContaining({ jobId: job.id, jobRunId: runId, chatId: null })])
    })

    await test.step('from the Inbox, with no job active, Open on the server lands on the run view', async () => {
      await restart(cinna)
      const page = cinna.page
      await page.getByRole('button', { name: /^Inbox/ }).click()
      await page
        .getByRole('region', { name: 'Recent tasks', exact: true })
        .getByRole('button', { name: TITLE })
        .click()
      await expect(page.getByRole('heading', { level: 1, name: TITLE, exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      const menu = page.getByRole('menu', { name: 'Task actions', exact: true })
      const items = menu.getByRole('menuitem')
      await expect(items.first()).toHaveAccessibleName('Open on the server')
      await expect(items).toHaveCount(2)
      await expect(items.nth(1)).toHaveAccessibleName('Delete task…')
      await items.first().click()

      await expect(page.getByText(`#${REMOTE_KEY}`, { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: `Back to ${TITLE}`, exact: true })).toBeVisible()
      await expect(page.getByText('This run is not available.', { exact: true })).toHaveCount(0)
    })
  } finally {
    fake.server.closeAllConnections()
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})
