import type { LocalAgentDto, AgentRootDto } from '../../src/shared/localAgents'
import { homeDir, type CinnaApp } from './app'

/**
 * Arrange steps, through the same IPC the UI uses. A test asserts on the step
 * it is about and seeds everything before it here: seconds via `window.api`
 * against minutes of click choreography that breaks on every layout change.
 */

/** Register `<sandbox home>/<name>` as an agents root, through the (stubbed) OS picker. */
export async function addAgentRoot(cinna: CinnaApp, name = 'agents-root'): Promise<AgentRootDto> {
  const dir = homeDir(cinna, name)
  await cinna.stubDirectoryPicker(dir)
  const added = await cinna.page.evaluate(() => window.api.localAgents.rootAdd())
  if (added.cancelled) throw new Error('the stubbed directory picker reported cancelled')
  return added.root
}

/** Scaffold a folder agent into `root` from the bundled kit contract. */
export async function createFolderAgent(
  cinna: CinnaApp,
  root: AgentRootDto,
  name: string,
  description = `${name}, scaffolded by the E2E suite.`
): Promise<LocalAgentDto> {
  return cinna.page.evaluate(
    (input) => window.api.localAgents.create(input),
    { rootId: root.id, name, description }
  )
}

/**
 * A local task bound to `chatId`. No task-creation IPC exists, so this writes
 * the row through a second handle on the sandbox database (the pattern of
 * `remote-inbox.spec.ts`), refusing any other profile. A `completed` desktop
 * task, so nothing tries to run it.
 */
export async function seedChatTask(
  cinna: CinnaApp,
  input: { chatId: string; title: string; status?: 'completed' | 'blocked' | 'new' }
): Promise<string> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  if (!user) throw new Error('no active profile to own the task')
  return cinna.electronApp.evaluate(({ app }, row) => {
    if (app.getPath('userData') !== row.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${row.userData}/cinna.db`, { fileMustExist: true })
    const id = `e2e-task-${Date.now().toString(36)}`
    const now = Math.floor(Date.now() / 1000)
    try {
      db.prepare(`INSERT INTO tasks (id, user_id, title, goal, status, chat_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, row.userId, row.title, row.title, row.status, row.chatId, now, now)
    } finally { db.close() }
    return id
  }, { userData: cinna.sandbox.userData, userId: user.id, chatId: input.chatId, title: input.title, status: input.status ?? 'completed' })
}
