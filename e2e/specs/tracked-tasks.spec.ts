import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { showTasksLayout } from '../fixtures/tasksView'
import { adoptBare, arrangeScripted, okResult, openTasksView, taskStatus } from '../fixtures/dispatcher'
import { scriptAcpEngine, type ScriptAcpEngine, type ScriptAcpHeld } from '../fixtures/scriptAcpEngine'

/**
 * Tracked tasks: a conversation takes a task on itself (`session_owned`) —
 * `tasks_create` with `category: active`, or a `tasks_report` that attaches to
 * a task nothing has run, by its row id or by a task file's own id — and from
 * then on only a report (or a person's move) settles it; a turn's end, and a
 * typed message, never do.
 *
 * Real: the session's `cinna` loopback MCP server, `taskToolService` (attach,
 * file-id refs with the awaited index pass), `inboxService.endTurn` and
 * `beginTurn`, the folder adapter writing the status word, the task DTO's
 * `chat` (title + running), the Tasks view's rows and live dot, the task page's
 * Details `Chat` row. Scripted: what each ACP turn calls (`scriptAcpAgent.mjs`).
 * No model, nothing billed.
 *
 * Not proved: that a model picks these tools; the dispatcher continuing a
 * session-owned task in its chat after a drag to Ready (plan §5's third case);
 * the Inbox answer to a `blocked` question resuming the chat (an ACP ask never
 * becomes a stored answer, see `dispatcher.ts`); the live dot while running
 * (asserted only idle); device sync of `session_owned`.
 */

const HEADING = 'Granite Notes'
const SLUG = 'granite-notes'
const CHAT = 'Plan the granite work'
const TITLE = 'Index the granite-5521 notes'
const DESCRIPTION = 'Build an index of every granite note in this folder.'

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] }

/** The refusal text of a tool call that the service refused (`isError`). */
function refusal(held: ScriptAcpHeld): string {
  const result = (held.params.results as { result: ToolResult }[])[0].result
  expect(result.isError, JSON.stringify(result)).toBe(true)
  return result.content.find((item) => item.type === 'text')?.text ?? ''
}

/** The scripted engine, a bare agent adopted and restarted into the Tasks view's Agent filter. */
async function arrange(cinna: CinnaApp, fake: ScriptAcpEngine): Promise<{ agentId: string; folder: string }> {
  await arrangeScripted(cinna, fake)
  await addAgentRoot(cinna)
  const bare = await adoptBare(cinna, SLUG, HEADING)
  // Adopted agents reach the Tasks view's Agent filter only after a restart.
  await cinna.relaunch()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return bare
}

async function directChat(cinna: CinnaApp, agentId: string, title: string): Promise<string> {
  return cinna.page.evaluate(async ({ agentId, title }) => {
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { agentId, router: 'direct', title })
    return chat.id
  }, { agentId, title })
}

/** Start a turn over IPC and answer the index of its held prompt. */
async function startTurn(cinna: CinnaApp, fake: ScriptAcpEngine, chatId: string, content: string): Promise<number> {
  const before = fake.calls.length
  await cinna.page.evaluate((input) => window.api.run.start(input), { chatId, content })
  await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(before + 1)
  return before
}

/** Release `held` with one tool call; answers that call's held result. */
async function callTool(fake: ScriptAcpEngine, held: { release(reply: any): void }, name: string, args: Record<string, unknown>): Promise<ScriptAcpHeld> {
  const before = fake.tools.length
  held.release({ tools: [{ name, args }] })
  await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(before + 1)
  return fake.tools[before]
}

/** End the turn with `text` and wait until the chat has stored it. */
async function endTurn(cinna: CinnaApp, held: { release(reply: any): void }, chatId: string, text: string): Promise<void> {
  held.release({ text })
  await expect.poll(async () => JSON.stringify((await cinna.page.evaluate((id) => window.api.chat.get(id), chatId))?.messages ?? []), { timeout: 60_000 })
    .toContain(text)
}

/** The task's row in the List layout's `section` region, filtered to the agent. */
function listRow(cinna: CinnaApp, section: string, title: string) {
  return cinna.page.getByRole('region', { name: section, exact: true }).getByRole('button', { name: new RegExp(`^${title} — `) })
}

async function openTaskFromList(cinna: CinnaApp, section: string, title: string): Promise<void> {
  await listRow(cinna, section, title).click()
  await expect(cinna.page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

/** The `status:` word in a task file's frontmatter. */
function fileWord(path: string): string {
  return readFileSync(path, 'utf8').match(/^status: (.+)$/m)?.[1] ?? ''
}

/**
 * Details' Status value. A folder task shows its file's word there (`in_progress`,
 * `blocked`, `completed`), not the category; the List region the row sits in is
 * what proves the category.
 */
function statusPill(cinna: CinnaApp) {
  return cinna.page.getByRole('complementary', { name: 'Details' }).getByRole('definition').first()
}

test.describe('tracked tasks', () => {
  test.setTimeout(240_000)

  test('an active create binds the chat, and only a report settles it', async ({ cinna }) => {
    const fake = await scriptAcpEngine()
    try {
      const { agentId, folder } = await arrange(cinna, fake)
      const chatId = await directChat(cinna, agentId, CHAT)
      let taskId = ''
      let taskFile = ''
      let doneWord = ''

      await test.step('tasks_create with category active answers attached and binds the chat', async () => {
        const i = await startTurn(cinna, fake, chatId, 'Let us index the granite notes.')
        const held = await callTool(fake, fake.calls[i], 'tasks_create', { title: TITLE, description: DESCRIPTION, category: 'active' })
        const created = okResult(held)
        expect(created).toMatchObject({ title: TITLE, attached: true, status: 'in_progress', relations: ['assigned', 'created'], assignee: { agentId } })
        taskId = created.ref
        taskFile = join(folder, created.file)
        await endTurn(cinna, held, chatId, 'Started the granite index.')
        // The start wrote the first of the default active words (`DEFAULT_FOLDER_STATUS_WORDS`).
        expect(fileWord(taskFile)).toBe('in_progress')
        const task = await cinna.page.evaluate((id) => window.api.tasks.get(id), taskId)
        expect({ chatId: task.chatId, sessionOwned: task.sessionOwned }).toEqual({ chatId, sessionOwned: true })
      })

      await test.step('the row shows In progress with the chat’s name and an idle dot; Details links the chat', async () => {
        await openTasksView(cinna, HEADING)
        await showTasksLayout(cinna.page, 'List')
        const row = listRow(cinna, 'In progress', TITLE)
        await expect(row).toBeVisible({ timeout: 15_000 })
        await expect(row).toHaveAccessibleName(new RegExp(`^${TITLE} — .+, in ${CHAT}$`))
        await expect(row.locator('[data-task-row-chat]')).toHaveText(`in ${CHAT}`)
        await expect(row.locator('[data-task-live-dot]')).toHaveAttribute('data-task-live-dot', 'idle', { timeout: 15_000 })

        await openTaskFromList(cinna, 'In progress', TITLE)
        await expect(statusPill(cinna)).toHaveText('in_progress')
        const details = cinna.page.getByRole('complementary', { name: 'Details' })
        await expect(details.getByText('Chat', { exact: true })).toBeVisible()
        await expect(details.locator('[data-task-session-state]')).toHaveText('Idle')
        await details.getByRole('button', { name: CHAT, exact: true }).click()
        await expect(cinna.page.getByText('Started the granite index.', { exact: true })).toBeVisible()
      })

      await test.step('the turn’s end left it In progress; a second turn reports done and it closes', async () => {
        const i = await startTurn(cinna, fake, chatId, 'Finish the index.')
        // The first turn has fully ended by now: a second could not start otherwise.
        expect(await taskStatus(cinna, taskId)).toBe('in_progress')
        const held = await callTool(fake, fake.calls[i], 'tasks_report', { status: 'done', summary: 'Indexed 42 granite notes.' })
        expect(okResult(held)).toMatchObject({ ref: taskId, status: 'done', taskStatus: 'completed', category: 'done' })
        await endTurn(cinna, held, chatId, 'The index is done.')
        expect(await taskStatus(cinna, taskId)).toBe('completed')
        doneWord = fileWord(taskFile)

        await openTasksView(cinna, HEADING)
        await showTasksLayout(cinna.page, 'List')
        await expect(listRow(cinna, 'Done', TITLE)).toBeVisible({ timeout: 15_000 })
        await expect(cinna.page.getByRole('region', { name: 'In progress', exact: true }).getByRole('button')).toHaveCount(0)
        await openTaskFromList(cinna, 'Done', TITLE)
        // No `_board.yaml`: the canonical word (`folder_tasks.md`, "Which word
        // Cinna writes") — unlike `tasks_update {category: done}`, which writes `done`.
        expect(doneWord).toBe('completed')
        await expect(statusPill(cinna)).toHaveText(doneWord)
      })
      expect(fake.unexpected).toEqual([])
    } finally { await fake.close() }
  })

  test('a report on a file the test wrote attaches the chat by the file’s own id', async ({ cinna }) => {
    const fake = await scriptAcpEngine()
    try {
      const { agentId, folder } = await arrange(cinna, fake)
      const chatId = await directChat(cinna, agentId, 'Work the ITAN queue')
      const tasksDir = join(folder, '.cinna', 'tasks')
      mkdirSync(tasksDir, { recursive: true })
      const file = join(tasksDir, 'ITAN-0001.md')
      writeFileSync(file, '---\ncinna_task: 1\nid: ITAN-0001\ntitle: Reconcile the ITAN-0001 ledger\nstatus: open\n---\n\nReconcile the ledger.\n')

      const i = await startTurn(cinna, fake, chatId, 'Pick up ITAN-0001.')
      const held = await callTool(fake, fake.calls[i], 'tasks_report', { ref: 'ITAN-0001', status: 'in_progress', summary: 'Reconciling the ledger.' })
      const reported = okResult(held)
      expect(reported).toMatchObject({ attached: true, status: 'in_progress', taskStatus: 'in_progress', category: 'active' })
      await endTurn(cinna, held, chatId, 'On the ledger now.')
      const task = await cinna.page.evaluate((id) => window.api.tasks.get(id), reported.ref)
      expect({ title: task.title, chatId: task.chatId, sessionOwned: task.sessionOwned, status: task.status })
        .toEqual({ title: 'Reconcile the ITAN-0001 ledger', chatId, sessionOwned: true, status: 'in_progress' })
      // The first of the default active words (`DEFAULT_FOLDER_STATUS_WORDS`).
      expect(readFileSync(file, 'utf8')).toMatch(/^status: in_progress$/m)
      expect(readFileSync(file, 'utf8')).toMatch(/^id: ITAN-0001$/m)

      await openTasksView(cinna, HEADING)
      await showTasksLayout(cinna.page, 'List')
      const row = listRow(cinna, 'In progress', 'Reconcile the ITAN-0001 ledger')
      await expect(row).toBeVisible({ timeout: 15_000 })
      await expect(row.locator('[data-task-row-chat]')).toHaveText('in Work the ITAN queue')
      expect(fake.unexpected).toEqual([])
    } finally { await fake.close() }
  })

  test('blocked stays blocked through a typed message and closes on a report', async ({ cinna }) => {
    const fake = await scriptAcpEngine()
    try {
      const { agentId, folder } = await arrange(cinna, fake)
      const chatId = await directChat(cinna, agentId, CHAT)
      const QUESTION = 'Which notebook holds the granite-5521 notes?'

      let i = await startTurn(cinna, fake, chatId, 'Let us index the granite notes.')
      let held = await callTool(fake, fake.calls[i], 'tasks_create', { title: TITLE, description: DESCRIPTION, category: 'active' })
      const created = okResult(held)
      const taskId = created.ref
      const taskFile = join(folder, created.file)
      held = await callTool(fake, held, 'tasks_report', { status: 'blocked', summary: 'Need the notebook.', question: QUESTION })
      expect(okResult(held)).toMatchObject({ ref: taskId, status: 'blocked', taskStatus: 'blocked', category: 'waiting' })
      await endTurn(cinna, held, chatId, 'I need to know which notebook.')
      expect(await taskStatus(cinna, taskId)).toBe('blocked')
      expect(fileWord(taskFile)).toBe('blocked')

      await openTasksView(cinna, HEADING)
      await showTasksLayout(cinna.page, 'List')
      await expect(listRow(cinna, 'Waiting', TITLE)).toBeVisible({ timeout: 15_000 })

      // The user types a plain message in that chat and the turn ends.
      await openTaskFromList(cinna, 'Waiting', TITLE)
      await expect(statusPill(cinna)).toHaveText('blocked')
      await cinna.page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: CHAT, exact: true }).click()
      const composer = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
      await composer.fill('It is the blue notebook.')
      await cinna.page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(i + 2)
      i = i + 1
      expect(fake.calls[i].text).toContain('It is the blue notebook.')
      await endTurn(cinna, fake.calls[i], chatId, 'Thanks, noted.')

      // Still Waiting once that turn ended: checked when the next one starts.
      i = await startTurn(cinna, fake, chatId, 'Go ahead.')
      expect(await taskStatus(cinna, taskId)).toBe('blocked')
      expect(fileWord(taskFile)).toBe('blocked')
      held = await callTool(fake, fake.calls[i], 'tasks_report', { status: 'done', summary: 'Indexed the blue notebook.' })
      expect(okResult(held)).toMatchObject({ ref: taskId, status: 'done', taskStatus: 'completed' })
      await endTurn(cinna, held, chatId, 'Done.')

      await openTasksView(cinna, HEADING)
      await showTasksLayout(cinna.page, 'List')
      await expect(listRow(cinna, 'Done', TITLE)).toBeVisible({ timeout: 15_000 })
      expect(fileWord(taskFile)).toBe('completed')
      await openTaskFromList(cinna, 'Done', TITLE)
      await expect(statusPill(cinna)).toHaveText('completed')
      expect(fake.unexpected).toEqual([])
    } finally { await fake.close() }
  })

  test('an active create is refused with an assignee and while the chat has a task in hand', async ({ cinna }) => {
    const fake = await scriptAcpEngine()
    try {
      await arrangeScripted(cinna, fake)
      const root = await addAgentRoot(cinna)
      const other = await createFolderAgent(cinna, root, 'Other queue keeper')
      const { agentId } = await adoptBare(cinna, SLUG, HEADING)
      await cinna.relaunch()
      await cinna.page.evaluate(() => window.api.localAgents.rescan())
      const chatId = await directChat(cinna, agentId, CHAT)

      const i = await startTurn(cinna, fake, chatId, 'Plan the granite work.')
      let held = await callTool(fake, fake.calls[i], 'tasks_create', {
        title: 'Delegated granite work', description: DESCRIPTION, category: 'active', assignee: `kit:${encodeURIComponent(other.id)}`
      })
      expect(refusal(held)).toBe('`category: active` is for your own queue; a delegation starts at once')

      held = await callTool(fake, held, 'tasks_create', { title: TITLE, description: DESCRIPTION, category: 'active' })
      const taskId = okResult(held).ref
      held = await callTool(fake, held, 'tasks_create', { title: 'A second granite task', description: DESCRIPTION, category: 'active' })
      expect(refusal(held)).toBe(`This conversation is already working on ${taskId}`)
      await endTurn(cinna, held, chatId, 'One task at a time.')

      const titles = (await cinna.page.evaluate(() => window.api.tasks.list())).map((task) => task.title)
      expect(titles).toContain(TITLE)
      expect(titles).not.toContain('Delegated granite work')
      expect(titles).not.toContain('A second granite task')
      expect(fake.unexpected).toEqual([])
    } finally { await fake.close() }
  })
})
