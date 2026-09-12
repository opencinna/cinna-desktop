import { randomUUID } from 'node:crypto'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL } from '../fixtures/scriptAcpEngine'
import { jobRemoteService, linkSandboxAccount, TITLE, GOAL, NOTE, LOCAL_AGENT, REMOTE_AGENT,
  AGENT_ID, REMOTE_ID, REMOTE_KEY, RECEIPT } from '../fixtures/jobRemoteService'
import type { TaskScript } from '../../src/shared/taskScript'

async function restart(cinna: CinnaApp): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
}
async function openJob(cinna: CinnaApp, title: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
  // The Job row precedes its same-titled entry in the separate Tasks region.
  await cinna.page.getByText(title, { exact: true }).first().click()
}
function mutationCounts(fake: Awaited<ReturnType<typeof jobRemoteService>>) {
  return {
    creates: fake.requests.filter((row) => row.method === 'POST' && row.path === '/api/v1/tasks/').length,
    executes: fake.requests.filter((row) => row.method === 'POST' && row.path.endsWith('/execute')).length,
    local: fake.state.localSends
  }
}

/** Job type remains local provenance while its current bound Task owns refresh. */
test('a local-origin Job handed remote exposes bound-task refresh without another dispatch', async ({ cinna }) => {
  const fake = await jobRemoteService()
  try {
    await cinna.skipOnboarding()
    const jobId = await cinna.page.evaluate(async ({ host, title, goal, name }) => {
      const agent = await window.api.agents.upsert({ name, protocol: 'a2a',
        cardUrl: `${host}/.well-known/agent-card.json`, endpointUrl: `${host}/a2a` })
      if (!agent.success || !agent.id) throw new Error('Could not create fixture agent')
      const job = await window.api.jobs.create({ type: 'local', title, prompt: goal })
      await window.api.jobs.setAgents(job.id, [agent.id])
      return job.id
    }, { host: fake.host, title: TITLE, goal: GOAL, name: LOCAL_AGENT })
    await restart(cinna)
    // This ordinary job only prepares a turn; handoff below is the user action.
    const prepared = await cinna.page.evaluate((id) => window.api.jobs.execute(id), jobId)
    expect(prepared).toMatchObject({ type: 'local', disposition: 'renderer_turn' })
    const [original] = await cinna.page.evaluate(() => window.api.tasks.list())
    const [run] = await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId)
    expect(run).toMatchObject({ taskId: original.id, type: 'local', refreshMode: 'none' })
    expect(original).toMatchObject({ jobId, executor: 'desktop', origin: 'local' })
    expect(mutationCounts(fake)).toEqual({ creates: 0, executes: 0, local: 0 })
    await linkSandboxAccount(cinna, fake.host)
    fake.state.refuseNote = false
    await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
    await cinna.page.getByRole('region', { name: 'Tasks', exact: true })
      .getByRole('button', { name: TITLE, exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Hand off', exact: true }).click()
    const dialog = cinna.page.getByRole('dialog', { name: 'Hand off task', exact: true })
    await dialog.getByRole('combobox', { name: 'Remote agent', exact: true }).selectOption({ label: REMOTE_AGENT })
    await dialog.getByRole('textbox', { name: 'Handoff note', exact: true }).fill(NOTE)
    await dialog.getByRole('button', { name: 'Hand off', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(cinna.page.getByText('This task is running in the service that holds it.', { exact: true })).toBeVisible()
    expect(mutationCounts(fake)).toEqual({ creates: 1, executes: 1, local: 0 })
    const handed = await cinna.page.evaluate((id) => window.api.tasks.get(id), original.id)
    expect(handed).toMatchObject({ executor: 'remote', origin: 'local', chatId: original.chatId,
      remote: { id: REMOTE_ID, key: REMOTE_KEY } })
    expect((await cinna.page.evaluate((id) => window.api.chat.get(id), original.chatId!))?.messages
      .filter((message) => message.role === 'agent_transition').map((message) => message.content)).toEqual([RECEIPT])
    await cinna.page.getByRole('button', { name: 'Open the conversation', exact: true }).click()
    await cinna.page.getByRole('button', { name: `From job ${TITLE}`, exact: true }).click()
    const refresh = cinna.page.getByRole('button', { name: 'Refresh status', exact: true })
    await expect(refresh).toBeVisible()
    const expected = { id: run.id, type: 'local', taskId: original.id, localChatId: original.chatId,
      refreshMode: 'bound_task', status: 'running' }
    expect((await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId))[0]).toMatchObject(expected)
    expect((await cinna.page.evaluate((id) => window.api.jobs.get(id), jobId)).recentRuns[0]).toMatchObject(expected)
    const detailReads = fake.requests.filter((row) => row.path.endsWith('/detail')).length
    fake.state.task!.status = 'completed'
    fake.state.task!.updated_at = new Date().toISOString()
    fake.state.remoteRunning = false
    await refresh.click()
    await expect(cinna.page.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 20_000 })
    expect(fake.requests.filter((row) => row.path.endsWith('/detail')).length).toBeGreaterThan(detailReads)
    // Scheduler reads may coalesce with the button. The public refresh result must
    // independently use the bound Task despite the unchanged local-origin type.
    const refreshed = await cinna.page.evaluate((id) => window.api.jobs.refreshRun(id, { force: true }), run.id)
    expect(refreshed).toMatchObject({ ...expected, status: 'succeeded' })
    expect(mutationCounts(fake)).toEqual({ creates: 1, executes: 1, local: 0 })
    await restart(cinna)
    await openJob(cinna, TITLE)
    await expect(cinna.page.getByText('Succeeded', { exact: true })).toBeVisible()
    expect(await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId))
      .toEqual([expect.objectContaining({ ...expected, status: 'succeeded' })])
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toHaveLength(1)
    expect(mutationCounts(fake)).toEqual({ creates: 1, executes: 1, local: 0 })
    expect(fake.state.unauthorized).toEqual([])
  } finally { fake.server.closeAllConnections(); await new Promise<void>((resolve) => fake.server.close(() => resolve())) }
})

test('an accepted main-owned Job starts one ACP step without a renderer model prompt or restart replay', async ({ cinna }) => {
  const fake = await scriptAcpEngine()
  const title = 'Accepted Job execution'
  const goal = 'Verify the regional plan.'
  const reply = 'Regional plan verified: spruce-4618.'
  const summary = `Script completed.\n\nverify:\n${reply}`
  try {
    await cinna.skipOnboarding()
    await fake.install(cinna)
    await cinna.page.evaluate(async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Job executor fixture', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
    }, { host: fake.host, model: SCRIPT_MODEL })
    const agent = await createFolderAgent(cinna, await addAgentRoot(cinna), 'Job Verification Agent')
    const script: TaskScript = { version: 1, agents: { worker: { kind: 'agent', source: 'folder',
      manifestId: agent.manifestId, name: agent.name } }, steps: [{ id: 'verify', agent: 'worker', prompt: 'VERIFY {{goal}}' }] }
    const job = await cinna.page.evaluate((input) => window.api.jobs.create(input),
      { type: 'local' as const, title, prompt: goal, router: 'script' as const, script, budget: { maxRounds: 3, maxMinutes: 1 } })
    await restart(cinna)
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openJob(cinna, title)
    await cinna.page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect.poll(() => fake.calls.length).toBe(1)
    expect(fake.calls[0].text).toBe(`VERIFY ${goal}`)
    expect(fake.calls[0].released).toBe(false)
    expect(fake.unexpected).toEqual([])
    const [run] = await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), job.id)
    expect(run).toMatchObject({ status: 'running', type: 'local', refreshMode: 'none', taskId: expect.any(String), localChatId: expect.any(String) })
    const children = await cinna.page.evaluate((parentTaskId) => window.api.tasks.list({ parentTaskId }), run.taskId!)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ parentTaskId: run.taskId, assignee: { kind: 'agent', agentId: agent.id } })
    fake.calls[0].release(reply)
    await expect.poll(() => cinna.page.evaluate((id) => window.api.jobs.listRuns(id), job.id))
      .toEqual([expect.objectContaining({ id: run.id, taskId: run.taskId, localChatId: run.localChatId, status: 'succeeded' })])
    const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), run.localChatId!)
    expect(chat?.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([goal])
    expect(chat?.messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([summary])
    expect(chat?.messages.filter((message) => message.role === 'error')).toEqual([])
    expect(fake.calls).toHaveLength(1)
    expect(fake.unexpected).toEqual([])
    await restart(cinna)
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openJob(cinna, title)
    await expect(cinna.page.getByText('Succeeded', { exact: true })).toBeVisible()
    await cinna.page.getByRole('region', { name: 'Tasks', exact: true })
      .getByRole('button', { name: title, exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Open the conversation', exact: true }).click()
    await expect(cinna.page.getByText(summary, { exact: true })).toHaveCount(1)
    expect((await cinna.page.evaluate((id) => window.api.chat.get(id), run.localChatId!))?.messages).toEqual(chat?.messages)
    expect(await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), job.id)).toHaveLength(1)
    expect(fake.calls).toHaveLength(1)
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

test('a pointer-only historical remote Job run adopts one Task and survives restart without execute replay', async ({ cinna }) => {
  const fake = await jobRemoteService()
  const title = 'Historical remote attempt'
  const runId = randomUUID()
  try {
    await cinna.skipOnboarding()
    await linkSandboxAccount(cinna, fake.host)
    const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
    const job = await cinna.page.evaluate((input) => window.api.jobs.create(input),
      { type: 'cinna_task' as const, title, prompt: GOAL, cinnaAgentId: AGENT_ID, cinnaPriority: 'normal' })
    fake.state.includeInLists = false // Adoption must come from the old run's pointer, not discovery.
    fake.state.remoteRunning = true
    fake.state.task = { id: REMOTE_ID, short_code: REMOTE_KEY, title, original_message: GOAL,
      current_description: 'Work already running before desktop upgrade.', priority: 'normal', status: 'in_progress',
      selected_agent_id: AGENT_ID, agent_name: REMOTE_AGENT, external_ref: '', updated_at: new Date().toISOString() }
    // Public execution cannot create this pre-Task shape. Seed only historical bookkeeping,
    // with the public-created Job and exact current sandbox owner; no Task INSERT.
    const changed = await cinna.electronApp.evaluate(({ app }, input) => {
      if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
      const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
      const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(`${app.getPath('userData')}/cinna.db`)
      try { return db.prepare(`INSERT INTO job_runs
        (id,job_id,user_id,type,status,cinna_task_id,cinna_short_code,task_id,started_at,created_at)
        VALUES (?,?,?,'cinna_task','running',?,?,NULL,?,?)`).run(input.runId,input.jobId,input.userId,
          input.remoteId,input.remoteKey,input.now,input.now).changes }
      finally { db.close() }
    }, { userData: cinna.sandbox.userData, runId, jobId: job.id, userId: user!.id,
      remoteId: REMOTE_ID, remoteKey: REMOTE_KEY, now: Math.floor(Date.now() / 1000) })
    expect(changed).toBe(1)
    expect(await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), job.id))
      .toEqual([expect.objectContaining({ id: runId, taskId: null, refreshMode: 'legacy_adoption', status: 'running' })])
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
    await restart(cinna)
    await openJob(cinna, title)
    await expect.poll(() => cinna.page.evaluate((id) => window.api.jobs.listRuns(id), job.id))
      .toEqual([expect.objectContaining({ id: runId, taskId: expect.any(String), refreshMode: 'bound_task' })])
    const [adopted] = await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), job.id)
    const tasks = await cinna.page.evaluate(() => window.api.tasks.list())
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: adopted.taskId, jobId: job.id, jobRunId: runId, executor: 'remote', remote: { id: REMOTE_ID } })
    expect((await cinna.page.evaluate((id) => window.api.jobs.get(id), job.id)).recentRuns[0])
      .toMatchObject({ id: runId, taskId: adopted.taskId, refreshMode: 'bound_task' })
    expect(mutationCounts(fake)).toEqual({ creates: 0, executes: 0, local: 0 })
    await restart(cinna)
    await openJob(cinna, title)
    expect(await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), job.id))
      .toEqual([expect.objectContaining({ id: runId, taskId: adopted.taskId, refreshMode: 'bound_task' })])
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toHaveLength(1)
    fake.state.task.status = 'completed'
    fake.state.task.updated_at = new Date().toISOString()
    fake.state.remoteRunning = false
    fake.state.includeInLists = true
    await expect(cinna.page.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 20_000 })
    expect(await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), job.id))
      .toEqual([expect.objectContaining({ id: runId, taskId: adopted.taskId, status: 'succeeded' })])
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toHaveLength(1)
    expect(mutationCounts(fake)).toEqual({ creates: 0, executes: 0, local: 0 })
    expect(fake.state.unauthorized).toEqual([])
  } finally { fake.server.closeAllConnections(); await new Promise<void>((resolve) => fake.server.close(() => resolve())) }
})
