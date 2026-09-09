import type { Page } from '@playwright/test'
import { answerAgentsFolder, test, expect } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'
import type { DetectedTool } from '../../src/shared/localTools'

/**
 * A folder agent on the **Claude engine**, on a machine whose `claude` is
 * installed but **not logged in**: the "Runs with" panel's reserved status line
 * has to name the remedy, and the Engine column beside it has to keep naming
 * the install.
 *
 * ## Why this state is reachable here at all, and free
 *
 * Readiness on this engine is answered before a turn by spawning
 * `claude auth status` (`claudeAuth.ts`). That subcommand runs no turn, logs
 * nobody in or out, and bills nothing — it is the *only* `claude` invocation
 * this spec may cause, and the reason it is allowed where a turn is not
 * (`claude-engine.spec.ts`'s header, and the gotcha in `e2e_llm.md`).
 *
 * The probe resolves its child environment through `buildClaudeEnv`, which
 * passes `HOME` through deliberately — the alternative "authenticates as
 * nobody". Every test in this suite already runs under a throwaway `HOME`, and
 * that binary reads its login from there: measured on a developer machine that
 * *is* logged in, `claude auth status` under the sandbox `HOME` exits 1 and
 * prints `{"loggedIn": false, "authMethod": "none", …}` while the same binary
 * under the real `HOME` prints `"loggedIn": true`. So the sandbox produces a
 * genuinely logged-out install **without logging anybody out**, and it does so
 * on a machine where the developer is logged in as well as on one where they
 * are not. Nothing here fakes the state; the ladder is driven against the real
 * binary's real answer.
 *
 * ## What is asserted, and why both halves
 *
 * The ladder has five rungs and three of them are silence-or-reassurance
 * (`toolsUnknown`, `claudeAuth === undefined`, `unknown`), so the failure this
 * guards is not "no line" — it is the *wrong* line, and specifically the
 * reassuring one. Hence two assertions that must hold together:
 *
 * 1. The status line reads the remedy-first sentence, in the danger tone. It
 *    leads with `Run \`claude\` in a terminal` because it is measured to clip
 *    at the 800px minimum, and the remedy is the half that must survive
 *    (ux_rules rule 7).
 * 2. The Engine column still reads `Claude Code <version>`. The install and its
 *    version are facts about the machine and stay true; only the reserved line
 *    carries what they *mean*. Asserting it here is what distinguishes "logged
 *    out" from "not installed" — the confusion the whole ladder exists to
 *    prevent, and the two rungs that share the danger tone.
 *
 * The install sentence is asserted **absent**, not tolerated. A spec that
 * passed on either sentence would pass on a machine where the probe silently
 * degraded to `unknown`, which is precisely the regression that would put
 * readiness back behind a billed turn.
 *
 * The third assertion is the **dot** beside that column, which carries the same
 * distinction in the one glanceable place: `--color-warning` for a definite
 * `logged_out`, `--color-danger` for no install at all, `--color-text-muted`
 * for everything the app has not found out. Colours are read from the running
 * theme rather than from class names, and the three are asserted to be
 * genuinely different values first — three tokens that resolved to the same
 * colour would make the comparison prove nothing.
 *
 * ## Never a turn
 *
 * Nothing here clicks anything that starts one. The agent is seeded onto the
 * engine over IPC and the page is only read.
 */

const AGENT = 'Ledger Watcher'

/** The Runs-on select's value for the engine — `CLAUDE_OPTION` in the panel. */
const CLAUDE_VALUE = 'engine:claude'

/** The rung under test: remedy first, danger tone. */
const LOGGED_OUT = 'Run `claude` in a terminal: that Claude Code install is not logged in.'
/**
 * The rung one step weaker — what a probe that could not answer produces. Must
 * not be on screen: it is the sentence that reads as "everything is fine".
 */
const ON_INSTALL = 'Claude Agent runs on your own Claude Code install, on sonnet.'

/**
 * What `var(--color-<token>)` resolves to in the running app.
 *
 * Read from the theme rather than hardcoded, because the assertion is "this is
 * the alarm colour", not "this is `#dc2626`" — a palette change must not fail a
 * test about which meaning was chosen.
 */
async function themeColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div')
    probe.style.color = `var(--color-${name})`
    document.body.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  }, token)
}

test('a Claude agent on a logged-out install is told to log in, and still names the install', async ({
  cinna
}) => {
  await cinna.skipOnboarding()

  // Real detection, over the same IPC the panel's query uses — the sandbox's rc
  // files carry the machine's own PATH. On a machine with no Claude Code there
  // is nothing to be logged out of, and the panel's sentence there is the
  // *other* danger rung, which `RuntimePanel.test.tsx` can fake.
  const claude = (await cinna.page.evaluate(() => window.api.localTools.list())).find(
    (tool: DetectedTool) => tool.id === 'claude' && tool.available
  )
  test.skip(
    claude === undefined,
    'no `claude` on this machine: the panel would read "Claude Agent needs Claude Code, which ' +
      'is not installed on this machine." — a different rung of the same ladder, and ' +
      'RuntimePanel.test.tsx’s case rather than this one'
  )

  const root = await addAgentRoot(cinna)
  // Description equal to the name so the sidebar row reads as the name alone.
  const created = await createFolderAgent(cinna, root, AGENT, AGENT)
  const stamp = created.stamps[MANIFEST_FILE]
  expect(stamp, `the scaffolded ${MANIFEST_FILE} has a stamp`).not.toBeNull()

  // Straight onto the engine, so the panel opens on the Claude branch and the
  // spec never touches the select. `credential` must be null beside an engine —
  // `runtimeService` refuses to write both — and the tier is left off because
  // the sentence under test says nothing about it.
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
    { agentId: created.id, expectedStamp: stamp! }
  )
  expect(saved.ok, saved.ok ? '' : saved.message).toBe(true)

  // An agent seeded over IPC is invisible to the renderer's queries until the
  // window restarts, and the index is rebuilt by a scan rather than at startup.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  await test.step('the sandbox’s own `claude` reports itself logged out', async () => {
    // The arrangement, stated as an assertion. The panel's line is decided by
    // this answer, so a machine that returned `unknown` here would make every
    // UI assertion below fail for a reason that has nothing to do with the
    // panel — and the point of naming it separately is that the failure says
    // so. `authMethod` comes back as the CLI's own word for "no login"; no
    // account identity crosses this boundary at all (`ClaudeAuthStatus`).
    const status = await cinna.page.evaluate(() => window.api.localTools.claudeAuth())
    expect(status, 'claude auth status under the sandbox HOME').toEqual({
      state: 'logged_out',
      authMethod: 'none',
      subscriptionType: null
    })
  })

  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  // A fresh `$HOME` has no agents folder, so the tab asks about it first.
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)

  const panel = page.getByRole('region', { name: 'Runs with' })
  await expect(panel.getByLabel('Runs on')).toHaveValue(CLAUDE_VALUE)

  await test.step('the reserved line leads with the remedy, in the alarm tone', async () => {
    // **Waited for, never asserted on first paint.** The line is empty while
    // detection is in flight and empty again while the login probe is — two
    // deliberate silences rather than a sentence the panel would retract — so
    // the assertion is on what it settles to, ~300ms in. The full sentence is
    // also the element's `title`, so this locator *is* the status line.
    const line = panel.getByTitle(LOGGED_OUT, { exact: true })
    await expect(line).toHaveText(LOGGED_OUT)
    // Not the reassuring rung. Exclusive already — one reserved line cannot
    // hold two sentences — but named so a probe that degraded to `unknown`
    // fails with the reason written on it rather than as a missing locator.
    await expect(panel.getByText(ON_INSTALL)).toHaveCount(0)
    // The tone, read from the theme rather than from a class name: this is the
    // one rung whose whole job is to be noticed, and a note-grey remedy is the
    // same defect as no remedy (ux_rules rule 9).
    await expect(line).toHaveCSS('color', await themeColour(page, 'danger'))
  })

  await test.step('the Engine column still names the install it found', async () => {
    // Logged out is a fact about the login, not about the machine's binary.
    // This cell reports what detection found — the absolute path is its
    // `title`, which is what makes it findable — and it is the only thing on
    // the panel that tells "logged out" apart from "not installed".
    const cell = panel.getByTitle(claude!.path!)
    const expected = claude!.version ? `Claude Code ${claude!.version}` : 'Claude Code'
    await expect(cell).toHaveText(expected)
    await expect(panel.getByText('Not installed')).toHaveCount(0)

    // The dot is the row's only glanceable indicator, and here it is the
    // difference between "go and log in" and "go and install it". Warning, not
    // danger: the install is fine and one command fixes it. Not muted either —
    // muted is what the app says while it does not know, and it does know.
    const [warning, danger, muted] = await Promise.all([
      themeColour(page, 'warning'),
      themeColour(page, 'danger'),
      themeColour(page, 'text-muted')
    ])
    // A comparison against tokens that resolved to one colour would prove
    // nothing, so the three are first shown to be three.
    expect(new Set([warning, danger, muted]).size, 'three distinct theme colours').toBe(3)
    // `fill-current`, so the dot's `color` is the token; the svg is the cell's
    // only sibling in the row.
    await expect(cell.locator('..').locator('svg')).toHaveCSS('color', warning)
  })
})
