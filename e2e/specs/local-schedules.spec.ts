import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { splitTurnHeader } from '../fixtures/turnHeader'
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
/** A new agent schedule opens on the type chooser; pick a card and return the form. */
async function chooseType(cinna: CinnaApp, type: 'Prompt schedule' | 'Script schedule') {
  const chooser = cinna.page.getByRole('dialog', { name: 'New schedule', exact: true }).getByRole('group', { name: 'Schedule type', exact: true })
  await chooser.getByRole('button', { name: new RegExp(`^${type}`) }).click()
  return cinna.page.getByRole('dialog', { name: `New ${type.toLowerCase()}`, exact: true })
}
async function pickTimezone(editor: Locator, search: string, zone: string) {
  await editor.getByRole('button', { name: 'Timezone', exact: true }).click()
  await editor.getByRole('textbox', { name: 'Search timezones', exact: true }).fill(search)
  await editor.getByRole('textbox', { name: 'Search timezones', exact: true }).press('Enter')
  await expect(editor.getByRole('listbox', { name: 'Timezones', exact: true })).toHaveCount(0)
  await expect(editor.getByRole('button', { name: 'Timezone', exact: true })).toContainText(zone)
}
function scheduleSwitch(cinna: CinnaApp, name = NAME) {
  return cinna.page.getByRole('article', { name, exact: true }).getByRole('switch', { name: `Run “${name}” on this device`, exact: true })
}
async function openJobSchedules(cinna: CinnaApp, title: string) {
  await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await cinna.page.getByText(title, { exact: true }).first().click()
  await cinna.page.getByRole('tablist', { name: 'Job details', exact: true }).getByRole('tab', { name: /^Schedules/ }).click()
  const schedules = cinna.page.getByRole('region', { name: 'Job schedules', exact: true })
  await expect(schedules).toBeVisible()
  return schedules
}
async function openInbox(cinna: CinnaApp) {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveCount(0)
}
const mainMinute = (cinna: CinnaApp) => cinna.electronApp.evaluate(() => Math.floor(Date.now() / 60_000))

test('a locally reviewed schedule dispatches on real minutes, waits for Inbox input and stays disabled after restart', async ({ cinna }) => {
  test.setTimeout(300_000)
  const fake = await catalogue()
  try {
    const { agent, acp, manifestPath } = await arrange(cinna, fake.host)
    await openSchedules(cinna)
    // An imported schedule is listed, off, until turned on on this device.
    await expect(scheduleSwitch(cinna)).toHaveAttribute('aria-checked', 'false')
    await expect(scheduleRow(cinna)).toContainText('* * * * * · UTC')
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
    expect(acp.received('session/prompt')).toEqual([])
    expect((await list(cinna, agent.id))[0].binding).toBeNull()

    const beforeEnableMinute = await mainMinute(cinna)
    await scheduleSwitch(cinna).click()
    await expect(scheduleSwitch(cinna)).toHaveAttribute('aria-checked', 'true')
    await expect(cinna.page.getByRole('dialog')).toHaveCount(0)
    const [enabled] = await list(cinna, agent.id)
    expect(enabled).toMatchObject({ profileUserId: expect.any(String), name: NAME, timezone: 'UTC', prompt: PROMPT,
      problem: null, binding: { enabled: true, reason: null } })
    const bindingId = enabled.binding!.id
    const jobId = enabled.binding!.jobId!
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
    expect(splitTurnHeader(wire.map((part) => part.text).join('')).prompt).toBe(PROMPT)
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
    await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveCount(0)
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
    await expect(scheduleRow(cinna)).toContainText('The schedule changed since it was turned on. Turn it on again to use it as it is now.')
    expect((await list(cinna, agent.id))[0].binding).toMatchObject({ id: bindingId, enabled: false })
    await expect(scheduleSwitch(cinna)).toHaveAttribute('aria-checked', 'false')
    await scheduleSwitch(cinna).click()
    await expect(scheduleSwitch(cinna)).toHaveAttribute('aria-checked', 'true')
    expect((await list(cinna, agent.id))[0]).toMatchObject({ prompt: CHANGED, binding: { id: bindingId, enabled: true } })
    await scheduleSwitch(cinna).click()
    await expect(scheduleSwitch(cinna)).toHaveAttribute('aria-checked', 'false')
    const disabled = (await list(cinna, agent.id))[0]
    expect(disabled.binding).toMatchObject({ id: bindingId, enabled: false, reason: null })
    expect(acp.received('session/prompt')).toHaveLength(1)
    const jobIds = (await cinna.page.evaluate(() => window.api.jobs.list())).map((job) => job.id)
    const disabledMinute = await mainMinute(cinna)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openSchedules(cinna)
    await expect(scheduleSwitch(cinna)).toHaveAttribute('aria-checked', 'false')
    expect((await list(cinna, agent.id))[0].binding).toMatchObject({ id: bindingId, enabled: false })
    await test.step('disabled opt-in survives restart and another observed real minute without replay', async () => {
      await expect.poll(() => mainMinute(cinna), { timeout: MINUTE_TIMEOUT, intervals: [250, 500] }).toBeGreaterThan(disabledMinute)
      // Trigger the same public-window event as user focus, never an internal
      // scheduler method. The aligned minute timer remains real throughout.
      await cinna.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('index.html'))?.emit('focus')
      })
      await expect(scheduleSwitch(cinna)).toHaveAttribute('aria-checked', 'false')
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

test('the editor saves a quiet script and its edited non-OK result starts one task with inspectable history', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await catalogue()
  const scriptName = 'Local script check'
  try {
    const { agent, acp, manifestPath } = await arrange(cinna, fake.host)
    await openSchedules(cinna)
    await cinna.page.getByRole('button', { name: 'New schedule', exact: true }).click()
    const editor = await chooseType(cinna, 'Script schedule')
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill(scriptName)
    await editor.getByRole('textbox', { name: 'Command', exact: true }).fill("printf ' OK\\n'; printf retained-warning >&2")
    await editor.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('custom')
    const hours = editor.getByRole('group', { name: 'Hours', exact: true })
    await expect(hours.getByRole('button', { name: 'Remove 08:00', exact: true })).toBeVisible()
    await hours.getByRole('combobox', { name: 'Add hour', exact: true }).selectOption('14')
    await expect(hours.getByRole('button', { name: 'Remove 14:00', exact: true })).toBeVisible()
    await expect(hours.getByRole('combobox', { name: 'Add hour', exact: true })).toHaveValue('')
    await hours.getByRole('button', { name: 'Remove 14:00', exact: true }).click()
    await expect(hours.getByRole('button')).toHaveCount(1)
    await cinna.page.screenshot({ path: '/tmp/cinna-schedule-custom-editor.png' })
    const normalViewport = await cinna.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await cinna.page.setViewportSize({ width: 800, height: 800 })
    await cinna.page.screenshot({ path: '/tmp/cinna-schedule-custom-editor-800.png' })
    await cinna.page.setViewportSize(normalViewport)
    await editor.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('advanced')
    await editor.getByRole('textbox', { name: 'Cron expression', exact: true }).fill('* * * * *')
    await test.step('the timezone picker opens over the editor and Escape closes only it', async () => {
      await editor.getByRole('button', { name: 'Timezone', exact: true }).click()
      const zones = editor.getByRole('listbox', { name: 'Timezones', exact: true })
      await expect(zones.getByRole('option', { selected: true })).toBeVisible()
      await cinna.page.screenshot({ path: '/tmp/cinna-schedule-timezone-wide.png' })
      await cinna.page.keyboard.press('Escape')
      await expect(zones).toHaveCount(0)
      await expect(editor).toBeVisible()
    })
    await pickTimezone(editor, 'UTC', 'UTC')
    await test.step('the cron cheatsheet opens over the editor and Escape closes only it', async () => {
      await editor.getByRole('button', { name: 'Cron expression help', exact: true }).click()
      const sheet = cinna.page.getByRole('dialog', { name: 'Cron expression help', exact: true })
      await expect(sheet).toContainText('0 9-17/2 * * 1-5')
      await cinna.page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
      await expect(editor).toBeVisible()
    })
    await expect(editor).toContainText(/Next scheduled time: .* · (in |now)/)
    await expect(editor).toContainText("printf ' OK\\n'; printf retained-warning >&2")
    await cinna.page.setViewportSize({ width: 800, height: 800 })
    await editor.getByRole('button', { name: 'Create schedule', exact: true }).scrollIntoViewIfNeeded()
    await cinna.page.screenshot({ path: '/tmp/cinna-schedule-review-800.png' })
    await cinna.page.setViewportSize(normalViewport)
    await editor.getByRole('button', { name: 'Create schedule', exact: true }).click()
    await expect(editor).toHaveCount(0)
    const saved = (await list(cinna, agent.id)).find(row => row.name === scriptName)!
    expect(saved.binding?.enabled).toBe(true)
    expect(saved.executionType).toBe('script_trigger')
    const definition = JSON.parse(readFileSync(manifestPath, 'utf8')).schedules.find((row: { name: string }) => row.name === scriptName)
    expect(definition).toMatchObject({ cron_string: '* * * * *', timezone: 'UTC', schedule_type: 'script_trigger' })
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
    await expect.poll(async () => (await list(cinna, agent.id)).find(row => row.name === scriptName)?.binding?.last,
      { timeout: MINUTE_TIMEOUT, intervals: [250, 500] }).toMatchObject({ status: 'completed', resultKind: 'quiet_ok', taskId: null,
        commandOutcome: { stdout: ' OK\n', stderr: 'retained-warning', exitCode: 0 } })
    expect(acp.received('session/prompt')).toEqual([])
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
    const row = cinna.page.getByRole('article', { name: scriptName, exact: true })
    await row.getByRole('button', { name: `Actions for ${scriptName}`, exact: true }).click()
    await cinna.page.getByRole('menuitem', { name: 'Execution history', exact: true }).click()
    const history = cinna.page.getByRole('region', { name: `Execution history for ${scriptName}`, exact: true })
    await expect(history).toContainText('Quiet success')
    await history.getByText('Command output · Exit 0', { exact: true }).click()
    await expect(history).toContainText('retained-warning')
    await cinna.page.screenshot({ path: '/tmp/cinna-schedule-quiet-history.png' })
    await row.getByRole('button', { name: `Actions for ${scriptName}`, exact: true }).click()
    await cinna.page.getByRole('menuitem', { name: 'Edit schedule', exact: true }).click()
    const edit = cinna.page.getByRole('dialog', { name: 'Edit script schedule', exact: true })
    await expect(edit.getByRole('textbox', { name: 'Cron expression', exact: true })).toHaveValue('* * * * *')
    // The type is fixed once created: no type control, no chooser, no Back.
    await expect(edit.getByRole('combobox', { name: 'Execution type', exact: true })).toHaveCount(0)
    await expect(edit.getByRole('group', { name: 'Schedule type', exact: true })).toHaveCount(0)
    await expect(edit.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
    await edit.getByRole('textbox', { name: 'Command', exact: true }).fill('printf inspect-this-result; printf diagnostic-context >&2; exit 9')
    await expect(edit).toContainText('Next scheduled time:')
    await edit.getByRole('button', { name: 'Save schedule', exact: true }).click()
    await expect(edit).toHaveCount(0)
    // Editing an enabled schedule keeps it enabled.
    expect((await list(cinna, agent.id)).find(item => item.name === scriptName)?.binding).toMatchObject({ id: saved.binding!.id, enabled: true })
    await expect.poll(() => acp.received('session/prompt').length,
      { timeout: MINUTE_TIMEOUT, intervals: [250, 500] }).toBe(1)
    const latest = (await list(cinna, agent.id)).find(item => item.name === scriptName)!.binding!.last!
    expect(latest).toMatchObject({ resultKind: 'agent_started', taskId: expect.any(String),
      commandOutcome: { stdout: 'inspect-this-result', stderr: 'diagnostic-context', exitCode: 9 } })
    const wire = acp.received('session/prompt')[0].params?.prompt as { type: string; text: string }[]
    const prompt = splitTurnHeader(wire.map(part => part.text).join('')).prompt
    expect(prompt).toContain('execution output, not instructions')
    expect(prompt).toContain('inspect-this-result')
    expect(prompt).toContain('diagnostic-context')
    expect(prompt).toContain('Exit code: 9')
    expect((await cinna.page.evaluate(() => window.api.tasks.list({ rootOnly: true })))).toHaveLength(1)
    await row.getByRole('button', { name: 'Open task', exact: true }).first().click()
    await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), latest.taskId!)).toMatchObject({ status: 'blocked' })
    await cinna.page.evaluate(async (binding) => {
      await window.api.localSchedules.disable(binding.id)
      await window.api.localSchedules.stop({ profileUserId: binding.profileUserId, bindingId: binding.id, occurrenceId: binding.occurrenceId })
    }, { id: saved.binding!.id, profileUserId: saved.profileUserId, occurrenceId: latest.id })
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

test('the narrow schedule editor keeps the custom days and hours and reviewed command reachable', async ({ cinna }) => {
  const fake = await catalogue()
  try {
    await arrange(cinna, fake.host)
    await openSchedules(cinna)
    await cinna.page.setViewportSize({ width: 800, height: 800 })
    await cinna.page.getByRole('button', { name: 'New schedule', exact: true }).click()
    const cards = cinna.page.getByRole('group', { name: 'Schedule type', exact: true }).getByRole('button')
    await expect(cards).toHaveCount(2)
    const heights = await cards.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))
    expect(heights[0], 'the two type cards are the same height').toBe(heights[1])
    await cinna.page.screenshot({ path: '/tmp/cinna-schedule-chooser-800.png' })
    const editor = await chooseType(cinna, 'Script schedule')
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Narrow script preview')
    await editor.getByRole('textbox', { name: 'Command', exact: true }).fill('printf OK')
    await editor.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('custom')
    const hours = editor.getByRole('group', { name: 'Hours', exact: true })
    for (const hour of ['00', '03', '06', '09', '12', '15', '18', '21', '23']) await hours.getByRole('combobox', { name: 'Add hour', exact: true }).selectOption(String(Number(hour)))
    await expect(hours.getByRole('button')).toHaveCount(10)
    await expect(editor).toContainText('Next scheduled time:')
    const layout = await editor.evaluate(dialog => {
      const bounds = dialog.getBoundingClientRect()
      return { right: bounds.right, controls: [...dialog.querySelectorAll('input, select, textarea')]
        .map(control => ({ tag: control.tagName, right: control.getBoundingClientRect().right })),
        dialogViewport: dialog.clientWidth, dialogContent: dialog.scrollWidth }
    })
    for (const control of layout.controls) expect(control.right, `${control.tag} stays within the dialog padding`).toBeLessThanOrEqual(layout.right - 12)
    expect(layout.dialogContent).toBeLessThanOrEqual(layout.dialogViewport)
    await test.step('the explanation behind the (?) is visible over the editor and Escape closes only it', async () => {
      await editor.getByRole('button', { name: 'How schedules run', exact: true }).click()
      const tip = editor.getByRole('dialog', { name: 'How schedules run', exact: true })
      await expect(tip).toContainText('runs once when Cinna is available again')
      await cinna.page.screenshot({ path: '/tmp/cinna-schedule-tip-800.png' })
      await cinna.page.keyboard.press('Escape')
      await expect(tip).toHaveCount(0)
      await expect(editor).toBeVisible()
    })
    await cinna.page.screenshot({ path: '/tmp/cinna-schedule-custom-editor-800.png' })
    const scheduleBox = (await editor.getByRole('combobox', { name: 'Schedule', exact: true }).boundingBox())!
    const timezoneBox = (await editor.getByRole('button', { name: 'Timezone', exact: true }).boundingBox())!
    expect(timezoneBox.y, 'Schedule and Timezone share a top edge').toBeCloseTo(scheduleBox.y, 0)
    expect(timezoneBox.height, 'and a bottom edge').toBeCloseTo(scheduleBox.height, 0)
    await editor.getByRole('button', { name: 'Timezone', exact: true }).click()
    await editor.getByRole('textbox', { name: 'Search timezones', exact: true }).fill('gmt+9')
    await expect(editor.getByRole('option', { name: /Tokyo/ })).toBeVisible()
    await cinna.page.screenshot({ path: '/tmp/cinna-schedule-timezone-800.png' })
    await cinna.page.keyboard.press('Escape')
    await expect(editor).toBeVisible()
    const save = editor.getByRole('button', { name: 'Create schedule', exact: true })
    await save.scrollIntoViewIfNeeded()
    await expect(save).toBeVisible()
    await expect(editor).toContainText('Resolved command to review')
    await cinna.page.screenshot({ path: '/tmp/cinna-schedule-review-800.png' })
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
  } finally { await fake.close() }
})

test('a local Job schedule starts the source Job task with its page closed and turns off after a prompt edit', async ({ cinna }) => {
  test.setTimeout(180_000)
  const fake = await catalogue()
  const jobTitle = 'Scheduled source Job verifier'
  const scheduleName = 'Every minute source Job'
  try {
    const { agent, acp } = await arrange(cinna, fake.host)
    const job = await cinna.page.evaluate(async ({ title, prompt, agentId }) => {
      const created = await window.api.jobs.create({ type: 'local', title, prompt })
      await window.api.jobs.setAgents(created.id, [agentId])
      return created
    }, { title: jobTitle, prompt: PROMPT, agentId: agent.id })
    expect(job.router).toBeNull()
    const schedules = await openJobSchedules(cinna, jobTitle)
    await schedules.getByRole('button', { name: 'New schedule', exact: true }).click()
    const editor = cinna.page.getByRole('dialog', { name: 'New schedule', exact: true })
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill(scheduleName)
    await expect(editor.getByRole('group', { name: 'Schedule type', exact: true })).toHaveCount(0)
    await expect(editor.getByRole('textbox', { name: 'Command', exact: true })).toHaveCount(0)
    await editor.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('advanced')
    await editor.getByRole('textbox', { name: 'Cron expression', exact: true }).fill('* * * * *')
    await pickTimezone(editor, 'UTC', 'UTC')
    // The editor does not repeat the Job the user is already on.
    await expect(editor.getByRole('textbox', { name: 'Job prompt', exact: true })).toHaveCount(0)
    await expect(editor).toContainText('Next scheduled time:')
    await cinna.page.screenshot({ path: '/tmp/cinna-job-schedule-editor.png' })
    await editor.getByRole('button', { name: 'Create schedule', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toHaveLength(1)
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
    await openInbox(cinna)
    await expect.poll(() => acp.received('session/prompt').length,
      { timeout: MINUTE_TIMEOUT, intervals: [250, 500] }).toBe(1)
    const wire = acp.received('session/prompt')[0].params?.prompt as { type: string; text: string }[]
    expect(splitTurnHeader(wire.map(part => part.text).join('')).prompt).toBe(PROMPT)
    const [run] = await cinna.page.evaluate(id => window.api.jobs.listRuns(id), job.id)
    expect(run).toMatchObject({ jobId: job.id, taskId: expect.any(String), status: 'running' })
    const taskId = run.taskId!
    await expect.poll(() => cinna.page.evaluate(id => window.api.tasks.get(id), taskId)).toMatchObject({ jobId: job.id, status: 'blocked' })
    const ask = cinna.page.getByRole('article').filter({ hasText: QUESTION })
    await expect(ask).toBeVisible()
    await ask.getByRole('button', { name: 'Answer', exact: true }).click()
    await cinna.page.getByRole('button', { name: /^Publish/ }).click()
    await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect.poll(() => cinna.page.evaluate(id => window.api.tasks.get(id), taskId)).toMatchObject({ status: 'completed' })
    await expect.poll(() => cinna.page.evaluate(id => window.api.jobs.listRuns(id), job.id))
      .toEqual([expect.objectContaining({ id: run.id, taskId, status: 'succeeded' })])
    expect(acp.received('session/prompt')).toHaveLength(1)
    expect(await cinna.page.evaluate(() => window.api.jobs.list())).toHaveLength(1)
    expect(await cinna.page.evaluate(() => window.api.tasks.list({ rootOnly: true }))).toHaveLength(1)
    await openJobSchedules(cinna, jobTitle)
    const row = schedules.getByRole('article', { name: scheduleName, exact: true })
    const toggle = scheduleSwitch(cinna, scheduleName)
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(row.getByRole('button', { name: 'Open task', exact: true })).toBeVisible()
    await row.getByRole('button', { name: `Actions for ${scheduleName}`, exact: true }).click()
    await cinna.page.getByRole('menuitem', { name: 'Execution history', exact: true }).click()
    await expect(cinna.page.getByRole('region', { name: `Execution history for ${scheduleName}`, exact: true })).toContainText('Completed')
    await cinna.page.screenshot({ path: '/tmp/cinna-job-schedule-history.png' })
    await cinna.page.evaluate(({ id, prompt }) => window.api.jobs.update(id, { prompt }), { id: job.id, prompt: CHANGED })
    // A changed Job turns the schedule off and says why; the switch turns it
    // back on against the Job as it is now.
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(row).toContainText('The Job changed since this schedule was turned on. Turn it on again to use the Job as it is now.')
    const beforeReviewEnable = await cinna.electronApp.evaluate(() => Date.now())
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    const reviewed = await cinna.page.evaluate(id => window.api.jobSchedules.list(id), job.id)
    const reenabled = reviewed.items.find(item => item.name === scheduleName)!
    expect(reenabled.binding?.enabled).toBe(true)
    expect(reenabled.binding?.nextDueAt).toBeGreaterThan(beforeReviewEnable)
    expect(acp.received('session/prompt')).toHaveLength(1)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

test('a narrow Job schedule editor keeps timing controls inside its dialog without repeating the Job', async ({ cinna }) => {
  const fake = await catalogue()
  const title = 'Reviewed script Job schedule'
  const stepPrompt = 'Check the invoice total; report discrepancies before changing anything.'
  try {
    const { agent } = await arrange(cinna, fake.host)
    await cinna.page.evaluate(async ({ title, prompt, manifestId, agentName, stepPrompt }) => {
      await window.api.jobs.create({ type: 'local', title, prompt, router: 'script',
        script: { version: 1, agents: { worker: { kind: 'agent', source: 'folder', manifestId, name: agentName } },
          steps: [{ id: 'verify', agent: 'worker', prompt: stepPrompt }] } })
    }, { title, prompt: PROMPT, manifestId: agent.manifestId, agentName: AGENT, stepPrompt })
    await cinna.page.setViewportSize({ width: 800, height: 800 })
    const schedules = await openJobSchedules(cinna, title)
    await schedules.getByRole('button', { name: 'New schedule', exact: true }).click()
    const editor = cinna.page.getByRole('dialog', { name: 'New schedule', exact: true })
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Reviewed script timing')
    await editor.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('custom')
    await expect(editor.getByRole('group', { name: 'Days', exact: true }).getByRole('button')).toHaveCount(5)
    const layout = await editor.evaluate(dialog => ({ right: dialog.getBoundingClientRect().right,
      controlRight: Math.max(...[...dialog.querySelectorAll('input,select,textarea')].map(control => control.getBoundingClientRect().right)),
      width: dialog.clientWidth, content: dialog.scrollWidth }))
    expect(layout.controlRight).toBeLessThanOrEqual(layout.right - 12)
    expect(layout.content).toBeLessThanOrEqual(layout.width)
    await cinna.page.screenshot({ path: '/tmp/cinna-job-schedule-editor-800.png' })
    await expect(editor.getByLabel('Instructions for verify', { exact: true })).toHaveCount(0)
    await expect(editor.getByRole('textbox', { name: 'Job prompt', exact: true })).toHaveCount(0)
    await expect(editor).not.toContainText(stepPrompt)
    const save = editor.getByRole('button', { name: 'Create schedule', exact: true })
    await save.scrollIntoViewIfNeeded()
    await expect(save).toBeVisible()
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(await cinna.page.evaluate(() => window.api.tasks.list())).toEqual([])
  } finally { await fake.close() }
})
