import { RUNTIME_PINS } from '../../../src/shared/runtimePins'
import { arrangeAgentsHome, createAgentAndSend, hasManagedInstall } from '../fixtures/agentSession'
import { expect, test } from '../fixtures/vm'

/**
 * An Antigravity folder agent on a Mac with nothing installed and no Google
 * login: the app reads the login — the macOS keychain asked by attributes
 * only, which must raise no keychain prompt — says to sign in, and the pinned
 * agy-acp-server zip downloads and unpacks with no system dialog. Sign-in is
 * never pressed: it opens a real browser.
 */
test('an Antigravity agent downloads the pinned server and asks for a Google sign-in', async ({ vm }) => {
  const { page } = vm
  await arrangeAgentsHome(vm, 'antigravity')
  await createAgentAndSend(vm, 'hi')

  vm.step('Antigravity login check')
  await expect(page.getByText('Antigravity is not signed in to Google').first()).toBeVisible({
    timeout: 10 * 60_000
  })
  // The sentence is readiness's verdict, read before any download, so the
  // turn never fetches the server; Settings' check installs it.
  vm.step('Antigravity download')
  const state = await page.evaluate(() => window.api.engine.resolveAntigravity())
  expect(state).toMatchObject({ state: 'ready', source: 'managed' })
  expect(await hasManagedInstall(vm, 'runtimes', 'antigravity', RUNTIME_PINS.antigravity.cli)).toBe(true)
  vm.step('idle after the refusal')
  await page.waitForTimeout(20_000)
})
