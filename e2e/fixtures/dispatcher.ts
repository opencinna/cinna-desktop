import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, homeDir, type CinnaApp } from './app'
import { SCRIPT_MODEL, type ScriptAcpEngine, type ScriptAcpHeld } from './scriptAcpEngine'

/**
 * Arrange helpers for the task dispatcher specs (`task-dispatcher*.spec.ts`):
 * the scripted ACP engine behind a keyless provider, bare folders adopted over
 * the same `folder-pick` → `folder-add` pair the dialog uses, Ready tasks made
 * over IPC, and the agent's `task_update` report.
 */

export type Priority = 'low' | 'normal' | 'high' | 'urgent'
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] }

export function okResult(held: ScriptAcpHeld): any {
  const result = (held.params.results as { result: ToolResult }[])[0].result
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  return JSON.parse(result.content.find((item) => item.type === 'text')!.text!)
}

/** Onboarding skipped, the scripted engine installed and a keyless default mode pointing at it. */
export async function arrangeScripted(cinna: CinnaApp, fake: ScriptAcpEngine): Promise<void> {
  await cinna.skipOnboarding()
  await fake.install(cinna)
  await cinna.page.evaluate(async ({ host, model }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Dispatcher fixture', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
  }, { host: fake.host, model: SCRIPT_MODEL })
}

/** Adopt `dir` as a bare agent; answers its id. */
export async function adoptFolder(cinna: CinnaApp, dir: string): Promise<string> {
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

/** A bare folder `<home>/<slug>` whose CLAUDE.md is headed `heading`, adopted. */
export async function adoptBare(cinna: CinnaApp, slug: string, heading: string): Promise<{ agentId: string; folder: string }> {
  const folder = homeDir(cinna, slug)
  writeFileSync(join(folder, 'CLAUDE.md'), `# ${heading}\n\nYou keep the ${heading.toLowerCase()}.\n`)
  return { agentId: await adoptFolder(cinna, folder), folder }
}

export async function createReady(cinna: CinnaApp, agentId: string, title: string, priority: Priority = 'normal'): Promise<string> {
  const task = await cinna.page.evaluate(
    (input) => window.api.tasks.create({ title: input.title, priority: input.priority, status: 'open', assignee: { kind: 'agent', agentId: input.agentId } }),
    { agentId, title, priority }
  )
  return task.id
}

export async function taskStatus(cinna: CinnaApp, id: string): Promise<string> {
  return (await cinna.page.evaluate((taskId) => window.api.tasks.get(taskId), id)).status
}

export async function setMode(cinna: CinnaApp, agentId: string, mode: 'manual' | 'one' | 'up_to', maxRuns?: number): Promise<void> {
  const result = await cinna.page.evaluate((input) => window.api.taskDispatch.setMode(input.agentId, input.mode, input.maxRuns), { agentId, mode, maxRuns })
  if (!result.ok) throw new Error(`set-mode refused: ${result.message}`)
}

/** The index of the held prompt whose goal is `title`, once it arrives. */
export async function promptFor(fake: ScriptAcpEngine, title: string, timeout = 60_000): Promise<number> {
  const needle = `Continue this task.\n\nGoal:\n${title}`
  await expect.poll(() => fake.calls.findIndex((call) => call.text.includes(needle)), { timeout, message: `a prompt for ${title}` }).toBeGreaterThan(-1)
  return fake.calls.findIndex((call) => call.text.includes(needle))
}

/** The agent reports prompt `i`'s task completed with `task_update`, then ends its turn. */
export async function report(cinna: CinnaApp, fake: ScriptAcpEngine, i: number, taskId: string, title: string): Promise<void> {
  const toolsBefore = fake.tools.length
  fake.calls[i].release({ tools: [{ name: 'task_update', args: { id: taskId, status: 'completed' } }] })
  await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(toolsBefore + 1)
  expect(okResult(fake.tools[toolsBefore])).toMatchObject({ id: taskId, status: 'completed' })
  fake.tools[toolsBefore].release({ text: `Done: ${title}.` })
  await expect.poll(() => taskStatus(cinna, taskId), { timeout: 30_000 }).toBe('completed')
}

/** Agents → agent → Settings → Tasks: the Task queue section. */
export async function openTasksTab(cinna: CinnaApp, heading: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: heading, exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('tab', { name: /^Tasks/ }).click()
}

/** Tasks view, filtered to the agent, so its queue control is in the header. */
export async function openTasksView(cinna: CinnaApp, heading: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await cinna.page.getByRole('combobox', { name: 'Agent' }).selectOption({ label: heading })
}

/** The task's page, from the Tasks view filtered to its agent. */
export async function openTaskPage(cinna: CinnaApp, heading: string, title: string): Promise<void> {
  await openTasksView(cinna, heading)
  await cinna.page.getByRole('button', { name: new RegExp(`^${title} — `) }).click()
  await expect(cinna.page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

export async function openInbox(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox' })).toBeVisible()
}
