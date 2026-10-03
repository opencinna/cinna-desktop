import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { requireLiveKey, seedOpenAiDefaultMode } from '../fixtures/live'
import {
  HANDOVERS_DIR,
  HANDOVER_BRIEF_FILE,
  HANDOVER_GATE_OPTIONS,
  HANDOVER_HOW_TO_REPORT,
  HANDOVER_REPORT_FILE,
  parseHandoverReport
} from '../../src/shared/handovers'

/**
 * @live — **auto-run with real agents.** The receiver's standing setting decides
 * whether a request that does not say `execution: ask` runs without an Inbox
 * gate: a bare folder's **Handovers** setting (plus git: the handovers directory
 * must be untracked and ignored, or the folder not a repository), a kit agent's
 * **Delegations** setting. These tests drive real folder agents on the real
 * pinned OpenCode runtime (`engine: true`) with the OpenAI key from `.env`, and
 * check the *outcome* each time: the Inbox stays empty for the whole run (polled
 * throughout, not read once), the task reaches Done, the work file exists and
 * `report.md` says done (file channel) or the result returns to the requester's
 * chat (bus). Where the rule says gate, it checks the gate and the reason the
 * task page gives for it.
 *
 * Each auto-run also logs its **brief-to-start latency** — from the brief's
 * rename into place to the handover row leaving `seen`/`gated` — which tells
 * the folder watcher (about a second) from the minute scan (up to sixty).
 *
 * Git: the sandbox's `CINNA_GIT_DOWNLOAD=off` only stops Cinna *fetching* a git;
 * the machine's own `git` on the exported PATH is used for the check. The
 * spec's own `git init` runs with `HOME` set to the sandbox so the developer's
 * global excludes file cannot ignore `.cinna/` behind the test's back.
 *
 * ## Cost
 *
 * Model: the first of `PREFERRED_MODELS` the key lists (gpt-4.1-mini normally;
 * logged). About nine OpenCode turns in total — one each in tests 1, 3, 7, two
 * in 4, and four in 5 (coordinator, two executors, coordinator wake) — each
 * 2–6 requests over a ~10–15k-token system prompt: roughly **$0.10–0.20 per
 * full run**. Tests 2 and 6 stop at the gate and spend nothing. Chat
 * auto-titles are off. Run deliberately: `make e2e-one SPEC=live-autorun.spec.ts`.
 *
 * ## What it does not prove
 *
 * Nothing about answer quality. The cloud channel (the sender's Cloud
 * delegations grant) is not covered. A brief with `execution: auto` is not
 * covered separately — the rule treats it exactly like an absent field.
 */

test.use({ engine: true })
test.beforeEach(() => requireLiveKey())

const TURN = 6 * 60_000

// ─── arrange ────────────────────────────────────────────────────────────────

async function arrangeModel(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  const model = await seedOpenAiDefaultMode(cinna)
  console.log(`live-autorun model: ${model}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
}

const PROJECT_PROMPT = 'You own this project. Do the work a handover brief asks for, then report exactly as the brief says. Never ask the user anything.'

/** A bare project: a folder that is an agent because it holds CLAUDE.md. */
function writeProject(cinna: CinnaApp, dir: string, heading: string): string {
  const folder = homeDir(cinna, dir)
  writeFileSync(join(folder, 'CLAUDE.md'), `# ${heading}\n\n${PROJECT_PROMPT}\n`)
  writeFileSync(join(folder, 'README.md'), `# ${heading}\n`)
  return folder
}

/** Adopt a bare folder over `folder-pick` → `folder-add`; returns its agent id and the name the app gave it. */
async function adoptFolder(cinna: CinnaApp, dir: string): Promise<{ id: string; name: string }> {
  await cinna.stubDirectoryPicker(dir)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled) throw new Error('the stubbed directory picker reported cancelled')
  if (pick.refusal !== null) throw new Error(`the folder was refused: ${pick.refusal}`)
  const added = await cinna.page.evaluate((input) => window.api.localAgents.folderAdd(input),
    { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) })
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
  const agents = await cinna.page.evaluate(() => window.api.localAgents.list())
  const real = realpathSync(dir)
  const agent = agents.agents.find((row) => row.path !== null && realpathSync(row.path) === real)
  if (!agent) throw new Error(`no agent row for ${dir}`)
  return { id: agent.id, name: agent.name }
}

/** Agents → the agent → Settings → Permissions, as a user gets there. */
async function openPermissions(cinna: CinnaApp, name: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name, exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('tab', { name: 'Permissions', exact: true }).click()
}

/** Handovers → Run automatically, through the agent page; then main is asked what it stored. */
async function setHandoversAutoThroughUi(cinna: CinnaApp, agent: { id: string; name: string }): Promise<void> {
  await openPermissions(cinna, agent.name)
  const select = cinna.page.getByRole('combobox', { name: 'Handovers', exact: true })
  await expect(select).toHaveValue('ask')
  // The option is disabled until git has answered; wait for it to be offered.
  await expect(select.locator('option[value="auto"]')).toBeEnabled()
  await select.selectOption('auto')
  await expect(select).toBeEnabled()
  await expect(select).toHaveValue('auto')
  await expect.poll(() => handoversSetting(cinna, agent.id)).toBe('auto')
}

const handoversSetting = (cinna: CinnaApp, agentId: string): Promise<string | null> =>
  cinna.page.evaluate(async (id) => {
    const got = await window.api.localAgents.get(id)
    return got.ok ? (got.value.desktop.handovers ?? null) : `error: ${got.message}`
  }, agentId)

/** `git` against the folder, with the sandbox's `HOME` so no global config leaks in. */
function git(cinna: CinnaApp, folder: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: folder,
    env: { ...process.env, HOME: cinna.sandbox.home, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8'
  })
}

// ─── briefs ─────────────────────────────────────────────────────────────────

/** A word no model would produce unless told to. */
const randomWord = (prefix: string): string => `${prefix}${Math.floor(1000 + Math.random() * 9000)}`

interface Brief {
  id: string
  title: string
  file: string
  word: string
  execution?: 'ask'
}

const brief = (id: string, title: string, file: string, prefix: string, execution?: 'ask'): Brief =>
  ({ id, title, file, word: randomWord(prefix), execution })

/** Written from outside the app, temp file then rename; returns the moment it landed. */
function writeBrief(folder: string, b: Brief): number {
  const dir = join(folder, HANDOVERS_DIR, b.id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, HANDOVER_BRIEF_FILE)
  writeFileSync(`${path}.tmp`, [
    '---',
    'cinna_handover: 1',
    `title: ${b.title}`,
    'status: ready',
    ...(b.execution ? [`execution: ${b.execution}`] : []),
    '---',
    '',
    `Create a file named \`${b.file}\` in your working folder, next to README.md (a relative path, never one starting with /). Its entire content must be exactly the word ${b.word} and nothing else.`,
    '',
    HANDOVER_HOW_TO_REPORT,
    ''
  ].join('\n'))
  renameSync(`${path}.tmp`, path)
  return Date.now()
}

function contentOf(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null
}

function reportStatus(folder: string, id: string): string {
  const text = contentOf(join(folder, HANDOVERS_DIR, id, HANDOVER_REPORT_FILE))
  if (text === null) return 'no report'
  const parsed = parseHandoverReport(text)
  return parsed.ok ? parsed.report.status : `unreadable: ${parsed.reason}`
}

// ─── reading main ───────────────────────────────────────────────────────────

const taskIdByTitle = (cinna: CinnaApp, title: string): Promise<string | null> =>
  cinna.page.evaluate(async (t) => (await window.api.tasks.list()).find((task) => task.title === t)?.id ?? null, title)

const statusOf = (cinna: CinnaApp, id: string): Promise<string> =>
  cinna.page.evaluate(async (taskId) => (await window.api.tasks.get(taskId)).status, id)

type Row = { state: string; warning: string | null; execution: string }
const rowOf = (cinna: CinnaApp, taskId: string): Promise<Row | null> =>
  cinna.page.evaluate(async (id) => {
    const row = await window.api.handovers.forTask(id)
    return row ? { state: row.state, warning: row.warning, execution: row.execution } : null
  }, taskId)

/**
 * The Inbox, sampled every half second for as long as the scenario runs. An
 * auto-run that gated for a moment and was then answered by something would
 * slip past a single read at the end; this records every entry it ever saw.
 * Reads that fail while the app restarts are counted, not fatal.
 */
function watchInbox(cinna: CinnaApp): { stop(): Promise<{ polls: number; seen: string[] }> } {
  const seen = new Map<string, string>()
  let polls = 0
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      try {
        const entries = await cinna.page.evaluate(async () =>
          (await window.api.inbox.list()).entries.map((e) => ({ requestId: e.requestId, owner: e.deliveryOwner ?? '', title: e.taskTitle })))
        polls++
        for (const e of entries) seen.set(e.requestId, `${e.owner} ${e.requestId} “${e.title}”`)
      } catch {
        // the window is being replaced by a relaunch
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })()
  return {
    async stop() {
      stopped = true
      await loop
      return { polls, seen: [...seen.values()] }
    }
  }
}

async function expectInboxStayedEmpty(watch: ReturnType<typeof watchInbox>): Promise<void> {
  const { polls, seen } = await watch.stop()
  console.log(`live-autorun inbox: ${polls} polls, ${seen.length} entries seen`)
  expect(polls, 'the Inbox was actually sampled during the run').toBeGreaterThan(5)
  expect(seen, 'nothing ever waited in the Inbox').toEqual([])
}

/**
 * From the brief landing to the row being under way: the task is found by its
 * title, then its handover row is read until it leaves `seen`/`gated`. Returns
 * the latency in ms and logs it.
 */
async function awaitAutoStart(cinna: CinnaApp, b: Brief, landedAt: number, label: string): Promise<string> {
  let taskId: string | null = null
  await expect.poll(async () => {
    taskId ??= await taskIdByTitle(cinna, b.title)
    if (!taskId) return 'no task yet'
    const row = await rowOf(cinna, taskId)
    return row ? row.state : 'no row yet'
  }, { message: `${b.title} starts by itself`, timeout: 120_000, intervals: [250] })
    .toMatch(/^(running|done)$/)
  const latency = Date.now() - landedAt
  console.log(`live-autorun latency [${label}]: brief → running in ${(latency / 1000).toFixed(1)}s`)
  return taskId!
}

/** The real agent wrote the file, `report.md` says done, the task is Done and the row ran unattended. */
async function expectDone(cinna: CinnaApp, folder: string, b: Brief, taskId: string): Promise<void> {
  await expect.poll(() => contentOf(join(folder, b.file)), { message: `${b.file} holds the word`, timeout: TURN })
    .toBe(b.word)
  await expect.poll(() => reportStatus(folder, b.id), { message: 'report.md says done', timeout: 120_000 })
    .toBe('done')
  await expect.poll(() => statusOf(cinna, taskId), { message: 'the task completes', timeout: 120_000 })
    .toBe('completed')
  const row = await rowOf(cinna, taskId)
  expect(row).toMatchObject({ state: 'done', warning: null })
}

// ─── the Inbox and task page ────────────────────────────────────────────────

async function openInbox(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
}

const gateCard = (cinna: CinnaApp, folder: string, title: string): Locator =>
  cinna.page.getByRole('article').filter({ hasText: `Run the handover “${title}” in ${basename(folder)}?` })

function detailValue(cinna: CinnaApp, label: string): Locator {
  return cinna.page
    .getByRole('complementary', { name: 'Details' })
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]')
}

/** Assert the gate is open for `b`, in main and on screen; returns the task id. */
async function expectGated(cinna: CinnaApp, folder: string, b: Brief, landedAt: number, label: string): Promise<string> {
  await openInbox(cinna)
  await expect(gateCard(cinna, folder, b.title)).toBeVisible({ timeout: 90_000 })
  console.log(`live-autorun latency [${label}]: brief → gate card in ${((Date.now() - landedAt) / 1000).toFixed(1)}s`)
  const taskId = await taskIdByTitle(cinna, b.title)
  if (!taskId) throw new Error(`no task titled ${b.title}`)
  expect((await rowOf(cinna, taskId))?.state).toBe('gated')
  expect(await cinna.page.evaluate(async (id) =>
    (await window.api.inbox.list()).entries.filter((e) => e.taskId === id).map((e) => [e.deliveryOwner, e.requestId.startsWith('handover:')]), taskId))
    .toEqual([['handover', true]])
  expect(await statusOf(cinna, taskId)).not.toBe('in_progress')
  return taskId
}

async function answerGate(cinna: CinnaApp, folder: string, title: string, option: string): Promise<void> {
  const card = gateCard(cinna, folder, title)
  await card.getByRole('button', { name: 'Answer', exact: true }).click()
  const modal = cinna.page.getByLabel('Question', { exact: true })
  await modal.getByRole('button', { name: option, exact: true }).click()
  await modal.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(modal).toHaveCount(0)
}

/** What main believed, written beside the test's results — ids, states, warnings, chat heads, the Inbox; no secrets. */
async function attachState(cinna: CinnaApp): Promise<void> {
  try {
    const state = await cinna.page.evaluate(async () => {
      const tasks = await window.api.tasks.list()
      const rows = []
      for (const task of tasks) {
        const chat = task.chatId ? await window.api.chat.get(task.chatId) : null
        rows.push({
          title: task.title,
          status: task.status,
          handover: await window.api.handovers.forTask(task.id),
          links: await window.api.delegations.forTask(task.id),
          messages: (chat?.messages ?? []).map((m) => `${new Date(m.createdAt).toISOString()} ${m.role}: ${m.content.slice(0, 300)} ${JSON.stringify(m.parts ?? []).slice(0, 1500)}`)
        })
      }
      return { rows, inbox: (await window.api.inbox.list()).entries }
    })
    writeFileSync(test.info().outputPath('main-state.json'), JSON.stringify(state, null, 2))
  } catch (error) {
    writeFileSync(test.info().outputPath('main-state-error.txt'), String(error))
  }
}

// ─── 1 ──────────────────────────────────────────────────────────────────────

test('@live 1 a third-party brief with no execution field auto-runs on a bare agent set to Run automatically', async ({ cinna }) => {
  test.setTimeout(10 * 60_000)
  await arrangeModel(cinna)
  const folder = writeProject(cinna, 'tide-tables', 'Tide Tables')
  const agent = await adoptFolder(cinna, folder)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  await test.step('Handovers → Run automatically, on the agent’s Permissions tab', async () => {
    await setHandoversAutoThroughUi(cinna, agent)
  })

  const b = brief('20261002-1200-tide-note', 'Write the tide note', 'tide.txt', 'HERON')
  const watch = watchInbox(cinna)
  try {
    const landedAt = writeBrief(folder, b)
    const taskId = await test.step('it starts with no gate', () => awaitAutoStart(cinna, b, landedAt, '1 third-party'))
    expect(await rowOf(cinna, taskId)).toMatchObject({ execution: 'receiver', warning: null })
    await test.step('the agent writes the file and report.md; the task is Done', () => expectDone(cinna, folder, b, taskId))
    await expectInboxStayedEmpty(watch)

    await test.step('the task page reads Done', async () => {
      await cinna.page.getByRole('button', { name: 'Tasks', exact: true }).click()
      await cinna.page.getByRole('region', { name: 'Done', exact: true })
        .getByRole('button', { name: `${b.title} — Done`, exact: true }).click()
      await expect(detailValue(cinna, 'Status')).toHaveText('Done')
      await expect(detailValue(cinna, 'Handover')).toHaveText('Done')
    })
  } finally {
    await watch.stop()
    await attachState(cinna)
  }
})

// ─── 2 ──────────────────────────────────────────────────────────────────────

test('@live 2 an explicit execution: ask still gates when the agent runs handovers automatically', async ({ cinna }) => {
  test.setTimeout(5 * 60_000)
  await arrangeModel(cinna)
  const folder = writeProject(cinna, 'ask-project', 'Ask Project')
  const agent = await adoptFolder(cinna, folder)
  const set = await cinna.page.evaluate((id) => window.api.localAgents.setHandovers(id, 'auto'), agent.id)
  expect(set.ok).toBe(true)

  const b = brief('20261002-1300-ask-first', 'Ask before this one', 'ask.txt', 'OTTER', 'ask')
  try {
    const landedAt = writeBrief(folder, b)
    const taskId = await expectGated(cinna, folder, b, landedAt, '2 explicit ask')
    // It got what it asked for, so nothing is recorded as refused.
    expect(await rowOf(cinna, taskId)).toEqual({ state: 'gated', warning: null, execution: 'ask' })
    await expect(gateCard(cinna, folder, b.title).getByText('Cinna Desktop is asking a question', { exact: true })).toBeVisible()
    expect(existsSync(join(folder, b.file))).toBe(false)
  } finally {
    await attachState(cinna)
  }
})

// ─── 3 ──────────────────────────────────────────────────────────────────────

test('@live 3 in a git repo: gated with the reason while .cinna is not ignored, auto-run once it is', async ({ cinna }) => {
  test.setTimeout(10 * 60_000)
  await arrangeModel(cinna)
  const folder = writeProject(cinna, 'harbor-repo', 'Harbor Repo')
  const agent = await adoptFolder(cinna, folder)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  await test.step('Run automatically is chosen while the folder is not a repository', async () => {
    await setHandoversAutoThroughUi(cinna, agent)
  })

  await test.step('then the folder becomes a git repo, with .cinna not ignored', async () => {
    git(cinna, folder, 'init', '-q')
    expect(git(cinna, folder, 'rev-parse', '--is-inside-work-tree').trim()).toBe('true')
    const check = await cinna.page.evaluate(async (id) => {
      const got = await window.api.localAgents.handoversCheck(id)
      return got.ok ? got.value.result : `error: ${got.message}`
    }, agent.id)
    console.log(`live-autorun git check after init: ${check}`)
    expect(check).toBe('not_ignored')
  })

  const first = brief('20261002-1400-harbor-one', 'Harbor note one', 'harbor-one.txt', 'GULL')
  await test.step('a brief with no execution gates, and the task page says why in words', async () => {
    const landedAt = writeBrief(folder, first)
    const taskId = await expectGated(cinna, folder, first, landedAt, '3a git not ignored')
    expect(await rowOf(cinna, taskId)).toEqual({ state: 'gated', warning: 'auto_not_allowed:not_ignored', execution: 'receiver' })
    await gateCard(cinna, folder, first.title).getByRole('button', { name: 'Open the task', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1 })).toHaveText(first.title)
    await expect(detailValue(cinna, 'Handover')).toHaveText('Waiting in the Inbox')
    await expect(detailValue(cinna, 'Note')).toHaveText('Automatic run was not allowed: .cinna/handovers is not ignored by git')
    // Skip it, so the Inbox is empty for the second half of the test.
    await openInbox(cinna)
    await answerGate(cinna, folder, first.title, HANDOVER_GATE_OPTIONS.skip)
    await expect.poll(async () => (await cinna.page.evaluate(() => window.api.inbox.list())).entries.length).toBe(0)
  })

  const second = brief('20261002-1410-harbor-two', 'Harbor note two', 'harbor-two.txt', 'TERN')
  await test.step('.cinna/handovers goes into .gitignore; a second brief auto-runs to Done', async () => {
    writeFileSync(join(folder, '.gitignore'), '.cinna/handovers\n')
    expect(git(cinna, folder, 'check-ignore', '.cinna/handovers').trim()).toBe('.cinna/handovers')
    const watch = watchInbox(cinna)
    try {
      const landedAt = writeBrief(folder, second)
      const taskId = await awaitAutoStart(cinna, second, landedAt, '3b git ignored')
      await expectDone(cinna, folder, second, taskId)
      await expectInboxStayedEmpty(watch)
    } finally {
      await watch.stop()
      await attachState(cinna)
    }
  })
})

// ─── 4 ──────────────────────────────────────────────────────────────────────

test('@live 4 the gate’s standing option runs the brief and turns auto-run on for the next one', async ({ cinna }) => {
  test.setTimeout(12 * 60_000)
  await arrangeModel(cinna)
  const folder = writeProject(cinna, 'reef-project', 'Reef Project')
  const agent = await adoptFolder(cinna, folder)
  expect(await handoversSetting(cinna, agent.id)).toBeNull()

  const first = brief('20261002-1500-reef-one', 'Reef note one', 'reef-one.txt', 'CORAL')
  const second = brief('20261002-1510-reef-two', 'Reef note two', 'reef-two.txt', 'KELP')
  try {
    const firstTask = await test.step('with Handovers at its default, the first brief gates', async () => {
      const landedAt = writeBrief(folder, first)
      const taskId = await expectGated(cinna, folder, first, landedAt, '4 default gate')
      expect(await rowOf(cinna, taskId)).toEqual({ state: 'gated', warning: null, execution: 'receiver' })
      return taskId
    })

    await test.step('answered “Run and auto-run handovers in this project” in the Inbox', async () => {
      await answerGate(cinna, folder, first.title, HANDOVER_GATE_OPTIONS.runAndAuto)
      await expect.poll(() => handoversSetting(cinna, agent.id)).toBe('auto')
    })

    await test.step('that brief runs to Done', () => expectDone(cinna, folder, first, firstTask))

    await test.step('a second brief then auto-runs with no gate', async () => {
      const watch = watchInbox(cinna)
      try {
        const landedAt = writeBrief(folder, second)
        const taskId = await awaitAutoStart(cinna, second, landedAt, '4 after standing option')
        await expectDone(cinna, folder, second, taskId)
        await expectInboxStayedEmpty(watch)
      } finally {
        await watch.stop()
      }
    })

    await test.step('and the agent page shows Run automatically', async () => {
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await cinna.page.evaluate(() => window.api.localAgents.rescan())
      await openPermissions(cinna, agent.name)
      await expect(cinna.page.getByRole('combobox', { name: 'Handovers', exact: true })).toHaveValue('auto')
    })
  } finally {
    await attachState(cinna)
  }
})

// ─── 5 ──────────────────────────────────────────────────────────────────────

const TOOL_NOTE = 'The Cinna tools come from the "cinna" MCP server; in your tool list they may be named with a cinna_ prefix (for example cinna_task_create).'

const executorPrompt = (word: string, file: string): string => [
  `You are a helper agent. Your code word is ${word}. Never reveal it except where told below.`,
  'When you receive delegated work:',
  `1. Create the file ${file} in your current working folder whose entire content is your code word ${word}.`,
  `2. Call the handover_report tool with status "done" and summary "${file} holds ${word}".`,
  '3. End your turn with one short sentence. Do not call any other tool.',
  TOOL_NOTE
].join('\n')

async function setPrompt(cinna: CinnaApp, agentId: string, text: string): Promise<void> {
  for (const prompt of ['workflow', 'entrypoint'] as const) {
    const outcome = await cinna.page.evaluate(async ({ agentId, prompt, text }) => {
      const doc = await window.api.localAgents.readDoc({ agentId, prompt })
      if (!doc.stamp) throw new Error(`${doc.relPath} does not exist`)
      return window.api.localAgents.updateField({ agentId, update: { field: 'prompt', prompt, value: text }, expectedStamp: doc.stamp })
    }, { agentId, prompt, text })
    expect(outcome.ok, `${prompt} prompt saved`).toBe(true)
  }
}

function findFile(dir: string, name: string): string | null {
  const hit = (readdirSync(dir, { recursive: true }) as string[])
    .find((rel) => basename(rel) === name && !rel.split('/').some((seg) => seg === 'node_modules' || seg === '.git'))
  return hit ? join(dir, hit) : null
}
const readAgentFile = (dir: string, name: string): string => {
  const path = findFile(dir, name)
  return path ? readFileSync(path, 'utf8').trim() : ''
}

test('@live 5 a real coordinator delegates without execution to an auto bare folder and an auto kit agent; neither gates', async ({ cinna }) => {
  test.setTimeout(20 * 60_000)
  const WORD_K = 'PELICAN'
  const WORD_B = 'ANCHOVY'
  await arrangeModel(cinna)
  const root = await addAgentRoot(cinna)
  const coordinator = await createFolderAgent(cinna, root, 'Auto Coordinator', 'Hands work to helpers.')
  const kitHelper = await createFolderAgent(cinna, root, 'Auto Kit Helper', 'Writes files on request.')
  const bareDir = homeDir(cinna, 'auto-bare-helper')
  writeFileSync(join(bareDir, 'AGENTS.md'), `# Auto Bare Helper\n\n${executorPrompt(WORD_B, 'bare.txt')}\n`)
  const bare = await adoptFolder(cinna, bareDir)
  const setBare = await cinna.page.evaluate((id) => window.api.localAgents.setHandovers(id, 'auto'), bare.id)
  expect(setBare.ok).toBe(true)

  await setPrompt(cinna, kitHelper.id, executorPrompt(WORD_K, 'kit.txt'))
  await setPrompt(cinna, coordinator.id, [
    'You are a coordinator. You never do the work yourself; helpers do it.',
    'When your task tells you to delegate, call the task_create tool exactly as instructed, once per helper, and then end your turn immediately with one short sentence. Do not call handover_list, do not wait, do not create files in that turn.',
    'Later Cinna Desktop will send you a message that starts with "Handover group". Then reply with one short sentence and end your turn. Do not call any tool then.',
    TOOL_NOTE
  ].join('\n'))

  const TITLE = 'Hand out the two notes'
  // No `execution` in either request: the receivers' own settings decide.
  const goal = [
    'Delegate two pieces of work, then end your turn.',
    `1. Call task_create with exactly: ${JSON.stringify({ assignee: { kind: 'kit', agentId: kitHelper.id }, id: 'auto-kit', title: 'Write kit.txt', description: 'Create kit.txt in your folder containing only your code word, then call handover_report with status done and a summary naming your code word.', group: 'autorun' })}`,
    `2. Call task_create with exactly: ${JSON.stringify({ assignee: { kind: 'bare', agentId: bare.id }, id: 'auto-bare', title: 'Write bare.txt', description: 'Create bare.txt in your folder containing only your code word, then call handover_report with status done and a summary naming your code word.', group: 'autorun' })}`,
    '3. End your turn now. The results come back later on their own.'
  ].join('\n')
  const taskId = (await cinna.page.evaluate((input) => window.api.tasks.create(input),
    { title: TITLE, goal, status: 'open' as const, assignee: { kind: 'agent' as const, agentId: coordinator.id } })).id

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  await test.step('the kit helper’s Delegations → Run automatically, on its Permissions tab', async () => {
    await openPermissions(cinna, 'Auto Kit Helper')
    const receiving = cinna.page.getByRole('combobox', { name: 'Delegations', exact: true })
    await expect(receiving).toHaveValue('ask')
    await receiving.selectOption('auto')
    await expect(receiving).toBeEnabled()
    await expect.poll(() => cinna.page.evaluate((id) => window.api.localAgents.get(id), kitHelper.id))
      .toMatchObject({ ok: true, value: { desktop: { delegations: 'auto' } } })
  })

  const watch = watchInbox(cinna)
  try {
    await test.step('the user starts the coordinator task from its page', async () => {
      const page = cinna.page
      await page.getByRole('button', { name: 'Tasks', exact: true }).click()
      await page.getByRole('region', { name: 'Ready', exact: true }).getByRole('button', { name: `${TITLE} — Ready`, exact: true }).click()
      const controls = page.getByRole('region', { name: 'Continue this task', exact: true })
      await controls.getByRole('combobox', { name: 'Continue with', exact: true }).selectOption({ label: 'Auto Coordinator' })
      await controls.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(controls).toHaveCount(0, { timeout: 30_000 })
    })

    const linksOf = (id: string) => cinna.page.evaluate((t) => window.api.delegations.forTask(t), id)

    await test.step('two delegations, recorded as following the receiver, neither gated', async () => {
      await expect.poll(async () => (await linksOf(taskId)).to.length, { timeout: TURN, intervals: [1_000] }).toBe(2)
      const to = (await linksOf(taskId)).to
      console.log(`live-autorun 5 rows: ${JSON.stringify(to.map((d) => ({ channel: d.channel, state: d.state, execution: d.execution, waiting: d.waitingOnUser })))}`)
      expect(to.map((d) => [d.channel, d.targetAgentId, d.groupId, d.execution]).sort()).toEqual([
        ['file', bare.id, 'autorun', 'receiver'],
        ['local', kitHelper.id, 'autorun', 'receiver']
      ])
      for (const d of to) {
        expect(d.state, `${d.channel} not gated`).not.toBe('gated')
        expect(d.waitingOnUser).toBe(false)
      }
    })

    await test.step('both child tasks reach Done and the files hold the right words', async () => {
      await expect.poll(async () => (await linksOf(taskId)).to.every((d) => d.taskId !== null), { timeout: 60_000 }).toBe(true)
      for (const d of (await linksOf(taskId)).to) {
        await expect.poll(() => statusOf(cinna, d.taskId!), { message: `${d.channel} child completes`, timeout: TURN, intervals: [2_000] }).toBe('completed')
      }
      expect(readAgentFile(kitHelper.path, 'kit.txt')).toBe(WORD_K)
      expect(readAgentFile(bareDir, 'bare.txt')).toBe(WORD_B)
    })

    await test.step('the group result returns to the coordinator’s chat', async () => {
      const chatId = (await cinna.page.evaluate((id) => window.api.tasks.get(id), taskId)).chatId!
      await expect.poll(async () => cinna.page.evaluate(async (id) => {
        const chat = await window.api.chat.get(id)
        return (chat?.messages ?? []).filter((m) => m.role === 'system' && m.content.startsWith('Handover group `autorun` has finished — 2 handovers:')).length
      }, chatId), { timeout: TURN, intervals: [2_000] }).toBe(1)
      const packet = await cinna.page.evaluate(async (id) => (await window.api.chat.get(id))!.messages.find((m) => m.role === 'system')!.content, chatId)
      expect(packet).toContain('`auto-kit` — done')
      expect(packet).toContain('`auto-bare` — done')
      expect(packet).toContain(WORD_K)
      expect(packet).toContain(WORD_B)
    })

    await expect.poll(() => statusOf(cinna, taskId), { message: 'the coordinator task completes', timeout: TURN, intervals: [2_000] }).toBe('completed')
    await expectInboxStayedEmpty(watch)
  } finally {
    await watch.stop()
    await attachState(cinna)
  }
})

// ─── 6 ──────────────────────────────────────────────────────────────────────

test('@live 6 with Handovers at its default a brief with no execution field gates', async ({ cinna }) => {
  test.setTimeout(5 * 60_000)
  await arrangeModel(cinna)
  const folder = writeProject(cinna, 'quiet-project', 'Quiet Project')
  const agent = await adoptFolder(cinna, folder)
  expect(await handoversSetting(cinna, agent.id)).toBeNull()

  const b = brief('20261002-1600-quiet', 'Quiet note', 'quiet.txt', 'MOSS')
  try {
    const landedAt = writeBrief(folder, b)
    const taskId = await expectGated(cinna, folder, b, landedAt, '6 default')
    expect(await rowOf(cinna, taskId)).toEqual({ state: 'gated', warning: null, execution: 'receiver' })
    // Not a repository, so the standing option is offered.
    await gateCard(cinna, folder, b.title).getByRole('button', { name: 'Answer', exact: true }).click()
    const modal = cinna.page.getByLabel('Question', { exact: true })
    for (const option of [HANDOVER_GATE_OPTIONS.run, HANDOVER_GATE_OPTIONS.runAndAuto, HANDOVER_GATE_OPTIONS.skip]) {
      await expect(modal.getByRole('button', { name: option, exact: true })).toBeVisible()
    }
    expect(existsSync(join(folder, b.file))).toBe(false)
  } finally {
    await attachState(cinna)
  }
})

// ─── 7 ──────────────────────────────────────────────────────────────────────

test('@live 7 a brief written while the app is closed auto-runs at the next launch', async ({ cinna }) => {
  test.setTimeout(10 * 60_000)
  await arrangeModel(cinna)
  const folder = writeProject(cinna, 'night-project', 'Night Project')
  const agent = await adoptFolder(cinna, folder)
  const set = await cinna.page.evaluate((id) => window.api.localAgents.setHandovers(id, 'auto'), agent.id)
  expect(set.ok).toBe(true)

  const b = brief('20261002-1700-night', 'Night note', 'night.txt', 'OWL')
  await cinna.electronApp.close()
  const landedAt = writeBrief(folder, b)
  await cinna.relaunch()
  const launchedAt = Date.now()
  const watch = watchInbox(cinna)
  await cinna.skipOnboarding()
  try {
    const taskId = await test.step('it is picked up at launch and starts with no gate', async () => {
      const id = await awaitAutoStart(cinna, b, landedAt, '7 closed-app (from brief)')
      console.log(`live-autorun latency [7 closed-app]: launch → running in ${((Date.now() - launchedAt) / 1000).toFixed(1)}s`)
      return id
    })
    expect(await rowOf(cinna, taskId)).toMatchObject({ execution: 'receiver', warning: null })
    await test.step('the agent writes the file and report.md; the task is Done', () => expectDone(cinna, folder, b, taskId))
    await expectInboxStayedEmpty(watch)
  } finally {
    await watch.stop()
    await attachState(cinna)
  }
})
