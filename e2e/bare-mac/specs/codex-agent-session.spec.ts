import { RUNTIME_PINS } from '../../../src/shared/runtimePins'
import { arrangeAgentsHome, createAgentAndSend, hasManagedInstall } from '../fixtures/agentSession'
import { expect, q, test } from '../fixtures/vm'

/**
 * A Codex folder agent on a Mac with nothing installed, logged in with a dummy
 * API-key `~/.codex/auth.json` — `codex login status` reads it as logged in
 * with no network, so unlike Claude's login refusal the pinned Codex and its
 * adapter are downloaded and spawned in the agent folder and start a session,
 * where the engine's own `git` and shell would raise the Command Line Tools
 * dialog. The turn ends at the provider refusing the key: OpenAI's own
 * sentence, or the adapter's `Authentication required` once Codex marks the
 * 401 as unauthorized. The text shown is kept as the `refusal` annotation.
 */
test('a Codex agent with an API-key login spawns the pinned Codex in its folder', async ({ vm }) => {
  const { page } = vm
  await vm.sh(`mkdir -p ~/.codex && printf '%s\\n' ${q('{"OPENAI_API_KEY":"sk-dummy-not-a-key"}')} > ~/.codex/auth.json`)
  await arrangeAgentsHome(vm, 'codex')
  await createAgentAndSend(vm, 'hi')

  vm.step('Codex download, session start and provider refusal')
  const refusal = page.getByText(/Incorrect API key provided|Authentication required/).first()
  await expect(refusal).toBeVisible({ timeout: 10 * 60_000 })
  test.info().annotations.push({ type: 'refusal', description: (await refusal.textContent()) ?? '' })
  expect(await hasManagedInstall(vm, 'runtimes', 'codex', RUNTIME_PINS.codex.cli)).toBe(true)
  // An engine's late git or shell call, after the turn, lands in this window.
  vm.step('idle after the turn')
  await page.waitForTimeout(30_000)
})
