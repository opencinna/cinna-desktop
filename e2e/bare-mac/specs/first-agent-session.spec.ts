import { RUNTIME_PINS } from '../../../src/shared/runtimePins'
import { expect, q, test } from '../fixtures/vm'

/**
 * A new user creates a Claude folder agent and sends it a message, with no
 * Claude Code installed and no login: the app downloads its pinned Claude Code
 * into its own profile, checks the login, and says what to do — with no system
 * dialog anywhere on the way.
 *
 * The agents home is set to ~/CinnaAgents, as "choose a different location"
 * would. The default, ~/Documents/CinnaAgents, meets the macOS Documents
 * access prompt: expected, explained by the app first, and not something a
 * test can click from outside the guest.
 */
test('first Claude agent message downloads Claude Code and asks for a login', async ({ vm }) => {
  const { page } = vm
  vm.step('skip onboarding')
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    await window.api.settings.set('localAgentsHome', '/Users/admin/CinnaAgents')
    await window.api.settings.set('localAgentsDefaultEngine', 'claude')
    // What the Agents tab's "Create folder" does, at the home set above.
    await window.api.localAgents.homeGrant()
  })
  // The renderer read the Default runtime and the agents home at startup, and
  // writes from here bypass its cache invalidation; reload, as a reopen would.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()

  vm.step('create an agent')
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Add an agent' }).click()
  await page.getByRole('dialog', { name: 'Add an agent' }).getByRole('button', { name: /New agent/ }).click()
  const form = page.getByRole('dialog', { name: 'New agent' })
  await form.getByLabel('Name').fill('Probe')
  await form.getByLabel('Name').press('Enter')
  // Create closes the dialog onto the new agent's page, in chat mode.
  await expect(form).toBeHidden()

  vm.step('send the first message')
  // A new agent opens on its own page, composer already addressed to it.
  await expect(page.getByText(/^Claude( Code| Agent)?$/).first()).toBeVisible()
  const box = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await box.fill('hi')
  await box.press('Enter')

  vm.step('Claude Code download and login check')
  await expect(page.getByText('Claude Code is not logged in').first()).toBeVisible({
    timeout: 10 * 60_000
  })
  const claudeVersion = await vm.sh(`ls ${q(`${vm.userData}/runtimes`)}`)
  expect(claudeVersion).toContain(RUNTIME_PINS.claude.cli)
})
