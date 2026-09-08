import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'

/**
 * Adopting a folder that already holds an `AGENT.md` — a **bare** agent.
 *
 * The promise this spec exists to keep is the negative one: the folder is the
 * user's own, very often a repository they share with other people, and the
 * desktop reads it and writes nothing into it. Every adopt test snapshots the
 * folder tree before the flow and compares it after, because every UI
 * assertion here would pass just as well against an implementation that
 * scaffolded a kit into the folder on its way past.
 *
 * The picker is the real one, stubbed at the main-process seam
 * (`cinna.stubDirectoryPicker`), so `local-agent:folder-pick` takes the path
 * from `dialog.showOpenDialog` exactly as it does for a user.
 */

/** Everything under `dir`, relative and sorted — the "nothing was written" witness. */
function treeOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort()
}

/** A folder that is one bare agent: `AGENT.md` with `heading`, and a `README.md`. */
function writeBareAgent(dir: string, heading: string, withReadme = true): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENT.md'), `# ${heading}\n\nYou answer questions about ${heading}.\n`)
  if (withReadme) writeFileSync(join(dir, 'README.md'), `# ${heading}\n\nRun it with \`uv run\`.\n`)
  return dir
}

/**
 * Adopt `dir` the way the dialog does, but over IPC: the same
 * `folder-pick` → `folder-add` pair, with the OS picker stubbed at `dir`.
 * Used by the tests that are *about* what an adopted agent looks like, so the
 * adopt flow itself is exercised once, in the tests that are about it.
 */
async function adoptFolder(
  cinna: CinnaApp,
  dir: string,
  options: { name?: string } = {}
): Promise<void> {
  await cinna.stubDirectoryPicker(dir)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled) throw new Error('the stubbed directory picker reported cancelled')
  if (pick.refusal !== null) throw new Error(`the folder was refused: ${pick.refusal}`)
  const added = await cinna.page.evaluate(
    (input) => window.api.localAgents.folderAdd(input),
    {
      path: pick.path,
      relPaths: pick.found.map((entry) => entry.relPath),
      ...(options.name === undefined ? {} : { name: options.name })
    }
  )
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
}

/**
 * `shell.trashItem` is real in main, so the safety net is the same one
 * `agent-page.spec.ts` uses — otherwise a regression in which radio is the
 * default would put a sandbox folder in the developer's Trash instead of
 * failing the test. `process.getBuiltinModule`, not `require`: the main bundle
 * is ESM.
 */
async function stubTrash(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ shell }) => {
    shell.trashItem = (async (path: string) => {
      const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
      fs.rmSync(path, { recursive: true, force: true })
    }) as typeof shell.trashItem
  })
}

/** Agents tab → the + button, which now offers a choice rather than a form. */
async function openAddDialog(cinna: CinnaApp): Promise<void> {
  const { page } = cinna
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Add an agent', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Add an agent' })).toBeVisible()
}

const FOUND = [
  ['accounting_meta_agent', 'Accounting Meta Agent'],
  ['exchange_rates_agent', 'Exchange Rates Agent'],
  ['sales_leaderboard_agent', 'Sales Leaderboard Agent']
] as const

test('a folder of three agents is adopted, and nothing is written into it', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const repo = homeDir(cinna, 'support-agents')
  for (const [slug, heading] of FOUND) writeBareAgent(join(repo, 'local_agents', slug), heading)
  const before = treeOf(repo)

  await test.step('the + offers a choice, and one of the two is a folder', async () => {
    await openAddDialog(cinna)
    const choice = cinna.page.getByRole('dialog', { name: 'Add an agent' })
    await expect(choice.getByRole('button', { name: /^New agent/ })).toBeVisible()
    await expect(choice.getByRole('button', { name: /^Add a folder/ })).toBeVisible()
  })

  await test.step('the picked folder is previewed as a list of what it holds', async () => {
    await cinna.stubDirectoryPicker(repo)
    await cinna.page
      .getByRole('dialog', { name: 'Add an agent' })
      .getByRole('button', { name: /^Add a folder/ })
      .click()

    // Same words, different roles: the card above and this dialog are both
    // "Add a folder", so the role is what tells them apart.
    const found = cinna.page.getByRole('dialog', { name: 'Add a folder' })
    await expect(found).toBeVisible()
    await expect(found.getByText('3 agents in support-agents')).toBeVisible()
    // The rows are the `AGENT.md` H1 headings, over the root-relative path.
    await expect(found.getByRole('checkbox')).toHaveCount(3)
    for (const [slug, heading] of FOUND) {
      await expect(
        found.getByRole('checkbox', { name: `${heading} local_agents/${slug}` })
      ).toBeChecked()
    }
    await found.getByRole('button', { name: 'Add 3 agents', exact: true }).click()
    await expect(cinna.page.getByRole('dialog')).toHaveCount(0)
  })

  await test.step('the three appear in the sidebar, grouped under the folder', async () => {
    const { page } = cinna
    // The group heading carries the root path as its title, so this asserts
    // the group is *this* folder and not a coincidence of names.
    await expect(page.getByTitle(repo)).toHaveText('support-agents')
    for (const [, heading] of FOUND) {
      // `toHaveText`, not `toBeVisible`: a sidebar row's accessible name would
      // also carry a sub-line, and a bare agent has none to carry.
      await expect(page.getByRole('button', { name: heading, exact: true })).toHaveText(heading)
    }
  })

  await test.step('the folder on disk is byte-for-byte the one that was picked', async () => {
    expect(treeOf(repo)).toEqual(before)
    for (const [slug] of FOUND) {
      const agentDir = join(repo, 'local_agents', slug)
      expect(existsSync(join(agentDir, '.cinna-kit'))).toBe(false)
      expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(false)
      expect(existsSync(join(agentDir, 'app-data'))).toBe(false)
      expect(existsSync(join(agentDir, 'cinna-agent.json'))).toBe(false)
    }
    expect(existsSync(join(repo, '.cinna-kit'))).toBe(false)
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(false)
  })
})

test('a folder that is itself one agent is named by the user, not by its heading', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const folder = writeBareAgent(homeDir(cinna, 'nightly-reporter'), 'Nightly Reporter')
  const before = treeOf(folder)

  await openAddDialog(cinna)
  await cinna.stubDirectoryPicker(folder)
  await cinna.page
    .getByRole('dialog', { name: 'Add an agent' })
    .getByRole('button', { name: /^Add a folder/ })
    .click()

  const found = cinna.page.getByRole('dialog', { name: 'Add a folder' })
  await expect(found).toBeVisible()
  // One folder, one field: a name prefilled from the `AGENT.md` heading, and
  // no checkbox list to choose from.
  await expect(found.getByLabel('Name')).toHaveValue('Nightly Reporter')
  await expect(found.getByRole('checkbox')).toHaveCount(0)
  await expect(found).toContainText(
    'AGENT.md is its instructions. README.md briefs an assistant that opens the folder to work on it.'
  )
  await expect(found.getByRole('button', { name: 'Add agent', exact: true })).toBeVisible()

  await found.getByLabel('Name').fill('Weekly Digest')
  await found.getByRole('button', { name: 'Add agent', exact: true }).click()
  await expect(cinna.page.getByRole('dialog')).toHaveCount(0)

  const row = cinna.page.getByRole('button', { name: 'Weekly Digest', exact: true })
  await expect(row).toHaveText('Weekly Digest')
  await row.click()
  await expect(cinna.page.getByRole('heading', { level: 1 })).toHaveText('Weekly Digest')

  // The name the user gave is held on this machine: the folder still says what
  // it always said, and gained nothing.
  expect(readFileSync(join(folder, 'AGENT.md'), 'utf8')).toContain('# Nightly Reporter')
  expect(treeOf(folder)).toEqual(before)
})

test('a folder with no AGENT.md is refused, and the dialog stays open', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const folder = homeDir(cinna, 'holiday-photos')
  writeFileSync(join(folder, 'notes.txt'), 'not an agent\n')
  mkdirSync(join(folder, 'summer'), { recursive: true })
  writeFileSync(join(folder, 'summer', 'beach.md'), '# Beach\n')

  await openAddDialog(cinna)
  await cinna.stubDirectoryPicker(folder)
  const choice = cinna.page.getByRole('dialog', { name: 'Add an agent' })
  await choice.getByRole('button', { name: /^Add a folder/ }).click()

  // A refusal is a state, not a failure: the dialog closes on success only
  // (ux_rules.md rule 6), so it is still the choice step and it names the file
  // the user needs to look for.
  await expect(choice.getByRole('alert')).toHaveText(
    "Nothing in this folder has an AGENT.md. Choose the agent's own folder, or a folder that holds several of them."
  )
  await expect(choice).toBeVisible()
  await expect(cinna.page.getByRole('dialog', { name: 'Add a folder' })).toHaveCount(0)
  await expect(choice.getByRole('button', { name: /^New agent/ })).toBeVisible()
  await expect(choice.getByRole('button', { name: /^Add a folder/ })).toBeVisible()
})

test('a bare agent has no Commands tab, and its Prompts tab is AGENT.md over a read-only README.md', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const folder = writeBareAgent(homeDir(cinna, 'exchange-rates'), 'Exchange Rates Agent')
  await adoptFolder(cinna, folder)

  const { page } = cinna
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Exchange Rates Agent', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Exchange Rates Agent')

  await test.step('four tabs, and Commands is not one of them', async () => {
    const tabs = page.getByRole('tablist', { name: 'Agent details' })
    // No badges: a bare folder with an `AGENT.md` has no errors and no
    // warnings, and has granted no permissions.
    await expect(tabs.getByRole('tab')).toHaveText([
      'Overview',
      'Prompts',
      'Permissions',
      'Folder'
    ])
    await expect(tabs.getByRole('tab', { name: /^Commands/ })).toHaveCount(0)
  })

  await test.step('Overview is the name, the one thing the desktop holds itself', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Name' })).toBeVisible()
    await expect(page.getByPlaceholder('What this agent is called')).toHaveValue(
      'Exchange Rates Agent'
    )
  })

  await test.step('Prompts: Instructions over AGENT.md, Readme over README.md', async () => {
    await page.getByRole('tab', { name: 'Prompts' }).click()
    await expect(page.getByRole('tab', { name: 'Prompts' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    const card = (title: string) =>
      page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: title }) })
    const instructions = card('Instructions')
    const readme = card('Readme')
    // The card names the file it is a view over: the button's name is the
    // file, its `title` the action ("Reveal AGENT.md").
    const instructionsFile = instructions.getByRole('button', { name: 'AGENT.md', exact: true })
    await expect(instructionsFile).toHaveAttribute('title', 'Reveal AGENT.md')
    await expect(instructions).toContainText('You answer questions about Exchange Rates Agent.')
    const readmeFile = readme.getByRole('button', { name: 'README.md', exact: true })
    await expect(readmeFile).toHaveAttribute('title', 'Reveal README.md')
    await expect(readme).toContainText('Run it with `uv run`.')

    // Read-only means the click-to-edit the other card has is simply absent.
    // The Instructions card, clicked the same way straight afterwards, is the
    // control that keeps this from passing on a page that never rendered.
    await readme.getByText('Run it with `uv run`.').click()
    await expect(readme.getByRole('textbox')).toHaveCount(0)
    await instructions.getByText('You answer questions about Exchange Rates Agent.').click()
    await expect(instructions.getByRole('textbox')).toHaveCount(1)
  })
})

test('removing a bare agent from the list leaves the folder, and Settings puts it back', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  await stubTrash(cinna)
  const folder = writeBareAgent(homeDir(cinna, 'sales-leaderboard'), 'Sales Leaderboard Agent')
  const before = treeOf(folder)
  await adoptFolder(cinna, folder)

  const { page } = cinna
  const row = page.getByRole('button', { name: 'Sales Leaderboard Agent', exact: true })
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await row.click()

  await test.step('the confirm offers two choices, and the button follows the choice', async () => {
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Remove agent…' }).click()

    // "Remove agent", not "Delete agent": for a bare agent the accessible name
    // matches the heading, the menu item and the button, and the default option
    // deletes nothing. Announcing the more alarming word here would be the
    // dialog's own name contradicting every word inside it.
    const confirm = page.getByRole('dialog', { name: 'Remove agent' })
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText('Remove agent')
    await expect(confirm.getByRole('radio')).toHaveCount(2)

    const listOnly = confirm.getByRole('radio', { name: /^Remove from the list only/ })
    const toTrash = confirm.getByRole('radio', { name: /^Remove and move the folder to the Trash/ })
    // The recoverable option is the default (ux_rules.md rule 5).
    await expect(listOnly).toBeChecked()
    await expect(toTrash).not.toBeChecked()
    await expect(confirm.getByRole('button', { name: 'Remove', exact: true })).toBeVisible()

    await toTrash.check()
    await expect(confirm.getByRole('button', { name: 'Move to Trash', exact: true })).toBeVisible()
    await listOnly.check()
    await expect(confirm.getByRole('button', { name: 'Remove', exact: true })).toBeVisible()

    await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(confirm).toHaveCount(0)
  })

  await test.step('gone from the list, still on disk, and a rescan keeps skipping it', async () => {
    await expect(row).toHaveCount(0)
    expect(treeOf(folder)).toEqual(before)
    expect(readFileSync(join(folder, 'AGENT.md'), 'utf8')).toContain('# Sales Leaderboard Agent')

    // The index, not the cache: a rescan walks the root and finds the folder
    // again, and "removed from the list" is what makes it skip it.
    await page.evaluate(() => window.api.localAgents.rescan())
    const named = await page.evaluate(async () =>
      (await window.api.localAgents.list()).agents.map((agent) => agent.name)
    )
    expect(named).not.toContain('Sales Leaderboard Agent')
    await expect(row).toHaveCount(0)
  })

  await test.step('Settings offers to put it back, and it comes back', async () => {
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Local Agents', exact: true }).click()

    // "not in the list", not "removed from it": the same hidden state also
    // holds an agent the user simply did not tick when adopting the folder, so
    // adopting 1 of 15 reported "14 agents removed from the list" about agents
    // that were never in it.
    const note = page.getByText('1 agent in this folder is not in the list.')
    await expect(note).toBeVisible()
    await page.getByRole('button', { name: 'Add it', exact: true }).click()
    await expect(note).toHaveCount(0)

    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await expect(row).toHaveText('Sales Leaderboard Agent')
    expect(treeOf(folder)).toEqual(before)
  })
})
