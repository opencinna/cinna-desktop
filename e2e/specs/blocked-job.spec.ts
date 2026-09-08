import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Section C of `plans/manual-test-session2.md`: a job whose folder agent is
 * not on this device must be visibly blocked, and must not run.
 *
 * Before this work such a job ran as a plain-LLM chat and recorded a success
 * with the agent silently absent. Nothing below needs a model: the gate fires
 * before any run row is written, so the refusal itself is the observable.
 */

const AGENT_NAME = 'Invoice Checker'
const JOB_TITLE = 'Nightly check'

interface Seeded {
  agentId: string
  agentPath: string
  jobId: string
}

async function seedJobWithFolderAgent(cinna: CinnaApp): Promise<Seeded> {
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT_NAME)
  const jobId = await cinna.page.evaluate(async (agentId) => {
    const job = await window.api.jobs.create({
      type: 'local',
      title: 'Nightly check',
      prompt: 'Check the invoices.'
    })
    await window.api.jobs.setAgents(job.id, [agentId])
    return job.id
  }, agent.id)
  return { agentId: agent.id, agentPath: agent.path, jobId }
}

/** The index is rebuilt from disk by a scan, not by startup; ask for one. */
async function rescanAndOpenJobs(cinna: CinnaApp): Promise<void> {
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
}

function jobRow(page: Page) {
  return page.locator('div').filter({ has: page.getByText(JOB_TITLE, { exact: true }) }).last()
}

const blockedMarker = (page: Page) => page.getByLabel('Incomplete setup', { exact: true })
const needsSetupMarker = (page: Page) => page.getByLabel('Needs setup', { exact: true })
const runRowButton = (page: Page) => page.getByRole('button', { name: 'Run this job' })

test('C1–C6 a job whose agent folder went missing is blocked until it comes back', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const seeded = await seedJobWithFolderAgent(cinna)
  // `cinna.page` is read at each use and never held in a local: after a
  // relaunch it is a different window.

  await test.step('control: with the folder present the row carries no marker', async () => {
    await rescanAndOpenJobs(cinna)
    await expect(jobRow(cinna.page)).toBeVisible()
    await expect(blockedMarker(cinna.page)).toHaveCount(0)
    await jobRow(cinna.page).hover()
    await expect(runRowButton(cinna.page)).toBeVisible()
  })

  // Out of the root, not renamed in place: a folder agent is identified by the
  // manifest inside it, so a rename under `Local/` re-indexes the same agent
  // at its new path and nothing goes missing.
  const parked = join(cinna.sandbox.home, 'parked-agent')

  await test.step('C1 quit, move the agent folder away, restart: the row shows the red marker', async () => {
    await cinna.electronApp.close()
    renameSync(seeded.agentPath, parked)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await rescanAndOpenJobs(cinna)
    await expect(blockedMarker(cinna.page)).toBeVisible()
    await expect(blockedMarker(cinna.page)).toHaveAttribute(
      'title',
      "Incomplete setup — this job can't run on this device"
    )
  })

  await test.step('C2 the marker stays on hover and no run button appears', async () => {
    await jobRow(cinna.page).hover()
    await expect(blockedMarker(cinna.page)).toBeVisible()
    await expect(runRowButton(cinna.page)).toHaveCount(0)
  })

  await test.step('C4 the detail screen', async () => {
    await cinna.page.getByText(JOB_TITLE, { exact: true }).click()
    const panel = cinna.page.getByRole('alert').filter({ hasText: 'Incomplete setup' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(
      "This job needs an agent that isn't available on this device, so it can't run here."
    )
    await expect(panel).not.toContainText(/copy|move|re-create|recreate/i)

    const run = cinna.page.getByRole('button', { name: 'Run', exact: true })
    await expect(run).toBeDisabled()
    await expect(
      cinna.page.locator("span[title=\"This job can't run on this device — incomplete setup\"]")
    ).toBeVisible()

    await expect(cinna.page.getByRole('status')).toHaveCount(0)
    await expect(cinna.page.getByText('Agent unavailable', { exact: true })).toBeVisible()
    await expect(cinna.page.getByText('Finish setup on this device')).toHaveCount(0)
    await expect(cinna.page.getByText('Not available on this device')).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'Set up' })).toHaveCount(0)
  })

  await test.step('C5 blocked really means blocked', async () => {
    const message = await cinna.page.evaluate((jobId) =>
      window.api.jobs.execute(jobId).then(
        () => 'resolved',
        (err: Error) => err.message
      ), seeded.jobId)
    expect(message).toBe(
      "Error invoking remote method 'job:execute': JobError: This job can't run on this device. " +
        `It needs an agent that isn't available here: ${AGENT_NAME}.`
    )
    const runs = await cinna.page.evaluate((jobId) => window.api.jobs.listRuns(jobId), seeded.jobId)
    expect(runs).toEqual([])
    await expect(cinna.page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  })

  await test.step('C6 it clears when the folder comes back', async () => {
    await cinna.electronApp.close()
    renameSync(parked, seeded.agentPath)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await rescanAndOpenJobs(cinna)
    await expect(jobRow(cinna.page)).toBeVisible()
    await expect(blockedMarker(cinna.page)).toHaveCount(0)
    await jobRow(cinna.page).hover()
    await expect(runRowButton(cinna.page)).toBeVisible()
    await cinna.page.getByText(JOB_TITLE, { exact: true }).click()
    await expect(cinna.page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled()
    await expect(cinna.page.getByText('Agent unavailable', { exact: true })).toHaveCount(0)
  })
})

test('C3/C8 a switched-off folder agent is amber, hides on hover, and routes to Local Agents', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const seeded = await seedJobWithFolderAgent(cinna)
  const result = await cinna.page.evaluate((agentId) => window.api.agents.setEnabled(agentId, false), seeded.agentId)
  expect(result.success).toBe(true)
  await rescanAndOpenJobs(cinna)

  await expect(needsSetupMarker(cinna.page)).toBeVisible()
  await expect(blockedMarker(cinna.page)).toHaveCount(0)
  await jobRow(cinna.page).hover()
  await expect(needsSetupMarker(cinna.page)).toBeHidden()
  await expect(runRowButton(cinna.page)).toBeVisible()

  await cinna.page.getByText(JOB_TITLE, { exact: true }).click()
  await expect(cinna.page.getByText('Finish setup on this device')).toBeVisible()
  await cinna.page.getByRole('button', { name: 'Set up' }).click()
  await expect(cinna.page.getByRole('heading', { name: 'Local Agents', exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('heading', { name: 'Agent Folders' })).toBeVisible()
})

test('C7 a missing folder agent and a disabled MCP are reported together', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const seeded = await seedJobWithFolderAgent(cinna)
  await cinna.page.evaluate(async (jobId) => {
    // `enabled: false` matters: an enabled row would spawn the command and
    // the IPC would wait on that connection attempt.
    const { id } = await window.api.mcp.upsert({
      name: 'Bogus Tools',
      transportType: 'stdio',
      command: '/nonexistent/bin/nope',
      args: [],
      enabled: false
    })
    await window.api.jobs.setMcpProviders(jobId, [id])
  }, seeded.jobId)

  await cinna.electronApp.close()
  renameSync(seeded.agentPath, join(cinna.sandbox.home, 'parked-agent'))
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await rescanAndOpenJobs(cinna)
  await cinna.page.getByText(JOB_TITLE, { exact: true }).click()

  await expect(cinna.page.getByText('Dependencies need attention')).toBeVisible()
  await expect(
    cinna.page.getByText(
      "Some of these can be set up on this device. Others didn't resolve here at all — each row says which."
    )
  ).toBeVisible()
  await expect(cinna.page.getByText('Finish setup on this device')).toHaveCount(0)
  await expect(cinna.page.getByText('Not available on this device')).toHaveCount(0)
  await expect(cinna.page.getByRole('button', { name: 'Set up' })).toHaveCount(1)
  await expect(cinna.page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
})
