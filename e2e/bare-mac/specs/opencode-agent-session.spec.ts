import { RUNTIME_PINS } from '../../../src/shared/runtimePins'
import { arrangeAgentsHome, createAgentAndSend, hasManagedInstall } from '../fixtures/agentSession'
import { expect, test } from '../fixtures/vm'

/**
 * An OpenCode folder agent on a Mac with nothing installed, on a real OpenAI
 * key from `.env` (billed: one short turn on gpt-5.6-luna). The pinned
 * OpenCode is downloaded from npm, bootstraps its own database, starts a
 * session in the agent folder — where the engine's own `git` and shell would
 * raise the Command Line Tools dialog — and answers.
 *
 * Billed, so it runs only when asked for, as the main suite's live specs do:
 * `make bare-mac LIVE=1` sets `CINNA_E2E_LIVE=1`.
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? ''
const LIVE_REQUESTED = process.env.CINNA_E2E_LIVE === '1'
/** The main suite's `PREFERRED_MODELS`: `CINNA_E2E_LIVE_MODEL`, then luna, then the minis. */
const PREFERRED_MODELS = [process.env.CINNA_E2E_LIVE_MODEL?.trim() ?? '', 'gpt-5.6-luna', 'gpt-5-mini', 'gpt-4.1-mini'].filter(Boolean)

test('an OpenCode agent downloads the pinned OpenCode and answers from its folder', async ({ vm }) => {
  test.skip(!LIVE_REQUESTED, 'billed: runs only with make bare-mac LIVE=1')
  test.skip(OPENAI_API_KEY === '', 'OPENAI_API_KEY is not set in .env')
  const { page } = vm
  await arrangeAgentsHome(vm, 'opencode', async () => {
    const model = await page.evaluate(async ({ apiKey, preferred }) => {
      const { id } = await window.api.providers.upsert({ type: 'openai', name: 'OpenAI', apiKey, enabled: true })
      const listed = (await window.api.providers.listModels()).filter((m) => m.providerId === id)
      const chosen = preferred.map((p) => listed.find((m) => m.id === p)).find(Boolean)
      if (!chosen) throw new Error(`the app lists none of ${preferred.join(', ')} for the key`)
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: chosen.id, isDefault: true })
      return chosen.id
    }, { apiKey: OPENAI_API_KEY, preferred: PREFERRED_MODELS })
    test.info().annotations.push({ type: 'model', description: model })
  })
  await createAgentAndSend(vm, 'Reply with exactly the word BAREPONG and nothing else.')

  vm.step('OpenCode download, bootstrap, session start and answer')
  await expect(page.getByText('BAREPONG', { exact: true }).first()).toBeVisible({ timeout: 10 * 60_000 })
  expect(await hasManagedInstall(vm, 'engine', 'opencode', RUNTIME_PINS.opencode.cli)).toBe(true)
  // An engine's late git or shell call, after the turn, lands in this window.
  vm.step('idle after the turn')
  await page.waitForTimeout(30_000)
})
