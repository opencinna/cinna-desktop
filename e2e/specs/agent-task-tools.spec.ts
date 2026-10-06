import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { filterTasksByAgent, showTasksLayout } from '../fixtures/tasksView'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpHeld } from '../fixtures/scriptAcpEngine'
import { LOG_CLOSE, LOG_OPEN } from '../../src/shared/folderTasks'

/**
 * The agent task tools (`tasks_create`, `tasks_list`, `tasks_update`,
 * `tasks_comment`) driven by a bare folder agent in its own chat, through the
 * session's `cinna` loopback MCP server — the agent's own queue, no assignee.
 *
 * Real: the loopback MCP server and its session token, `taskToolService`,
 * `taskAuthoringService` writing `.cinna/tasks/<slug>.md`, the folder adapter's
 * comment log, the turn header's `ready tasks` line, the Tasks view and the
 * task page. Scripted: what each ACP turn decides to call (`scriptAcpAgent.mjs`).
 * No model, nothing billed.
 *
 * Not proved: that a model would pick these tools, delegation through
 * `tasks_create` (the `delegation-*` specs), `tasks_report` on the chat's own
 * task, the 20-per-chat cap and the depth cap (unit-tested in
 * `taskToolService.test.ts`).
 */

const BARE_HEADING = 'Granite Notes'
const OTHER_AGENT = 'Other queue keeper'
const TITLE = 'Index the granite-5521 notes'
const DESCRIPTION = 'Build an index of every granite note in this folder.'
const OTHER_TITLE = 'Someone else’s obsidian-8812 task'
const COMMENT = 'Indexed 42 granite notes; see notes/index.md.'

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] }

function results(held: ScriptAcpHeld): ToolResult[] {
  return (held.params.results as { result: ToolResult }[]).map((entry) => entry.result)
}

/** The JSON a successful tool call answered; a product refusal (`isError`) fails with its text. */
function ok(result: ToolResult): any {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  return JSON.parse(result.content.find((item) => item.type === 'text')!.text!)
}

/** Adopt `dir` over the `folder-pick` → `folder-add` pair the dialog uses (`delegation-bare.spec.ts`). */
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

test('a bare agent keeps its own queue through the task tools', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await cinna.skipOnboarding()
    await fake.install(cinna)
    await cinna.page.evaluate(async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Task tools fixture', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
    }, { host: fake.host, model: SCRIPT_MODEL })

    const root = await addAgentRoot(cinna)
    const other = await createFolderAgent(cinna, root, OTHER_AGENT)
    const folder = homeDir(cinna, 'granite-notes')
    writeFileSync(join(folder, 'CLAUDE.md'), `# ${BARE_HEADING}\n\nYou keep the granite notes.\n`)
    const agentId = await adoptFolder(cinna, folder)
    const otherTask = await cinna.page.evaluate(
      (agentId) => window.api.tasks.create({ title: 'Someone else’s obsidian-8812 task', status: 'open', assignee: { kind: 'agent', agentId } }),
      other.id
    )
    expect(otherTask.title).toBe(OTHER_TITLE)
    // Adopted agents reach the Tasks view's Agent filter only after a restart.
    await cinna.relaunch()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())

    const chatId = await cinna.page.evaluate(async (agentId) => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { agentId, router: 'direct', title: 'Plan the granite work' })
      return chat.id
    }, agentId)
    const tasksDir = join(folder, '.cinna', 'tasks')
    let taskId = ''
    let taskFile = ''

    await test.step('tasks_create without an assignee writes a ready task file in the agent’s folder', async () => {
      await cinna.page.evaluate((id) => window.api.run.start({ chatId: id, content: 'Plan the granite work.' }), chatId)
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(1)
      // Nothing is ready for this agent yet, so the header has no such line.
      expect(fake.calls[0].text).not.toContain('ready tasks:')
      fake.calls[0].release({ tools: [{ name: 'tasks_create', args: { title: TITLE, description: DESCRIPTION, category: 'ready' } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(1)
      const created = ok(results(fake.tools[0])[0])
      expect(created).toMatchObject({ title: TITLE, status: 'open', category: 'ready', relations: ['assigned', 'created'], assignee: { agentId } })
      expect(created.file).toMatch(/^\.cinna\/tasks\/.+\.md$/)
      taskId = created.ref
      taskFile = join(folder, created.file)
      fake.tools[0].release({ text: 'Queued the granite index.' })

      expect(readdirSync(tasksDir)).toEqual([created.file.split('/').pop()])
      const text = readFileSync(taskFile, 'utf8')
      expect(text).toContain(`title: ${TITLE}`)
      // `open` is the first of the default ready words (`DEFAULT_FOLDER_STATUS_WORDS`).
      expect(text).toMatch(/^status: open$/m)
      expect(text).toContain(DESCRIPTION)

      await cinna.page.getByRole('button', { name: 'Tasks', exact: true }).click()
      await filterTasksByAgent(cinna.page, BARE_HEADING)
      await showTasksLayout(cinna.page, 'List')
      await expect(cinna.page.getByRole('region', { name: 'Ready' }).getByRole('button', { name: `${TITLE} — open` })).toBeVisible({ timeout: 15_000 })
      await expect(cinna.page.getByRole('region', { name: 'Ready' }).getByRole('button')).toHaveCount(1)
    })

    await test.step('the next turn’s header counts the ready task', async () => {
      await expect.poll(async () => JSON.stringify((await cinna.page.evaluate((id) => window.api.chat.get(id), chatId))?.messages ?? []), { timeout: 60_000 })
        .toContain('Queued the granite index.')
      await cinna.page.evaluate((id) => window.api.run.start({ chatId: id, content: 'Check your queue and finish the index.' }), chatId)
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(2)
      expect(fake.calls[1].sessionId).toBe(fake.calls[0].sessionId)
      expect(fake.calls[1].text).toMatch(/^- (?:.* · )?ready tasks: 1$/m)
    })

    await test.step('tasks_list answers the task as assigned and created', async () => {
      fake.calls[1].release({ tools: [{ name: 'tasks_list', args: {} }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(2)
      const listed = ok(results(fake.tools[1])[0]) as { tasks: any[] }
      const mine = listed.tasks.filter((task) => task.ref === taskId)
      expect(mine, JSON.stringify(listed)).toHaveLength(1)
      expect(mine[0]).toMatchObject({ title: TITLE, category: 'ready', statusLabel: 'open', relations: ['assigned', 'created'], file: `.cinna/tasks/${taskFile.split('/').pop()}` })
      // Another agent's queue is never listed.
      expect(listed.tasks.map((task) => task.ref)).not.toContain(otherTask.id)
    })

    await test.step('tasks_update to done rewrites the file’s status word and moves the task to Done', async () => {
      fake.tools[1].release({ tools: [{ name: 'tasks_update', args: { ref: taskId, category: 'done' } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(3)
      expect(ok(results(fake.tools[2])[0])).toMatchObject({ ref: taskId, status: 'completed', category: 'done', statusLabel: 'done' })
      expect(readFileSync(taskFile, 'utf8')).toMatch(/^status: done$/m)
      await expect(cinna.page.getByRole('region', { name: 'Done' }).getByRole('button', { name: `${TITLE} — done` })).toBeVisible({ timeout: 15_000 })
      await expect(cinna.page.getByRole('region', { name: 'Ready' }).getByRole('button')).toHaveCount(0)
    })

    await test.step('tasks_comment shows under Comments and lands in the file’s log section', async () => {
      fake.tools[2].release({ tools: [{ name: 'tasks_comment', args: { ref: taskId, body: COMMENT } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(4)
      const commented = ok(results(fake.tools[3])[0])
      expect(commented).toMatchObject({ ref: taskId, commentId: expect.any(String) })
      expect(commented.warning).toBeUndefined()

      const text = readFileSync(taskFile, 'utf8')
      const open = text.indexOf(LOG_OPEN)
      const close = text.indexOf(LOG_CLOSE)
      expect(open, text).toBeGreaterThan(-1)
      expect(close, text).toBeGreaterThan(open)
      expect(text.slice(open, close)).toContain(COMMENT)
      expect(text.slice(open, close)).toContain(`**${BARE_HEADING}** · `)

      await cinna.page.getByRole('region', { name: 'Done' }).getByRole('button', { name: `${TITLE} — done` }).click()
      await expect(cinna.page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible()
      await expect(cinna.page.locator('[data-task-file]')).toHaveText(taskFile.split('/').pop()!)
      // Created and appended by Cinna: the file is still trusted as its own.
      await expect(cinna.page.locator('[data-task-from-outside]')).toHaveCount(0)
      const comments = cinna.page.locator('section').filter({ has: cinna.page.getByRole('heading', { level: 2, name: 'Comments', exact: true }) })
      await expect(comments.getByRole('listitem')).toHaveCount(1, { timeout: 15_000 })
      await expect(comments.getByRole('listitem').getByText(COMMENT, { exact: true })).toBeVisible()
      await expect(comments.getByRole('listitem').getByRole('button', { name: BARE_HEADING, exact: true })).toBeVisible()
    })

    await test.step('tasks_update on another agent’s task is refused to the agent', async () => {
      const before = await cinna.page.evaluate((id) => window.api.tasks.get(id), otherTask.id)
      fake.tools[3].release({ tools: [{ name: 'tasks_update', args: { ref: otherTask.id, category: 'done' } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(5)
      const refused = results(fake.tools[4])[0]
      expect(refused.isError, JSON.stringify(refused)).toBe(true)
      expect(refused.content.find((item) => item.type === 'text')?.text)
        .toBe('You can change only tasks assigned to you, or tasks you created that nobody has started.')
      fake.tools[4].release({ text: 'The index is done.' })
      const after = await cinna.page.evaluate((id) => window.api.tasks.get(id), otherTask.id)
      expect({ status: after.status, title: after.title, updatedAt: after.updatedAt }).toEqual({ status: before.status, title: before.title, updatedAt: before.updatedAt })
      expect(fake.unexpected).toEqual([])
    })
  } finally { await fake.close() }
})
