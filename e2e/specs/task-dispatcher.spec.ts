import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { addAgentRoot } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpEngine, type ScriptAcpHeld } from '../fixtures/scriptAcpEngine'

/**
 * The task dispatcher (unified tasks, phase 4) on one bare folder agent:
 * Cinna working the agent's queue of Ready tasks.
 *
 * Real: `taskDispatchService` (passes, the report rule, the pause, the
 * outside-content gate), `taskExecutionService.start`, the folder adapter
 * writing and reading `.cinna/tasks/*.md`, the session's `cinna` MCP server
 * answering `task_update`, the agent page's Tasks tab, the Tasks view's queue
 * control and the Inbox's dispatch cards. Scripted: what each ACP turn decides
 * to do (`scriptAcpAgent.mjs`). No model, nothing billed.
 *
 * Not proved: Stop, error and interrupted pauses; a kit agent's queue; two
 * agents sharing a folder; the runner-slot wait; Skip on the gate card;
 * `blocked_by`. "Nothing starts" in Manual mode and before the gate is
 * answered is bounded by the time the UI takes to show the task (several
 * dispatcher wakes at 150 ms), not proved for ever.
 */

const BARE_HEADING = 'Basalt Ledger'
const HIGH = 'Reconcile the basalt-7731 ledger'
const LOW = 'Archive the basalt-2210 receipts'
const SILENT = 'Audit the basalt-4402 invoices'
const AFTER_RESUME = 'Close the basalt-9905 month'
const OUTSIDE = 'Sort the basalt-6618 statements'
const OUTSIDE_BODY = 'Group every statement by quarter.'
const MANUAL_TOP = 'Export the basalt-3307 totals'
const MANUAL_OTHER = 'Tidy the basalt-1186 folder'

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] }

function okResult(held: ScriptAcpHeld): any {
  const result = (held.params.results as { result: ToolResult }[])[0].result
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  return JSON.parse(result.content.find((item) => item.type === 'text')!.text!)
}

/** Adopt `dir` over the `folder-pick` → `folder-add` pair the dialog uses (`agent-task-tools.spec.ts`). */
async function adoptFolder(cinna: CinnaApp, dir: string): Promise<string> {
  await cinna.stubDirectoryPicker(dir)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled) throw new Error('the stubbed directory picker reported cancelled')
  if (pick.refusal !== null) throw new Error(`the folder was refused: ${pick.refusal}`)
  const added = await cinna.page.evaluate(
    (input) => window.api.localAgents.folderAdd(input),
    { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) }
  )
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
  const agents = await cinna.page.evaluate(() => window.api.localAgents.list())
  const real = realpathSync(dir)
  const agent = agents.agents.find((row) => row.path !== null && realpathSync(row.path) === real)
  if (!agent) throw new Error(`no agent row for ${dir}`)
  return agent.id
}

async function createReady(cinna: CinnaApp, agentId: string, title: string, priority: 'low' | 'normal' | 'high' | 'urgent'): Promise<string> {
  const task = await cinna.page.evaluate(
    (input) => window.api.tasks.create({ title: input.title, priority: input.priority, status: 'open', assignee: { kind: 'agent', agentId: input.agentId } }),
    { agentId, title, priority }
  )
  return task.id
}

async function taskStatus(cinna: CinnaApp, id: string): Promise<string> {
  return (await cinna.page.evaluate((taskId) => window.api.tasks.get(taskId), id)).status
}

/** The dispatched prompt `i` arrives for `title` (its goal), and the agent reports it completed with `task_update`. */
async function workAndReport(cinna: CinnaApp, fake: ScriptAcpEngine, i: number, taskId: string, title: string): Promise<void> {
  await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(i + 1)
  expect(fake.calls[i].text).toContain(`Continue this task.\n\nGoal:\n${title}`)
  const toolsBefore = fake.tools.length
  fake.calls[i].release({ tools: [{ name: 'task_update', args: { id: taskId, status: 'completed' } }] })
  await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(toolsBefore + 1)
  expect(okResult(fake.tools[toolsBefore])).toMatchObject({ id: taskId, status: 'completed' })
  fake.tools[toolsBefore].release({ text: `Done: ${title}.` })
  await expect.poll(() => taskStatus(cinna, taskId), { timeout: 30_000 }).toBe('completed')
}

/** Tasks view, filtered to the agent, so its queue control is in the header. */
async function openTasksView(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await cinna.page.getByRole('combobox', { name: 'Agent' }).selectOption({ label: BARE_HEADING })
}

test('a bare agent’s task queue runs one at a time, pauses on a silent turn, gates outside content, and waits in Manual', async ({ cinna }) => {
  test.setTimeout(300_000)
  const fake = await scriptAcpEngine()
  try {
    await cinna.skipOnboarding()
    await fake.install(cinna)
    await cinna.page.evaluate(async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Dispatcher fixture', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
    }, { host: fake.host, model: SCRIPT_MODEL })

    await addAgentRoot(cinna)
    const folder = homeDir(cinna, 'basalt-ledger')
    writeFileSync(join(folder, 'CLAUDE.md'), `# ${BARE_HEADING}\n\nYou keep the basalt ledger.\n`)
    const agentId = await adoptFolder(cinna, folder)
    // Adopted agents reach the agent list, the Tasks view and the dispatcher's agents after a restart.
    await cinna.relaunch()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())

    await test.step('One at a time runs two Ready tasks in priority order, each reported with task_update', async () => {
      // Created in the default Manual mode: nothing may start yet, so the order is the queue's choice.
      const low = await createReady(cinna, agentId, LOW, 'low')
      const high = await createReady(cinna, agentId, HIGH, 'high')
      expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.mode).toBe('manual')

      await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
      await cinna.page.getByRole('button', { name: BARE_HEADING, exact: true }).click()
      await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
      await cinna.page.getByRole('tab', { name: 'Tasks', exact: true }).click()
      const runMode = cinna.page.getByRole('combobox', { name: 'Run mode', exact: true })
      await expect(runMode).toHaveValue('manual')
      await expect(cinna.page.locator('[data-queue-status]')).toHaveText(`Next: ${HIGH}`)
      expect(fake.calls).toHaveLength(0)
      await runMode.selectOption({ label: 'One at a time' })

      // Highest priority first, although it was created second.
      await expect(cinna.page.locator('[data-queue-status]')).toHaveText(`Running ${HIGH}`, { timeout: 30_000 })
      await workAndReport(cinna, fake, 0, high, HIGH)
      await workAndReport(cinna, fake, 1, low, LOW)
      await expect(cinna.page.locator('[data-queue-status]')).toHaveText('No Ready tasks', { timeout: 30_000 })
    })

    let silent = ''
    let afterResume = ''
    await test.step('a dispatched turn that never reports leaves its task Blocked and pauses the queue', async () => {
      silent = await createReady(cinna, agentId, SILENT, 'urgent')
      afterResume = await createReady(cinna, agentId, AFTER_RESUME, 'low')
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(3)
      expect(fake.calls[2].text).toContain(`Continue this task.\n\nGoal:\n${SILENT}`)
      // The agent answers and ends its turn without saying how the task went.
      fake.calls[2].release({ text: 'I looked at the invoices.' })
      await expect.poll(() => taskStatus(cinna, silent), { timeout: 30_000 }).toBe('blocked')
      expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), silent)).dispatchNote).toBe('Ended without reporting')
      await expect(cinna.page.locator('[data-queue-paused]')).toContainText(`Paused — ${SILENT} ended without reporting`, { timeout: 15_000 })

      await openTasksView(cinna)
      await expect(cinna.page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible({ timeout: 15_000 })
      await expect(cinna.page.getByRole('button', { name: 'Run next', exact: true })).toHaveCount(0)
      await cinna.page.getByRole('region', { name: 'Waiting' }).getByRole('button', { name: new RegExp(`^${SILENT} — `) }).click()
      await expect(cinna.page.getByRole('heading', { level: 1, name: SILENT })).toBeVisible()
      await expect(cinna.page.locator('[data-task-dispatch-note]')).toHaveText('Ended without reporting')

      await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
      await expect(cinna.page.getByRole('heading', { name: 'Inbox' })).toBeVisible()
      const card = cinna.page.getByRole('article', { name: `${BARE_HEADING}’s queue is paused`, exact: true })
      await expect(card).toBeVisible({ timeout: 20_000 })
      await expect(card.getByText(`${SILENT} ended without reporting`, { exact: true })).toBeVisible()
      // Paused: the next Ready task has not started.
      expect(fake.calls).toHaveLength(3)
      expect(await taskStatus(cinna, afterResume)).toBe('open')
    })

    await test.step('Resume in the Tasks view restarts the queue and the next Ready task runs', async () => {
      await openTasksView(cinna)
      await cinna.page.getByRole('button', { name: 'Resume', exact: true }).click()
      await expect(cinna.page.getByRole('button', { name: 'Run next', exact: true })).toBeVisible({ timeout: 15_000 })
      await workAndReport(cinna, fake, 3, afterResume, AFTER_RESUME)
      // The task the queue paused on stays where it was.
      expect(await taskStatus(cinna, silent)).toBe('blocked')
    })

    await test.step('a task file written outside Cinna waits for approval in the Inbox, then runs', async () => {
      const tasksDir = join(folder, '.cinna', 'tasks')
      mkdirSync(tasksDir, { recursive: true })
      writeFileSync(join(tasksDir, 'sort-statements.md'), ['---', `title: ${OUTSIDE}`, 'status: open', '---', '', OUTSIDE_BODY, ''].join('\n'))

      await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
      const card = cinna.page.getByRole('article', { name: 'Run a task changed outside Cinna?', exact: true })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card.getByText(OUTSIDE, { exact: true })).toBeVisible()
      await expect(card.locator('[data-gate-file]')).toHaveText('.cinna/tasks/sort-statements.md')
      await expect(card.getByLabel('What the agent will receive')).toContainText(OUTSIDE_BODY)
      const outside = (await cinna.page.evaluate(() => window.api.tasks.list()))
        .find((task: { title: string }) => task.title === OUTSIDE) as { id: string; status: string }
      expect(outside.status).toBe('open')
      // One at a time and nothing else running, yet the unapproved content did not start.
      expect(fake.calls).toHaveLength(4)

      await card.getByRole('button', { name: 'Approve and run', exact: true }).click()
      await expect(card.getByRole('status')).toHaveText('Approved. The task is running.', { timeout: 30_000 })
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(5)
      expect(fake.calls[4].text).toContain(OUTSIDE_BODY)
      await workAndReport(cinna, fake, 4, outside.id, OUTSIDE)
    })

    await test.step('in Manual nothing starts on its own, and Run next starts the top task', async () => {
      await openTasksView(cinna)
      await cinna.page.getByRole('button', { name: 'Choose how the queue runs', exact: true }).click()
      await cinna.page.getByRole('menuitemradio', { name: 'Manual', exact: true }).click()
      await expect.poll(async () => (await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.mode).toBe('manual')

      const other = await createReady(cinna, agentId, MANUAL_OTHER, 'low')
      const top = await createReady(cinna, agentId, MANUAL_TOP, 'high')
      const ready = cinna.page.getByRole('region', { name: 'Ready' })
      await expect(ready.getByRole('button', { name: new RegExp(`^${MANUAL_TOP} — `) })).toBeVisible({ timeout: 15_000 })
      await expect(ready.getByRole('button', { name: new RegExp(`^${MANUAL_OTHER} — `) })).toBeVisible()
      expect(fake.calls).toHaveLength(5)
      expect(await taskStatus(cinna, top)).toBe('open')

      await cinna.page.getByRole('button', { name: 'Run next', exact: true }).click()
      await workAndReport(cinna, fake, 5, top, MANUAL_TOP)
      // Manual: the finished run does not start the next one.
      await expect(ready.getByRole('button', { name: new RegExp(`^${MANUAL_TOP} — `) })).toHaveCount(0, { timeout: 15_000 })
      expect(fake.calls).toHaveLength(6)
      expect(await taskStatus(cinna, other)).toBe('open')
      expect(fake.unexpected).toEqual([])
    })
  } finally { await fake.close() }
})
