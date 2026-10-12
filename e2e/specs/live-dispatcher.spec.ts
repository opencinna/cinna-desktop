import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'
import { adoptFolder, openTasksTab } from '../fixtures/dispatcher'

/**
 * @live — **the task dispatcher with a real agent.** A bare folder agent on
 * the real pinned OpenCode runtime (`engine: true`) with the OpenAI key from
 * `.env` has two Ready task files (made in Cinna, so their content is trusted
 * and no approval card is needed). The run mode is set to One at a time on
 * the agent's Tasks tab and nothing else is driven: the queue starts the
 * higher-priority task, the agent does it and reports it done with
 * `tasks_report` (on the turn's own task), and the queue goes
 * on to the second.
 *
 * Witnesses: each task's file in the agent's folder holds an answer the
 * prompt does not contain (a sum, a product); main's task status; the
 * two chats' creation order; and a 500 ms poll of the queue's state over the
 * whole run — never paused, never two runs at once. The scripted half (the
 * pauses, the gate, Up to N) is `task-dispatcher*.spec.ts`.
 *
 * The briefs name each output file by a path relative to the working folder:
 * gpt-4.1-mini read "the top of this project" as the filesystem root once
 * (`live-autorun.spec.ts`). Answers are arithmetic: a first draft asked for a
 * word spelled backwards and gpt-4.1-mini wrote `etnarg` for `granite`.
 *
 * ## Cost
 *
 * Two OpenCode turns of 2–4 requests each over a ~10k-token system prompt on
 * the first of `PREFERRED_MODELS` the key lists (gpt-5.6-luna normally): about
 * **$0.02–0.06 a run**. Run deliberately: `make e2e-one SPEC=live-dispatcher`.
 * With `CINNA_E2E_LIVE_ENGINE=claude|codex` the agent runs on the developer's
 * own Claude Code / Codex login instead (`e2e/fixtures/liveEngine.ts`).
 */

test.use(liveEngineOptions())
test.beforeEach(() => requireLiveEngine())

const HEADING = 'Tally Desk'
const FIRST = 'Tally the crate counts'
const FIRST_GOAL = 'Add 17 and 25. Write only the resulting number into the file ./tally-sum.txt in your working folder (relative path, never at the filesystem root).'
const SECOND = 'Square the pallet count'
const SECOND_GOAL = 'Multiply 12 by 12. Write only the resulting number into the file ./tally-square.txt in your working folder (relative path, never at the filesystem root).'

const INSTRUCTIONS = [
  `# ${HEADING}`,
  '',
  'Cinna hands you tasks one at a time. For each task:',
  '',
  '1. Do exactly what its goal says, with your file tools, inside your working folder.',
  '2. Then report it: call the `tasks_report` tool with `status` set to `done` and a one-line `summary` of what you did.',
  '3. Then reply with the single word done.',
  '',
  'Never ask the user anything. Never work on a task you were not handed in this turn.',
  ''
].join('\n')

interface Sample { paused: boolean; running: string[] }

const readTask = (cinna: CinnaApp, id: string) => cinna.page.evaluate((taskId) => window.api.tasks.get(taskId), id)
const fileText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '(missing)')

test('@live One at a time runs two Ready tasks of a real agent in order, each reported done, and never pauses', async ({ cinna }) => {
  test.setTimeout(8 * 60_000)
  await cinna.skipOnboarding()
  const model = await seedLiveModel(cinna)
  console.log(`live-dispatcher model: ${model}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))

  const folder = homeDir(cinna, 'tally-desk')
  writeFileSync(join(folder, 'CLAUDE.md'), INSTRUCTIONS)
  const agentId = await adoptFolder(cinna, folder)
  await useLiveRuntime(cinna, agentId)
  // Adopted agents and seeded credentials reach the agent page and the dispatcher after a restart.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  // Created in Manual (the default), so nothing starts before both exist.
  const ids = await cinna.page.evaluate(async (input) => {
    const assignee = { kind: 'agent' as const, agentId: input.agentId }
    const first = await window.api.tasks.create({ title: input.first, goal: input.firstGoal, priority: 'high', status: 'open', assignee })
    const second = await window.api.tasks.create({ title: input.second, goal: input.secondGoal, priority: 'normal', status: 'open', assignee })
    return { first: first.id, second: second.id }
  }, { agentId, first: FIRST, firstGoal: FIRST_GOAL, second: SECOND, secondGoal: SECOND_GOAL })
  for (const id of [ids.first, ids.second]) {
    const task = await readTask(cinna, id)
    expect(task.status).toBe('open')
    // Task files Cinna wrote: content it vouches for, so no approval card.
    expect(task.file?.path ?? '').toContain(join('.cinna', 'tasks'))
    expect(task.fromOutside).toBe(false)
  }

  const samples: Sample[] = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const state = await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId).catch(() => null)
      if (state) samples.push({ paused: state.paused !== null, running: state.running.map((run) => run.taskId) })
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })()

  try {
    await openTasksTab(cinna, HEADING)
    await expect(cinna.page.locator('[data-queue-status]')).toHaveText(`Next: ${FIRST}`)
    await cinna.page.getByRole('combobox', { name: 'Run mode', exact: true }).selectOption({ label: 'One at a time' })

    await test.step('the higher-priority task runs first and the agent reports it done', async () => {
      await expect.poll(async () => (await readTask(cinna, ids.first)).status, { timeout: 3 * 60_000, intervals: [1000] }).toBe('completed')
      expect(fileText(join(folder, 'tally-sum.txt'))).toBe('42')
    })

    await test.step('the queue goes on to the second task, which the agent also reports done', async () => {
      await expect.poll(async () => (await readTask(cinna, ids.second)).status, { timeout: 3 * 60_000, intervals: [1000] }).toBe('completed')
      expect(fileText(join(folder, 'tally-square.txt'))).toBe('144')
      await expect(cinna.page.locator('[data-queue-status]')).toHaveText('No Ready tasks', { timeout: 30_000 })
    })
  } finally {
    sampling = false
    await sampler
  }

  const first = await readTask(cinna, ids.first)
  const second = await readTask(cinna, ids.second)
  expect(first.chatId && second.chatId && first.chatId !== second.chatId).toBeTruthy()
  expect(first.dispatchNote ?? null).toBeNull()
  expect(second.dispatchNote ?? null).toBeNull()
  // Over the whole run: never paused, never two runs at once, and the runs in order — the first, then the second.
  expect(samples.length).toBeGreaterThan(5)
  expect(samples.filter((sample) => sample.paused)).toEqual([])
  expect(samples.filter((sample) => sample.running.length > 1)).toEqual([])
  const order = samples.map((sample) => sample.running[0]).filter(Boolean)
    .filter((id, index, list) => index === 0 || list[index - 1] !== id)
  expect(order).toEqual([ids.first, ids.second])
  expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.paused).toBeNull()
})
