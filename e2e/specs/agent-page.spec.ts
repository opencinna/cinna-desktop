import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

const COPY_NAME = 'Receipt Sorter'
const COPY_ITEM = 'Copy prompt for another tool'

/**
 * "Copy prompt for another tool": the one item in the Open-in menu that does
 * not close it, because writing a clipboard changes nothing else on screen and
 * the label is the whole confirmation.
 *
 * The item's accessible name is deliberately three names in sequence —
 * "Copy prompt for another tool" → "Copying…" → "Copied" → back after 1500ms —
 * so every locator below names the state it is waiting for, and each is scoped
 * *inside* the portaled menu: a `menuitem` found within `menu` is proof the
 * menu is still open, in one assertion rather than two racing ones.
 *
 * "Copying…" is not asserted: it lasts one IPC round trip, which can be shorter
 * than a poll interval, and a flake here would say nothing about the feature.
 *
 * The copied text is checked twice over: the OS clipboard read back from the
 * main process (proof the click really wrote it) and `localAgents.initPrompt`
 * (proof of what main builds). The click writes to the machine's real
 * clipboard — the product does that, not the test.
 */
test('Copy prompt for another tool confirms inside the menu and copies a briefing naming the folder', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const page = cinna.page

  await test.step('an agent created from the name field', async () => {
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'New agent' }).click()
    const form = page.getByRole('dialog', { name: 'New agent' })
    await expect(form).toBeVisible()
    await form.getByLabel('Name').fill(COPY_NAME)
    await form.getByLabel('Name').press('Enter')
    const buildWith = page.getByRole('dialog', { name: 'Build it with' })
    await expect(buildWith).toBeVisible()
    await buildWith.getByRole('button', { name: 'Not now' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(COPY_NAME)
  })

  const listed = await page.evaluate(() => window.api.localAgents.list())
  const agent = listed.agents.find((a) => a.name === COPY_NAME)
  expect(agent, 'the index has the new agent').toBeTruthy()
  const folder = agent!.path
  // The briefing names this file, so the file has to be the one the scaffold
  // really wrote — a confident pointer at an absent document is the failure
  // `initPrompt` exists to avoid.
  expect(existsSync(join(folder, 'AGENTS.md')), `${folder}/AGENTS.md exists`).toBe(true)

  const menu = page.getByRole('menu', { name: 'Open this folder in' })
  await page.getByRole('button', { name: 'Open in…' }).click()
  await expect(menu.getByRole('menuitem', { name: COPY_ITEM })).toBeVisible()

  await test.step('the click confirms in place, without closing the menu', async () => {
    await menu.getByRole('menuitem', { name: COPY_ITEM }).click()
    // Scoped to `menu`: this passes only while the menu is still on screen.
    await expect(menu.getByRole('menuitem', { name: 'Copied' })).toBeVisible()
    // Nothing failed: the failure path renders its reason inside the menu.
    await expect(menu.getByRole('alert')).toHaveCount(0)
  })

  await test.step('the copied text names the folder and the entry document', async () => {
    const expected = [
      `Your working directory is \`${folder}\``,
      '',
      `That folder is "${COPY_NAME}", a Cinna local agent: its manifest, prompts, scripts and knowledge all live inside it.`,
      '',
      "Read `AGENTS.md` in that folder first — it explains the folder's structure and how to work on this agent, and points at every other file you need.",
      '',
      'You are working *on* this agent, not running it. Keep every change inside that folder, and follow what you read there.'
    ].join('\n')

    const clipboard = await cinna.electronApp.evaluate(({ clipboard }) => clipboard.readText())
    expect(clipboard).toBe(expected)

    const built = await page.evaluate(
      (id) => window.api.localAgents.initPrompt(id),
      agent!.id
    )
    expect(built).toBe(expected)
  })

  await test.step('the confirmation reverts and the menu is still open', async () => {
    await expect(menu.getByRole('menuitem', { name: COPY_ITEM })).toBeVisible()
  })
})
