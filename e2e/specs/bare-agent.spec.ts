import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { answerAgentsFolder, test, expect, homeDir, type CinnaApp } from '../fixtures/app'

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
  // A fresh `$HOME` has no agents folder, so the tab asks about it first.
  await answerAgentsFolder(cinna)
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

test('a bare agent has no Commands tab, its README on Overview and AGENT.md on Prompts', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const folder = writeBareAgent(homeDir(cinna, 'exchange-rates'), 'Exchange Rates Agent')
  await adoptFolder(cinna, folder)

  const { page } = cinna
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
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

  await test.step('Overview: the name the desktop holds, then the folder’s README', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Name' })).toBeVisible()
    await expect(page.getByPlaceholder('What this agent is called')).toHaveValue(
      'Exchange Rates Agent'
    )

    // The README is what the folder says about itself, so it answers the tab's
    // question — not Prompts, where it read as part of what the agent is told.
    const readme = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 2, name: 'Readme' }) })
    await expect(readme.getByRole('button', { name: 'README.md', exact: true })).toHaveAttribute(
      'title',
      'Reveal README.md'
    )
    // Rendered, not raw: the fixture's backticks arrive as a `code` element, so
    // the card reads as the document rather than as its source.
    await expect(readme).toContainText('Run it with uv run.')
    await expect(readme.getByText('`uv run`')).toHaveCount(0)
    // And its own `# heading` is demoted, so the page keeps exactly one `h1`.
    await expect(readme.getByRole('heading', { level: 3 })).toHaveText('Exchange Rates Agent')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Exchange Rates Agent')

    // Read-only: the click that opens the Instructions editor does nothing here.
    await readme.getByText('Run it with').click()
    await expect(readme.getByRole('textbox')).toHaveCount(0)
  })

  await test.step('Prompts is AGENT.md alone — the one document the agent is told', async () => {
    await page.getByRole('tab', { name: 'Prompts' }).click()
    await expect(page.getByRole('tab', { name: 'Prompts' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    const card = (title: string) =>
      page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: title }) })
    const instructions = card('Instructions')
    // The README is not here: it is the folder's briefing for a person, and a
    // second card on this tab read as though it too reached the agent.
    await expect(card('Readme')).toHaveCount(0)
    // The card names the file it is a view over: the button's name is the
    // file, its `title` the action ("Reveal AGENT.md").
    const instructionsFile = instructions.getByRole('button', { name: 'AGENT.md', exact: true })
    await expect(instructionsFile).toHaveAttribute('title', 'Reveal AGENT.md')
    await expect(instructions).toContainText('You answer questions about Exchange Rates Agent.')

    // Rendered while it is read, raw while it is written: the click puts the
    // file's own bytes in a textbox, heading marker and all.
    await instructions.getByText('You answer questions about Exchange Rates Agent.').click()
    const box = instructions.getByRole('textbox')
    await expect(box).toHaveCount(1)
    await expect(box).toHaveValue(
      '# Exchange Rates Agent\n\nYou answer questions about Exchange Rates Agent.\n'
    )
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
  await answerAgentsFolder(cinna)
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
    // Matched without its tail: the sentence now ends by naming the route
    // ("— choose which ones with Manage agents above"), and this assertion is
    // about the count and the wording of the *state*, not about the pointer.
    const note = page.getByText('1 agent in this folder is not in the list')
    await expect(note).toBeVisible()

    // The count is a statement; the set is chosen in Manage agents. The old
    // "Add it" button beside the note could only put back all of them at once,
    // which is why it was replaced rather than kept alongside.
    await page.getByRole('button', { name: /^Manage agents in / }).click()
    const manage = page.getByRole('dialog', { name: 'Manage agents' })
    await expect(manage).toBeVisible()
    await manage.getByRole('checkbox').first().check()
    await manage.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(manage).toHaveCount(0)
    await expect(note).toHaveCount(0)

    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)
    await expect(row).toHaveText('Sales Leaderboard Agent')
    expect(treeOf(folder)).toEqual(before)
  })
})

test('re-picking an adopted folder re-selects its agents, and confirms what leaves the list', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const repo = homeDir(cinna, 'finance-agents')
  for (const [slug, heading] of FOUND) writeBareAgent(join(repo, 'local_agents', slug), heading)
  const before = treeOf(repo)

  const [FIRST, SECOND, THIRD] = FOUND
  const { page } = cinna
  const row = (heading: string) => cinna.page.getByRole('button', { name: heading, exact: true })
  /** One row of the picked folder's list, by the name and path the dialog shows. */
  const box = (dialog: Locator, [slug, heading]: (typeof FOUND)[number]) =>
    dialog.getByRole('checkbox', { name: `${heading} local_agents/${slug}` })

  /** + → Add a folder, at `repo`, landing on the list of what it holds. */
  const pickRepo = async (): Promise<Locator> => {
    await openAddDialog(cinna)
    await cinna.stubDirectoryPicker(repo)
    await cinna.page
      .getByRole('dialog', { name: 'Add an agent' })
      .getByRole('button', { name: /^Add a folder/ })
      .click()
    const list = cinna.page.getByRole('dialog', { name: 'Add a folder' })
    await expect(list).toBeVisible()
    return list
  }

  await test.step('one of the three is adopted, and two are left behind', async () => {
    const list = await pickRepo()
    await expect(list.getByRole('checkbox')).toHaveCount(3)
    // A first adopt opens with everything ticked, so taking two out is two
    // clicks away from the state this test needs.
    await list.getByRole('button', { name: 'Clear all', exact: true }).click()
    await box(list, FIRST).check()
    await list.getByRole('button', { name: 'Add agent', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await expect(row(FIRST[1])).toHaveText(FIRST[1])
    await expect(row(SECOND[1])).toHaveCount(0)
    await expect(row(THIRD[1])).toHaveCount(0)
  })

  await test.step('the same folder is no longer refused: it comes back as a selection', async () => {
    const list = await pickRepo()
    // The old behaviour was the refusal `This folder is already registered as
    // "finance-agents".` in the choice step's alert, with the folder step never
    // reached — which left no way at all to add the two that were not ticked.
    await expect(list.getByText('3 agents in finance-agents')).toBeVisible()
    await expect(list).toContainText(
      'Already in the app as “finance-agents”. This is the whole list — the folder on disk is never touched either way.'
    )
    // Ticked because it is in the app, and **editable** — unticking it is how it
    // would leave. An already-added row used to be ticked and disabled.
    await expect(box(list, FIRST)).toBeChecked()
    await expect(box(list, FIRST)).toBeEnabled()
    await expect(box(list, SECOND)).not.toBeChecked()
    await expect(box(list, THIRD)).not.toBeChecked()
    // Not "Add 1 agent": the button saves a set, and the set can shrink.
    await expect(list.getByRole('button', { name: 'Save selection', exact: true })).toBeVisible()

    await box(list, SECOND).check()
    await expect(list.getByTitle('1 to add.')).toBeVisible()
    await list.getByRole('button', { name: 'Save selection', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await expect(row(FIRST[1])).toHaveText(FIRST[1])
    await expect(row(SECOND[1])).toHaveText(SECOND[1])
    await expect(row(THIRD[1])).toHaveCount(0)
  })

  await test.step('unticking one asks first, by name, and says what does not come back', async () => {
    const list = await pickRepo()
    await expect(box(list, FIRST)).toBeChecked()
    await expect(box(list, SECOND)).toBeChecked()
    await box(list, FIRST).uncheck()
    await expect(list.getByTitle('1 to remove from the list.')).toBeVisible()

    // The first press is the question, never the act.
    await list.getByRole('button', { name: 'Save selection', exact: true }).click()
    await expect(list.getByText('Remove an agent from the list')).toBeVisible()
    await expect(list.locator('strong')).toHaveText(FIRST[1])
    const sentence = list.locator('p').filter({ hasText: 'leaves the list' })
    await expect(sentence).toHaveCount(1)
    await expect(sentence).toContainText(
      'any job that uses one will refuse to run — and will need it selected again even if you add it back'
    )
    // The list is frozen under the question: it names agents, and a set that
    // could still change would ask about one and act on another.
    await expect(box(list, SECOND)).toBeDisabled()
    await expect(list.getByRole('button', { name: 'Back to the list', exact: true })).toBeVisible()

    await list.getByRole('button', { name: 'Remove and save', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  await test.step('it leaves the list, and its folder is exactly where it was', async () => {
    await expect(row(FIRST[1])).toHaveCount(0)
    await expect(row(SECOND[1])).toHaveText(SECOND[1])
    await expect(row(THIRD[1])).toHaveCount(0)
    // Removing from the list is an app-side act in both directions: neither the
    // add nor the remove may leave a mark on a folder the user owns.
    expect(treeOf(repo)).toEqual(before)
    expect(readFileSync(join(repo, 'local_agents', FIRST[0], 'AGENT.md'), 'utf8')).toContain(
      `# ${FIRST[1]}`
    )
  })
})

/**
 * The "Runs with" panel on a bare agent — the one surface where a folder the
 * desktop promised not to write into has to remember a choice.
 *
 * It needs a **model registry**, which is one live network round trip per
 * credential (`provider:list-models`), so the panel's controls stay disabled
 * for as long as it has not landed. The endpoint is replaced and nothing else,
 * exactly as `agent-runtime.spec.ts` does it: both SDKs read their base URL
 * from the environment, the fixture hands the app this process's environment,
 * and the app then runs its real adapters over real HTTP against a server in
 * this file. Scoped to a `describe` so the tests above it — which seed no
 * credentials and make no such call — run with the environment untouched, and
 * restored in `afterAll` so `live.spec.ts` in the same worker never sees it.
 */
test.describe('a bare agent chooses its own credential', () => {
  const ANTHROPIC_CRED = 'Anthropic Personal'
  const OPENAI_CRED = 'OpenAI Work'
  const CLAUDE = { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' }
  const AGENT = 'Invoice Triage Agent'

  /** Both catalogues on one port, told apart by the header the SDK sends. */
  function modelRegistry(): Server {
    return createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (!req.url?.startsWith('/v1/models')) {
        res.statusCode = 404
        res.end('{}')
        return
      }
      const anthropic = typeof req.headers['x-api-key'] === 'string'
      res.end(
        JSON.stringify(
          anthropic
            ? {
                data: [
                  {
                    type: 'model',
                    id: CLAUDE.id,
                    display_name: CLAUDE.name,
                    created_at: '2025-09-29T00:00:00Z'
                  }
                ],
                has_more: false,
                first_id: CLAUDE.id,
                last_id: null
              }
            : {
                object: 'list',
                data: [
                  { id: 'gpt-4o-mini', object: 'model', created: 1_720_000_000, owned_by: 'openai' }
                ]
              }
        )
      )
    })
  }

  let server: Server
  const savedEnv: Record<string, string | undefined> = {}

  test.beforeAll(async () => {
    server = modelRegistry()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    savedEnv.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL
    savedEnv.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
    // The OpenAI SDK's default base URL already carries `/v1`; Anthropic's does not.
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`
  })

  test.afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** Every state file the desktop keeps for bare agents, by filename. */
  function stateFiles(cinna: CinnaApp): string[] {
    const dir = join(cinna.sandbox.userData, 'external-agents')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
  }

  /** The `runtime` block of the single bare agent's state, or null if it has none. */
  function storedRuntime(cinna: CinnaApp): unknown {
    const files = stateFiles(cinna)
    if (files.length !== 1) return null
    const raw = readFileSync(join(cinna.sandbox.userData, 'external-agents', files[0]), 'utf8')
    return (JSON.parse(raw) as { runtime?: unknown }).runtime ?? null
  }

  /** Agents tab → this agent's page, from wherever the app just is. */
  async function openAgentPage(cinna: CinnaApp): Promise<Locator> {
    const page = cinna.page
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)
    await page.getByRole('button', { name: AGENT, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
    return page.getByRole('region', { name: 'Runs with' })
  }

  test('the choice is saved in Cinna, survives a restart, and never lands in the folder', async ({
    cinna
  }) => {
    await cinna.skipOnboarding()
    await cinna.page.evaluate(
      async (names) => {
        await window.api.providers.upsert({
          type: 'anthropic',
          name: names.anthropic,
          apiKey: 'e2e-anthropic-key',
          enabled: true
        })
        await window.api.providers.upsert({
          type: 'openai',
          name: names.openai,
          apiKey: 'e2e-openai-key',
          enabled: true
        })
      },
      { anthropic: ANTHROPIC_CRED, openai: OPENAI_CRED }
    )

    const folder = writeBareAgent(homeDir(cinna, 'invoice-triage'), AGENT)
    const before = treeOf(folder)
    await adoptFolder(cinna, folder)
    // Adopting a folder whose one agent is wanted writes nothing anywhere: the
    // `hidden: false` patch is skipped because the state already reads that way.
    expect(stateFiles(cinna)).toEqual([])

    // Credentials seeded over IPC are invisible to the renderer's `useProviders`
    // query, which cached an empty list before the seed and is invalidated by
    // nothing — the same staleness the agent list has. A restart is the
    // arrangement, not part of what is under test.
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    let panel = await openAgentPage(cinna)

    await test.step('the panel is a control now, not a sentence', async () => {
      const credential = panel.getByLabel('Runs on')
      // Disabled until `provider:list-models` lands for both credentials; before
      // that the panel cannot tell a foreign model from an unlisted one.
      await expect(credential).toBeEnabled()
      // The bare panel used to render the credential as static text and offer no
      // second picker at all — it could only report the Default runtime.
      await expect(panel.getByLabel('Work complexity')).toBeEnabled()
      await expect(credential).toHaveValue('')
      await expect(credential.locator('option')).toHaveCount(3)
      await expect(credential.locator('option').first()).toHaveText('Default (none set)')
      // The one line on the page that says where the answer goes.
      await expect(panel).toContainText(
        'This choice is kept in Cinna, not in the folder — so a folder that moves starts over on the default.'
      )
    })

    await test.step('choosing a credential writes it under userData, and only there', async () => {
      await panel.getByLabel('Runs on').selectOption(OPENAI_CRED)
      await expect(panel.getByLabel('Runs on')).toHaveValue(OPENAI_CRED)
      // The file is the assertion. A `runtime` block in the folder's own
      // `cinna-agent.json`, or an `app-data/desktop.json` beside `AGENT.md`,
      // would satisfy every locator above and none of the three below.
      await expect
        .poll(() => storedRuntime(cinna), { message: 'the choice reached userData' })
        .toEqual({ credential: OPENAI_CRED })
      // Keyed by the folder's real path, with its basename kept legible.
      expect(stateFiles(cinna)).toHaveLength(1)
      expect(stateFiles(cinna)[0]).toMatch(/^invoice-triage-[0-9a-f]{16}\.json$/)
      expect(treeOf(folder)).toEqual(before)
      expect(existsSync(join(folder, 'app-data'))).toBe(false)
      expect(existsSync(join(folder, 'cinna-agent.json'))).toBe(false)
    })

    await test.step('a restart and a rescan read it back off disk', async () => {
      await cinna.relaunch()
      await cinna.skipOnboarding()
      // Startup does not scan, and the panel reads `agent.runtime` off the index.
      await cinna.page.evaluate(() => window.api.localAgents.rescan())
      panel = await openAgentPage(cinna)
      const credential = panel.getByLabel('Runs on')
      await expect(credential).toBeEnabled()
      await expect(credential).toHaveValue(OPENAI_CRED)
      expect(treeOf(folder)).toEqual(before)
    })
  })
})
