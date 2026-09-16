import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { DESKTOP_STATE_FILE, MANIFEST_FILE } from '../../src/shared/kit/manifest'

async function openAgent(cinna: CinnaApp, name: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await cinna.page.getByRole('button', { name, exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
}

// No real Codex turn or credentials: verifies the production IPC and persistent UI state.
test('Codex runtime and approvals persist across an app restart', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Codex Example', 'Codex Example')
  const saved = await cinna.page.evaluate((input) => window.api.localAgents.updateField({
    agentId: input.agentId,
    update: { field: 'runtime', value: { engine: 'codex', credential: null, modelId: null, complexity: 'medium' } },
    expectedStamp: input.stamp
  }), { agentId: agent.id, stamp: agent.stamps[MANIFEST_FILE]! })
  expect(saved.ok).toBe(true)

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await openAgent(cinna, agent.name)
  const page = cinna.page
  await expect(page.getByLabel('Runs on')).toHaveValue('engine:codex')
  await page.getByLabel('Work complexity').selectOption('complex')
  await expect.poll(() => JSON.parse(readFileSync(join(agent.path, MANIFEST_FILE), 'utf8')).runtime)
    .toEqual({ engine: 'codex', complexity: 'complex' })
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Permissions/ }).click()
  await expect(page.getByLabel('Approvals')).toHaveValue('ask')
  await expect(page.getByText(/Both modes keep the workspace sandbox enabled/)).toBeVisible()
  await page.getByLabel('Approvals').selectOption('auto')
  await expect.poll(() => JSON.parse(readFileSync(join(agent.path, DESKTOP_STATE_FILE), 'utf8')).codexApproval).toBe('auto')
  await page.screenshot({ path: '/tmp/cinna-codex-ui.png' })

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await openAgent(cinna, agent.name)
  await cinna.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Permissions/ }).click()
  await expect(cinna.page.getByLabel('Approvals')).toHaveValue('auto')
  const state = JSON.parse(readFileSync(join(agent.path, DESKTOP_STATE_FILE), 'utf8'))
  expect(state.claudeApproval).not.toBe('auto')
})


test('Codex chats, approves, answers questions, stops, and resumes through the production launcher', async ({ cinna }) => {
  test.setTimeout(90_000)
  // Put a scripted CLI first in this disposable home's shell PATH. The app's
  // detector, login probe, Electron launcher, adapter, driver and UI are real.
  const bin = join(cinna.sandbox.home, 'bin')
  mkdirSync(bin)
  const executable = join(bin, 'codex')
  writeFileSync(executable, `#!${process.execPath}\n${readFileSync(resolve('src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs'), 'utf8')}`, { mode: 0o755 })
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  for (const profile of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
    const file = join(cinna.sandbox.home, profile)
    writeFileSync(file, readFileSync(file, 'utf8') + `\nexport PATH=${quote(bin)}:$PATH\nexport CODEX_HOME=${quote(cinna.sandbox.home)}\n`)
  }
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const tools = await cinna.page.evaluate(() => window.api.localTools.list())
  expect(tools.find((tool) => tool.id === 'codex')?.path).toBe(executable)
  expect(await cinna.page.evaluate(() => window.api.localTools.codexAuth())).toEqual({ state: 'logged_in' })
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Codex Runner', 'Codex Runner')
  const result = await cinna.page.evaluate((input) => window.api.localAgents.updateField({
    agentId: input.id, expectedStamp: input.stamp,
    update: { field: 'runtime', value: { engine: 'codex', credential: null, modelId: null, complexity: 'complex' } }
  }), { id: agent.id, stamp: agent.stamps[MANIFEST_FILE]! })
  expect(result.ok).toBe(true)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  // Assert the executable again immediately before any chat can run.
  expect((await cinna.page.evaluate(() => window.api.localTools.list())).find((tool) => tool.id === 'codex')?.path).toBe(executable)
  await openAgent(cinna, agent.name)
  await cinna.page.getByRole('button', { name: 'Start chat', exact: true }).click()
  const send = async (text: string) => {
    const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await input.fill(text)
    await input.press('Enter')
  }
  await send('Hello Codex')
  await expect(cinna.page.getByText('Hello from Codex.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await send('Ask for permission')
  await cinna.page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(cinna.page.getByText('Codex approval: accept.', { exact: true })).toBeVisible()
  await send('Ask a question')
  await cinna.page.getByRole('button', { name: 'Answer', exact: true }).click()
  await cinna.page.getByRole('button', { name: /^Staging/ }).click()
  await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(cinna.page.getByText('Codex answer: Staging.', { exact: true })).toBeVisible()
  await send('Wait until stopped')
  const requests = () => readFileSync(join(cinna.sandbox.home, 'codex-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  await expect.poll(() => requests().some((request) => request.method === 'turn/start' && JSON.stringify(request.params).includes('Wait until stopped'))).toBe(true)
  await cinna.page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect(requests().some((request) => request.method === 'turn/interrupt')).toBe(true)
  const state = JSON.parse(readFileSync(join(agent.path, DESKTOP_STATE_FILE), 'utf8'))
  expect(Object.values(state.sessions)).toContainEqual(expect.objectContaining({ sessionId: 'codex-session' }))
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByText('Hello Codex', { exact: true }).first().click()
  await send('Continue after restart')
  await expect.poll(() => requests().some((request) => request.method === 'thread/resume')).toBe(true)
  await expect(cinna.page.getByText('Hello from Codex.', { exact: true })).toHaveCount(2)
  const turns = requests().filter((request) => request.method === 'turn/start' && request.params.threadId === 'codex-session')
  expect(turns).toHaveLength(5)
  expect(turns.every((turn) => turn.params.effort === 'high' && turn.params.approvalsReviewer === 'user')).toBe(true)
})
