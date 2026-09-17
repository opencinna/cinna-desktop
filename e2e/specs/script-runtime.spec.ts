import { realpathSync } from 'node:fs'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'
import type { TaskScript } from '../../src/shared/taskScript'

/**
 * Real folder scaffolds, configured engine launcher, ACP processes, Jobs Run,
 * persistence and Inbox. The fake controls only agent replies over loopback.
 * Two requests must arrive before either reply is released: parallel work is
 * observed directly, not inferred from elapsed time. Restart uses the same
 * fixture HOME/userData. Explicit recovery sends a new reconciliation prompt;
 * this proves completed work is not replayed, not that a real model obeys it.
 */
const TITLE = 'Script quarterly report'
const GOAL = 'Prepare the verified quarterly report.'
const ANALYST = 'Script Revenue Analyst'
const REVIEWER = 'Script Risk Reviewer'
const ANALYSIS = 'Analysis juniper-6382 {{goal}}'
const REVIEW = 'Review cedar-4197'
const ANSWER = 'Publish to leadership'
const FINAL = 'Approved report quartz-5723'
const QUESTION = `Approve ${ANALYSIS} and ${REVIEW}?`

async function arrange(cinna: CinnaApp, fake: ScriptAcpEngine, gate: boolean) {
  await cinna.skipOnboarding()
  await fake.install(cinna)
  await cinna.page.evaluate(async ({ host, model }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Script fixture', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
  }, { host: fake.host, model: SCRIPT_MODEL })
  const root = await addAgentRoot(cinna)
  const analyst = await createFolderAgent(cinna, root, ANALYST, ANALYST)
  const reviewer = await createFolderAgent(cinna, root, REVIEWER, REVIEWER)
  const script: TaskScript = {
    version: 1,
    agents: {
      analyst: { kind: 'agent', source: 'folder', manifestId: analyst.manifestId, name: ANALYST },
      reviewer: { kind: 'agent', source: 'folder', manifestId: reviewer.manifestId, name: REVIEWER }
    },
    steps: [
      { id: 'analyse', agent: 'analyst', prompt: 'ANALYSE {{goal}}' },
      { id: 'review', agent: 'reviewer', prompt: 'REVIEW {{goal}}' },
      ...(gate ? [
        { id: 'gate', after: ['analyse', 'review'], ask_user: 'Approve {{analyse.text}} and {{review.text}}?' },
        { id: 'finish', after: ['gate'], agent: 'analyst', prompt: 'FINISH {{goal}} / {{analyse.text}} / {{review.text}} / {{gate.text}}' }
      ] : [])
    ]
  }
  const jobId = await cinna.page.evaluate(async ({ script, title, goal }) => {
    const job = await window.api.jobs.create({ type: 'local', title, prompt: goal, router: 'script', script,
      budget: { maxRounds: 8, maxMinutes: 2 } })
    return job.id
  }, { script, title: TITLE, goal: GOAL })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await cinna.page.getByText(TITLE, { exact: true }).click()
  return { jobId, analyst, reviewer, script }
}
async function children(cinna: CinnaApp, taskId: string) {
  return cinna.page.evaluate((parentTaskId) => window.api.tasks.list({ parentTaskId }), taskId)
}
async function start(cinna: CinnaApp, fake: ScriptAcpEngine, jobId: string) {
  await cinna.page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect.poll(() => fake.calls.length).toBe(2)
  expect(fake.calls.every((call) => !call.closed && !call.released)).toBe(true)
  expect(fake.calls.map((call) => call.text).sort()).toEqual([`ANALYSE ${GOAL}`, `REVIEW ${GOAL}`].sort())
  // Both actual session/prompt requests arrived before either response was released.
  expect(new Set(fake.calls.map((call) => call.sessionId)).size).toBe(2)
  const runs = await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId)
  expect(runs).toHaveLength(1)
  const run = runs[0]
  expect(run).toMatchObject({ status: 'running', taskId: expect.any(String), localChatId: expect.any(String) })
  const taskId = run.taskId!
  await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), taskId))
    .toMatchObject({ router: 'script', status: 'in_progress', runtime: { ownerTurns: 2 } })
  await openInbox(cinna)
  return { taskId, chatId: run.localChatId!, runId: run.id }
}
async function openInbox(cinna: CinnaApp) {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveCount(0)
}
async function openTask(cinna: CinnaApp) {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await cinna.page.getByRole('region', { name: 'Recent tasks', exact: true }).getByRole('button', { name: TITLE }).click()
}
async function verifyCompleted(cinna: CinnaApp, fake: ScriptAcpEngine, jobId: string, taskId: string, chatId: string, summary: string, turns: number) {
  await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), taskId))
    .toMatchObject({ status: 'completed', runtime: { state: 'completed', ownerTurns: turns } })
  await expect.poll(() => cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId))
    .toEqual([expect.objectContaining({ taskId, localChatId: chatId, status: 'succeeded' })])
  expect(await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)).toEqual([])
  await openTask(cinna)
  await cinna.page.getByRole('button', { name: 'Open the chat', exact: true }).click()
  await expect(cinna.page.getByText(summary, { exact: true })).toHaveCount(1)
  const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
  expect(chat?.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([GOAL])
  expect(chat?.messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([summary])
  expect(chat?.messages.filter((message) => message.role === 'error')).toEqual([])
  expect(fake.unexpected).toEqual([]) // Catalogue reads allowed; model inference is not.
  await cinna.page.getByRole('button', { name: `From job ${TITLE}`, exact: true }).click()
  await expect(cinna.page.getByText('Succeeded', { exact: true })).toBeVisible()
  await expect(cinna.page.getByLabel('Running', { exact: true })).toHaveCount(0)
}

test('a Jobs script runs parallel folder agents, survives its Inbox gate and finishes with chat closed', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await scriptAcpEngine()
  try {
    const { jobId, analyst, reviewer } = await arrange(cinna, fake, true)
    const { taskId, chatId, runId } = await start(cinna, fake, jobId)
    const firstChildren = await children(cinna, taskId)
    expect(firstChildren.map((child) => child.title).sort()).toEqual(['analyse', 'finish', 'gate', 'review'])
    expect(new Set(firstChildren.map((child) => child.chatId)).size).toBe(4)
    expect(firstChildren.every((child) => child.chatId !== chatId && child.parentTaskId === taskId)).toBe(true)
    const analyse = firstChildren.find((child) => child.title === 'analyse')!
    const review = firstChildren.find((child) => child.title === 'review')!
    const gate = firstChildren.find((child) => child.title === 'gate')!
    const finish = firstChildren.find((child) => child.title === 'finish')!
    expect(analyse.assignee).toMatchObject({ kind: 'agent', agentId: analyst.id })
    expect(review.assignee).toMatchObject({ kind: 'agent', agentId: reviewer.id })
    const analyseCall = fake.calls.find((call) => call.text.startsWith('ANALYSE'))!
    const reviewCall = fake.calls.find((call) => call.text.startsWith('REVIEW'))!
    expect(realpathSync(analyseCall.cwd)).toBe(realpathSync(analyst.path))
    expect(realpathSync(reviewCall.cwd)).toBe(realpathSync(reviewer.path))
    analyseCall.release(ANALYSIS)
    await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), analyse.id)).toMatchObject({ status: 'completed' })
    expect(await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)).toEqual([])
    expect(fake.calls).toHaveLength(2)
    expect(reviewCall.closed).toBe(false)
    expect(await cinna.page.evaluate((id) => window.api.tasks.get(id), taskId)).toMatchObject({ status: 'in_progress' })
    reviewCall.release(REVIEW)
    await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), taskId))
      .toMatchObject({ status: 'blocked', runtime: { state: 'waiting' } })
    const entries = await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)
    expect(entries).toEqual([expect.objectContaining({ taskId: gate.id, chatId: gate.chatId, agentId: null, deliveryOwner: 'runner' })])
    const requestId = entries[0].requestId
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openInbox(cinna)
    await expect.poll(() => cinna.page.evaluate(async () => (await window.api.inbox.list()).entries))
      .toEqual([expect.objectContaining({ requestId, taskId: gate.id, chatId: gate.chatId })])
    expect((await children(cinna, taskId)).map((child) => child.id).sort()).toEqual(firstChildren.map((child) => child.id).sort())
    expect(fake.calls).toHaveLength(2)
    const row = cinna.page.getByRole('article').filter({ hasText: QUESTION })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Answer', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Other (enter custom answer)', exact: true }).click()
    await cinna.page.getByPlaceholder('Type your answer…').fill(ANSWER)
    await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
    await expect.poll(() => fake.calls.length).toBe(3)
    expect(fake.calls[2].text).toBe(`FINISH ${GOAL} / ${ANALYSIS} / ${REVIEW} / ${ANSWER}`)
    expect(realpathSync(fake.calls[2].cwd)).toBe(realpathSync(analyst.path))
    expect(await cinna.page.evaluate((id) => window.api.tasks.get(id), taskId)).toMatchObject({ status: 'in_progress' })
    fake.calls[2].release(FINAL)
    const summary = `Script completed.\n\nanalyse:\n${ANALYSIS}\n\nreview:\n${REVIEW}\n\ngate:\n${ANSWER}\n\nfinish:\n${FINAL}`
    await verifyCompleted(cinna, fake, jobId, taskId, chatId, summary, 3)
    expect(fake.calls).toHaveLength(3)
    expect(await cinna.page.evaluate((id) => window.api.jobs.listRuns(id), jobId)).toEqual([expect.objectContaining({ id: runId })])
    for (const [child, expected] of [[analyse, ANALYSIS], [review, REVIEW], [finish, FINAL]] as const) {
      const transcript = await cinna.page.evaluate((id) => window.api.chat.get(id), child.chatId!)
      expect(transcript?.messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([expected])
    }
    const gateChat = await cinna.page.evaluate((id) => window.api.chat.get(id), gate.chatId!)
    expect(gateChat?.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([ANSWER])
    await openTask(cinna)
    await cinna.page.getByRole('region', { name: 'Subtasks', exact: true }).getByRole('button', { name: /^analyse — / }).click()
    await expect(cinna.page.getByRole('button', { name: 'Parent task', exact: true })).toBeVisible()
    await cinna.page.getByRole('button', { name: 'Open the chat', exact: true }).click()
    await expect(cinna.page.getByText(ANALYSIS, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByText(REVIEW, { exact: true })).toHaveCount(0)
  } finally { await fake.close() }
})

test('an interrupted parallel script resumes only its unfinished step after explicit user recovery', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await scriptAcpEngine()
  try {
    const { jobId } = await arrange(cinna, fake, false)
    const { taskId, chatId } = await start(cinna, fake, jobId)
    const before = await children(cinna, taskId)
    const analyse = before.find((child) => child.title === 'analyse')!
    const review = before.find((child) => child.title === 'review')!
    fake.calls.find((call) => call.text.startsWith('ANALYSE'))!.release(ANALYSIS)
    await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), analyse.id)).toMatchObject({ status: 'completed' })
    const held = fake.calls.find((call) => call.text.startsWith('REVIEW'))!
    expect(held.closed).toBe(false)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openTask(cinna)
    await expect(cinna.page.getByText('Execution interrupted', { exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'Resume task', exact: true })).toBeEnabled()
    expect(fake.calls).toHaveLength(2)
    expect((await children(cinna, taskId)).map((child) => child.id).sort()).toEqual(before.map((child) => child.id).sort())
    expect(await cinna.page.evaluate((id) => window.api.tasks.get(id), analyse.id)).toMatchObject({ status: 'completed' })
    await cinna.page.getByRole('button', { name: 'Resume task', exact: true }).click()
    await openInbox(cinna)
    await expect.poll(() => fake.calls.length).toBe(3)
    const recovery = fake.calls[2]
    expect(recovery.text).toContain('The previous execution of script step review was interrupted.')
    expect(recovery.text).toContain('Do not repeat completed side effects.')
    expect(recovery.text).toContain(`Step intent:\nREVIEW ${GOAL}`)
    expect(recovery.text).not.toBe(held.text)
    expect(recovery.cwd).toBe(held.cwd)
    expect(fake.calls.filter((call) => call.text === `ANALYSE ${GOAL}`)).toHaveLength(1)
    recovery.release(REVIEW)
    const summary = `Script completed.\n\nanalyse:\n${ANALYSIS}\n\nreview:\n${REVIEW}`
    await verifyCompleted(cinna, fake, jobId, taskId, chatId, summary, 3)
    expect(fake.calls).toHaveLength(3)
    const reviewChat = await cinna.page.evaluate((id) => window.api.chat.get(id), review.chatId!)
    expect(reviewChat?.messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([REVIEW])
  } finally { await fake.close() }
})
