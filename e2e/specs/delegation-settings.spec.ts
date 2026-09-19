import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

async function openPermissions(cinna: CinnaApp, name: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name, exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('tab', { name: 'Permissions', exact: true }).click()
}

/** Real UI → preload → IPC → per-agent desktop state. No model or dispatch is involved. */
test('kit and bare delegation grants persist on this machine and stay out of agent folders', async ({ cinna }, testInfo) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna, 'delegation-kits')
  const kit = await createFolderAgent(cinna, root, 'Delegation Worker')
  const barePath = homeDir(cinna, 'delegation-requester')
  writeFileSync(join(barePath, 'AGENT.md'), '# Delegation Requester\n')
  await cinna.stubDirectoryPicker(barePath)
  const selection = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (selection.cancelled || selection.refusal) throw new Error('The bare fixture folder could not be selected')
  const picked = await cinna.page.evaluate((input) => window.api.localAgents.folderAdd(input), { path: selection.path, relPaths: selection.found.map((entry) => entry.relPath) })
  if (!picked.ok) throw new Error(picked.message)
  const before = readdirSync(barePath, { recursive: true }).map(String).sort()
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  await openPermissions(cinna, 'Delegation Worker')
  const receiving = cinna.page.getByRole('combobox', { name: 'Delegations', exact: true })
  const cloud = cinna.page.getByRole('combobox', { name: 'Cloud delegations', exact: true })
  await expect(receiving).toHaveValue('ask')
  await expect(cloud).toHaveValue('ask')
  await receiving.selectOption('auto')
  await expect(receiving).toBeEnabled()
  await cloud.selectOption('auto')
  await expect(cloud).toBeEnabled()
  await expect.poll(() => cinna.page.evaluate((id) => window.api.localAgents.get(id), kit.id)).toMatchObject({ ok: true, value: { desktop: { delegations: 'auto', cloudDelegations: 'auto' } } })
  expect(readFileSync(join(kit.path, 'app-data', 'desktop.json'), 'utf8')).not.toContain('cloudDelegations')
  await cinna.page.screenshot({ path: testInfo.outputPath('kit-delegation-permissions.png'), animations: 'disabled' })

  await openPermissions(cinna, 'Delegation Requester')
  await expect(cinna.page.getByRole('combobox', { name: 'Delegations', exact: true })).toHaveCount(0)
  await expect(cinna.page.getByRole('combobox', { name: 'Handovers', exact: true })).toBeVisible()
  const requesterCloud = cinna.page.getByRole('combobox', { name: 'Cloud delegations', exact: true })
  await expect(requesterCloud).toHaveValue('ask')
  await requesterCloud.selectOption('auto')
  await expect(requesterCloud).toBeEnabled()
  expect(readdirSync(barePath, { recursive: true }).map(String).sort()).toEqual(before)
  await cinna.page.screenshot({ path: testInfo.outputPath('bare-delegation-permissions.png'), animations: 'disabled' })

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await openPermissions(cinna, 'Delegation Worker')
  await expect(cinna.page.getByRole('combobox', { name: 'Delegations', exact: true })).toHaveValue('auto')
  await expect(cinna.page.getByRole('combobox', { name: 'Cloud delegations', exact: true })).toHaveValue('auto')
  await openPermissions(cinna, 'Delegation Requester')
  await expect(cinna.page.getByRole('combobox', { name: 'Cloud delegations', exact: true })).toHaveValue('auto')
  expect(readdirSync(barePath, { recursive: true }).map(String).sort()).toEqual(before)
})
