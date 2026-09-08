import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * Settings → Local Agents → **Forget** an added agents folder.
 *
 * Forget used to run on one click of an unlabelled X, and what it does is not
 * obviously recoverable: it drops the `agents` row of every folder agent under
 * the root, and `job_agents`, `a2a_sessions` and `chat_on_demand_agents`
 * cascade from that row. There is a confirm in front of it now, and the whole
 * promise of that confirm is a claim about the disk — "The folder and
 * everything in it stays on disk — Cinna only stops listing it."
 *
 * So the assertion that matters here is not the row leaving the list, which
 * would pass just as well against an implementation that deleted the folder on
 * its way past. It is `treeOf` before and after: the same file list, byte for
 * byte, including the file the test wrote there by hand and the agent folders
 * the removal had just forgotten.
 */

/** Everything under `dir`, relative and sorted — the "nothing was touched" witness. */
function treeOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort()
}

/** Footer user menu → Settings → Local Agents. The trigger is the profile's generated name. */
async function openLocalAgentsSettings(cinna: CinnaApp): Promise<Locator> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Local Agents', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agent Folders' })).toBeVisible()
  // A `section` with no accessible name is not a `region`, so it is found by
  // the heading it holds.
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Agent Folders' }) })
}

const ROOT = 'team-agents'
const AGENTS = ['Invoice Triage', 'Weekly Digest'] as const

test('Forget asks first, Cancel changes nothing, and the folder outlives the confirm', async ({
  cinna
}) => {
  await cinna.skipOnboarding()

  const root = await addAgentRoot(cinna, ROOT)
  const created: { name: string; path: string }[] = []
  for (const name of AGENTS) {
    const agent = await createFolderAgent(cinna, root, name)
    // The folder is the slug of the name, so its path comes from the DTO
    // rather than from an assumption about slugify.
    created.push({ name, path: agent.path ?? '' })
  }
  // A file of the user's own, so "everything in it stays on disk" is checked
  // against something Cinna did not put there and has no reason to keep.
  writeFileSync(join(root.path, 'handover.md'), '# Handover\n\nAsk Dana about the Q3 numbers.\n')
  const before = treeOf(root.path)
  expect(before).toContain('handover.md')

  // Roots and agents seeded over IPC are invisible to a query that was already
  // fetched; the restart is the arrangement, not part of what is under test.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  const section = await openLocalAgentsSettings(cinna)
  const forget = section.getByRole('button', { name: `Forget ${ROOT}`, exact: true })
  const dialog = cinna.page.getByRole('dialog', { name: 'Forget agents folder' })

  await test.step('the home folder cannot be forgotten; the added one can', async () => {
    await expect(section.getByText(root.path)).toBeVisible()
    await expect(forget).toBeVisible()
    // The default home root is `Agents`, and it carries no Forget at all:
    // there is no confirm to reach because there is no action behind it.
    await expect(section.getByRole('button', { name: 'Forget Agents', exact: true })).toHaveCount(0)
    await expect(section.getByRole('button', { name: /^Forget / })).toHaveCount(1)
  })

  await test.step('the X asks first, names the folder, and promises the disk', async () => {
    await forget.click()
    await expect(dialog).toBeVisible()
    // The click asked and did nothing else. This is the whole change under
    // test: the X used to remove the root on this one press, and against that
    // behaviour the row would already be gone here.
    await expect(forget).toBeVisible()
    await expect(section.getByText(root.path)).toBeVisible()

    // The recoverable half, in the words the copy uses for it.
    await expect(dialog).toContainText(
      `Forget ${ROOT}? The folder and everything in it stays on disk — Cinna only stops listing it.`
    )
    // And the half that is not recoverable. `agentCount`, so the sentence is
    // about the two agents that are in the list.
    await expect(dialog).toContainText(
      'Its 2 agents leave the list. Existing chats stay, but they can no longer reach them, and any job set up with one loses that agent. Adding the folder again lists the agents again — it does not put them back into those jobs, and a job left that way runs without the agent rather than asking.'
    )
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Forget folder', exact: true })).toBeVisible()
  })

  await test.step('Cancel leaves the list and the disk exactly as they were', async () => {
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    await expect(forget).toBeVisible()
    await expect(section.getByText(root.path)).toBeVisible()
    await expect(section.getByText('2 agents · kit contract')).toBeVisible()
    expect(treeOf(root.path)).toEqual(before)
  })

  await test.step('Forget folder takes the row out of the list', async () => {
    await forget.click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Forget folder', exact: true }).click()

    // The dialog closes on success only, so its absence is the outcome.
    await expect(dialog).toHaveCount(0)
    await expect(forget).toHaveCount(0)
    await expect(section.getByText(root.path)).toHaveCount(0)
    // The agents went with it. Asserted against the index rather than against a
    // sentence on screen: the "N agents, all valid" status row this used to
    // read was removed from the section, and the index is what "the agents went
    // with it" actually means.
    const named = await cinna.page.evaluate(async () =>
      (await window.api.localAgents.list()).agents.map((agent) => agent.name)
    )
    expect(named).toEqual([])
  })

  await test.step('the folder and every file in it are still there', async () => {
    // This is the assertion the copy is a promise about. Every locator above
    // would pass against a Forget that deleted the folder on its way past.
    expect(existsSync(root.path)).toBe(true)
    expect(treeOf(root.path)).toEqual(before)
    expect(readFileSync(join(root.path, 'handover.md'), 'utf8')).toContain(
      'Ask Dana about the Q3 numbers.'
    )
    for (const agent of created) {
      const manifest = join(agent.path, 'cinna-agent.json')
      expect(existsSync(manifest)).toBe(true)
      expect(readFileSync(manifest, 'utf8')).toContain(agent.name)
    }
  })

  await test.step('adding the same folder again brings its agents back', async () => {
    await cinna.stubDirectoryPicker(root.path)
    await section.getByRole('button', { name: 'Add an agents folder' }).click()

    await expect(forget).toBeVisible()
    await expect(section.getByText(root.path)).toBeVisible()
    // The row's own summary line, not the removed status card: "2 agents" is
    // what the folder row says about itself.
    await expect(section.getByText(/2 agents · kit contract/)).toBeVisible()
    // Re-adopting reads the folder; it does not rewrite it.
    expect(treeOf(root.path)).toEqual(before)
  })
})
