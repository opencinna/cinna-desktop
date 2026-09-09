import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'
import type { DetectedTool } from '../../src/shared/localTools'

/**
 * Putting a folder agent on the **Claude engine** from the "Runs with" panel:
 * the user's own `claude` install instead of the desktop-managed `opencode
 * serve`.
 *
 * ## What this spec does and does not do
 *
 * It **chooses** the engine. It never runs a turn on it — spawning `claude`
 * bills the user's own Claude subscription, and a spec in the default suite
 * would do that on every developer's machine and in CI. Everything asserted
 * here is knowable from the picker, the panel and the file; whether that
 * install can actually answer is deliberately out of scope.
 *
 * ## Why the file is the assertion
 *
 * `cinna-agent.json` is what the engine reads and what the user commits, and
 * the two directions of this switch are *file rewrites in opposite
 * directions*: moving to Claude must clear `credential` (`runtimeService`
 * refuses to write both — an engine that spends no key cannot name one) and
 * moving back must clear `engine`, while the Work Complexity tier survives both
 * because `medium` means the same thing on either. A panel that showed the
 * right option over a manifest still naming the old one is exactly the failure
 * `agent-runtime.spec.ts` was written for, one axis over.
 *
 * ## Why the geometry is the other assertion
 *
 * The two branches render different controls into the same panel — the
 * Advanced checkbox is gone on Claude, the third column reports a detected
 * binary rather than a startable process — and the page's tab strip sits
 * directly below. If the panel's height moves, the tab strip moves out from
 * under the pointer that just used the select (ux_rules rule 1). Measured at
 * both the default width and the 800px minimum, because the panel is a
 * container query and lays itself out differently at each.
 *
 * ## Detection is real
 *
 * The option is offered only where `claude` is on the PATH, and nothing here
 * fakes that: the fixture writes the real `PATH` into the sandbox's rc files
 * and the app's own detection answers. On a machine without Claude Code the
 * test skips rather than asserting on an option that must not exist there —
 * the absent case is `RuntimePanel.test.tsx`'s, which can fake detection.
 *
 * The model catalogue is stubbed for the *credential* half only, so that branch
 * is healthy rather than "could not load the model list": the Claude branch —
 * which has no catalogue at all — must be compared against a working
 * credential, not against a broken one.
 *
 * ## Why the catalogue is a keyless credential, and not an environment variable
 *
 * It used to come from `ANTHROPIC_BASE_URL`, and that stopped working — for a
 * good reason, which is the same reason the replacement is stable. `18e97b2`
 * pinned the Anthropic client's `baseURL` to `https://api.anthropic.com`
 * precisely so a shell variable cannot send a stored key to a host the user
 * never configured, and `openai.ts` does the same with its default. Left as it
 * was, this spec asserted a healthy credential branch against a catalogue that
 * silently went empty — `providers.listModels()` answering `[]` while a stub
 * server sat there unvisited — which is a fixture that fails *open*.
 *
 * The redirect that survives is the one the product means to exist: a
 * **keyless** credential, whose host the user types and which therefore travels
 * on the row. `providerService.upsert` **drops `baseUrl` for any type that
 * requires a key** — deliberately, because pointing a row holding a real API
 * key at an arbitrary URL "is key exfiltration with extra steps" — so an
 * `openai_compatible` gateway cannot be arranged from a spec at all, and an
 * Ollama row can. That makes the fake Ollama the only stub-served catalogue a
 * spec may build, and it is one the suite already relies on
 * (`ollama-credential.spec.ts`).
 *
 * Its ids classify by **parameter size** rather than by product line, so the
 * three tags below give all three tiers something to resolve to and Medium
 * lands on `qwen3:8b`. Nothing about the Claude branch depends on which
 * credential the other branch holds; what matters is that the comparison is
 * against a working one — and the credential sentence now names a tag that
 * only the stub can have produced, so a fixture that stops being served fails
 * this spec instead of quietly weakening it.
 *
 * ## Why the login probe is stubbed here and nowhere else
 *
 * Readiness on this engine is answered before a turn by `claude auth status`,
 * and under the suite's throwaway `HOME` a real `claude` answers *logged out* —
 * so the panel's reserved line would carry the red remedy rather than anything
 * about the choice this spec is making. That state is real and is asserted
 * against the real binary in `claude-logged-out.spec.ts`. Here the probe is
 * pinned to `unknown` — the honest "readiness was not answered", not a
 * fabricated login — which is the state the install sentence below describes.
 * It also means this spec spawns no `claude` at all, which is the stronger
 * property for a file whose whole header is about never spending the user's
 * subscription.
 */

const CREDENTIAL = 'Local Models'
/**
 * The fake Ollama's catalogue, one tag per tier — parameter size is what
 * decides which (`PARAMS_SMALL` / `PARAMS_MID` / `PARAMS_LARGE`). The **tag
 * itself** is the display name on this provider: the adapter passes it through
 * verbatim rather than prettifying it.
 */
const TAGS = { simple: 'llama3.2:3b', medium: 'qwen3:8b', complex: 'qwen3:32b' }
const AGENT = 'Ledger Watcher'

/** The Runs-on select's value for the engine — `CLAUDE_OPTION` in the panel. */
const CLAUDE_VALUE = 'engine:claude'
const MACHINE_GROUP = 'On this machine'
const CREDENTIAL_GROUP = 'AI credentials'

/** The reserved status line on each branch. */
const ON_CLAUDE = 'Claude Agent runs on your own Claude Code install, on sonnet.'
const ON_CREDENTIAL = `Medium — the balanced default, on ${TAGS.medium}.`

/**
 * What the login probe answers here: *we did not find out*. See the header —
 * the real answer under a throwaway `HOME` is `logged_out`, and that belongs to
 * `claude-logged-out.spec.ts`.
 */
const AUTH_UNKNOWN = { state: 'unknown', authMethod: null, subscriptionType: null } as const

/**
 * A fake Ollama, so the credential branch resolves its tier.
 *
 * Two endpoints, because the app asks two questions: `/api/version` is how
 * detection decides something is answering there at all, and `/api/tags` is the
 * catalogue. `parameter_size` is carried because a real daemon carries it,
 * though the tier is read from the tag.
 */
function modelRegistry(): Server {
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.startsWith('/api/version')) {
      res.end(JSON.stringify({ version: '0.6.2' }))
      return
    }
    if (!req.url?.startsWith('/api/tags')) {
      res.statusCode = 404
      res.end('{}')
      return
    }
    res.end(
      JSON.stringify({
        models: [
          { name: TAGS.simple, model: TAGS.simple, details: { parameter_size: '3B' } },
          { name: TAGS.medium, model: TAGS.medium, details: { parameter_size: '8B' } },
          { name: TAGS.complex, model: TAGS.complex, details: { parameter_size: '32B' } }
        ]
      })
    )
  })
}

let server: Server
/** Where the credential row points, known once the server has a port. */
let registryUrl = ''

test.beforeAll(async () => {
  server = modelRegistry()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  // Reaches the app through the credential row that the test seeds, not through
  // the environment: nothing is written to `process.env` and no launch option
  // is involved, so a later spec in this worker cannot inherit a base URL
  // pointing at a server that has since stopped listening.
  registryUrl = `http://127.0.0.1:${port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** The manifest's `runtime` block as it stands on disk right now. */
function manifestRuntime(agentPath: string): unknown {
  return JSON.parse(readFileSync(join(agentPath, MANIFEST_FILE), 'utf8')).runtime
}

/**
 * The two numbers that say the page did not move: how tall the panel is, and
 * where the tab strip under it starts.
 */
interface Layout {
  wide: { panel: number; tabs: number }
  narrow: { panel: number; tabs: number }
}

const WIDE = 1200
const NARROW = 800

async function setWidth(cinna: CinnaApp, width: number): Promise<void> {
  const handle = await cinna.electronApp.browserWindow(cinna.page)
  await handle.evaluate((browserWindow, target) => {
    const [, height] = browserWindow.getContentSize()
    browserWindow.setContentSize(target, height)
  }, width)
  await expect
    .poll(() => cinna.page.evaluate(() => window.innerWidth), {
      message: `the window is ${width}px wide`
    })
    .toBe(width)
}

async function measure(cinna: CinnaApp): Promise<{ panel: number; tabs: number }> {
  const panel = await cinna.page.getByRole('region', { name: 'Runs with' }).boundingBox()
  const tabs = await cinna.page.getByRole('tablist', { name: 'Agent details' }).boundingBox()
  expect(panel, 'the panel is on screen').not.toBeNull()
  expect(tabs, 'the tab strip is on screen').not.toBeNull()
  return { panel: panel!.height, tabs: tabs!.y }
}

/** Measure at both widths and leave the window at the wide one. */
async function layout(cinna: CinnaApp): Promise<Layout> {
  await setWidth(cinna, WIDE)
  const wide = await measure(cinna)
  await setWidth(cinna, NARROW)
  const narrow = await measure(cinna)
  await setWidth(cinna, WIDE)
  return { wide, narrow }
}

test('choosing the Claude engine rewrites the manifest both ways, and does not move the page', async ({
  cinna
}) => {
  await cinna.skipOnboarding()

  // Real detection, over the same IPC the panel's query uses. The option below
  // exists because of what this answers, not because the spec arranged it.
  const claude = (await cinna.page.evaluate(() => window.api.localTools.list())).find(
    (tool: DetectedTool) => tool.id === 'claude' && tool.available
  )
  test.skip(
    claude === undefined,
    'no `claude` on this machine: the Runs-on select would offer no Claude Agent option, ' +
      'which is RuntimePanel.test.tsx’s case rather than this one'
  )

  // Keyless, so the row keeps the host — see the header. A keyed row silently
  // loses its `baseUrl` here and would talk to the real vendor API with a fake
  // key, which is how this spec's catalogue went empty.
  await cinna.page.evaluate(
    (input) =>
      window.api.providers.upsert({
        type: 'ollama',
        name: input.name,
        baseUrl: input.baseUrl,
        enabled: true
      }),
    { name: CREDENTIAL, baseUrl: registryUrl }
  )

  const root = await addAgentRoot(cinna)
  // Description equal to the name so the sidebar row reads as the name alone.
  const created = await createFolderAgent(cinna, root, AGENT, AGENT)
  const stamp = created.stamps[MANIFEST_FILE]
  expect(stamp, `the scaffolded ${MANIFEST_FILE} has a stamp`).not.toBeNull()

  await test.step('the agent starts on a credential, at a tier', async () => {
    const saved = await cinna.page.evaluate(
      (input) =>
        window.api.localAgents.updateField({
          agentId: input.agentId,
          update: {
            field: 'runtime',
            value: {
              engine: null,
              credential: input.credential,
              modelId: null,
              complexity: 'medium'
            }
          },
          expectedStamp: input.expectedStamp
        }),
      { agentId: created.id, credential: CREDENTIAL, expectedStamp: stamp! }
    )
    expect(saved.ok, saved.ok ? '' : saved.message).toBe(true)
    expect(manifestRuntime(created.path)).toEqual({
      credential: CREDENTIAL,
      complexity: 'medium'
    })
  })

  // A folder agent and a credential seeded over IPC are both invisible to the
  // renderer's queries until the window restarts, and the index is rebuilt by a
  // scan rather than at startup.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  // **After the relaunch**, because handlers are registered per app process and
  // the fresh one carries the product's own. Replacing it — rather than faking
  // detection — keeps everything this spec asserts real: the option is offered
  // because a `claude` was found on the PATH, and only the sentence about
  // whether that install can answer is pinned. It also means no `claude` child
  // is spawned by this file at all.
  await cinna.electronApp.evaluate(({ ipcMain }, status) => {
    ipcMain.removeHandler('local-tools:claude-auth')
    ipcMain.handle('local-tools:claude-auth', () => status)
  }, AUTH_UNKNOWN)

  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  // A fresh `$HOME` has no agents folder, so the tab asks about it first.
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)

  const panel = page.getByRole('region', { name: 'Runs with' })
  const runsOn = panel.getByLabel('Runs on')
  const complexity = panel.getByLabel('Work complexity')
  const advanced = panel.getByRole('checkbox', { name: 'Advanced' })
  /** The one reserved status line: the only element whose `title` is that sentence. */
  const status = (text: string): ReturnType<typeof panel.getByTitle> =>
    panel.getByTitle(text, { exact: true })
  const group = (label: string): ReturnType<typeof panel.locator> =>
    runsOn.locator(`optgroup[label="${label}"] option`)

  let baseline: Layout | null = null

  await test.step('the engine is offered under its own heading, beside the credentials', async () => {
    // The select is disabled until `provider:list-models` lands on this branch,
    // and the Claude option only exists once `useLocalTools` answers — a first
    // visit's detection is a real PATH walk. Waiting on the option is what
    // covers both; reading the list straight away reads it mid-flight.
    await expect(runsOn).toBeEnabled()
    await expect(group(MACHINE_GROUP)).toHaveText(['Claude Agent'])
    // Two honest lists, not one flat one: an engine has no key, no `enabled`
    // flag and no catalogue, so it must not sit among rows that do.
    await expect(group(CREDENTIAL_GROUP)).toHaveText([CREDENTIAL])
    await expect(
      runsOn.locator('optgroup').evaluateAll((groups) =>
        groups.map((entry) => (entry as HTMLOptGroupElement).label)
      )
    ).resolves.toEqual([MACHINE_GROUP, CREDENTIAL_GROUP])
    await expect(runsOn).toHaveValue(CREDENTIAL)
    await expect(complexity).toHaveValue('medium')
    await expect(status(ON_CREDENTIAL)).toHaveText(ON_CREDENTIAL)
    // The escape hatch to a raw model id, on the branch that has a catalogue.
    await expect(advanced).toBeVisible()

    baseline = await layout(cinna)
    // The two widths are genuinely two layouts — the panel is a container
    // query, and at the 800px minimum the engine line drops to its own row. If
    // this ever reads equal, the resize did nothing and every comparison below
    // is comparing the wide layout with itself.
    expect(baseline.narrow.panel, 'the 800px layout is the taller two-column one').toBeGreaterThan(
      baseline.wide.panel
    )
  })

  await test.step('choosing Claude Agent writes the engine and clears the credential', async () => {
    await runsOn.selectOption(CLAUDE_VALUE)
    // The whole block: `credential` gone is half the assertion — `runtimeService`
    // refuses to write both, so a manifest carrying one here would be a file
    // the panel could not have produced — and the tier surviving is the other,
    // because `medium` means the same thing on either engine.
    await expect
      .poll(() => manifestRuntime(created.path), {
        message: `${MANIFEST_FILE} names the engine, keeps the tier, drops the credential`
      })
      .toEqual({ engine: 'claude', complexity: 'medium' })
    await expect(runsOn).toHaveValue(CLAUDE_VALUE)
  })

  await test.step('the panel reports the install it found, and offers no model list', async () => {
    // Both names in one sentence, because both are on the screen: the option
    // says "Claude Agent" and the column beside it names the user's install.
    await expect(status(ON_CLAUDE)).toHaveText(ON_CLAUDE)
    // What detection actually found on this machine, rendered — not a fixture.
    const expected = claude!.version ? `Claude Code ${claude!.version}` : 'Claude Code'
    await expect(panel.getByTitle(claude!.path!)).toHaveText(expected)
    // Absent, not disabled-and-empty: there is no catalogue to pick a model
    // from, and a checkbox that can never do anything invites a click.
    await expect(advanced).toHaveCount(0)
    // The tier survives as a control too, and its Default names the floor this
    // engine runs on rather than a catalogue it does not have.
    await expect(complexity).toHaveValue('medium')
    await expect(complexity.locator('option')).toHaveText([
      'Default (sonnet)',
      'Simple',
      'Medium',
      'Complex'
    ])
  })

  await test.step('the panel is the same height, so the tab strip did not move', async () => {
    expect(await layout(cinna)).toEqual(baseline)
  })

  await test.step('switching back to the credential clears the engine', async () => {
    await runsOn.selectOption(CREDENTIAL)
    await expect
      .poll(() => manifestRuntime(created.path), {
        message: `${MANIFEST_FILE} loses the engine and names the credential again`
      })
      .toEqual({ credential: CREDENTIAL, complexity: 'medium' })
    await expect(runsOn).toHaveValue(CREDENTIAL)
    await expect(status(ON_CREDENTIAL)).toHaveText(ON_CREDENTIAL)
    await expect(advanced).toBeVisible()
    expect(await layout(cinna)).toEqual(baseline)
  })
})
