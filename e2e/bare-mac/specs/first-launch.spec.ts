import { expect, test } from '../fixtures/vm'

/**
 * A new user opens the app on a Mac that has never had developer tools.
 *
 * 0.5.1 failed this one: within fifteen seconds of the first launch, before any
 * click, the system "install the command line developer tools" dialog opened,
 * because startup tool detection executed the /usr/bin/git stub.
 */
test('first launch shows Welcome and nothing from the system', async ({ vm }) => {
  const { page } = vm
  await expect(page.getByText('Welcome to Cinna')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible()

  // Startup work (tool detection, the default-engine lock, the managed git
  // download it may start) runs in the first seconds; give it a minute on
  // screen, as a user reading the Welcome card would.
  vm.step('idle on Welcome')
  await page.waitForTimeout(60_000)
})
