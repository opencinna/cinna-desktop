import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { LIVE_ENGINE, expectTaskTurnSettled, liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'
import { showTasksLayout } from '../fixtures/tasksView'
import {
  HANDOVERS_DIR,
  HANDOVER_BRIEF_FILE,
  HANDOVER_GATE_OPTIONS,
  HANDOVER_HOW_TO_REPORT,
  HANDOVER_REPORT_FILE,
  parseHandoverReport
} from '../../src/shared/handovers'

/**
 * @live — tasks processed by a **real** agent: a folder agent on the real
 * pinned OpenCode runtime (`engine: true`) answering through the real OpenAI
 * key in `.env`. Skipped without the key. `CINNA_E2E_LIVE_ENGINE=claude|codex`
 * runs the same tests on the developer's own Claude Code / Codex login instead
 * (`e2e/fixtures/liveEngine.ts`); every agent is put on that engine's cheap model.
 *
 * Every assertion is on an outcome — a file on disk, the task's status and
 * chat in main, the Inbox, the words the task page and board show — never on
 * the model's wording. Each goal names a random word the prompt has to carry
 * into a file, so a file holding it can only have come from this run.
 *
 * ## Cost
 *
 * The model is the first of `PREFERRED_MODELS` the key lists (gpt-4.1-mini on
 * a normal key; logged per test). OpenCode sends ~10–15k tokens of system
 * prompt and tools per model request, and a file-writing turn is 2–6 requests,
 * so the whole file is roughly 300–500k input tokens and a few thousand output
 * tokens: **about $0.15–0.25 per run** on gpt-4.1-mini. Chat auto-titles are
 * switched off so nothing else calls the model.
 *
 * ## What it does not prove
 *
 * Nothing about answer quality. The stop test proves the turn ends as
 * Cancelled and nothing is left waiting, not exactly which tool call was
 * interrupted. Job-run tasks and Cinna-server tasks are not covered here.
 */

test.beforeEach(() => requireLiveEngine())

test.use(liveEngineOptions())

const AGENT = 'File Clerk'

const CLERK_PROMPT = [
  'You are the File Clerk. You work only inside your own folder.',
  'When a task asks you to create files, create them with your file-writing tool exactly as asked:',
  'the exact path, the exact content, nothing added. Never ask the user anything; just do the work.',
  'When the work is finished, reply with the single word DONE.'
].join(' ')

/** A word no prompt and no model would produce unless told to. */
function randomWord(prefix: string): string {
  return `${prefix}${Math.floor(1000 + Math.random() * 9000)}`
}

const tasksButton = (cinna: CinnaApp): Locator => cinna.page.getByRole('button', { name: 'Tasks', exact: true })

/** The value beside a `Details` label on the task page. */
function detailValue(cinna: CinnaApp, label: string): Locator {
  return cinna.page
    .getByRole('complementary', { name: 'Details' })
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]')
}

const statusOf = (cinna: CinnaApp, id: string): Promise<string> =>
  cinna.page.evaluate(async (taskId) => (await window.api.tasks.get(taskId)).status, id)

/** A file's content, trimmed, or null while it does not exist. */
function contentOf(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null
}

/**
 * Onboarding done, the real key with a default mode, a kit folder agent whose
 * prompts say one thing: write the files a task asks for. Relaunched, so the
 * pickers and the task page's Continue list can see the agent.
 */
async function arrangeClerk(cinna: CinnaApp): Promise<{ agentId: string; folder: string }> {
  await cinna.skipOnboarding()
  const model = await seedLiveModel(cinna)
  console.log(`live-tasks model: ${model}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, 'Writes the files a task asks for.')
  await useLiveRuntime(cinna, agent.id)
  for (const prompt of ['workflow', 'entrypoint'] as const) {
    const outcome = await cinna.page.evaluate(
      async ({ agentId, prompt, value }) => {
        const doc = await window.api.localAgents.readDoc({ agentId, prompt })
        if (!doc.stamp) throw new Error(`${doc.relPath} does not exist`)
        return window.api.localAgents.updateField({
          agentId,
          update: { field: 'prompt', prompt, value },
          expectedStamp: doc.stamp
        })
      },
      { agentId: agent.id, prompt, value: CLERK_PROMPT }
    )
    expect(outcome.ok, `${prompt} prompt saved`).toBe(true)
  }
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  if (!agent.path) throw new Error('the scaffolded agent has no folder')
  return { agentId: agent.id, folder: agent.path }
}

/** A task assigned to the agent, created and started over IPC. */
async function createAndStart(
  cinna: CinnaApp,
  input: { title: string; goal: string; agentId: string }
): Promise<{ taskId: string; chatId: string }> {
  return cinna.page.evaluate(async ({ title, goal, agentId }) => {
    const task = await window.api.tasks.create({ title, goal, assignee: { kind: 'agent', agentId } })
    const started = await window.api.tasks.start(task.id, { kind: 'agent', agentId })
    return { taskId: task.id, chatId: started.chatId }
  }, input)
}

/** Inbox entries still waiting for this task. */
const asksFor = (cinna: CinnaApp, taskId: string): Promise<number> =>
  cinna.page.evaluate(
    async (id) => (await window.api.inbox.list()).entries.filter((entry) => entry.taskId === id).length,
    taskId
  )

async function assistantMessages(cinna: CinnaApp, chatId: string): Promise<number> {
  return cinna.page.evaluate(async (id) => {
    const chat = await window.api.chat.get(id)
    return (chat?.messages ?? []).filter((message) => message.role === 'assistant').length
  }, chatId)
}

test('@live one agent processes a task started from the task page', async ({ cinna }) => {
  test.setTimeout(360_000)
  const { folder } = await arrangeClerk(cinna)
  const word = randomWord('MANGO')
  const title = 'Write the result file'
  const target = join(folder, 'app-data', 'result.txt')
  const goalOf = (w: string): string =>
    `Create the file app-data/result.txt inside your folder. Its entire content must be exactly the word ${w} and nothing else. Then reply DONE.`

  await test.step('New task in the Tasks view, assigned to the agent, with the goal', async () => {
    await tasksButton(cinna).click()
    await cinna.page.getByRole('button', { name: 'New task', exact: true }).click()
    const dialog = cinna.page.getByRole('dialog', { name: 'New task', exact: true })
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
    await dialog.getByRole('button', { name: 'More options', exact: true }).click()
    await dialog.getByLabel('Goal', { exact: true }).fill(goalOf(word))
    await dialog.getByLabel('Assignee', { exact: true }).selectOption({ label: AGENT })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(cinna.page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
  })

  await test.step('Continue with the agent starts the work', async () => {
    const start = cinna.page.getByRole('region', { name: 'Continue this task', exact: true })
    await start.getByLabel('Continue with', { exact: true }).selectOption({ label: AGENT })
    await start.getByRole('button', { name: 'Continue', exact: true }).click()
    // Continue opens the task's new chat, with the agent's turn under way.
    await expect(cinna.page.getByRole('paragraph').filter({ hasText: goalOf(word) })).toBeVisible()
  })

  const task = await cinna.page.evaluate(
    async (t) => (await window.api.tasks.list()).find((entry) => entry.title === t)!,
    title
  )

  await test.step('the agent writes the file and the task reaches Done', async () => {
    await expect
      .poll(() => contentOf(target), { message: 'app-data/result.txt holds the word', timeout: 240_000 })
      .toBe(word)
    await expect
      .poll(() => statusOf(cinna, task.id), { message: 'the task completes', timeout: 120_000 })
      .toBe('completed')
  })

  await test.step('the task page reads Done, and the board shows it in Done', async () => {
    await tasksButton(cinna).click()
    await showTasksLayout(cinna.page, 'List')
    await cinna.page.getByRole('region', { name: 'Done', exact: true })
      .getByRole('button', { name: `${title} — Done`, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
    await expect(detailValue(cinna, 'Status')).toHaveText('Done')
    await expect(cinna.page.getByRole('status')).toHaveCount(0)
    await cinna.page.getByRole('button', { name: 'Back to Tasks', exact: true }).click()
    await cinna.page.getByRole('group', { name: 'Tasks layout' }).getByRole('button', { name: 'Board', exact: true }).click()
    await expect(
      cinna.page.locator('[data-board-column="closed"]').getByRole('button', { name: `${title} — Done`, exact: true })
    ).toBeVisible()
  })

  await test.step('the task has its own chat with the agent’s answer in it', async () => {
    const stored = await cinna.page.evaluate((id) => window.api.tasks.get(id), task.id)
    expect(stored.chatId).not.toBeNull()
    expect(await assistantMessages(cinna, stored.chatId!)).toBeGreaterThan(0)
    expect(await asksFor(cinna, task.id)).toBe(0)
  })
})

test('@live two tasks for the same agent run at once without cross-talk', async ({ cinna }) => {
  test.setTimeout(360_000)
  const { agentId, folder } = await arrangeClerk(cinna)
  const jobs = [
    { title: 'Write the alpha file', file: 'alpha.txt', word: randomWord('KIWI') },
    { title: 'Write the bravo file', file: 'bravo.txt', word: randomWord('PLUM') }
  ]

  // Both started back to back, and read in the same breath: a turn takes the
  // model seconds, so two `in_progress` here is two live turns at once.
  const { started, statuses } = await cinna.page.evaluate(async ({ jobs, agentId }) => {
    const started: Array<{ taskId: string; chatId: string }> = []
    for (const job of jobs) {
      const task = await window.api.tasks.create({ title: job.title, goal: job.goal, assignee: { kind: 'agent', agentId } })
      const run = await window.api.tasks.start(task.id, { kind: 'agent', agentId })
      started.push({ taskId: task.id, chatId: run.chatId })
    }
    const statuses = await Promise.all(started.map(async (s) => (await window.api.tasks.get(s.taskId)).status))
    return { started, statuses }
  }, {
    agentId,
    jobs: jobs.map((job) => ({
      title: job.title,
      goal: `Create the file app-data/${job.file} inside your folder. Its entire content must be exactly the word ${job.word} and nothing else. Then reply DONE.`
    }))
  })

  await test.step('both were running together, each in its own chat', async () => {
    expect(statuses).toEqual(['in_progress', 'in_progress'])
    expect(started[0].chatId).not.toBe(started[1].chatId)
  })

  await test.step('each file holds its own word and only its own', async () => {
    for (const job of jobs) {
      await expect
        .poll(() => contentOf(join(folder, 'app-data', job.file)), { message: `${job.file} holds ${job.word}`, timeout: 240_000 })
        .toBe(job.word)
    }
    expect(contentOf(join(folder, 'app-data', jobs[0].file))).not.toContain(jobs[1].word)
    expect(contentOf(join(folder, 'app-data', jobs[1].file))).not.toContain(jobs[0].word)
  })

  await test.step('both tasks are Done, each pointing at its own chat with an answer', async () => {
    for (const s of started) {
      await expect.poll(() => statusOf(cinna, s.taskId), { timeout: 120_000 }).toBe('completed')
      const stored = await cinna.page.evaluate((id) => window.api.tasks.get(id), s.taskId)
      expect(stored.chatId).toBe(s.chatId)
      expect(await assistantMessages(cinna, s.chatId)).toBeGreaterThan(0)
      expect(await asksFor(cinna, s.taskId)).toBe(0)
    }
  })
})

test('@live a brief written from outside the app is run by a real agent through the file protocol', async ({ cinna }) => {
  test.setTimeout(360_000)
  await cinna.skipOnboarding()
  const model = await seedLiveModel(cinna)
  console.log(`live-tasks model: ${model}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))

  // A bare project: a folder that is an agent because it holds CLAUDE.md.
  const folder = homeDir(cinna, 'tide-tables')
  writeFileSync(join(folder, 'CLAUDE.md'), '# Tide Tables\n\nYou own this project. Do the work a handover brief asks for, then report as the brief says.\n')
  writeFileSync(join(folder, 'README.md'), '# Tide Tables\n')
  await cinna.stubDirectoryPicker(folder)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled || pick.refusal !== null) throw new Error('the project folder was not offered for adoption')
  const added = await cinna.page.evaluate(
    (input) => window.api.localAgents.folderAdd(input),
    { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) }
  )
  expect(added.ok, 'the folder is adopted').toBe(true)
  if (LIVE_ENGINE.runtime) {
    const real = realpathSync(folder)
    const rows = (await cinna.page.evaluate(() => window.api.localAgents.list())).agents
    const row = rows.find((entry) => entry.path !== null && realpathSync(entry.path) === real)
    if (!row) throw new Error(`no agent row for ${folder}`)
    await useLiveRuntime(cinna, row.id)
  }

  const id = '20261002-1200-tide-note'
  const title = 'Write the tide note'
  const word = randomWord('HERON')
  const handover = join(folder, HANDOVERS_DIR, id)

  await test.step('a third-party tool writes the brief, and it waits in the Inbox', async () => {
    await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
    await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
    mkdirSync(handover, { recursive: true })
    const brief = join(handover, HANDOVER_BRIEF_FILE)
    writeFileSync(`${brief}.tmp`, [
      '---',
      'cinna_handover: 1',
      `title: ${title}`,
      'status: ready',
      '---',
      '',
      `Create a file named \`tide.txt\` at the top of this project (next to README.md). Its entire content must be exactly the word ${word} and nothing else.`,
      '',
      HANDOVER_HOW_TO_REPORT,
      ''
    ].join('\n'))
    renameSync(`${brief}.tmp`, brief)
  })

  const card = cinna.page.getByRole('article').filter({ hasText: `Run the handover “${title}” in ${basename(folder)}?` })

  await test.step('Run, answered through the Inbox', async () => {
    await expect(card).toBeVisible({ timeout: 90_000 })
    await card.getByRole('button', { name: 'Answer', exact: true }).click()
    const modal = cinna.page.getByLabel('Question', { exact: true })
    await modal.getByRole('button', { name: HANDOVER_GATE_OPTIONS.run, exact: true }).click()
    await modal.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect(modal).toHaveCount(0)
  })

  const taskId = await cinna.page.evaluate(async (t) => {
    const task = (await window.api.tasks.list()).find((entry) => entry.title === t)
    if (!task) throw new Error(`no task titled ${t}`)
    return task.id
  }, title)

  await test.step('the real agent wrote the file and a final report', async () => {
    await expect
      .poll(() => contentOf(join(folder, 'tide.txt')), { message: 'tide.txt holds the word', timeout: 240_000 })
      .toBe(word)
    // The executor has the `cinna` tools, so it reports with `tasks_report`; report.md
    // keeps whatever it wrote before starting. The handover row is the record.
    await expect
      .poll(async () => (await cinna.page.evaluate((tid) => window.api.handovers.forTask(tid), taskId))?.state ?? null,
        { message: 'the handover reports done (tasks_report or report.md)', timeout: 120_000 })
      .toBe('done')
    const text = contentOf(join(handover, HANDOVER_REPORT_FILE))
    if (text !== null) {
      const parsed = parseHandoverReport(text)
      expect(parsed.ok ? ['in_progress', 'done'].includes(parsed.report.status) : false).toBe(true)
    }
  })

  await test.step('the task is Done and carries the report’s summary', async () => {
    await expect.poll(() => statusOf(cinna, taskId), { timeout: 120_000 }).toBe('completed')
    const task = await cinna.page.evaluate((tid) => window.api.tasks.get(tid), taskId)
    // The report's one-line summary is the first line of the handoff note.
    expect((task.handoffNote ?? '').trim()).not.toBe('')
    expect(await asksFor(cinna, taskId)).toBe(0)

    await card.getByRole('button', { name: 'Open the task', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1 })).toHaveText(title)
    await expect(detailValue(cinna, 'Status')).toHaveText('Done')
    await expect(detailValue(cinna, 'Handover')).toHaveText('Done')
    await expectTaskTurnSettled(cinna, taskId)
  })

  // Nothing but the brief, the report, and the one file asked for.
  const written = readdirSync(folder).filter((name) => !['.cinna', 'CLAUDE.md', 'README.md'].includes(name))
  expect(written).toEqual(['tide.txt'])
  expect(realpathSync(folder)).toBe(realpathSync(pick.path))
})

test('@live Stop in a running task’s chat cancels the task and leaves nothing waiting', async ({ cinna }) => {
  test.setTimeout(360_000)
  const { agentId, folder } = await arrangeClerk(cinna)
  const title = 'Write thirty numbered files'
  const dir = join(folder, 'app-data', 'numbers')
  const { taskId } = await createAndStart(cinna, {
    title,
    agentId,
    goal: 'Create 30 files, one at a time, each with its own separate file-write tool call: app-data/numbers/n01.txt containing "1", then app-data/numbers/n02.txt containing "2", and so on up to app-data/numbers/n30.txt containing "30". Write them strictly one per tool call, in order, never several at once. Then reply DONE.'
  })

  await test.step('open the task’s chat while the run is live', async () => {
    await tasksButton(cinna).click()
    await cinna.page.getByRole('button', { name: `${title} — In progress` }).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
    await cinna.page.getByRole('button', { name: 'Open the chat', exact: true }).click()
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 60_000 })
    // Live means working, not only started: the first file is on disk.
    await expect
      .poll(() => (existsSync(dir) ? readdirSync(dir).length : 0), { message: 'the agent is writing files', timeout: 180_000 })
      .toBeGreaterThan(0)
  })

  await test.step('Stop ends the turn and the task is Cancelled', async () => {
    await cinna.page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 })
    await expect.poll(() => statusOf(cinna, taskId), { timeout: 60_000 }).toBe('cancelled')
    expect(readdirSync(dir).length).toBeLessThan(30)
  })

  await test.step('the task page says Cancelled and the Inbox has nothing for it', async () => {
    expect(await asksFor(cinna, taskId)).toBe(0)
    await expect(cinna.page.getByRole('button', { name: /^Inbox/ })).toHaveAccessibleName('Inbox')
    await tasksButton(cinna).click()
    await cinna.page.getByRole('button', { name: `${title} — Cancelled` }).click()
    await expect(detailValue(cinna, 'Status')).toHaveText('Cancelled')
  })
})
