import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { requireLiveKey, seedOpenAiDefaultMode } from '../fixtures/live'

/**
 * @live — **a real agent edits its own task file.** A bare folder agent on the
 * real pinned OpenCode runtime (`engine: true`) with the OpenAI key from
 * `.env` is asked in its own chat to change one line of
 * `.cinna/tasks/<file>.md`; the board then moves the card to that word's
 * column and the task's status becomes `completed`. The chat is the only thing
 * the test drives; the file, main's task status and the board are the
 * witnesses. The model-free half of folder tasks (outside files, outside
 * edits, UI writes, create and delete) is `folder-tasks.spec.ts`.
 *
 * The prompt names the new word (`Shipped`), so the word alone proves nothing;
 * what proves the agent did it is the file on disk changing from `Up Next`
 * (with its title and name kept), after a turn the test did not script, and
 * Cinna then reading that change into the task and the board.
 *
 * Known flakiness of the model and runtime, which the generous poll absorbs
 * rather than the assertions: pinned OpenCode sometimes freezes a write tool
 * call (the stall watchdog retries once), and gpt-4.1-mini sometimes writes to
 * the filesystem root — hence the exact path relative to the agent's working
 * folder in the prompt.
 *
 * ## Cost
 *
 * One OpenCode turn of 2–4 requests over a ~10k-token system prompt on the
 * first of `PREFERRED_MODELS` the key lists (gpt-4.1-mini normally): about
 * **$0.01–0.03 a run**. Chat auto-titles are off. Run deliberately:
 * `make e2e-one SPEC=live-folder-tasks`.
 */

test.use({ engine: true })
test.beforeEach(() => requireLiveKey())

const AGENT_HEADING = 'Release Desk'
const TITLE = 'Publish the release notes'
const FILE = 'publish-notes.md'

const TASK_FILE = [
  '---',
  `title: ${TITLE}`,
  'status: Up Next',
  'area: release',
  '---',
  '',
  'Post the notes for 2.4 on the website.',
  ''
].join('\n')

/** Adopt a bare folder over `folder-pick` → `folder-add`; returns its agent id and name. */
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

const taskByTitle = (cinna: CinnaApp, title: string) =>
  cinna.page.evaluate(async (t) => {
    const task = (await window.api.tasks.list()).find((entry) => entry.title === t)
    return task ? { status: task.status, statusLabel: task.statusLabel ?? null } : null
  }, title)

const folderColumn = (cinna: CinnaApp, word: string) => cinna.page.locator(`[data-folder-column="${word}"]`)

test('@live a real agent moves its own task by editing the task file', async ({ cinna }) => {
  test.setTimeout(5 * 60_000)
  await cinna.skipOnboarding()
  const model = await seedOpenAiDefaultMode(cinna)
  console.log(`live-folder-tasks model: ${model}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))

  const folder = homeDir(cinna, 'release-desk')
  writeFileSync(join(folder, 'CLAUDE.md'), `# ${AGENT_HEADING}\n\nYou own this project. Do what the user asks with your file tools, then say done. Never ask the user anything.\n`)
  const agent = await adoptFolder(cinna, folder)
  // Seeded agents and credentials reach the sidebar, the composer and the Agent filter only after a restart.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const tasksDir = join(folder, '.cinna', 'tasks')
  const taskPath = join(tasksDir, FILE)

  await test.step('the task file written from outside stands in Up Next on the agent’s board', async () => {
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(join(tasksDir, '_board.yaml'), 'Inbox: backlog\nUp Next: ready\nDoing: active\nShipped: done\n')
    writeFileSync(taskPath, TASK_FILE)
    await expect.poll(() => taskByTitle(cinna, TITLE), { timeout: 15_000 }).toEqual({ status: 'open', statusLabel: 'Up Next' })
  })

  await test.step('in its own chat, the agent is asked to change the status line', async () => {
    await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await cinna.page.getByRole('button', { name: `Start a new chat with ${agent.name}`, exact: true }).click()
    const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await input.fill(
      `In your working folder there is a file at the relative path .cinna/tasks/${FILE} ` +
      '(open it as ./.cinna/tasks/' + FILE + ', never at the filesystem root). ' +
      'Edit that file: change its line "status: Up Next" to "status: Shipped". ' +
      'Change nothing else in the file. Then reply with the single word done.'
    )
    await input.press('Enter')
    // The composer is renamed while a turn runs: the turn really started.
    await expect(cinna.page.getByRole('combobox', { name: 'Send a follow-up · Esc Esc to stop', exact: true }))
      .toBeVisible({ timeout: 30_000 })
  })

  await test.step('the file says Shipped, the task is completed and the board shows it in Shipped', async () => {
    await expect.poll(() => (existsSync(taskPath) ? readFileSync(taskPath, 'utf8') : '(missing)'), {
      timeout: 2 * 60_000,
      intervals: [1000]
    }).toMatch(/^status: Shipped\r?$/m)
    // The model's whitespace is its own business; the task must still be the same task.
    expect(readFileSync(taskPath, 'utf8')).toMatch(new RegExp(`^title: ${TITLE}\\r?$`, 'm'))
    expect(readdirSync(tasksDir).filter((name) => name.endsWith('.md'))).toEqual([FILE])
    await expect.poll(() => taskByTitle(cinna, TITLE), { timeout: 30_000 }).toEqual({ status: 'completed', statusLabel: 'Shipped' })

    await cinna.page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await cinna.page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption({ label: agent.name })
    await cinna.page.getByRole('group', { name: 'Tasks layout' }).getByRole('button', { name: 'Board', exact: true }).click()
    await expect(cinna.page.locator('[data-tasks-board="folder"]')).toBeVisible()
    await expect(folderColumn(cinna, 'Shipped').getByRole('button', { name: `${TITLE} — Shipped`, exact: true })).toBeVisible()
    await expect(folderColumn(cinna, 'Up Next').locator('[data-task-card]')).toHaveCount(0)
  })
})
