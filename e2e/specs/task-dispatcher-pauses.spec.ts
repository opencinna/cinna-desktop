import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot } from '../fixtures/seed'
import { scriptAcpEngine } from '../fixtures/scriptAcpEngine'
import {
  adoptBare, arrangeScripted, createReady, openInbox, openTaskPage, openTasksTab, openTasksView,
  promptFor, report, setMode, taskStatus
} from '../fixtures/dispatcher'

/**
 * The task dispatcher's pauses other than the silent turn, the Skip answer on
 * the outside-content card, and `blocked_by` — on one bare folder agent
 * (`task-dispatcher.spec.ts` covers the rest of phase 4).
 *
 * Real: `taskDispatchService` (the report rule's Stop and error arms, boot
 * recovery, the gate's Skip and its reopening by Run next, the `blocked_by`
 * refusal), `taskExecutionService.start`, the folder adapter, the session's
 * `cinna` MCP `task_update`, the Tasks tab, the Tasks view's Run next, the
 * task page and the Inbox cards. Scripted: what each ACP turn does
 * (`scriptAcpAgent.mjs`). The error ending is the agent process dying
 * mid-turn (SIGKILL), the one way a scripted turn fails without a fixture
 * change. No model, nothing billed.
 *
 * Not proved: "nothing starts" while paused or while a task waits on its
 * blocker is bounded by the UI showing the state first, not proved for ever.
 */

const HEADING = 'Granite Ledger'
const STOPPED = 'Reconcile the granite-1407 ledger'
const FAILED = 'Archive the granite-2291 receipts'
const QUIT = 'Audit the granite-3318 invoices'
const LAST = 'Close the granite-4470 month'

const pausedLine = (cinna: CinnaApp) => cinna.page.locator('[data-queue-paused]')
const pausedCard = (cinna: CinnaApp) => cinna.page.getByRole('article', { name: `${HEADING}’s queue is paused`, exact: true })
const gateCards = (cinna: CinnaApp) => cinna.page.getByRole('article', { name: 'Run a task changed outside Cinna?', exact: true })

async function arrange(cinna: CinnaApp, fake: Awaited<ReturnType<typeof scriptAcpEngine>>, slug: string): Promise<{ agentId: string; folder: string }> {
  await arrangeScripted(cinna, fake)
  await addAgentRoot(cinna)
  const adopted = await adoptBare(cinna, slug, HEADING)
  // Adopted agents reach the agent list, the Tasks view and the dispatcher after a restart.
  await cinna.relaunch()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return adopted
}

function taskFile(dir: string, name: string, lines: string[], body: string): void {
  writeFileSync(join(dir, name), ['---', ...lines, '---', '', body, ''].join('\n'))
}

test('a Stop, an error ending and quitting mid-turn each pause the queue, and Resume goes on to the next task', async ({ cinna }) => {
  test.setTimeout(300_000)
  const fake = await scriptAcpEngine()
  try {
    const { agentId } = await arrange(cinna, fake, 'granite-ledger')
    // Created in Manual so the order is the queue's, then One at a time.
    const stopped = await createReady(cinna, agentId, STOPPED, 'urgent')
    const failed = await createReady(cinna, agentId, FAILED, 'high')
    const quit = await createReady(cinna, agentId, QUIT, 'normal')
    const last = await createReady(cinna, agentId, LAST, 'low')
    await setMode(cinna, agentId, 'one')

    await test.step('Stop in the dispatched chat cancels the task and pauses the queue', async () => {
      const i = await promptFor(fake, STOPPED)
      await openTaskPage(cinna, HEADING, STOPPED)
      await cinna.page.getByRole('button', { name: 'Open the chat', exact: true }).click()
      await cinna.page.getByRole('button', { name: 'Stop', exact: true }).click()
      await expect.poll(() => fake.calls[i].closed, { timeout: 30_000 }).toBe(true)
      await expect.poll(() => taskStatus(cinna, stopped), { timeout: 30_000 }).toBe('cancelled')

      await openTasksTab(cinna, HEADING)
      await expect(pausedLine(cinna)).toContainText(`Paused — ${STOPPED} was stopped`, { timeout: 15_000 })
      // Paused: the next Ready task has not started.
      expect(fake.calls).toHaveLength(1)
      expect(await taskStatus(cinna, failed)).toBe('open')
      await pausedLine(cinna).getByRole('button', { name: 'Resume', exact: true }).click()
      await expect(pausedLine(cinna)).toHaveCount(0, { timeout: 15_000 })
    })

    await test.step('an error ending marks the task failed and pauses the queue', async () => {
      const i = await promptFor(fake, FAILED)
      expect(i).toBe(1)
      // The agent process dies mid-turn.
      process.kill(fake.calls[i].pid, 'SIGKILL')
      await expect.poll(() => taskStatus(cinna, failed), { timeout: 30_000 }).toBe('error')
      await expect(pausedLine(cinna)).toContainText(`Paused — ${FAILED} failed`, { timeout: 15_000 })

      await openInbox(cinna)
      await expect(pausedCard(cinna)).toBeVisible({ timeout: 20_000 })
      await expect(pausedCard(cinna).getByText(`${FAILED} failed`, { exact: true })).toBeVisible()
      expect(fake.calls).toHaveLength(2)
      expect(await taskStatus(cinna, quit)).toBe('open')
      await pausedCard(cinna).getByRole('button', { name: 'Resume', exact: true }).click()
      await expect(pausedCard(cinna).getByRole('status')).toHaveText('Resumed. The task it paused on stays where it is.')
    })

    await test.step('quitting mid-turn leaves the task Waiting with "Interrupted when Cinna quit" and the queue paused at the next start', async () => {
      const i = await promptFor(fake, QUIT)
      expect(i).toBe(2)
      expect(await taskStatus(cinna, quit)).toBe('in_progress')
      // Cinna quits while the turn is still held, and starts again on the same sandbox.
      await cinna.relaunch()
      await cinna.page.evaluate(() => window.api.localAgents.rescan())

      await expect.poll(() => taskStatus(cinna, quit), { timeout: 30_000 }).toBe('blocked')
      expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), quit)).dispatchNote).toBe('Interrupted when Cinna quit')
      await openTasksTab(cinna, HEADING)
      await expect(pausedLine(cinna)).toContainText(`Paused — ${QUIT} was interrupted when Cinna quit`, { timeout: 15_000 })

      await openTaskPage(cinna, HEADING, QUIT)
      await expect(cinna.page.locator('[data-task-dispatch-note]')).toHaveText('Interrupted when Cinna quit')
      await openInbox(cinna)
      await expect(pausedCard(cinna)).toBeVisible({ timeout: 20_000 })
      await expect(pausedCard(cinna).getByText(`${QUIT} was interrupted when Cinna quit`, { exact: true })).toBeVisible()
      // Paused across the restart: the last Ready task has not started.
      expect(fake.calls).toHaveLength(3)
      expect(await taskStatus(cinna, last)).toBe('open')
      expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.paused?.reason).toBe('interrupted')
      expect(fake.unexpected).toEqual([])
    })

    await test.step('the flagged task moves to Ready from the board’s Move to menu, and the queue stays paused', async () => {
      await openTasksView(cinna, HEADING)
      await cinna.page.getByRole('group', { name: 'Tasks layout' }).getByRole('button', { name: 'Board', exact: true }).click()
      await expect(cinna.page.locator('[data-tasks-board="folder"]')).toBeVisible()
      await cinna.page.getByRole('button', { name: `Actions for ${QUIT}`, exact: true }).click()
      const menu = cinna.page.getByRole('menu', { name: 'Task actions', exact: true })
      await menu.getByRole('menuitem', { name: 'Move to open', exact: true }).click()
      await expect(menu).toHaveCount(0)
      await expect.poll(() => taskStatus(cinna, quit), { timeout: 15_000 }).toBe('open')
      const moved = await cinna.page.evaluate((id) => window.api.tasks.get(id), quit)
      expect(moved.dispatchNote ?? null).toBeNull()
      expect(moved.statusLabel).toBe('open')
      await expect(cinna.page.getByRole('alert')).toHaveCount(0)
      // Paused still: moving the task resumes nothing.
      expect(fake.calls).toHaveLength(3)
      expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.paused?.reason).toBe('interrupted')
    })
  } finally { await fake.close() }
})

const OUTSIDE = 'Sort the granite-6618 statements'
const OUTSIDE_BODY = 'Group every granite statement by quarter.'
const OTHER = 'Tidy the granite-5502 drawer'

test('Skip on the outside-content card leaves the task untrusted, the queue passes over it, and Run next asks again', async ({ cinna }) => {
  test.setTimeout(300_000)
  const fake = await scriptAcpEngine()
  try {
    const { agentId, folder } = await arrange(cinna, fake, 'granite-skip')
    await setMode(cinna, agentId, 'one')
    const tasksDir = join(folder, '.cinna', 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    taskFile(tasksDir, 'sort-statements.md', [`title: ${OUTSIDE}`, 'status: open', 'priority: urgent'], OUTSIDE_BODY)

    let outsideId = ''
    await test.step('Skip answers the card and leaves the content untrusted', async () => {
      await openInbox(cinna)
      await expect(gateCards(cinna)).toHaveCount(1, { timeout: 30_000 })
      await expect(gateCards(cinna).locator('[data-gate-file]')).toHaveText('.cinna/tasks/sort-statements.md')
      await gateCards(cinna).getByRole('button', { name: 'Skip', exact: true }).click()
      await expect(gateCards(cinna).getByRole('status')).toHaveText('Skipped. The queue passes over this task until its file changes.')
      const outside = (await cinna.page.evaluate(() => window.api.tasks.list()))
        .find((task: { title: string }) => task.title === OUTSIDE) as { id: string; status: string; fromOutside: boolean }
      outsideId = outside.id
      expect(outside).toMatchObject({ status: 'open', fromOutside: true })
    })

    await test.step('the queue passes over the skipped task and runs the next one', async () => {
      const other = await createReady(cinna, agentId, OTHER, 'low')
      const i = await promptFor(fake, OTHER)
      expect(i).toBe(0)
      await report(cinna, fake, i, other, OTHER)

      await openTasksTab(cinna, HEADING)
      // Only the skipped task is left, and no card asks about it.
      await expect(cinna.page.locator('[data-queue-status]')).toHaveText(`Next: ${OUTSIDE} — needs approval`, { timeout: 15_000 })
      await openInbox(cinna)
      await expect(cinna.page.getByText('Nothing is waiting on you.', { exact: true })).toBeVisible({ timeout: 15_000 })
      await expect(gateCards(cinna)).toHaveCount(0)
      expect(fake.calls).toHaveLength(1)
      expect(await taskStatus(cinna, outsideId)).toBe('open')
    })

    await test.step('Run next on the skipped task opens its card again', async () => {
      await openTasksView(cinna, HEADING)
      await cinna.page.getByRole('button', { name: 'Run next', exact: true }).click()
      await expect(cinna.page.getByRole('heading', { name: 'Inbox' })).toBeVisible({ timeout: 15_000 })
      await expect(gateCards(cinna)).toHaveCount(1, { timeout: 15_000 })
      await expect(gateCards(cinna).getByLabel('What the agent will receive')).toContainText(OUTSIDE_BODY)
      expect(fake.calls).toHaveLength(1)

      await gateCards(cinna).getByRole('button', { name: 'Approve and run', exact: true }).click()
      await expect(gateCards(cinna).getByRole('status')).toHaveText('Approved. The task is running.', { timeout: 30_000 })
      const i = await promptFor(fake, OUTSIDE)
      expect(fake.calls[i].text).toContain(OUTSIDE_BODY)
      await report(cinna, fake, i, outsideId, OUTSIDE)
      expect(fake.unexpected).toEqual([])
    })
  } finally { await fake.close() }
})

const BLOCKER = 'Count the granite-7001 crates'
const DEPENDENT = 'Ship the granite-7002 crates'
const TYPO = 'Label the granite-7003 crates'
const BLOCKER_ID = 't-granite-count'
const MISSING_ID = 't-granite-cuont'

test('a task waits until every blocked_by task is Done, and an id that names no task blocks with "not found"', async ({ cinna }) => {
  test.setTimeout(300_000)
  const fake = await scriptAcpEngine()
  try {
    const { agentId, folder } = await arrange(cinna, fake, 'granite-crates')
    const tasksDir = join(folder, '.cinna', 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    // Higher priority than their blocker, so only blocked_by keeps them back.
    taskFile(tasksDir, 'count.md', [`id: ${BLOCKER_ID}`, `title: ${BLOCKER}`, 'status: open', 'priority: low'], 'Count every crate.')
    taskFile(tasksDir, 'ship.md', ['id: t-granite-ship', `title: ${DEPENDENT}`, 'status: open', 'priority: urgent', `blocked_by: [${BLOCKER_ID}]`], 'Ship the counted crates.')
    taskFile(tasksDir, 'label.md', ['id: t-granite-label', `title: ${TYPO}`, 'status: open', 'priority: urgent', `blocked_by: [${MISSING_ID}]`], 'Label every crate.')
    await openTasksView(cinna, HEADING)
    await expect(cinna.page.getByRole('region', { name: 'Ready' }).getByRole('button', { name: new RegExp(`^${TYPO} — `) })).toBeVisible({ timeout: 30_000 })
    const ids = Object.fromEntries((await cinna.page.evaluate(() => window.api.tasks.list()))
      .map((task: { title: string; id: string }) => [task.title, task.id]))
    await setMode(cinna, agentId, 'one')

    await test.step('only the blocker is asked about and run; its dependants wait', async () => {
      await openInbox(cinna)
      await expect(gateCards(cinna)).toHaveCount(1, { timeout: 30_000 })
      await expect(gateCards(cinna).locator('[data-gate-file]')).toHaveText('.cinna/tasks/count.md')
      await gateCards(cinna).getByRole('button', { name: 'Approve and run', exact: true }).click()
      const i = await promptFor(fake, BLOCKER)
      expect(i).toBe(0)

      await openTaskPage(cinna, HEADING, DEPENDENT)
      await expect(cinna.page.locator('[data-task-blocked-by]').getByRole('button', { name: BLOCKER })).toBeVisible()
      await expect(cinna.page.locator('[data-task-waits-on]')).toHaveAttribute('title', `Waits on ${BLOCKER}`)
      await openTaskPage(cinna, HEADING, TYPO)
      await expect(cinna.page.locator('[data-task-blocked-by]').getByTitle(`${MISSING_ID} — not found`)).toBeVisible()
      await expect(cinna.page.locator('[data-task-blocked-by]').getByRole('img', { name: 'Not found' })).toBeVisible()
      await expect(cinna.page.locator('[data-task-waits-on]')).toHaveAttribute('title', `Waits on ${MISSING_ID} (not found)`)

      await report(cinna, fake, i, ids[BLOCKER], BLOCKER)
    })

    await test.step('once the blocker is Done its dependant becomes eligible; the missing id still blocks', async () => {
      await openInbox(cinna)
      // The dependant's own content came from outside too, so eligibility shows as its card.
      const card = gateCards(cinna).filter({ has: cinna.page.locator('[data-gate-file]', { hasText: '.cinna/tasks/ship.md' }) })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await card.getByRole('button', { name: 'Approve and run', exact: true }).click()
      const i = await promptFor(fake, DEPENDENT)
      expect(i).toBe(1)
      await report(cinna, fake, i, ids[DEPENDENT], DEPENDENT)

      await openTasksTab(cinna, HEADING)
      await expect(cinna.page.locator('[data-queue-status]')).toHaveText('No Ready tasks', { timeout: 15_000 })
      await openInbox(cinna)
      await expect(gateCards(cinna).filter({ has: cinna.page.locator('[data-gate-file]', { hasText: '.cinna/tasks/label.md' }) })).toHaveCount(0)
      expect(fake.calls).toHaveLength(2)
      expect(await taskStatus(cinna, ids[TYPO])).toBe('open')
      expect(fake.unexpected).toEqual([])
    })
  } finally { await fake.close() }
})
