import { realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { scriptAcpEngine, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'
import {
  adoptBare, adoptFolder, arrangeScripted, createReady, openTasksTab, promptFor, report, setMode, taskStatus
} from '../fixtures/dispatcher'

/**
 * The task dispatcher beyond one bare agent working alone: a kit agent's
 * queue of native tasks, the global runner slot, Up to N, and two agents over
 * one working tree.
 *
 * Real: `taskDispatchService` (flights, the per-agent and per-folder rules,
 * `withRuntimeAgent`'s slots), `taskExecutionService.start`, native tasks and
 * the folder adapter, the session's `cinna` MCP `task_update`, and the agent
 * page's Tasks tab (the single Run mode select, the status line). Scripted:
 * what each ACP turn does (`scriptAcpAgent.mjs`). No model, nothing billed.
 *
 * **Two agents over one folder** can only be arranged one way in the real
 * app: a folder adopted a second time through a symlink (the adopt overlap
 * check is textual — `bare_agents.md`, Known gaps). A kit folder's own
 * `AGENT.md` is refused as already added, and roots may not overlap.
 *
 * Not proved: "nothing else starts" is bounded by the UI showing the wait
 * first; the slot wait is shown for the run mode, not Run next's refusal.
 */

async function arrange(cinna: CinnaApp, fake: ScriptAcpEngine): Promise<void> {
  await arrangeScripted(cinna, fake)
  await addAgentRoot(cinna)
}

async function relaunchAndRescan(cinna: CinnaApp): Promise<void> {
  // Created and adopted agents reach the agent list, the Tasks view and the dispatcher after a restart.
  await cinna.relaunch()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
}

const status = (cinna: CinnaApp) => cinna.page.locator('[data-queue-status]')

const KIT = 'Quarry Clerk'
const KIT_FIRST = 'Weigh the quarry-5120 slabs'
const KIT_SECOND = 'Stack the quarry-5121 slabs'

test('a kit agent’s queue runs its native tasks one at a time, each reported with task_update', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await arrange(cinna, fake)
    const root = (await cinna.page.evaluate(() => window.api.localAgents.rootsList()))[0]
    const kit = await createFolderAgent(cinna, root, KIT)
    await relaunchAndRescan(cinna)
    const first = await createReady(cinna, kit.id, KIT_FIRST, 'high')
    const second = await createReady(cinna, kit.id, KIT_SECOND, 'normal')
    // Native tasks: no file behind them.
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), first)).file ?? null).toBeNull()

    await openTasksTab(cinna, KIT)
    await expect(status(cinna)).toHaveText(`Next: ${KIT_FIRST}`)
    await cinna.page.getByRole('combobox', { name: 'Run mode', exact: true }).selectOption({ label: 'One at a time' })
    await expect(status(cinna)).toHaveText(`Running ${KIT_FIRST}`, { timeout: 30_000 })
    const i = await promptFor(fake, KIT_FIRST)
    expect(realpathSync(fake.calls[i].cwd)).toBe(realpathSync(kit.path!))
    expect(fake.calls).toHaveLength(1)
    await report(cinna, fake, i, first, KIT_FIRST)
    const j = await promptFor(fake, KIT_SECOND)
    expect(j).toBe(1)
    await report(cinna, fake, j, second, KIT_SECOND)
    await expect(status(cinna)).toHaveText('No Ready tasks', { timeout: 30_000 })
    expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), kit.id))?.paused).toBeNull()
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

const SLOT_A = 'Slate Keeper'
const SLOT_B = 'Shale Keeper'
const SLOT_A_TASK = 'Split the slate-8101 blocks'
const SLOT_B_TASK = 'Sort the shale-8102 chips'

test('with one task runner slot taken, a second agent’s queue shows "Waiting for a runner slot" and starts once it frees', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await arrange(cinna, fake)
    const a = await adoptBare(cinna, 'slate-keeper', SLOT_A)
    const b = await adoptBare(cinna, 'shale-keeper', SLOT_B)
    await cinna.page.evaluate(() => window.api.settings.set('taskRunnerConcurrency', 1))
    await relaunchAndRescan(cinna)

    // Agent A's dispatched turn takes the only slot.
    const aTask = await createReady(cinna, a.agentId, SLOT_A_TASK)
    await setMode(cinna, a.agentId, 'one')
    const i = await promptFor(fake, SLOT_A_TASK)

    const bTask = await createReady(cinna, b.agentId, SLOT_B_TASK)
    await openTasksTab(cinna, SLOT_B)
    await cinna.page.getByRole('combobox', { name: 'Run mode', exact: true }).selectOption({ label: 'One at a time' })
    await expect(status(cinna)).toHaveText('Waiting for a runner slot', { timeout: 15_000 })
    expect(fake.calls).toHaveLength(1)
    expect(await taskStatus(cinna, bTask)).toBe('open')

    await report(cinna, fake, i, aTask, SLOT_A_TASK)
    const j = await promptFor(fake, SLOT_B_TASK)
    expect(j).toBe(1)
    await expect(status(cinna)).toHaveText(`Running ${SLOT_B_TASK}`, { timeout: 15_000 })
    await report(cinna, fake, j, bTask, SLOT_B_TASK)
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

const WIDE = 'Marble Crew'
const WIDE_TASKS = ['Polish the marble-9201 slab', 'Polish the marble-9202 slab', 'Polish the marble-9203 slab']

test('Up to 2 chosen in the Run mode select runs two of one agent’s tasks at once in the same folder, reading "Running 2 of 2"', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await arrange(cinna, fake)
    const wide = await adoptBare(cinna, 'marble-crew', WIDE)
    await relaunchAndRescan(cinna)
    const ids = [
      await createReady(cinna, wide.agentId, WIDE_TASKS[0], 'urgent'),
      await createReady(cinna, wide.agentId, WIDE_TASKS[1], 'high'),
      await createReady(cinna, wide.agentId, WIDE_TASKS[2], 'low')
    ]

    await openTasksTab(cinna, WIDE)
    const runMode = cinna.page.getByRole('combobox', { name: 'Run mode', exact: true })
    await runMode.selectOption({ label: 'Up to 2' })
    await expect(runMode).toHaveValue('up_to:2')
    await expect(status(cinna)).toHaveText('Running 2 of 2', { timeout: 30_000 })
    const first = await promptFor(fake, WIDE_TASKS[0])
    const second = await promptFor(fake, WIDE_TASKS[1])
    // Both turns are held open at once, in the agent's one folder.
    expect(fake.calls[first].closed || fake.calls[first].released).toBe(false)
    expect(fake.calls[second].closed || fake.calls[second].released).toBe(false)
    expect(realpathSync(fake.calls[first].cwd)).toBe(realpathSync(wide.folder))
    expect(realpathSync(fake.calls[second].cwd)).toBe(realpathSync(wide.folder))
    expect(fake.calls).toHaveLength(2)
    expect(await taskStatus(cinna, ids[2])).toBe('open')

    // One finishes: the third fills the free run.
    await report(cinna, fake, second, ids[1], WIDE_TASKS[1])
    const third = await promptFor(fake, WIDE_TASKS[2])
    await expect(status(cinna)).toHaveText('Running 2 of 2', { timeout: 15_000 })
    await report(cinna, fake, first, ids[0], WIDE_TASKS[0])
    await expect(status(cinna)).toHaveText(`Running ${WIDE_TASKS[2]} · 1 of 2`, { timeout: 15_000 })
    await report(cinna, fake, third, ids[2], WIDE_TASKS[2])
    await expect(status(cinna)).toHaveText('No Ready tasks', { timeout: 15_000 })
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

/**
 * The second agent over `dir`, adopted through a symlink: the only way two
 * real agents share a working tree. Answers its id and the link's path.
 */
async function adoptThroughLink(cinna: CinnaApp, dir: string, linkName: string): Promise<string> {
  const link = join(cinna.sandbox.home, linkName)
  symlinkSync(dir, link)
  const before = new Set((await cinna.page.evaluate(() => window.api.localAgents.list())).agents.map((row) => row.id))
  await adoptFolder(cinna, link).catch(() => '')
  const after = (await cinna.page.evaluate(() => window.api.localAgents.list())).agents
  const added = after.find((row) => !before.has(row.id))
  if (!added) throw new Error(`no second agent for ${link}`)
  return added.id
}

const FIRST = 'Basin Surveyor'
const SECOND = 'Basin Mapper'
const FIRST_TASK = 'Survey the basin-6301 shore'
const SECOND_TASK = 'Map the basin-6302 shore'

/**
 * The second agent is adopted through a symlink to the first one's folder:
 * the dispatcher tells folders apart by their real path (`folderOf`), so the
 * two read as one folder.
 */
test('two agents sharing a folder: a One at a time agent waits while the other agent’s dispatched run is in the folder', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await arrange(cinna, fake)
    const first = await adoptBare(cinna, 'basin-survey', FIRST)
    // Both agents read the one instructions file, so the second is told apart by its heading only in the list.
    const secondId = await adoptThroughLink(cinna, first.folder, 'basin-survey-link')
    await relaunchAndRescan(cinna)

    const firstTask = await createReady(cinna, first.agentId, FIRST_TASK)
    const secondTask = await createReady(cinna, secondId, SECOND_TASK)
    await setMode(cinna, first.agentId, 'one')
    const i = await promptFor(fake, FIRST_TASK)
    await setMode(cinna, secondId, 'one')

    await expect.poll(async () => (await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), secondId))?.waiting, { timeout: 15_000 })
      .toBe('folder_busy')
    expect(fake.calls).toHaveLength(1)
    expect(await taskStatus(cinna, secondTask)).toBe('open')

    await report(cinna, fake, i, firstTask, FIRST_TASK)
    const j = await promptFor(fake, SECOND_TASK)
    expect(realpathSync(fake.calls[j].cwd)).toBe(realpathSync(first.folder))
    await report(cinna, fake, j, secondTask, SECOND_TASK)
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

/**
 * The same symlinked folder: with a third slot free, only the folder rule
 * holds the One at a time agent back while the Up to 2 agent's runs are there.
 */
test('a One at a time agent sharing an Up to 2 agent’s folder waits while its runs are there', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await arrange(cinna, fake)
    const wide = await adoptBare(cinna, 'marble-shared', WIDE)
    const narrowId = await adoptThroughLink(cinna, wide.folder, 'marble-shared-link')
    // A third slot, so only the folder rule can hold the One at a time agent back.
    await cinna.page.evaluate(() => window.api.settings.set('taskRunnerConcurrency', 3))
    await relaunchAndRescan(cinna)

    const ids = [
      await createReady(cinna, wide.agentId, WIDE_TASKS[0], 'urgent'),
      await createReady(cinna, wide.agentId, WIDE_TASKS[1], 'high')
    ]
    const narrowTask = await createReady(cinna, narrowId, SECOND_TASK)
    await setMode(cinna, wide.agentId, 'up_to', 2)
    const first = await promptFor(fake, WIDE_TASKS[0])
    const second = await promptFor(fake, WIDE_TASKS[1])
    await setMode(cinna, narrowId, 'one')

    await expect.poll(async () => (await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), narrowId))?.waiting, { timeout: 15_000 })
      .toBe('folder_busy')
    expect(fake.calls).toHaveLength(2)
    expect(await taskStatus(cinna, narrowTask)).toBe('open')

    await report(cinna, fake, first, ids[0], WIDE_TASKS[0])
    await report(cinna, fake, second, ids[1], WIDE_TASKS[1])
    const j = await promptFor(fake, SECOND_TASK)
    await report(cinna, fake, j, narrowTask, SECOND_TASK)
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})
