import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/app'
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

test('changing the credential rewrites the manifest, says what it dropped, and does not move the page', async ({
  cinna
}) => {
  await cinna.skipOnboarding()

  await test.step('two credentials and an agent that declares the Anthropic one', async () => {
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
        update: { field: 'runtime', value: { credential: input.credential, modelId: input.modelId } },
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
  await page.getByRole('button', { name: AGENT }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)

  const panel = page.getByRole('region', { name: 'Runs with' })
  const credential = panel.getByLabel('Credential')
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
    await expect(model.locator('option')).toHaveText(['Default (none set)', CLAUDE.name])
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
