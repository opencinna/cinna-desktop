import { existsSync } from 'node:fs'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot } from '../fixtures/seed'

/**
 * The agent page and the two-step creation flow: a name alone makes a folder,
 * the second step offers the user's tools, and the ⋯ menu takes the folder
 * back out again through the Trash.
 *
 * Main really calls `shell.trashItem` on delete. Left alone, that would put a
 * sandbox folder into the developer's real Trash on every run, so the test
 * replaces it with an `rm -rf` in the main process — the same seam the
 * fixture uses for the OS directory picker. Everything either side of that
 * call (the lock, the rescan, the pruned row, the renderer's reaction) is the
 * real path.
 *
 * `process.getBuiltinModule`, not `require`: the main bundle is ESM, so inside
 * an evaluated function `require` is undefined and `import()` is refused
 * ("A dynamic import callback was not specified"). Either mistake is caught
 * by the service and comes back as `write_failed` — the dialog just stays
 * open, and nothing says why.
 */
async function stubTrash(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ shell }) => {
    shell.trashItem = (async (path: string) => {
      const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
      fs.rmSync(path, { recursive: true, force: true })
    }) as typeof shell.trashItem
  })
}

const NAME = 'Invoice Watcher'

test('a name alone creates an agent, and Delete agent moves its folder to the Trash', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  await stubTrash(cinna)
  const { page } = cinna

  await test.step('create from the name field with Enter', async () => {
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'New agent' }).click()
    const form = page.getByRole('dialog', { name: 'New agent' })
    await expect(form).toBeVisible()
    await form.getByLabel('Name').fill(NAME)
    await form.getByLabel('Name').press('Enter')

    const buildWith = page.getByRole('dialog', { name: 'Build it with' })
    await expect(buildWith).toBeVisible()
    await expect(buildWith).toContainText(`Build ${NAME} with…`)
    await expect(buildWith.getByRole('button', { name: 'Terminal' })).toBeVisible()
    await expect(buildWith.getByRole('button', { name: 'Reveal folder' })).toBeVisible()
    await buildWith.getByRole('button', { name: 'Not now' }).click()
    await expect(buildWith).toBeHidden()
  })

  let folder = ''
  await test.step('the new agent’s page and sidebar row', async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(NAME)
    await expect(
      page.getByRole('button', { name: 'No description yet — add one under Overview.' })
    ).toBeVisible()
    const tabs = page.getByRole('tablist', { name: 'Agent details' })
    // Two tabs wear count badges: the scaffold ships one command, and a fresh
    // folder has two validation warnings (no example prompts, no router
    // trigger) that the Folder tab counts now that a ready folder shows no banner.
    await expect(tabs.getByRole('tab')).toHaveText(['Overview', 'Prompts', 'Commands1', 'Folder2'])
    await expect(page.getByRole('button', { name: 'Open in…' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start chat' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'More actions' })).toBeVisible()

    // The row is the name and nothing else: the manifest description equals
    // the name, and the sidebar does not repeat it as a sub-line.
    const row = page.getByRole('button', { name: NAME, exact: true })
    await expect(row).toHaveText(NAME)

    const listed = await page.evaluate(() => window.api.localAgents.list())
    const agent = listed.agents.find((a) => a.name === NAME)
    expect(agent, 'the index has the new agent').toBeTruthy()
    expect(agent!.description).toBe(NAME)
    expect(agent!.readiness).toBe('ok')
    // The form scaffolds into the default agents home, which on a fresh
    // profile is `~/Documents/CinnaAgents` under the sandbox `$HOME`.
    expect(agent!.path.startsWith(cinna.sandbox.home), `${agent!.path} is inside the sandbox`).toBe(true)
    folder = agent!.path
    expect(existsSync(folder)).toBe(true)
  })

  await test.step('More actions → Delete agent… → Move to Trash', async () => {
    await page.getByRole('button', { name: 'More actions' }).click()
    await page
      .getByRole('menu', { name: 'Agent actions' })
      .getByRole('menuitem', { name: 'Delete agent…' })
      .click()
    const confirm = page.getByRole('dialog', { name: 'Delete agent' })
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText(`Move ${NAME} to the Trash?`)
    await confirm.getByRole('button', { name: 'Move to Trash' }).click()

    await expect(confirm).toBeHidden()
    await expect(page.getByRole('button', { name: NAME, exact: true })).toBeHidden()
    await expect(
      page.getByText('Select an agent from the sidebar, or create one with +.')
    ).toBeVisible()
    await expect.poll(() => existsSync(folder), 'the folder is gone from disk').toBe(false)
  })
})

test('create over IPC with no description fills it with the name and the folder is ready', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await cinna.page.evaluate(
    (input) => window.api.localAgents.create(input),
    { name: NAME, rootId: root.id }
  )
  expect(agent.name).toBe(NAME)
  expect(agent.description).toBe(NAME)
  expect(agent.slug).toBe('invoice-watcher')
  expect(agent.readiness).toBe('ok')
  expect(agent.readinessReason).toBeNull()
  expect(existsSync(agent.path)).toBe(true)
})
