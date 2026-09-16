import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'

/**
 * Real UTC minute boundaries, no patched clock or private scheduler pump.
 * Three boundaries cover dispatch, overlap prevention and persisted disable.
 * Pure/service tests cover DST and admission transaction failure exhaustively.
 */
const AGENT = 'Scheduled Report Verifier'
const NAME = 'Quarterly verification'
const MODEL = 'qwen3:8b'
const PROMPT = 'Verify scheduled report {{literal-data}}.'
const CHANGED = 'Verify the revised scheduled report {{new-literal-data}}.'
const QUESTION = 'May the scheduled report be published?'
const ANSWER = 'Publish'
const OUTPUT = 'Scheduled report verified: juniper-6382.'
const MINUTE_TIMEOUT = 80_000

async function catalogue() {
  const unexpected: string[] = []
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] })); return
    }
    if (req.url === '/api/version') { res.end(JSON.stringify({ version: '0.6.2' })); return }
    unexpected.push(`${req.method} ${req.url}`); res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, unexpected,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) } }
}
function writeSchedule(path: string, prompt: string) {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  manifest.schedules = [{ name: NAME, cron_string: '* * * * *', timezone: 'UTC', schedule_type: 'static_prompt', prompt, enabled: true }]
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
}
async function arrange(cinna: CinnaApp, host: string) {
  await cinna.skipOnboarding()
  const acp = await installFakeAcpEngine(cinna, { prompt: { emit: [
    { kind: 'elicitation', params: { message: QUESTION, requestedSchema: { type: 'object', properties: {
      question_0: { type: 'string', title: 'Publication', description: QUESTION,
        oneOf: [{ const: ANSWER, title: ANSWER, description: 'Publish the verified report' }, { const: 'Hold', title: 'Hold' }] }
    } } } },
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: OUTPUT } } }
  ] } })
  await cinna.page.evaluate(async ({ host, model }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Schedule fixture', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
  }, { host, model: MODEL })
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  const manifestPath = join(agent.path, MANIFEST_FILE)
  writeSchedule(manifestPath, PROMPT)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { agent, acp, manifestPath }
}
async function openSchedules(cinna: CinnaApp) {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: AGENT, exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('tablist', { name: 'Agent details', exact: true }).getByRole('tab', { name: 'Schedules', exact: true }).click()
  await expect(cinna.page.getByRole('region', { name: 'Local schedules', exact: true })).toBeVisible()
}
function scheduleRow(cinna: CinnaApp) { return cinna.page.getByRole('article', { name: NAME, exact: true }) }
async function list(cinna: CinnaApp, agentId: string) { return cinna.page.evaluate((id) => window.api.localSchedules.list(id), agentId) }
async function review(cinna: CinnaApp, prompt: string) {
  await scheduleRow(cinna).getByRole('button', { name: 'Review and enable', exact: true }).click()
  const dialog = cinna.page.getByRole('dialog', { name: 'Enable schedule', exact: true })
  await expect(dialog.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(prompt)
  await expect(dialog).toContainText('* * * * * · UTC')
  await expect(dialog).toContainText('Each run has a 20-turn and 60-minute limit.')
  return dialog
}
async function openInbox(cinna: CinnaApp) {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)
}
const mainMinute = (cinna: CinnaApp) => cinna.electronApp.evaluate(() => Math.floor(Date.now() / 60_000))

test('a locally reviewed schedule dispatches on real minutes, waits for Inbox input and stays disabled after restart', async ({ cinna }) => {
  test.setTimeout(300_000)
  const fake = await catalogue()
  try {
    const { agent, acp, manifestPath } = await arrange(cinna, fake.host)
    await openSchedules(cinna)
    await expect(scheduleRow(cinna)).toContainText('Not enabled on this device.')
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
    expect(acp.received('session/prompt')).toEqual([])
    const cancelledReview = await review(cinna, PROMPT)
    await cancelledReview.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
    expect((await list(cinna, agent.id))[0].binding).toBeNull()

    const dialog = await review(cinna, PROMPT)
    const beforeEnableMinute = await mainMinute(cinna)
    await dialog.getByRole('button', { name: 'Enable on this device', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(scheduleRow(cinna).getByRole('button', { name: 'Disable', exact: true })).toBeVisible()
    const [enabled] = await list(cinna, agent.id)
    expect(enabled).toMatchObject({ profileUserId: expect.any(String), name: NAME, timezone: 'UTC', prompt: PROMPT,
      problem: null, binding: { enabled: true, reason: null } })
    const bindingId = enabled.binding!.id
    const jobId = enabled.binding!.jobId
    const jobs = await cinna.page.evaluate(() => window.api.jobs.list())
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ id: jobId, prompt: PROMPT, router: 'script', budget: { maxRounds: 20, maxMinutes: 60 },
      script: { version: 1, agents: { worker: { kind: 'agent', source: 'folder', manifestId: agent.manifestId } },
        steps: [{ id: 'run', agent: 'worker', prompt: '{{goal}}' }] } })
    if (await mainMinute(cinna) === beforeEnableMinute) expect(acp.received('session/prompt')).toEqual([])
    await openInbox(cinna)

    await test.step('the first later matching minute starts one main-owned task with chat closed', async () => {
      await expect.poll(() => acp.received('session/prompt').length, { timeout: MINUTE_TIMEOUT, intervals: [250, 500] }).toBe(1)
    })
    const wire = acp.received('session/prompt')[0].params?.prompt as { type: string; text: string }[]
    expect(wire.map((part) => part.text).join('')).toBe(PROMPT)
    const runs = await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId)
    expect(runs).toHaveLength(1)
    const run = runs[0]
    expect(run).toMatchObject({ taskId: expect.any(String), localChatId: expect.any(String), status: 'running' })
    const taskId = run.taskId!
    await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), taskId)).toMatchObject({ status: 'blocked' })
    const [first] = await list(cinna, agent.id)
    expect(first.binding?.last).toMatchObject({ taskId, runId: run.id, status: 'dispatched' })
    const firstMinute = first.binding!.last!.utcMinute
    const firstCivil = first.binding!.last!.civilKey
    const ask = cinna.page.getByRole('article').filter({ hasText: QUESTION })
    await expect(ask).toBeVisible()
    const entries = await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)
    expect(entries).toHaveLength(1)
    const child = await cinna.page.evaluate((id) => window.api.tasks.get(id), entries[0].taskId!)
    expect(child).toMatchObject({ parentTaskId: taskId, assignee: { kind: 'agent', agentId: agent.id }, status: 'blocked' })
    expect(acp.answers('elicitation/create')).toEqual([])

    await test.step('the next real minute records overlap instead of dispatching another agent', async () => {
      await expect.poll(async () => (await list(cinna, agent.id))[0].binding?.last,
        { timeout: MINUTE_TIMEOUT, intervals: [250, 500] }).toMatchObject({ status: 'skipped_overlap', taskId })
    })
    const skipped = (await list(cinna, agent.id))[0].binding!.last!
    expect(skipped.utcMinute).toBeGreaterThan(firstMinute)
    expect(skipped.civilKey).not.toBe(firstCivil)
    expect(acp.received('session/prompt')).toHaveLength(1)
    expect(await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId)).toHaveLength(1)
    await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)
    await ask.getByRole('button', { name: 'Answer', exact: true }).click()
    await cinna.page.getByRole('button', { name: /^Publish/ }).click()
    await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect.poll(() => acp.answers('elicitation/create').map((entry) => entry.result))
      .toEqual([{ action: 'accept', content: { question_0: ANSWER } }])
    await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), taskId)).toMatchObject({ status: 'completed' })
    await expect.poll(() => cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId))
      .toEqual([expect.objectContaining({ id: run.id, taskId, status: 'succeeded' })])
    expect(await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)).toEqual([])
    const childChat = await cinna.page.evaluate((id) => window.api.chat.get(id), child.chatId!)
    expect(childChat?.messages.filter((message) => message.role === 'assistant' && message.content === OUTPUT)).toHaveLength(1)

    writeSchedule(manifestPath, CHANGED)
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openSchedules(cinna)
    await expect(scheduleRow(cinna)).toContainText('The schedule changed. Review it before enabling again.')
    expect((await list(cinna, agent.id))[0].binding).toMatchObject({ id: bindingId, enabled: false })
    const changedReview = await review(cinna, CHANGED)
    await changedReview.getByRole('button', { name: 'Enable on this device', exact: true }).click()
    await expect(changedReview).toHaveCount(0)
    await scheduleRow(cinna).getByRole('button', { name: 'Disable', exact: true }).click()
    await expect(scheduleRow(cinna)).toContainText('Not enabled on this device.')
    const disabled = (await list(cinna, agent.id))[0]
    expect(disabled.binding).toMatchObject({ id: bindingId, enabled: false, reason: null })
    expect(acp.received('session/prompt')).toHaveLength(1)
    const jobIds = (await cinna.page.evaluate(() => window.api.jobs.list())).map((job) => job.id)
    const disabledMinute = await mainMinute(cinna)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openSchedules(cinna)
    await expect(scheduleRow(cinna)).toContainText('Not enabled on this device.')
    expect((await list(cinna, agent.id))[0].binding).toMatchObject({ id: bindingId, enabled: false })
    await test.step('disabled opt-in survives restart and another observed real minute without replay', async () => {
      await expect.poll(() => mainMinute(cinna), { timeout: MINUTE_TIMEOUT, intervals: [250, 500] }).toBeGreaterThan(disabledMinute)
      // Trigger the same public-window event as user focus, never an internal
      // scheduler method. The aligned minute timer remains real throughout.
      await cinna.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('index.html'))?.emit('focus')
      })
      await scheduleRow(cinna).getByRole('button', { name: 'Review and enable', exact: true }).waitFor({ state: 'visible' })
      expect((await list(cinna, agent.id))[0].binding).toMatchObject({ id: bindingId, enabled: false })
      expect(acp.received('session/prompt')).toHaveLength(1)
      const allRuns = await cinna.page.evaluate(async (ids) => (await Promise.all(ids.map((id) => window.api.jobs.listRuns(id)))).flat(), jobIds)
      expect(allRuns).toEqual([expect.objectContaining({ id: run.id, taskId, status: 'succeeded' })])
    })
    const roots = await cinna.page.evaluate(() => window.api.tasks.list({ rootOnly: true }))
    expect(roots).toEqual([expect.objectContaining({ id: taskId, status: 'completed' })])
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})
