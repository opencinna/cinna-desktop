import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'

/**
 * Folder tasks (Unified Tasks phase 2): a bare agent's work queue is
 * `<folder>/.cinna/tasks/*.md`, and Cinna indexes those files as tasks and
 * writes back only the lines it owns.
 *
 * ## What is real
 *
 * The bare agent is a folder holding `CLAUDE.md`, adopted over `folder-pick` →
 * `folder-add` with the OS picker stubbed. The task files and `_board.yaml` are
 * written by the test with `writeFileSync`, as an editor or a script would —
 * after the app is up, so the watcher (or the five-second pass) is what finds
 * them. Every move, edit, create and delete goes through the UI; the file on
 * disk is the witness for each write. No model, engine or credential.
 *
 * ## What it proves
 *
 * - A file written from outside is listed with its own status word, the board
 *   filtered to the agent shows the folder's columns in `_board.yaml` order,
 *   and the task page shows the File row, the "Changed outside Cinna" glyph,
 *   Blocked by (as a link to the blocking file task) and the custom fields.
 * - An outside rewrite of another file's status word and title is followed by
 *   the list and the board.
 * - A board move and an Edit-task title change land in the file as exactly two
 *   changed lines — every other byte, the nested `meta:` map, the comment and
 *   the body included, is unchanged — and the glyph is gone (Cinna wrote it).
 * - New task with the agent as assignee offers the folder's words and writes a
 *   new `.md`; Delete task removes that file.
 *
 * ## What it does not
 *
 * Absence grace, symlinks, subtasks, the handoff section and a running task's
 * file are unit-tested (`folderTaskAdapter.test.ts`,
 * `taskSyncService.folder.test.ts`), not driven here. A real agent editing its
 * own file is `live-folder-tasks.spec.ts`.
 */

const AGENT_HEADING = 'Docs Desk'
const BOARD_YAML = 'Inbox: backlog\nUp Next: ready\nDoing: active\nShipped: done\n'

const DOCS_TITLE = 'Write the setup docs'
const DOCS_RENAMED = 'Write the install guide'
const LOGIN_TITLE = 'Fix the login form'
const LOGIN_RENAMED = 'Fix the sign-in form'
const NEW_TITLE = 'Draft release notes'

/** A task file as a third-party tool writes it: comment, custom scalar, nested map, block list, body. */
const DOCS_FILE = [
  '---',
  '# written by the planning script',
  `title: ${DOCS_TITLE}`,
  'status: Inbox',
  'priority: high',
  'area: docs',
  'meta:',
  '  owner: kim',
  '  sprint: 14',
  'blocked_by: [fix-login]',
  '---',
  '',
  'Cover install, first run and upgrade.',
  '',
  'Keep it short.',
  ''
].join('\n')

const loginFile = (title: string, status: string): string => [
  '---',
  `title: ${title}`,
  `status: ${status}`,
  '---',
  '',
  'The submit button does nothing on Safari.',
  ''
].join('\n')

const tasksButton = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: 'Tasks', exact: true })
const layout = (cinna: CinnaApp) => cinna.page.getByRole('group', { name: 'Tasks layout' })
const folderColumn = (cinna: CinnaApp, word: string) => cinna.page.locator(`[data-folder-column="${word}"]`)
const details = (cinna: CinnaApp) => cinna.page.getByRole('complementary', { name: 'Details', exact: true })

/** The board filtered to one agent. Both choices survive a visit to a task page. */
async function showAgentBoard(cinna: CinnaApp, agentName: string): Promise<void> {
  await cinna.page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption({ label: agentName })
  await layout(cinna).getByRole('button', { name: 'Board', exact: true }).click()
  await expect(cinna.page.locator('[data-tasks-board="folder"]')).toBeVisible()
}

/** A bare project: a folder that is an agent because it holds CLAUDE.md. */
function writeProject(cinna: CinnaApp, dir: string): string {
  const folder = homeDir(cinna, dir)
  writeFileSync(join(folder, 'CLAUDE.md'), `# ${AGENT_HEADING}\n\nYou keep this project's docs.\n`)
  return folder
}

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
    return task ? { id: task.id, status: task.status, statusLabel: task.statusLabel ?? null } : null
  }, title)

const taskFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')).sort() : []

test('folder tasks: an outside file is indexed, an outside edit is followed, and UI edits patch only their lines', async ({ cinna }) => {
  test.setTimeout(120_000)
  await cinna.skipOnboarding()
  const folder = writeProject(cinna, 'docs-desk')
  const agent = await adoptFolder(cinna, folder)
  // Seeded agents reach the Tasks view's agent filter and the New task picker only after a restart.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const tasksDir = join(folder, '.cinna', 'tasks')
  const docsPath = join(tasksDir, 'write-docs.md')
  const loginPath = join(tasksDir, 'fix-login.md')

  await test.step('files written from outside show up in the list with their words', async () => {
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(join(tasksDir, '_board.yaml'), BOARD_YAML)
    writeFileSync(loginPath, loginFile(LOGIN_TITLE, 'Inbox'))
    writeFileSync(docsPath, DOCS_FILE)

    await tasksButton(cinna).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: 'Tasks', exact: true })).toBeVisible()
    await layout(cinna).getByRole('button', { name: 'List', exact: true }).click()
    const backlog = cinna.page.getByRole('region', { name: 'Backlog', exact: true })
    await expect(backlog.getByRole('button', { name: `${DOCS_TITLE} — Inbox`, exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(backlog.getByRole('button', { name: `${LOGIN_TITLE} — Inbox`, exact: true })).toBeVisible()
    await expect(backlog.getByRole('heading', { level: 2 })).toHaveText('Backlog2')

    const docs = await taskByTitle(cinna, DOCS_TITLE)
    expect(docs).toEqual({ id: expect.any(String), status: 'new', statusLabel: 'Inbox' })
  })

  await test.step('the board filtered to the agent has the folder’s columns, in _board.yaml order', async () => {
    await showAgentBoard(cinna, agent.name)
    const board = cinna.page.locator('[data-tasks-board="folder"]')
    await expect(board.locator('[data-folder-column]')).toHaveCount(4)
    expect(await board.locator('[data-folder-column]').evaluateAll(
      (columns) => columns.map((column) => column.getAttribute('data-folder-column'))
    )).toEqual(['Inbox', 'Up Next', 'Doing', 'Shipped'])
    await expect(folderColumn(cinna, 'Inbox').getByRole('button', { name: `${DOCS_TITLE} — Inbox`, exact: true })).toBeVisible()
    await expect(folderColumn(cinna, 'Inbox').getByRole('button', { name: `${LOGIN_TITLE} — Inbox`, exact: true })).toBeVisible()
  })

  await test.step('the task page shows the File row, the outside glyph, Blocked by and the fields', async () => {
    await folderColumn(cinna, 'Inbox').getByRole('button', { name: `${DOCS_TITLE} — Inbox`, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: DOCS_TITLE, exact: true })).toBeVisible()
    const file = details(cinna).locator('[data-task-file]')
    await expect(file).toHaveText('write-docs.md')
    expect(realpathSync(await file.getAttribute('title') ?? '')).toBe(realpathSync(docsPath))
    const outside = details(cinna).locator('[data-task-from-outside]')
    await expect(outside).toBeVisible()
    await expect(outside).toHaveAttribute('aria-label', 'Changed outside Cinna')
    // fix-login is the other file task of the same agent, so its id links to it by title.
    await expect(details(cinna).locator('[data-task-blocked-by]').getByRole('button', { name: LOGIN_TITLE, exact: true }))
      .toBeVisible()
    await expect(details(cinna).getByText('Inbox', { exact: true })).toBeVisible()
    const fields = details(cinna).getByRole('region', { name: 'Fields', exact: true })
    await expect(fields.getByRole('term').filter({ hasText: /^area$/ })).toHaveCount(1)
    await expect(fields.getByRole('term').filter({ hasText: /^meta$/ })).toHaveCount(1)
    await cinna.page.getByRole('button', { name: 'Back to Tasks', exact: true }).click()
    // The Agent filter is remembered, so Back to Tasks lands on the same folder board.
    await expect(cinna.page.locator('[data-tasks-board="folder"]')).toBeVisible()
  })

  await test.step('an outside rewrite of the status word and title is followed by the board and the list', async () => {
    writeFileSync(loginPath, loginFile(LOGIN_RENAMED, 'Shipped'))
    await expect(folderColumn(cinna, 'Shipped').getByRole('button', { name: `${LOGIN_RENAMED} — Shipped`, exact: true }))
      .toBeVisible({ timeout: 15_000 })
    await expect(folderColumn(cinna, 'Inbox').locator('[data-task-card]')).toHaveCount(1)
    await expect.poll(async () => (await taskByTitle(cinna, LOGIN_RENAMED))?.status).toBe('completed')

    await layout(cinna).getByRole('button', { name: 'List', exact: true }).click()
    await expect(cinna.page.getByRole('region', { name: 'Done', exact: true })
      .getByRole('button', { name: `${LOGIN_RENAMED} — Shipped`, exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: new RegExp(`^${LOGIN_TITLE} — `) })).toHaveCount(0)
    await layout(cinna).getByRole('button', { name: 'Board', exact: true }).click()
    await expect(cinna.page.locator('[data-tasks-board="folder"]')).toBeVisible()
  })

  await test.step('Move to Up Next and an Edit task title change patch exactly those two lines', async () => {
    await cinna.page.getByRole('button', { name: `Actions for ${DOCS_TITLE}`, exact: true }).click()
    const menu = cinna.page.getByRole('menu', { name: 'Task actions', exact: true })
    await menu.getByRole('menuitem', { name: 'Move to Up Next', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(folderColumn(cinna, 'Up Next').getByRole('button', { name: `${DOCS_TITLE} — Up Next`, exact: true })).toBeVisible()
    await expect.poll(() => readFileSync(docsPath, 'utf8'), { timeout: 15_000 }).toContain('\nstatus: Up Next\n')
    await expect.poll(async () => (await taskByTitle(cinna, DOCS_TITLE))?.status).toBe('open')

    await folderColumn(cinna, 'Up Next').getByRole('button', { name: `${DOCS_TITLE} — Up Next`, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: DOCS_TITLE, exact: true })).toBeVisible()
    await cinna.page.getByRole('button', { name: 'More actions', exact: true }).click()
    await cinna.page.getByRole('menu', { name: 'Task actions', exact: true })
      .getByRole('menuitem', { name: 'Edit task…', exact: true }).click()
    const dialog = cinna.page.getByRole('dialog', { name: 'Edit task', exact: true })
    await dialog.getByLabel('Title', { exact: true }).fill(DOCS_RENAMED)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(cinna.page.getByRole('heading', { level: 1, name: DOCS_RENAMED, exact: true })).toBeVisible()

    const expected = DOCS_FILE
      .replace(`\ntitle: ${DOCS_TITLE}\n`, `\ntitle: ${DOCS_RENAMED}\n`)
      .replace('\nstatus: Inbox\n', '\nstatus: Up Next\n')
    await expect.poll(() => readFileSync(docsPath, 'utf8'), { timeout: 15_000 }).toBe(expected)
    // Cinna wrote these bytes, but over content that came from outside: a
    // Cinna edit never vouches for what it did not write, so the mark stays
    // until the user approves the content (the dispatcher's gate).
    await expect(details(cinna).locator('[data-task-file]')).toHaveText('write-docs.md')
    await expect(details(cinna).locator('[data-task-from-outside]')).toHaveCount(1)
    expect(taskFiles(tasksDir)).toEqual(['fix-login.md', 'write-docs.md'])
    await cinna.page.getByRole('button', { name: 'Back to Tasks', exact: true }).click()
  })

  await test.step('New task for the agent writes a new file, and Delete task removes it', async () => {
    await cinna.page.getByRole('button', { name: 'New task', exact: true }).click()
    const dialog = cinna.page.getByRole('dialog', { name: 'New task', exact: true })
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(NEW_TITLE)
    await dialog.getByRole('button', { name: 'More options', exact: true }).click()
    await dialog.getByLabel('Assignee', { exact: true }).selectOption({ label: agent.name })
    // The Backlog/Ready choices take the assignee folder's own words.
    await expect(dialog.getByLabel('Status', { exact: true }).locator('option')).toHaveText(['Inbox', 'Up Next'])
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(cinna.page.getByRole('heading', { level: 1, name: NEW_TITLE, exact: true })).toBeVisible()

    await expect.poll(() => taskFiles(tasksDir)).toHaveLength(3)
    const created = taskFiles(tasksDir).filter((name) => name !== 'fix-login.md' && name !== 'write-docs.md')
    expect(created).toHaveLength(1)
    const createdPath = join(tasksDir, created[0])
    const text = readFileSync(createdPath, 'utf8')
    expect(text).toMatch(/^---\ncinna_task: 1\nid: t-[a-z0-9]+\n/)
    expect(text).toContain(`\ntitle: ${NEW_TITLE}\n`)
    expect(text).toContain('\nstatus: Inbox\n')
    expect(text).toContain('\norigin: cinna\n')
    await expect(details(cinna).locator('[data-task-file]')).toHaveText(created[0])
    await expect(details(cinna).locator('[data-task-from-outside]')).toHaveCount(0)

    await cinna.page.getByRole('button', { name: 'More actions', exact: true }).click()
    await cinna.page.getByRole('menu', { name: 'Task actions', exact: true })
      .getByRole('menuitem', { name: 'Delete task…', exact: true }).click()
    const confirm = cinna.page.getByRole('dialog', { name: 'Delete task', exact: true })
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect.poll(() => existsSync(createdPath)).toBe(false)
    expect(taskFiles(tasksDir)).toEqual(['fix-login.md', 'write-docs.md'])
    await expect.poll(async () => await taskByTitle(cinna, NEW_TITLE)).toBeNull()
  })
})
