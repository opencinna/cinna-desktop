import { RUNTIME_PINS } from '../../../src/shared/runtimePins'
import { expect, q, test } from '../fixtures/vm'

/**
 * Settings → Local Development → Developer Tools on a Mac without the Command
 * Line Tools: make and python3 are the /usr/bin stubs and read as not found
 * without being run; git is the app's own managed git once its background
 * download lands, which on a bare Mac starts at startup.
 */
test('Developer Tools reads the stubs as missing and finds the managed git', async ({ vm }) => {
  const { page } = vm
  vm.step('skip onboarding')
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()

  vm.step('open Developer Tools')
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  // The Default group comes first; Profile has a section of the same name.
  await page.getByRole('button', { name: 'Local Development', exact: true }).first().click()
  const row = (label: string) => page.getByRole('row', { name: new RegExp(`^${label}`) })
  await expect(row('Make')).toContainText('Not found')
  await expect(row('Python 3')).toContainText('Not found')

  vm.step('wait for the managed git')
  const gitBin = `${vm.userData}/runtimes/git-${RUNTIME_PINS.git.cli}/bin/git`
  await expect
    .poll(async () => (await vm.sh(`test -x ${q(gitBin)} && echo yes || echo no`)).trim(), {
      timeout: 5 * 60_000,
      intervals: [5_000]
    })
    .toBe('yes')

  vm.step('refresh Developer Tools')
  await page.getByRole('button', { name: 'Refresh detected tools' }).click()
  await expect(row('Git')).toContainText(RUNTIME_PINS.git.cli)
  await expect(row('Make')).toContainText('Not found')
})
