import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { DESKTOP_STATE_FILE, MANIFEST_FILE } from '../../src/shared/kit/manifest'

/**
 * A Claude agent's Permissions tab offers **who approves its actions**, and the
 * choice survives a restart.
 *
 * ## What this spec does and does not do
 *
 * It makes the choice and reads it back — from the select, from the file the
 * desktop keeps beside the folder's grants, and from the select again after
 * the app has been quit and started. It never runs a turn on the engine, so
 * whether `ask` actually routes a command to the chat's permission block is
 * out of scope here (that is the ACP driver's own suite, against a fake
 * ACP agent). Nothing here needs a `claude` install either: the card branches on the
 * **manifest's** engine, not on detection, and the one `claude` invocation the
 * page would otherwise cause — the login probe the Runs-with panel makes — is
 * pinned over `ipcMain` so this file spawns no `claude` at all.
 *
 * ## Why the file is the assertion
 *
 * The select is controlled by the DTO and the hook writes the mutation's
 * answer straight into the query cache, so a handler that never touched disk
 * would still show `ask` for the rest of the session. Two things say the choice
 * was actually kept: `app-data/desktop.json` naming it, and the select reading
 * it again in a fresh process, whose only source is that file. The manifest is
 * checked too, in the other direction — the choice is the desktop's own and
 * must **not** land in a file the folder publishes.
 *
 * ## Why the heading is measured
 *
 * The card explains both settings *above* the control and reserves a line for
 * an error *below* it, so choosing must not move the "Always allowed" list
 * under the pointer that just used the select (ux_rules rule 1). The heading's
 * box before and after is that assertion.
 *
 * ## The other engine
 *
 * An OpenCode agent's tab is the contrast: no approvals control at all, and the
 * profile sentence instead — a Claude card describing OpenCode's rules, or the
 * reverse, would be describing a gate that is not in force.
 */

const CLAUDE_AGENT = 'Release Notes'
const OPENCODE_AGENT = 'Ledger Watcher'

/** The card's own words on each engine — one must be present, the other absent. */
const CLAUDE_SENTENCE = 'This agent runs on your own Claude Code install.'
const OPENCODE_SENTENCE = 'runs commands inside its own folder without asking'

/** The login probe pinned to "not answered", so no `claude` child is spawned. */
const AUTH_UNKNOWN = { state: 'unknown', authMethod: null, subscriptionType: null } as const

/** Parsed `app-data/desktop.json`, or null while the desktop has not written one. */
function desktopState(agentPath: string): Record<string, unknown> | null {
  const file = join(agentPath, DESKTOP_STATE_FILE)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** Parsed `cinna-agent.json`. */
function manifest(agentPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentPath, MANIFEST_FILE), 'utf8')) as Record<string, unknown>
}

/**
 * Restart in the same sandbox and rebuild the index — agents seeded over IPC
 * are invisible to the renderer's queries until then, and startup does not
 * scan. The probe is re-pinned because handlers are per process.
 */
async function restart(cinna: CinnaApp): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await cinna.electronApp.evaluate(({ ipcMain }, status) => {
    ipcMain.removeHandler('local-tools:claude-auth')
    ipcMain.handle('local-tools:claude-auth', () => status)
  }, AUTH_UNKNOWN)
}

/** Open an agent's Permissions tab from wherever the app just started. */
async function openPermissions(cinna: CinnaApp, name: string): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  // A fresh `$HOME` has no agents folder, so the tab asks about it first.
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  await page
    .getByRole('tablist', { name: 'Agent details' })
    .getByRole('tab', { name: /^Permissions/ })
    .click()
}

/** The Permissions card: a `section` with no accessible name, found by its `h2`. */
function permissionsCard(cinna: CinnaApp): ReturnType<typeof cinna.page.locator> {
  const page = cinna.page
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Permissions' }) })
}

test('a Claude agent chooses who approves its actions, and the choice survives a restart', async ({
  cinna
}) => {
  await cinna.skipOnboarding()

  const root = await addAgentRoot(cinna)
  // Description equal to the name, so the sidebar row reads as the name alone.
  const agent = await createFolderAgent(cinna, root, CLAUDE_AGENT, CLAUDE_AGENT)
  const stamp = agent.stamps[MANIFEST_FILE]
  expect(stamp, `the scaffolded ${MANIFEST_FILE} has a stamp`).not.toBeNull()

  // The engine, through the same write the Runs-with panel makes. All four
  // keys are required by the setter; the three nulls remove theirs.
  const saved = await cinna.page.evaluate(
    (input) =>
      window.api.localAgents.updateField({
        agentId: input.agentId,
        update: {
          field: 'runtime',
          value: { engine: 'claude', credential: null, modelId: null, complexity: null }
        },
        expectedStamp: input.expectedStamp
      }),
    { agentId: agent.id, expectedStamp: stamp! }
  )
  expect(saved.ok, saved.ok ? '' : saved.message).toBe(true)
  expect(manifest(agent.path).runtime).toEqual({ engine: 'claude' })
  // Nothing has been decided yet, and the scaffold writes no desktop state.
  expect(desktopState(agent.path)).toBeNull()

  await restart(cinna)
  await openPermissions(cinna, CLAUDE_AGENT)

  const card = permissionsCard(cinna)
  const approvals = card.getByLabel('Approvals')
  const alwaysAllowed = card.getByText('Always allowed', { exact: true })

  await test.step('the tab offers the choice, on the default, in the engine’s own words', async () => {
    await expect(approvals).toHaveValue('auto')
    await expect(approvals.locator('option')).toHaveText(['Automatic', 'Ask every time'])
    await expect(card).toContainText(CLAUDE_SENTENCE)
    await expect(card).not.toContainText(OPENCODE_SENTENCE)
  })

  await test.step('choosing “Ask every time” reads back at once, and nothing moves', async () => {
    const before = await alwaysAllowed.boundingBox()
    expect(before, 'the Always allowed heading is on screen').not.toBeNull()

    await approvals.selectOption({ label: 'Ask every time' })
    // At once: the card holds the pick until main answers rather than snapping
    // back to the DTO's value for the round trip.
    await expect(approvals).toHaveValue('ask')
    await expect(approvals).toBeEnabled()

    // The heading did not move: the explanation sits above the control and the
    // error line below is always rendered, so the list stays where it was.
    expect(await alwaysAllowed.boundingBox()).toEqual(before)
    await expect(card).not.toContainText('Nothing was changed')
  })

  await test.step('the choice lands beside the grants, and not in the manifest', async () => {
    await expect
      .poll(() => desktopState(agent.path)?.claudeApproval, {
        message: `${DESKTOP_STATE_FILE} names the approval setting`
      })
      .toBe('ask')
    // The literal the file carries, as the desktop wrote it.
    expect(readFileSync(join(agent.path, DESKTOP_STATE_FILE), 'utf8')).toContain(
      '"claudeApproval": "ask"'
    )
    // The desktop's own decision, never published with the folder.
    const published = manifest(agent.path)
    expect(published.runtime).toEqual({ engine: 'claude' })
    expect(published).not.toHaveProperty('claudeApproval')
  })

  await test.step('after a restart the select still reads the choice', async () => {
    await restart(cinna)
    await openPermissions(cinna, CLAUDE_AGENT)
    const reopened = permissionsCard(cinna).getByLabel('Approvals')
    await expect(reopened).toHaveValue('ask')
    await expect(reopened).toBeEnabled()
  })
})

test('an OpenCode agent’s Permissions tab has no approvals control, and describes the profile', async ({
  cinna
}) => {
  await cinna.skipOnboarding()

  const root = await addAgentRoot(cinna)
  // No engine declared: the scaffold writes `runtime: null`, and an agent
  // naming no engine runs on OpenCode.
  const agent = await createFolderAgent(cinna, root, OPENCODE_AGENT, OPENCODE_AGENT)
  const runtime = manifest(agent.path).runtime as { engine?: unknown } | null
  expect(runtime?.engine, 'the scaffolded manifest names no engine').toBeUndefined()

  await restart(cinna)
  await openPermissions(cinna, OPENCODE_AGENT)

  const card = permissionsCard(cinna)
  await expect(card).toContainText(OPENCODE_SENTENCE)
  await expect(card).not.toContainText(CLAUDE_SENTENCE)
  await expect(card.getByLabel('Approvals')).toHaveCount(0)
  await expect(card.locator('select')).toHaveCount(0)
  await expect(card.getByText('Always allowed', { exact: true })).toBeVisible()
})
