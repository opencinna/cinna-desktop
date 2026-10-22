import { expect, q, test, type BareVm } from '../fixtures/vm'

/**
 * "Mention in Cinna" on a bare Mac: the Quick Action installed from Settings
 * is registered with the Services menu, and running it hands the selected
 * folder to the app — through the real Launch Services `open -b`, not a test
 * seam — with no system dialog along the way.
 *
 * A Finder right-click cannot be driven over SSH (no Accessibility grant), so
 * the installed workflow is run with `automator -i <path>`, which executes the
 * same document Finder would. The second folder sits in `~/Documents`, a
 * guarded location: if resolving a mentioned path there raised the
 * Files-and-Folders prompt, the nag watch fails the test.
 */

const WORKFLOW = '~/Library/Services/Mention\\ in\\ Cinna.workflow'

async function mention(vm: BareVm, path: string): Promise<void> {
  await vm.sh(`automator -i ${q(path)} ${WORKFLOW} >/dev/null`, 120_000)
}

test('the installed Quick Action mentions a folder in a new chat, with no system dialog', async ({ vm }) => {
  const { page } = vm
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible({ timeout: 60_000 })
  vm.step('skip onboarding')
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()

  vm.step('install the Quick Action from Settings → Features')
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Features', exact: true }).first().click()
  await page.getByRole('switch', { name: 'Mention in Cinna' }).click()
  await expect(page.getByRole('switch', { name: 'Mention in Cinna' })).toBeChecked()
  expect(await page.evaluate(() => window.api.finderQuickAction.status())).toMatchObject({
    supported: true,
    installed: true,
    outdated: false
  })
  // The Services registry picked it up (the installer runs `pbs -update`).
  const registered = await vm.sh(`/System/Library/CoreServices/pbs -dump | grep -c 'Mention in Cinna' || true`)
  expect(Number(registered.trim())).toBeGreaterThan(0)

  // Still in Settings: the chip goes into the new-chat draft quietly, with a
  // toast, and the screen the user is on stays put.
  vm.step('mention ~/Projects/site from Settings')
  await vm.sh('mkdir -p ~/Projects/site && touch ~/Projects/site/index.html')
  await mention(vm, '/Users/admin/Projects/site')
  await expect(page.getByText('site added to a new chat')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('switch', { name: 'Mention in Cinna' })).toBeVisible()

  vm.step('back to the new-chat screen')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  const chips = page.getByTestId('path-ref-badge')
  await expect(chips.filter({ hasText: 'site' })).toBeVisible()

  // On the new-chat screen the mention lands directly.
  vm.step('mention ~/Documents/notes (a guarded location)')
  await vm.sh('mkdir -p ~/Documents/notes')
  await mention(vm, '/Users/admin/Documents/notes')
  await expect(chips.filter({ hasText: 'notes' })).toBeVisible({ timeout: 30_000 })
  await expect(chips).toHaveCount(2)

  // A prompt raised by resolving the guarded path would land in this window.
  vm.step('idle with both chips')
  await page.waitForTimeout(20_000)
})
