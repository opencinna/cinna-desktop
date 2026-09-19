import { renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { heldA2aAgent, type HeldA2aAgent } from '../fixtures/heldA2aAgent'

/**
 * A job folder's ⋯ menu (`JobFolderRow.tsx`): Run All Jobs above Edit and
 * Delete, and what Run All actually starts.
 *
 * ## What is real
 *
 * The runs are real renderer turns started by the menu item (`useExecuteJob`
 * with `navigate: false`, one job at a time), against a hand-added A2A agent on
 * a loopback port (`heldA2aAgent`) that holds every `message/send` until the
 * test answers — so "running" is main's own `inProgressRunsCount`, not a
 * seeded row. The blocked job is the `blocked-job.spec.ts` arrangement: its
 * folder agent moved out of the root while the app is closed. The job already
 * running is `jobs.execute` over IPC, which writes a `running` run and starts
 * no stream — a run the list counts and no turn will ever end.
 *
 * ## What it proves
 *
 * - The menu's items, in order, and that an empty folder's Run All is disabled
 *   with its reason as text inside the item (not a tooltip), and does nothing.
 * - Scrolling the sidebar list closes the menu.
 * - Run All starts every runnable job exactly once — each row spins, each job
 *   has one run, and the agent heard exactly those two prompts — and skips the
 *   job with incomplete setup and the job already running.
 *
 * ## What it does not
 *
 * Edit and Delete themselves, the "Already starting…" state while the loop
 * runs, the per-job re-check against a job the user started by hand mid-loop
 * (`JobFolderRow.runAll.test.tsx`), and a refusal from main part-way through.
 */

const EMPTY_FOLDER = 'Empty shelf'
const FOLDER = 'Morning batch'

function folderHeader(page: Page, name: string) {
  return page.getByText(name, { exact: true }).locator('xpath=..')
}

function jobRow(page: Page, title: string) {
  return page.getByText(title, { exact: true }).first().locator('xpath=..')
}

async function openFolderMenu(page: Page, name: string) {
  await folderHeader(page, name).hover()
  await page.getByRole('button', { name: 'Folder actions', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Folder actions', exact: true })
  await expect(menu).toBeVisible()
  return menu
}

test('the folder menu lists Run All Jobs, Edit, Delete; an empty folder says why it cannot run; a scroll closes it', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(
    async ({ folder, count }) => {
      await window.api.jobFolders.create({ name: folder })
      // Enough jobs at the root for the sidebar list to scroll.
      for (let i = 1; i <= count; i++) {
        await window.api.jobs.create({
          type: 'local',
          title: `Filler job ${String(i).padStart(2, '0')}`,
          prompt: 'Nothing.'
        })
      }
    },
    { folder: EMPTY_FOLDER, count: 40 }
  )
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await expect(folderHeader(cinna.page, EMPTY_FOLDER)).toBeVisible()

  await test.step('the items are Run All Jobs, then Edit, then Delete', async () => {
    const menu = await openFolderMenu(cinna.page, EMPTY_FOLDER)
    const items = menu.getByRole('menuitem')
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toHaveAccessibleName('Run All Jobs')
    await expect(items.nth(1)).toHaveAccessibleName('Edit')
    await expect(items.nth(2)).toHaveAccessibleName('Delete')
  })

  await test.step('in an empty folder Run All Jobs is disabled and says why inside the item', async () => {
    const menu = cinna.page.getByRole('menu', { name: 'Folder actions', exact: true })
    const runAll = menu.getByRole('menuitem', { name: 'Run All Jobs', exact: true })
    await expect(runAll).toHaveAttribute('aria-disabled', 'true')
    await expect(runAll).toHaveAccessibleDescription('This folder has no jobs')
    // Visible text in the item, not a title.
    await expect(runAll.getByText('This folder has no jobs', { exact: true })).toBeVisible()
    await expect(runAll).not.toHaveAttribute('title')
    // `force`: Playwright will not click an aria-disabled element on its own,
    // and the point is what a click on it does — nothing.
    await runAll.click({ force: true })
    // Nothing started, and the menu is still there to say why.
    await expect(menu).toBeVisible()
    expect(
      await cinna.page.evaluate(async () => {
        const jobs = await window.api.jobs.list()
        return jobs.reduce((n, j) => n + j.inProgressRunsCount, 0)
      })
    ).toBe(0)
  })

  await test.step('scrolling the sidebar list closes the menu', async () => {
    const menu = cinna.page.getByRole('menu', { name: 'Folder actions', exact: true })
    const scroller = folderHeader(cinna.page, EMPTY_FOLDER).locator(
      'xpath=ancestor::div[contains(@class, "overflow-y-auto")][1]'
    )
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await folderHeader(cinna.page, EMPTY_FOLDER).hover()
    await cinna.page.mouse.wheel(0, 300)
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await expect(menu).toHaveCount(0)
  })
})

interface Arranged {
  jobs: { alpha: string; beta: string; blocked: string; running: string }
}

const PROMPTS = {
  alpha: 'Alpha: summarise the overnight alerts.',
  beta: 'Beta: list the failed deploys.',
  blocked: 'Blocked: check the invoices.',
  running: 'Running: rotate the logs.'
}
const TITLES = {
  alpha: 'Alpha report',
  beta: 'Beta report',
  blocked: 'Blocked check',
  running: 'Already running'
}

async function arrange(cinna: CinnaApp, fake: HeldA2aAgent): Promise<Arranged> {
  await cinna.skipOnboarding()
  const agentId = await fake.register(cinna, 'Batch Agent')
  const root = await addAgentRoot(cinna)
  const folderAgent = await createFolderAgent(cinna, root, 'Invoice Checker')
  const jobs = await cinna.page.evaluate(
    async ({ agentId, folderAgentId, folder, titles, prompts }) => {
      const make = async (key: keyof typeof titles, agent: string): Promise<string> => {
        const job = await window.api.jobs.create({ type: 'local', title: titles[key], prompt: prompts[key] })
        await window.api.jobs.setAgents(job.id, [agent])
        return job.id
      }
      const ids = {
        alpha: await make('alpha', agentId),
        blocked: await make('blocked', folderAgentId),
        beta: await make('beta', agentId),
        running: await make('running', agentId)
      }
      const created = await window.api.jobFolders.create({ name: folder })
      await window.api.jobs.reorder(created.id, [ids.alpha, ids.blocked, ids.beta, ids.running])
      return ids
    },
    { agentId, folderAgentId: folderAgent.id, folder: FOLDER, titles: TITLES, prompts: PROMPTS }
  )
  // The folder agent leaves its root while the app is closed: its job is then
  // incomplete setup, exactly as in `blocked-job.spec.ts`.
  await cinna.electronApp.close()
  renameSync(folderAgent.path, join(cinna.sandbox.home, 'parked-agent'))
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  // A run in progress that nothing will end: the IPC creates the run and
  // starts no turn (see the header).
  await cinna.page.evaluate((id) => window.api.jobs.execute(id), jobs.running)
  return { jobs }
}

async function runCounts(cinna: CinnaApp, jobs: Arranged['jobs']): Promise<Record<string, number>> {
  return cinna.page.evaluate(async (ids) => {
    const out: Record<string, number> = {}
    for (const [key, id] of Object.entries(ids)) out[key] = (await window.api.jobs.listRuns(id)).length
    return out
  }, jobs)
}

test('Run All Jobs starts each runnable job once and skips the blocked one and the one already running', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const fake = await heldA2aAgent()
  try {
    const { jobs } = await arrange(cinna, fake)
    await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()

    await test.step('before: one job is blocked, one is already running, two are idle', async () => {
      const page = cinna.page
      const blockedJob = await page.evaluate(
        async (id) => (await window.api.jobs.list()).find((j) => j.id === id),
        jobs.blocked
      )
      expect(blockedJob?.incompleteSetup).toBe(true)
      await expect(jobRow(page, TITLES.blocked).getByLabel('Incomplete setup', { exact: true })).toBeVisible()
      await expect(jobRow(page, TITLES.running).getByLabel('Running', { exact: true })).toBeVisible()
      await expect(jobRow(page, TITLES.alpha).getByLabel('Running', { exact: true })).toHaveCount(0)
      await expect(jobRow(page, TITLES.beta).getByLabel('Running', { exact: true })).toHaveCount(0)
      expect(await runCounts(cinna, jobs)).toEqual({ alpha: 0, blocked: 0, beta: 0, running: 1 })
    })

    await test.step('Run All Jobs starts the two runnable jobs, and each row spins', async () => {
      const menu = await openFolderMenu(cinna.page, FOLDER)
      const runAll = menu.getByRole('menuitem', { name: 'Run All Jobs', exact: true })
      await expect(runAll).not.toHaveAttribute('aria-disabled')
      await runAll.click()
      await expect(menu).toHaveCount(0)

      await expect.poll(() => fake.calls.length, { timeout: 30_000 }).toBe(2)
      // Folder order, one at a time: Alpha, then Beta — never the blocked job,
      // never the one already running.
      expect(fake.calls[0].text).toContain(PROMPTS.alpha)
      expect(fake.calls[1].text).toContain(PROMPTS.beta)

      const page = cinna.page
      await expect(jobRow(page, TITLES.alpha).getByLabel('Running', { exact: true })).toBeVisible()
      await expect(jobRow(page, TITLES.beta).getByLabel('Running', { exact: true })).toBeVisible()
      await expect(jobRow(page, TITLES.running).getByLabel('Running', { exact: true })).toBeVisible()
      await expect(jobRow(page, TITLES.blocked).getByLabel('Running', { exact: true })).toHaveCount(0)
      await expect(jobRow(page, TITLES.blocked).getByLabel('Incomplete setup', { exact: true })).toBeVisible()
      // The user stayed on the list: no chat was opened.
      await expect(page.getByRole('combobox', { name: 'Send a follow-up · Esc Esc to stop', exact: true })).toHaveCount(0)
      expect(await runCounts(cinna, jobs)).toEqual({ alpha: 1, blocked: 0, beta: 1, running: 1 })
    })

    await test.step('when the agent answers, the two runs finish and nothing ran twice', async () => {
      fake.calls[0].release('Alpha done.')
      fake.calls[1].release('Beta done.')
      await expect
        .poll(() =>
          cinna.page.evaluate(async (ids) => {
            const [a] = await window.api.jobs.listRuns(ids.alpha)
            const [b] = await window.api.jobs.listRuns(ids.beta)
            return [a?.status, b?.status]
          }, jobs)
        )
        .toEqual(['succeeded', 'succeeded'])
      const page = cinna.page
      await expect(jobRow(page, TITLES.alpha).getByLabel('Running', { exact: true })).toHaveCount(0)
      await expect(jobRow(page, TITLES.beta).getByLabel('Running', { exact: true })).toHaveCount(0)
      expect(await runCounts(cinna, jobs)).toEqual({ alpha: 1, blocked: 0, beta: 1, running: 1 })
      expect(fake.calls).toHaveLength(2)
    })
  } finally {
    await fake.close()
  }
})
