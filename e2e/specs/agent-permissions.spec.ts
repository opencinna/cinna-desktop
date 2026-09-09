import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { DESKTOP_STATE_FILE } from '../../src/shared/kit/manifest'

/**
 * The agent page's Permissions tab: the count on the tab, the two ways to
 * revoke, and the file underneath.
 *
 * A standing grant is a security decision the user made once and will not be
 * asked about again, so the only thing that proves a revoke is the store — not
 * the row disappearing, which a cache write alone would produce. The grants
 * live in the agent folder's own `app-data/desktop.json` (never in OpenCode's
 * global store — `docs/agents/local_agents/opencode_contract.md` §4), and the
 * folder path is derived in main from the agent id, so this spec seeds that
 * file directly and reads it back off disk after each revoke.
 *
 * The two seeded rules are the two shapes the store holds: an `origin` grant
 * synthesised from a webfetch URL, and an `exact` grant that is a command line
 * verbatim. Both are also the two the card must render in the user's words
 * rather than the engine's (`webfetch` → "Fetch from the web").
 */

const AGENT = 'Docs Reader'

/** Keys as `permissionGrantKey` writes them: `<action>::<pattern>`. */
const WEBFETCH_KEY = 'webfetch::https://docs.example.com/*'
const BASH_KEY = 'bash::make test'

/** Well before "now", so both rows read as a date rather than "2h ago". */
const DECIDED_AT = 1_757_000_000_000

const SEEDED_GRANTS = {
  [WEBFETCH_KEY]: {
    action: 'webfetch',
    pattern: 'https://docs.example.com/*',
    scope: 'origin',
    decidedAt: DECIDED_AT
  },
  [BASH_KEY]: {
    action: 'bash',
    pattern: 'make test',
    scope: 'exact',
    decidedAt: DECIDED_AT
  }
}

/** The aria-label the row's × carries — the phrase, then the pattern. */
const FORGET_WEBFETCH = 'Forget permission to fetch from the web: https://docs.example.com/*'

const NOTHING_YET =
  'Nothing yet. Choosing “Always allow” on a permission request in a chat remembers it here, ' +
  'for this agent only.'

/**
 * The grant keys `app-data/desktop.json` holds right now, sorted.
 *
 * `permissionGrants: {}` and an absent key are the same outcome for a user —
 * nothing is remembered — and `forgetAll` writes the former, so both read as
 * an empty list here.
 */
function grantKeysOnDisk(agentPath: string): string[] {
  const raw: unknown = JSON.parse(readFileSync(join(agentPath, DESKTOP_STATE_FILE), 'utf8'))
  const grants = (raw as { permissionGrants?: Record<string, unknown> }).permissionGrants ?? {}
  return Object.keys(grants).sort()
}

/** Open the seeded agent's page from wherever the app just started. */
async function openAgentPage(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  // A fresh `$HOME` has no agents folder, so the tab asks about it first.
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
}

test('the Permissions tab counts standing grants, and revoking one takes it off disk', async ({
  cinna
}) => {
  await cinna.skipOnboarding()

  const root = await addAgentRoot(cinna)
  // Description equal to the name, so the sidebar row reads as the name alone.
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  const stateFile = join(agent.path, DESKTOP_STATE_FILE)
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, `${JSON.stringify({ permissionGrants: SEEDED_GRANTS }, null, 2)}\n`)

  // An agent seeded over IPC is invisible to the renderer's agent queries until
  // a restart, and the index is rebuilt by a scan rather than at startup.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await openAgentPage(cinna)

  const page = cinna.page
  const tabs = page.getByRole('tablist', { name: 'Agent details' })
  const permissionsTab = tabs.getByRole('tab', { name: /^Permissions/ })
  const card = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Permissions' }) })
  const rows = card.getByRole('listitem')
  const webRow = rows.filter({ hasText: 'Fetch from the web' })
  const bashRow = rows.filter({ hasText: 'Run a command' })

  await test.step('the tab carries the count before it is opened', async () => {
    // The badge is what makes a standing grant discoverable without opening the
    // tab, so it is read here while the Overview tab is still the one selected.
    await expect(permissionsTab).toHaveText('Permissions2')
    await expect(permissionsTab).toHaveAttribute('aria-selected', 'false')
  })

  await test.step('both rules are listed by phrase and pattern', async () => {
    await permissionsTab.click()
    await expect(rows).toHaveCount(2)
    await expect(webRow).toContainText('Fetch from the web')
    await expect(webRow).toContainText('https://docs.example.com/*')
    await expect(bashRow).toContainText('Run a command')
    await expect(bashRow).toContainText('make test')
  })

  await test.step('forgetting one row leaves the other, and the file agrees', async () => {
    await card.getByRole('button', { name: FORGET_WEBFETCH }).click()
    await expect(webRow).toHaveCount(0)
    await expect(bashRow).toHaveCount(1)
    await expect(bashRow).toContainText('make test')
    await expect(permissionsTab).toHaveText('Permissions1')

    expect(grantKeysOnDisk(agent.path)).toEqual([BASH_KEY])
  })

  await test.step('Forget all empties the list, and the file with it', async () => {
    await card.getByRole('button', { name: 'Forget all' }).click()
    await expect(rows).toHaveCount(0)
    await expect(card).toContainText(NOTHING_YET)
    // The action is gone with the last row: there is nothing left to forget.
    await expect(card.getByRole('button', { name: 'Forget all' })).toHaveCount(0)
    // No badge at all, not a zero.
    await expect(permissionsTab).toHaveText('Permissions')

    expect(grantKeysOnDisk(agent.path)).toEqual([])
  })
})
