import { expect, q, type BareVm } from './vm'

/**
 * The steps every per-engine agent spec shares, as `first-agent-session` does
 * them for Claude: skip onboarding, point the agents home at ~/CinnaAgents
 * (the default under ~/Documents meets the Documents access prompt, which
 * nothing in the guest can click), make `engine` the Default runtime, run
 * `setup` inside the same window, then reload so the renderer reads it all.
 */
export async function arrangeAgentsHome(vm: BareVm, engine: string, setup?: () => Promise<void>): Promise<void> {
  const { page } = vm
  vm.step('skip onboarding')
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()
  await page.evaluate(async (engine) => {
    await window.api.settings.set('localAgentsHome', '/Users/admin/CinnaAgents')
    await window.api.settings.set('localAgentsDefaultEngine', engine)
    // What the Agents tab's "Create folder" does, at the home set above.
    await window.api.localAgents.homeGrant()
  }, engine)
  await setup?.()
  // Writes through window.api bypass the renderer's caches; reload, as a reopen would.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()
}

/** Agents → Add an agent → New agent "Probe", then send `message` from its page. */
export async function createAgentAndSend(vm: BareVm, message: string): Promise<void> {
  const { page } = vm
  vm.step('create an agent')
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Add an agent' }).click()
  await page.getByRole('dialog', { name: 'Add an agent' }).getByRole('button', { name: /New agent/ }).click()
  const form = page.getByRole('dialog', { name: 'New agent' })
  await form.getByLabel('Name').fill('Probe')
  await form.getByLabel('Name').press('Enter')
  // Create closes the dialog onto the new agent's page, composer addressed to it.
  await expect(form).toBeHidden()

  vm.step('send the first message')
  const box = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await box.fill(message)
  await box.press('Enter')
}

/**
 * Whether the managed install `<tool>-<version>/` exists in the app's profile —
 * under `engine/` for OpenCode, `runtimes/` for the others (`managedBinaryPath`).
 */
export async function hasManagedInstall(vm: BareVm, root: 'engine' | 'runtimes', tool: string, version: string): Promise<boolean> {
  const dir = `${vm.userData}/${root}/${tool}-${version}`
  return (await vm.sh(`test -d ${q(dir)} && echo yes || echo no`)).trim() === 'yes'
}
