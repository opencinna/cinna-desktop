import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'

/**
 * Switching the credential on the "Runs with" panel, with two credentials that
 * list different catalogues.
 *
 * The assertion that matters is the **file**: the engine turns a manifest's
 * `{credential, model}` into `"<credential>/<model>"` verbatim, so a manifest
 * left naming an Anthropic model under an OpenAI credential is a config that
 * saves cleanly here and fails on the agent's first turn. What the panel says
 * and what the picker offers are the two things that tell the user it
 * happened; the panel's height is what keeps the tab strip below it from
 * moving out from under the pointer that just used the select.
 *
 * ## Why a local model registry
 *
 * `provider:list-models` is a real network round trip per credential — every
 * adapter's `listModels()` is one — so two credentials with fake keys would
 * give this test an empty registry, and an empty registry cannot tell a model
 * that belongs to another catalogue from one it simply has not listed
 * (`shared/runtimeDefaults`, `modelBelongsElsewhere`, declines to guess in
 * exactly that case). The suite has no Anthropic key and one Anthropic model
 * turn is not what this scenario is about, so the *endpoint* is replaced and
 * nothing else: both SDKs read their base URL from the environment
 * (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`), the fixture hands the app the
 * test process's environment, and the app then runs its real adapters, real
 * `providerService.listModels`, real registry over real HTTP to a server in
 * this file. Provider *types* stay `anthropic` and `openai`, so the drop goes
 * through the cross-type branch of the rule and not the `openai_compatible`
 * per-row one.
 *
 * The variables are set in `beforeAll` and removed in `afterAll`: the fixture
 * copies `process.env` at launch, and `live.spec.ts` in the same worker must
 * not inherit a base URL pointing at this server.
 */

const ANTHROPIC_CRED = 'Anthropic Personal'
const OPENAI_CRED = 'OpenAI Work'
/** What the Anthropic stub lists, and what the manifest declares to begin with. */
const CLAUDE = { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' }
/** Newest first is what the OpenAI adapter sorts by, hence the `created` values. */
const OPENAI_MODELS = [
  { id: 'gpt-4o-mini', created: 1_720_000_000, name: 'GPT-4o Mini' },
  { id: 'gpt-4.1-mini', created: 1_710_000_000, name: 'GPT-4.1 Mini' }
]
const AGENT = 'Ledger Watcher'

const NOTICE = `Dropped “${CLAUDE.name}” — ${OPENAI_CRED} does not list it.`

/**
 * The reserved status line, in the three states the complexity test walks
 * through. The healthy one is not empty: a tier is worth choosing only if the
 * panel says what it costs and what it resolved to.
 */
const HEALTHY = `Medium — the balanced default, on ${CLAUDE.name}.`
const REMEDY = `Pick another complexity or another credential — ${ANTHROPIC_CRED} lists no model for Complex work.`
const PINNED = `Pinned “${CLAUDE.name}” — what Medium resolved to.`

/**
 * Both catalogues on one port. Told apart by the header the SDK sends:
 * Anthropic authenticates with `x-api-key`, OpenAI with a bearer token.
 */
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
              data: OPENAI_MODELS.map((model) => ({
                id: model.id,
                object: 'model',
                created: model.created,
                owned_by: 'openai'
              }))
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
  // The OpenAI SDK's default base URL already carries `/v1`; the Anthropic
  // SDK's does not and its paths do.
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`
})

test.afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** The manifest's `runtime` block as it stands on disk right now. */
function manifestRuntime(agentPath: string): unknown {
  return JSON.parse(readFileSync(join(agentPath, MANIFEST_FILE), 'utf8')).runtime
}

/** Two credentials whose catalogues the stub above tells apart by header. */
async function seedCredentials(cinna: CinnaApp): Promise<void> {
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
}

/** Open the seeded agent's page, from wherever the app just started. */
async function openAgentPage(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  // A fresh `$HOME` has no agents folder, so the tab asks about it first.
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
}

/**
 * The two numbers that say the page did not move: how tall the panel is, and
 * where the tab strip under it starts — at the default width and at the 800px
 * minimum, because the panel is a container query and lays itself out
 * differently at each.
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
  const tabs = await cinna.page
    .getByRole('tablist', { name: 'Agent details' })
    .boundingBox()
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

test('changing the credential rewrites the manifest, says what it dropped, and does not move the page', async ({
  cinna
}) => {
  await cinna.skipOnboarding()

  await test.step('two credentials and an agent that declares the Anthropic one', async () => {
    await seedCredentials(cinna)
  })

  const root = await addAgentRoot(cinna)
  // Description equal to the name so the sidebar row is the name and nothing
  // else — `describedAs` drops a description that only repeats it.
  const created = await createFolderAgent(cinna, root, AGENT, AGENT)
  const stamp = created.stamps[MANIFEST_FILE]
  expect(stamp, `the scaffolded ${MANIFEST_FILE} has a stamp`).not.toBeNull()
  const saved = await cinna.page.evaluate(
    (input) =>
      window.api.localAgents.updateField({
        agentId: input.agentId,
        update: {
          field: 'runtime',
          value: { credential: input.credential, modelId: input.modelId, complexity: null }
        },
        expectedStamp: input.expectedStamp
      }),
    {
      agentId: created.id,
      credential: ANTHROPIC_CRED,
      modelId: CLAUDE.id,
      expectedStamp: stamp!
    }
  )
  expect(saved.ok, saved.ok ? '' : saved.message).toBe(true)
  expect(manifestRuntime(created.path)).toEqual({ credential: ANTHROPIC_CRED, model: CLAUDE.id })

  // A folder agent seeded over IPC is invisible to the renderer's queries until
  // the window restarts.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  // A fresh `$HOME` has no agents folder, so the tab asks about it first.
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)

  const panel = page.getByRole('region', { name: 'Runs with' })
  const credential = panel.getByLabel('Credential')
  // The manifest pins a model, so the panel opens on the Advanced model picker
  // rather than the Work Complexity tier. That is the manifest deciding the
  // view, not a remembered preference.
  const model = panel.getByLabel('Model')
  const tabs = page.getByRole('tablist', { name: 'Agent details' })

  let panelBefore: { height: number } | null = null
  let tabsBefore: { y: number } | null = null

  await test.step('the panel waits for the model registry, then shows what the manifest declares', async () => {
    // Both selects are disabled until `provider:list-models` lands: before it
    // does, the panel cannot tell a foreign model from an unlisted one.
    await expect(credential).toBeEnabled()
    await expect(model).toBeEnabled()
    await expect(credential).toHaveValue(ANTHROPIC_CRED)
    await expect(model).toHaveValue(CLAUDE.id)
    // `Default` names the Medium floor on this credential — the Anthropic
    // catalogue's one model is a sonnet — so both options read the same name
    // here. On the OpenAI credential below, whose catalogue is all minis, the
    // floor finds nothing and `Default` goes back to naming nothing.
    await expect(model.locator('option')).toHaveText([
      `Default (${CLAUDE.name})`,
      CLAUDE.name
    ])
    // Nothing is wrong yet, so the reserved status line is empty.
    await expect(panel).not.toContainText('Dropped')

    panelBefore = await panel.boundingBox()
    tabsBefore = await tabs.boundingBox()
    expect(panelBefore, 'the panel is on screen').not.toBeNull()
    expect(tabsBefore, 'the tab strip is on screen').not.toBeNull()
  })

  await test.step('switch the credential to the OpenAI one', async () => {
    await credential.selectOption(OPENAI_CRED)
  })

  await test.step('the manifest no longer names the Anthropic model', async () => {
    // The whole block, not just the credential: `model` gone is the assertion,
    // because the engine builds `<credential>/<model>` verbatim.
    await expect
      .poll(() => manifestRuntime(created.path), {
        message: `${MANIFEST_FILE} keeps the credential and drops the model`
      })
      .toEqual({ credential: OPENAI_CRED })
  })

  await test.step('the panel says what it dropped, in its one reserved line', async () => {
    // By `title`: the status line carries the full sentence there because the
    // line truncates, which makes it the one element that is that line.
    await expect(panel.getByTitle(NOTICE)).toHaveText(NOTICE)
  })

  await test.step('the Model select offers only what the OpenAI credential lists', async () => {
    await expect(credential).toHaveValue(OPENAI_CRED)
    await expect(model).toHaveValue('')
    await expect(model.locator('option')).toHaveText([
      'Default (none set)',
      ...OPENAI_MODELS.map((entry) => entry.name)
    ])
    const values = await model
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
    expect(values, 'the Anthropic model is not offered under the OpenAI credential').toEqual([
      '',
      ...OPENAI_MODELS.map((entry) => entry.id)
    ])
  })

  await test.step('the panel is the same height, so the tab strip did not move', async () => {
    const panelAfter = await panel.boundingBox()
    const tabsAfter = await tabs.boundingBox()
    expect(panelAfter?.height).toBe(panelBefore?.height)
    expect(tabsAfter?.y).toBe(tabsBefore?.y)
  })
})

/**
 * Work complexity: the same panel when the manifest names a *tier* instead of a
 * model, and the Advanced escape hatch out of it.
 *
 * A tier is the choice a user can actually hold an opinion about — `medium`
 * means the same thing on the next machine and on a credential that has never
 * heard of `claude-sonnet-4-5-20250929`. What that costs is a layer of
 * indirection over billing, so the two things this test insists on are that the
 * concrete model is on screen (the tier names what it resolved to, in the
 * reserved line) and that a tier the chosen credential cannot serve says so
 * *before* it is picked (` (none listed)` in the option) and says what to do
 * about it after (remedy first, because that line truncates at the 800px
 * minimum and the surviving half has to be the actionable one).
 *
 * The Advanced checkbox is not a view toggle: it **converts the file**, because
 * the manifest — not a remembered preference — decides which picker an agent
 * gets. That is why the preference is seeded to the *opposite* of what the
 * panel is expected to show, at both ends of the flow: first `true` against a
 * manifest naming a tier, then `false` against the manifest the conversion
 * wrote. A panel that obeyed the checkbox rather than the file would show the
 * wrong picker in one of those two places.
 *
 * The catalogue is the same local stub the credential-switch test above uses,
 * and it is what makes the tiers deterministic: the Anthropic credential lists
 * one sonnet, so Medium resolves and Simple and Complex resolve to nothing.
 */
test('a work complexity resolves to a model, warns when it cannot, and Advanced converts the manifest', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  await seedCredentials(cinna)

  const root = await addAgentRoot(cinna)
  const created = await createFolderAgent(cinna, root, AGENT, AGENT)
  const stamp = created.stamps[MANIFEST_FILE]
  expect(stamp, `the scaffolded ${MANIFEST_FILE} has a stamp`).not.toBeNull()

  await test.step('the manifest declares a tier, and the preference says the opposite', async () => {
    const saved = await cinna.page.evaluate(
      (input) =>
        window.api.localAgents.updateField({
          agentId: input.agentId,
          update: {
            field: 'runtime',
            value: { credential: input.credential, modelId: null, complexity: 'medium' }
          },
          expectedStamp: input.expectedStamp
        }),
      { agentId: created.id, credential: ANTHROPIC_CRED, expectedStamp: stamp! }
    )
    expect(saved.ok, saved.ok ? '' : saved.message).toBe(true)
    expect(manifestRuntime(created.path)).toEqual({
      credential: ANTHROPIC_CRED,
      complexity: 'medium'
    })
    // Advanced is a remembered preference for an agent that declares neither.
    // Seeded true here so that the tier picker below is the *manifest* winning,
    // not the default value of a setting.
    await cinna.page.evaluate(() =>
      window.api.settings.set('localAgentsModelAdvanced', true)
    )
  })

  // A folder agent seeded over IPC is invisible to the renderer's queries until
  // the window restarts, and the index is rebuilt by a scan, not at startup.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await openAgentPage(cinna)

  const panel = () => cinna.page.getByRole('region', { name: 'Runs with' })
  const complexity = (): ReturnType<typeof panel> => panel().getByLabel('Work complexity')
  const model = (): ReturnType<typeof panel> => panel().getByLabel('Model')
  const advanced = (): ReturnType<typeof panel> =>
    panel().getByRole('checkbox', { name: 'Advanced' })
  /** The one reserved status line: the only element whose `title` is that sentence. */
  const status = (text: string): ReturnType<typeof panel> =>
    panel().getByTitle(text, { exact: true })

  let baseline: Layout | null = null

  await test.step('the tier picker is what renders, and the line names the model it resolved to', async () => {
    // Both selects are disabled until `provider:list-models` lands *and* the
    // settings query answers; asking before that reads a control mid-flight.
    await expect(complexity()).toBeEnabled()
    await expect(model()).toHaveCount(0)
    await expect(panel().getByText('Work complexity', { exact: true })).toBeVisible()
    await expect(advanced()).not.toBeChecked()
    await expect(complexity()).toHaveValue('medium')
    // The tier that this credential cannot serve is marked before it is picked.
    // `Default` carries no suffix here because it resolves — via the Medium
    // floor — to the same sonnet.
    await expect(complexity().locator('option')).toHaveText([
      'Default',
      'Simple (none listed)',
      'Medium',
      'Complex (none listed)'
    ])
    // The user is choosing what gets billed, so the concrete model is on screen.
    await expect(status(HEALTHY)).toHaveText(HEALTHY)
    baseline = await layout(cinna)
    // The two widths are genuinely two layouts — the panel is a container
    // query, and at the 800px minimum the engine line drops to its own row. If
    // this ever reads equal, the resize did nothing and every "narrow"
    // comparison below is comparing the wide layout with itself.
    expect(baseline.narrow.panel, 'the 800px layout is the taller two-column one').toBeGreaterThan(
      baseline.wide.panel
    )
  })

  await test.step('a tier this credential cannot serve warns remedy-first', async () => {
    await complexity().selectOption('complex')
    await expect
      .poll(() => manifestRuntime(created.path), {
        message: `${MANIFEST_FILE} carries the tier, and only the tier`
      })
      .toEqual({ credential: ANTHROPIC_CRED, complexity: 'complex' })
    await expect(status(REMEDY)).toHaveText(REMEDY)
    // The leading clause is the assertion: at the 800px minimum this line is
    // truncated, and what survives has to be the half the user can act on.
    await expect(status(REMEDY)).toHaveText(/^Pick another complexity or another credential — /)
    await expect(complexity()).toHaveValue('complex')
    expect(await layout(cinna)).toEqual(baseline)
  })

  await test.step('back to Medium', async () => {
    await complexity().selectOption('medium')
    await expect(status(HEALTHY)).toHaveText(HEALTHY)
    expect(await layout(cinna)).toEqual(baseline)
  })

  await test.step('ticking Advanced converts the file to the model the tier resolved to', async () => {
    await advanced().check()
    await expect
      .poll(() => manifestRuntime(created.path), {
        message: `${MANIFEST_FILE} loses the tier and gains the model it named`
      })
      .toEqual({ credential: ANTHROPIC_CRED, model: CLAUDE.id })
    await expect(panel().getByText('Model', { exact: true })).toBeVisible()
    await expect(complexity()).toHaveCount(0)
    await expect(model()).toHaveValue(CLAUDE.id)
    // A rewrite of a file the user commits cannot happen wordlessly.
    await expect(status(PINNED)).toHaveText(PINNED)
    expect(await layout(cinna)).toEqual(baseline)
  })

  await test.step('the manifest decides the picker, not the checkbox', async () => {
    // The preference now says "not advanced" and the file names a model. The
    // file wins, or the panel would show a tier over an agent pinned to a model.
    await cinna.page.evaluate(() =>
      window.api.settings.set('localAgentsModelAdvanced', false)
    )
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openAgentPage(cinna)

    await expect(model()).toBeEnabled()
    await expect(complexity()).toHaveCount(0)
    await expect(panel().getByText('Model', { exact: true })).toBeVisible()
    await expect(advanced()).toBeChecked()
    await expect(model()).toHaveValue(CLAUDE.id)
    expect(manifestRuntime(created.path)).toEqual({ credential: ANTHROPIC_CRED, model: CLAUDE.id })
    // The Model select names the model itself, so the reserved line stays empty
    // — and the conversion's note is not carried across a restart.
    await expect(panel()).not.toContainText('Pinned')
    expect(await layout(cinna)).toEqual(baseline)
  })
})
